import type OpenAI from "openai"

import { joinTextBlocks, parseToolCallArguments, reasoningRequestFragment, serializeToolCallArguments, splitSystemMessage, streamInterruptedError } from "../../shared.ts"
import { convertChatCompletionsUsage } from "../../usage.ts"
import type { ChatCompletionsUsageFields } from "../../usage.ts"
import type { ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../../types.ts"

/**
 * 构造 DeepSeek Chat Completions 请求，携带工具定义时回传所有可用历史思考。
 * @param request 本次模型引用、上下文与工具定义。
 * @param config 本轮模型输出上限与推理配置。
 * @param thinking DeepSeek 的显式思考开关。
 * @returns 可由 OpenAI SDK 发送的请求体。
 * @throws AppError 当上下文或推理配置无效时抛出。
 */
export function buildChatRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
  thinking: { type: "enabled" | "disabled" },
): OpenAI.ChatCompletionCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const replayThinking = tools.length > 0 && request.context.purpose !== "summary"
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }]

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content.length > 0) messages.push({ role: "user", content })
    } else if (message.role === "assistant") {
      let content = ""
      let reasoningContent = ""
      const toolCalls: NonNullable<OpenAI.ChatCompletionAssistantMessageParam["tool_calls"]> = []
      for (const block of message.content) {
        if (block.type === "text") content += block.text
        if (block.type === "thinking" && replayThinking) reasoningContent += block.text
        if (block.type === "tool_call") {
          toolCalls.push({ id: block.toolCallId, type: "function", function: {
            name: block.name, arguments: serializeToolCallArguments(block.arguments),
          } })
        }
      }
      if (content.length === 0 && reasoningContent.length === 0 && toolCalls.length === 0) continue

      const assistant = {
        role: "assistant" as const,
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningContent.length > 0 ? { reasoning_content: reasoningContent } : {}),
      }
      messages.push(assistant)
    } else if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: joinTextBlocks(message.content) })
    }
  }

  const params = {
    model: request.model.name,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function" as const, function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" as const } : {}),
  } satisfies OpenAI.ChatCompletionCreateParamsStreaming
  return Object.assign(params, reasoningRequestFragment(request, config), { max_tokens: config.maxOutputTokens, thinking })
}

/** 同一通道连续到达的思考或正文分片。 */
interface TextBlock {
  index: number
  type: "thinking" | "text"
  text: string
}

/** 按 DeepSeek 工具序号累计的调用，收到工具终态才交付给 Runtime。 */
interface ToolCall {
  index: number
  toolCallId: string
  name: string
  argumentsJson: string
}

/**
 * 映射 DeepSeek 报告的结束原因，并确认工具终态包含可消费的调用。
 * @param reason DeepSeek 流最后的原始结束原因。
 * @param callCount 已完成的工具调用数。
 * @returns Runtime 完成状态。
 */
function completionFor(reason: string, callCount: number): ModelCompletion {
  switch (reason) {
    case "stop": return "finished"
    case "function_call":
    case "tool_calls": return callCount > 0 ? "tool_calls" : "unknown"
    case "length":
    case "content_filter":
    case "insufficient_system_resource":
    case "aborted": return "incomplete"
    default: return "unknown"
  }
}

/**
 * 读取 DeepSeek 的思考增量，兼容使用同协议的中转端点提供的明文表示。
 * @param delta SDK chunk 中的单次增量。
 * @returns 按字段优先级选取的明文思考，或空字符串。
 */
function readReasoning(delta: OpenAI.ChatCompletionChunk.Choice.Delta): string {
  const fields = delta as Record<string, unknown>
  for (const value of [fields.reasoning_content, fields.reasoning]) {
    if (typeof value === "string" && value.length > 0) return value
  }
  if (!Array.isArray(fields.reasoning_details)) return ""

  let text = ""
  for (const detail of fields.reasoning_details) {
    if (detail === null || typeof detail !== "object") continue
    const { type, text: detailText, summary } = detail as Record<string, unknown>
    if (type === "reasoning.text" && typeof detailText === "string") text += detailText
    if (type === "reasoning.summary" && typeof summary === "string") text += summary
  }
  return text
}

/**
 * 解析 DeepSeek Chat 流，收齐思考、正文、并行工具分片以及终止块中的用量。
 * @param chunks 本次尝试的 OpenAI SDK 流。
 * @returns 分配统一序号的块和最终流状态。
 * @throws 流未报告结束原因，或工具终态中的调用缺少 ID 或名称时抛出。
 */
export async function* mapChatStream(chunks: AsyncIterable<OpenAI.ChatCompletionChunk>): AsyncGenerator<ModelStreamEvent> {
  let nextIndex = 0
  let activeText: TextBlock | undefined
  const calls = new Map<number, ToolCall>()
  let finishReason: string | undefined
  let usage: ChatCompletionsUsageFields | undefined

  /**
   * 投影一个思考或正文增量，切换通道时先结束上一块。
   * @param type 当前文本通道。
   * @param text 当前增量。
   * @returns 对应的块开始、增量与必要的上一块结束事件。
   */
  function* appendText(type: TextBlock["type"], text: string): Generator<ModelStreamEvent> {
    if (activeText?.type !== type) {
      if (activeText) yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
      activeText = { index: nextIndex++, type, text: "" }
      yield { type: "block_start", index: activeText.index, blockType: type }
    }
    activeText.text += text
    yield { type: "block_delta", index: activeText.index, delta: { type, text } }
  }

  for await (const chunk of chunks) {
    if (chunk.usage != null) usage = chunk.usage
    const choice = chunk.choices[0]
    if (!choice) continue
    if (choice.finish_reason != null) finishReason = choice.finish_reason

    const { delta } = choice
    const reasoning = readReasoning(delta)
    if (reasoning.length > 0) yield* appendText("thinking", reasoning)
    const content = delta.content ?? delta.refusal
    if (content) yield* appendText("text", content)
    if (delta.tool_calls?.length && activeText) {
      yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
      activeText = undefined
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
      if (nameDelta) {
        call.name += nameDelta
        yield { type: "block_delta", index: call.index, delta: { type: "tool_call", toolCallId: call.toolCallId, nameDelta } }
      }
      if (argumentsDelta) {
        call.argumentsJson += argumentsDelta
        yield { type: "block_delta", index: call.index, delta: { type: "tool_call", toolCallId: call.toolCallId, argumentsDelta } }
      }
    }
  }

  if (finishReason === undefined) throw streamInterruptedError("chat_completions")
  if (activeText) yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    for (const call of calls.values()) {
      if (!call.toolCallId || !call.name) throw new Error("DeepSeek Chat Completions 返回了缺少 ID 或名称的工具调用")
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
