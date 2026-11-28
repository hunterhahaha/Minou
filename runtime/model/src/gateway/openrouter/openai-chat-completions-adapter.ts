import type OpenAI from "openai"

import {
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "../../shared.ts"
import type { ModelCompletion, ModelConfig, ModelStreamEvent, ReplaySource, UnifiedModelRequest } from "../../types.ts"
import { convertChatCompletionsUsage } from "../../usage.ts"
import type { ChatCompletionsUsageFields } from "../../usage.ts"

/** OpenRouter 写入和读取回放时使用的固定来源。 */
const REPLAY_SOURCE = { name: "OpenRouter", protocol: "chat_completions" } satisfies ReplaySource

/** OpenRouter 原生思考详情，保留上游附带的字段。 */
type ReasoningDetail = Record<string, unknown>

/** 可直接放入 OpenRouter assistant 消息的原生推理字段。 */
interface ReasoningFields {
  /** 独立累积的 OpenRouter 明文推理。 */
  reasoning?: string
  /** 按首次出现的顺序保存的完整结构化详情。 */
  reasoning_details?: ReasoningDetail[]
}

/**
 * 从历史回放或流式增量中读取可用的原生思考字段。
 * @param value 解析后的回放或 SDK 增量。
 * @returns OpenRouter 支持的思考字段，空或无效值省略。
 */
function readReasoningFields(value: unknown): ReasoningFields {
  if (value === null || typeof value !== "object") return {}
  const { reasoning, reasoning_details: details } = value as Record<string, unknown>
  const fields: ReasoningFields = {}
  if (typeof reasoning === "string" && reasoning.length > 0) fields.reasoning = reasoning
  if (Array.isArray(details) && details.length > 0 && details.every(
    (detail): detail is ReasoningDetail => detail !== null && typeof detail === "object" && !Array.isArray(detail),
  )) fields.reasoning_details = details
  return fields
}

/**
 * 构造 OpenRouter 流式请求，按历史顺序回放同来源的 assistant 推理字段。
 * @param request 本次模型请求、上下文和工具定义。
 * @param config 模型输出上限和推理配置。
 * @returns 可由 OpenAI SDK 发送的请求体。
 * @throws AppError 当统一上下文或推理配置无效时抛出。
 */
export function buildChatRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
): OpenAI.ChatCompletionCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }]

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content.length > 0) messages.push({ role: "user", content })
    } else if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: joinTextBlocks(message.content) })
    } else if (message.role === "assistant") {
      let content = ""
      const toolCalls: NonNullable<OpenAI.ChatCompletionAssistantMessageParam["tool_calls"]> = []
      const nativeReasoning: ReasoningFields = {}
      for (const block of message.content) {
        if (block.type === "text") content += block.text
        if (block.type === "tool_call") {
          toolCalls.push({ id: block.toolCallId, type: "function", function: {
            name: block.name, arguments: serializeToolCallArguments(block.arguments),
          } })
        }
        const { replay } = block
        if (replay?.name !== REPLAY_SOURCE.name || replay.protocol !== REPLAY_SOURCE.protocol) continue

        let saved: unknown
        try {
          saved = JSON.parse(replay.payloadJson)
        } catch {
          continue
        }
        const { reasoning, reasoning_details: details } = readReasoningFields(saved)
        if (reasoning !== undefined) nativeReasoning.reasoning = (nativeReasoning.reasoning ?? "") + reasoning
        if (details !== undefined) (nativeReasoning.reasoning_details ??= []).push(...details)
      }
      if (content.length === 0 && toolCalls.length === 0 &&
        nativeReasoning.reasoning === undefined && nativeReasoning.reasoning_details === undefined) continue

      const assistant = {
        role: "assistant" as const,
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...nativeReasoning,
      }
      messages.push(assistant)
    }
  }

  return {
    model: request.model.name,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...reasoningRequestFragment(request, config),
    max_completion_tokens: config.maxOutputTokens,
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function" as const, function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" as const } : {}),
  }
}

