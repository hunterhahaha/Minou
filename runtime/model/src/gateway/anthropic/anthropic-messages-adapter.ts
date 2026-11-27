import type Anthropic from "@anthropic-ai/sdk"

import type { ProtocolRequest } from "../adapter.ts"
import {
  applyHistoryToolChange,
  historyMessage,
  invalidRequest,
  joinTextBlocks,
  reasoningRequestFragment,
  resolveToolCallInput,
  splitSystemMessage,
  streamInterruptedError,
} from "../../shared.ts"
import { convertAnthropicUsage } from "../../usage.ts"
import type { AnthropicUsageFields } from "../../usage.ts"
import type {
  AssistantContentBlock,
  ModelCompletion,
  ModelConfig,
  ModelHistory,
  ModelMessage,
  ModelStreamEvent,
  ReplaySource,
  UnifiedModelRequest,
  UnifiedToolDefinition,
} from "../../types.ts"

/** 专用转换器写入会话历史的固定来源。 */
const REPLAY_SOURCE = { name: "Anthropic", protocol: "anthropic_messages" } satisfies ReplaySource

/** 共享 SDK 入口接受的 Messages 请求及 beta 选项。 */
type MessagesRequest = Extract<ProtocolRequest, { protocol: "anthropic_messages" }>

/** 可按序追加普通消息和内联工具变更的原生消息数组。 */
type Messages = MessagesRequest["params"]["messages"]

/** 与 Minou 文本、思考、工具调用对应的 Anthropic 原生流式内容。 */
type NativeBlock = Extract<Anthropic.Messages.RawContentBlockStartEvent["content_block"],
  { type: "text" | "thinking" | "redacted_thinking" | "tool_use" }>

/**
 * 将一条工具定义转换成 Anthropic 客户端工具。
 * @param tool Minou 调用工具时使用的名称、描述和 JSON Schema。
 * @returns 顶层或内联工具定义。
 */
function toTool(tool: UnifiedToolDefinition): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
  }
}

/**
 * 按块投影 assistant 内容，原样采用同来源的原生 JSON。
 * @param blocks 已完成的统一内容块，按响应顺序排列。
 * @returns 可发给 Anthropic 的消息内容，缺少同来源回放的 thinking 会跳过。
 * @throws AppError 当同来源回放无法解析为 JSON 对象时抛出。
 */
function assistantContent(blocks: AssistantContentBlock[]): Anthropic.Messages.ContentBlockParam[] {
  const content: Anthropic.Messages.ContentBlockParam[] = []
  for (const block of blocks) {
    if (block.replay?.name === REPLAY_SOURCE.name) {
      let native: unknown
      try {
        native = JSON.parse(block.replay.payloadJson)
      } catch {
        throw invalidRequest("Anthropic 回放内容不是有效的 JSON")
      }
      if (native === null || typeof native !== "object" || Array.isArray(native)) {
        throw invalidRequest("Anthropic 回放内容必须是原生内容块对象")
      }
      content.push(native as Anthropic.Messages.ContentBlockParam)
    } else if (block.type === "text" && block.text.length > 0) {
      content.push({ type: "text", text: block.text })
    } else if (block.type === "tool_call") {
      content.push({ type: "tool_use", id: block.toolCallId, name: block.name, input: resolveToolCallInput(block.arguments) })
    }
  }
  return content
}

/**
 * 将一条消息追加到请求，必要时将同批次工具结果合并进同一条 user 消息。
 * @param messages 正在构造的请求消息。
 * @param message 待追加的消息，系统提示已在顶层处理。
 * @param mergeToolResult 是否可与紧邻的上一组工具结果合并。
 */
function appendMessage(messages: Messages, message: ModelMessage, mergeToolResult: boolean): void {
  if (message.role === "assistant") {
    const content = assistantContent(message.content)
    if (content.length > 0) messages.push({ role: "assistant", content })
  } else if (message.role === "user") {
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
    const content = blocks.filter(({ text }) => text.length > 0)
    if (content.length > 0) messages.push({ role: "user", content })
  } else if (message.role === "tool") {
    const result: Anthropic.Messages.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: joinTextBlocks(message.content),
      ...(message.isError ? { is_error: true } : {}),
    }
    const previous = messages.at(-1)
    if (mergeToolResult && previous?.role === "user" && typeof previous.content !== "string" &&
        previous.content[0]?.type === "tool_result") {
      previous.content.push(result)
    } else {
      messages.push({ role: "user", content: [result] })
    }
  }
}

