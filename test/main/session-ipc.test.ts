import assert from "node:assert/strict"

import { SessionRuntimePorts } from "../../runtime/agent/src/session-runtime.ts"
import type { SessionRuntimeBindings } from "../../runtime/agent/src/session-runtime.ts"
import type { ModelRef } from "../../runtime/model/src/types.ts"
import type { SessionEvent, SessionEventInput } from "../../runtime/session/src/events.ts"
import {
  registerSessionIpcHandlers,
} from "../../src/main/session-ipc.ts"
import type {
  IpcMainHandlePort,
  SessionCompletionFailure,
  SessionEventForwardingPort,
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

interface RuntimeRecord {
  runtime: SessionRuntimePorts
  events: SessionEvent[]
  batches: Array<Parameters<SessionRuntimeBindings["appendTurnStartAndUserMessage"]>[0]>
}

function persistedEvent(sessionId: string, seq: number, input: SessionEventInput): SessionEvent {
  return {
    ...input,
    eventId: `${sessionId}-event-${seq}`,
    sessionId,
    seq,
    createdAt: `2026-09-20T00:00:${String(seq).padStart(2, "0")}.000Z`,
  } as SessionEvent
}

function completedSessionEvents(sessionId: string): SessionEvent[] {
  return [
    persistedEvent(sessionId, 1, { type: "turn/start", turn: 1, model: MODEL }),
    persistedEvent(sessionId, 2, {
      type: "user/message",
      turn: 1,
      message: { id: "existing-message", role: "user", content: CONTENT },
    }),
    persistedEvent(sessionId, 3, { type: "turn/end", turn: 1, reason: "completed" }),
  ]
}

function runtimeHarness(options: { blockFirstLoop?: boolean; failInitialization?: boolean } = {}): {
  createRuntime: (sessionId: string) => SessionRuntimePorts
  records: Map<string, RuntimeRecord>
  loopStarted: Promise<void>
  releaseFirstLoop(): void
  twoTurnsEnded: Promise<void>
} {
  const records = new Map<string, RuntimeRecord>()
  let releaseFirstLoop!: () => void
  let markLoopStarted!: () => void
  const firstLoopGate = new Promise<void>((resolve) => { releaseFirstLoop = resolve })
  const loopStarted = new Promise<void>((resolve) => { markLoopStarted = resolve })
  let firstLoop = true
  let turnEndCount = 0
  let resolveTwoTurns!: () => void
  const twoTurnsEnded = new Promise<void>((resolve) => { resolveTwoTurns = resolve })

  const createRuntime = (sessionId: string): SessionRuntimePorts => {
    const events = sessionId === "existing-session" ? completedSessionEvents(sessionId) : []
    const batches: RuntimeRecord["batches"] = []
    const repairPorts = {
      readEvents: async () => events,
      initializeSession: async () => {
        if (options.failInitialization) throw new Error("initialize failed")
      },
      repairDerivedState: async () => ({ currentModel: MODEL }),
      appendEvent: async (input: SessionEventInput) => {
        const event = persistedEvent(sessionId, events.length + 1, input)
        events.push(event)
        if (event.type === "turn/end") {
          turnEndCount += 1
          if (turnEndCount >= 2) resolveTwoTurns()
        }
        return event
      },
    }
    const bindings: SessionRuntimeBindings = {
      createSessionDirectory: async () => {},
      appendTurnStartAndUserMessage: async (inputs) => {
        batches.push(inputs)
        const start = persistedEvent(sessionId, events.length + 1, inputs[0])
        const message = persistedEvent(sessionId, events.length + 2, inputs[1])
        assert.equal(start.type, "turn/start")
        assert.equal(message.type, "user/message")
        if (start.type !== "turn/start" || message.type !== "user/message") {
          throw new Error("unreachable")
        }
        events.push(start, message)
        return [start, message]
      },
      prepareExistingTurn: async () => {},
      buildContent: async () => [
        { role: "system", content: "system" },
        { role: "user", content: CONTENT },
      ],
      createLoopOptions: async () => ({
        adapter: {
          stream: async function* () {
            if (firstLoop) {
              firstLoop = false
              markLoopStarted()
              if (options.blockFirstLoop) await firstLoopGate
            }
            yield { type: "stream_end" as const, completion: "finished" as const }
          },
        },
        tools: [],
        executeTool: async () => { throw new Error("unexpected tool call") },
        signal: new AbortController().signal,
      }),
      repairPorts,
    }
    const runtime = new SessionRuntimePorts(sessionId, bindings)
    records.set(sessionId, { runtime, events, batches })
    return runtime
  }

  return {
    createRuntime,
    records,
    loopStarted,
    releaseFirstLoop,
    twoTurnsEnded,
  }
}

async function testStartsNewSessionAndProcessesQueuedMessages(): Promise<void> {
  const harness = runtimeHarness({ blockFirstLoop: true })
  const ipcMain = new FakeIpcMain()
  const failures: SessionCompletionFailure[] = []
  const forwarded: SessionEvent[] = []
  const forwarding: SessionEventForwardingPort = {
    filterSessionEventForRenderer: (event) => event.type === "user/message" ? event : undefined,
    sendSessionEventToRenderer: (event) => { forwarded.push(event as SessionEvent) },
  }
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, (failure) => {
    failures.push(failure)
  }, forwarding)

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.startNewSession,
    { content: CONTENT, model: MODEL },
  )
  assert.equal(response.turn, 1)
  await harness.loopStarted

  const queuedContent = [{ type: "text" as const, text: "排队消息" }]
  assert.deepEqual(
    await ipcMain.invoke(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      response.sessionId,
      { content: queuedContent },
    ),
    { sessionId: response.sessionId, content: queuedContent },
  )
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.continueSession,
      response.sessionId,
      { content: queuedContent },
    ),
    /正在运行/,
  )

  harness.releaseFirstLoop()
  await harness.twoTurnsEnded
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const record = harness.records.get(response.sessionId)
  assert.ok(record)
  assert.deepEqual(record.batches.map((batch) => batch[0].turn), [1, 2])
  assert.deepEqual(forwarded.map((event) => event.type), ["user/message", "user/message"])
  assert.deepEqual(failures, [])
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      response.sessionId,
      { content: queuedContent },
    ),
    /当前未运行/,
  )
}