/**
 * 按原始顺序累计详情。可由 index 或 id 识别的同一详情按到达顺序拼接其字符串分片。
 * @param details 当前响应的详情缓冲。
 * @param fragments 本次增量中的详情对象。
 */
function appendReasoningDetails(details: ReasoningDetail[], fragments: ReasoningDetail[]): void {
  for (const fragment of fragments) {
    const current = details.find((detail) => {
      if (detail.type !== fragment.type) return false
      if (detail.format != null && fragment.format != null && detail.format !== fragment.format) return false
      if (detail.id != null && fragment.id != null && detail.id !== fragment.id) return false
      if (detail.index != null && fragment.index != null && detail.index !== fragment.index) return false
      return (typeof fragment.index === "number" && detail.index === fragment.index) ||
        (typeof fragment.id === "string" && detail.id === fragment.id)
    })
    if (current === undefined) {
      details.push({ ...fragment })
      continue
    }
    for (const [key, value] of Object.entries(fragment)) {
      const previous = current[key]
      if (!Object.hasOwn(current, key) || previous == null) {
        Object.defineProperty(current, key, { value, enumerable: true, writable: true, configurable: true })
      } else if ((key === "text" || key === "summary" || key === "signature" || key === "data") &&
        typeof previous === "string" && typeof value === "string") {
        current[key] = previous + value
      }
    }
  }
}

/** 流中已开始输出的正文或思考文本。 */
interface PendingText {
  /** 统一事件索引。 */
  index: number
  /** 已发送给前端的完整文本。 */
  text: string
}

/** 当前连续思考段和首个有效文本选定的来源。 */
interface PendingThinking extends PendingText {
  /** 只收到签名或密文时保持未选定。 */
  source?: "reasoning" | "reasoning_details"
}

/** 按协议索引累计的单个工具调用，终态确认后提交。 */
interface PendingToolCall {
  /** 统一事件索引。 */
  index: number
  /** 用于关联后续 tool result 的协议 ID。 */
  toolCallId: string
  /** 累积的工具名。 */
  name: string
  /** 累积的原生工具参数。 */
  argumentsJson: string
}

/**
 * 从 OpenRouter 的结束原因确定 Runtime 状态。
 * @param reason 已报告的结束原因。
 * @param toolCount 已完整接收的工具调用数。
 * @returns 统一完成状态。
 */
function completionFor(reason: string, toolCount: number): ModelCompletion {
  switch (reason) {
    case "stop": return "finished"
    case "tool_calls":
    case "function_call": return toolCount > 0 ? "tool_calls" : "unknown"
    case "length":
    case "content_filter": return "incomplete"
    default: return "unknown"
  }
}

/**
 * 流式投影正文、思考和工具调用，并把完整原生推理附在最后一个思考块上。
 * @param chunks 本次尝试的 OpenRouter Chat Completions SDK 流。
 * @returns 按统一事件契约分配索引的增量、完整块和终态。
 * @throws 流报告错误、未报告结束原因或工具终态缺少调用 ID 或名称时抛出。
 */
