import type Anthropic from "@anthropic-ai/sdk"

import { joinTextBlocks, parseToolCallArguments, reasoningRequestFragment, resolveToolCallInput, splitSystemMessage, streamInterruptedError } from "../../shared.ts"
import { convertAnthropicUsage } from "../../usage.ts"
import type { AnthropicUsageFields } from "../../usage.ts"
import type { AssistantContentBlock, ModelCompletion, ModelConfig, ModelStreamEvent, ReplaySource, UnifiedModelRequest } from "../../types.ts"

/** DeepSeek Messages 客户端会话需要原样回传的 assistant 内容块。 */
type NativeBlock = Extract<Anthropic.Messages.RawContentBlockStartEvent["content_block"], { type: "text" | "thinking" | "tool_use" }>

/** 用于保存 DeepSeek 原生块并与其他厂商的签名区分的来源。 */
const REPLAY_SOURCE = { name: "deepseek", protocol: "anthropic_messages" } satisfies ReplaySource

/**
 * 校验可用于 DeepSeek 工具调用和回放的 JSON 对象。
 * @param value SDK 事件或日志读取出的工具输入。
 * @returns 是否为非数组对象。
 */
function isToolInput(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * 校验并读取 assistant 的完整原生块。任一块不匹配时由请求构造投影普通内容。
 * @param blocks 按响应顺序保存的统一块。
 * @returns 同来源且与统一块匹配的原生内容，或 undefined。
 */
function readReplay(blocks: AssistantContentBlock[]): NativeBlock[] | undefined {
  const content: NativeBlock[] = []
  for (const block of blocks) {
    const { replay } = block
    if (replay?.name !== REPLAY_SOURCE.name || replay.protocol !== REPLAY_SOURCE.protocol) return undefined

    let native: NativeBlock | null
    try { native = JSON.parse(replay.payloadJson) as NativeBlock | null }
    catch { return undefined }
    if (!native) return undefined

    if (block.type === "text" && native.type === "text" && native.text === block.text ||
      block.type === "thinking" && native.type === "thinking" && native.thinking === block.text &&
        typeof native.signature === "string" && native.signature.length > 0 ||
      block.type === "tool_call" && native.type === "tool_use" && native.id === block.toolCallId &&
        native.name === block.name && isToolInput(native.input)) {
      content.push(native)
    } else {
      return undefined
    }
  }
  return content
}

/**
 * 构造 DeepSeek Messages 请求，保存工具定义、工具结果顺序与同来源的思考签名。
 * @param request 本次模型引用、上下文与工具定义。
 * @param config 本轮模型输出上限与推理配置。
 * @param thinking DeepSeek 的显式思考开关。
 * @returns 可由 Anthropic SDK 发送的普通 Messages 请求体。
 * @throws AppError 当上下文或推理配置无效时抛出。
 */
export function buildMessagesRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
  thinking: { type: "enabled" | "disabled" },
): Anthropic.Messages.MessageCreateParamsStreaming {
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
      continue
    }

    if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
      const content = blocks.filter((block) => block.text.length > 0)
      if (content.length === 0) continue
      messages.push({ role: "user", content })
      toolResults = undefined
    } else if (message.role === "assistant") {
      const native = request.context.purpose === "summary" ? undefined : readReplay(message.content)
      const content: Anthropic.Messages.ContentBlockParam[] = native ?? []
      if (native === undefined) {
        for (const block of message.content) {
          if (block.type === "text" && block.text.length > 0) content.push({ type: "text", text: block.text })
          if (block.type === "tool_call") content.push({ type: "tool_use", id: block.toolCallId, name: block.name,
            input: resolveToolCallInput(block.arguments) })
        }
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
  /** DeepSeek 接受不含 Anthropic SDK 类型所要求的 budget_tokens 的 thinking。 */
  Object.assign(params, reasoningRequestFragment(request, config), { thinking })
  return params
}

/** 当前内容块的原生字段和流中不断追加的签名或工具参数。 */
interface PendingBlock {
  index: number
  native: NativeBlock
  signatureStarted: boolean
  argumentsJson: string
}

/**
 * 从较新的累计用量覆盖初始用量，保留新事件省略的桶。
 * @param previous 当前记录的用量。
 * @param next 最新事件的累计用量。
 * @returns 以最新已报告值为准的用量。
 */
function mergeUsage(previous: AnthropicUsageFields, next: AnthropicUsageFields): AnthropicUsageFields {
  const thinkingTokens = next.output_tokens_details?.thinking_tokens ?? previous.output_tokens_details?.thinking_tokens
  return {
    input_tokens: next.input_tokens ?? previous.input_tokens,
    output_tokens: next.output_tokens ?? previous.output_tokens,
    total_tokens: next.total_tokens ?? previous.total_tokens,
    cache_creation_input_tokens: next.cache_creation_input_tokens ?? previous.cache_creation_input_tokens,
    cache_read_input_tokens: next.cache_read_input_tokens ?? previous.cache_read_input_tokens,
    ...(thinkingTokens != null ? { output_tokens_details: { thinking_tokens: thinkingTokens } } : {}),
  }
}

/**
 * 根据 DeepSeek Messages 的停止原因与完整工具块决定 Runtime 完成状态。
 * @param reason 原始 stop_reason。
 * @param completedCalls 已交付的完整工具块数量。
 * @returns Runtime 完成状态。
 */
function completionFor(reason: string, completedCalls: number): ModelCompletion {
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
 * 解析 DeepSeek Messages 的增量，保存工具调用和签名，并以 `message_stop` 确认终态。
 * @param events 本次尝试的 Anthropic SDK 流。
 * @param captureReplay 是否应将完整原生块随内容块存入会话历史。
 * @returns 统一块事件和最终用量。
 * @throws 流提前结束、原生块顺序错乱或签名与工具调用无效时抛出。
 */
export async function* mapMessagesStream(
  events: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>,
  captureReplay: boolean,
): AsyncGenerator<ModelStreamEvent> {
  const blocks = new Map<number, PendingBlock>()
  let nextIndex = 0
  let completedCalls = 0
  let stopReason: string | undefined
  let usage: AnthropicUsageFields | undefined

  /**
   * 将收到停止事件的内容块封装为 Runtime 块，普通会话同时保存原生回放。
   * @param block 本次流累积完成的内容块。
   * @returns 可交付的 block_end 事件。
   * @throws 思考签名缺失或工具调用的原生字段无效时抛出。
   */
  function closeBlock({ native, index, argumentsJson }: PendingBlock): ModelStreamEvent {
    let block: AssistantContentBlock
    switch (native.type) {
      case "thinking":
        if (captureReplay && !native.signature) throw streamInterruptedError("anthropic_messages")
        block = { type: "thinking", text: native.thinking }
        break
      case "text":
        block = { type: "text", text: native.text }
        break
      case "tool_use": {
        if (argumentsJson.length > 0) {
          if (captureReplay) {
            try { native.input = JSON.parse(argumentsJson) }
            catch { throw streamInterruptedError("anthropic_messages") }
          } else {
            native.input = parseToolCallArguments(argumentsJson)
          }
        }
        if (!native.id || !native.name || (captureReplay && !isToolInput(native.input))) {
          throw streamInterruptedError("anthropic_messages")
        }
        completedCalls += 1
        block = { type: "tool_call", toolCallId: native.id, name: native.name, arguments: native.input }
        break
      }
    }
    if (captureReplay) block.replay = { ...REPLAY_SOURCE, payloadJson: JSON.stringify(native) }
    return { type: "block_end", index, block }
  }

  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        if (event.message.usage) usage = mergeUsage(usage ?? {}, event.message.usage)
        break
      case "content_block_start": {
        const content = event.content_block
        if (content.type !== "text" && content.type !== "thinking" && content.type !== "tool_use") {
          if (captureReplay) throw streamInterruptedError("anthropic_messages")
          break
        }
        if (captureReplay && (event.index !== nextIndex || blocks.size > 0)) throw streamInterruptedError("anthropic_messages")
        const index = nextIndex++
        blocks.set(event.index, { index, native: structuredClone(content), signatureStarted: false, argumentsJson: "" })
        const blockType = content.type === "tool_use" ? "tool_call" : content.type
        yield { type: "block_start", index, blockType }
        if (content.type === "tool_use") {
          yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: content.id, nameDelta: content.name } }
        } else {
          const text = content.type === "thinking" ? content.thinking : content.text
          if (text.length > 0) yield { type: "block_delta", index, delta: { type: content.type, text } }
        }
        break
      }
      case "content_block_delta": {
        const block = blocks.get(event.index)
        if (!block) {
          if (captureReplay) throw streamInterruptedError("anthropic_messages")
          break
        }
        const { delta } = event
        const { native, index } = block
        if (native.type === "text" && delta.type === "text_delta") {
          native.text += delta.text
          yield { type: "block_delta", index, delta: { type: "text", text: delta.text } }
        } else if (native.type === "thinking" && delta.type === "thinking_delta") {
          native.thinking += delta.thinking
          yield { type: "block_delta", index, delta: { type: "thinking", text: delta.thinking } }
        } else if (native.type === "thinking" && delta.type === "signature_delta") {
          native.signature = (block.signatureStarted ? native.signature : "") + delta.signature
          block.signatureStarted = true
        } else if (native.type === "tool_use" && delta.type === "input_json_delta") {
          block.argumentsJson += delta.partial_json
          yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: native.id, argumentsDelta: delta.partial_json } }
        } else if (native.type === "text" && delta.type === "citations_delta") {
          ;(native.citations ??= []).push(delta.citation)
        } else if (captureReplay) {
          throw streamInterruptedError("anthropic_messages")
        }
        break
      }
      case "content_block_stop": {
        const block = blocks.get(event.index)
        if (block) {
          blocks.delete(event.index)
          yield closeBlock(block)
        } else if (captureReplay) {
          throw streamInterruptedError("anthropic_messages")
        }
        break
      }
      case "message_delta":
        if (event.usage) usage = mergeUsage(usage ?? {}, event.usage)
        if (event.delta.stop_reason != null) stopReason = event.delta.stop_reason
        break
      case "message_stop":
        if (captureReplay && (blocks.size > 0 || stopReason === undefined)) throw streamInterruptedError("anthropic_messages")
        for (const block of blocks.values()) {
          if (block.native.type !== "tool_use") yield closeBlock(block)
        }
        yield {
          type: "stream_end",
          completion: stopReason === undefined ? "unknown" : completionFor(stopReason, completedCalls),
          ...(stopReason !== undefined ? { finishReason: stopReason } : {}),
          ...(usage && Object.values(usage).some((value) => value != null) ? { usage: convertAnthropicUsage(usage) } : {}),
        }
        return
    }
  }
  throw streamInterruptedError("anthropic_messages")
}
