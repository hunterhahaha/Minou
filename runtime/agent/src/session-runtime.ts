/**
 * SessionRuntime 的两个 Turn 入口（架构备忘录第 13.1、13.2 节）。
 *
 * Event Log 读写、派生状态修复、增量检查和 ContextBuilder 由 ports 提供；本文件实现
 * 第 10 节确定的 Event Log 校验与补写顺序，可用 createRepairSession 绑定 repairSession。
 * appendTurnStartAndUserMessage 必须在一个持久化批次中提交两条事件；失败不能启动 Loop。
 * 当前 runAgentLoop 只负责 Step，Turn 收尾仍由调用方处理。
 */

import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { CANCELLED } from "../../error/src/normalizer.ts"
import type { ModelMessage, ModelRef, ModelTextBlock } from "../../model/src/types.ts"
import type {
  ApprovalRequestEvent,
  ApprovalResultEvent,
  AssistantBlockDeltaEvent,
  AssistantBlockEndEvent,
  AssistantBlockStartEvent,
  AssistantMessageEvent,
  SessionEvent,
  SessionEventInput,
  StepStartEvent,
  ToolResultEvent,
  TurnStartEvent,
  TurnStartEventInput,
  UserMessageInput,
  UserMessageEventInput,
} from "../../session/src/events.ts"
import type { ToolResult } from "../../tools/src/types.ts"
import { runAgentLoop } from "./loop.ts"
import type { AgentLoopOptions, AgentLoopResult } from "./loop.ts"

export interface SessionRuntimePorts {
  /** 在目标 Project/default 分组下创建 Session 目录。 */
  createSessionDirectory(sessionId: string): Promise<void>
  /**
   * 两条事件一次提交，顺序固定；实现者负责分配事件身份和持久化。
   * 同一 Session 并发启动时，须确保 turn 仍是下一个编号，否则拒绝提交。
   */
  appendTurnStartAndUserMessage(
    sessionId: string,
    events: readonly [TurnStartEventInput, UserMessageEventInput],
  ): Promise<void>
  /** 首次事件已提交后，幂等补齐其余 Session 状态。 */
  initializeSession(sessionId: string): Promise<void>
  /** 修复已有 Session，返回已提交的最后 Turn 和当前模型。 */
  repairSession(sessionId: string): Promise<{ lastTurn: number; currentModel: ModelRef }>
  /** 已有 Session 的 AGENTS.md / Skills 增量检查；先提交事件再更新比较状态。 */
  prepareExistingTurn(sessionId: string): Promise<void>
  /** 在进入 Loop 前构建一次完整 content。 */
  buildContent(sessionId: string, turn: number): Promise<ModelMessage[]>
  /** 提供尚未由 SessionRuntime 装配的 Adapter、工具、取消信号和事件出口。 */
  createLoopOptions(
    sessionId: string,
    model: ModelRef,
  ): Promise<Omit<AgentLoopOptions, "turn" | "model" | "content">>
}

export interface StartedAgentLoop {
  sessionId: string
  turn: number
  /** 成批提交新 Turn 后启动；调用方需等待并处理运行结果或错误。 */
  completion: Promise<AgentLoopResult>
}

export interface ContinueSessionInput {
  content: ModelTextBlock[]
  /** 省略时使用 repairSession 返回的 meta.currentModel。 */
  model?: ModelRef
}

/** `repairSession` 读取和修复 Event Log 所需的最小持久化端口。 */
export interface SessionRepairPorts {
  /** 检查 Session 目录并返回逐行解析后的 Event Log；缺失目录或日志时应拒绝。 */
  readEvents(sessionId: string): Promise<readonly unknown[]>
  /** 幂等补齐首次初始化可能缺失的 Session 派生文件。 */
  initializeSession(sessionId: string): Promise<void>
  /**
   * 根据已校验的日志修复 meta / contextstate / snapshot 等派生状态，并返回当前模型。
   * 该端口不得改写 Event Log。
   */
  repairDerivedState(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<{ currentModel: ModelRef }>
  /** 追加一条恢复事件并返回已经分配身份、成功落盘的事件。 */
  appendEvent(sessionId: string, event: SessionEventInput): Promise<SessionEvent>
}

export const SESSION_LOG_CORRUPTED = "SESSION_LOG_CORRUPTED"

/** Event Log 无法按架构规则解释时抛出的统一 Storage 错误。 */
export class SessionLogCorruptedError extends Error {
  readonly source = "storage" as const
  readonly code = SESSION_LOG_CORRUPTED