async function testContinuesExistingSessionThroughQueue(): Promise<void> {
  const harness = runtimeHarness()
  const ipcMain = new FakeIpcMain()
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, () => {})

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.continueSession,
    "existing-session",
    { content: CONTENT },
  )
  assert.deepEqual(response, { sessionId: "existing-session", turn: 2 })
  const record = harness.records.get("existing-session")
  assert.ok(record)
  assert.deepEqual(record.batches[0]?.[0], {
    type: "turn/start",
    turn: 2,
    model: MODEL,
  })
}

async function testRejectsInvalidRendererInput(): Promise<void> {
  const harness = runtimeHarness()
  const ipcMain = new FakeIpcMain()
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, () => {})

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
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      "missing-session",
      { content: "invalid" },
    ),
    /enqueueSessionMessage 输入无效/,
  )
}

async function testObservesBackgroundFailureAndCleansRuntime(): Promise<void> {
  const harness = runtimeHarness({ failInitialization: true })
  const ipcMain = new FakeIpcMain()
  let resolveFailure!: (failure: SessionCompletionFailure) => void
  const failureSeen = new Promise<SessionCompletionFailure>((resolve) => { resolveFailure = resolve })
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, resolveFailure)

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.startNewSession,
    { content: CONTENT, model: MODEL },
  )
  const failure = await failureSeen
  assert.equal(failure.sessionId, response.sessionId)
  assert.equal(failure.turn, response.turn)
  assert.match(String(failure.error), /initialize failed/)
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      response.sessionId,
      { content: CONTENT },
    ),
    /当前未运行/,
  )
}

async function main(): Promise<void> {
  await testStartsNewSessionAndProcessesQueuedMessages()
  await testContinuesExistingSessionThroughQueue()
  await testRejectsInvalidRendererInput()
  await testObservesBackgroundFailureAndCleansRuntime()
  console.log("session-ipc.test.ts: 主进程 Session IPC 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
