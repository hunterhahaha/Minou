/** Electron 主进程启动装配的配置、IPC、Runtime 与窗口生命周期测试。 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

import type { SessionCompletionFailure } from "../../src/main/index.ts"
import {
  startElectronApp,
} from "../../src/main/index.ts"
import type {
  ElectronAppLifecycleEvent,
  ElectronAppPort,
  ElectronStartupOptions,
  IpcMainHandlePort,
  MainWindowLifecyclePort,
} from "../../src/main/index.ts"
import type { ModelAdapter, ModelRef } from "../../runtime/model/src/types.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import type { CurrentSessionBaseline } from "../../runtime/session/src/session-state.ts"
import {
  SESSION_IPC_CHANNELS,
} from "../../src/preload/session-api.ts"
import type { StartedSessionResponse } from "../../src/preload/session-api.ts"

const MODEL: ModelRef = {
  providerId: "provider-1",
  protocol: "anthropic_messages",
  modelId: "model-1",
}
const MESSAGE = [{ type: "text" as const, text: "你好" }]
const PROJECT_ID = 17

/** FakeIpcMain 保存的通用 IPC handler。 */
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

/** 保存已注册 handler，并允许测试按 Renderer invoke 形态调用。 */
class FakeIpcMain implements IpcMainHandlePort {
  /** 当前 channel 对应的唯一 handler。 */
  readonly handlers = new Map<string, IpcHandler>()

  /**
   * 注册一个 channel；重复注册模拟 Electron 的错误行为。
   *
   * @param channel IPC channel。
   * @param listener 主进程 handler。
   */
  handle(channel: string, listener: IpcHandler): void {
    if (this.handlers.has(channel)) throw new Error(`IPC handler 已存在：${channel}`)
    this.handlers.set(channel, listener)
  }

  /**
   * 调用已经注册的 handler。
   *
   * @param channel IPC channel。
   * @param args Renderer 参数。
   * @returns handler 的解析结果。
   */
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`IPC handler 未注册：${channel}`)
    return await handler({}, ...args) as T
  }
}

/** 记录 ready、应用事件和退出行为的 Electron app 假端口。 */
class FakeApp implements ElectronAppPort {
  /** `whenReady` 的调用次数。 */
  readyCalls = 0
  /** `quit` 的调用次数。 */
  quitCalls = 0
  private readonly listeners = new Map<ElectronAppLifecycleEvent, Array<() => void>>()

  /** @returns 立即进入 ready 状态的 Promise。 */
  async whenReady(): Promise<void> {
    this.readyCalls += 1
  }

  /**
   * 保存应用事件监听器。
   *
   * @param event Electron 应用事件。
   * @param listener 事件监听器。
   */
  on(event: ElectronAppLifecycleEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  /** 记录一次退出请求。 */
  quit(): void {
    this.quitCalls += 1
  }

  /**
   * 同步触发当前事件的全部监听器。
   *
   * @param event 要触发的应用事件。
   */
  emit(event: ElectronAppLifecycleEvent): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }

  /** @returns 当前已注册的生命周期监听器总数。 */
  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.length, 0)
  }
}

/** 记录窗口创建次数并暴露当前窗口存活状态。 */
class FakeWindows implements MainWindowLifecyclePort {
  /** 已执行的窗口创建次数。 */
  createCalls = 0
  /** 当前是否存在打开窗口。 */
  open = false

  /** 记录并模拟一个窗口已经打开。 */
  createMainWindow(): void {
    this.createCalls += 1
    this.open = true
  }

  /** @returns 当前模拟窗口是否打开。 */
  hasOpenWindows(): boolean {
    return this.open
  }
}

/**
 * 在临时 USERPROFILE 下运行测试并安全清理。
 *
 * @param test 使用绝对临时用户目录的测试函数。
 */
async function withTempProfile(test: (profile: string) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "nicode-electron-startup-"))
  try {
    await test(profile)
  } finally {
    assert.ok(resolve(profile).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(profile, { recursive: true, force: true })
  }
}

