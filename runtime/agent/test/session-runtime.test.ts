import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAbortError } from "../../error/src/abort.ts"

import type { ModelAdapter, ModelRef, ModelStreamEvent } from "../../model/src/types.ts"
import type { CurrentSessionBaseline } from "../../session/src/session-state.ts"
import { initializeSessionMetaDatabase } from "../../session/src/meta-store.ts"
import type {
  SessionEvent,
  SessionEventInput,
} from "../../session/src/events.ts"
import {
  repairSession,
  SessionRuntime,
  SessionLogCorruptedError,
} from "../src/session-runtime.ts"
import type { SessionRepairPorts } from "../src/session-runtime.ts"
import type { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"

const MODEL: ModelRef = { providerId: "provider-1", protocol: "anthropic_messages", modelId: "model-1", name: "claude-test" }
const OTHER_MODEL: ModelRef = { providerId: "provider-2", protocol: "responses", modelId: "model-2", name: "gpt-test" }
const MESSAGE = [{ type: "text" as const, text: "你好" }]

function fixture(
  sessionId = "session-1",
  initialEvents: readonly SessionEvent[] = [],
): {
  ports: SessionRuntime
  global: SessionRuntimeGlobal
  repairPorts: SessionRepairPorts
  calls: string[]
  batches: Parameters<SessionRuntime["appendTurnStartAndUserMessage"]>[0][]
  events: SessionEvent[]
  loopEvents: SessionEventInput[]
  seenModels: ModelRef[]
  writtenModels: ModelRef[]
  queueReadModels(...models: ModelRef[]): void
} {
  const calls: string[] = []
  const batches: Parameters<SessionRuntime["appendTurnStartAndUserMessage"]>[0][] = []
  const events = [...initialEvents]
  const loopEvents: SessionEventInput[] = []
  const seenModels: ModelRef[] = []
  const writtenModels: ModelRef[] = []
  const pendingReadModels: ModelRef[] = []
  let diskModel = structuredClone(MODEL)
  const repairPorts: SessionRepairPorts = {
    readEvents: async () => {
      calls.push("readEvents")
      return events
    },
    initializeSession: async () => { calls.push("initialize") },
    repairDerivedState: async () => {
      calls.push("repairDerivedState")
    },
    appendEvent: async (input) => {
      loopEvents.push(input)
      calls.push(input.type)
      const event = persistedEvent(sessionId, events.length + 1, input)
      events.push(event)
      return event
    },
  }
  const overrides = {
    createSessionDirectory: async () => { calls.push("createDirectory") },
    appendTurnStartAndUserMessage: async (
      inputs: Parameters<SessionRuntime["appendTurnStartAndUserMessage"]>[0],
    ) => {
      calls.push("appendBatch")
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
    prepareExistingTurn: async () => { calls.push("prepare") },
    writeCurrentModel: async (model: ModelRef) => {
      calls.push("writeCurrentModel")
      diskModel = structuredClone(model)
      writtenModels.push(structuredClone(model))
    },
    readCurrentModel: async () => {
      calls.push("readCurrentModel")
      return structuredClone(pendingReadModels.shift() ?? diskModel)
    },
    buildContent: async () => {
      calls.push("buildContent")
      return [{ role: "system", content: "fixed" }, { role: "user", content: MESSAGE }]
    },
    createLoopOptions: async (model: ModelRef) => {
      calls.push("createLoopOptions")
      seenModels.push(model)
      return {
        adapter: {
          stream: async function* (request: Parameters<import("../../model/src/types.ts").ModelAdapter["stream"]>[0]) {
            calls.push("modelRequest")
            assert.deepEqual(request.model, model)
            assert.deepEqual(request.context.messages.map((message: import("../../model/src/types.ts").ModelMessage) => message.role), ["system", "user"])
            yield { type: "stream_end" as const, completion: "finished" as const }
          },
        },
        tools: [],
        executeTool: async () => { throw new Error("unexpected tool call") },
      }
    },
  }
  const global = {
    resolveProjectContext: () => ({
      workspaceInfo: "test",
      resolveCurrentBaseline: async () => { throw new Error("unexpected baseline") },
    }),
    estimateSkillTokens: () => 0,
    createTurnModelAdapter: async (model: ModelRef) => (await overrides.createLoopOptions(model)).adapter,
    listToolDefinitions: () => [],
    executeTool: async () => { throw new Error("unexpected tool") },
  } as unknown as SessionRuntimeGlobal
  const ports = new SessionRuntime({
    sessionId,
    sessionDirectory: join(tmpdir(), sessionId),
    projectGroupId: "default",
    databasePath: join(tmpdir(), "unused-events.sqlite"),
    metaDatabasePath: join(tmpdir(), "unused-meta.sqlite"),
    systemPrompt: "test",
    global,
  })
  Object.assign(ports, {
    eventLog: {
      readEvents: () => repairPorts.readEvents(),
      appendEvent: (input: SessionEventInput) => repairPorts.appendEvent(input),
      appendTurnStartAndUserMessage: overrides.appendTurnStartAndUserMessage,
    },
    sessionState: {
      initializeSession: () => repairPorts.initializeSession(),
      repairDerivedState: (values: readonly SessionEvent[]) => repairPorts.repairDerivedState(values),
    },
    createSessionDirectory: overrides.createSessionDirectory,
    prepareExistingTurn: overrides.prepareExistingTurn,
    writeCurrentModel: overrides.writeCurrentModel,
    readCurrentModel: overrides.readCurrentModel,
    buildContent: overrides.buildContent,
  })
  return {
    ports,
    global,
    repairPorts,
    calls,
    batches,
    events,
    loopEvents,
    seenModels,
    writtenModels,
    queueReadModels: (...models) => pendingReadModels.push(...models.map((model) => structuredClone(model))),
  }
}

function persistedEvent(
  sessionId: string,
  seq: number,
  input: SessionEventInput,
): SessionEvent {
  return {
    ...input,
    eventId: `event-${seq}`,
    sessionId,
    seq,
    createdAt: `2026-09-18T00:00:${String(seq).padStart(2, "0")}.000Z`,
  } as SessionEvent
}

function initialRepairEvents(sessionId: string): SessionEvent[] {
  return [
    persistedEvent(sessionId, 1, { type: "turn/start", turn: 1, model: MODEL }),
    persistedEvent(sessionId, 2, {
      type: "user/message",
      turn: 1,
      message: { id: "message-1", role: "user", content: MESSAGE },
    }),
  ]
}

function completedSessionEvents(sessionId: string): SessionEvent[] {
  const events = initialRepairEvents(sessionId)
  events.push(persistedEvent(sessionId, 3, { type: "turn/end", turn: 1, reason: "completed" }))
  return events
}

function repairFixture(initial: readonly SessionEvent[]): {
  events: SessionEvent[]
  calls: string[]
  repair: () => Promise<{ lastTurn: number }>
  ports: SessionRepairPorts
} {
  const events = [...initial]
  const calls: string[] = []
  const ports: SessionRepairPorts = {
    readEvents: async () => {
      calls.push("readEvents")
      return events
    },
    initializeSession: async () => { calls.push("initialize") },
    repairDerivedState: async (validatedEvents) => {
      calls.push("repairDerivedState")
      assert.equal(validatedEvents.length, events.length)
    },
    appendEvent: async (input) => {
      calls.push(`append:${input.type}`)
      const event = persistedEvent(initial[0]?.sessionId ?? "session-repair", events.length + 1, input)
      events.push(event)
      return event
    },
  }
  const sessionId = initial[0]?.sessionId ?? "session-repair"
  return { events, calls, repair: () => repairSession(sessionId, ports), ports }
}

async function testNewSession(): Promise<void> {
  const { ports, repairPorts, calls, batches, loopEvents, seenModels } = fixture()
  let releaseInitialization!: () => void
  const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve })
  repairPorts.initializeSession = async () => {
    calls.push("initialize")
    await initializationGate
  }

  const started = await ports.startNewSession({ content: MESSAGE, model: MODEL })
  const processing = ports.processMessageQueue(started)
  const streamed: SessionEvent[] = []
  const streamDone = (async () => {
    for await (const event of started.events) streamed.push(event)
  })()
  assert.equal(started.sessionId, "session-1")
  assert.equal(started.turn, 1)
  assert.deepEqual(calls, ["createDirectory", "appendBatch", "initialize"])
  const firstBatch = batches[0]
  assert.ok(firstBatch)
  assert.deepEqual(firstBatch.map((event) => event.type), ["turn/start", "user/message"])
  assert.deepEqual(firstBatch[0], { type: "turn/start", turn: 1, model: MODEL })
  assert.equal(firstBatch[1].message.role, "user")
  assert.deepEqual(firstBatch[1].message.content, MESSAGE)
  assert.ok(firstBatch[1].message.id.length > 0)

  releaseInitialization()
  await processing.completion
  await streamDone
  assert.deepEqual(seenModels, [MODEL])
  assert.deepEqual(
    loopEvents.map((event) => event.type),
    ["step/start", "assistant/message", "step/end", "turn/end"],
  )
  assert.deepEqual(streamed.map((event) => event.type), [
    "turn/start",
    "user/message",
    "step/start",
    "assistant/message",
    "step/end",
    "turn/end",
  ])
  assert.deepEqual(calls.slice(3, 7), [
    "writeCurrentModel",
    "readCurrentModel",
    "createLoopOptions",
    "buildContent",
  ])
}

