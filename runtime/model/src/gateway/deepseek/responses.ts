import type OpenAI from "openai"

import { joinTextBlocks, parseToolCallArguments, reasoningRequestFragment, serializeToolCallArguments, splitSystemMessage, streamInterruptedError } from "../../shared.ts"
import { convertResponsesUsage } from "../../usage.ts"
import type { ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../../types.ts"

/**
 * 构造 DeepSeek 无状态 Responses 请求，将普通历史的明文思考归入相邻 assistant。
 * @param request 本次模型引用、上下文与工具定义。
 * @param config 本轮模型输出上限与推理配置。
 * @param disableThinking 为 true 时显式发送 `reasoning.effort: none`。
 * @returns 可由 OpenAI SDK 发送的请求体。
 * @throws AppError 当上下文或推理配置无效时抛出。
 */
export function buildResponsesRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
  disableThinking: boolean,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const input: OpenAI.Responses.ResponseInput = []

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content.length > 0) input.push({ role: "user", content })
    } else if (message.role === "assistant") {
      if (request.context.purpose !== "summary") {
        const content = message.content.flatMap((block) => block.type === "thinking" && block.text.length > 0
          ? [{ type: "reasoning_text" as const, text: block.text }] : [])
        if (content.length > 0) {
          /** DeepSeek 的 reasoning 输入允许省略 SDK 输出类型要求的 id 和 summary。 */
          input.push({ type: "reasoning", content } as OpenAI.Responses.ResponseReasoningItem)
        }
      }
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("")
      if (text.length > 0) input.push({ role: "assistant", content: text })

      for (const block of message.content) {
        if (block.type !== "tool_call") continue
        input.push({ type: "function_call", call_id: block.toolCallId, name: block.name,
          arguments: serializeToolCallArguments(block.arguments) })
      }
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: joinTextBlocks(message.content) })
    }
  }

  const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
    model: request.model.name,
    instructions: system,
    input,
    stream: true,
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function" as const, name: tool.name,
      description: tool.description, parameters: tool.inputSchema, strict: false })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" as const } : {}),
  }
  Object.assign(params, reasoningRequestFragment(request, config), { max_output_tokens: config.maxOutputTokens })
  if (disableThinking) params.reasoning = { ...params.reasoning, effort: "none" }
  return params
}

/** 与原生 output item 对应的 Runtime 块，由 item id 或客户端工具的 call_id 定位。 */
type PendingItem =
  | { index: number; type: "thinking" | "text"; text: string }
  | { index: number; type: "tool_call"; toolCallId: string; name: string; argumentsJson: string }

/**
 * 解析 DeepSeek Responses 事件。正文和思考按 item 增量聚合，工具须收到 item 完成事件才交付。
 * @param events 本次尝试的 OpenAI Responses SDK 流。
 * @returns 统一块事件及终态携带的完成原因和用量。
 * @throws 当响应报告错误、在终态前断流或返回缺少 ID 或名称的完整调用时抛出。
 */
export async function* mapResponsesStream(
  events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  const pending = new Map<string, PendingItem>()
  let nextIndex = 0
  let completedCalls = 0

  /**
   * 查找参数事件对应的工具块，兼容事件用 call_id 标识工具块的情况。
   * @param id 参数事件提供的 item_id 或 call_id。
   * @returns 对应工具块，无法配对时返回 undefined。
   */
  function findCall(id: string): Extract<PendingItem, { type: "tool_call" }> | undefined {
    const item = pending.get(id)
    if (item?.type === "tool_call") return item
    for (const candidate of pending.values()) {
      if (candidate.type === "tool_call" && candidate.toolCallId === id) return candidate
    }
    return undefined
  }

  for await (const event of events) {
    switch (event.type) {
      case "response.output_item.added": {
        const { item } = event
        if (item.type === "function_call") {
          const index = nextIndex++
          pending.set(item.id ?? item.call_id, { index, type: "tool_call", toolCallId: item.call_id,
            name: item.name, argumentsJson: item.arguments ?? "" })
          yield { type: "block_start", index, blockType: "tool_call" }
          yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: item.call_id, nameDelta: item.name } }
        } else if (item.type === "reasoning" || item.type === "message") {
          const blockType = item.type === "reasoning" ? "thinking" : "text"
          const index = nextIndex++
          pending.set(item.id, { index, type: blockType, text: "" })
          yield { type: "block_start", index, blockType }
        }
        break
      }
      case "response.output_text.delta":
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const block = pending.get(event.item_id)
        const type = event.type === "response.output_text.delta" ? "text" : "thinking"
        if (block?.type !== type || event.delta.length === 0) break
        block.text += event.delta
        yield { type: "block_delta", index: block.index, delta: { type, text: event.delta } }
        break
      }
      case "response.function_call_arguments.delta": {
        const call = findCall(event.item_id)
        if (!call || event.delta.length === 0) break
        call.argumentsJson += event.delta
        yield { type: "block_delta", index: call.index, delta: {
          type: "tool_call", toolCallId: call.toolCallId, argumentsDelta: event.delta,
        } }
        break
      }
      case "response.function_call_arguments.done": {
        const call = findCall(event.item_id)
        if (call) call.argumentsJson = event.arguments
        break
      }
      case "response.output_item.done": {
        const { item } = event
        if (item.type === "function_call") {
          const key = item.id ?? item.call_id
          const call = pending.get(key)
          if (call?.type !== "tool_call") break
          pending.delete(key)
          if (item.status === "incomplete") break
          if (!call.toolCallId || !call.name) throw new Error("DeepSeek Responses 返回了缺少 ID 或名称的工具调用")
          completedCalls += 1
          yield { type: "block_end", index: call.index, block: {
            type: "tool_call", toolCallId: call.toolCallId, name: call.name,
            arguments: parseToolCallArguments(item.arguments || call.argumentsJson),
          } }
        } else if (item.type === "reasoning" || item.type === "message") {
          const block = pending.get(item.id)
          if (!block || block.type === "tool_call") break
          pending.delete(item.id)
          if (block.text.length === 0 && item.type === "reasoning") {
            const parts = item.content?.length ? item.content : item.summary
            block.text = parts?.map((part) => part.text).join("") ?? ""
            if (block.text.length > 0) yield { type: "block_delta", index: block.index, delta: { type: "thinking", text: block.text } }
          }
          yield { type: "block_end", index: block.index, block: { type: block.type, text: block.text } }
        }
        break
      }
      case "response.completed":
      case "response.incomplete": {
        const { response } = event
        for (const block of pending.values()) {
          if (block.type !== "tool_call") yield { type: "block_end", index: block.index, block: { type: block.type, text: block.text } }
        }
        let completion: ModelCompletion = "unknown"
        if (event.type === "response.incomplete" || response.status === "incomplete") {
          completion = "incomplete"
        } else if (response.status === "completed") {
          const hasCall = completedCalls > 0 || response.output.some((item) => item.type === "function_call")
          completion = hasCall ? "tool_calls" : "finished"
        }
        const finishReason = response.incomplete_details?.reason ?? response.status
        yield {
          type: "stream_end",
          completion,
          ...(finishReason !== undefined ? { finishReason } : {}),
          ...(response.usage ? { usage: convertResponsesUsage(response.usage) } : {}),
        }
        return
      }
      case "response.failed": {
        const error = event.response.error
        throw new Error(error ? `${error.code}: ${error.message}` : "DeepSeek Responses 请求失败")
      }
      case "error":
        throw new Error(event.message)
    }
  }
  throw streamInterruptedError("responses")
}
