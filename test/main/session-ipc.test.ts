import assert from "node:assert/strict"

import { createAbortError } from "../../runtime/error/src/abort.ts"
import { SessionRuntime } from "../../runtime/agent/src/session-runtime.ts"
import type { SessionRuntimeGlobal } from "../../src/main/session-runtime-global.ts"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ModelAdapter, ModelRef } from "../../runtime/model/src/types.ts"
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
  name: "claude-test",
}
const OTHER_MODEL: ModelRef = {
  providerId: "provider-2",
  protocol: "responses",
  modelId: "model-2",
  name: "gpt-test",
}
const CONTENT = [{ type: "text" as const, text: "你好" }]
const PROJECT_ID = "00000000-0000-4000-8000-000000000017"

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
  projectId: string
  runtime: SessionRuntime
  events: SessionEvent[]
  batches: Array<Parameters<SessionRuntime["appendTurnStartAndUserMessage"]>[0]>
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
  createRuntime: (projectId: string, sessionId: string, onStateChanged?: () => void) => SessionRuntime
  records: Map<string, RuntimeRecord>
  loopStarted: Promise<void>
  releaseFirstLoop(): void
  twoTurnsEnded: Promise<void>
  stoppedTurnEnded: Promise<void>
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
  let resolveStoppedTurn!: () => void
  const stoppedTurnEnded = new Promise<void>((resolve) => { resolveStoppedTurn = resolve })

  const createRuntime = (projectId: string, sessionId: string, onStateChanged?: () => void): SessionRuntime => {
    const events = sessionId === "existing-session" ? completedSessionEvents(sessionId) : []
    const batches: RuntimeRecord["batches"] = []
    let diskModel = structuredClone(MODEL)
    let sandboxMode = "sandbox-full-access"
    const repairPorts = {
      readEvents: async () => events,
      initializeSession: async () => {
        if (options.failInitialization) throw new Error("initialize failed")
      },
      repairDerivedState: async () => {},
      appendEvent: async (input: SessionEventInput) => {
        const event = persistedEvent(sessionId, events.length + 1, input)
        events.push(event)
        if (event.type === "turn/end") {
          turnEndCount += 1
          if (turnEndCount >= 2) resolveTwoTurns()
          if (event.reason === "stopped") resolveStoppedTurn()
        }
        return event
      },
    }
    const fake = {
      createSessionDirectory: async () => {},
      appendTurnStartAndUserMessage: async (
        inputs: Parameters<SessionRuntime["appendTurnStartAndUserMessage"]>[0],
      ) => {
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
      writeCurrentModel: async (model: ModelRef) => { diskModel = structuredClone(model) },
      readCurrentModel: async () => structuredClone(diskModel),
      buildContent: async () => [
        { role: "system", content: "system" },
        { role: "user", content: CONTENT },
      ],
      createLoopOptions: async () => ({
        adapter: {
          stream: async function* (
            _request: Parameters<ModelAdapter["stream"]>[0],
            signal: AbortSignal,
          ) {
            if (firstLoop) {
              firstLoop = false
              markLoopStarted()
              if (options.blockFirstLoop) {
                await Promise.race([
                  firstLoopGate,
                  new Promise<never>((_resolve, reject) => {
                    const stop = (): void => { reject(createAbortError()) }
                    if (signal.aborted) stop()
                    else signal.addEventListener("abort", stop, { once: true })
                  }),
                ])
              }
            }
            yield { type: "stream_end" as const, completion: "finished" as const }
          },
        },
        tools: [],
        executeTool: async () => { throw new Error("unexpected tool call") },
      }),
      repairPorts,
     }
    const runtime = new SessionRuntime({
      sessionId,
      sessionDirectory: join(tmpdir(), sessionId),
      projectGroupId: projectId,
      databasePath: join(tmpdir(), "unused-events.sqlite"),
      metaDatabasePath: join(tmpdir(), "unused-meta.sqlite"),
      systemPrompt: "test",
      onStateChanged,
      global: {
        resolveProjectContext: () => ({
          workspaceInfo: "test",
          resolveCurrentBaseline: async () => { throw new Error("unexpected baseline") },
        }),
        estimateSkillTokens: () => 0,
        createTurnModelAdapter: async () => (await fake.createLoopOptions()).adapter,
        listToolDefinitions: () => [],
        interruptTerminals: () => [],
        disposeProcessTools: async () => {},
        executeTool: async () => { throw new Error("unexpected tool call") },
      } as unknown as SessionRuntimeGlobal,
    })
    Object.assign(runtime, {
      eventLog: {
        readEvents: () => repairPorts.readEvents(),
        appendEvent: (input: SessionEventInput) => repairPorts.appendEvent(input),
        appendTurnStartAndUserMessage: fake.appendTurnStartAndUserMessage,
      },
      sessionState: {
        initializeSession: () => repairPorts.initializeSession(),
        repairDerivedState: () => repairPorts.repairDerivedState(),
        readSettings: async () => ({ name: "新对话", currentModel: structuredClone(diskModel), sandboxMode }),
        writeSettings: async (patch: { model?: ModelRef; sandboxMode?: string }) => {
          if (patch.model) diskModel = structuredClone(patch.model)
          if (patch.sandboxMode) sandboxMode = patch.sandboxMode
        },
      },
      createSessionDirectory: fake.createSessionDirectory,
      prepareExistingTurn: fake.prepareExistingTurn,
      writeCurrentModel: fake.writeCurrentModel,
      readCurrentModel: fake.readCurrentModel,
      buildContent: fake.buildContent,
    })
    records.set(sessionId, { projectId, runtime, events, batches })
    return runtime
  }

  return {
    createRuntime,
    records,
    loopStarted,
    releaseFirstLoop,
    twoTurnsEnded,
    stoppedTurnEnded,
  }
}

