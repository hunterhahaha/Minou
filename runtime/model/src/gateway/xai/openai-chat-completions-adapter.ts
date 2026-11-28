import type OpenAI from "openai"

import {
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "../../shared.ts"
import { convertChatCompletionsUsage, type ChatCompletionsUsageFields } from "../../usage.ts"
import type { ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest, Usage } from "../../types.ts"

/**
 * 构造 xAI Chat Completions 流式请求。历史保留文本与工具调用，思考只供展示。
 * @param request 本次统一请求，包含会话历史和工具定义。
 * @param config 本轮模型的输出上限和推理参数配置。
 * @returns 交给共享 SDK 网关的 Chat Completions 参数。
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
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
  }
  return Object.assign(params, reasoningRequestFragment(request, config), { max_tokens: config.maxOutputTokens })
}

/** 当前连续的文本或可读思考及其统一索引。 */
type PendingText = { index: number; type: "text" | "thinking"; text: string }

/** 按协议工具序号拼装的函数调用，统一索引在首次接收分片时分配。 */
type PendingCall = { index: number; toolCallId: string; name: string; argumentsJson: string }

/**
 * 按 xAI 口径把单列的推理用量计入输出，再交给共享逻辑扣除缓存并校验总量。
 * @param fields 最后一次收到的有效 Usage，可能来自无 choice 的尾部 chunk。
 * @returns 推理用量属于输出子集的统一 Usage。
 */
function convertXaiUsage(fields: ChatCompletionsUsageFields): Usage {
  const reasoningTokens = fields.completion_tokens_details?.reasoning_tokens
  if (typeof reasoningTokens !== "number") return convertChatCompletionsUsage(fields)

  const completionTokens = fields.completion_tokens ?? 0
  /** 兼容端点若明确用完整总量表明输出已含推理，则复用其输出计数。 */
  const alreadyIncluded = typeof fields.prompt_tokens === "number" && typeof fields.completion_tokens === "number" &&
    fields.total_tokens === fields.prompt_tokens + completionTokens
  return convertChatCompletionsUsage({
    ...fields,
    completion_tokens: alreadyIncluded ? completionTokens : completionTokens + reasoningTokens,
  })
}

/**
 * 映射原始结束原因，只有完整的函数调用可以进入工具执行。
 * @param reason 首个 choice 上收到的结束原因。
 * @param callCount 已拼装的工具调用数量。
 * @returns Runtime 使用的统一完成状态。
 */
function completionFor(reason: string, callCount: number): ModelCompletion {
  switch (reason) {
    case "stop": return "finished"
    case "function_call":
    case "tool_calls": return callCount > 0 ? "tool_calls" : "unknown"
    case "length":
    case "content_filter": return "incomplete"
    default: return "unknown"
  }
}

/**
 * 把 xAI Chat Completions SDK 流转换为文本、可读思考、工具调用和最终 Usage。
 * @param chunks 本次网络尝试的原始 SDK chunk 流。
 * @returns 依照分片顺序产生的统一块事件和流结束事件。
 * @throws 流缺少结束原因，或已完成的工具调用缺少 ID 或名称时抛出。
 */
export async function* mapChatCompletionsStream(
  chunks: AsyncIterable<OpenAI.ChatCompletionChunk>,
): AsyncGenerator<ModelStreamEvent> {
  const calls = new Map<number, PendingCall>()
  let nextIndex = 0
  let activeText: PendingText | undefined
  let finishReason: string | undefined
  let usage: ChatCompletionsUsageFields | undefined

  for await (const chunk of chunks) {
    const reported = chunk.usage
    if (reported && (reported.prompt_tokens != null || reported.completion_tokens != null || reported.total_tokens != null ||
      reported.completion_tokens_details?.reasoning_tokens != null)) usage = reported
    const choice = chunk.choices[0]
    if (!choice) continue
    if (choice.finish_reason != null) finishReason = choice.finish_reason

    const delta: OpenAI.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null } = choice.delta
    const parts = [
      ["thinking", typeof delta.reasoning_content === "string" ? delta.reasoning_content : ""],
      ["text", (delta.content ?? "") + (delta.refusal ?? "")],
    ] as const
    for (const [type, text] of parts) {
      if (text.length === 0) continue
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

    if (delta.tool_calls?.length && activeText) {
      yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
      activeText = undefined
    }
    for (const fragment of delta.tool_calls ?? []) {
      let call = calls.get(fragment.index)
      if (!call) {
        call = { index: nextIndex++, toolCallId: "", name: "", argumentsJson: "" }
        calls.set(fragment.index, call)
        yield { type: "block_start", index: call.index, blockType: "tool_call" }
      }
      if (fragment.id) call.toolCallId = fragment.id
      const { name: nameDelta, arguments: argumentsDelta } = fragment.function ?? {}
      if (!nameDelta && !argumentsDelta) continue
      call.name += nameDelta ?? ""
      call.argumentsJson += argumentsDelta ?? ""
      yield { type: "block_delta", index: call.index, delta: {
        type: "tool_call", toolCallId: call.toolCallId,
        ...(nameDelta ? { nameDelta } : {}), ...(argumentsDelta ? { argumentsDelta } : {}),
      } }
    }
  }

  if (finishReason === undefined) throw streamInterruptedError("chat_completions")
  if (activeText) yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
  const completion = completionFor(finishReason, calls.size)
  if (completion === "tool_calls") {
    for (const call of calls.values()) {
      if (!call.toolCallId || !call.name) throw new Error("xAI Chat Completions 返回了缺少 ID 或名称的工具调用")
      yield { type: "block_end", index: call.index, block: {
        type: "tool_call", toolCallId: call.toolCallId, name: call.name, arguments: parseToolCallArguments(call.argumentsJson),
      } }
    }
  }
  yield {
    type: "stream_end", completion, finishReason,
    ...(usage ? { usage: convertXaiUsage(usage) } : {}),
  }
}
