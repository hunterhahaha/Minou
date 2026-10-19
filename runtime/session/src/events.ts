/**
 * Session Event 的结构与「待写入事件」契约（第 8 节）。
 *
 * 事件身份（`eventId` / `sessionId` / `seq` / `createdAt`）由 SessionEventLog 补齐，
 * 因此本文件除了完整事件结构，还给出 `SessionEventInput`（去掉身份字段）作为上层写事件的契约：
 * AgentLoop 只描述"发生了什么"，不自行分配 `seq`；需要引用已写事件时用 `appendEvent` 的返回值。
 *
 * 当前定义开发备忘录第 8 节的完整 Session Event 联合；尚未落地的生产方也先提供
 * 结构契约，使 Event Log 恢复可以读取并保留全部合法历史事件。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 8 节（Session Event Log）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 6.1（事件输出契约）、6.4（tool/result 关联）
 */

import type {
  AssistantBlockDelta,
  AssistantContentBlock,
  BlockType,
  ModelRef,
  ModelTextBlock,
  Usage,
} from "../../model/src/types.ts"
import type { AppError } from "../../error/src/types.ts"
import type { ToolResult } from "../../tools/src/types.ts"

/** 事件基类（第 8.2 节）。 */
export interface EventBase {
  eventId: string
  sessionId: string
  seq: number
  createdAt: string

  turn?: number
  step?: number
}

/**
 * 由 SessionEventLog 分配的身份字段（第 8.2 节）。
 *
 * 与 `EventBase` 的 `turn` / `step` 区分开：Turn 与 Step 由调用方（SessionRuntime / AgentLoop）
 * 决定，不是日志分配的。
 */
type EventIdentity = "eventId" | "sessionId" | "seq" | "createdAt"

/** V1 入口用户输入：模型用于确定 turn/start.model，不写入 user/message（第 8.3 节）。 */
export interface UserMessageInput {
  content: ModelTextBlock[]
  model: ModelRef
}

/** 新 Turn 的固定模型（第 8.9 节）。 */
export interface TurnStartEvent extends EventBase {
  type: "turn/start"
  turn: number
  model: ModelRef
}

/** 用户实际发送的消息（第 8.3 节）。 */
export interface UserMessageEvent extends EventBase {
  type: "user/message"
  turn: number
  message: {
    id: string
    role: "user"
    content: ModelTextBlock[]
  }
}

/** Turn / Step 的终态原因（第 8.9 节）。 */
export type StepEndReason = "completed" | "stopped" | "error"

/** Turn 结束；异常恢复只会补写 `reason = "error"`（第 8.9、10.2 节）。 */
export interface TurnEndEvent extends EventBase {
  type: "turn/end"
  turn: number
  reason: StepEndReason
}

/** Step 开始（第 8.9 节）。 */
export interface StepStartEvent extends EventBase {
  type: "step/start"
  turn: number
  step: number
}

/** Step 结束（第 8.9 节）。 */
export interface StepEndEvent extends EventBase {
  type: "step/end"
  turn: number
  step: number
  reason: StepEndReason
}

/** 模型流：块开始（第 8.4 节）。 */
export interface AssistantBlockStartEvent extends EventBase {
  type: "assistant/block_start"
  turn: number
  step: number
  blockId: string
  index: number
  blockType: BlockType
}

/** 模型流：块增量（第 8.4 节）。 */
export interface AssistantBlockDeltaEvent extends EventBase {
  type: "assistant/block_delta"
  turn: number
  step: number
  blockId: string
  delta: AssistantBlockDelta
}

/** 模型流：块结束（第 8.4 节）。 */
export interface AssistantBlockEndEvent extends EventBase {
  type: "assistant/block_end"
  turn: number
  step: number
  blockId: string
  index: number
  block: AssistantContentBlock
}

/** 本 Step 的权威 Assistant Message（第 8.5 节）。 */
export interface AssistantMessageEvent extends EventBase {
  type: "assistant/message"
  turn: number
  step: number
  message: {
    id: string
    role: "assistant"
    content: AssistantContentBlock[]
  }
  model: ModelRef
  usage?: Usage
  finishReason?: string
}

/** 工具结果（第 8.6 节）。`toolCallEventId` 指向对应工具调用块的 `assistant/block_end.eventId`。 */
export interface ToolResultEvent extends EventBase {
  type: "tool/result"
  turn: number
  step: number
  toolCallEventId: string
  toolCallId: string
  blockId: string
  result: ToolResult
}

/** 工具执行前的审批请求（第 8.12 节）。 */
export interface ApprovalRequestEvent extends EventBase {
  type: "approval/request"
  turn: number
  step: number
  approvalId: string
  toolCallEventId: string
  toolCallId: string
  blockId: string
  toolName: string
  arguments: unknown
  reason?: string
}

export type ApprovalDecision = "approved" | "denied" | "cancelled"

/** 审批结果；恢复未完成审批时补写 `cancelled`（第 8.12、10.4 节）。 */
export interface ApprovalResultEvent extends EventBase {
  type: "approval/result"
  turn: number
  step: number
  approvalId: string
  decision: ApprovalDecision
}

export type SkillScope = "global" | "project"

/**
 * 记录首次载入到对话中的一个 Skill 来源。
 *
 * 已有来源的启用状态变化保存在 Session Meta，不产生模型通知。
 */