/**
 * 重建签名对应的会话前缀。首个原生思考块之后，工具变更按原顺序内联。
 * @param history 宿主提供的系统提示、工具基线与有序会话事件。
 * @param baseTools 本轮始终提供的工具定义。
 * @returns 原生消息序列和顶层工具表。
 * @throws AppError 当原生回放损坏或内联工具变更缺少前置 user 消息时抛出。
 */
function buildHistory(history: ModelHistory, baseTools: UnifiedToolDefinition[]): {
  messages: Messages
  definitions: UnifiedToolDefinition[]
} {
  const messages: Messages = []
  const tools = new Map([...baseTools, ...history.mcpBaseline].map((tool) => [tool.name, tool]))
  let frozen = false
  let changes: Extract<Messages[number], { role: "system" }>["content"] = []
  let previousResult: { turn: number; step: number } | undefined

  /**
   * 将待发送工具变更放在用户内容或整批工具结果之后。
   * @throws AppError 当当前位置无法接收内联系统消息时抛出。
   */
  function flushChanges(): void {
    if (changes.length === 0) return
    if (messages.at(-1)?.role !== "user") throw invalidRequest("Anthropic 内联工具变更缺少前置用户消息")
    messages.push({ role: "system", content: changes })
    changes = []
  }

  for (const event of history.events) {
    if (event.type === "mcp/tools_added" || event.type === "mcp/tools_removed") {
      if (!frozen) applyHistoryToolChange(tools, event)
      else if (event.type === "mcp/tools_added") {
        for (const tool of event.definitions) {
          changes.push({ type: "tool_addition", tool: { type: "tool_definition", definition: toTool(tool) } })
        }
      } else {
        for (const name of event.toolNames) changes.push({ type: "tool_removal", tool: { type: "tool_reference", name } })
      }
      continue
    }
    const message = historyMessage(event)
    if (message === undefined) continue
    if (message.role === "assistant") {
      const content = assistantContent(message.content)
      if (content.length === 0) continue
      flushChanges()
      messages.push({ role: "assistant", content })
      frozen ||= content.some(({ type }) => type === "thinking" || type === "redacted_thinking")
    } else {
      appendMessage(messages, message, event.type === "tool/result" &&
        previousResult?.turn === event.turn && previousResult.step === event.step)
    }
    previousResult = event.type === "tool/result" ? event : undefined
  }
  flushChanges()
  return { messages, definitions: [...tools.values()] }
}

/**
 * 将独立的压缩上下文转成单条用户材料，避免把原会话签名附到已改写的前缀上。
 * @param messages 原会话材料及最后一条摘要指令。
 * @returns 仅含通用内容和摘要指令的 Messages 消息。
 */
function summaryMessage(messages: ModelMessage[]): Anthropic.Messages.MessageParam {
  const material = messages.slice(0, -1).map((message) => message.role !== "assistant" ? message : {
    ...message,
    content: message.content.map(({ replay: _replay, ...block }) => block),
  })
  const instruction = messages.at(-1)
  const prompt = instruction?.role !== "user" ? "" :
    typeof instruction.content === "string" ? instruction.content : joinTextBlocks(instruction.content)
  return { role: "user", content: JSON.stringify(material) + "\n\n" + prompt }
}

/**
 * 构造 Anthropic Messages 请求，保持历史顺序和工具调用配对。
 * @param request 当前统一请求，包括实时上下文和可用工具。
 * @param config 本轮模型的输出上限与推理配置。
 * @returns 共享网关需要的协议、SDK 参数及内联工具 beta 选项。
 * @throws AppError 当上下文、原生回放或推理配置无效时抛出。
 */
