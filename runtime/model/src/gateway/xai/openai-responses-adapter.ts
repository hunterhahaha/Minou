import type OpenAI from "openai"

import {
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "../../shared.ts"
import { convertResponsesUsage } from "../../usage.ts"
import type {
  AssistantBlockDelta, AssistantContentBlock, ModelConfig, ModelStreamEvent, ReplaySource, UnifiedModelRequest,
} from "../../types.ts"

/** 固定回放来源，与本轮 Provider 配置名无关。 */
const REPLAY_SOURCE = { name: "Xai", protocol: "responses" } as const satisfies ReplaySource

/**
 * 检查原生项是否携带可回放的 xAI 推理密文。
 * @param item 来自历史 JSON 或完整 SDK 输出项的值。
 * @returns 类型为 reasoning 且密文字段为非空字符串时返回 true。
 */
function isEncryptedReasoning(item: unknown): item is OpenAI.Responses.ResponseReasoningItem & { encrypted_content: string } {
  if (item === null || typeof item !== "object") return false
  const { type, encrypted_content } = item as Record<string, unknown>
  return type === "reasoning" && typeof encrypted_content === "string" && encrypted_content.length > 0
}

/**
 * 构造携带客户端历史的 xAI Responses 流式请求，原位回传已完成的原生推理项。
 * @param request 本次统一请求，包含会话历史和工具定义。
 * @param config 本轮模型的输出上限和推理参数配置。
 * @returns 交给共享 SDK 网关的 Responses 参数。
 * @throws AppError 当统一上下文或推理配置无效时抛出。
 */
export function buildResponsesRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "system", content: system }]

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
            if (!isEncryptedReasoning(parsed)) continue
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

/** 一个原生输出项对应的块及等待按原生顺序发布的更新。 */
type PendingOutput = {
  itemId?: string
  index?: number
  finished?: boolean
  updates: ({ delta: AssistantBlockDelta } | { block: AssistantContentBlock })[]
} & (
  | { type: "text" | "thinking"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; argumentsJson: string }
)

/**
 * 发布已编号块的更新，并释放已发布的缓冲。
 * @param output 单个原生输出项所对应的统一块状态。
 * @returns 原顺序的增量及至多一个结束事件。
 */
function* flushUpdates(output: PendingOutput): Generator<ModelStreamEvent> {
  if (output.index === undefined) return
  for (const update of output.updates.splice(0)) {
    if ("delta" in update) yield { type: "block_delta", index: output.index, delta: update.delta }
    else yield { type: "block_end", index: output.index, block: update.block }
  }
}

/**
 * 封存完成项。仅从 done 或终态快照读取密文，摘要先展示并等待终态补齐回放。
 * @param output 与该原生项匹配且尚未收尾的统一块。
 * @param item 已完成的原生输出项或终态快照中的项。
 * @param terminal 是否已收到终态，此时可完成只有摘要的思考块。
 * @throws 当完成的函数调用缺少 ID 或名称时抛出。
 */
function finishOutput(output: PendingOutput, item: OpenAI.Responses.ResponseOutputItem, terminal: boolean): void {
  if (output.type === "tool_call") {
    if (item.type !== "function_call" || item.status === "incomplete" || item.status === "in_progress") return
    const toolCallId = item.call_id || output.toolCallId
    const name = item.name || output.name
    if (!toolCallId || !name) throw new Error("xAI Responses 返回了缺少 ID 或名称的工具调用")
    const argumentsJson = item.arguments || output.argumentsJson
    if (!output.name || (!output.argumentsJson && argumentsJson)) {
      output.updates.push({ delta: {
        type: "tool_call", toolCallId,
        ...(!output.name ? { nameDelta: name } : {}),
        ...(!output.argumentsJson && argumentsJson ? { argumentsDelta: argumentsJson } : {}),
      } })
    }
    output.updates.push({ block: { type: "tool_call", toolCallId, name, arguments: parseToolCallArguments(argumentsJson) } })
  } else {
    const finalText = item.type === "reasoning" ? item.summary?.map((part) => part.text).join("")
      : item.type === "message" ? item.content?.map((part) => part.type === "refusal" ? part.refusal : part.text).join("")
      : undefined
    if (!output.text && finalText) output.updates.push({ delta: { type: output.type, text: finalText } })
    output.text = finalText || output.text
    const replay = isEncryptedReasoning(item) ? { ...REPLAY_SOURCE, payloadJson: JSON.stringify(item) } : undefined
    if (output.type === "thinking" && !replay && !terminal) return
    output.updates.push({ block: { type: output.type, text: output.text, ...(replay ? { replay } : {}) } })
  }
  output.finished = true
}

/**
 * 转换一次 xAI Responses 流。原生序号决定输出顺序，项 ID 辅助关联增量、完成事件与快照。
 * @param events 本次网络尝试的 SDK 事件流。
 * @returns 统一块事件与带可用 Usage 的流结束事件。
 * @throws 流失败、缺少终态或完整函数调用缺少身份时抛出。
 */