async function testContinueSession(): Promise<void> {
  const state = fixture(
    "session-existing",
    completedSessionEvents("session-existing"),
  )
  state.queueReadModels(OTHER_MODEL)
  const started = await state.ports.continueSession({ content: MESSAGE, model: MODEL })
  assert.equal(started.sessionId, "session-existing")
  assert.equal(started.turn, 2)
  await started.completion
  assert.deepEqual(state.calls.slice(0, 9), [
    "readEvents",
    "initialize",
    "repairDerivedState",
    "prepare",
    "writeCurrentModel",
    "readCurrentModel",
    "createLoopOptions",
    "appendBatch",
    "buildContent",
  ])
  assert.deepEqual(state.writtenModels, [MODEL])
  assert.deepEqual(state.batches[0]?.[0], {
    type: "turn/start",
    turn: 2,
    model: OTHER_MODEL,
  })
  assert.deepEqual(state.seenModels, [OTHER_MODEL])
}

async function testOneAdapterServesAllStepsInTurn(): Promise<void> {
  const state = fixture("session-multi-step")
  let adapterFactoryCalls = 0
  let modelRequests = 0
  state.global.createTurnModelAdapter = async (model: ModelRef) => {
    adapterFactoryCalls += 1
    const adapter: ModelAdapter = {
      stream: async function* (): AsyncGenerator<ModelStreamEvent> {
        modelRequests += 1
        if (modelRequests === 1) {
          yield { type: "block_start", index: 0, blockType: "tool_call" }
          yield {
            type: "block_end",
            index: 0,
            block: {
              type: "tool_call",
              toolCallId: "call-1",
              name: "fake_tool",
              arguments: {},
            },
          }
          yield { type: "stream_end", completion: "tool_calls" }
          return
        }
        yield { type: "stream_end", completion: "finished" }
      },
    }
    return adapter
  }
  state.global.executeTool = async () => ({
    status: "success",
    content: [{ type: "text", text: "ok" }],
  })

  const started = await state.ports.startNewSession({ content: MESSAGE, model: MODEL })
  const processing = state.ports.processMessageQueue(started)
  await processing.completion
  assert.equal(adapterFactoryCalls, 1)
  assert.equal(modelRequests, 2)
  assert.deepEqual(state.seenModels, [], "测试覆盖的 Adapter 工厂不得回落到旧 fixture")
}

