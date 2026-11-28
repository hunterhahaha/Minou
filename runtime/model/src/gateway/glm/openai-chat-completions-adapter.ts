import type OpenAI from "openai"
import { joinTextBlocks, parseToolCallArguments, reasoningRequestFragment, serializeToolCallArguments, splitSystemMessage, streamInterruptedError } from "../../shared.ts"
import type { AssistantContentBlock, ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest, Usage } from "../../types.ts"
import { extractProviderError, readThinkingReplay, record, thinkingReplay } from "./provider.ts"
import type { GlmProvider } from "./provider.ts"
import { chatUsage } from "./usage.ts"

/**
 * 将会话投影到 GLM Chat，启用保留式思考时按原顺序回传原生文本。
 * @param request 当前上下文、工具和所选模型档位。
 * @param config 本轮模型输出上限、推理能力和档位字段。
 * @returns 使用服务端默认用量报告行为的流式请求。
 * @throws AppError 当上下文或推理配置无效时抛出。
 */
export function buildChatRequest(request: UnifiedModelRequest, config: ModelConfig): OpenAI.ChatCompletionCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const reasoning = reasoningRequestFragment(request, config)
  const thinking = record(reasoning.thinking)
  const replayThinking = config.supportsReasoning && request.context.purpose !== "summary" &&
    thinking?.type !== "disabled" && thinking?.clear_thinking !== true &&
    reasoning.reasoning_effort !== "minimal" &&
    !["none", "disabled", "false", "off"].includes(request.model.reasoningLevel.toLowerCase())
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }]
  let hasReplay = false

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content.length > 0) messages.push({ role: "user", content })
    } else if (message.role === "assistant") {
      let content = ""
      let reasoningContent = ""
      const toolCalls: NonNullable<OpenAI.ChatCompletionAssistantMessageParam["tool_calls"]> = []
      for (const block of message.content) {
        if (block.type === "text") content += block.text
        if (block.type === "thinking" && replayThinking) {
          const native = readThinkingReplay(block, "chat_completions")
          if (typeof native?.reasoning_content === "string") reasoningContent += native.reasoning_content
        }
        if (block.type === "tool_call") {
          toolCalls.push({ id: block.toolCallId, type: "function", function: {
            name: block.name, arguments: serializeToolCallArguments(block.arguments),
          } })
        }
      }
      if (content.length === 0 && reasoningContent.length === 0 && toolCalls.length === 0) continue
      hasReplay ||= reasoningContent.length > 0
      const assistant = {
        role: "assistant" as const,
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningContent.length > 0 ? { reasoning_content: reasoningContent } : {}),
      }
      messages.push(assistant)
    } else if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: joinTextBlocks(message.content) })
    }
  }

  const params = {
    model: request.model.name,
    messages,
    stream: true,
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function" as const, function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" as const } : {}),
  } satisfies OpenAI.ChatCompletionCreateParamsStreaming
  return Object.assign(params, reasoning, { max_tokens: config.maxOutputTokens },
    hasReplay ? { thinking: { ...thinking, clear_thinking: false } } : {})
}

/** 一段连续的正文或原生思考，切换通道时结束。 */
interface TextBlock {
  index: number
  type: "thinking" | "text"
  text: string
}

/** 单个原生 tool_calls 序号对应的 Runtime 工具块。 */
interface ToolCall {
  index: number
  toolCallId: string
  name: string
  argumentsJson: string
}

/**
 * 读取 GLM Chat 流，直到 SDK 流关闭才交付最终 Usage。
 * @param chunks 本次尝试的原始 SDK 流。
 * @param provider 用于提取错误与 Usage 的平台分支。
 * @param captureReplay 是否为独立摘要之外的请求保存已完成思考。
 * @returns 统一块事件和一个最终流事件。
 * @throws 流报告错误、缺少结束原因或工具调用缺少身份时抛出。
 */
