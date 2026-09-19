import assert from "node:assert/strict"

import type { ModelRef } from "../../runtime/model/src/types.ts"
import type { AppendSessionEvent } from "../../runtime/session/src/events.ts"
import type { SessionRuntimePorts } from "../../runtime/agent/src/session-runtime.ts"
import {
  registerSessionIpcHandlers,
} from "../../src/main/session-ipc.ts"
import type {
  IpcMainHandlePort,
  SessionCompletionFailure,
} from "../../src/main/session-ipc.ts"
import {
  SESSION_IPC_CHANNELS,
} from "../../src/preload/session-api.ts"
import type { StartedSessionResponse } from "../../src/preload/session-api.ts"

const MODEL: ModelRef = {
  providerId: "provider-1",
  protocol: "anthropic_messages",
  modelId: "model-1",
}
const OTHER_MODEL: ModelRef = {
  providerId: "provider-1",
  protocol: "responses",
  modelId: "model-2",
}
const CONTENT = [{ type: "text" as const, text: "你好" }]

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

class FakeIpcMain implements IpcMainHandlePort {
  readonly handlers = new Map<string, IpcHandler>()

  handle(channel: string, listener: IpcHandler): void {
    assert.equal(this.handlers.has(channel), false, `重复注册 IPC channel：${channel}`)
    this.handlers.set(channel, listener)
  }

  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const handler = this.handlers.get(channel)
    assert.ok(handler, `未注册 IPC channel：${channel}`)
    return await handler({}, ...args) as T
  }
}

function runtimeFixture(): {
  ports: SessionRuntimePorts
  calls: string[]
  batches: Parameters<SessionRuntimePorts["appendTurnStartAndUserMessage"]>[1][]
  loopStarted: Promise<void>
} {
  const calls: string[] = []
  const batches: Parameters<SessionRuntimePorts["appendTurnStartAndUserMessage"]>[1][] = []
  let resolveLoopStarted!: () => void
  const loopStarted = new Promise<void>((resolve) => { resolveLoopStarted = resolve })
  let nextEvent = 0
  const appendEvent: AppendSessionEvent = async (event) => ({
    ...event,
    eventId: `loop-event-${++nextEvent}`,
    sessionId: "runtime-session",
    seq: nextEvent,
    createdAt: "2026-09-19T00:00:00.000Z",
  })

  const ports: SessionRuntimePorts = {
    createSessionDirectory: async () => { calls.push("createDirectory") },
    appendTurnStartAndUserMessage: async (_sessionId, events) => {
      calls.push("appendBatch")
      batches.push(events)
    },
    initializeSession: async () => { calls.push("initialize") },
    repairSession: async () => {
      calls.push("repair")
      return { lastTurn: 2, currentModel: MODEL }
    },
    prepareExistingTurn: async () => { calls.push("prepare") },
    buildContent: async () => {
      calls.push("buildContent")
      return [{ role: "system", content: "system" }, { role: "user", content: CONTENT }]
    },
    createLoopOptions: async () => ({
      adapter: {
        stream: async function* () {
          calls.push("modelRequest")
          resolveLoopStarted()
          yield { type: "stream_end" as const, completion: "finished" as const }
        },
      },
      tools: [],
      executeTool: async () => { throw new Error("unexpected tool call") },
      signal: new AbortController().signal,
      appendEvent,
    }),
  }
  return { ports, calls, batches, loopStarted }
}

async function testStartsNewSessionAndReturnsBeforeCompletion(): Promise<void> {
  const runtime = runtimeFixture()
  let releaseInitialization!: () => void
  const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve })
  runtime.ports.initializeSession = async () => {
    runtime.calls.push("initialize")
    await initializationGate
  }
  const ipcMain = new FakeIpcMain()
  const failures: SessionCompletionFailure[] = []
  registerSessionIpcHandlers(ipcMain, runtime.ports, (failure) => { failures.push(failure) })

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.startNewSession,
    { content: CONTENT, model: MODEL },
  )
  assert.equal(response.turn, 1)
  assert.ok(response.sessionId.length > 0)
  assert.deepEqual(runtime.calls, ["createDirectory", "appendBatch", "initialize"])
  assert.deepEqual(runtime.batches[0].map((event) => event.type), ["turn/start", "user/message"])

  releaseInitialization()
  await runtime.loopStarted
  assert.deepEqual(failures, [])
}

async function testContinuesExistingSession(): Promise<void> {
  const runtime = runtimeFixture()
  const ipcMain = new FakeIpcMain()
  registerSessionIpcHandlers(ipcMain, runtime.ports, () => {})

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.continueSession,
    "existing-session",
    { content: CONTENT, model: OTHER_MODEL },
  )
  assert.deepEqual(response, { sessionId: "existing-session", turn: 3 })
  assert.deepEqual(runtime.calls.slice(0, 3), ["repair", "prepare", "appendBatch"])
  assert.deepEqual(runtime.batches[0][0], {
    type: "turn/start",
    turn: 3,
    model: OTHER_MODEL,
  })
  await runtime.loopStarted
}

async function testRejectsInvalidRendererInput(): Promise<void> {
  const runtime = runtimeFixture()
  const ipcMain = new FakeIpcMain()
  registerSessionIpcHandlers(ipcMain, runtime.ports, () => {})

  await assert.rejects(
    ipcMain.invoke(SESSION_IPC_CHANNELS.startNewSession, { content: CONTENT }),
    /startNewSession 输入无效/,
  )
  await assert.rejects(
    ipcMain.invoke(SESSION_IPC_CHANNELS.continueSession, "", { content: CONTENT }),
    /sessionId 无效/,
  )
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.continueSession,
      "existing-session",
      { content: CONTENT, model: { ...MODEL, protocol: "invalid" } },
    ),
    /model 无效/,
  )
  assert.deepEqual(runtime.calls, [])
}

async function testObservesBackgroundFailure(): Promise<void> {
  const runtime = runtimeFixture()
  const failureError = new Error("initialize failed")
  runtime.ports.initializeSession = async () => { throw failureError }
  const ipcMain = new FakeIpcMain()
  let resolveFailure!: (failure: SessionCompletionFailure) => void
  const failureSeen = new Promise<SessionCompletionFailure>((resolve) => { resolveFailure = resolve })
  registerSessionIpcHandlers(ipcMain, runtime.ports, resolveFailure)

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.startNewSession,
    { content: CONTENT, model: MODEL },
  )
  const failure = await failureSeen
  assert.equal(failure.sessionId, response.sessionId)
  assert.equal(failure.turn, response.turn)
  assert.equal(failure.error, failureError)
}

async function main(): Promise<void> {
  await testStartsNewSessionAndReturnsBeforeCompletion()
  await testContinuesExistingSession()
  await testRejectsInvalidRendererInput()
  await testObservesBackgroundFailure()
  console.log("session-ipc.test.ts: 主进程 Session IPC 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