  constructor(sessionId: string, detail: string) {
    super(`Session Event Log 已损坏（${sessionId}）：${detail}`)
    this.name = "SessionLogCorruptedError"
  }
}

/**
 * 创建可直接赋给 `SessionRuntimePorts.repairSession` 的实现。
 * 持久化细节保留在 ports，恢复顺序和补写决策集中在本文件。
 */
export function createRepairSession(
  ports: SessionRepairPorts,
): SessionRuntimePorts["repairSession"] {
  return (sessionId) => repairSession(sessionId, ports)
}

/** 按开发备忘录第 10 节把 Session 修复到可继续创建新 Turn 的一致状态。 */
export async function repairSession(
  sessionId: string,
  ports: SessionRepairPorts,
): Promise<{ lastTurn: number; currentModel: ModelRef }> {
  const events = validateEventLog(sessionId, await ports.readEvents(sessionId))
  const lifecycle = validateLifecycle(sessionId, events)
  validateBlockStreams(sessionId, events)
  validateSummaries(sessionId, events)

  await ports.initializeSession(sessionId)
  const { currentModel } = await ports.repairDerivedState(sessionId, events)

  const append = async (input: SessionEventInput): Promise<SessionEvent> => {
    const previousSeq = events.at(-1)?.seq ?? 0
    const written = validateSessionEvent(sessionId, await ports.appendEvent(sessionId, input), events.length)
    if (written.type !== input.type) {
      corrupted(sessionId, `追加 ${input.type} 后返回了 ${written.type}`)
    }
    for (const [field, expected] of Object.entries(input)) {
      if (!isDeepStrictEqual((written as unknown as Record<string, unknown>)[field], expected)) {
        corrupted(sessionId, `追加 ${input.type} 后返回的 ${field} 与请求不一致`)
      }
    }
    if (written.seq <= previousSeq) {
      corrupted(sessionId, `追加事件的 seq ${written.seq} 未大于 ${previousSeq}`)
    }
    if (events.some((event) => event.eventId === written.eventId)) {
      corrupted(sessionId, `追加事件使用了重复 eventId：${written.eventId}`)
    }
    events.push(written)
    return written
  }

  await repairBlockEnds(sessionId, events, append)
  await repairAssistantMessages(sessionId, events, append)
  await repairApprovalsAndToolResults(sessionId, events, append)

  if (lifecycle.openStep !== undefined) {
    await append({
      type: "step/end",
      turn: lifecycle.openStep.turn,
      step: lifecycle.openStep.step,
      reason: "error",
    })
  }
  if (lifecycle.openTurn !== undefined) {
    await append({ type: "turn/end", turn: lifecycle.openTurn, reason: "error" })
  }

  return { lastTurn: lifecycle.lastTurn, currentModel }
}

/** 首次创建 Session。成功提交首批事件后即返回 sessionId，并继续初始化和运行。 */
export async function startNewSession(
  input: UserMessageInput,
  ports: SessionRuntimePorts,
): Promise<StartedAgentLoop> {
  const sessionId = randomUUID()
  const turn = 1

  await ports.createSessionDirectory(sessionId)
  await ports.appendTurnStartAndUserMessage(sessionId, turnEvents(turn, input.model, input.content))

  const completion = (async () => {
    await ports.initializeSession(sessionId)
    return startLoop(sessionId, turn, input.model, ports)
  })()
  return { sessionId, turn, completion }
}

/** 在已修复的 Session 上创建下一 Turn，然后进入同一个 AgentLoop。 */
export async function continueSession(
  sessionId: string,
  input: ContinueSessionInput,
  ports: SessionRuntimePorts,
): Promise<StartedAgentLoop> {
  const state = await ports.repairSession(sessionId)
  await ports.prepareExistingTurn(sessionId)

  const turn = state.lastTurn + 1
  const model = input.model ?? state.currentModel
  await ports.appendTurnStartAndUserMessage(sessionId, turnEvents(turn, model, input.content))

  return { sessionId, turn, completion: startLoop(sessionId, turn, model, ports) }
}

function turnEvents(
  turn: number,
  model: ModelRef,
  content: ModelTextBlock[],
): readonly [TurnStartEventInput, UserMessageEventInput] {
  return [
    { type: "turn/start", turn, model },
    { type: "user/message", turn, message: { id: randomUUID(), role: "user", content } },
  ]
}

async function startLoop(
  sessionId: string,
  turn: number,
  model: ModelRef,
  ports: SessionRuntimePorts,
): Promise<AgentLoopResult> {
  const content = await ports.buildContent(sessionId, turn)
  const options = await ports.createLoopOptions(sessionId, model)
  return runAgentLoop({ ...options, turn, model, content })
}

type AppendRecoveryEvent = (event: SessionEventInput) => Promise<SessionEvent>

interface LifecycleState {
  lastTurn: number
  openTurn?: number
  openStep?: { turn: number; step: number }
}

interface BlockStream {
  start: AssistantBlockStartEvent
  deltas: AssistantBlockDeltaEvent[]
  end?: AssistantBlockEndEvent
}

interface AuthoritativeToolCall {
  message: AssistantMessageEvent
  end: AssistantBlockEndEvent & {
    block: Extract<AssistantBlockEndEvent["block"], { type: "tool_call" }>
  }
}

const APPROVAL_DENIED = "APPROVAL_DENIED"
const EXECUTION_STATE_UNKNOWN = "EXECUTION_STATE_UNKNOWN"

type RecoveryToolErrorCode =
  | typeof CANCELLED
  | typeof APPROVAL_DENIED
  | typeof EXECUTION_STATE_UNKNOWN

function validateEventLog(sessionId: string, values: readonly unknown[]): SessionEvent[] {
  if (values.length < 2) {
    corrupted(sessionId, "缺少同批提交的首个 turn/start 与 user/message")
  }

  const events: SessionEvent[] = []
  const eventIds = new Set<string>()
  let previousSeq = 0

  for (const [index, value] of values.entries()) {
    const event = validateSessionEvent(sessionId, value, index)
    if (event.seq <= previousSeq) {
      corrupted(sessionId, `第 ${index + 1} 条事件的 seq 未严格递增`)
    }
    if (eventIds.has(event.eventId)) {
      corrupted(sessionId, `eventId 重复：${event.eventId}`)
    }
    previousSeq = event.seq
    eventIds.add(event.eventId)
    events.push(event)
  }

  const first = events[0]
  const second = events[1]
  if (first.type !== "turn/start" || first.turn !== 1) {
    corrupted(sessionId, "首条事件不是 turn=1 的 turn/start")
  }
  if (second.type !== "user/message" || second.turn !== 1) {
    corrupted(sessionId, "首个 turn/start 缺少同批提交的首条 user/message")
  }
  for (const [index, event] of events.entries()) {
    if (event.type !== "turn/start") continue
    const next = events[index + 1]
    if (next?.type !== "user/message" || next.turn !== event.turn) {
      corrupted(sessionId, `turn/start ${event.turn} 缺少同批提交的首条 user/message`)
    }
  }

  return events
}

function validateSessionEvent(sessionId: string, value: unknown, index: number): SessionEvent {
  if (!isRecord(value)) corrupted(sessionId, `第 ${index + 1} 条事件不是对象`)
  const event = value as Record<string, unknown>
  if (!isNonEmptyString(event.eventId)) corrupted(sessionId, `第 ${index + 1} 条事件缺少 eventId`)
  if (event.sessionId !== sessionId) corrupted(sessionId, `第 ${index + 1} 条事件的 sessionId 不匹配`)
  if (!isPositiveInteger(event.seq)) corrupted(sessionId, `第 ${index + 1} 条事件的 seq 无效`)
  if (!isNonEmptyString(event.createdAt)) corrupted(sessionId, `第 ${index + 1} 条事件缺少 createdAt`)

  switch (event.type) {
    case "turn/start":
      requireTurn(sessionId, event, index)
      requireModel(sessionId, event.model, index)
      break
    case "turn/end":
      requireTurn(sessionId, event, index)
      requireEndReason(sessionId, event.reason, index)
      break
    case "user/message":
      requireTurn(sessionId, event, index)
      requireUserMessage(sessionId, event.message, index)
      break
    case "step/start":
      requireTurnAndStep(sessionId, event, index)
      break
    case "step/end":
      requireTurnAndStep(sessionId, event, index)
      requireEndReason(sessionId, event.reason, index)
      break
    case "assistant/block_start":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "blockId", index)
      if (!isNonNegativeInteger(event.index)) corrupted(sessionId, `第 ${index + 1} 条事件的块 index 无效`)
      if (event.blockType !== "thinking" && event.blockType !== "text" && event.blockType !== "tool_call") {
        corrupted(sessionId, `第 ${index + 1} 条事件的 blockType 无效`)
      }
      break
    case "assistant/block_delta":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "blockId", index)
      requireBlockDelta(sessionId, event.delta, index)
      break
    case "assistant/block_end":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "blockId", index)
      if (!isNonNegativeInteger(event.index)) corrupted(sessionId, `第 ${index + 1} 条事件的块 index 无效`)
      requireAssistantBlock(sessionId, event.block, index)
      break
    case "assistant/message":
      requireTurnAndStep(sessionId, event, index)
      requireAssistantMessage(sessionId, event.message, index)
      requireModel(sessionId, event.model, index)
      if (event.usage !== undefined) requireUsage(sessionId, event.usage, index)
      if (event.finishReason !== undefined && typeof event.finishReason !== "string") {
        corrupted(sessionId, `第 ${index + 1} 条事件的 finishReason 无效`)
      }
      break
    case "tool/result":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "toolCallEventId", index)
      requireStringField(sessionId, event, "toolCallId", index)
      requireStringField(sessionId, event, "blockId", index)
      requireToolResult(sessionId, event.result, index)
      break
    case "approval/request":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "approvalId", index)
      requireStringField(sessionId, event, "toolCallEventId", index)
      requireStringField(sessionId, event, "toolCallId", index)
      requireStringField(sessionId, event, "blockId", index)
      requireStringField(sessionId, event, "toolName", index)
      if (event.reason !== undefined && typeof event.reason !== "string") {
        corrupted(sessionId, `第 ${index + 1} 条事件的 approval reason 无效`)
      }
      break
    case "approval/result":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "approvalId", index)
      if (event.decision !== "approved" && event.decision !== "denied" && event.decision !== "cancelled") {
        corrupted(sessionId, `第 ${index + 1} 条事件的 approval decision 无效`)
      }
      break
    case "context_update":
      requireTurn(sessionId, event, index)
      if (typeof event.content !== "string" || !isRecord(event.source)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 context_update 无效`)
      }
      if (event.source.type === "agents_md") {
        if (
          !isNonEmptyString(event.source.path) ||
          !isNonEmptyString(event.source.hash) ||
          typeof event.source.fullContent !== "string"
        ) {
          corrupted(sessionId, `第 ${index + 1} 条事件的 agents_md source 无效`)
        }
      } else if (event.source.type === "skill") {
        if (!Array.isArray(event.source.changes)) {
          corrupted(sessionId, `第 ${index + 1} 条事件的 skill changes 无效`)
        }
      } else {
        corrupted(sessionId, `第 ${index + 1} 条事件的 context_update source 无效`)
      }
      break
    case "app/error":
      if (event.turn !== undefined && !isPositiveInteger(event.turn)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 turn 无效`)
      }
      if (event.step !== undefined && !isPositiveInteger(event.step)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 step 无效`)
      }
      if (
        !isRecord(event.error) ||
        !isAppErrorSource(event.error.source) ||
        !isNonEmptyString(event.error.code) ||
        typeof event.error.message !== "string"
      ) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 AppError 无效`)
      }
      if (event.sourceEventId !== undefined && !isNonEmptyString(event.sourceEventId)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 sourceEventId 无效`)
      }
      break
    case "summary/start":
      requireTurn(sessionId, event, index)
      requireStringField(sessionId, event, "summaryId", index)
      if (!isPositiveInteger(event.throughEventSeq)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 throughEventSeq 无效`)
      }
      break
    case "summary/end":
      requireTurn(sessionId, event, index)
      requireStringField(sessionId, event, "summaryId", index)
      if (!isNonEmptyString(event.summary) || !isPositiveInteger(event.throughEventSeq)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 summary/end 无效`)
      }
      if (event.usage !== undefined) requireUsage(sessionId, event.usage, index)
      break
    case "turn/file_changes":
      requireTurn(sessionId, event, index)
      if (!Array.isArray(event.files)) corrupted(sessionId, `第 ${index + 1} 条事件的 files 无效`)
      break
    default:
      corrupted(sessionId, `第 ${index + 1} 条事件类型未知：${String(event.type)}`)
  }

  return event as unknown as SessionEvent
}

function validateLifecycle(sessionId: string, events: readonly SessionEvent[]): LifecycleState {
  const turns = new Map<number, TurnStartEvent>()
  const endedTurns = new Set<number>()
  const stepStarts = new Map<string, StepStartEvent>()
  const stepEnds = new Set<string>()
  const lastStepByTurn = new Map<number, number>()
  let openTurn: number | undefined
  let openStep: { turn: number; step: number } | undefined

  for (const event of events) {
    switch (event.type) {
      case "turn/start": {
        if (openTurn !== undefined) {
          corrupted(sessionId, `turn ${event.turn} 开始时 turn ${openTurn} 尚未结束`)
        }
        if (turns.has(event.turn) || event.turn !== turns.size + 1) {
          corrupted(sessionId, `turn/start 编号不连续或重复：${event.turn}`)
        }
        turns.set(event.turn, event)
        openTurn = event.turn
        break
      }
      case "turn/end": {
        if (!turns.has(event.turn)) corrupted(sessionId, `turn/end ${event.turn} 没有对应 turn/start`)
        if (endedTurns.has(event.turn)) corrupted(sessionId, `turn/end ${event.turn} 重复`)
        if (openTurn !== event.turn) corrupted(sessionId, `turn/end ${event.turn} 不在当前 Turn`)
        if (openStep !== undefined) {
          corrupted(sessionId, `turn/end ${event.turn} 之前 step ${openStep.step} 尚未结束`)
        }
        endedTurns.add(event.turn)
        openTurn = undefined
        break
      }
      case "step/start": {
        if (!turns.has(event.turn)) corrupted(sessionId, `step/start ${event.turn}:${event.step} 缺少 turn/start`)
        if (openTurn !== event.turn || endedTurns.has(event.turn)) {
          corrupted(sessionId, `step/start ${event.turn}:${event.step} 不在开放的 Turn 中`)
        }
        if (openStep !== undefined) {
          corrupted(sessionId, `step ${event.turn}:${event.step} 开始时上一个 Step 尚未结束`)
        }
        const expected = (lastStepByTurn.get(event.turn) ?? 0) + 1
        const key = stepKey(event.turn, event.step)
        if (event.step !== expected || stepStarts.has(key)) {
          corrupted(sessionId, `step/start 编号不连续或重复：${event.turn}:${event.step}`)
        }
        stepStarts.set(key, event)
        lastStepByTurn.set(event.turn, event.step)
        openStep = { turn: event.turn, step: event.step }
        break
      }
      case "step/end": {
        const key = stepKey(event.turn, event.step)
        if (!stepStarts.has(key)) corrupted(sessionId, `step/end ${key} 没有对应 step/start`)
        if (stepEnds.has(key)) corrupted(sessionId, `step/end ${key} 重复`)
        if (openStep?.turn !== event.turn || openStep.step !== event.step) {
          corrupted(sessionId, `step/end ${key} 不在当前 Step`)
        }
        stepEnds.add(key)
        openStep = undefined
        break
      }
      case "user/message":
        if (!turns.has(event.turn) || endedTurns.has(event.turn)) {
          corrupted(sessionId, `user/message 位于未开始或已结束的 turn ${event.turn}`)
        }
        break
      case "summary/start":
      case "summary/end":
      case "turn/file_changes":
        if (openTurn !== event.turn || endedTurns.has(event.turn) || openStep !== undefined) {
          corrupted(sessionId, `${event.type} 位于未开始或已结束的 turn ${event.turn}`)
        }
        break
      case "context_update":
        if (openTurn !== undefined || event.turn !== turns.size + 1) {
          corrupted(sessionId, `context_update 不在下一 Turn 开始前：${event.turn}`)
        }
        break
      default:
        if (isStepScopedEvent(event)) {
          if (openStep?.turn !== event.turn || openStep.step !== event.step) {
            corrupted(sessionId, `${event.type} 位于未开始或已结束的 step ${event.turn}:${event.step}`)
          }
        }
    }
  }

  return {
    lastTurn: turns.size,
    openTurn,
    openStep,
  }
}

function validateBlockStreams(sessionId: string, events: readonly SessionEvent[]): Map<string, BlockStream> {
  const streams = new Map<string, BlockStream>()
  const nextIndexByStep = new Map<string, number>()

  for (const event of events) {
    if (event.type === "assistant/block_start") {
      const key = blockKey(event.turn, event.step, event.blockId)
      if (streams.has(key)) corrupted(sessionId, `BlockStart 重复：${key}`)
      const step = stepKey(event.turn, event.step)
      const expectedIndex = nextIndexByStep.get(step) ?? 0
      if (event.index !== expectedIndex) {
        corrupted(sessionId, `Block index 不连续：${step}:${event.index}`)
      }
      nextIndexByStep.set(step, expectedIndex + 1)
      streams.set(key, { start: event, deltas: [] })
      continue
    }

    if (event.type === "assistant/block_delta") {
      const key = blockKey(event.turn, event.step, event.blockId)
      const stream = streams.get(key)
      if (stream === undefined) corrupted(sessionId, `BlockDelta 缺少 BlockStart：${key}`)
      if (stream.end !== undefined) corrupted(sessionId, `BlockEnd 后仍有 BlockDelta：${key}`)
      if (stream.start.blockType !== event.delta.type) {
        corrupted(sessionId, `BlockDelta 类型与 BlockStart 不一致：${key}`)
      }
      stream.deltas.push(event)
      continue
    }

    if (event.type === "assistant/block_end") {
      const key = blockKey(event.turn, event.step, event.blockId)
      const stream = streams.get(key)
      if (stream === undefined) corrupted(sessionId, `BlockEnd 缺少 BlockStart：${key}`)
      if (stream.end !== undefined) corrupted(sessionId, `BlockEnd 重复：${key}`)
      if (stream.start.index !== event.index || stream.start.blockType !== event.block.type) {
        corrupted(sessionId, `BlockEnd 与 BlockStart 不匹配：${key}`)
      }
      if (event.block.type === "thinking" || event.block.type === "text") {
        const deltaText = stream.deltas.map((delta) => {
          if (delta.delta.type !== event.block.type || delta.delta.type === "tool_call") {
            corrupted(sessionId, `BlockEnd 与 Delta 类型不一致：${key}`)
          }
          return delta.delta.text
        }).join("")
        if (stream.deltas.length > 0 && deltaText !== event.block.text) {
          corrupted(sessionId, `BlockEnd 文本与 Delta 不一致：${key}`)
        }
      } else {
        const toolCallIds = new Set(stream.deltas.map((delta) => {
          if (delta.delta.type !== "tool_call") corrupted(sessionId, `tool_call Delta 类型不一致：${key}`)
          return delta.delta.toolCallId
        }))
        if (toolCallIds.size > 1 || (toolCallIds.size === 1 && !toolCallIds.has(event.block.toolCallId))) {
          corrupted(sessionId, `tool_call BlockEnd 与 Delta 身份不一致：${key}`)
        }
      }
      stream.end = event
    }
  }

  return streams
}

function validateSummaries(sessionId: string, events: readonly SessionEvent[]): void {
  const starts = new Map<string, Extract<SessionEvent, { type: "summary/start" }>>()
  const ends = new Set<string>()
  for (const event of events) {
    if (event.type === "summary/start") {
      if (starts.has(event.summaryId)) corrupted(sessionId, `summary/start 重复：${event.summaryId}`)
      if (event.throughEventSeq >= event.seq) {
        corrupted(sessionId, `summary/start 的 throughEventSeq 未早于自身：${event.summaryId}`)
      }
      starts.set(event.summaryId, event)
    }
    if (event.type === "summary/end") {
      const start = starts.get(event.summaryId)
      if (start === undefined) corrupted(sessionId, `summary/end 缺少 start：${event.summaryId}`)
      if (ends.has(event.summaryId)) corrupted(sessionId, `summary/end 重复：${event.summaryId}`)
      if (event.turn !== start.turn || event.throughEventSeq !== start.throughEventSeq) {
        corrupted(sessionId, `summary/end 与 start 不匹配：${event.summaryId}`)
      }
      ends.add(event.summaryId)
    }
  }
}

async function repairBlockEnds(
  sessionId: string,
  events: SessionEvent[],
  append: AppendRecoveryEvent,
): Promise<void> {
  const streams = validateBlockStreams(sessionId, events)
  for (const stream of streams.values()) {
    if (stream.end !== undefined || stream.start.blockType === "tool_call") continue

    const text = stream.deltas.map((event) => {
      if (event.delta.type !== stream.start.blockType || event.delta.type === "tool_call") {
        corrupted(sessionId, `文本 Block 的 Delta 类型不一致：${stream.start.blockId}`)
      }
      return event.delta.text
    }).join("")

    await append({
      type: "assistant/block_end",
      turn: stream.start.turn,
      step: stream.start.step,
      blockId: stream.start.blockId,
      index: stream.start.index,
      block: { type: stream.start.blockType, text },
    })
  }
}

async function repairAssistantMessages(
  sessionId: string,
  events: SessionEvent[],
  append: AppendRecoveryEvent,
): Promise<void> {
  const turnModels = new Map<number, ModelRef>()
  const messages = new Map<string, AssistantMessageEvent>()
  const blockEnds = new Map<string, AssistantBlockEndEvent[]>()

  for (const event of events) {
    if (event.type === "turn/start") turnModels.set(event.turn, event.model)
    if (event.type === "assistant/message") {
      const key = stepKey(event.turn, event.step)
      if (messages.has(key)) corrupted(sessionId, `assistant/message 重复：${key}`)
      messages.set(key, event)
    }
    if (event.type === "assistant/block_end") {
      const key = stepKey(event.turn, event.step)
      const group = blockEnds.get(key) ?? []
      group.push(event)
      blockEnds.set(key, group)
    }
  }

  for (const [key, ends] of blockEnds) {
    const indexes = new Set<number>()
    for (const end of ends) {
      if (indexes.has(end.index)) corrupted(sessionId, `同一 Step 的 Block index 重复：${key}:${end.index}`)
      indexes.add(end.index)
    }
    const existing = messages.get(key)
    const expectedContent = [...ends].sort((left, right) => left.index - right.index).map((end) => end.block)
    if (existing !== undefined) {
      const turnModel = turnModels.get(existing.turn)
      if (turnModel === undefined || !isDeepStrictEqual(existing.model, turnModel)) {
        corrupted(sessionId, `assistant/message.model 与 turn/start.model 不一致：${key}`)
      }
      if (!isDeepStrictEqual(existing.message.content, expectedContent)) {
        corrupted(sessionId, `assistant/message.content 与 BlockEnd 不一致：${key}`)
      }
      continue
    }

    const [first] = ends
    const model = turnModels.get(first.turn)
    if (model === undefined) corrupted(sessionId, `恢复 assistant/message 时缺少 turn/start.model：${key}`)
    await append({
      type: "assistant/message",
      turn: first.turn,
      step: first.step,
      message: {
        id: randomUUID(),
        role: "assistant",
        content: expectedContent,
      },
      model,
    })
  }

  for (const [key, message] of messages) {
    if (blockEnds.has(key)) continue
    const turnModel = turnModels.get(message.turn)
    if (turnModel === undefined || !isDeepStrictEqual(message.model, turnModel)) {
      corrupted(sessionId, `assistant/message.model 与 turn/start.model 不一致：${key}`)
    }
    if (message.message.content.length > 0) {
      corrupted(sessionId, `assistant/message 有内容但没有可用 BlockEnd：${key}`)
    }
  }
}

async function repairApprovalsAndToolResults(
  sessionId: string,
  events: SessionEvent[],
  append: AppendRecoveryEvent,
): Promise<void> {
  const calls = collectAuthoritativeToolCalls(sessionId, events)
  const callsByEventId = new Map(calls.map((call) => [call.end.eventId, call]))
  const requestsByCall = new Map<string, ApprovalRequestEvent>()
  const requestsByApproval = new Map<string, ApprovalRequestEvent>()
  const decisions = new Map<string, ApprovalResultEvent>()
  const toolResults = new Map<string, ToolResultEvent>()

  for (const event of events) {
    if (event.type === "approval/request") {
      const call = callsByEventId.get(event.toolCallEventId)
      if (call === undefined) corrupted(sessionId, `approval/request 引用了非权威 tool_call：${event.approvalId}`)
      if (
        event.turn !== call.end.turn ||
        event.step !== call.end.step ||
        event.toolCallId !== call.end.block.toolCallId ||
        event.blockId !== call.end.blockId ||
        event.toolName !== call.end.block.name
      ) {
        corrupted(sessionId, `approval/request 与 tool_call 不匹配：${event.approvalId}`)
      }
      if (requestsByCall.has(event.toolCallEventId) || requestsByApproval.has(event.approvalId)) {
        corrupted(sessionId, `approval/request 重复：${event.approvalId}`)
      }
      requestsByCall.set(event.toolCallEventId, event)
      requestsByApproval.set(event.approvalId, event)
    }

    if (event.type === "approval/result") {
      const request = requestsByApproval.get(event.approvalId)
      if (request === undefined) corrupted(sessionId, `approval/result 缺少 request：${event.approvalId}`)
      if (event.turn !== request.turn || event.step !== request.step) {
        corrupted(sessionId, `approval/result 与 request 身份不匹配：${event.approvalId}`)
      }
      if (decisions.has(event.approvalId)) corrupted(sessionId, `approval/result 重复：${event.approvalId}`)
      decisions.set(event.approvalId, event)
    }

    if (event.type === "tool/result") {
      const call = callsByEventId.get(event.toolCallEventId)
      if (call === undefined) corrupted(sessionId, `tool/result 引用了非权威 tool_call：${event.toolCallId}`)
      if (
        event.turn !== call.end.turn ||
        event.step !== call.end.step ||
        event.toolCallId !== call.end.block.toolCallId ||
        event.blockId !== call.end.blockId
      ) {
        corrupted(sessionId, `tool/result 与 tool_call 不匹配：${event.toolCallId}`)
      }
      if (toolResults.has(event.toolCallEventId)) corrupted(sessionId, `tool/result 重复：${event.toolCallId}`)
      toolResults.set(event.toolCallEventId, event)
    }
  }

  for (const request of requestsByApproval.values()) {
    if (decisions.has(request.approvalId)) continue
    const written = await append({
      type: "approval/result",
      turn: request.turn,
      step: request.step,
      approvalId: request.approvalId,
      decision: "cancelled",
    })
    if (written.type !== "approval/result") corrupted(sessionId, "补写 approval/result 返回了错误事件类型")
    decisions.set(request.approvalId, written)
  }

  for (const call of calls) {
    if (toolResults.has(call.end.eventId)) continue
    const request = requestsByCall.get(call.end.eventId)
    const decision = request === undefined ? undefined : decisions.get(request.approvalId)?.decision
    const code = recoveryToolErrorCode(decision)
    const written = await append({
      type: "tool/result",
      turn: call.end.turn,
      step: call.end.step,
      toolCallEventId: call.end.eventId,
      toolCallId: call.end.block.toolCallId,
      blockId: call.end.blockId,
      result: recoveryToolResult(code),
    })
    if (written.type !== "tool/result") corrupted(sessionId, "补写 tool/result 返回了错误事件类型")
    toolResults.set(call.end.eventId, written)
  }
}

function collectAuthoritativeToolCalls(
  sessionId: string,
  events: readonly SessionEvent[],
): AuthoritativeToolCall[] {
  const blockEnds = events.filter(
    (event): event is AuthoritativeToolCall["end"] =>
      event.type === "assistant/block_end" && event.block.type === "tool_call",
  )
  const calls: AuthoritativeToolCall[] = []
  const seenEventIds = new Set<string>()

  for (const message of events) {
    if (message.type !== "assistant/message") continue
    for (const block of message.message.content) {
      if (block.type !== "tool_call") continue
      const matching = blockEnds.filter(
        (end) => end.turn === message.turn &&
          end.step === message.step &&
          end.block.toolCallId === block.toolCallId,
      )
      if (matching.length !== 1) {
        corrupted(sessionId, `权威 assistant/message 的 tool_call 无唯一 BlockEnd：${block.toolCallId}`)
      }
      const end = matching[0]
      if (end.block.name !== block.name || !isDeepStrictEqual(end.block.arguments, block.arguments)) {
        corrupted(sessionId, `assistant/message 与 tool_call BlockEnd 内容不一致：${block.toolCallId}`)
      }
      if (seenEventIds.has(end.eventId)) {
        corrupted(sessionId, `权威 tool_call 重复：${block.toolCallId}`)
      }
      seenEventIds.add(end.eventId)
      calls.push({ message, end })
    }
  }

  return calls
}

function recoveryToolErrorCode(
  decision: ApprovalResultEvent["decision"] | undefined,
): RecoveryToolErrorCode {
  if (decision === "denied") return APPROVAL_DENIED
  if (decision === "cancelled") return CANCELLED
  return EXECUTION_STATE_UNKNOWN
}

function recoveryToolResult(code: RecoveryToolErrorCode): ToolResult {
  const message = code === CANCELLED
    ? "工具调用已在 Session 恢复期间取消"
    : code === APPROVAL_DENIED
      ? "工具调用未获批准"
      : "工具调用的执行状态未知，未自动重试"
  return {
    status: "error",
    content: [{ type: "text", text: `${code}: ${message}` }],
    error: { source: "tool", code, message },
  }
}

function requireTurn(sessionId: string, event: Record<string, unknown>, index: number): void {
  if (!isPositiveInteger(event.turn)) corrupted(sessionId, `第 ${index + 1} 条事件的 turn 无效`)
}

function requireTurnAndStep(sessionId: string, event: Record<string, unknown>, index: number): void {
  requireTurn(sessionId, event, index)
  if (!isPositiveInteger(event.step)) corrupted(sessionId, `第 ${index + 1} 条事件的 step 无效`)
}

function requireStringField(
  sessionId: string,
  event: Record<string, unknown>,
  field: string,
  index: number,
): void {
  if (!isNonEmptyString(event[field])) corrupted(sessionId, `第 ${index + 1} 条事件缺少 ${field}`)
}

function requireEndReason(sessionId: string, reason: unknown, index: number): void {
  if (reason !== "completed" && reason !== "stopped" && reason !== "error") {
    corrupted(sessionId, `第 ${index + 1} 条事件的结束原因无效`)
  }
}

function requireModel(sessionId: string, model: unknown, index: number): void {
  if (!isRecord(model)) corrupted(sessionId, `第 ${index + 1} 条事件缺少 model`)
  if (!isNonEmptyString(model.providerId) || !isNonEmptyString(model.modelId)) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 model 无效`)
  }
  if (model.protocol !== "anthropic_messages" && model.protocol !== "chat_completions" && model.protocol !== "responses") {
    corrupted(sessionId, `第 ${index + 1} 条事件的 model.protocol 无效`)
  }
}