export function buildMessagesRequest(request: UnifiedModelRequest, config: ModelConfig): MessagesRequest {
  const history = request.context.history
  let messages: Messages = []
  let system: string
  let definitions: UnifiedToolDefinition[]
  if (history !== undefined) {
    system = history.system
    const built = buildHistory(history, request.tools)
    messages = built.messages
    definitions = built.definitions
  } else {
    const { system: prompt, rest, tools } = splitSystemMessage(request)
    system = prompt
    definitions = tools
    if (request.context.purpose === "summary") messages.push(summaryMessage(rest))
    else for (const message of rest) appendMessage(messages, message, true)
  }
  const params: MessagesRequest["params"] = {
    model: request.model.name,
    max_tokens: config.maxOutputTokens,
    system,
    messages,
    stream: true,
    ...(definitions.length > 0 ? { tools: definitions.map(toTool) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}),
  }
  Object.assign(params, reasoningRequestFragment(request, config))
  if (config.supportsReasoning && params.thinking === undefined) {
    params.thinking = { type: "adaptive", display: "summarized" }
  }
  return { protocol: "anthropic_messages", params, useBeta: messages.some(({ role }) => role === "system") }
}

/** 本次流尚未结束的块及在网络分片间累积的工具输入。 */
interface PendingBlock {
  /** Minou 连续分配的块序号。 */
  index: number
  /** 起始块的原生字段集，增量应用在该副本上。 */
  native: NativeBlock
  /** 工具输入的部分 JSON，到块结束时才解析。 */
  inputJson: string
}

/**
 * 用新事件报告的累计用量覆盖旧值。
 * @param current 之前记录的计数。
 * @param update 最新事件中可用的计数。
 * @returns 按累计口径合并的用量。
 */
function mergeUsage(current: AnthropicUsageFields, update?: AnthropicUsageFields): AnthropicUsageFields {
  if (update === undefined) return current
  const thinkingTokens = update.output_tokens_details?.thinking_tokens ?? current.output_tokens_details?.thinking_tokens
  return {
    input_tokens: update.input_tokens ?? current.input_tokens,
    output_tokens: update.output_tokens ?? current.output_tokens,
    total_tokens: update.total_tokens ?? current.total_tokens,
    cache_read_input_tokens: update.cache_read_input_tokens ?? current.cache_read_input_tokens,
    cache_creation_input_tokens: update.cache_creation_input_tokens ?? current.cache_creation_input_tokens,
    ...(thinkingTokens != null ? { output_tokens_details: { thinking_tokens: thinkingTokens } } : {}),
  }
}

/**
 * 根据协议停止原因和已完成工具调用决定 Runtime 终态。
 * @param reason 服务端最后报告的停止原因。
 * @param hasToolCall 本次响应是否已交付完整工具调用。
 * @returns Runtime 流完成状态。
 */
function completionFor(reason: string, hasToolCall: boolean): ModelCompletion {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "refusal": return "finished"
    case "max_tokens":
    case "model_context_window_exceeded": return "incomplete"
    case "tool_use": return hasToolCall ? "tool_calls" : "unknown"
    default: return "unknown"
  }
}

/**
 * 将已结束的原生块转为统一内容，并保留下次请求使用的完整 JSON。
 * @param pending 由起始事件和后续增量组装的原生内容。
 * @returns 带回放来源的已完成内容。
 * @throws Error 当思考块缺少签名或密文，或工具调用缺少有效的标识与参数时抛出。
 */
function completeBlock({ native, inputJson }: PendingBlock): AssistantContentBlock {
  let block: AssistantContentBlock
  switch (native.type) {
    case "text":
      block = { type: "text", text: native.text }
      break
    case "thinking":
      if (!native.signature) throw streamInterruptedError(REPLAY_SOURCE.protocol)
      block = { type: "thinking", text: native.thinking }
      break
    case "redacted_thinking":
      if (!native.data) throw streamInterruptedError(REPLAY_SOURCE.protocol)
      block = { type: "thinking", text: "" }
      break
    case "tool_use":
      if (inputJson.length > 0) {
        try {
          native.input = JSON.parse(inputJson)
        } catch {
          throw streamInterruptedError(REPLAY_SOURCE.protocol)
        }
      }
      if (!native.id || !native.name || native.input === null || typeof native.input !== "object" || Array.isArray(native.input)) {
        throw streamInterruptedError(REPLAY_SOURCE.protocol)
      }
      block = { type: "tool_call", toolCallId: native.id, name: native.name, arguments: native.input }
      break
  }
  block.replay = { ...REPLAY_SOURCE, payloadJson: JSON.stringify(native) }
  return block
}