async function testQueuedMessagesRunInOrder(): Promise<void> {
  const state = fixture("session-queue")
  let releaseInitialization!: () => void
  const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve })
  state.repairPorts.initializeSession = async () => {
    state.calls.push("initialize")
    await initializationGate
  }
  const started = await state.ports.startNewSession({ content: MESSAGE, model: MODEL })
  const processing = state.ports.processMessageQueue(started)
  const second = [{ type: "text" as const, text: "第二条" }]
  const third = [{ type: "text" as const, text: "第三条" }]
  state.queueReadModels(MODEL, OTHER_MODEL, MODEL)
  const queued = state.ports.enqueueSessionMessage({ content: second })
  assert.ok(queued.messageId)
  assert.deepEqual(queued, {
    sessionId: "session-queue",
    messageId: queued.messageId,
    content: second,
  })
  state.ports.enqueueSessionMessage({ content: third })
  releaseInitialization()
  await processing.completion

  assert.deepEqual(state.batches.map((batch) => batch[0].turn), [1, 2, 3])
  assert.equal(state.batches[1]?.[1].message.id, queued.messageId)
  assert.deepEqual(
    state.batches.map((batch) => batch[1].message.content),
    [MESSAGE, second, third],
  )
  assert.deepEqual(state.batches.map((batch) => batch[0].model), [MODEL, OTHER_MODEL, MODEL])
  assert.deepEqual(state.seenModels, [MODEL, OTHER_MODEL, MODEL])
  assert.deepEqual(state.writtenModels, [MODEL], "Queue Turn 不得覆盖 currentModel")
  assert.throws(() => state.ports.enqueueSessionMessage({ content: MESSAGE }), /已关闭/)
}

