import type OpenAI from "openai"

import { createAbortError } from "../../../../error/src/abort.ts"
import {
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "../../shared.ts"
import type { ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../../types.ts"
import { convertChatCompletionsUsage, type ChatCompletionsUsageFields } from "../../usage.ts"

/**
 * 按消息投影历史正文、明文思考与工具调用，并应用本轮模型的推理参数与输出上限。
 * @param request 本次统一请求，含历史、API 模型名及工具定义。
 * @param config 本轮模型的输出上限和推理设置。
 * @returns 启用流式输出和尾部 Usage 的 SDK 请求参数。
 * @throws AppError 当统一上下文或推理配置无效时抛出。
 */
export function buildChatCompletionsRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
): OpenAI.ChatCompletionCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }]

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content !== "") messages.push({ role: "user", content })
    } else if (message.role === "assistant") {
      let content = ""
      let reasoningContent = ""
      const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = []
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            content += block.text
            break
          case "thinking":
            if (block.text !== "") reasoningContent += block.text
            break
          case "tool_call":
            toolCalls.push({ type: "function", id: block.toolCallId, function: {
              name: block.name, arguments: serializeToolCallArguments(block.arguments),
            } })
            break
        }
      }
      if (content === "" && reasoningContent === "" && toolCalls.length === 0) continue
      const assistant = {
        role: "assistant" as const,
        content: content === "" ? null : content,
        ...(reasoningContent !== "" ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      }
      messages.push(assistant)
    } else if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: joinTextBlocks(message.content) })
    }
  }

  return {
    ...reasoningRequestFragment(request, config),
    model: request.model.name,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: config.maxOutputTokens,
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
  }
}

/** 相邻的同类型文本分片共用一个 Runtime 块。 */
type PendingText = { index: number; type: "thinking" | "text"; text: string }

/** 同一 SDK 工具序号下累积的调用身份、名称和原始参数。 */
type PendingToolCall = { index: number; toolCallId: string; name: string; argumentsJson: string }

/**
 * 识别至少包含一个有效计数的 Usage，兼容尾部只有部分计数的响应。
 * @param usage SDK chunk 中可空的用量字段。
 * @returns 用量对象包含已报告的非负整数计数且已报告的计数均有效时为 true。
 */
function hasReportedUsage(usage: ChatCompletionsUsageFields | null | undefined): usage is ChatCompletionsUsageFields {
  if (usage == null) return false
  const counts = [
    usage.prompt_tokens, usage.completion_tokens, usage.total_tokens,
    usage.prompt_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cache_write_tokens,
    usage.prompt_cache_hit_tokens, usage.cached_tokens, usage.completion_tokens_details?.reasoning_tokens,
  ].filter((count) => count != null)
  return counts.length > 0 && counts.every((count) => Number.isInteger(count) && count >= 0)
}

/**
 * 把默认 choice 的分片映射为 Runtime 事件，读完尾部 Usage 后提交完整工具调用与终态。
 * @param chunks 本次网络尝试的 OpenAI SDK 流。
 * @param signal 共享网关提供的信号，用于识别 SDK 静默停止时的取消。
 * @returns 以一次 stream_end 收尾的事件流，截断的工具调用只交付增量。
 * @throws SDK 失败、取消、终态前断流或工具终态缺少调用 ID 或名称时抛出。
 */
export async function* mapChatCompletionsStream(
  chunks: AsyncIterable<OpenAI.ChatCompletionChunk>,
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  let nextIndex = 0
  let activeText: PendingText | undefined
  const calls = new Map<number, PendingToolCall>()
  let finishReason: string | undefined
  let usage: ChatCompletionsUsageFields | undefined

  for await (const chunk of chunks) {
    if (hasReportedUsage(chunk.usage)) usage = chunk.usage
    if (finishReason !== undefined) continue
    const choice = chunk.choices.find(({ index }) => index === 0)
    if (!choice) continue

    const delta: (OpenAI.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null }) | undefined = choice.delta
    const parts = [["thinking", delta?.reasoning_content], ["text", delta?.content]] as const
    for (const [type, text] of parts) {
      if (typeof text !== "string" || text === "") continue
      if (activeText?.type !== type) {
        if (activeText) {
          yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
        }
        activeText = { index: nextIndex++, type, text: "" }
        yield { type: "block_start", index: activeText.index, blockType: type }
      }
      activeText.text += text
      yield { type: "block_delta", index: activeText.index, delta: { type, text } }
    }

    if (delta?.tool_calls?.length && activeText) {
      yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
      activeText = undefined
    }
    for (const fragment of delta?.tool_calls ?? []) {
      let call = calls.get(fragment.index)
      if (!call) {
        call = { index: nextIndex++, toolCallId: "", name: "", argumentsJson: "" }
        calls.set(fragment.index, call)
        yield { type: "block_start", index: call.index, blockType: "tool_call" }
      }
      if (fragment.id && !call.toolCallId) call.toolCallId = fragment.id
      const { name: nameDelta, arguments: argumentsDelta } = fragment.function ?? {}
      call.name += nameDelta ?? ""
      call.argumentsJson += argumentsDelta ?? ""
      if (fragment.id || nameDelta || argumentsDelta) {
        yield { type: "block_delta", index: call.index, delta: {
          type: "tool_call", toolCallId: call.toolCallId,
          ...(nameDelta ? { nameDelta } : {}), ...(argumentsDelta ? { argumentsDelta } : {}),
        } }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  if (signal?.aborted) throw createAbortError()
  if (finishReason === undefined) throw streamInterruptedError("chat_completions")
  const completedCalls = finishReason === "tool_calls" || finishReason === "function_call" ? [...calls.values()] : []
  if (completedCalls.some(({ toolCallId, name }) => !toolCallId || !name)) {
    throw new Error("NVIDIA Chat Completions 返回了缺少 ID 或名称的工具调用")
  }

  if (activeText) {
    yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
  }
  for (const call of completedCalls) {
    yield { type: "block_end", index: call.index, block: {
      type: "tool_call", toolCallId: call.toolCallId, name: call.name, arguments: parseToolCallArguments(call.argumentsJson),
    } }
  }

  let completion: ModelCompletion = "unknown"
  if (completedCalls.length > 0) completion = "tool_calls"
  else if (finishReason === "stop") completion = "finished"
  else if (finishReason === "length" || finishReason === "content_filter") completion = "incomplete"
  if (signal?.aborted) throw createAbortError()
  yield { type: "stream_end", completion, finishReason, ...(usage ? { usage: convertChatCompletionsUsage(usage) } : {}) }
}
