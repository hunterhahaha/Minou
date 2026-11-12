import { requestMessages } from "../../runtime/model/test/helpers.ts"
/** Electron 主进程启动装配的配置、IPC、Runtime 与窗口生命周期测试。 */

import assert from "node:assert/strict"
import { DEFAULT_TEAM_WAKEUP_CONFIG } from "../../runtime/session/src/team-wakeup-config.ts"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import type { SessionCompletionFailure } from "../../src/main/index.ts"
import type { SessionRuntimeGlobal } from "../../src/main/session-runtime-global.ts"
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
import { INITIAL_SESSION_NAME, initializeSessionMetaDatabase, readSessionMeta } from "../../runtime/session/src/meta-store.ts"
import { initializeSessionEventDatabase } from "../../runtime/session/src/event-log.ts"
import { initializeWorkspaceDatabase, readDefaultWorkspace, readProjectWorkspace, saveProjectWorkspace } from "../../src/main/workspace-store.ts"
import type { SessionData, SessionUpdate } from "../../src/preload/session-api.ts"
import {
  SESSION_IPC_CHANNELS,
  START_TEAM_SESSION_CHANNEL,
  TEAM_WAKEUP_CHANNELS,
  STARTUP_DATA_IPC_CHANNELS,
  PROJECT_IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
  MCP_IPC_CHANNELS,
  SKILL_IPC_CHANNELS,
  WEB_SEARCH_IPC_CHANNELS,
} from "../../src/preload/session-api.ts"
import type { StartedSessionResponse } from "../../src/preload/session-api.ts"

