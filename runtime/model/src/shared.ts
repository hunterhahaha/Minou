/**
 * 三种 Adapter 共用的请求校验、推理字段拼装、文本与工具参数转换，以及流式重试入口。
 *
 * 请求校验失败使用 Runtime 来源的 AppError；流执行失败由共享入口归一化。
 * 首个内容增量标记有效输出，重试与取消处理委托网络层。
 */

import { createAbortError } from "../../error/src/abort.ts"
import { normalizeModelError } from "../../error/src/normalizer.ts"
import type { AppError } from "../../error/src/types.ts"
import { streamWithRetry } from "../../network/src/retry.ts"
import { isReasoningLevels, renderReasoningField } from "./reasoning.ts"
import type {
  ModelConfig,
  ModelHistory,
  ModelHistoryEvent,
  ModelMessage,
  UnifiedToolDefinition,
  ModelStreamEvent,
  ModelTextBlock,
  Protocol,
  UnifiedModelRequest,
} from "./types.ts"


/** 请求校验 */


/**
 * 请求本身不合法（统一格式的约定没有被满足）。
 *
 * 属于 Runtime 侧的错误而不是模型侧错误，因此 `source = "runtime"`：
 * 它不是 Provider 拒绝请求，而是 AgentLoop / ContextBuilder 给出的输入违反了统一格式契约。
 */
export const INVALID_MODEL_REQUEST = "INVALID_MODEL_REQUEST"

/**
 * 创建统一的 Runtime 请求错误，不执行抛出动作。
 *
 * @param message 面向上层错误处理和日志的可读说明。
 * @param details 可选的结构化诊断信息；不改变错误的来源和错误码。
 * @returns `source` 为 `runtime` 且错误码为 `INVALID_MODEL_REQUEST` 的 AppError。
 */
export function invalidRequest(message: string, details?: Record<string, unknown>): AppError {
  return { source: "runtime", code: INVALID_MODEL_REQUEST, message, details }
}

/**
 * 校验请求的模型引用与 Adapter 绑定的 ModelConfig 一致。
 *
 * Adapter 实例绑定一个具体模型（凭据按 providerId 提供，`max_tokens` 等按模型提供），
 * 所以 `request.model` 与实例不符时不能"用这个实例去请求那个模型"，必须直接失败。
 *
 * @param request 待发送的统一模型请求。
 * @param config 当前 Adapter 绑定的模型配置。
 * @throws `AppError` 当 Provider、协议或模型 ID 任一不匹配时抛出。
 */
export function assertRequestMatchesModel(request: UnifiedModelRequest, config: ModelConfig): void {
  const { providerId, protocol, modelId, name, reasoningLevel } = request.model
  if (providerId === config.providerId && protocol === config.protocol && modelId === config.modelId && name === config.name) {
    if (config.supportsReasoning && (!isReasoningLevels(config.reasoningLevels) || !config.reasoningLevels.includes(reasoningLevel))) {
      throw invalidRequest("当前推理等级不在模型支持的等级列表中", { reasoningLevel, modelId })
    }
    return
  }

  throw invalidRequest("请求的模型引用与当前 Protocol Adapter 绑定的模型不一致", {
    request: { providerId, protocol, modelId, name },
    adapter: { providerId: config.providerId, protocol: config.protocol, modelId: config.modelId, name: config.name },
  })
}

/**
 * 将模型配置中的字段路径与当前 Turn 的等级组合成请求片段。
 * @param request 当前模型请求，其选择已从 Session Meta 固定到 Turn。
 * @param config Adapter 绑定的完整模型配置。
 * @returns 支持思考时返回推理字段对象，否则返回空对象。
 * @throws AppError 支持思考且等级或字段路径无效时拒绝发送请求。
 */
export function reasoningRequestFragment(request: UnifiedModelRequest, config: ModelConfig): Record<string, unknown> {
  if (!config.supportsReasoning) return {}
  if (!isReasoningLevels(config.reasoningLevels) || !config.reasoningLevels.includes(request.model.reasoningLevel)) {
    throw invalidRequest("当前推理等级不在模型支持的等级列表中", {
      reasoningLevel: request.model.reasoningLevel, modelId: request.model.modelId,
    })
  }
  try {
    return renderReasoningField(config.reasoningField, request.model.reasoningLevel, config.protocol)
  } catch {
    throw invalidRequest("模型的推理等级请求字段无效", { modelId: request.model.modelId })
  }
}

/** 拆分后的统一上下文：`system` 对应协议的系统位置，`rest` 是其余消息。 */
export interface SplitModelContext {
  /** 传给协议专用 system / instructions 位置的系统文本。 */
  system: string
  /** 除首个 System Message 外的会话消息。 */
  rest: ModelMessage[]
  tools: UnifiedToolDefinition[]
}