/**
 * 创建能够完成一次无工具 AgentLoop 的启动参数。
 *
 * @param profile 当前测试的用户目录。
 * @param overrides 要覆盖的启动端口或回调。
 * @returns 启动参数及可直接断言的假端口。
 */
function startupFixture(
  profile: string,
  overrides: Partial<ElectronStartupOptions> = {},
): {
  options: ElectronStartupOptions
  app: FakeApp
  ipcMain: FakeIpcMain
  windows: FakeWindows
} {
  const app = new FakeApp()
  const ipcMain = new FakeIpcMain()
  const windows = new FakeWindows()
  const baseline: CurrentSessionBaseline = {
    agentsmd: {
      path: join(profile, "AGENTS.md"),
      hash: "agents-hash",
      content: "Always verify changes.",
    },
    skills: {
      content: "Available skills.",
      entries: [],
      descriptions: {},
    },
    mcp: [],
  }
  const adapter: ModelAdapter = {
    stream: async function* () {
      yield { type: "stream_end", completion: "finished" }
    },
  }
  const options: ElectronStartupOptions = {
    app,
    ipcMain,
    windows,
    userProfile: profile,
    platform: "win32",
    sessionRuntime: {
      systemPrompt: "System prompt.",
      workspaceInfo: "Default workspace.",
      resolveCurrentBaseline: async () => baseline,
      estimateSkillTokens: (description) => description.length,
      adapters: [{ model: MODEL, adapter }],
      executeTool: async () => ({ status: "success", content: [] }),
    },
    onSessionCompletionFailure: () => {},
    ...overrides,
  }
  return { options, app, ipcMain, windows }
}

/** 验证启动顺序、IPC channel 和跨平台窗口生命周期。 */
async function testRegistersIpcAndWindowLifecycle(): Promise<void> {
  await withTempProfile(async (profile) => {
    const fixture = startupFixture(profile)
    await startElectronApp(fixture.options)

    assert.equal(fixture.app.readyCalls, 1)
    assert.equal(fixture.windows.createCalls, 1)
    assert.deepEqual([...fixture.ipcMain.handlers.keys()], [
      SESSION_IPC_CHANNELS.startNewSession,
      SESSION_IPC_CHANNELS.continueSession,
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      SESSION_IPC_CHANNELS.stopSession,
    ])

    fixture.app.emit("activate")
    assert.equal(fixture.windows.createCalls, 1)
    fixture.windows.open = false
    fixture.app.emit("activate")
    assert.equal(fixture.windows.createCalls, 2)
    fixture.app.emit("window-all-closed")
    assert.equal(fixture.app.quitCalls, 1)

    await assert.rejects(startElectronApp(fixture.options), /IPC handler 已存在/)
    assert.equal(fixture.windows.createCalls, 2)
  })

  await withTempProfile(async (profile) => {
    const fixture = startupFixture(profile, { platform: "darwin" })
    await startElectronApp(fixture.options)
    fixture.app.emit("window-all-closed")
    assert.equal(fixture.app.quitCalls, 0)
  })
}

