import type OpenAI from "openai"
import { joinTextBlocks, parseToolCallArguments, reasoningRequestFragment, serializeToolCallArguments, splitSystemMessage, streamInterruptedError } from "../../shared.ts"
import type { AssistantContentBlock, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../../types.ts"
import { extractProviderError, readThinkingReplay, record, thinkingReplay } from "./provider.ts"
import type { GlmProvider } from "./provider.ts"
import { responsesUsage } from "./usage.ts"

/** GLM Responses 的原生思考输入，content 是单个 reasoning_text 对象。 */
interface ReasoningInput {
  type: "reasoning"
  content: { type: "reasoning_text"; text: string }
}

/**
 * 构造客户端持有历史的 GLM Responses 请求，思考项保留原来的位置。
 * @param request 当前上下文、工具和所选模型档位。
 * @param config 本轮模型输出上限和推理配置。
 * @returns 可由 OpenAI SDK 发送的流式请求。
 * @throws AppError 当上下文或推理配置无效时抛出。
 */
export function buildResponsesRequest(request: UnifiedModelRequest, config: ModelConfig): OpenAI.Responses.ResponseCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const input: (OpenAI.Responses.ResponseInputItem | ReasoningInput)[] = []
  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content.length > 0) input.push({ type: "message", role: "user", content })
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.length > 0) input.push({ type: "message", role: "assistant", content: block.text })
        if (block.type === "tool_call") input.push({ type: "function_call", call_id: block.toolCallId,
          name: block.name, arguments: serializeToolCallArguments(block.arguments) })
        if (block.type === "thinking" && request.context.purpose !== "summary") {
          const native = readThinkingReplay(block, "responses")
          const part = record(native?.content)
          if (native?.type === "reasoning" && part?.type === "reasoning_text" && typeof part.text === "string" && part.text.length > 0) {
            input.push({ type: "reasoning", content: { type: "reasoning_text", text: part.text } })
          }
        }
      }
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: joinTextBlocks(message.content) })
    }
  }

  const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
    model: request.model.name,
    instructions: system,
    /** SDK 原样序列化 input，其 OpenAI 类型没有 GLM 的单对象 reasoning 输入。 */
    input: input as OpenAI.Responses.ResponseInput,
    stream: true,
    store: false,
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function" as const, name: tool.name,
      description: tool.description, parameters: tool.inputSchema, strict: false })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" as const } : {}),
  }
  return Object.assign(params, reasoningRequestFragment(request, config), { max_output_tokens: config.maxOutputTokens })
}

/** 按原生 output_index 保存的 Runtime 块，文本内部再按 content_index 累积。 */
type PendingItem =
  | { index: number; type: "thinking" | "text"; parts: Map<number, string>; reasoningDone: boolean }
  | { index: number; type: "tool_call"; toolCallId: string; name: string; argumentsJson: string }

/**
 * 读取 GLM 原生输出项的文本，也接受端点按 SDK 形状返回的数组。
 * @param item 原生 reasoning 或 message 项。
 * @returns 与输出项类型匹配的正文或思考，不使用摘要或加密字段。
 */
function itemText(item: OpenAI.Responses.ResponseOutputItem): string {
  if (item.type !== "message" && item.type !== "reasoning") return ""
  const content: unknown = item.content
  const expected = item.type === "reasoning" ? "reasoning_text" : "output_text"
  return (Array.isArray(content) ? content : [content]).map((part) => {
    const fields = record(part)
    return fields?.type === expected && typeof fields.text === "string" ? fields.text : ""
  }).join("")
}

/**
 * 按 output_index 转换 Responses 流，并以 Responses 终态交付用量。
 * @param events 本次尝试的 OpenAI SDK 流。
 * @param provider 用于提取错误的 Provider 分支。
 * @param captureReplay 是否保存已完成的原生思考项。
 * @returns 按块交付的统一事件流。
 * @throws 响应报告错误、流缺少终态或工具调用缺少身份时抛出。
 */