async function testStartsNewSessionAndProcessesQueuedMessages(): Promise<void> {
  const harness = runtimeHarness({ blockFirstLoop: true })
  const ipcMain = new FakeIpcMain()
  const failures: SessionCompletionFailure[] = []
  const forwarded: SessionEvent[] = []
  const forwarding: SessionEventForwardingPort = {
    sendSessionUpdateToRenderer: (update) => { if (update.kind === "event" && update.event.type === "user/message") forwarded.push(update.event) },
  }
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, (failure) => {
    failures.push(failure)
  }, forwarding)

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.startNewSession,
    PROJECT_ID,
    { content: CONTENT, model: MODEL },
  )
  assert.equal(response.turn, 1)
  await harness.loopStarted

  const queuedContent = [{ type: "text" as const, text: "排队消息" }]
  const queued = await ipcMain.invoke<{ sessionId: string; messageId: string; content: typeof queuedContent }>(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      PROJECT_ID,
      response.sessionId,
      { content: queuedContent },
  )
  assert.equal(queued.sessionId, response.sessionId)
  assert.ok(queued.messageId)
  assert.deepEqual(queued.content, queuedContent)
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.continueSession,
      PROJECT_ID,
      response.sessionId,
      { content: queuedContent, model: MODEL },
    ),
    /正在运行/,
  )

  harness.releaseFirstLoop()
  await harness.twoTurnsEnded
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const record = harness.records.get(response.sessionId)
  assert.ok(record)
  assert.equal(record.projectId, PROJECT_ID)
  assert.deepEqual(record.batches.map((batch) => batch[0].turn), [1, 2])
  assert.equal(record.batches[1]?.[1].message.id, queued.messageId)
  assert.deepEqual(forwarded.map((event) => event.type), ["user/message", "user/message"])
  assert.deepEqual(failures, [])
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      PROJECT_ID,
      response.sessionId,
      { content: queuedContent },
    ),
    /当前未运行/,
  )
}