export async function* mapResponsesStream(
  events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  const outputs = new Map<number, PendingOutput | null>()
  const itemPositions = new Map<string, number>()
  let nextOutputIndex = 0
  let nextBlockIndex = 0
  let terminal: OpenAI.Responses.ResponseCompletedEvent | OpenAI.Responses.ResponseIncompleteEvent | undefined

  /**
   * 查找或登记当前原生输出项。未映射的类型占用原生序号，供后续块连续编号。
   * @param position 事件的 output_index 或快照中的原生序号。
   * @param itemId 原生 item ID，空 ID 只按原生序号关联。
   * @param type 已识别的统一块类型，未知输出类型传 undefined。
   * @returns 匹配且仍可更新的统一块，其他输出项返回 undefined。
   */
  function findOutput(position: number, itemId: string | undefined, type: PendingOutput["type"] | undefined): PendingOutput | undefined {
    if (!type) {
      if (!outputs.has(position)) outputs.set(position, null)
      return undefined
    }
    const knownPosition = itemId ? itemPositions.get(itemId) : undefined
    if (knownPosition !== undefined && knownPosition !== position) return undefined

    let output = outputs.get(position)
    if (output === undefined) {
      output = type === "tool_call"
        ? { type, toolCallId: "", name: "", argumentsJson: "", updates: [] }
        : { type, text: "", updates: [] }
      outputs.set(position, output)
    }
    if (!output || output.finished || output.type !== type || (itemId && output.itemId && output.itemId !== itemId)) return undefined
    if (itemId) {
      output.itemId = itemId
      itemPositions.set(itemId, position)
    }
    return output
  }

  /**
   * 按已知顺序开始一个块。快照发现更早但未推送的项时，后续块仍能保持原生顺序。
   * @param output 当前可编号的原生输出项。
   * @returns 新块的开始事件和所有可发布更新。
   */
  function* publish(output: PendingOutput): Generator<ModelStreamEvent> {
    if (output.index === undefined) {
      output.index = nextBlockIndex++
      yield { type: "block_start", index: output.index, blockType: output.type }
    }
    yield* flushUpdates(output)
  }

  for await (const event of events) {
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      terminal = event
      break
    }
    let output: PendingOutput | undefined
    switch (event.type) {
      case "response.output_item.added":
      case "response.output_item.done": {
        const { item } = event
        output = findOutput(event.output_index, item.id, outputBlockType(item))
        if (!output) break
        if (event.type === "response.output_item.done") {
          finishOutput(output, item, false)
        } else if (item.type === "function_call" && output.type === "tool_call") {
          output.toolCallId = item.call_id
          if (item.name && !output.name) {
            output.name = item.name
            output.updates.push({ delta: { type: "tool_call", toolCallId: item.call_id, nameDelta: item.name } })
          }
          if (item.arguments && !output.argumentsJson) output.argumentsJson = item.arguments
        }
        break
      }
      case "response.output_text.delta":
      case "response.refusal.delta":
      case "response.reasoning_summary_text.delta": {
        const type = event.type === "response.reasoning_summary_text.delta" ? "thinking" : "text"
        output = findOutput(event.output_index, event.item_id, type)
        if (!output || output.type === "tool_call" || !event.delta) break
        output.text += event.delta
        output.updates.push({ delta: { type, text: event.delta } })
        break
      }
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done": {
        output = findOutput(event.output_index, event.item_id, "tool_call")
        if (output?.type !== "tool_call") break
        if (event.type === "response.function_call_arguments.done") output.argumentsJson = event.arguments
        else if (event.delta) {
          output.argumentsJson += event.delta
          if (output.toolCallId) {
            output.updates.push({ delta: { type: "tool_call", toolCallId: output.toolCallId, argumentsDelta: event.delta } })
          }
        }
        break
      }
      case "response.failed":
      case "error":
        throw new Error("xAI Responses 请求失败")
    }

    if (output?.index !== undefined) yield* flushUpdates(output)
    while (outputs.has(nextOutputIndex)) {
      const next = outputs.get(nextOutputIndex++)
      if (next) yield* publish(next)
    }
  }

  if (!terminal) throw streamInterruptedError("responses")
  const { response } = terminal
  if (response.status === "failed" || response.status === "cancelled") throw new Error("xAI Responses 请求失败")
  for (const [index, item] of (response.output ?? []).entries()) {
    const position = (item.id ? itemPositions.get(item.id) : undefined) ?? index
    const output = findOutput(position, item.id, outputBlockType(item))
    if (output) finishOutput(output, item, true)
  }

  let completedCalls = 0
  for (const [, output] of [...outputs.entries()].sort(([a], [b]) => a - b)) {
    if (!output) continue
    if (output.type === "tool_call") {
      if (output.finished) completedCalls += 1
    } else if (!output.finished) {
      output.updates.push({ block: { type: output.type, text: output.text } })
    }
    yield* publish(output)
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

/**
 * 将支持的原生输出项类型映射为统一块类型。
 * @param item SDK 输出项。
 * @returns 能流式展示或交给本地工具执行的块类型。
 */
function outputBlockType(item: OpenAI.Responses.ResponseOutputItem): PendingOutput["type"] | undefined {
  switch (item.type) {
    case "reasoning": return "thinking"
    case "message": return "text"
    case "function_call": return "tool_call"
  }
}