/**
 * 消费 Anthropic SDK 的原始流，在每个块结束时交付完整内容。
 * @param events 本次网络尝试的 SDK 原始事件。
 * @returns 可增量消费的块事件及最终停止原因和用量。
 * @throws Error 流被截断、块重复打开或结束块无效时抛出，SDK 异常直接传播给共享流。
 */
export async function* mapMessagesStream(
  events: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  const pending = new Map<number, PendingBlock>()
  let nextIndex = 0
  let hasToolCall = false
  let usage: AnthropicUsageFields = {}
  let stopReason: string | undefined

  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        usage = mergeUsage(usage, event.message.usage)
        break
      case "content_block_start": {
        const block = event.content_block
        if (block.type !== "text" && block.type !== "thinking" && block.type !== "redacted_thinking" && block.type !== "tool_use") break
        if (pending.has(event.index)) throw streamInterruptedError(REPLAY_SOURCE.protocol)
        const index = nextIndex++
        pending.set(event.index, { index, native: structuredClone(block), inputJson: "" })
        const blockType = block.type === "tool_use" ? "tool_call" : block.type === "redacted_thinking" ? "thinking" : block.type
        yield { type: "block_start", index, blockType }
        if (block.type === "tool_use") {
          yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: block.id, nameDelta: block.name } }
        } else if (block.type === "text" && block.text.length > 0) {
          yield { type: "block_delta", index, delta: { type: "text", text: block.text } }
        } else if (block.type === "thinking" && block.thinking.length > 0) {
          yield { type: "block_delta", index, delta: { type: "thinking", text: block.thinking } }
        }
        break
      }
      case "content_block_delta": {
        const block = pending.get(event.index)
        if (block === undefined) break
        const { native, index } = block
        const { delta } = event
        if (native.type === "text" && delta.type === "text_delta") {
          native.text += delta.text
          yield { type: "block_delta", index, delta: { type: "text", text: delta.text } }
        } else if (native.type === "thinking" && delta.type === "thinking_delta") {
          native.thinking += delta.thinking
          if (delta.thinking.length > 0) yield { type: "block_delta", index, delta: { type: "thinking", text: delta.thinking } }
        } else if (native.type === "thinking" && delta.type === "signature_delta") {
          native.signature += delta.signature
        } else if (native.type === "tool_use" && delta.type === "input_json_delta") {
          block.inputJson += delta.partial_json
          yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: native.id, argumentsDelta: delta.partial_json } }
        } else if (native.type === "text" && delta.type === "citations_delta") {
          native.citations ??= []
          native.citations.push(delta.citation)
        }
        break
      }
      case "content_block_stop": {
        const block = pending.get(event.index)
        if (block === undefined) break
        pending.delete(event.index)
        const content = completeBlock(block)
        hasToolCall ||= content.type === "tool_call"
        yield { type: "block_end", index: block.index, block: content }
        break
      }
      case "message_delta":
        usage = mergeUsage(usage, event.usage)
        stopReason = event.delta.stop_reason ?? stopReason
        break
      case "message_stop":
        if (pending.size > 0 || stopReason === undefined) throw streamInterruptedError(REPLAY_SOURCE.protocol)
        yield {
          type: "stream_end",
          completion: completionFor(stopReason, hasToolCall),
          finishReason: stopReason,
          ...(Object.values(usage).some((count) => count != null) ? { usage: convertAnthropicUsage(usage) } : {}),
        }
        return
    }
  }
  throw streamInterruptedError(REPLAY_SOURCE.protocol)
}