async function testContinuesExistingSessionExplicitly(): Promise<void> {
  const harness = runtimeHarness()
  const ipcMain = new FakeIpcMain()
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, () => {})

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.continueSession,
    PROJECT_ID,
    "existing-session",
    { content: CONTENT, model: OTHER_MODEL },
  )
  assert.deepEqual(response, { sessionId: "existing-session", turn: 2 })
  const record = harness.records.get("existing-session")
  assert.ok(record)
  assert.equal(record.projectId, PROJECT_ID)
  assert.deepEqual(record.batches[0]?.[0], {
    type: "turn/start",
    turn: 2,
    model: OTHER_MODEL,
  })
}

async function testStopsActiveSessionAndDropsQueuedTurns(): Promise<void> {
  const harness = runtimeHarness({ blockFirstLoop: true })
  const ipcMain = new FakeIpcMain()
  const failures: SessionCompletionFailure[] = []
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, (failure) => { failures.push(failure) })

  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.startNewSession,
    PROJECT_ID,
    { content: CONTENT, model: MODEL },
  )
  await harness.loopStarted
  await ipcMain.invoke(
    SESSION_IPC_CHANNELS.enqueueSessionMessage,
    PROJECT_ID,
    response.sessionId,
    { content: [{ type: "text", text: "不应启动的排队消息" }] },
  )

  assert.deepEqual(
    await ipcMain.invoke(
      SESSION_IPC_CHANNELS.stopSession,
      PROJECT_ID,
      response.sessionId,
    ),
    { sessionId: response.sessionId },
  )
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      PROJECT_ID,
      response.sessionId,
      { content: CONTENT },
    ),
    /正在停止|当前未运行/,
  )

  await harness.stoppedTurnEnded
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const record = harness.records.get(response.sessionId)
  assert.ok(record)
  assert.deepEqual(record.batches.map((batch) => batch[0].turn), [1])
  assert.equal(
    record.events.some((event) => event.type === "step/end" && event.reason === "stopped"),
    true,
  )
  assert.equal(
    record.events.some((event) => event.type === "turn/end" && event.reason === "stopped"),
    true,
  )
  assert.deepEqual(failures, [])

  assert.deepEqual(
    await ipcMain.invoke(
      SESSION_IPC_CHANNELS.stopSession,
      PROJECT_ID,
      response.sessionId,
    ),
    { sessionId: response.sessionId },
  )
  assert.deepEqual(
    await ipcMain.invoke(
      SESSION_IPC_CHANNELS.stopSession,
      PROJECT_ID,
      "not-running",
    ),
    { sessionId: "not-running" },
  )
}

async function testRejectsInvalidRendererInput(): Promise<void> {
  const harness = runtimeHarness()
  const ipcMain = new FakeIpcMain()
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, () => {})

  await assert.rejects(
    ipcMain.invoke(SESSION_IPC_CHANNELS.startNewSession, PROJECT_ID, { content: CONTENT }),
    /Session 输入无效/,
  )
  await assert.rejects(
    ipcMain.invoke(SESSION_IPC_CHANNELS.continueSession, PROJECT_ID, "", { content: CONTENT }),
    /sessionId 无效/,
  )
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.continueSession,
      PROJECT_ID,
      "existing-session",
      { content: CONTENT },
    ),
    /Session 输入无效/,
  )
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.continueSession,
      PROJECT_ID,
      "existing-session",
      { content: CONTENT, model: { ...MODEL, protocol: "invalid" } },
    ),
    /Session 输入无效/,
  )
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      PROJECT_ID,
      "missing-session",
      { content: "invalid" },
    ),
    /enqueueSessionMessage 输入无效/,
  )
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      PROJECT_ID,
      "missing-session",
      { content: CONTENT, model: MODEL },
    ),
    /enqueueSessionMessage 输入无效/,
  )
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.startNewSession,
      -1,
      { content: CONTENT, model: MODEL },
    ),
    /projectId 无效/,
  )
  await assert.rejects(
    ipcMain.invoke(SESSION_IPC_CHANNELS.stopSession, PROJECT_ID, ""),
    /sessionId 无效/,
  )
  await assert.rejects(
    ipcMain.invoke(SESSION_IPC_CHANNELS.stopSession, -1, "session-1"),
    /projectId 无效/,
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
    PROJECT_ID,
    { content: CONTENT, model: MODEL },
  )
  const failure = await failureSeen
  assert.equal(failure.sessionId, response.sessionId)
  assert.equal(failure.turn, response.turn)
  assert.match(String(failure.error), /initialize failed/)
  await assert.rejects(
    ipcMain.invoke(
      SESSION_IPC_CHANNELS.enqueueSessionMessage,
      PROJECT_ID,
      response.sessionId,
      { content: CONTENT },
    ),
    /当前未运行/,
  )
}

