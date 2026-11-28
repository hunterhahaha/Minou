import OpenAI from "openai"

import {
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "../../shared.ts"
import { convertResponsesUsage } from "../../usage.ts"
import type { ModelConfig, ModelStreamEvent, ReplaySource, UnifiedModelRequest } from "../../types.ts"

/** 原生推理项的回放标记独立于本轮连接使用的 Provider 名称。 */
const REPLAY_SOURCE = { name: "OpenAI", protocol: "responses" } as const satisfies ReplaySource

/**
 * 检查历史或流中的原生项是否携带可回放的密文。
 * @param item 来自 JSON 或 SDK 的原生 OpenAI item。
 * @returns 仅当类型为 reasoning 且密文字段为非空字符串时返回 true。
 */
function isEncryptedReasoningItem(item: unknown): item is OpenAI.Responses.ResponseReasoningItem & { encrypted_content: string } {
  if (item === null || typeof item !== "object") return false
  const { type, encrypted_content } = item as Record<string, unknown>
  return type === "reasoning" && typeof encrypted_content === "string" && encrypted_content.length > 0
}

/**
 * 构造无状态 Responses 流式请求，按历史块顺序交错回传文本、完整推理项和函数调用。
 * @param request 本次统一请求，包含历史和工具定义。
 * @param config 本轮模型的推理字段与输出上限。
 * @returns Responses SDK 的流式参数。
 * @throws AppError 当统一上下文或推理配置无效时抛出。
 */
export function buildResponsesRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const input: OpenAI.Responses.ResponseInputItem[] = []

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content.length > 0) input.push({ role: "user", content })
    } else if (message.role === "assistant") {
      let text = ""
      for (const block of message.content) {
        if (block.type === "text") {
          text += block.text
          continue
        }

        let item: OpenAI.Responses.ResponseReasoningItem | OpenAI.Responses.ResponseFunctionToolCall
        if (block.type === "thinking") {
          const { replay } = block
          if (replay?.name !== REPLAY_SOURCE.name || replay.protocol !== REPLAY_SOURCE.protocol) continue
          try {
            const parsed: unknown = JSON.parse(replay.payloadJson)
            if (!isEncryptedReasoningItem(parsed)) continue
            item = parsed
          } catch {
            continue
          }
        } else {
          item = {
            type: "function_call", call_id: block.toolCallId, name: block.name,
            arguments: serializeToolCallArguments(block.arguments),
          }
        }

        if (text.length > 0) input.push({ role: "assistant", content: text })
        text = ""
        input.push(item)
      }
      if (text.length > 0) input.push({ role: "assistant", content: text })
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: joinTextBlocks(message.content) })
    }
  }

  const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
    model: request.model.name,
    instructions: system,
    input,
    stream: true,
    store: false,
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({
      type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false,
    })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
  }
  return Object.assign(params, reasoningRequestFragment(request, config), { max_output_tokens: config.maxOutputTokens })
}

/** 一个原生 output item 当前累积的统一块，密文只在最终 item 到达时读取。 */
type PendingBlock =
  | { index: number; type: "text" | "thinking"; text: string }
  | { index: number; type: "tool_call"; toolCallId: string; argumentsJson: string }

/**
 * 读取 SDK 事件并清理上游 API 错误中可能回显的密文，同时保留 HTTP 状态供共享重试判断。
 * @param events 本次网络尝试的原始 SDK 流。
 * @returns 原样转交成功解码的事件。
 * @throws APIError API 拒绝请求时抛出仅含安全文字与状态的错误；传输异常和取消由共享入口处理。
 */
async function* readResponseEvents(
  events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
  try {
    yield* events
  } catch (error) {
    if (error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIUserAbortError)) {
      throw new OpenAI.APIError(error.status, undefined, "OpenAI Responses 请求失败", undefined)
    }
    throw error
  }
}

/**
 * 将 OpenAI Responses 流转换成文本、推理和工具块，原生推理项仅在 item done 时封存。
 * @param events 本次尝试的 SDK 事件流。
 * @returns 包含统一块事件与最终 Usage 的异步生成器。
 * @throws 流报告失败、工具调用缺少标识、或流在收到终态前中断时抛出。
 */