async function testFailureBoundaries(): Promise<void> {
  const failedBatch = fixture()
  failedBatch.ports.appendTurnStartAndUserMessage = async () => { throw new Error("batch failed") }
  await assert.rejects(failedBatch.ports.startNewSession({ content: MESSAGE, model: MODEL }), /batch failed/)
  assert.deepEqual(failedBatch.calls, ["createDirectory"])

  const failedRepair = fixture("session-existing", completedSessionEvents("session-existing"))
  failedRepair.repairPorts.readEvents = async () => { throw new Error("repair failed") }
  await assert.rejects(
    failedRepair.ports.continueSession({ content: MESSAGE, model: MODEL }),
    /repair failed/,
  )
  assert.deepEqual(failedRepair.calls, [])

  const failedInitialization = fixture()
  failedInitialization.repairPorts.initializeSession = async () => { throw new Error("initialize failed") }
  const started = await failedInitialization.ports.startNewSession({ content: MESSAGE, model: MODEL })
  await assert.rejects(started.completion, /initialize failed/)
  assert.deepEqual(
    failedInitialization.loopEvents.map((event) => event.type),
    ["app/error", "turn/end"],
  )

  const failedNewAdapter = fixture("session-new-adapter-failure")
  failedNewAdapter.global.createTurnModelAdapter = async () => {
    throw new Error("new adapter failed")
  }
  const failedNewTurn = await failedNewAdapter.ports.startNewSession(
    { content: MESSAGE, model: MODEL },
  )
  await assert.rejects(failedNewTurn.completion, /new adapter failed/)
  assert.deepEqual(
    failedNewAdapter.loopEvents.map((event) => event.type),
    ["app/error", "turn/end"],
  )

  const failedAdapter = fixture(
    "session-adapter-failure",
    completedSessionEvents("session-adapter-failure"),
  )
  failedAdapter.global.createTurnModelAdapter = async () => {
    throw new Error("adapter failed")
  }
  await assert.rejects(
    failedAdapter.ports.continueSession({ content: MESSAGE, model: OTHER_MODEL }),
    /adapter failed/,
  )
  assert.deepEqual(failedAdapter.writtenModels, [OTHER_MODEL])
  assert.equal(failedAdapter.batches.length, 0, "Adapter 失败前不得提交新 Turn")
}

async function testRepairInterruptedTextStep(): Promise<void> {
  const sessionId = "session-repair-text"
  const initial = initialRepairEvents(sessionId)
  initial.push(
    persistedEvent(sessionId, 3, { type: "step/start", turn: 1, step: 1 }),
    persistedEvent(sessionId, 4, {
      type: "assistant/block_start",
      turn: 1,
      step: 1,
      blockId: "1:1:0",
      index: 0,
      blockType: "text",
    }),
    persistedEvent(sessionId, 5, {
      type: "assistant/block_delta",
      turn: 1,
      step: 1,
      blockId: "1:1:0",
      delta: { type: "text", text: "未完成" },
    }),
    persistedEvent(sessionId, 6, {
      type: "assistant/block_delta",
      turn: 1,
      step: 1,
      blockId: "1:1:0",
      delta: { type: "text", text: "文本" },
    }),
  )
  const state = repairFixture(initial)

  assert.deepEqual(await state.repair(), { lastTurn: 1 })
  assert.deepEqual(
    state.events.slice(6).map((event) => event.type),
    ["assistant/block_end", "assistant/message", "step/end", "turn/end"],
  )
  const blockEnd = state.events[6]
  assert.equal(blockEnd.type, "assistant/block_end")
  if (blockEnd.type === "assistant/block_end") {
    assert.deepEqual(blockEnd.block, { type: "text", text: "未完成文本" })
  }
  const message = state.events[7]
  assert.equal(message.type, "assistant/message")
  if (message.type === "assistant/message") {
    assert.deepEqual(message.message.content, [{ type: "text", text: "未完成文本" }])
    assert.deepEqual(message.model, MODEL)
    assert.equal(message.usage, undefined)
    assert.equal(message.finishReason, undefined)
  }
  const stepEnd = state.events[8]
  const turnEnd = state.events[9]
  assert.ok(stepEnd.type === "step/end" && stepEnd.reason === "error")
  assert.ok(turnEnd.type === "turn/end" && turnEnd.reason === "error")

  const eventCount = state.events.length
  await state.repair()
  assert.equal(state.events.length, eventCount, "重复恢复不得再次补写事件")
}

