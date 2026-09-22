import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ModelRef } from "../../model/src/types.ts"
import type { CurrentSessionBaseline } from "../../session/src/session-state.ts"
import type {
  SessionEvent,
  SessionEventInput,
} from "../../session/src/events.ts"
import {
  continueSession,
  createRepairSession,
  SessionRuntimeBindings,
  SessionRuntimePorts,
  SessionLogCorruptedError,
  startNewSession,
} from "../src/session-runtime.ts"
import type { SessionRepairPorts } from "../src/session-runtime.ts"

const MODEL: ModelRef = { providerId: "provider-1", protocol: "anthropic_messages", modelId: "model-1" }
const MESSAGE = [{ type: "text" as const, text: "你好" }]

function fixture(
  sessionId = "session-1",
  initialEvents: readonly SessionEvent[] = [],
): {
  ports: SessionRuntimePorts
  bindings: SessionRuntimeBindings
  repairPorts: SessionRepairPorts
  calls: string[]
  batches: Parameters<SessionRuntimeBindings["appendTurnStartAndUserMessage"]>[0][]
  events: SessionEvent[]
  loopEvents: SessionEventInput[]
  seenModels: ModelRef[]
} {
  const calls: string[] = []
  const batches: Parameters<SessionRuntimeBindings["appendTurnStartAndUserMessage"]>[0][] = []
  const events = [...initialEvents]
  const loopEvents: SessionEventInput[] = []
  const seenModels: ModelRef[] = []
  const repairPorts: SessionRepairPorts = {
    readEvents: async () => {
      calls.push("readEvents")
      return events
    },
    initializeSession: async () => { calls.push("initialize") },
    repairDerivedState: async () => {
      calls.push("repairDerivedState")
      return { currentModel: MODEL }
    },
    appendEvent: async (input) => {
      loopEvents.push(input)
      calls.push(input.type)
      const event = persistedEvent(sessionId, events.length + 1, input)
      events.push(event)
      return event
    },
  }
  const bindings = {
    createSessionDirectory: async () => { calls.push("createDirectory") },
    appendTurnStartAndUserMessage: async (
      inputs: Parameters<SessionRuntimeBindings["appendTurnStartAndUserMessage"]>[0],
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
    repairPorts,
  } as unknown as SessionRuntimeBindings
  const ports = new SessionRuntimePorts(sessionId, bindings)
  return { ports, bindings, repairPorts, calls, batches, events, loopEvents, seenModels }
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
  repair: () => Promise<{ lastTurn: number; currentModel: ModelRef }>
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
      return { currentModel: MODEL }
    },
    appendEvent: async (input) => {
      calls.push(`append:${input.type}`)
      const event = persistedEvent(initial[0]?.sessionId ?? "session-repair", events.length + 1, input)
      events.push(event)
      return event
    },
  }
  const sessionId = initial[0]?.sessionId ?? "session-repair"
  return { events, calls, repair: createRepairSession(sessionId, ports), ports }
}

async function testNewSession(): Promise<void> {
  const { ports, repairPorts, calls, batches, loopEvents, seenModels } = fixture()
  let releaseInitialization!: () => void
  const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve })
  repairPorts.initializeSession = async () => {
    calls.push("initialize")
    await initializationGate
  }

  const started = await startNewSession({ content: MESSAGE, model: MODEL }, ports)
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
  assert.deepEqual(calls.slice(3, 5), ["buildContent", "createLoopOptions"])
}

async function testContinueSession(): Promise<void> {
  const { ports, calls, batches, seenModels } = fixture(
    "session-existing",
    completedSessionEvents("session-existing"),
  )
  const started = await continueSession({ content: MESSAGE }, ports)
  assert.equal(started.sessionId, "session-existing")
  assert.equal(started.turn, 2)
  await started.completion
  assert.deepEqual(calls.slice(0, 6), [
    "readEvents",
    "initialize",
    "repairDerivedState",
    "prepare",
    "appendBatch",
    "buildContent",
  ])
  assert.deepEqual(batches[0]?.[0], { type: "turn/start", turn: 2, model: MODEL })
  assert.deepEqual(seenModels, [MODEL])
}

async function testQueuedMessagesRunInOrder(): Promise<void> {
  const state = fixture("session-queue")
  let releaseInitialization!: () => void
  const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve })
  state.repairPorts.initializeSession = async () => {
    state.calls.push("initialize")
    await initializationGate
  }
  const started = await startNewSession({ content: MESSAGE, model: MODEL }, state.ports)
  const processing = state.ports.processMessageQueue(started)
  const second = [{ type: "text" as const, text: "第二条" }]
  const third = [{ type: "text" as const, text: "第三条" }]
  assert.deepEqual(state.ports.enqueueSessionMessage(second), {
    sessionId: "session-queue",
    content: second,
  })
  state.ports.enqueueSessionMessage(third)
  releaseInitialization()
  await processing.completion

  assert.deepEqual(state.batches.map((batch) => batch[0].turn), [1, 2, 3])
  assert.deepEqual(
    state.batches.map((batch) => batch[1].message.content),
    [MESSAGE, second, third],
  )
  assert.deepEqual(state.seenModels, [MODEL, MODEL, MODEL])
  assert.throws(() => state.ports.enqueueSessionMessage(MESSAGE), /已关闭/)
}