/** 验证实际 Runtime 闭包使用 Project 路径与调用方注入的上下文和事件出口。 */
async function testCreatesProjectSessionRuntime(): Promise<void> {
  await withTempProfile(async (profile) => {
    let resolveRequest!: (request: Parameters<ModelAdapter["stream"]>[0]) => void
    const requestSeen = new Promise<Parameters<ModelAdapter["stream"]>[0]>((resolveRequestPromise) => {
      resolveRequest = resolveRequestPromise
    })
    let resolveTurnEnd!: () => void
    const turnEndSeen = new Promise<void>((resolve) => { resolveTurnEnd = resolve })
    const forwarded: SessionEvent[] = []
    const failures: SessionCompletionFailure[] = []
    const adapter: ModelAdapter = {
      stream: async function* (request) {
        resolveRequest(request)
        yield { type: "stream_end", completion: "finished" }
      },
    }
    const fixture = startupFixture(profile, {
      sessionRuntime: {
        systemPrompt: "Injected system prompt.",
        workspaceInfo: "Injected workspace info.",
        resolveCurrentBaseline: async () => ({
          agentsmd: {
            path: join(profile, "AGENTS.md"),
            hash: "injected-agents-hash",
            content: "Injected AGENTS content.",
          },
          skills: {
            content: "Injected skills content.",
            entries: [],
            descriptions: {},
          },
          mcp: [],
        }),
        estimateSkillTokens: (description) => description.length,
        adapters: [{ model: MODEL, adapter }],
        executeTool: async () => ({ status: "success", content: [] }),
      },
      onSessionCompletionFailure: (failure) => { failures.push(failure) },
      sessionEventForwarding: {
        filterSessionEventForRenderer: (event) => event,
        sendSessionEventToRenderer: (event) => {
          const sessionEvent = event as SessionEvent
          forwarded.push(sessionEvent)
          if (sessionEvent.type === "turn/end") resolveTurnEnd()
        },
      },
    })
    await startElectronApp(fixture.options)
    await mkdir(join(profile, ".nicode", "sessions", String(PROJECT_ID)))

    const response = await fixture.ipcMain.invoke<StartedSessionResponse>(
      SESSION_IPC_CHANNELS.startNewSession,
      PROJECT_ID,
      { content: MESSAGE, model: MODEL },
    )
    assert.equal(response.turn, 1)
    assert.equal(
      (await stat(join(
        profile,
        ".nicode",
        "sessions",
        String(PROJECT_ID),
        response.sessionId,
      ))).isDirectory(),
      true,
    )

    const request = await requestSeen
    assert.deepEqual(request.context.messages, [
      {
        role: "system",
        content: [
          "Injected system prompt.",
          "Injected workspace info.",
          "Injected AGENTS content.",
          "Injected skills content.",
        ].join("\n\n"),
      },
      { role: "user", content: MESSAGE },
    ])
    await turnEndSeen
    assert.equal(forwarded.some((event) => event.type === "turn/start"), true)
    assert.equal(forwarded.some((event) => event.type === "turn/end"), true)
    assert.deepEqual(failures, [])
  })
}

/** 验证后台 Turn 错误到启动参数回调的完整接线。 */
async function testForwardsSessionCompletionFailure(): Promise<void> {
  await withTempProfile(async (profile) => {
    const expected = new Error("adapter failed")
    let resolveFailure!: (failure: SessionCompletionFailure) => void
    const failureSeen = new Promise<SessionCompletionFailure>((resolve) => { resolveFailure = resolve })
    const adapter: ModelAdapter = {
      stream: async function* () {
        throw expected
      },
    }
    const fixture = startupFixture(profile, {
      sessionRuntime: {
        ...startupFixture(profile).options.sessionRuntime,
        adapters: [{ model: MODEL, adapter }],
      },
      onSessionCompletionFailure: resolveFailure,
    })
    await startElectronApp(fixture.options)
    await mkdir(join(profile, ".nicode", "sessions", String(PROJECT_ID)))
    const response = await fixture.ipcMain.invoke<StartedSessionResponse>(
      SESSION_IPC_CHANNELS.startNewSession,
      PROJECT_ID,
      { content: MESSAGE, model: MODEL },
    )
    const failure = await failureSeen
    assert.deepEqual(failure, { sessionId: response.sessionId, turn: 1, error: expected })
  })
}

/** 验证配置失败发生在 IPC、ready 和窗口副作用之前。 */
async function testRejectsInvalidProfileBeforeRegistration(): Promise<void> {
  const fixture = startupFixture(resolve(tmpdir()), { userProfile: "relative-profile" })
  await assert.rejects(startElectronApp(fixture.options), /USERPROFILE/)
  assert.equal(fixture.ipcMain.handlers.size, 0)
  assert.equal(fixture.app.readyCalls, 0)
  assert.equal(fixture.app.listenerCount(), 0)
  assert.equal(fixture.windows.createCalls, 0)
}

/** 依次运行启动装配的全部断言。 */
async function main(): Promise<void> {
  await testRegistersIpcAndWindowLifecycle()
  await testCreatesProjectSessionRuntime()
  await testForwardsSessionCompletionFailure()
  await testRejectsInvalidProfileBeforeRegistration()
  console.log("index.test.ts: Electron 主进程启动装配断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
