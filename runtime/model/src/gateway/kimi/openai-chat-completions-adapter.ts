import type OpenAI from "openai"

import { createAbortError, isAbortError } from "../../../../error/src/abort.ts"
import { normalizeModelError } from "../../../../error/src/normalizer.ts"
import {
  isAppError, joinTextBlocks, parseToolCallArguments, reasoningRequestFragment,
  serializeToolCallArguments, splitSystemMessage, streamInterruptedError,
} from "../../shared.ts"
import { convertChatCompletionsUsage } from "../../usage.ts"
import type {
  ModelCompletion, ModelConfig, ModelStreamEvent, UnifiedModelRequest, Usage,
} from "../../types.ts"

/** Coding Plan 文档示例中的额度消息，以及可直接展示的说明。 */
const CODING_PLAN_QUOTAS = [
  [/reached your 5-hour usage limit/i, "Kimi Coding Plan 的 5 小时使用额度已用完。"],
  [/reached your weekly \(7-day\) usage limit/i, "Kimi Coding Plan 的 7 天使用额度已用完。"],
  [/reached your monthly usage limit/i, "Kimi Coding Plan 的月度使用额度已用完。"],
  [/credit balance is insufficient/i, "Kimi Coding Plan 的账户余额不足。"],
  [/extra usage balance has run out/i, "Kimi Coding Plan 的组织 Extra Usage 余额已用完。"],
  [/extra usage limit set for your account/i, "Kimi Coding Plan 已达到组织为本账号设置的 Extra Usage 上限。"],
] as const

/**
 * 从协议载荷或 SDK 对象中读取字段。
 * @param value JSON 载荷、SDK 异常或可选的嵌套字段。
 * @returns 可读取字段的对象，其他值省略。
 */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/**
 * 投影统一上下文和工具，按模型的保留式思考规则发送非空的思考文本。
 * @param request 请求的已裁剪上下文、工具和推理档位。
 * @param config 本轮 API 模型原名、输出上限和推理字段配置。
 * @returns 可直接由共享 OpenAI SDK 发送的流式请求。
 * @throws AppError 当统一上下文或推理配置无法转换时抛出。
 */
export function buildChatRequest(request: UnifiedModelRequest, config: ModelConfig): OpenAI.ChatCompletionCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const reasoning = reasoningRequestFragment(request, config)
  const thinking = record(reasoning.thinking)
  const includeThinking = request.context.purpose !== "summary" && thinking?.type !== "disabled"
  const currentToolTurnOnly = config.name.toLowerCase() === "kimi-k2.6" && thinking?.keep !== "all"
  const lastUserIndex = currentToolTurnOnly
    ? rest.reduce((last, message, index) => message.role === "user" ? index : last, -1) : -1
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }]

  for (const [index, message] of rest.entries()) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (content.length > 0) messages.push({ role: "user", content })
    } else if (message.role === "assistant") {
      let content = ""
      const toolCalls: NonNullable<OpenAI.ChatCompletionAssistantMessageParam["tool_calls"]> = []
      for (const block of message.content) {
        if (block.type === "text") content += block.text
        if (block.type === "tool_call") {
          toolCalls.push({ id: block.toolCallId, type: "function", function: {
            name: block.name, arguments: serializeToolCallArguments(block.arguments),
          } })
        }
      }
      const reasoningContent = includeThinking && (!currentToolTurnOnly || (index > lastUserIndex && toolCalls.length > 0))
        ? message.content.flatMap((block) => block.type === "thinking" && block.text !== "" ? [block.text] : []).join("") : ""
      if (content.length === 0 && reasoningContent.length === 0 && toolCalls.length === 0) continue
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
    model: config.name,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools: tools.map((tool) => ({ type: "function" as const, function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })) } : {}),
    ...(request.toolChoice === "none" ? { tool_choice: "none" as const } : {}),
  } satisfies OpenAI.ChatCompletionCreateParamsStreaming
  return Object.assign(params, reasoning, { max_tokens: config.maxOutputTokens })
}

/**
 * 读取协议中的可选 Token 计数。
 * @param value 流尾用量中的原始字段。
 * @returns 非负安全整数，包括显式零；无效值省略。
 */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * 只读取 Kimi 的已知用量字段，再交由共享规则计算缓存拆分和总量。
 * @param value chunk 顶层的 usage 字段。
 * @returns 可用用量；整块无有效计数时省略。
 */
