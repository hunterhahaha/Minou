import type Anthropic from "@anthropic-ai/sdk"
import { joinTextBlocks, parseToolCallArguments, reasoningRequestFragment, resolveToolCallInput, splitSystemMessage, streamInterruptedError } from "../../shared.ts"
import type { AssistantContentBlock, ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../../types.ts"
import { convertAnthropicUsage } from "../../usage.ts"
import type { AnthropicUsageFields } from "../../usage.ts"
import { extractProviderError, record } from "./provider.ts"
import type { GlmProvider } from "./provider.ts"
import { mergeMessagesUsage } from "./usage.ts"

/**
 * 将会话的正文、工具调用与结果投影到 Messages 请求。
 * @param request 当前上下文、工具和所选模型档位。
 * @param config 本轮模型输出上限和推理配置。
 * @returns 可由 Anthropic SDK 发送的普通 Messages 流式请求。
 * @throws AppError 当上下文或推理配置无效时抛出。
 */
export function buildMessagesRequest(request: UnifiedModelRequest, config: ModelConfig): Anthropic.Messages.MessageCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const messages: Anthropic.Messages.MessageParam[] = []
  let toolResults: Anthropic.Messages.ToolResultBlockParam[] | undefined

  for (const message of rest) {
    if (message.role === "tool") {
      if (!toolResults) {
        toolResults = []
        messages.push({ role: "user", content: toolResults })
      }
      toolResults.push({ type: "tool_result", tool_use_id: message.toolCallId, content: joinTextBlocks(message.content),
        ...(message.isError ? { is_error: true } : {}) })
    } else if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
      const content = blocks.filter((block) => block.text.length > 0)
      if (content.length === 0) continue
      messages.push({ role: "user", content })
      toolResults = undefined
    } else if (message.role === "assistant") {
      const content: Anthropic.Messages.ContentBlockParam[] = []
      for (const block of message.content) {
        if (block.type === "text" && block.text.length > 0) content.push({ type: "text", text: block.text })
        if (block.type === "tool_call") content.push({ type: "tool_use", id: block.toolCallId, name: block.name,
          input: resolveToolCallInput(block.arguments) })
      }
      if (content.length === 0) continue
      messages.push({ role: "assistant", content })
      toolResults = undefined
    }
  }

  const params: Anthropic.Messages.MessageCreateParamsStreaming = {
    model: request.model.name,
    system,
    messages,
    stream: true,
    max_tokens: config.maxOutputTokens,
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}),
  }
  return Object.assign(params, reasoningRequestFragment(request, config))
}

/** 与 Messages 原始索引关联的内容块，只保留 Runtime 支持的类型。 */
type PendingBlock = { index: number } & (
  | { type: "text" | "thinking"; text: string }
  | { type: "tool_use"; toolCallId: string; name: string; input: unknown; argumentsJson: string }
)

/**
 * 将 Messages 停止原因和完整工具块映射为统一完成状态。
 * @param reason message_delta 报告的停止原因。
 * @param completedCalls 收到内容块停止事件的工具调用数。
 * @returns Runtime 完成状态。
 */
function completionFor(reason: string | undefined, completedCalls: number): ModelCompletion {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "refusal": return "finished"
    case "tool_use": return completedCalls > 0 ? "tool_calls" : "unknown"
    case "max_tokens":
    case "model_context_window_exceeded": return "incomplete"
    default: return "unknown"
  }
}

/**
 * 按 Messages 内容块索引拼接正文、思考文本与工具参数，并以 message_stop 确认终态。
 * @param events 本次尝试的 Anthropic SDK 流。
 * @param provider 用于提取错误的 Provider 分支。
 * @returns 统一块事件与最终用量。
 * @throws 流报告错误、缺少 message_stop 或工具调用缺少身份时抛出。
 */
