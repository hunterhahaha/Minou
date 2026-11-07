/**
 * Session 已提交事件与待写入事件的数据契约。
 *
 * 日志层分配 eventId、sessionId、seq 和 createdAt；Turn 与 Step 由运行层决定。
 * 事件覆盖生命周期、模型块与完整消息、工具结果、审批、上下文增量、摘要和文件变化。
 * 调用方通过追加结果引用已提交事件的身份，不自行推算日志序号。
 */

import type {
  AssistantBlockDelta,
  AssistantContentBlock,
  BlockType,
  ModelRef,
  ModelTextBlock,
  UnifiedToolDefinition,
  Usage,
} from "../../model/src/types.ts"
import type { SessionLoadedMCPTool } from "../../mcp/src/types.ts"
import type { AppError } from "../../error/src/types.ts"
import type { ToolResult } from "../../tools/src/types.ts"
import type { CurrentSessionBaseline } from "./session-state.ts"

/** 事件基类。 */
export interface EventBase {
  /** 日志分配的事件唯一身份。 */
  eventId: string
  /** 事件或记录所属的 Session 身份。 */
  sessionId: string
  /** 日志为当前 Session 分配的事件序号。 */
  seq: number
  /** 事件创建时间字符串。 */
  createdAt: string

  /** 运行层分配的 Turn 编号。 */
  turn?: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step?: number
}

/**
 * 由 SessionEventLog 分配的身份字段。
 *
 * 与 `EventBase` 的 `turn` / `step` 区分开：Turn 与 Step 由调用方（SessionRuntime / AgentLoop）
 * 决定，不是日志分配的。
 */
type EventIdentity = "eventId" | "sessionId" | "seq" | "createdAt"

/** V1 入口用户输入：模型用于确定 turn/start.model，不写入 user/message。 */
export interface UserMessageInput {
  /** 当前消息或上下文记录的内容。 */
  content: ModelTextBlock[]
  /** 本次输入选定的完整模型引用。 */
  model: ModelRef
}

/** 新 Turn 的固定模型。 */
export interface TurnStartEvent extends EventBase {
  type: "turn/start"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** 本次输入选定的完整模型引用。 */
  model: ModelRef
}

/** 用户实际发送的消息。 */
export interface UserMessageEvent extends EventBase {
  type: "user/message"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  message: {
    id: string
    role: "user"
    content: ModelTextBlock[]
  }
}

/** Turn / Step 的终态原因。 */
export type StepEndReason = "completed" | "stopped" | "error"

/** Turn 结束；异常恢复只会补写 `reason = "error"`。 */
export interface TurnEndEvent extends EventBase {
  type: "turn/end"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  reason: StepEndReason
}

/** Step 开始。 */
export interface StepStartEvent extends EventBase {
  type: "step/start"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step: number
}

/** Step 结束。 */
export interface StepEndEvent extends EventBase {
  type: "step/end"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step: number
  reason: StepEndReason
}

/** 模型流：块开始。 */
export interface AssistantBlockStartEvent extends EventBase {
  type: "assistant/block_start"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step: number
  blockId: string
  index: number
  blockType: BlockType
}

/** 模型流：块增量。 */
export interface AssistantBlockDeltaEvent extends EventBase {
  type: "assistant/block_delta"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step: number
  blockId: string
  delta: AssistantBlockDelta
}

/** 模型流：块结束。 */
export interface AssistantBlockEndEvent extends EventBase {
  type: "assistant/block_end"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step: number
  blockId: string
  index: number
  block: AssistantContentBlock
}

/** 本 Step 的权威 Assistant Message。 */
export interface AssistantMessageEvent extends EventBase {
  type: "assistant/message"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step: number
  message: {
    id: string
    role: "assistant"
    content: AssistantContentBlock[]
  }
  /** 本次输入选定的完整模型引用。 */
  model: ModelRef
  /** 从已提交正常 Assistant 消息派生的 Session Usage。 */
  usage?: Usage
  finishReason?: string
}

/** 工具结果。`toolCallEventId` 指向对应工具调用块的 `assistant/block_end.eventId`。 */
export interface ToolResultEvent extends EventBase {
  type: "tool/result"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step: number
  toolCallEventId: string
  toolCallId: string
  blockId: string
  result: ToolResult
}