export interface SkillContextChange {
  /**
   * 此事件只表示新增载入记录。
   */
  type: "new"
  /**
   * Skill 文件夹名；允许与其他来源的记录同名。
   */
  name: string
  /**
   * 当时载入的 Skill 文件夹绝对路径。
   */
  path: string
  /**
   * 当时载入的来源作用域。
   */
  scope: SkillScope
  /**
   * 当时实际注入模型的截断描述，用于历史回放和派生状态修复。
   */
  description: string
}

/** 已有 Session 在 Turn 开始前提交的固定上下文增量（第 8.10、11.5 节）。 */
export interface ContextUpdateEvent extends EventBase {
  type: "context_update"
  turn: number
  source:
    | { type: "agents_md"; path: string; hash: string; fullContent: string }
    | { type: "skill"; changes: SkillContextChange[] }
  content: string
}

/** 不属于 ToolResult 的独立 Runtime 错误（第 8.7 节）。 */
export interface AppErrorEvent extends EventBase {
  type: "app/error"
  turn?: number
  step?: number
  error: AppError
  sourceEventId?: string
}

/** 一次尚未提交的压缩尝试（第 8.8、10.5 节）。 */
export interface SummaryStartEvent extends EventBase {
  type: "summary/start"
  turn: number
  summaryId: string
  throughEventSeq: number
}

/** 已提交的压缩结果（第 8.8、10.5 节）。 */
export interface SummaryEndEvent extends EventBase {
  type: "summary/end"
  turn: number
  summaryId: string
  summary: string
  throughEventSeq: number
  usage?: Usage
}

export interface FileDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface FileChange {
  path: string
  changeType: "created" | "modified" | "deleted"
  hunks: FileDiffHunk[]
  stats: { additions: number; deletions: number }
  description?: string
}

/** Turn 结束前提交的最终文件变化（第 8.9、34.3 节）。 */
export interface TurnFileChangesEvent extends EventBase {
  type: "turn/file_changes"
  turn: number
  files: FileChange[]
}

export type TurnStartEventInput = Omit<TurnStartEvent, EventIdentity>
export type TurnEndEventInput = Omit<TurnEndEvent, EventIdentity>
export type UserMessageEventInput = Omit<UserMessageEvent, EventIdentity>
export type StepStartEventInput = Omit<StepStartEvent, EventIdentity>
export type StepEndEventInput = Omit<StepEndEvent, EventIdentity>
export type AssistantBlockStartEventInput = Omit<AssistantBlockStartEvent, EventIdentity>
export type AssistantBlockDeltaEventInput = Omit<AssistantBlockDeltaEvent, EventIdentity>
export type AssistantBlockEndEventInput = Omit<AssistantBlockEndEvent, EventIdentity>
export type AssistantMessageEventInput = Omit<AssistantMessageEvent, EventIdentity>
export type ToolResultEventInput = Omit<ToolResultEvent, EventIdentity>
export type ApprovalRequestEventInput = Omit<ApprovalRequestEvent, EventIdentity>
export type ApprovalResultEventInput = Omit<ApprovalResultEvent, EventIdentity>
export type ContextUpdateEventInput = Omit<ContextUpdateEvent, EventIdentity>
export type AppErrorEventInput = Omit<AppErrorEvent, EventIdentity>
export type SummaryStartEventInput = Omit<SummaryStartEvent, EventIdentity>
export type SummaryEndEventInput = Omit<SummaryEndEvent, EventIdentity>
export type TurnFileChangesEventInput = Omit<TurnFileChangesEvent, EventIdentity>

/** 开发备忘录第 8.11 节的完整 Session Event 联合。 */
export type SessionEvent =
  | TurnStartEvent
  | TurnEndEvent
  | UserMessageEvent
  | StepStartEvent
  | StepEndEvent
  | AssistantBlockStartEvent
  | AssistantBlockDeltaEvent
  | AssistantBlockEndEvent
  | AssistantMessageEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | ApprovalResultEvent
  | ContextUpdateEvent
  | AppErrorEvent
  | SummaryStartEvent
  | SummaryEndEvent
  | TurnFileChangesEvent

/** 上层交给 SessionEventLog 的事件：内容齐备，只缺日志分配的身份字段（第 8.2 节）。 */
export type SessionEventInput =
  | TurnStartEventInput
  | TurnEndEventInput
  | UserMessageEventInput
  | StepStartEventInput
  | StepEndEventInput
  | AssistantBlockStartEventInput
  | AssistantBlockDeltaEventInput
  | AssistantBlockEndEventInput
  | AssistantMessageEventInput
  | ToolResultEventInput
  | ApprovalRequestEventInput
  | ApprovalResultEventInput
  | ContextUpdateEventInput
  | AppErrorEventInput
  | SummaryStartEventInput
  | SummaryEndEventInput
  | TurnFileChangesEventInput

/**
 * 事件出口，对应 SessionEventLog 的最小形态。
 *
 * 返回**已落盘**的事件，因为后续事件需要引用它的身份：`tool/result.toolCallEventId`
 * 指向工具调用块的 `block_end.eventId`（第 8.6 节）；Usage 记账要记录 `lastUsageEventSeq`
 * （第 27.4 节，尚未实现）。`seq` 只能由 Event Log 分配，调用方不能自行推算。
 */
export type AppendSessionEvent = (event: SessionEventInput) => Promise<SessionEvent>
