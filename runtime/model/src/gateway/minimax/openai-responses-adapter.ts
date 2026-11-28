import type OpenAI from "openai"

import {
  invalidRequest, joinTextBlocks, parseToolCallArguments, reasoningRequestFragment, serializeToolCallArguments,
  splitSystemMessage, streamInterruptedError,
} from "../../shared.ts"
import { convertResponsesUsage } from "../../usage.ts"
import type { ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../../types.ts"

/**
 * 将本地会话投影成 MiniMax Responses 输入，保留正文、思考和工具调用的相对顺序。
 * @param request 统一模型请求、历史及工具定义。
 * @param config 本轮模型的输出上限及可选推理档位。
 * @returns 以完整本地历史续接的流式 Responses 请求。
 * @throws 统一上下文、推理配置或所选档位无效时抛出。
 */
export function buildResponsesRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const input: OpenAI.Responses.ResponseInput = []

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content !== "") input.push({ role: "user", content })
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            if (block.text !== "") input.push({ role: "assistant", content: block.text })
            break
          case "thinking":
            if (block.text !== "") {
              /** MiniMax 的历史 reasoning 输入可省略 SDK 输出类型要求的 id。 */
              input.push({
                type: "reasoning", summary: [{ type: "summary_text", text: block.text }],
              } as OpenAI.Responses.ResponseReasoningItem)
            }
            break
          case "tool_call":
            input.push({
              type: "function_call", call_id: block.toolCallId, name: block.name,
              arguments: serializeToolCallArguments(block.arguments),
            })
            break
        }
      }
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: joinTextBlocks(message.content) })
    }
  }

  const model = config.name.toLowerCase()
  const { reasoningLevel } = request.model
  const effortLevels = ["low", "medium", "high", "xhigh", "max"]
  if (config.supportsReasoning &&
      ((model === "minimax-m3.1-flash" && !effortLevels.includes(reasoningLevel)) ||
       (model === "minimax-m3" && ![...effortLevels, "minimal", "none"].includes(reasoningLevel)))) {
    throw invalidRequest("当前推理等级不受 MiniMax Responses 模型支持", { reasoningLevel })
  }
  const reasoning = reasoningRequestFragment(request, { ...config, reasoningField: { path: ["reasoning", "effort"] } })
  const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
    ...reasoning,
    model: request.model.name,
    instructions: system,
    input,
    stream: true,
    max_output_tokens: config.maxOutputTokens,
  }
  /** MiniMax Responses 的 tool_choice 只支持 auto；省略工具定义即可禁用工具。 */
  if (request.toolChoice !== "none" && tools.length > 0) {
    params.tools = tools.map((tool) => ({
      type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false,
    }))
  }
  return params
}

/** 按 output_index 保存的文本状态，itemId 用于核对分片身份。 */
type PendingText = { type: "thinking" | "text"; itemId?: string; index?: number; text: string }

/** 按 output_index 保存的工具调用状态，分别记录响应 item ID 和工具调用 ID。 */
type PendingCall = { type: "tool_call"; itemId?: string; index?: number; toolCallId: string; name: string; argumentsJson: string }

/**
 * 消费 MiniMax Responses 流，分别拼装各 output item 并用终态交付 Usage。
 * @param events 本次网络尝试的 OpenAI SDK 流。
 * @returns 每个非空思考 item 对应的独立内容块、其他内容块及流结束事件。
 * @throws 上游失败、终态之前断流或同一输出位置的 item 身份不一致时抛出。
 */
