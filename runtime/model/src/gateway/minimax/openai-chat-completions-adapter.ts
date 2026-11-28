import type OpenAI from "openai"

import { createAbortError } from "../../../../error/src/abort.ts"
import {
  invalidRequest, joinTextBlocks, parseToolCallArguments, reasoningRequestFragment, serializeToolCallArguments,
  splitSystemMessage, streamInterruptedError,
} from "../../shared.ts"
import { convertChatCompletionsUsage } from "../../usage.ts"
import type { ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../../types.ts"

/** MiniMax 支持的分离思考流式请求。 */
type MiniMaxChatRequest = OpenAI.ChatCompletionCreateParamsStreaming & { reasoning_split: true }

/**
 * 将同一条 assistant 消息内的正文、明文思考及工具调用转换为各自的协议字段。
 * @param request 统一模型请求、历史及工具定义。
 * @param config 本轮模型的输出上限及可选推理档位。
 * @returns 启用思考分流和尾部 Usage 的 SDK 请求。
 * @throws 统一上下文、推理配置或所选档位无效时抛出。
 */
export function buildChatCompletionsRequest(request: UnifiedModelRequest, config: ModelConfig): MiniMaxChatRequest {
  const { system, rest, tools } = splitSystemMessage(request)
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }]

  for (const message of rest) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content !== "") messages.push({ role: "user", content })
    } else if (message.role === "assistant") {
      let content = ""
      let reasoningContent = ""
      const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = []
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            content += block.text
            break
          case "thinking":
            if (block.text !== "") reasoningContent += block.text
            break
          case "tool_call":
            toolCalls.push({ type: "function", id: block.toolCallId, function: {
              name: block.name, arguments: serializeToolCallArguments(block.arguments),
            } })
            break
        }
      }
      if (content === "" && reasoningContent === "" && toolCalls.length === 0) continue
      const assistant = {
        role: "assistant" as const,
        content: content === "" ? null : content,
        ...(reasoningContent !== "" ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      }
      messages.push(assistant)
    } else if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: joinTextBlocks(message.content) })
    }
  }

  const model = config.name.toLowerCase()
  const { reasoningLevel } = request.model
  if (config.supportsReasoning &&
      ((model === "minimax-m3.1-flash" && !["low", "medium", "high", "xhigh", "max"].includes(reasoningLevel)) ||
       (model === "minimax-m3" && !["adaptive", "disabled"].includes(reasoningLevel)))) {
    throw invalidRequest("当前推理等级不受 MiniMax Chat Completions 模型支持", { reasoningLevel })
  }
  const reasoningField = model === "minimax-m3" ? { path: ["thinking", "type"] }
    : model === "minimax-m3.1-flash" ? { path: ["reasoning_effort"] } : config.reasoningField

  const params: MiniMaxChatRequest = {
    model: request.model.name,
    messages,
    stream: true,
    reasoning_split: true,
    stream_options: { include_usage: true },
    max_completion_tokens: config.maxOutputTokens,
  }
  if (request.toolChoice !== "none" && tools.length > 0) {
    params.tools = tools.map((tool) => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } }))
  }
  return { ...reasoningRequestFragment(request, { ...config, reasoningField }), ...params }
}

/** 当前连续的思考或正文块及其统一索引。 */
type PendingText = { index: number; type: "text" | "thinking"; text: string }

/** 按 SDK 工具索引累积的统一块索引、调用标识及分片。 */
type PendingCall = { index: number; toolCallId: string; name: string; argumentsJson: string }

/**
 * 分别累积 MiniMax 的思考、正文和工具参数，读取结束原因之后的 Usage。
 * @param chunks 本次网络尝试的 OpenAI SDK 流。
 * @param signal 共享网关传入的取消信号，用于区分 SDK 静默停止与正常流尾。
 * @returns 统一内容块及一次流结束事件，截断的工具调用仅产出已收到的分片。
 * @throws 上游失败、请求取消、终态之前断流或工具调用缺少 ID 或名称时抛出。
 */
export async function* mapChatCompletionsStream(
  chunks: AsyncIterable<OpenAI.ChatCompletionChunk>,
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  const calls = new Map<number, PendingCall>()
  let nextIndex = 0
  let activeText: PendingText | undefined
  let finishReason: string | undefined
  let usage: OpenAI.ChatCompletionChunk["usage"]

  for await (const chunk of chunks) {
    const { base_resp: baseResponse } = chunk as OpenAI.ChatCompletionChunk & {
      base_resp?: { status_code?: number; status_msg?: string }
    }
    if (baseResponse?.status_code) {
      throw new Error(`MiniMax Chat Completions 请求失败 (${baseResponse.status_code}): ${baseResponse.status_msg ?? ""}`)
    }
    if (chunk.usage != null) usage = chunk.usage
    /** 请求使用默认的单个 choice，独立的 Usage 分片不包含 choice。 */
    const choice = chunk.choices?.find((item) => item.index === 0)
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason

    const delta: (OpenAI.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null }) | undefined = choice.delta
    const parts = [
      ["thinking", delta?.reasoning_content ?? ""],
      ["text", delta?.content ?? ""],
    ] as const
    for (const [type, text] of parts) {
      if (typeof text !== "string" || text === "") continue
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

    if (delta?.tool_calls?.length && activeText) {
      yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
      activeText = undefined
    }
    for (const fragment of delta?.tool_calls ?? []) {
      let call = calls.get(fragment.index)
      if (!call) {
        call = { index: nextIndex++, toolCallId: "", name: "", argumentsJson: "" }
        calls.set(fragment.index, call)
        yield { type: "block_start", index: call.index, blockType: "tool_call" }
      }
      if (fragment.id && !call.toolCallId) call.toolCallId = fragment.id
      const { name: nameDelta, arguments: argumentsDelta } = fragment.function ?? {}
      call.name += nameDelta ?? ""
      call.argumentsJson += argumentsDelta ?? ""
      if (fragment.id || nameDelta || argumentsDelta) {
        yield { type: "block_delta", index: call.index, delta: {
          type: "tool_call", toolCallId: call.toolCallId,
          ...(nameDelta ? { nameDelta } : {}), ...(argumentsDelta ? { argumentsDelta } : {}),
        } }
      }
    }
  }

  if (signal?.aborted) throw createAbortError()
  if (finishReason === undefined) throw streamInterruptedError("chat_completions")
  if (activeText) {
    yield { type: "block_end", index: activeText.index, block: { type: activeText.type, text: activeText.text } }
  }
  let completion: ModelCompletion = "unknown"
  switch (finishReason) {
    case "stop":
      completion = "finished"
      break
    case "tool_calls":
    case "function_call":
      if (calls.size > 0) completion = "tool_calls"
      break
    case "length":
    case "content_filter":
      completion = "incomplete"
      break
  }
  /** 只有确认进入工具小轮时才闭合工具块，避免 AgentLoop 执行截断的调用。 */
  if (completion === "tool_calls") {
    for (const call of calls.values()) {
      if (!call.toolCallId || !call.name) throw new Error("MiniMax Chat Completions 返回了缺少 ID 或名称的工具调用")
      yield { type: "block_end", index: call.index, block: {
        type: "tool_call", toolCallId: call.toolCallId, name: call.name, arguments: parseToolCallArguments(call.argumentsJson),
      } }
    }
  } else if (calls.size > 0 && completion !== "incomplete") {
    throw new Error("MiniMax Chat Completions 结束时缺少工具调用完成原因")
  }
  if (signal?.aborted) throw createAbortError()
  yield { type: "stream_end", completion, finishReason, ...(usage ? { usage: convertChatCompletionsUsage(usage) } : {}) }
}