/**
 * 拆分 System Message。
 *
 * `messages[0]` 必须是唯一的 System Message，它对应 Anthropic `system`、
 * Chat Completions `developer/system`、Responses `instructions`；`messages[1...]` 才是会话上下文。
 *
 * 出现第二个 System Message 直接失败：三个协议都没有"中途插入系统指令"的等价位置，
 * 静默丢弃会让发出去的上下文与 Runtime 内存中的 content 不一致。
 *
 * @param request 待拆分的统一模型请求。
 * @returns 系统文本与其余会话消息，且不修改请求。
 * @throws `AppError` 当首条不是 System Message 或后续仍出现 System Message 时抛出。
 */
export function splitSystemMessage(request: UnifiedModelRequest): SplitModelContext {
  if (request.context.history !== undefined) {
    const { system, mcpBaseline, events } = request.context.history
    return { system, rest: historyMessages(events), tools: foldHistoryTools([...request.tools, ...mcpBaseline], events) }
  }
  const messages = request.context.messages
  const first = messages[0]

  if (first === undefined || first.role !== "system") {
    throw invalidRequest("统一上下文的 messages[0] 必须是 System Message")
  }

  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "system") {
      throw invalidRequest(`统一上下文只允许一个 System Message，messages[${index}] 也是 system`)
    }
  }

  return { system: first.content, rest: messages.slice(1), tools: request.tools }
}


/** 应用一条已提交的工具增量，保留定义首次加入时的顺序。 */
export function applyHistoryToolChange(tools: Map<string, UnifiedToolDefinition>, event: ModelHistoryEvent): void {
  if (event.type === "mcp/tools_added") {
    for (const definition of event.definitions) tools.set(definition.name, definition)
  } else if (event.type === "mcp/tools_removed") {
    for (const name of event.toolNames) tools.delete(name)
  }
}

/** 从基线折叠工具定义，用于通用请求及摘要快照。 */
export function foldHistoryTools(baseline: UnifiedToolDefinition[], events: ModelHistory["events"]): UnifiedToolDefinition[] {
  const tools = new Map(baseline.map((tool) => [tool.name, tool]))
  for (const event of events) applyHistoryToolChange(tools, event)
  return [...tools.values()]
}

/** 将一条模型相关事件投影成通用消息，工具增量另由工具转换消费。 */
export function historyMessage(event: ModelHistoryEvent): ModelMessage | undefined {
  switch (event.type) {
    case "summary/end": return { role: "user", content: event.summary }
    case "context_update":
    case "user/message": return { role: "user", content: event.content }
    case "assistant/message": return { role: "assistant", content: event.content }
    case "tool/result": return { role: "tool", toolCallId: event.toolCallId, content: event.content, isError: event.isError }
    default: return undefined
  }
}

/** 通用历史投影，保持消息与工具结果的提交顺序。 */
export function historyMessages(events: ModelHistoryEvent[]): ModelMessage[] {
  return events.flatMap((event) => historyMessage(event) ?? [])
}

/** 文本与工具调用参数 */


/**
 * 按顺序拼接文本块，不添加分隔符。
 *
 * 工具结果只消费 `type="text"`；Chat Completions 与 Responses 的字符串
 * 字段由这里拼接后填入，Anthropic 则保留文本块数组。
 * 用户消息也是同样的规则：统一 user content 允许字符串或文本块数组，三个协议都只转换文本。
 *
 * @param blocks 按协议顺序排列的文本块。
 * @returns 不带分隔符的拼接文本。
 */
export function joinTextBlocks(blocks: ModelTextBlock[]): string {
  let text = ""
  for (const block of blocks) text += block.text
  return text
}

/**
 * 把统一 tool_call 的 `arguments` 序列化为协议侧的 JSON 字符串。
 *
 * Chat Completions 与 Responses 的 function arguments 都是字符串。统一格式里
 * `arguments` 是 `unknown`（正常是解析后的对象，见 `parseToolCallArguments`）。
 * 已是字符串时原样传出，不重复编码。
 *
 * @param value 统一 tool_call 的参数值。
 * @returns 协议要求的 JSON 字符串；空值或不可序列化值退化为 `{}`。
 */
export function serializeToolCallArguments(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return "{}"

  try {
    const text = JSON.stringify(value)
    return text === undefined ? "{}" : text
  } catch {
    /** 循环引用等无法序列化的值：协议侧必须拿到字符串，退化为空参数对象。 */
    return "{}"
  }
}

/**
 * 解析协议侧累积出的 arguments JSON 字符串，作为统一 tool_call 块的 `arguments`。
 *
 * 返回解析后的对象；无法解析时**原样返回字符串**，不吞掉内容 —— 被 token 上限截断的
 * tool_call 是正常路径，保留原始文本便于上层判断与展示。
 *
 * @param raw 协议流中累积出的参数文本。
 * @returns 成功解析后的值；空文本返回空对象，解析失败返回原始字符串。
 */