export async function* mapMessagesStream(
  events: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>, provider: GlmProvider,
): AsyncGenerator<ModelStreamEvent> {
  const blocks = new Map<number, PendingBlock>()
  let nextIndex = 0
  let completedCalls = 0
  let stopReason: string | undefined
  let usage: AnthropicUsageFields | undefined

  /**
   * 结束内容块，收到内容块停止事件的工具调用计入完成状态。
   * @param pending 该块的累计内容。
   * @param complete 是否收到内容块停止事件。
   * @returns Runtime 的完整内容块事件。
   */
  function closeBlock(pending: PendingBlock, complete: boolean): ModelStreamEvent {
    let block: AssistantContentBlock
    switch (pending.type) {
      case "text":
      case "thinking":
        block = { type: pending.type, text: pending.text }
        break
      case "tool_use":
        if (complete) completedCalls += 1
        block = { type: "tool_call", toolCallId: pending.toolCallId, name: pending.name,
          arguments: pending.argumentsJson.length > 0 ? parseToolCallArguments(pending.argumentsJson) : pending.input }
        break
    }
    return { type: "block_end", index: pending.index, block }
  }

  for await (const event of events) {
    if (record(event)?.type === "error") {
      throw extractProviderError(event, "anthropic_messages", provider, "GLM Messages 流报告错误")
    }
    switch (event.type) {
      case "message_start":
        usage = mergeMessagesUsage(usage, event.message.usage)
        break
      case "content_block_start": {
        const content = event.content_block
        let block: PendingBlock
        switch (content.type) {
          case "thinking":
            block = { index: nextIndex++, type: content.type, text: content.thinking ?? "" }
            break
          case "text":
            block = { index: nextIndex++, type: content.type, text: content.text ?? "" }
            break
          case "tool_use":
            if (!content.id || !content.name) throw new Error("GLM Messages 返回了缺少 ID 或名称的工具调用")
            block = { index: nextIndex++, type: content.type, toolCallId: content.id, name: content.name, input: content.input, argumentsJson: "" }
            break
          default:
            continue
        }
        const { index } = block
        blocks.set(event.index, block)
        const blockType = block.type === "tool_use" ? "tool_call" : block.type
        yield { type: "block_start", index, blockType }
        if (block.type === "tool_use") {
          yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: block.toolCallId, nameDelta: block.name } }
        } else if (block.text.length > 0) {
          yield { type: "block_delta", index, delta: { type: block.type, text: block.text } }
        }
        break
      }
      case "content_block_delta": {
        const block = blocks.get(event.index)
        if (!block) break
        const { delta } = event
        const { index } = block
        if (block.type === "text" && delta.type === "text_delta" && delta.text.length > 0) {
          block.text += delta.text
          yield { type: "block_delta", index, delta: { type: "text", text: delta.text } }
        } else if (block.type === "thinking" && delta.type === "thinking_delta" && delta.thinking.length > 0) {
          block.text += delta.thinking
          yield { type: "block_delta", index, delta: { type: "thinking", text: delta.thinking } }
        } else if (block.type === "tool_use" && delta.type === "input_json_delta" && delta.partial_json.length > 0) {
          block.argumentsJson += delta.partial_json
          yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: block.toolCallId, argumentsDelta: delta.partial_json } }
        }
        break
      }
      case "content_block_stop": {
        const block = blocks.get(event.index)
        if (block) {
          blocks.delete(event.index)
          yield closeBlock(block, true)
        }
        break
      }
      case "message_delta":
        usage = mergeMessagesUsage(usage, event.usage)
        stopReason = event.delta.stop_reason ?? stopReason
        break
      case "message_stop":
        for (const block of blocks.values()) yield closeBlock(block, false)
        yield { type: "stream_end", completion: completionFor(stopReason, completedCalls),
          ...(stopReason ? { finishReason: stopReason } : {}), ...(usage ? { usage: convertAnthropicUsage(usage) } : {}) }
        return
    }
  }
  throw streamInterruptedError("anthropic_messages")
}