function requireUserMessage(sessionId: string, message: unknown, index: number): void {
  if (!isRecord(message) || !isNonEmptyString(message.id) || message.role !== "user") {
    corrupted(sessionId, `第 ${index + 1} 条事件的 user message 无效`)
  }
  if (!Array.isArray(message.content) || !message.content.every(isTextBlock)) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 user content 无效`)
  }
}

function requireAssistantMessage(sessionId: string, message: unknown, index: number): void {
  if (!isRecord(message) || !isNonEmptyString(message.id) || message.role !== "assistant") {
    corrupted(sessionId, `第 ${index + 1} 条事件的 assistant message 无效`)
  }
  if (!Array.isArray(message.content)) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 assistant content 无效`)
  }
  for (const block of message.content) requireAssistantBlock(sessionId, block, index)
}

function requireAssistantBlock(sessionId: string, block: unknown, index: number): void {
  if (!isRecord(block)) corrupted(sessionId, `第 ${index + 1} 条事件的 Assistant Block 无效`)
  if (block.type === "thinking" || block.type === "text") {
    if (typeof block.text !== "string") corrupted(sessionId, `第 ${index + 1} 条事件的文本 Block 无效`)
    return
  }
  if (block.type === "tool_call") {
    if (!isNonEmptyString(block.toolCallId) || !isNonEmptyString(block.name) || !("arguments" in block)) {
      corrupted(sessionId, `第 ${index + 1} 条事件的 tool_call Block 无效`)
    }
    return
  }
  corrupted(sessionId, `第 ${index + 1} 条事件的 Assistant Block 类型无效`)
}