export function parseToolCallArguments(raw: string): unknown {
  const text = raw.trim()
  if (text.length === 0) return {}

  try {
    return JSON.parse(text)
  } catch {
    return raw
  }
}

/**
 * 把统一 `arguments` 还原为 Anthropic `tool_use.input` 需要的对象。
 *
 * Anthropic 要求 `input` 是对象，因此无法解析的字符串只能退化为空对象；
 * 这只会发生在被截断的 tool_call 回放时，属已知退化（见 shared.ts 顶部说明）。
 *
 * @param value 统一 tool_call 的参数值。
 * @returns Anthropic `tool_use.input` 可接受的对象；无法解析时返回空对象。
 */
export function resolveToolCallInput(value: unknown): unknown {
  if (typeof value === "string") {
    const parsed = parseToolCallArguments(value)
    return typeof parsed === "string" ? {} : parsed
  }
  if (typeof value === "object" && value !== null) return value
  return {}
}

/**
 * 流中断错误：协议流在给出结束事件前就结束了。
 *
 * 各 Adapter 用它表示"没有拿到结束事件"，由 `runModelStream` 归一化为 `REQUEST_FAILED`。
 *
 * @param protocol 产生中断的协议名称。
 * @returns 描述协议流中断原因的 Error 实例。
 */
export function streamInterruptedError(protocol: Protocol): Error {
  return new Error(`${protocol} 协议流在结束事件前中断`)
}


/** 重试与错误归一化 */


/**
 * 判定一个值是否已经是统一错误结构。
 *
 * @param value 待检查的未知异常值。
 * @returns 同时包含字符串 `source`、`code` 和 `message` 字段时返回 `true`。
 */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.source === "string" &&
    typeof record.code === "string" &&
    typeof record.message === "string"
  )
}

/**
 * 流式重试边界：首个内容增量才算"有效模型输出"。
 *
 * 只有 `block_delta` 算有效输出。`block_start` 本身不含模型生成的内容，
 * 因此允许它先被缓冲、失败的尝试不会把它泄漏给消费方（见 `network/src/retry.ts`）。
 * `block_end` / `stream_end` 同样不含新内容增量，出现在它们之后仍可重试是安全的。
 *
 * @param event 待判断的统一流事件。
 * @returns 只有首个内容增量 `block_delta` 会被视为有效输出。
 */
function isFirstContentDelta(event: ModelStreamEvent): boolean {
  return event.type === "block_delta"
}

/**
 * 把一次「协议流 → 统一事件流」的尝试包装为带自动重试的流。
 *
 * 三个 Adapter 的差异只在 `attempt` 内部（请求构建与事件转换），重试边界、取消排除与
 * 错误归一化完全一致，所以共用这一个入口：
 *
 *   - 尚未产出有效输出 + 可重试错误 → 重新请求，消费方看不到失败尝试的痕迹；
 *   - 已产出有效输出 → 原样抛出，交给错误处理；
 *   - 取消类错误 / 调用方取消信号已触发 → 不重试，归一化为 `CANCELLED`；
 *   - 其余失败在重试耗尽后归一化为 `source = "model"` 的 AppError。
 *
 * 归一化放在这里而不是各 Adapter 里，保证"抛出的一定是 AppError"这一条对所有协议成立。
 *
 * 关于取消：实测三个官方 SDK 在请求中途被取消时**不一定抛错**，而是直接结束流
 * （例如 Anthropic 只吐出 message_start 就正常返回）。因此这里以调用方信号为准做兜底 ——
 * 信号的 `aborted` 就是"这次请求是被用户取消的"的权威依据，不管底层抛了什么。
 * 少了这条兜底，取消会被下层的"流被截断"错误盖成 REQUEST_FAILED，
 * 前端与 Event Log 就无法区分"用户停止"和"请求失败"。
 *
 * @param attempt 单次协议请求尝试；接收本次尝试专用的取消信号并返回统一事件流。
 * @param signal 调用方的取消信号。
 * @returns 自动重试后的统一模型事件异步生成器。
 * @throws `AppError` 请求失败、重试耗尽或取消时抛出；已归一化的错误会原样透传。
 */
export async function* runModelStream(
  attempt: (signal: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  try {
    yield* streamWithRetry(attempt, { signal, isValidOutput: isFirstContentDelta })
  } catch (error) {
    /** 已经是统一错误（例如请求校验失败）时原样抛出，避免被再次包装成 REQUEST_FAILED。 */
    if (isAppError(error)) throw error
    /** 调用方取消是权威信号：无论底层抛的是什么，都归一化为 CANCELLED。 */
    if (signal.aborted) throw normalizeModelError(createAbortError())
    throw normalizeModelError(error)
  }
}