async function testFailureBoundaries(): Promise<void> {
  const failedBatch = fixture()
  failedBatch.bindings.appendTurnStartAndUserMessage = async () => { throw new Error("batch failed") }
  await assert.rejects(startNewSession({ content: MESSAGE, model: MODEL }, failedBatch.ports), /batch failed/)
  assert.deepEqual(failedBatch.calls, ["createDirectory"])

  const failedRepair = fixture("session-existing", completedSessionEvents("session-existing"))
  failedRepair.repairPorts.readEvents = async () => { throw new Error("repair failed") }
  await assert.rejects(continueSession({ content: MESSAGE }, failedRepair.ports), /repair failed/)
  assert.deepEqual(failedRepair.calls, [])

  const failedInitialization = fixture()
  failedInitialization.repairPorts.initializeSession = async () => { throw new Error("initialize failed") }
  const started = await startNewSession({ content: MESSAGE, model: MODEL }, failedInitialization.ports)
  await assert.rejects(started.completion, /initialize failed/)
  assert.deepEqual(
    failedInitialization.loopEvents.map((event) => event.type),
    ["turn/end"],
  )
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

  assert.deepEqual(await state.repair(), { lastTurn: 1, currentModel: MODEL })
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
  assert.deepEqual(await state.repair(), { lastTurn: 2, currentModel: MODEL })
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
    const adapter = {
      stream: async function* () {
        yield { type: "stream_end" as const, completion: "finished" as const }
      },
    }
    const bindings = new SessionRuntimeBindings({
      sessionId,
      sessionDirectory,
      systemPrompt: "system",
      workspaceInfo: "workspace",
      resolveCurrentBaseline: async () => baseline,
      estimateSkillTokens: (description) => description.length,
      adapters: [{ model: MODEL, adapter }],
      executeTool: async () => ({ status: "success", content: [] }),
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      createEventId: (() => {
        let id = 0
        return () => `concrete-${++id}`
      })(),
    })

    await bindings.createSessionDirectory()
    await assert.rejects(bindings.createSessionDirectory(), /无法创建 Session 目录/)
    const first = await bindings.appendTurnStartAndUserMessage([
      { type: "turn/start", turn: 1, model: MODEL },
      { type: "user/message", turn: 1, message: { id: "user-1", role: "user", content: MESSAGE } },
    ])
    assert.deepEqual(first.map((event) => event.seq), [1, 2])
    await bindings.repairPorts.initializeSession()
    assert.deepEqual(await bindings.buildContent(1), [
      { role: "system", content: "system\n\nworkspace\n\nUse npm.\n\nskills-1" },
      { role: "user", content: MESSAGE },
    ])

    const loopResources = await bindings.createLoopOptions(MODEL)
    assert.equal(loopResources.adapter, adapter)
    assert.deepEqual(loopResources.tools, [])

    await bindings.repairPorts.appendEvent({ type: "turn/end", turn: 1, reason: "completed" })
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
    await bindings.prepareExistingTurn((event) => bindings.repairPorts.appendEvent(event))
    await bindings.appendTurnStartAndUserMessage([
      { type: "turn/start", turn: 2, model: MODEL },
      { type: "user/message", turn: 2, message: { id: "user-2", role: "user", content: [{ type: "text", text: "继续" }] } },
    ])

    const content = await bindings.buildContent(2)
    assert.equal(content[0]?.role, "system")
    assert.equal(content[0]?.content, "system\n\nworkspace\n\nUse pnpm.\n\nskills-2")
    assert.deepEqual(content.slice(1).map((message) => message.role), ["user", "user", "user", "user"])
    const log = (await readFile(join(sessionDirectory, "events.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEvent)
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

    await bindings.repairPorts.appendEvent({
      type: "summary/start",
      turn: 2,
      summaryId: "summary-1",
      throughEventSeq: 5,
    })
    await bindings.repairPorts.appendEvent({
      type: "summary/end",
      turn: 2,
      summaryId: "summary-1",
      summary: "Earlier context summary.",
      throughEventSeq: 5,
    })
    assert.deepEqual(await bindings.buildContent(2), [
      { role: "system", content: "system\n\nworkspace\n\nUse pnpm.\n\nskills-2" },
      { role: "user", content: "Earlier context summary." },
      { role: "user", content: [{ type: "text", text: "继续" }] },
    ])
    await assert.rejects(
      bindings.createLoopOptions({ ...MODEL, modelId: "missing" }),
      /匹配数量 0/,
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
    () => first.ports.enqueueSessionMessage(MESSAGE),
    /正在停止/,
  )

  first.ports.close()
  first.ports.stop()
  second.ports.close()
}

async function main(): Promise<void> {
  await testNewSession()
  await testContinueSession()
  await testQueuedMessagesRunInOrder()
  await testFailureBoundaries()
  await testRepairInterruptedTextStep()
  await testRepairApprovalAndToolResults()
  await testInterruptedToolCallDoesNotCreateOrphanResult()
  await testRepairPreservesContextAndUncommittedSummary()
  await testCorruptedLogIsRejectedBeforeWrites()
  await testConcreteRuntimeBindings()
  await testRuntimeScopedCancellation()
  console.log("session-runtime.test.ts: SessionRuntime 入口与恢复断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