const MODEL: ModelRef = {
  providerId: "provider-1",
  protocol: "anthropic_messages",
  modelId: "model-1",
  name: "claude-test",
  reasoningLevel: "medium",
}
const MESSAGE = [{ type: "text" as const, text: "你好" }]
const PROJECT_ID = "00000000-0000-4000-8000-000000000017"

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
  const profile = await mkdtemp(join(tmpdir(), "minou-electron-startup-"))
  try {
    await mkdir(join(profile, ".minou"))
    initializeSessionMetaDatabase(join(profile, ".minou", "meta.sqlite"))
    await initializeSessionEventDatabase(join(profile, ".minou", "events.sqlite"), true)
    const workspacePath = join(profile, ".minou", "workspace.sqlite")
    initializeWorkspaceDatabase(workspacePath)
    for (const id of [PROJECT_ID, "00000000-0000-4000-8000-000000000018"]) {
      saveProjectWorkspace(workspacePath, { version: 1, id, name: "测试项目", updatedAt: new Date().toISOString(), directories: [], sessions: [] })
    }
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
    contextWindow: 128000, maxOutputTokens: 4096, stream: async function* () {
      yield { type: "stream_end", completion: "finished" }
    },
  }
  const options: ElectronStartupOptions = {
    app,
    ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    windows,
    teamWakeup: DEFAULT_TEAM_WAKEUP_CONFIG,
    configPaths: {
      rootDir: join(profile, ".minou"),
      configPath: join(profile, ".minou", "config.json"),
      providerDatabasePath: join(profile, ".minou", "providers.sqlite"),
      workspaceDatabasePath: join(profile, ".minou", "workspace.sqlite"),
      metaDatabasePath: join(profile, ".minou", "meta.sqlite"),
    },
    platform: "win32",
    sessionRuntime: {
      systemPrompt: "System prompt.",
      global: {
        resolveProjectContext: () => ({
          workspaceInfo: "Default workspace.",
          resolveCurrentBaseline: async () => baseline,
        }),
        estimateSkillTokens: (description: string) => description.length,
        createTurnModelAdapter: async () => adapter,
        listToolDefinitions: () => [],
        interruptTerminals: () => [],
        disposeProcessTools: async () => {},
        executeTool: async () => ({ status: "success", content: [] }),
      } as unknown as SessionRuntimeGlobal,
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
    let adapterFactoryCalls = 0
    let skillReads = 0
    Object.defineProperty(fixture.options.sessionRuntime.global, "skillManager", {
      value: { listSkills: async () => { skillReads += 1; return [] } },
    })
    fixture.options.sessionRuntime.global.createTurnModelAdapter = async () => {
      adapterFactoryCalls += 1
      throw new Error("启动阶段不得创建 Adapter")
    }
    await startElectronApp(fixture.options)

    assert.equal(fixture.app.readyCalls, 1)
    assert.equal(fixture.windows.createCalls, 1)
    assert.equal(adapterFactoryCalls, 0)
    assert.equal(skillReads, 0, "注册 Skill IPC 不主动读取列表")
    assert.deepEqual([...fixture.ipcMain.handlers.keys()], [
      SESSION_IPC_CHANNELS.startNewSession,
      START_TEAM_SESSION_CHANNEL,
      ...Object.values(TEAM_WAKEUP_CHANNELS),
      SESSION_IPC_CHANNELS.continueSession,
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      SESSION_IPC_CHANNELS.stopSession,
      SESSION_IPC_CHANNELS.getSessionData,
      SESSION_IPC_CHANNELS.renameSession,
      SESSION_IPC_CHANNELS.exportSessionMarkdown,
      SESSION_IPC_CHANNELS.updateSessionSettings,
      SESSION_IPC_CHANNELS.decideSessionApproval,
      STARTUP_DATA_IPC_CHANNELS.listProjects,
      STARTUP_DATA_IPC_CHANNELS.listDefaultSessions,
      STARTUP_DATA_IPC_CHANNELS.listProviders,
      PROVIDER_IPC_CHANNELS.listCompatibleProviders,
      PROVIDER_IPC_CHANNELS.createCompatibleProvider,
      PROVIDER_IPC_CHANNELS.createCustomProvider,
      PROVIDER_IPC_CHANNELS.updateProvider,
      PROVIDER_IPC_CHANNELS.deleteProvider,
      PROVIDER_IPC_CHANNELS.updateApiKey,
      PROVIDER_IPC_CHANNELS.createModel,
      PROVIDER_IPC_CHANNELS.updateModel,
      PROVIDER_IPC_CHANNELS.deleteModel,
      PROVIDER_IPC_CHANNELS.setDefaultModel,
      ...Object.values(WEB_SEARCH_IPC_CHANNELS),
      PROJECT_IPC_CHANNELS.selectDirectory,
      PROJECT_IPC_CHANNELS.createProject,
      PROJECT_IPC_CHANNELS.renameProject,
      PROJECT_IPC_CHANNELS.addProjectDirectory,
      PROJECT_IPC_CHANNELS.removeProjectDirectory,
      PROJECT_IPC_CHANNELS.listProjectGitBranches,
      PROJECT_IPC_CHANNELS.switchProjectGitBranch,
      ...Object.values(MCP_IPC_CHANNELS),
      ...Object.values(SKILL_IPC_CHANNELS),
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
      contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (request, _signal, options) {
        if (options?.timeoutMs !== undefined) return
        resolveRequest(request)
        yield { type: "stream_end", completion: "finished" }
      },
    }
    const fixture = startupFixture(profile, {
      sessionRuntime: {
        systemPrompt: "Injected system prompt.",
        global: {
          resolveProjectContext: (projectId: string) => ({
            workspaceInfo: `Injected workspace info for ${projectId}.`,
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
          }),
          estimateSkillTokens: (description: string) => description.length,
          createTurnModelAdapter: async () => adapter,
          listToolDefinitions: () => [],
          interruptTerminals: () => [],
          disposeProcessTools: async () => {},
          executeTool: async () => ({ status: "success", content: [] }),
        } as unknown as SessionRuntimeGlobal,
      },
      onSessionCompletionFailure: (failure) => { failures.push(failure) },
      sessionEventForwarding: {
        sendSessionUpdateToRenderer: (update) => {
          if (update.kind !== "event") return
          const sessionEvent = update.event
          forwarded.push(sessionEvent)
          if (sessionEvent.type === "turn/end") resolveTurnEnd()
        },
      },
    })
    await startElectronApp(fixture.options)
    await mkdir(join(profile, ".minou", "sessions", String(PROJECT_ID)), { recursive: true })

    const response = await fixture.ipcMain.invoke<StartedSessionResponse>(
      SESSION_IPC_CHANNELS.startNewSession,
      PROJECT_ID,
      { content: MESSAGE, model: MODEL },
    )
    assert.equal(response.turn, 1)
    assert.equal(
      (await stat(join(
        profile,
        ".minou",
        "sessions",
        String(PROJECT_ID),
        response.sessionId,
      ))).isDirectory(),
      true,
    )

    const request = await requestSeen
    assert.deepEqual(requestMessages(request), [
      {
        role: "system",
        content: [
          "Injected system prompt.",
          `Injected workspace info for ${PROJECT_ID}.`,
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

/** 验证每次 Runtime 构造都按当前 projectId 取得独立固定上下文。 */
async function testResolvesContextForEachProject(): Promise<void> {
  await withTempProfile(async (profile) => {
    const projectIds = [
      "00000000-0000-4000-8000-000000000017",
      "00000000-0000-4000-8000-000000000018",
    ]
    const requestedProjects: string[] = []
    const systemMessages: string[] = []
    let resolveRequests!: () => void
    const requestsSeen = new Promise<void>((resolve) => { resolveRequests = resolve })
    let completedTurns = 0
    let resolveTurns!: () => void
    const turnsCompleted = new Promise<void>((resolve) => { resolveTurns = resolve })
    const adapter: ModelAdapter = {
      contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (request, _signal, options) {
        if (options?.timeoutMs !== undefined) return
        const systemMessage = requestMessages(request)[0]
        assert.equal(systemMessage.role, "system")
        assert.equal(typeof systemMessage.content, "string")
        if (typeof systemMessage.content === "string") systemMessages.push(systemMessage.content)
        if (systemMessages.length === projectIds.length) resolveRequests()
        yield { type: "stream_end", completion: "finished" }
      },
    }
    const fixture = startupFixture(profile, {
      sessionRuntime: {
        ...startupFixture(profile).options.sessionRuntime,
        global: {
          ...startupFixture(profile).options.sessionRuntime.global,
          resolveProjectContext: (projectId: string) => {
            requestedProjects.push(projectId)
            return {
              workspaceInfo: `Workspace ${projectId}`,
              resolveCurrentBaseline: async () => ({
                agentsmd: {
                  path: join(profile, `AGENTS-${projectId}.md`),
                  hash: `agents-${projectId}`,
                  content: `Rules ${projectId}`,
                },
                skills: { content: "", entries: [], descriptions: {} },
                mcp: [],
              }),
            }
          },
          createTurnModelAdapter: async () => adapter,
        } as unknown as SessionRuntimeGlobal,
      },
      sessionEventForwarding: {
        sendSessionUpdateToRenderer: (update) => {
          if (update.kind !== "event") return
          const sessionEvent = update.event
          if (sessionEvent.type === "turn/end") {
            completedTurns += 1
            if (completedTurns === projectIds.length) resolveTurns()
          }
        },
      },
    })
    await startElectronApp(fixture.options)
    for (const projectId of projectIds) {
      await mkdir(join(profile, ".minou", "sessions", String(projectId)), { recursive: true })
    }

    await Promise.all(projectIds.map((projectId) => fixture.ipcMain.invoke(
      SESSION_IPC_CHANNELS.startNewSession,
      projectId,
      { content: MESSAGE, model: MODEL },
    )))
    await requestsSeen
    await turnsCompleted

    assert.deepEqual(requestedProjects, projectIds)
    for (const projectId of projectIds) {
      assert.equal(systemMessages.some((message) =>
        message.includes(`Workspace ${projectId}\n\nRules ${projectId}`)), true)
    }
  })
}

/** 验证标题独立完成、写入顺序、手动命名优先和后续轮次不再触发。 */
async function testGeneratedSessionTitles(): Promise<void> {
  await withTempProfile(async (profile) => {
    const fixture = startupFixture(profile)
    const { rootDir, metaDatabasePath, workspaceDatabasePath } = fixture.options.configPaths
    const updates: SessionUpdate[] = []
    const failures: SessionCompletionFailure[] = []
    const titleRequests: string[] = []
    const diskAtPublish = new Map<string, string[]>()
    let releaseTitle!: () => void
    let titleGate = Promise.resolve()
    let titleMode: "generate" | "rename" | "fail" = "generate"
    let generationFinished = false

    const readIndex = (projectId: string) => (projectId === "default"
      ? readDefaultWorkspace(workspaceDatabasePath) : readProjectWorkspace(workspaceDatabasePath, projectId)).sessions
    await startElectronApp({
      ...fixture.options,
      sessionRuntime: {
        ...fixture.options.sessionRuntime,
        global: {
          ...fixture.options.sessionRuntime.global,
          createTurnModelAdapter: async (): Promise<ModelAdapter> => ({
            contextWindow: 128_000, maxOutputTokens: 4096, reasoningLevels: ["medium", "none"],
            async *stream(request, _signal, options) {
              if (options?.timeoutMs !== undefined) {
                titleRequests.push(request.model.reasoningLevel)
                try {
                  await titleGate
                  if (titleMode === "fail") throw new Error("标题请求失败")
                  yield { type: "block_start", index: 0, blockType: "text" }
                  yield { type: "block_end", index: 0, block: { type: "text", text: '{"title":"自动标题"}' } }
                  yield { type: "stream_end", completion: "finished" }
                } finally { generationFinished = true }
                return
              }
              assert.equal(request.model.reasoningLevel, MODEL.reasoningLevel)
              yield { type: "stream_end", completion: "finished" }
            },
          }),
        } as unknown as SessionRuntimeGlobal,
      },
      onSessionCompletionFailure: (failure) => { failures.push(failure) },
      sessionEventForwarding: {
        sendSessionUpdateToRenderer: (update) => {
          updates.push(update)
          if (update.kind === "state" && update.summary?.name === "自动标题") {
            const meta = readSessionMeta(metaDatabasePath, update.projectId, update.sessionId) as { name: string }
            const indexed = readIndex(update.projectId).find(({ id }) => id === update.sessionId)
            diskAtPublish.set(update.sessionId, [meta.name, indexed?.name ?? ""])
          }
        },
      },
    })

    /** @param ready 要等待的 IPC 或脚本模型条件。 @throws Error 条件迟迟未出现。 */
    async function waitFor(ready: () => boolean): Promise<void> {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (ready()) return
        if (failures.length > 0) throw failures[0].error
        await delay(10)
      }
      assert.fail("未收到预期的标题或会话更新")
    }

    for (const [projectId, mode] of [
      ["default", "generate"], [PROJECT_ID, "generate"], [PROJECT_ID, "rename"], [PROJECT_ID, "fail"],
    ] as const) {
      titleMode = mode
      generationFinished = false
      titleGate = new Promise<void>((resolve) => { releaseTitle = resolve })
      await mkdir(join(rootDir, "sessions", projectId), { recursive: true })
      const { sessionId } = await fixture.ipcMain.invoke<StartedSessionResponse>(
        SESSION_IPC_CHANNELS.startNewSession, projectId, { content: MESSAGE, model: MODEL },
      )
      const getData = () => fixture.ipcMain.invoke<SessionData>(SESSION_IPC_CHANNELS.getSessionData, projectId, sessionId)
      await waitFor(() => updates.some((update) => update.sessionId === sessionId && update.kind === "state" && update.control.phase === "idle"))
      assert.equal((await getData()).summary.name, INITIAL_SESSION_NAME, "主回复已结束，标题请求仍在等待")
      if (mode === "rename") await fixture.ipcMain.invoke(SESSION_IPC_CHANNELS.renameSession, projectId, sessionId, "手动标题")
      releaseTitle()
      await waitFor(() => mode === "generate" ? diskAtPublish.has(sessionId) : generationFinished)
      const expected = mode === "generate" ? "自动标题" : mode === "rename" ? "手动标题" : INITIAL_SESSION_NAME
      if (mode === "generate") assert.deepEqual(diskAtPublish.get(sessionId), [expected, expected])
      assert.equal((await getData()).summary.name, expected)
      assert.equal(readIndex(projectId).find(({ id }) => id === sessionId)?.name, expected)
      if (mode === "generate") {
        const next = await fixture.ipcMain.invoke<StartedSessionResponse>(SESSION_IPC_CHANNELS.continueSession, projectId, sessionId, { content: MESSAGE })
        await waitFor(() => updates.some((update) => update.sessionId === sessionId && update.kind === "event" &&
          update.event.type === "turn/end" && update.event.turn === next.turn))
      }
    }
    assert.deepEqual(titleRequests, ["none", "none", "none", "none"])
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
      contextWindow: 128000, maxOutputTokens: 4096, stream: async function* () {
        throw expected
      },
    }
    const fixture = startupFixture(profile, {
      sessionRuntime: {
        ...startupFixture(profile).options.sessionRuntime,
        global: {
          ...startupFixture(profile).options.sessionRuntime.global,
          createTurnModelAdapter: async () => adapter,
        } as unknown as SessionRuntimeGlobal,
      },
      onSessionCompletionFailure: resolveFailure,
    })
    await startElectronApp(fixture.options)
    await mkdir(join(profile, ".minou", "sessions", String(PROJECT_ID)), { recursive: true })
    const response = await fixture.ipcMain.invoke<StartedSessionResponse>(
      SESSION_IPC_CHANNELS.startNewSession,
      PROJECT_ID,
      { content: MESSAGE, model: MODEL },
    )
    const failure = await failureSeen
    assert.deepEqual(failure, { sessionId: response.sessionId, turn: 1, error: expected })
  })
}

/** 验证 Project Context 建立失败时不会创建 Session 目录。 */
async function testRejectsProjectContextBeforeSessionCreation(): Promise<void> {
  await withTempProfile(async (profile) => {
    const projectDirectory = join(profile, ".minou", "sessions", String(PROJECT_ID))
    await mkdir(projectDirectory, { recursive: true })
    const fixture = startupFixture(profile, {
      sessionRuntime: {
        ...startupFixture(profile).options.sessionRuntime,
        global: {
          ...startupFixture(profile).options.sessionRuntime.global,
          resolveProjectContext: () => {
            throw new Error("Project context unavailable")
          },
        } as unknown as SessionRuntimeGlobal,
      },
    })
    await startElectronApp(fixture.options)

    await assert.rejects(
      fixture.ipcMain.invoke(
        SESSION_IPC_CHANNELS.startNewSession,
        PROJECT_ID,
        { content: MESSAGE, model: MODEL },
      ),
      /Project context unavailable/,
    )
    assert.deepEqual(await readdir(projectDirectory), [])
  })
}

/** 应用退出要等待进程资源清理；重复退出请求不能重复启动清理。 */
async function testWaitsForProcessDisposal(): Promise<void> {
  await withTempProfile(async (profile) => {
    const fixture = startupFixture(profile)
    let disposed = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    fixture.options.sessionRuntime.global.disposeProcessTools = async () => { disposed++; await gate }
    await startElectronApp(fixture.options)
    fixture.app.emit("before-quit")
    fixture.app.emit("before-quit")
    assert.equal(disposed, 1)
    assert.equal(fixture.app.quitCalls, 0)
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fixture.app.quitCalls, 1)
    fixture.app.emit("before-quit")
    assert.equal(disposed, 1)
    assert.equal(fixture.app.quitCalls, 1)
  })
}

/** 依次运行启动装配的全部断言。 */
async function main(): Promise<void> {
  await testRegistersIpcAndWindowLifecycle()
  await testCreatesProjectSessionRuntime()
  await testResolvesContextForEachProject()
  await testGeneratedSessionTitles()
  await testForwardsSessionCompletionFailure()
  await testRejectsProjectContextBeforeSessionCreation()
  await testWaitsForProcessDisposal()
  console.log("index.test.ts: Electron 主进程启动装配断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