/** default 作为分组身份进入 Runtime，活动命令仍按联合身份隔离。 */
async function testDefaultProjectIdentity(): Promise<void> {
  const harness = runtimeHarness({ blockFirstLoop: true })
  const ipcMain = new FakeIpcMain()
  registerSessionIpcHandlers(ipcMain, harness.createRuntime, () => {})
  const response = await ipcMain.invoke<StartedSessionResponse>(
    SESSION_IPC_CHANNELS.startNewSession, "default", { content: CONTENT, model: MODEL },
  )
  await harness.loopStarted
  assert.equal(harness.records.get(response.sessionId)?.projectId, "default")
  await assert.rejects(
    ipcMain.invoke(SESSION_IPC_CHANNELS.enqueueSessionMessage, PROJECT_ID, response.sessionId, { content: CONTENT }),
    /当前未运行/,
  )
  await ipcMain.invoke(SESSION_IPC_CHANNELS.stopSession, PROJECT_ID, response.sessionId)
  assert.equal(harness.records.get(response.sessionId)?.runtime.currentTurn, 1)
  await ipcMain.invoke(SESSION_IPC_CHANNELS.stopSession, "default", response.sessionId)
  await harness.stoppedTurnEnded
}

async function main(): Promise<void> {
  await testStartsNewSessionAndProcessesQueuedMessages()
  await testContinuesExistingSessionExplicitly()
  await testStopsActiveSessionAndDropsQueuedTurns()
  await testRejectsInvalidRendererInput()
  await testObservesBackgroundFailureAndCleansRuntime()
  await testDefaultProjectIdentity()
  await testAcceptedQueueSurvivesSnapshotFailure()
  console.log("session-ipc.test.ts: 主进程 Session IPC 断言通过")
}

/**
 * 验证入队已经接受后，控制快照故障不会使调用方误以为消息未入队。
 * @returns Queue 确认、后台错误与 Stop 验证完成。
 */
async function testAcceptedQueueSurvivesSnapshotFailure(): Promise<void> {
  const harness = runtimeHarness({ blockFirstLoop: true }), ipc = new FakeIpcMain()
  const failures: SessionCompletionFailure[] = []
  registerSessionIpcHandlers(ipc, harness.createRuntime, (failure) => { failures.push(failure) })
  const started = await ipc.invoke<StartedSessionResponse>(SESSION_IPC_CHANNELS.startNewSession, PROJECT_ID, { content: CONTENT, model: MODEL })
  await harness.loopStarted
  const runtime = harness.records.get(started.sessionId)!.runtime
  const snapshot = runtime.readSnapshot.bind(runtime)
  runtime.readSnapshot = async () => { throw new Error("snapshot failed") }
  const response = await ipc.invoke<{ messageId: string }>(SESSION_IPC_CHANNELS.enqueueSessionMessage, PROJECT_ID, started.sessionId, { content: CONTENT })
  assert.ok(response.messageId)
  assert.ok(failures.some((failure) => String(failure.error).includes("snapshot failed")))
  runtime.readSnapshot = snapshot
  assert.equal((await snapshot()).pendingMessages[0].messageId, response.messageId)
  await ipc.invoke(SESSION_IPC_CHANNELS.stopSession, PROJECT_ID, started.sessionId)
  await harness.stoppedTurnEnded
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