export async function* mapResponsesStream(
  events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  const pending = new Map<number, PendingText | PendingCall>()
  const finished = new Set<number>()
  let nextIndex = 0
  let completedCalls = 0

  /**
   * 按协议输出位置取出分片状态，并核对事件携带的 item ID 和类型。
   * @param outputIndex SDK 事件的输出位置。
   * @param state 首次见到该 item 时使用的状态，以及当前事件提供的身份。
   * @returns 该 output item 的累积状态。
   * @throws 同一输出位置出现冲突的 item ID 或类型时抛出。
   */
  function track(outputIndex: number, state: PendingText): PendingText
  function track(outputIndex: number, state: PendingCall): PendingCall
  function track(outputIndex: number, state: PendingText | PendingCall): PendingText | PendingCall {
    const current = pending.get(outputIndex)
    if (!current) {
      pending.set(outputIndex, state)
      return state
    }
    if (current.type !== state.type || (current.itemId && state.itemId && current.itemId !== state.itemId)) {
      throw new Error("MiniMax Responses 同一输出位置的 item ID 或类型不一致")
    }
    current.itemId ??= state.itemId
    return current
  }

  /**
   * 为首次收到有效内容的 item 分配 Runtime 块序号。
   * @param output 本次流内的 item 状态。
   * @returns 首次调用时产出块开始事件，结束时返回该块的统一索引。
   */
  function* start(output: PendingText | PendingCall): Generator<ModelStreamEvent, number> {
    if (output.index === undefined) {
      output.index = nextIndex++
      yield { type: "block_start", index: output.index, blockType: output.type }
    }
    return output.index
  }

  /**
   * 接收完整 item，补齐未由分片送达的文本或工具参数，并关闭其块。
   * @param outputIndex SDK 事件的输出位置。
   * @param item 完成事件或响应终态携带的 item。
   * @returns 该 item 剩余的统一事件。
   * @throws item 身份冲突或完整工具调用缺少 ID 或名称时抛出。
   */
  function* finishItem(outputIndex: number, item: OpenAI.Responses.ResponseOutputItem): Generator<ModelStreamEvent> {
    if (finished.has(outputIndex)) return
    if (item.type === "reasoning" || item.type === "message") {
      const type = item.type === "reasoning" ? "thinking" : "text"
      const output = track(outputIndex, { type, itemId: item.id, text: "" })
      const completeText = item.type === "reasoning"
        ? item.content?.filter((part) => part.type === "reasoning_text").map((part) => part.text).join("")
        : item.content?.filter((part) => part.type === "output_text").map((part) => part.text).join("")
      if (completeText) {
        const suffix = completeText.startsWith(output.text) ? completeText.slice(output.text.length) : ""
        output.text = completeText
        if (suffix !== "") {
          const index = yield* start(output)
          yield { type: "block_delta", index, delta: { type, text: suffix } }
        }
      }
      if (output.index !== undefined) {
        yield { type: "block_end", index: output.index, block: { type, text: output.text } }
      }
    } else if (item.type === "function_call") {
      if (item.status === "incomplete" || item.status === "in_progress") return
      const output = track(outputIndex, {
        type: "tool_call", itemId: item.id, toolCallId: item.call_id, name: item.name, argumentsJson: "",
      })
      output.toolCallId = item.call_id || output.toolCallId
      output.name = item.name || output.name
      if (!output.toolCallId || !output.name) throw new Error("MiniMax Responses 返回了缺少 ID 或名称的工具调用")
      const argumentsJson = item.arguments || output.argumentsJson
      const hadBlock = output.index !== undefined
      const index = yield* start(output)
      if (!hadBlock) {
        yield { type: "block_delta", index, delta: {
          type: "tool_call", toolCallId: output.toolCallId, nameDelta: output.name, argumentsDelta: argumentsJson,
        } }
      }
      yield { type: "block_end", index, block: {
        type: "tool_call", toolCallId: output.toolCallId, name: output.name,
        arguments: parseToolCallArguments(argumentsJson),
      } }
      completedCalls += 1
    }
    pending.delete(outputIndex)
    finished.add(outputIndex)
  }

  for await (const event of events) {
    switch (event.type) {
      case "response.output_item.added": {
        const { item, output_index: outputIndex } = event
        if (finished.has(outputIndex)) break
        if (item.type === "reasoning" || item.type === "message") {
          track(outputIndex, { type: item.type === "reasoning" ? "thinking" : "text", itemId: item.id, text: "" })
        } else if (item.type === "function_call") {
          const output = track(outputIndex, {
            type: "tool_call", itemId: item.id, toolCallId: item.call_id, name: item.name, argumentsJson: item.arguments ?? "",
          })
          if (output.index !== undefined) break
          output.toolCallId = item.call_id
          output.name = item.name
          const index = yield* start(output)
          yield { type: "block_delta", index, delta: {
            type: "tool_call", toolCallId: output.toolCallId, nameDelta: output.name,
            ...(output.argumentsJson !== "" ? { argumentsDelta: output.argumentsJson } : {}),
          } }
        }
        break
      }
      case "response.reasoning_text.delta":
      case "response.output_text.delta": {
        const { delta, item_id: itemId, output_index: outputIndex } = event
        if (delta === "" || finished.has(outputIndex)) break
        const type = event.type === "response.reasoning_text.delta" ? "thinking" : "text"
        const output = track(outputIndex, { type, itemId, text: "" })
        output.text += delta
        const index = yield* start(output)
        yield { type: "block_delta", index, delta: { type, text: delta } }
        break
      }
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done": {
        const { item_id: itemId, output_index: outputIndex } = event
        if (finished.has(outputIndex)) break
        const output = track(outputIndex, { type: "tool_call", itemId, toolCallId: "", name: "", argumentsJson: "" })
        if (event.type === "response.function_call_arguments.done") {
          output.argumentsJson = event.arguments
        } else {
          output.argumentsJson += event.delta
          if (output.index !== undefined && event.delta !== "") {
            yield { type: "block_delta", index: output.index, delta: {
              type: "tool_call", toolCallId: output.toolCallId, argumentsDelta: event.delta,
            } }
          }
        }
        break
      }
      case "response.output_item.done":
        yield* finishItem(event.output_index, event.item)
        break
      case "response.completed":
      case "response.incomplete": {
        const { response } = event
        if (response.status === "failed") throw new Error(response.error?.message ?? "MiniMax Responses 请求失败")
        const incomplete = event.type === "response.incomplete" || response.status === "incomplete"
        for (const [outputIndex, item] of (response.output ?? []).entries()) yield* finishItem(outputIndex, item)
        for (const output of pending.values()) {
          if (output.type === "tool_call") {
            /** AgentLoop 只执行已闭合的工具调用。缺少完整 item 时保留未完成状态。 */
            if (!incomplete) throw new Error("MiniMax Responses 结束时缺少已完成的工具调用 item")
          } else if (output.index !== undefined) {
            yield { type: "block_end", index: output.index, block: { type: output.type, text: output.text } }
          }
        }
        const finishReason = response.incomplete_details?.reason ?? response.status
        yield {
          type: "stream_end",
          completion: incomplete ? "incomplete" : completedCalls > 0 ? "tool_calls" : "finished",
          ...(finishReason ? { finishReason } : {}),
          ...(response.usage ? { usage: convertResponsesUsage(response.usage) } : {}),
        }
        return
      }
      case "response.failed":
        throw new Error(event.response.error?.message ?? "MiniMax Responses 请求失败")
      case "error":
        throw new Error(event.message)
    }
  }
  throw streamInterruptedError("responses")
}
