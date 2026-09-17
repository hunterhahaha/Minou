/**
 * Session Event 的结构与「待写入事件」契约（第 8 节）。
 *
 * 事件身份（`eventId` / `sessionId` / `seq` / `createdAt`）由 SessionEventLog 补齐，
 * 因此本文件除了完整事件结构，还给出 `SessionEventInput`（去掉身份字段）作为上层写事件的契约：
 * AgentLoop 只描述"发生了什么"，不自行分配 `seq`。
 *
 * 本阶段只定义 AgentLoop 会写出的那部分事件：Step 生命周期、模型流事件与最终 Assistant Message
 * （第 8.4、8.5、8.9 节）。其余事件（`user/message`、`tool/result`、`context_update`、
 * `summary/*`、`turn/*`、审批）在各自模块接入时再补，`SessionEvent` 联合类型也留到那时。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 8 节（Session Event Log）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 6.1（AgentLoop 的事件输出契约）
 */

import type {
  AssistantBlockDelta,
  AssistantContentBlock,
  BlockType,
  ModelRef,
  Usage,
} from "../../model/src/types.ts"

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

/** Turn / Step 的终态原因（第 8.9 节）。 */
export type StepEndReason = "completed" | "stopped" | "error"

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

export type StepStartEventInput = Omit<StepStartEvent, EventIdentity>
export type StepEndEventInput = Omit<StepEndEvent, EventIdentity>
export type AssistantBlockStartEventInput = Omit<AssistantBlockStartEvent, EventIdentity>
export type AssistantBlockDeltaEventInput = Omit<AssistantBlockDeltaEvent, EventIdentity>
export type AssistantBlockEndEventInput = Omit<AssistantBlockEndEvent, EventIdentity>
export type AssistantMessageEventInput = Omit<AssistantMessageEvent, EventIdentity>

/** 上层交给 SessionEventLog 的事件：内容齐备，只缺日志分配的身份字段（第 8.2 节）。 */
export type SessionEventInput =
  | StepStartEventInput
  | StepEndEventInput
  | AssistantBlockStartEventInput
  | AssistantBlockDeltaEventInput
  | AssistantBlockEndEventInput
  | AssistantMessageEventInput

/**
 * 事件出口，对应 SessionEventLog 的最小形态。
 *
 * 本阶段返回 void：AgentLoop 还不需要写入后的事件身份。等 Usage 记账需要
 * `lastUsageEventSeq`、`tool/result` 需要 `toolCallEventId` 时（TODOList 6.3 / 6.4），
 * 这个契约再改为返回已落盘的事件。
 */
export type AppendSessionEvent = (event: SessionEventInput) => Promise<void>