async function testRepairApprovalAndToolResults(): Promise<void> {
  const sessionId = "session-repair-tools"
  const initial = initialRepairEvents(sessionId)
  let seq = initial.length
  const add = (input: SessionEventInput): SessionEvent => {
    const event = persistedEvent(sessionId, ++seq, input)
    initial.push(event)
    return event
  }
  add({ type: "step/start", turn: 1, step: 1 })

  const toolEnds = [
    ["call-pending", "read"],
    ["call-approved", "write"],
    ["call-denied", "shell"],
    ["call-cancelled", "edit"],
    ["call-without-approval", "grep"],
  ].map(([toolCallId, name], index) => {
    const blockId = `1:1:${index}`
    add({
      type: "assistant/block_start",
      turn: 1,
      step: 1,
      blockId,
      index,
      blockType: "tool_call",
    })
    return add({
      type: "assistant/block_end",
      turn: 1,
      step: 1,
      blockId,
      index,
      block: { type: "tool_call", toolCallId, name, arguments: { path: `${index}` } },
    })
  })

  add({
    type: "assistant/message",
    turn: 1,
    step: 1,
    message: {
      id: "assistant-tools",
      role: "assistant",
      content: toolEnds.map((event) => {
        assert.equal(event.type, "assistant/block_end")
        if (event.type !== "assistant/block_end") throw new Error("unreachable")
        return event.block
      }),
    },
    model: MODEL,
  })

  const request = (
    approvalId: string,
    end: SessionEvent,
  ): void => {
    assert.equal(end.type, "assistant/block_end")
    if (end.type !== "assistant/block_end" || end.block.type !== "tool_call") throw new Error("unreachable")
    add({
      type: "approval/request",
      turn: 1,
      step: 1,
      approvalId,
      toolCallEventId: end.eventId,
      toolCallId: end.block.toolCallId,
      blockId: end.blockId,
      toolName: end.block.name,
      arguments: end.block.arguments,
    })
  }
  request("approval-pending", toolEnds[0])
  request("approval-approved", toolEnds[1])
  add({
    type: "approval/result",
    turn: 1,
    step: 1,
    approvalId: "approval-approved",
    decision: "approved",
  })
  request("approval-denied", toolEnds[2])
  add({
    type: "approval/result",
    turn: 1,
    step: 1,
    approvalId: "approval-denied",
    decision: "denied",
  })
  request("approval-cancelled", toolEnds[3])
  add({
    type: "approval/result",
    turn: 1,
    step: 1,
    approvalId: "approval-cancelled",
    decision: "cancelled",
  })

  const state = repairFixture(initial)
  await state.repair()
  const appended = state.events.slice(initial.length)
  assert.deepEqual(
    appended.map((event) => event.type),
    [
      "approval/result",
      "tool/result",
      "tool/result",
      "tool/result",
      "tool/result",
      "tool/result",
      "step/end",
      "turn/end",
    ],
  )
  const recoveryCodes = appended
    .filter((event): event is Extract<SessionEvent, { type: "tool/result" }> => event.type === "tool/result")
    .map((event) => event.result.status === "error" ? event.result.error.code : "success")
  assert.deepEqual(recoveryCodes, [
    "CANCELLED",
    "EXECUTION_STATE_UNKNOWN",
    "APPROVAL_DENIED",
    "CANCELLED",
    "EXECUTION_STATE_UNKNOWN",
  ])
}

async function testInterruptedToolCallDoesNotCreateOrphanResult(): Promise<void> {
  const sessionId = "session-repair-incomplete-tool"
  const initial = initialRepairEvents(sessionId)
  initial.push(
    persistedEvent(sessionId, 3, { type: "step/start", turn: 1, step: 1 }),
    persistedEvent(sessionId, 4, {
      type: "assistant/block_start",
      turn: 1,
      step: 1,
      blockId: "1:1:0",
      index: 0,
      blockType: "tool_call",
    }),
    persistedEvent(sessionId, 5, {
      type: "assistant/block_delta",
      turn: 1,
      step: 1,
      blockId: "1:1:0",
      delta: { type: "tool_call", toolCallId: "call-incomplete", argumentsDelta: "{" },
    }),
  )
  const state = repairFixture(initial)
  await state.repair()
  assert.deepEqual(state.events.slice(5).map((event) => event.type), ["step/end", "turn/end"])
}