function readUsage(value: unknown): Usage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const prompt = record(usage.prompt_tokens_details)
  const fields = {
    prompt_tokens: tokenCount(usage.prompt_tokens),
    completion_tokens: tokenCount(usage.completion_tokens),
    total_tokens: tokenCount(usage.total_tokens),
    cached_tokens: tokenCount(prompt?.cached_tokens) ?? tokenCount(usage.cached_tokens),
    cache_write_tokens: tokenCount(prompt?.cache_write_tokens),
    reasoning_tokens: tokenCount(record(usage.completion_tokens_details)?.reasoning_tokens),
  }
  if (Object.values(fields).every((count) => count === undefined)) return undefined
  return convertChatCompletionsUsage({
    prompt_tokens: fields.prompt_tokens,
    completion_tokens: fields.completion_tokens,
    total_tokens: fields.total_tokens,
    cached_tokens: fields.cached_tokens,
    prompt_tokens_details: { cache_write_tokens: fields.cache_write_tokens },
    completion_tokens_details: { reasoning_tokens: fields.reasoning_tokens },
  })
}

/**
 * 取第一个可公开记录的上游标识符。
 * @param values 按优先级排列的错误码或请求 ID 字段。
 * @returns 可展示的标识符，缺失或包含非标识符字符时省略。
 */
function errorIdentifier(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && /^[\w.:-]{1,160}$/.test(value))
}

/**
 * 提取 HTTP 和 SSE 错误字段，只向调用方提供固定的说明与结构化元数据。
 * @param error SDK 抛出的错误或原始 SSE 错误事件。
 * @returns 额度和权限失败使用统一错误；其他失败保留共享重试分类所需的字段。
 */
function kimiError(error: unknown): unknown {
  if (isAbortError(error) || isAppError(error)) return error
  const top = record(error)
  if (!top) return error
  const envelope = record(top.error)
  const body = record(envelope?.error) ?? envelope
  const status = [top.status, body?.status, envelope?.status].find((value): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599)
  const code = errorIdentifier(body?.code, body?.type, top.code, top.type === "error" ? undefined : top.type)
  const type = errorIdentifier(body?.type, top.type)
  const requestID = errorIdentifier(top.requestID, top.requestId, top.request_id, envelope?.request_id, body?.request_id)
  const message = typeof body?.message === "string" ? body.message
    : typeof top.message === "string" ? top.message : ""

  const rateLimited = code === "rate_limit_reached_error" || type === "rate_limit_reached_error"
  const quotaMessage = code === "exceeded_current_quota_error" || type === "exceeded_current_quota_error"
    ? "Kimi 账户余额或使用额度不足。"
    : rateLimited && /\bTPD\b|tokens per day|daily token|每日.{0,8}(?:token|令牌)/i.test(message)
      ? "Kimi 开放平台的每日 Token 额度已用完。"
      : CODING_PLAN_QUOTAS.find(([pattern]) => pattern.test(message))?.[1]
  const planAccess = /current subscription does not have access|current plan supports only|does not have access to kimi code/i.test(message)
  const overloaded = code === "engine_overloaded_error" || type === "engine_overloaded_error" ||
    /engine is currently overloaded/i.test(message)
  const temporarilyLimited = rateLimited || /receiving too many requests|reached your concurrent request limit/i.test(message)

  if (top.error == null && status === undefined && type === undefined && !quotaMessage && !planAccess &&
      !overloaded && !temporarilyLimited) return error
  const metadata = { status, requestID, error: { code } }
  if (quotaMessage !== undefined) {
    return normalizeModelError({ ...metadata, message: quotaMessage })
  }
  if (status === 403 || planAccess) {
    return normalizeModelError({ ...metadata, message: "Kimi 账户没有本次请求所需的权限。" })
  }
  const safeMessage = overloaded ? "Kimi 推理服务暂时过载。"
    : temporarilyLimited ? "Kimi 请求触发临时限流。" : "Kimi 模型请求失败。"
  return Object.assign(new Error(safeMessage, { cause: error }), metadata, {
    type: overloaded || temporarilyLimited ? "overloaded_error" : type,
  })
}

/** 同一通道连续到达的思考或正文。 */
interface TextBlock {
  /** Runtime 块序号。 */
  index: number
  /** 当前通道。 */
  type: "thinking" | "text"
  /** 未裁剪的已接收文本。 */
  text: string
}

/** 按协议工具序号累计的调用分片。 */
interface ToolCall {
  /** Runtime 块序号，与协议工具序号独立。 */
  index: number
  /** 由服务端 ID 分片拼成的结果关联键。 */
  id: string
  /** 累计的函数名。 */
  name: string
  /** 累计的原始 JSON 参数。 */
  argumentsJson: string
}

/**
 * 生成包含完整已接收文本的思考或正文结束事件。
 * @param block 已接收的思考或正文。
 * @returns 可由 Runtime 持久化的结束事件。
 */