export async function* mapChatStream(
  chunks: AsyncIterable<OpenAI.ChatCompletionChunk>, provider: GlmProvider, captureReplay: boolean,
): AsyncGenerator<ModelStreamEvent> {
  let nextIndex = 0
  let activeText: TextBlock | undefined
  const calls = new Map<number, ToolCall>()
  let finishReason: string | undefined
  let usage: Usage | undefined

  /**
   * 封装完整文本块，已结束的原生思考可被下一次请求回传。
   * @param pending 当前累计的文本块。
   * @param complete 是否已越过思考边界或正常结束思考。
   * @returns 对应的块结束事件。
   */
  function endText(pending: TextBlock, complete: boolean): ModelStreamEvent {
    const block: AssistantContentBlock = { type: pending.type, text: pending.text }
    if (block.type === "thinking" && complete && captureReplay) {
      block.replay = thinkingReplay("chat_completions", { reasoning_content: block.text })
    }
    return { type: "block_end", index: pending.index, block }
  }

  /**
   * 追加一个增量，必要时切换正文与思考通道。
   * @param type 当前文本通道。
   * @param text 原始文本增量。
   * @returns 对应的增量及边界事件。
   */
  function* appendText(type: TextBlock["type"], text: string): Generator<ModelStreamEvent> {
    if (activeText?.type !== type) {
      if (activeText) yield endText(activeText, true)
      activeText = { index: nextIndex++, type, text: "" }
      yield { type: "block_start", index: activeText.index, blockType: type }
    }
    activeText.text += text
    yield { type: "block_delta", index: activeText.index, delta: { type, text } }
  }

  for await (const chunk of chunks) {
    const fields = record(chunk)
    if (fields?.error != null || fields?.type === "error") {
      throw extractProviderError(chunk, "chat_completions", provider, "GLM Chat Completions 流报告错误")
    }
    usage = chatUsage(chunk.usage, provider) ?? usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const reason: string | null = choice.finish_reason
    if (reason === "network_error" || reason === "error") {
      throw extractProviderError({ code: reason, request_id: fields?.request_id }, "chat_completions", provider,
        `GLM Chat Completions 流以 ${reason} 结束`)
    }
    if (typeof reason === "string" && reason.length > 0) finishReason = reason

    const { delta } = choice
    const reasoning = record(delta)?.reasoning_content
    if (typeof reasoning === "string" && reasoning.length > 0) yield* appendText("thinking", reasoning)
    const content = delta?.content ?? delta?.refusal
    if (content) yield* appendText("text", content)
    if (delta?.tool_calls?.length && activeText) {
      yield endText(activeText, true)
      activeText = undefined
    }

    for (const fragment of delta?.tool_calls ?? []) {
      let call = calls.get(fragment.index)
      if (!call) {
        call = { index: nextIndex++, toolCallId: "", name: "", argumentsJson: "" }
        calls.set(fragment.index, call)
        yield { type: "block_start", index: call.index, blockType: "tool_call" }
      }
      const previousId = call.toolCallId
      if (fragment.id) {
        if (previousId && previousId !== fragment.id) throw new Error("GLM Chat Completions 更改了工具调用 ID")
        call.toolCallId = fragment.id
      }
      const { name: nameDelta, arguments: argumentsDelta } = fragment.function ?? {}
      call.name += nameDelta ?? ""
      call.argumentsJson += argumentsDelta ?? ""
      const nameToEmit = previousId ? nameDelta : call.name
      const argumentsToEmit = previousId ? argumentsDelta : call.argumentsJson
      if (call.toolCallId && (nameToEmit || argumentsToEmit)) {
        yield { type: "block_delta", index: call.index, delta: { type: "tool_call", toolCallId: call.toolCallId,
          ...(nameToEmit ? { nameDelta: nameToEmit } : {}), ...(argumentsToEmit ? { argumentsDelta: argumentsToEmit } : {}) } }
      }
    }
  }

  if (finishReason === undefined) throw streamInterruptedError("chat_completions")
  const toolFinish = finishReason === "tool_calls" || finishReason === "function_call"
  const completion: ModelCompletion = finishReason === "stop" ? "finished"
    : toolFinish && calls.size > 0 ? "tool_calls"
      : ["length", "sensitive", "content_filter", "model_context_window_exceeded"].includes(finishReason) ? "incomplete" : "unknown"
  if (activeText) yield endText(activeText, completion === "finished" || completion === "tool_calls")
  for (const call of calls.values()) {
    if (!call.toolCallId || !call.name) throw new Error("GLM Chat Completions 返回了缺少 ID 或名称的工具调用")
    yield { type: "block_end", index: call.index, block: { type: "tool_call", toolCallId: call.toolCallId,
      name: call.name, arguments: parseToolCallArguments(call.argumentsJson) } }
  }
  yield { type: "stream_end", completion, finishReason, ...(usage ? { usage } : {}) }
}