async function testRepairPreservesContextAndUncommittedSummary(): Promise<void> {
  const sessionId = "session-repair-summary"
  const initial = initialRepairEvents(sessionId)
  initial.push(
    persistedEvent(sessionId, 3, { type: "step/start", turn: 1, step: 1 }),
    persistedEvent(sessionId, 4, {
      type: "assistant/message",
      turn: 1,
      step: 1,
      message: { id: "empty-assistant", role: "assistant", content: [] },
      model: MODEL,
    }),
    persistedEvent(sessionId, 5, { type: "step/end", turn: 1, step: 1, reason: "completed" }),
    persistedEvent(sessionId, 6, { type: "turn/end", turn: 1, reason: "completed" }),
    persistedEvent(sessionId, 7, {
      type: "context_update",
      turn: 2,
      source: {
        type: "agents_md",
        path: "G:/code/NiCode/AGENTS.md",
        hash: "hash-2",
        fullContent: "updated",
      },
      content: "<agents_md_update>updated</agents_md_update>",
    }),
    persistedEvent(sessionId, 8, { type: "turn/start", turn: 2, model: MODEL }),
    persistedEvent(sessionId, 9, {
      type: "user/message",
      turn: 2,
      message: { id: "message-2", role: "user", content: MESSAGE },
    }),
    persistedEvent(sessionId, 10, {
      type: "summary/start",
      turn: 2,
      summaryId: "summary-uncommitted",
      throughEventSeq: 9,
    }),
  )
  const state = repairFixture(initial)
  assert.deepEqual(await state.repair(), { lastTurn: 2 })
  assert.deepEqual(state.events.slice(10).map((event) => event.type), ["turn/end"])
  assert.equal(state.events.filter((event) => event.type === "summary/end").length, 0)
}

async function testCorruptedLogIsRejectedBeforeWrites(): Promise<void> {
  const sessionId = "session-corrupted"
  const initial = initialRepairEvents(sessionId)
  initial.push(
    persistedEvent(sessionId, 3, { type: "step/start", turn: 1, step: 1 }),
    persistedEvent(sessionId, 4, {
      type: "assistant/block_delta",
      turn: 1,
      step: 1,
      blockId: "missing-start",
      delta: { type: "text", text: "orphan" },
    }),
  )
  const state = repairFixture(initial)
  await assert.rejects(
    state.repair(),
    (error: unknown) => error instanceof SessionLogCorruptedError && error.code === "SESSION_LOG_CORRUPTED",
  )
  assert.deepEqual(state.calls, ["readEvents"])
  assert.equal(state.events.length, initial.length)

  const missingFirstMessage = repairFixture([
    persistedEvent(sessionId, 1, { type: "turn/start", turn: 1, model: MODEL }),
    persistedEvent(sessionId, 2, { type: "step/start", turn: 1, step: 1 }),
  ])
  await assert.rejects(missingFirstMessage.repair(), SessionLogCorruptedError)
  assert.deepEqual(missingFirstMessage.calls, ["readEvents"])
}