function endTextBlock({ index, type, text }: TextBlock): ModelStreamEvent {
  return { type: "block_end", index, block: { type, text } }
}

/**
 * 映射正常 EOF 前收到的上游结束原因。
 * @param reason Kimi 报告的原始原因。
 * @returns Runtime 的完成状态。
 */
function completionFor(reason: string): ModelCompletion {
  switch (reason) {
    case "stop": return "finished"
    case "tool_calls":
    case "function_call": return "tool_calls"
    case "length":
    case "content_filter":
    case "insufficient_system_resource":
    case "aborted": return "incomplete"
    default: return "unknown"
  }
}

/**
 * 转换一次 SDK 流，收齐工具参数、思考文本与结束原因之后的用量。
 * @param chunks 本次尝试的 Chat Completions 事件。
 * @param signal SDK 传输使用的取消信号，离线样本可省略。
 * @returns 独立分配块序号的统一事件流，正常完成只产生一次 stream_end。
 * @throws 流取消、上游失败、缺少结束原因或工具终态缺少调用信息时抛出。
 */
export async function* mapChatStream(
  chunks: AsyncIterable<OpenAI.ChatCompletionChunk>,
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  let nextIndex = 0
  let activeText: TextBlock | undefined
  const calls = new Map<number, ToolCall>()
  let finishReason: string | undefined
  let usage: Usage | undefined

  /**
   * 在切换文本通道时结束上一块，并交付本次增量。
   * @param type 本次增量所属的思考或正文通道。
   * @param text 未裁剪的非空文本增量。
   * @returns 新增量和必要的块边界事件。
   */
  function* appendText(type: TextBlock["type"], text: string): Generator<ModelStreamEvent> {
    if (activeText?.type !== type) {
      if (activeText) yield endTextBlock(activeText)
      activeText = { index: nextIndex++, type, text: "" }
      yield { type: "block_start", index: activeText.index, blockType: type }
    }
    activeText.text += text
    yield { type: "block_delta", index: activeText.index, delta: { type, text } }
  }

  try {
    for await (const chunk of chunks) {
      const fields = record(chunk)
      if (fields?.error != null || fields?.type === "error") throw chunk
      usage = readUsage(chunk.usage) ?? usage
      if (finishReason !== undefined) continue
      const choice = chunk.choices?.find((item) => item.index === 0) ?? chunk.choices?.[0]
      if (!choice) continue
      if (typeof choice.finish_reason === "string" && choice.finish_reason.trim() !== "") finishReason = choice.finish_reason

      const delta = choice.delta
      const reasoning = record(delta)?.reasoning_content
      if (typeof reasoning === "string" && reasoning.length > 0) yield* appendText("thinking", reasoning)
      if (typeof delta?.content === "string" && delta.content.length > 0) yield* appendText("text", delta.content)

      for (const deltaCall of delta?.tool_calls ?? []) {
        const { name: nameDelta, arguments: argumentsDelta } = deltaCall.function ?? {}
        if (!deltaCall.id && !nameDelta && !argumentsDelta) continue
        if (activeText) {
          yield endTextBlock(activeText)
          activeText = undefined
        }
        let call = calls.get(deltaCall.index)
        if (!call) {
          call = { index: nextIndex++, id: "", name: "", argumentsJson: "" }
          calls.set(deltaCall.index, call)
          yield { type: "block_start", index: call.index, blockType: "tool_call" }
        }
        call.id += deltaCall.id ?? ""
        call.name += nameDelta ?? ""
        call.argumentsJson += argumentsDelta ?? ""
        yield { type: "block_delta", index: call.index, delta: {
          type: "tool_call", toolCallId: call.id,
          ...(nameDelta ? { nameDelta } : {}),
          ...(argumentsDelta ? { argumentsDelta } : {}),
        } }
      }
    }
  } catch (error) {
    if (signal?.aborted) throw createAbortError()
    throw kimiError(error)
  }

  if (signal?.aborted) throw createAbortError()
  if (finishReason === undefined) throw streamInterruptedError("chat_completions")
  const completion = completionFor(finishReason)
  if (activeText) yield endTextBlock(activeText)
  if (completion === "tool_calls") {
    if (calls.size === 0 || [...calls.values()].some((call) => !call.id || !call.name)) {
      throw new Error("Kimi Chat Completions 工具调用缺少 ID 或名称。")
    }
    for (const call of calls.values()) {
      yield { type: "block_end", index: call.index, block: {
        type: "tool_call", toolCallId: call.id, name: call.name, arguments: parseToolCallArguments(call.argumentsJson),
      } }
    }
  }
  if (signal?.aborted) throw createAbortError()
  yield { type: "stream_end", completion, finishReason, ...(usage === undefined ? {} : { usage }) }
}