export async function* mapChatStream(chunks: AsyncIterable<OpenAI.ChatCompletionChunk>): AsyncGenerator<ModelStreamEvent> {
  let nextIndex = 0
  let thinking: PendingThinking | undefined
  let inThinking = false
  let textBlock: PendingText | undefined
  const calls = new Map<number, PendingToolCall>()
  const nativeReasoning: ReasoningFields = {}
  let finishReason: string | undefined
  let usage: ChatCompletionsUsageFields | undefined

  for await (const chunk of chunks) {
    if (chunk.usage != null) usage = chunk.usage
    const choice = chunk.choices?.[0]
    const reason: string | null | undefined = choice?.finish_reason
    if ((chunk as { error?: unknown }).error != null || reason === "error") {
      throw new Error("OpenRouter Chat Completions 响应流报告错误")
    }
    if (!choice) continue
    if (reason != null) finishReason = reason

    const delta = choice.delta ?? {}
    const { reasoning, reasoning_details: details } = readReasoningFields(delta)
    if (reasoning !== undefined) nativeReasoning.reasoning = (nativeReasoning.reasoning ?? "") + reasoning
    if (details !== undefined) appendReasoningDetails(nativeReasoning.reasoning_details ??= [], details)

    const detailText = details?.map(({ text }) => typeof text === "string" ? text : "").join("")
    if (detailText || reasoning || (details !== undefined && thinking === undefined)) {
      if (textBlock) {
        yield { type: "block_end", index: textBlock.index, block: { type: "text", text: textBlock.text } }
        textBlock = undefined
      }
      if (!inThinking || thinking === undefined) {
        if (thinking) yield { type: "block_end", index: thinking.index, block: { type: "thinking", text: thinking.text } }
        thinking = { index: nextIndex++, text: "" }
        inThinking = true
        yield { type: "block_start", index: thinking.index, blockType: "thinking" }
      }
      if (thinking.source === undefined) {
        if (detailText) thinking.source = "reasoning_details"
        else if (reasoning) thinking.source = "reasoning"
      }
      const text = thinking.source === "reasoning_details" ? detailText : reasoning
      if (text) {
        thinking.text += text
        yield { type: "block_delta", index: thinking.index, delta: { type: "thinking", text } }
      }
    }

    const content = delta.content ?? delta.refusal
    if (content) {
      inThinking = false
      if (!textBlock) {
        textBlock = { index: nextIndex++, text: "" }
        yield { type: "block_start", index: textBlock.index, blockType: "text" }
      }
      textBlock.text += content
      yield { type: "block_delta", index: textBlock.index, delta: { type: "text", text: content } }
    }
    if (delta.tool_calls?.length) {
      inThinking = false
      if (textBlock) {
        yield { type: "block_end", index: textBlock.index, block: { type: "text", text: textBlock.text } }
        textBlock = undefined
      }
    }

    for (const deltaCall of delta.tool_calls ?? []) {
      let call = calls.get(deltaCall.index)
      if (!call) {
        call = { index: nextIndex++, toolCallId: "", name: "", argumentsJson: "" }
        calls.set(deltaCall.index, call)
        yield { type: "block_start", index: call.index, blockType: "tool_call" }
      }
      if (deltaCall.id) call.toolCallId = deltaCall.id
      const { name: nameDelta, arguments: argumentsDelta } = deltaCall.function ?? {}
      if (nameDelta || argumentsDelta) {
        call.name += nameDelta ?? ""
        call.argumentsJson += argumentsDelta ?? ""
        yield { type: "block_delta", index: call.index, delta: {
          type: "tool_call", toolCallId: call.toolCallId, nameDelta, argumentsDelta,
        } }
      }
    }
  }

  if (finishReason === undefined) throw streamInterruptedError(REPLAY_SOURCE.protocol)
  if (thinking) {
    yield { type: "block_end", index: thinking.index, block: {
      type: "thinking", text: thinking.text,
      replay: { ...REPLAY_SOURCE, payloadJson: JSON.stringify(nativeReasoning) },
    } }
  }
  if (textBlock) yield { type: "block_end", index: textBlock.index, block: { type: "text", text: textBlock.text } }
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    for (const call of calls.values()) {
      if (!call.toolCallId || !call.name) throw new Error("OpenRouter Chat Completions 返回了缺少 ID 或名称的工具调用")
      yield { type: "block_end", index: call.index, block: {
        type: "tool_call", toolCallId: call.toolCallId, name: call.name, arguments: parseToolCallArguments(call.argumentsJson),
      } }
    }
  }
  yield {
    type: "stream_end", completion: completionFor(finishReason, calls.size), finishReason,
    ...(usage && (usage.prompt_tokens != null || usage.completion_tokens != null || usage.total_tokens != null)
      ? { usage: convertChatCompletionsUsage(usage) } : {}),
  }
}