/** 工具执行前的审批请求。 */
export interface ApprovalRequestEvent extends EventBase {
  type: "approval/request"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
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

/** 审批结果；恢复未完成审批时补写 `cancelled`。 */
export interface ApprovalResultEvent extends EventBase {
  type: "approval/result"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** Turn 内由运行层分配的 Step 编号。 */
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

/** 已有 Session 在 Turn 开始前提交的固定上下文增量。 */
export interface ContextUpdateEvent extends EventBase {
  type: "context_update"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  source:
    | { type: "agents_md"; path: string; hash: string; fullContent: string }
    | { type: "skill"; changes: SkillContextChange[] }
  /** 当前消息或上下文记录的内容。 */
  content: string
}

/** 不属于 ToolResult 的独立 Runtime 错误。 */
export interface AppErrorEvent extends EventBase {
  type: "app/error"
  /** 运行层分配的 Turn 编号。 */
  turn?: number
  /** Turn 内由运行层分配的 Step 编号。 */
  step?: number
  error: AppError
  sourceEventId?: string
}

/** 一次工具载入提交的新增记录，定义是当时对模型公开的快照。 */
export interface McpToolsAddedEvent extends EventBase {
  type: "mcp/tools_added"
  turn: number
  step: number
  toolCallEventId: string
  tools: { entry: SessionLoadedMCPTool; definition: UnifiedToolDefinition }[]
}

/** 同一次工具载入实际移出已载入集合的名称。 */
export interface McpToolsRemovedEvent extends EventBase {
  type: "mcp/tools_removed"
  turn: number
  step: number
  toolCallEventId: string
  toolNames: string[]
}

/** 载入操作的有序批次，移除先于新增。 */
export type McpToolChangeInput = Omit<McpToolsAddedEvent, EventIdentity> | Omit<McpToolsRemovedEvent, EventIdentity>

/** 压缩尝试开始；不改变上下文，只有同一 summaryId 的 end 成功提交才生效。 */
export interface SummaryStartEvent extends EventBase {
  type: "summary/start"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** 本次压缩尝试的配对身份。 */
  summaryId: string
  /** 累计覆盖起点；再次压缩继承最近已提交 Summary 的起点。 */
  fromEventSeq: number
  /** 写入 start 前捕获的输入历史截止事件。 */
  throughEventSeq: number
}

/** 已完成的完整压缩结果；end 是正文与固定基线的唯一提交点。 */
export interface SummaryEndEvent extends EventBase {
  type: "summary/end"
  /** 运行层分配的 Turn 编号。 */
  turn: number
  /** 与对应 start 一致的压缩尝试身份。 */
  summaryId: string
  /** 压缩正文，回放时作为一条 user 消息。 */
  summary: string
  /** 累计覆盖起点；再次压缩继承旧 Summary 的起点。 */
  fromEventSeq: number
  /** 输入历史的截止事件；回放遮蔽此序号及以前的所有事件。 */
  throughEventSeq: number
  /** 压缩本身的 Usage，不进入正常 Agent Usage。 */
  usage?: Usage
  /** 最新 AGENTS.md / Skills 完整基线及 MCP 工具定义。 */
  baseline: Pick<CurrentSessionBaseline, "agentsmd" | "skills" | "mcp">
}

export interface FileDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface FileChange {
  /** 文件或来源的路径。 */
  path: string
  changeType: "created" | "modified" | "deleted"
  hunks: FileDiffHunk[]
  stats: { additions: number; deletions: number }
  /** 最近设置的文件变化说明。 */
  description?: string
}

/** Turn 结束前提交的最终文件变化。 */
export interface TurnFileChangesEvent extends EventBase {
  type: "turn/file_changes"
  /** 运行层分配的 Turn 编号。 */
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
/** 待写入的压缩开始事件；持久化身份与序号由 Event Log 分配。 */
export type SummaryStartEventInput = Omit<SummaryStartEvent, EventIdentity>
/** 待写入的压缩提交事件；包含正文、覆盖区间和完整基线。 */
export type SummaryEndEventInput = Omit<SummaryEndEvent, EventIdentity>
export type TurnFileChangesEventInput = Omit<TurnFileChangesEvent, EventIdentity>

/** 所有受支持的已提交 Session 事件联合。 */
export type SessionEvent =
  | McpToolsAddedEvent | McpToolsRemovedEvent
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

/** 上层交给 SessionEventLog 的事件：内容齐备，只缺日志分配的身份字段。 */
export type SessionEventInput =
  | McpToolChangeInput
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
 * 追加单条 Session 事件的异步出口。
 *
 * 返回已提交事件，供后续工具结果等记录引用真实 eventId；seq 由日志层分配。
 * @param event 尚未分配日志身份的完整事件输入。
 * @returns 已持久化并包含日志身份的事件。
 * @throws Error 校验或持久化失败时拒绝，调用方应停止依赖该事件的后续写入。
 */
export type AppendSessionEvent = (event: SessionEventInput) => Promise<SessionEvent>