export async function* mapResponsesStream(
  events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>, provider: GlmProvider, captureReplay: boolean,
): AsyncGenerator<ModelStreamEvent> {
  const pending = new Map<number, PendingItem>()
  const closed = new Set<number>()
  let nextIndex = 0
  let completedCalls = 0

  /**
   * 在输出项或首个文本事件出现时登记 Runtime 文本块。
   * @param outputIndex 协议输出项索引。
   * @param type 该项对应的文本通道。
   * @returns 首次登记时的块开始事件。
   */
  function* openText(outputIndex: number, type: "thinking" | "text"): Generator<ModelStreamEvent> {
    if (pending.has(outputIndex) || closed.has(outputIndex)) return
    const index = nextIndex++
    pending.set(outputIndex, { index, type, parts: new Map(), reasoningDone: false })
    yield { type: "block_start", index, blockType: type }
  }

  /**
   * 从输出项登记内容块，已登记或已结束的索引保持原有生命周期。
   * @param outputIndex 协议输出项索引。
   * @param item 出现在 added、done 或终态快照中的输出项。
   * @returns 新块的开始事件及可用的首个工具名称增量。
   * @throws Error 工具项缺少调用 ID 或名称时抛出。
   */
  function* openItem(outputIndex: number, item: OpenAI.Responses.ResponseOutputItem): Generator<ModelStreamEvent> {
    if (pending.has(outputIndex) || closed.has(outputIndex)) return
    if (item.type === "function_call") {
      if (!item.call_id || !item.name) throw new Error("GLM Responses 返回了缺少 ID 或名称的工具调用")
      const index = nextIndex++
      pending.set(outputIndex, { index, type: "tool_call", toolCallId: item.call_id, name: item.name, argumentsJson: item.arguments ?? "" })
      yield { type: "block_start", index, blockType: "tool_call" }
      yield { type: "block_delta", index, delta: { type: "tool_call", toolCallId: item.call_id, nameDelta: item.name } }
    } else if (item.type === "reasoning" || item.type === "message") {
      yield* openText(outputIndex, item.type === "reasoning" ? "thinking" : "text")
    }
  }

  /**
   * 结束输出项，以原生完成快照补齐尚未流出的内容。
   * @param outputIndex 协议输出项索引。
   * @param complete 该项是否完整生成。
   * @param item 可选的输出项快照。
   * @returns 完成事件和快照补足的文本增量。
   */
  function* closeItem(outputIndex: number, complete: boolean, item?: OpenAI.Responses.ResponseOutputItem): Generator<ModelStreamEvent> {
    const block = pending.get(outputIndex)
    if (!block) return
    pending.delete(outputIndex)
    closed.add(outputIndex)

    let content: AssistantContentBlock
    if (block.type === "tool_call") {
      if (complete) completedCalls += 1
      content = { type: "tool_call", toolCallId: block.toolCallId, name: block.name,
        arguments: parseToolCallArguments(item?.type === "function_call" ? item.arguments ?? block.argumentsJson : block.argumentsJson) }
    } else {
      const streamed = [...block.parts].sort(([left], [right]) => left - right).map(([, part]) => part).join("")
      const text = (item && itemText(item)) || streamed
      if (text.length > streamed.length && text.startsWith(streamed)) {
        yield { type: "block_delta", index: block.index, delta: { type: block.type, text: text.slice(streamed.length) } }
      }
      content = { type: block.type, text }
      if (block.type === "thinking" && (complete || block.reasoningDone) && captureReplay && text.length > 0) {
        const native: ReasoningInput = { type: "reasoning", content: { type: "reasoning_text", text } }
        content.replay = thinkingReplay("responses", native)
      }
    }
    yield { type: "block_end", index: block.index, block: content }
  }

  for await (const event of events) {
    switch (event.type) {
      case "response.output_item.added":
        yield* openItem(event.output_index, event.item)
        break
      case "response.output_text.delta":
      case "response.output_text.done":
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done": {
        const isReasoning = event.type === "response.reasoning_text.delta" || event.type === "response.reasoning_text.done"
        const type = isReasoning ? "thinking" : "text"
        yield* openText(event.output_index, type)
        const block = pending.get(event.output_index)
        if (block?.type !== type) break
        const partIndex = event.content_index ?? 0
        const previous = block.parts.get(partIndex) ?? ""
        const text = "delta" in event ? previous + event.delta : event.text
        block.parts.set(partIndex, text)
        if (event.type === "response.reasoning_text.done") block.reasoningDone = true
        if (text.length > previous.length && text.startsWith(previous)) {
          yield { type: "block_delta", index: block.index, delta: { type, text: text.slice(previous.length) } }
        }
        break
      }
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done": {
        const call = pending.get(event.output_index)
        if (call?.type !== "tool_call") break
        if (event.type === "response.function_call_arguments.done") call.argumentsJson = event.arguments
        else if (event.delta.length > 0) {
          call.argumentsJson += event.delta
          yield { type: "block_delta", index: call.index, delta: { type: "tool_call", toolCallId: call.toolCallId, argumentsDelta: event.delta } }
        }
        break
      }
      case "response.output_item.done":
        yield* openItem(event.output_index, event.item)
        yield* closeItem(event.output_index, !("status" in event.item) || event.item.status === undefined || event.item.status === "completed", event.item)
        break
      case "response.completed":
      case "response.incomplete": {
        const { response } = event
        const incomplete = event.type === "response.incomplete" || response.status === "incomplete"
        for (const [index, item] of (response.output ?? []).entries()) {
          yield* openItem(index, item)
          const status = "status" in item ? item.status : undefined
          yield* closeItem(index, status === "completed" || (status === undefined && !incomplete), item)
        }
        for (const index of pending.keys()) yield* closeItem(index, !incomplete)
        const usage = responsesUsage(response.usage)
        yield { type: "stream_end", completion: incomplete ? "incomplete" : completedCalls > 0 ? "tool_calls" : "finished",
          finishReason: response.incomplete_details?.reason ?? response.status ?? (incomplete ? "incomplete" : "completed"),
          ...(usage ? { usage } : {}) }
        return
      }
      case "response.failed":
      case "error":
        throw extractProviderError(event, "responses", provider, "GLM Responses 流报告错误")
    }
  }
  throw streamInterruptedError("responses")
}
