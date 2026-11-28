import OpenAI from "openai"

import {
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "../../shared.ts"
import type { AssistantContentBlock, BlockReplay, ModelCompletion, ModelConfig, ModelStreamEvent, ReplaySource, UnifiedModelRequest } from "../../types.ts"
import { convertChatCompletionsUsage } from "../../usage.ts"
import type { ChatCompletionsUsageFields } from "../../usage.ts"

/** 所有 Gemini Chat Completions 签名回放的固定来源。 */
const REPLAY_SOURCE = { name: "Gemini", protocol: "chat_completions" } satisfies ReplaySource

/** Gemini 写在原生消息或工具调用上的扩展字段。 */
type ExtraContent = { extra_content?: Record<string, unknown> }

/** 带 Gemini 扩展字段的原生函数调用。 */
type NativeToolCall = OpenAI.ChatCompletionMessageFunctionToolCall & ExtraContent

/** 带 Gemini 扩展字段的原生 assistant 消息。 */
type NativeAssistantMessage = OpenAI.ChatCompletionAssistantMessageParam & ExtraContent

/**
 * @param value 待校验的 SDK 或历史 JSON 值。
 * @returns 是否为可读取字段的 JSON 对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * @param value 消息或调用的原生 `extra_content`。
 * @returns 含非空签名的完整扩展对象，签名以收到的字符串为准。
 */
function signedExtraContent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.google)) return undefined
  const signature = value.google.thought_signature
  return typeof signature === "string" && signature.length > 0 ? value : undefined
}

/**
 * @param value 候选原生工具调用。
 * @returns 是否具备函数调用的 ID、名称与原始参数字符串。
 */
function isNativeToolCall(value: unknown): value is NativeToolCall {
  return isRecord(value) && value.type === "function" && typeof value.id === "string" && value.id.length > 0 &&
    isRecord(value.function) && typeof value.function.name === "string" && value.function.name.length > 0 &&
    typeof value.function.arguments === "string"
}

/**
 * @param value 候选原生 assistant 消息。
 * @returns 消息角色、文本、拒答和工具调用字段是否符合回放形状。
 */
function isNativeAssistantMessage(value: Record<string, unknown>): value is NativeAssistantMessage & Record<string, unknown> {
  const { role, content, refusal, tool_calls: calls } = value
  return role === "assistant" && (content == null || typeof content === "string" ||
    (Array.isArray(content) && content.every((part: unknown) => isRecord(part) &&
      ((part.type === "text" && typeof part.text === "string") ||
       (part.type === "refusal" && typeof part.refusal === "string"))))) &&
    (refusal == null || typeof refusal === "string") &&
    (calls === undefined || (Array.isArray(calls) && calls.every(isNativeToolCall)))
}

/**
 * @param replay 历史块携带的原生回放数据。
 * @returns 本协议带签名的 JSON 对象，供调用方继续校验消息或工具调用形状。
 */
function readReplay(replay: BlockReplay | undefined): Record<string, unknown> | undefined {
  if (replay?.name !== REPLAY_SOURCE.name || replay.protocol !== REPLAY_SOURCE.protocol) return undefined
  try {
    const value: unknown = JSON.parse(replay.payloadJson)
    if (isRecord(value) && signedExtraContent(value.extra_content)) return value
  } catch {
    /** JSON 损坏时由统一内容块构造请求。 */
  }
  return undefined
}

/**
 * 从历史块恢复一条消息，工具调用数组始终按当前内容块顺序组装。
 * @param blocks 同一条 assistant 消息的历史内容块。
 * @returns Chat Completions assistant 消息，空白内容且无签名时省略。
 */