async function testConcreteRuntimeBindings(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-runtime-bindings-"))
  try {
    const sessionId = "session-concrete"
    const sessionDirectory = join(root, sessionId)
    let baseline: CurrentSessionBaseline = {
      agentsmd: {
        path: join(root, "AGENTS.md"),
        hash: "hash-1",
        content: "Use npm.",
      },
      skills: {
        content: "skills-1",
        entries: [{ name: "alpha", scope: "global" as const, enabled: true, estimatedTokens: 5 }],
        descriptions: { alpha: "alpha" },
      },
      mcp: [],
    }
    const createdAdapters: Array<import("../../model/src/types.ts").ModelAdapter> = []
    const metaDatabasePath = join(root, "meta.sqlite")
    initializeSessionMetaDatabase(metaDatabasePath)
    const runtime = new SessionRuntime({
      projectGroupId: "00000000-0000-4000-8000-000000000001",
      databasePath: join(root, "events.sqlite"),
      metaDatabasePath,
      sessionId,
      sessionDirectory,
      systemPrompt: "system",
      global: {
        resolveProjectContext: () => ({
          workspaceInfo: "workspace",
          resolveCurrentBaseline: async () => baseline,
        }),
        estimateSkillTokens: (description: string) => description.length,
        createTurnModelAdapter: async (model: ModelRef) => {
          if (model.modelId === "missing") throw new Error("model missing")
          const adapter = {
            stream: async function* () {
              yield { type: "stream_end" as const, completion: "finished" as const }
            },
          }
          createdAdapters.push(adapter)
          return adapter
        },
        listToolDefinitions: () => [],
        executeTool: async () => ({ status: "success", content: [] }),
      } as unknown as SessionRuntimeGlobal,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      createEventId: (() => {
        let id = 0
        return () => "concrete-" + ++id
      })(),
    })

    await runtime.createSessionDirectory()
    await assert.rejects(runtime.createSessionDirectory(), /无法创建 Session 目录/)
    const first = await runtime.appendTurnStartAndUserMessage([
      { type: "turn/start", turn: 1, model: MODEL },
      { type: "user/message", turn: 1, message: { id: "user-1", role: "user", content: MESSAGE } },
    ])
    assert.deepEqual(first.map((event) => event.seq), [1, 2])
    await runtime.initializeSession()
    assert.deepEqual(await runtime.buildContent(1), [
      { role: "system", content: "system\n\nworkspace\n\nUse npm.\n\nskills-1" },
      { role: "user", content: MESSAGE },
    ])

    const loopResources = await runtime.createLoopOptions(MODEL)
    assert.equal(loopResources.adapter, createdAdapters[0])
    assert.deepEqual(loopResources.tools, [])
    const nextTurnResources = await runtime.createLoopOptions(MODEL)
    assert.notEqual(loopResources.adapter, nextTurnResources.adapter)
    assert.equal(createdAdapters.length, 2)

    await runtime.appendEvent({ type: "turn/end", turn: 1, reason: "completed" })
    baseline = {
      agentsmd: {
        path: join(root, "AGENTS.md"),
        hash: "hash-2",
        content: "Use pnpm.",
      },
      skills: {
        content: "skills-2",
        entries: [{ name: "beta", scope: "project" as const, enabled: true, estimatedTokens: 4 }],
        descriptions: { beta: "beta" },
      },
      mcp: [],
    }
    await runtime.prepareExistingTurn()
    await runtime.appendTurnStartAndUserMessage([
      { type: "turn/start", turn: 2, model: MODEL },
      { type: "user/message", turn: 2, message: { id: "user-2", role: "user", content: [{ type: "text", text: "继续" }] } },
    ])

    const content = await runtime.buildContent(2)
    assert.equal(content[0]?.role, "system")
    assert.equal(content[0]?.content, "system\n\nworkspace\n\nUse pnpm.\n\nskills-2")
    assert.deepEqual(content.slice(1).map((message) => message.role), ["user", "user", "user", "user"])
    const log = await runtime.readEvents() as SessionEvent[]
    const updates = log.filter((event) => event.type === "context_update")
    assert.equal(updates.length, 2)
    assert.match(updates[0].content, /Removed:\nUse npm\./)
    assert.match(updates[0].content, /Added:\nUse pnpm\./)
    assert.deepEqual(updates[1].source, {
      type: "skill",
      changes: [
        { type: "new", name: "beta", scope: "project", description: "beta" },
        { type: "disabled", name: "alpha" },
      ],
    })

    await runtime.appendEvent({
      type: "summary/start",
      turn: 2,
      summaryId: "summary-1",
      throughEventSeq: 5,
    })
    await runtime.appendEvent({
      type: "summary/end",
      turn: 2,
      summaryId: "summary-1",
      summary: "Earlier context summary.",
      throughEventSeq: 5,
    })
    assert.deepEqual(await runtime.buildContent(2), [
      { role: "system", content: "system\n\nworkspace\n\nUse pnpm.\n\nskills-2" },
      { role: "user", content: "Earlier context summary." },
      { role: "user", content: [{ type: "text", text: "继续" }] },
    ])
    await assert.rejects(
      runtime.createLoopOptions({ ...MODEL, modelId: "missing" }),
      /model missing/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function testRuntimeScopedCancellation(): Promise<void> {
  const first = fixture("session-cancellation-1")
  const second = fixture("session-cancellation-2")
  const firstOptions = await first.ports.createLoopOptions(MODEL)
  const nextTurnOptions = await first.ports.createLoopOptions(MODEL)
  const otherRuntimeOptions = await second.ports.createLoopOptions(MODEL)

  assert.equal(firstOptions.signal, nextTurnOptions.signal)
  assert.notEqual(firstOptions.signal, otherRuntimeOptions.signal)
  assert.equal(firstOptions.signal.aborted, false)

  first.ports.stop()
  first.ports.stop()
  assert.equal(firstOptions.signal.aborted, true)
  assert.equal(nextTurnOptions.signal.aborted, true)
  assert.equal(otherRuntimeOptions.signal.aborted, false)
  assert.throws(
    () => first.ports.enqueueSessionMessage({ content: MESSAGE }),
    /正在停止/,
  )

  first.ports.close()
  first.ports.stop()
  second.ports.close()
}

/**
 * 使用真实临时 SQLite 日志验证思考流停止后的收尾、幂等恢复及新实例继续发送。
 * @returns 新 Turn 正常完成、原思考内容进入回放且恢复未追加迟到事件后解析。
 * @throws Error 当临时存储或运行失败时抛出；AssertionError 表示收尾顺序或继续行为不符合契约。
 */
async function testStoppedThinkingCanContinue(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-stop-continue-"))
  const metaDatabasePath = join(root, "meta.sqlite")
  initializeSessionMetaDatabase(metaDatabasePath)
  let active: SessionRuntime | undefined
  let requests = 0
  const global = {
    resolveProjectContext: () => ({
      workspaceInfo: "workspace",
      resolveCurrentBaseline: async (): Promise<CurrentSessionBaseline> => ({
        agentsmd: { path: join(root, "AGENTS.md"), hash: "empty", content: "" },
        skills: { content: "", entries: [], descriptions: {} }, mcp: [],
      }),
    }),
    estimateSkillTokens: () => 0,
    createTurnModelAdapter: async () => ({
      stream: async function* (request: Parameters<ModelAdapter["stream"]>[0]): AsyncGenerator<ModelStreamEvent> {
        requests++
        if (requests === 1) {
          yield { type: "block_start", index: 0, blockType: "thinking" }
          yield { type: "block_delta", index: 0, delta: { type: "thinking", text: "停止前的思考" } }
          active!.stop()
          throw createAbortError()
        }
        assert.ok(request.context.messages.some((message) => message.role === "assistant" &&
          Array.isArray(message.content) && message.content.some((block) => block.type === "thinking" && block.text === "停止前的思考")))
        yield { type: "block_start", index: 0, blockType: "text" }
        yield { type: "block_end", index: 0, block: { type: "text", text: "已继续" } }
        yield { type: "stream_end", completion: "finished" }
      },
    }),
    listToolDefinitions: () => [],
    executeTool: async () => { throw new Error("unexpected tool") },
  } as unknown as SessionRuntimeGlobal
  const options = {
    sessionId: "session-stop-continue", projectGroupId: "default" as const,
    sessionDirectory: join(root, "session-stop-continue"), databasePath: join(root, "events.sqlite"),
    metaDatabasePath, systemPrompt: "system", global,
  }
  try {
    active = new SessionRuntime(options)
    const first = await active.startNewSession({ model: MODEL, content: MESSAGE })
    assert.equal((await first.completion).stopped, true)
    const stoppedEvents = await active.readEvents() as SessionEvent[]
    assert.deepEqual(stoppedEvents.map((event) => event.type), [
      "turn/start", "user/message", "step/start", "assistant/block_start", "assistant/block_delta",
      "assistant/block_end", "assistant/message", "step/end", "turn/end",
    ])
    active.close()
    active = new SessionRuntime(options)
    assert.deepEqual(await active.repairSession(), { lastTurn: 1 })
    assert.deepEqual(await active.repairSession(), { lastTurn: 1 })
    assert.deepEqual(await active.readEvents(), stoppedEvents, "停止后的恢复不得再补写块或消息")
    const second = await active.continueSession({ model: MODEL, content: [{ type: "text", text: "继续" }] })
    assert.equal(second.turn, 2)
    assert.equal((await second.completion).stopped, false)
    assert.equal(requests, 2)
    const completedEvents = await active.readEvents()
    await active.repairSession()
    assert.deepEqual(await active.readEvents(), completedEvents)
  } finally {
    active?.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await testNewSession()
  await testContinueSession()
  await testOneAdapterServesAllStepsInTurn()
  await testQueuedMessagesRunInOrder()
  await testFailureBoundaries()
  await testRepairInterruptedTextStep()
  await testRepairApprovalAndToolResults()
  await testInterruptedToolCallDoesNotCreateOrphanResult()
  await testRepairPreservesContextAndUncommittedSummary()
  await testCorruptedLogIsRejectedBeforeWrites()
  await testConcreteRuntimeBindings()
  await testRuntimeScopedCancellation()
  await testStoppedThinkingCanContinue()
  console.log("session-runtime.test.ts: SessionRuntime 入口与恢复断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
