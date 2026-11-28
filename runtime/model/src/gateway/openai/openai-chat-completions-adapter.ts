import type OpenAI from "openai"

import {
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "../../shared.ts"
import { convertChatCompletionsUsage } from "../../usage.ts"
import type { ChatCompletionsUsageFields } from "../../usage.ts"
import type { ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../../types.ts"

/**
 * 构造原生 Chat Completions 请求，映射会话消息、函数工具和官方输出上限字段。
 * @param request 本次统一请求，包含上下文和工具定义。
 * @param config 本轮模型的推理字段与输出上限。
 * @returns Chat Completions SDK 的流式参数。
 * @throws AppError 当统一上下文或推理配置无效时抛出。
 */
export function buildChatCompletionsRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
): OpenAI.ChatCompletionCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: config.supportsReasoning ? "developer" : "system", content: system },
  ]

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content.length > 0) messages.push({ role: "user", content })
    } else if (message.role === "assistant") {
      let content = ""
      const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = []
      for (const block of message.content) {
        if (block.type === "text") content += block.text
        if (block.type === "tool_call") {
          toolCalls.push({ type: "function", id: block.toolCallId, function: {
            name: block.name, arguments: serializeToolCallArguments(block.arguments),
          } })
        }
      }
      if (content.length > 0 || toolCalls.length > 0) {
        messages.push({ role: "assistant", content: content || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) })
      }
    } else if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: joinTextBlocks(message.content) })
    }
  }

  const params: OpenAI.ChatCompletionCreateParamsStreaming = {
    model: request.model.name,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
  }
  return Object.assign(params, reasoningRequestFragment(request, config), { max_completion_tokens: config.maxOutputTokens })
}

/** 同一文本块的统一序号与已接收正文。 */
interface PendingText {
  index: number
  text: string
}

/** 按 Chat Completions 工具序号累积的调用分片。 */
interface PendingToolCall {
  index: number
  toolCallId: string
  name: string
  argumentsJson: string
}

/**
 * 映射 Chat Completions 的结束原因和完整工具调用。
 * @param reason 来自所消费 choice 的原始结束原因。
 * @param callCount 已收尾的函数调用数量。
 * @returns Runtime 使用的统一完成状态。
 */
function completionFor(reason: string, callCount: number): ModelCompletion {
  switch (reason) {
    case "stop": return "finished"
    case "tool_calls": return callCount > 0 ? "tool_calls" : "unknown"
    case "length":
    case "content_filter": return "incomplete"
    default: return "unknown"
  }
}

/**
 * 将 Chat Completions chunk 流映射为正文、函数调用与最终 Usage。
 * @param chunks 本次网络尝试的 SDK 流。
 * @returns 按首次出现顺序分配统一序号后的异步事件流。
 * @throws 流未报告结束原因，或完整工具调用缺少 ID 或名称时抛出。
 */
export async function* mapChatCompletionsStream(
  chunks: AsyncIterable<OpenAI.ChatCompletionChunk>,
): AsyncGenerator<ModelStreamEvent> {
  const calls = new Map<number, PendingToolCall>()
  let nextIndex = 0
  let activeText: PendingText | undefined
  let finishReason: string | undefined
  let usage: ChatCompletionsUsageFields | undefined

  for await (const chunk of chunks) {
    if (chunk.usage != null) usage = chunk.usage
    const choice = chunk.choices[0]
    if (!choice) continue
    if (choice.finish_reason != null) finishReason = choice.finish_reason

    const { delta } = choice
    const text = (delta.content ?? "") + (delta.refusal ?? "")
    if (text.length > 0) {
      if (!activeText) {
        activeText = { index: nextIndex++, text: "" }
        yield { type: "block_start", index: activeText.index, blockType: "text" }
      }
      activeText.text += text
      yield { type: "block_delta", index: activeText.index, delta: { type: "text", text } }
    }

    if (delta.tool_calls?.length && activeText) {
      yield { type: "block_end", index: activeText.index, block: { type: "text", text: activeText.text } }
      activeText = undefined
    }
    for (const toolDelta of delta.tool_calls ?? []) {
      let call = calls.get(toolDelta.index)
      if (!call) {
        call = { index: nextIndex++, toolCallId: "", name: "", argumentsJson: "" }
        calls.set(toolDelta.index, call)
        yield { type: "block_start", index: call.index, blockType: "tool_call" }
      }
      if (toolDelta.id) call.toolCallId = toolDelta.id
      const { name: nameDelta, arguments: argumentsDelta } = toolDelta.function ?? {}
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
  if (activeText) yield { type: "block_end", index: activeText.index, block: { type: "text", text: activeText.text } }
  if (finishReason === "tool_calls") {
    for (const call of calls.values()) {
      if (!call.toolCallId || !call.name) throw new Error("OpenAI Chat Completions 返回了缺少 ID 或名称的工具调用")
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