function buildAssistantMessage(blocks: AssistantContentBlock[]): NativeAssistantMessage | undefined {
  let nativeMessage: NativeAssistantMessage | undefined
  let text = ""
  const toolCalls: NativeToolCall[] = []
  for (const block of blocks) {
    const replay = readReplay(block.replay)
    if (!nativeMessage && replay && isNativeAssistantMessage(replay)) nativeMessage = replay
    if (block.type === "text") text += block.text
    if (block.type !== "tool_call") continue
    if (replay && isNativeToolCall(replay) && replay.id === block.toolCallId) {
      const { index: _index, ...toolCall } = replay
      toolCalls.push(toolCall)
    } else {
      toolCalls.push({
        type: "function", id: block.toolCallId,
        function: { name: block.name, arguments: serializeToolCallArguments(block.arguments) },
      })
    }
  }

  if (!nativeMessage && !text && toolCalls.length === 0) return undefined
  const message = nativeMessage ? { ...nativeMessage } : { role: "assistant" as const, content: text || null }
  delete message.tool_calls
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return message
}

/**
 * 映射 Gemini Chat Completions 的历史、工具定义和模型配置。
 * @param request 本次统一请求，包含会话上下文和工具定义。
 * @param config 本轮模型的推理设置和输出上限。
 * @returns OpenAI SDK 的 Gemini 流式请求参数。
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
      if (content.length > 0) messages.push({ role: "user", content })
    } else if (message.role === "assistant") {
      const assistant = buildAssistantMessage(message.content)
      if (assistant) messages.push(assistant)
    } else if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: joinTextBlocks(message.content) })
    }
  }

  const params: OpenAI.ChatCompletionCreateParamsStreaming = {
    model: request.model.name,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: config.maxOutputTokens,
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
  }
  return Object.assign(params, reasoningRequestFragment(request, config))
}

/** 单次流内的工具块序号、协议索引与已收到的原生字段。 */
interface PendingToolCall {
  index: number
  providerIndex: number | undefined
  native: NativeToolCall
}

/** SDK delta 的 Gemini 扩展。签名分片可以只携带工具 ID 或协议索引。 */
type ChoiceDelta = Omit<OpenAI.ChatCompletionChunk.Choice.Delta, "tool_calls"> & ExtraContent & {
  tool_calls?: Array<Partial<OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall> & ExtraContent>
}

/**
 * @param native 已完整收到的 Gemini 消息或工具调用。
 * @returns 附在统一块上的固定来源和原生 JSON。
 */
function makeReplay(native: NativeAssistantMessage | NativeToolCall): BlockReplay {
  return { ...REPLAY_SOURCE, payloadJson: JSON.stringify(native) }
}

/**
 * @param reason 所选 choice 的原始结束原因。
 * @param callCount 已完整组装的工具调用数。
 * @returns Runtime 的统一完成状态。
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
 * 转发 SDK 事件，避免上游错误回显请求或响应中的签名。
 * @param chunks 本次网络尝试的原始 SDK 分片。
 * @returns 原始成功分片。
 * @throws APIError 上游拒绝请求时仅传递安全的错误文字和用于重试的 HTTP 状态；连接及取消异常原样传播。
 */
async function* readResponseChunks(chunks: AsyncIterable<OpenAI.ChatCompletionChunk>): AsyncGenerator<OpenAI.ChatCompletionChunk> {
  try {
    yield* chunks
  } catch (error) {
    if (error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIUserAbortError)) {
      throw new OpenAI.APIError(error.status, undefined, "Gemini Chat Completions 请求失败", undefined)
    }
    throw error
  }
}

/**
 * 增量交付可读内容，流正常结束且收到 choice 的结束原因后才交付带签名的完整块。
 * @param chunks 单次尝试的 SDK 流。统一请求使用 Chat Completions 默认的单 choice。
 * @returns 按块首次出现顺序分配索引的统一事件流。
 * @throws 流中断、SDK 报错或工具调用身份冲突或缺失时抛出。
 */