export async function* mapResponsesStream(
  events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  const pending = new Map<string, PendingBlock>()
  let nextIndex = 0
  let completedCalls = 0
  let terminal: OpenAI.Responses.ResponseCompletedEvent | OpenAI.Responses.ResponseIncompleteEvent | undefined

  for await (const event of readResponseEvents(events)) {
    switch (event.type) {
      case "response.output_item.added": {
        const { item } = event
        if (item.type === "reasoning" || item.type === "message") {
          const type = item.type === "reasoning" ? "thinking" : "text"
          const index = nextIndex++
          pending.set(item.id, { index, type, text: "" })
          yield { type: "block_start", index, blockType: type }
        } else if (item.type === "function_call") {
          const index = nextIndex++
          pending.set(item.id ?? item.call_id, { index, type: "tool_call", toolCallId: item.call_id, argumentsJson: item.arguments })
          yield { type: "block_start", index, blockType: "tool_call" }
          yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: item.call_id, nameDelta: item.name } }
        }
        break
      }
      case "response.output_text.delta":
      case "response.refusal.delta":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const block = pending.get(event.item_id)
        const type = event.type === "response.output_text.delta" || event.type === "response.refusal.delta" ? "text" : "thinking"
        if (block?.type !== type || !event.delta) break
        block.text += event.delta
        yield { type: "block_delta", index: block.index, delta: { type, text: event.delta } }
        break
      }
      case "response.function_call_arguments.delta": {
        const block = pending.get(event.item_id)
        if (block?.type !== "tool_call" || !event.delta) break
        block.argumentsJson += event.delta
        yield { type: "block_delta", index: block.index, delta: {
          type: "tool_call", toolCallId: block.toolCallId, argumentsDelta: event.delta,
        } }
        break
      }
      case "response.function_call_arguments.done": {
        const block = pending.get(event.item_id)
        if (block?.type === "tool_call") block.argumentsJson = event.arguments
        break
      }
      case "response.output_item.done": {
        const { item } = event
        if (item.type === "function_call") {
          const key = item.id ?? item.call_id
          const block = pending.get(key)
          pending.delete(key)
          if (block?.type !== "tool_call" || item.status === "incomplete") break
          if (!item.call_id || !item.name) throw new Error("OpenAI Responses 返回了缺少 ID 或名称的工具调用")
          completedCalls += 1
          yield { type: "block_end", index: block.index, block: {
            type: "tool_call", toolCallId: item.call_id, name: item.name,
            arguments: parseToolCallArguments(item.arguments || block.argumentsJson),
          } }
        } else if (item.type === "reasoning" || item.type === "message") {
          const previous = pending.get(item.id)
          pending.delete(item.id)
          const type = item.type === "reasoning" ? "thinking" : "text"
          const received = previous?.type === type ? previous.text : ""
          const index = previous?.index ?? nextIndex++
          if (previous === undefined) yield { type: "block_start", index, blockType: type }

          const finalText = item.type === "reasoning"
            ? item.summary?.map((part) => part.text).join("") || item.content?.map((part) => part.text).join("")
            : item.content.map((part) => part.type === "refusal" ? part.refusal : part.text).join("")
          const text = finalText || received
          if (!received && text) yield { type: "block_delta", index, delta: { type, text } }
          yield { type: "block_end", index, block: {
            type, text,
            ...(isEncryptedReasoningItem(item) ? { replay: { ...REPLAY_SOURCE, payloadJson: JSON.stringify(item) } } : {}),
          } }
        }
        break
      }
      case "response.completed":
      case "response.incomplete":
        terminal = event
        break
      case "response.failed":
      case "error":
        throw new Error("OpenAI Responses 请求失败")
    }
  }

  if (!terminal) throw streamInterruptedError("responses")
  const { response } = terminal
  if (response.status === "failed" || response.status === "cancelled") throw new Error("OpenAI Responses 请求失败")
  for (const block of pending.values()) {
    if (block.type !== "tool_call") yield { type: "block_end", index: block.index, block: { type: block.type, text: block.text } }
  }

  const incomplete = terminal.type === "response.incomplete" || response.status === "incomplete"
  const finishReason = response.incomplete_details?.reason ?? response.status
  yield {
    type: "stream_end",
    completion: incomplete ? "incomplete" : completedCalls > 0 ? "tool_calls" : "finished",
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(response.usage ? { usage: convertResponsesUsage(response.usage) } : {}),
  }
}