function requireBlockDelta(sessionId: string, delta: unknown, index: number): void {
  if (!isRecord(delta)) corrupted(sessionId, `第 ${index + 1} 条事件的 Block Delta 无效`)
  if (delta.type === "thinking" || delta.type === "text") {
    if (typeof delta.text !== "string") corrupted(sessionId, `第 ${index + 1} 条事件的文本 Delta 无效`)
    return
  }
  if (delta.type === "tool_call") {
    if (!isNonEmptyString(delta.toolCallId)) corrupted(sessionId, `第 ${index + 1} 条事件的 tool_call Delta 无效`)
    if (delta.nameDelta !== undefined && typeof delta.nameDelta !== "string") {
      corrupted(sessionId, `第 ${index + 1} 条事件的 nameDelta 无效`)
    }
    if (delta.argumentsDelta !== undefined && typeof delta.argumentsDelta !== "string") {
      corrupted(sessionId, `第 ${index + 1} 条事件的 argumentsDelta 无效`)
    }
    return
  }
  corrupted(sessionId, `第 ${index + 1} 条事件的 Block Delta 类型无效`)
}

function requireToolResult(sessionId: string, result: unknown, index: number): void {
  if (!isRecord(result) || (result.status !== "success" && result.status !== "error")) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 ToolResult 无效`)
  }
  if (!Array.isArray(result.content)) corrupted(sessionId, `第 ${index + 1} 条事件的 ToolResult.content 无效`)
  if (result.status === "error" && !isRecord(result.error)) {
    corrupted(sessionId, `第 ${index + 1} 条错误 ToolResult 缺少 error`)
  }
}

function requireUsage(sessionId: string, usage: unknown, index: number): void {
  if (!isRecord(usage) || !isNonNegativeNumber(usage.inputTokens) || !isNonNegativeNumber(usage.outputTokens)) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 Usage 无效`)
  }
  for (const field of ["totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    if (usage[field] !== undefined && !isNonNegativeNumber(usage[field])) {
      corrupted(sessionId, `第 ${index + 1} 条事件的 Usage.${field} 无效`)
    }
  }
}

function isStepScopedEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { step: number }> {
  return event.type === "step/start" ||
    event.type === "step/end" ||
    event.type === "assistant/block_start" ||
    event.type === "assistant/block_delta" ||
    event.type === "assistant/block_end" ||
    event.type === "assistant/message" ||
    event.type === "tool/result" ||
    event.type === "approval/request" ||
    event.type === "approval/result"
}

function blockKey(turn: number, step: number, blockId: string): string {
  return `${turn}:${step}:${blockId}`
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isAppErrorSource(value: unknown): boolean {
  return value === "runtime" ||
    value === "model" ||
    value === "tool" ||
    value === "mcp" ||
    value === "storage" ||
    value === "system"
}

function isTextBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "text" && typeof value.text === "string"
}

function corrupted(sessionId: string, detail: string): never {
  throw new SessionLogCorruptedError(sessionId, detail)
}