export async function* mapChatCompletionsStream(
  chunks: AsyncIterable<OpenAI.ChatCompletionChunk>,
): AsyncGenerator<ModelStreamEvent> {
  const calls: PendingToolCall[] = []
  const nativeMessage: NativeAssistantMessage = { role: "assistant" }
  let nextIndex = 0
  let textIndex: number | undefined
  let text = ""
  let finishReason: string | undefined
  let usage: ChatCompletionsUsageFields | undefined

  for await (const chunk of readResponseChunks(chunks)) {
    if (chunk.usage != null) usage = chunk.usage
    const choice = chunk.choices.find(({ index }) => index === 0)
    if (!choice || finishReason !== undefined) continue
    const delta: ChoiceDelta = choice.delta ?? {}
    const extraContent = signedExtraContent(delta.extra_content)
    if (extraContent) nativeMessage.extra_content = extraContent

    if (typeof delta.content === "string") nativeMessage.content = (nativeMessage.content ?? "") + delta.content
    if (typeof delta.refusal === "string") nativeMessage.refusal = (nativeMessage.refusal ?? "") + delta.refusal
    const textDelta = (delta.content ?? "") + (delta.refusal ?? "")
    if (textDelta) {
      if (textIndex === undefined) {
        textIndex = nextIndex++
        yield { type: "block_start", index: textIndex, blockType: "text" }
      }
      text += textDelta
      yield { type: "block_delta", index: textIndex, delta: { type: "text", text: textDelta } }
    }

    for (const toolDelta of delta.tool_calls ?? []) {
      const { index, id } = toolDelta
      const providerIndex = typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : undefined
      if (providerIndex === undefined && !id) continue
      const byIndex = providerIndex === undefined ? undefined : calls.find((call) => call.providerIndex === providerIndex)
      const byId = id ? calls.find((call) => call.native.id === id) : undefined
      let call = byIndex ?? byId
      if ((byIndex && byId && byIndex !== byId) ||
          (id && call?.native.id && call.native.id !== id) ||
          (providerIndex !== undefined && call?.providerIndex !== undefined && call.providerIndex !== providerIndex)) {
        throw new Error("Gemini Chat Completions 返回了关联冲突的工具调用")
      }
      if (!call) {
        call = { index: nextIndex++, providerIndex, native: { type: "function", id: "", function: { name: "", arguments: "" } } }
        calls.push(call)
        yield { type: "block_start", index: call.index, blockType: "tool_call" }
      }
      call.providerIndex ??= providerIndex
      if (id) call.native.id = id
      const toolExtraContent = signedExtraContent(toolDelta.extra_content)
      if (toolExtraContent) call.native.extra_content = toolExtraContent

      const { name: nameDelta, arguments: argumentsDelta } = toolDelta.function ?? {}
      if (nameDelta) call.native.function.name += nameDelta
      if (argumentsDelta) call.native.function.arguments += argumentsDelta
      if (nameDelta || argumentsDelta) {
        yield { type: "block_delta", index: call.index, delta: {
          type: "tool_call", toolCallId: call.native.id, nameDelta, argumentsDelta,
        } }
      }
    }

    if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) finishReason = choice.finish_reason
  }

  if (finishReason === undefined) throw streamInterruptedError(REPLAY_SOURCE.protocol)

  const completedCalls = finishReason === "tool_calls" ? calls : []
  if (completedCalls.some(({ native }) => !native.id || !native.function.name)) {
    throw new Error("Gemini Chat Completions 返回了缺少 ID 或名称的工具调用")
  }
  if (completedCalls.length > 0) nativeMessage.tool_calls = completedCalls.map(({ native }) => native)
  if (nativeMessage.content === undefined) nativeMessage.content = completedCalls.length > 0 ? null : ""
  const replay = nativeMessage.extra_content ? makeReplay(nativeMessage) : undefined
  if (textIndex !== undefined) {
    yield { type: "block_end", index: textIndex, block: { type: "text", text, ...(replay ? { replay } : {}) } }
  } else if (replay) {
    const index = nextIndex++
    yield { type: "block_start", index, blockType: "thinking" }
    yield { type: "block_end", index, block: { type: "thinking", text: "", replay } }
  }
  for (const { index, native } of completedCalls) {
    yield { type: "block_end", index, block: {
      type: "tool_call", toolCallId: native.id, name: native.function.name,
      arguments: parseToolCallArguments(native.function.arguments),
      ...(native.extra_content ? { replay: makeReplay(native) } : {}),
    } }
  }
  yield {
    type: "stream_end", completion: completionFor(finishReason, completedCalls.length), finishReason,
    ...(usage && (usage.prompt_tokens != null || usage.completion_tokens != null || usage.total_tokens != null)
      ? { usage: convertChatCompletionsUsage(usage) } : {}),
  }
}
