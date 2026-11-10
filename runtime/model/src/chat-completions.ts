/**
 * Chat Completions 的请求与统一流事件转换。
 *
 * 系统指令使用 system 消息，工具调用及结果通过 tool_call_id 配对。
 * 请求不发送最大输出字段；思考文本归一为 thinking，OpenRouter 原生思考详情随块回放。
 * 缺少调用 ID 的旧式 function_call 不构成完整工具调用；共享入口负责重试与错误归一化。
 */

import OpenAI from "openai"

import type { ProtocolClientOptions } from "./adapter.ts"
import {
  assertRequestMatchesModel,
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
  runModelStream,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "./shared.ts"
import { convertChatCompletionsUsage } from "./usage.ts"
import type { ChatCompletionsUsageFields } from "./usage.ts"
import type {
  AssistantContentBlock,
  BlockType,
  ModelAdapter,
  ModelStreamOptions,
  ModelCompletion,
  ModelConfig,
  ModelMessage,
  ModelStreamEvent,
  ReplaySource,
  UnifiedModelRequest,
  UnifiedToolDefinition,
} from "./types.ts"

type ChatCompletionChunk = OpenAI.ChatCompletionChunk
type ChatCompletionMessageParam = OpenAI.ChatCompletionMessageParam
type ChatCompletionAssistantMessageParam = OpenAI.ChatCompletionAssistantMessageParam
type ChatCompletionToolMessageParam = OpenAI.ChatCompletionToolMessageParam
type ChatCompletionTool = OpenAI.ChatCompletionTool
type ChatCompletionCreateParamsStreaming = OpenAI.ChatCompletionCreateParamsStreaming

type AssistantToolCalls = NonNullable<ChatCompletionAssistantMessageParam["tool_calls"]>


/** 请求方向：统一上下文 → Chat Completions */


/**
 * 统一 `messages[1...]` → Chat Completions `messages`（不含系统消息）。
 *
 * 该协议的 content 是字符串，多块文本按顺序直接拼接、不添加分隔符（见 `./types.ts`）。
 * 没有正文、工具调用或原生思考回放的 assistant 消息不发送。
 *
 * @param messages 除首个 System Message 外的统一会话消息。
 * @param source 可选的 OpenRouter 原生思考来源；通用请求使用 reasoning_content。
 * @returns Chat Completions 消息数组。
 */
export function toChatCompletionsMessages(messages: ModelMessage[], source?: ReplaySource): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []
  const openRouter = isOpenRouterReplay(source)

  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (text.length > 0) result.push({ role: "user", content: text })
      continue
    }

    if (message.role === "assistant") {
      const text = joinAssistantText(message.content)
      const toolCalls = toAssistantToolCalls(message.content)
      const details = openRouter ? readOpenRouterReplay(message.content, source) : undefined
      if (text.length === 0 && toolCalls.length === 0 && details === undefined) continue

      const param: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        /** 无正文时使用 null。 */
        content: text.length > 0 ? text : null,
      }
      if (toolCalls.length > 0) param.tool_calls = toolCalls
      if (details !== undefined) {
        Object.assign(param, { reasoning_details: details })
      } else {
        const reasoning = message.content
          .filter((block) => block.type === "thinking")
          .map((block) => block.text).join("")
        if (reasoning.length > 0) {
          Object.assign(param, openRouter ? { reasoning } : { reasoning_content: reasoning })
        }
      }
      result.push(param)
      continue
    }

    if (message.role === "tool") {
      /** 工具结果只消费 text 块。 */
      const param: ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: joinTextBlocks(message.content),
      }
      result.push(param)
    }
  }

  return result
}

/**
 * 提取 assistant 正文；thinking 由消息转换写入单独的协议字段。
 *
 * @param blocks 统一 assistant 内容块。
 * @returns 按原顺序拼接的文本。
 */
function joinAssistantText(blocks: AssistantContentBlock[]): string {
  let text = ""
  for (const block of blocks) {
    if (block.type === "text") text += block.text
  }
  return text
}

/**
 * 提取 assistant 内容中的工具调用并映射为 Chat Completions 形状。
 *
 * @param blocks 统一 assistant 内容块。
 * @returns Chat Completions 工具调用数组。
 */
function toAssistantToolCalls(blocks: AssistantContentBlock[]): AssistantToolCalls {
  const toolCalls: AssistantToolCalls = []

  for (const block of blocks) {
    if (block.type !== "tool_call") continue
    toolCalls.push({
      id: block.toolCallId,
      type: "function",
      function: {
        name: block.name,
        /** 协议的 arguments 是 JSON 字符串。 */
        arguments: serializeToolCallArguments(block.arguments),
      },
    })
  }

  return toolCalls
}

/**
 * 将统一工具定义映射为 Chat Completions function tools。
 *
 * @param tools 统一工具定义。
 * @returns Chat Completions 工具定义数组。
 */
function toChatCompletionsTools(tools: UnifiedToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      /** 协议侧的字段名是 parameters，统一格式固定叫 inputSchema。 */
      parameters: tool.inputSchema,
    },
  }))
}

/**
 * 构建一次 Chat Completions 流式请求。
 *
 * 必须带 `stream_options.include_usage`：该协议默认不在流里返回 Usage，
 * 而权威 Usage 是 Adapter 的输出契约之一。
 *
 * @param request 待转换的统一模型请求。
 * @param config 当前 Adapter 绑定的完整模型配置，包含推理字段路径。
 * @param source 当前端点的原生思考来源；摘要请求使用通用文本转换。
 * @returns SDK 可接受的流式 Chat Completions 请求参数。
 * @throws `AppError` 当统一上下文或推理等级配置无效时抛出。
 */
export function buildChatCompletionsRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
  source?: ReplaySource,
): ChatCompletionCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)
  const historySource = request.context.purpose === "summary" ? undefined : source

  const params: ChatCompletionCreateParamsStreaming = {
    model: request.model.name,
    messages: [{ role: "system", content: system }, ...toChatCompletionsMessages(rest, historySource)],
    stream: true,
    stream_options: { include_usage: true },
  }

  if (tools.length > 0) {
    params.tools = toChatCompletionsTools(tools)
  }
  if (request.toolChoice === "none") params.tool_choice = "none"

  Object.assign(params, reasoningRequestFragment(request, config))

  return params
}


/** 响应方向：ChatCompletionChunk 流 → ModelStreamEvent */


/** 正在拼装的块。 */
interface PendingBlock {
  /** 统一流里的块序号，从 0 起连续。 */
  index: number
  blockType: BlockType
  /** 工具调用在协议流里的序号（`tool_calls[].index`）；文本与思考块为 -1。 */
  providerIndex: number
  /** 已收到的文本或 thinking 内容。 */
  text: string
  /** Chat Completions 工具调用 ID。非工具块为空字符串。 */
  toolCallId: string
  /** 已收到的工具名称分片拼接结果。 */
  name: string
  /** 已收到的工具参数 JSON 分片拼接结果。 */
  argumentsJson: string
}

/** 可读取的结构化思考分片，保留供应商附带的原始字段。 */
type ReasoningDetail = Record<string, unknown> & { type: "reasoning.text" | "reasoning.summary" | "reasoning.encrypted" }

/**
 * @param source Adapter 的原生历史策略。
 * @returns 来源名称和协议是否允许 OpenRouter 思考回放。
 */
function isOpenRouterReplay(source?: ReplaySource): source is ReplaySource {
  return source?.name === "openrouter" && source.protocol === "chat_completions"
}

/**
 * @param value 来自协议流或历史回放的 JSON 值。
 * @returns 是否为已知的结构化思考类型。
 */
function isReasoningDetail(value: unknown): value is ReasoningDetail {
  if (value === null || typeof value !== "object") return false
  const { type } = value as Record<string, unknown>
  return type === "reasoning.text" || type === "reasoning.summary" || type === "reasoning.encrypted"
}

/**
 * 取回当前 assistant 响应携带的完整思考详情。
 *
 * @param blocks 当前 assistant 消息的统一内容块。
 * @param source 允许回放的名称与协议。
 * @returns 来源匹配且有效的详情数组；缺失或损坏时由请求转换回退到明文。
 */
function readOpenRouterReplay(blocks: AssistantContentBlock[], source: ReplaySource): ReasoningDetail[] | undefined {
  for (const { replay } of blocks) {
    if (replay?.name !== source.name || replay.protocol !== source.protocol) continue
    try {
      const details: unknown = JSON.parse(replay.payloadJson)
      if (Array.isArray(details) && details.length > 0 && details.every(isReasoningDetail)) return details
    } catch {
      /** 回放无效时仍可发送通用思考文本。 */
    }
  }
  return undefined
}

/**
 * 按首次出现的顺序组装原生思考详情；同一详情的内容分片按到达顺序拼接。
 *
 * @param details 当前响应已累积的原生详情。
 * @param fragments 本次增量携带的详情分片。
 */
function appendReasoningDetails(details: ReasoningDetail[], fragments: ReasoningDetail[]): void {
  for (const fragment of fragments) {
    const current = details.find((detail) => {
      if (detail.type !== fragment.type) return false
      if (detail.format != null && fragment.format != null && detail.format !== fragment.format) return false
      if (detail.id != null && fragment.id != null && detail.id !== fragment.id) return false
      if (detail.index != null && fragment.index != null && detail.index !== fragment.index) return false
      return (typeof fragment.index === "number" && detail.index === fragment.index) ||
        (typeof fragment.id === "string" && detail.id === fragment.id)
    })
    if (current === undefined) {
      details.push({ ...fragment })
      continue
    }
    for (const [key, value] of Object.entries(fragment)) {
      const previous = current[key]
      if (!Object.hasOwn(current, key) || previous == null) {
        Object.defineProperty(current, key, { value, enumerable: true, writable: true, configurable: true })
      } else if ((key === "text" || key === "summary" || key === "signature" || key === "data") &&
        typeof previous === "string" && typeof value === "string") {
        current[key] = previous + value
      }
    }
  }
}

/**
 * 依次读取常见明文字段与结构化思考，避免把同一增量的多个表示重复输出。
 *
 * @param delta 协议 chunk 的增量对象。
 * @param details 本次增量携带的结构化思考。
 * @returns 可展示的思考文本，密文和签名只用于原生回放。
 */
function readReasoningDelta(delta: Record<string, unknown>, details: ReasoningDetail[]): string {
  for (const value of [delta.reasoning_content, delta.reasoning]) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return details.map((detail) => {
    const text = detail.type === "reasoning.text" ? detail.text : detail.type === "reasoning.summary" ? detail.summary : undefined
    return typeof text === "string" ? text : ""
  }).join("")
}

/**
 * 判断 Chat Completions chunk 是否报告过可用 Usage。
 *
 * @param fields 已累积的协议 Usage 字段。
 * @returns 至少包含输入、输出或总数任一字段时返回 `true`。
 */
function hasReportedUsage(fields: ChatCompletionsUsageFields): boolean {
  return (
    fields.prompt_tokens != null || fields.completion_tokens != null || fields.total_tokens != null
  )
}

/**
 * `finish_reason` → 统一完成状态。
 *
 * 只有"已结束的完整 tool_call"才算待执行；`function_call` 属已废弃形态，
 * 没有 id 时无法配对，因此不可能满足该条件。
 *
 * @param finishReason 协议返回的原始结束原因。
 * @param endedToolCalls 已完整收尾的工具调用数量。
 * @returns Runtime 使用的统一完成状态。
 */
function resolveCompletion(
  finishReason: string | undefined,
  endedToolCalls: number,
): ModelCompletion {
  switch (finishReason) {
    case "stop":
      return "finished"
    case "tool_calls":
    case "function_call":
      return endedToolCalls > 0 ? "tool_calls" : "unknown"
    case "length":
    case "content_filter":
      return "incomplete"
    default:
      return "unknown"
  }
}

/**
 * Chat Completions 协议流 → 统一流事件。
 *
 * 该协议没有显式结束事件，流结束即请求结束；`finish_reason` 缺失时完成状态取 unknown。
 * 一个 chunk 都没有就结束（空响应体）按中断处理，不产出 `stream_end`。
 *
 * 通道之间是严格顺序的：思考 / 文本 / 工具调用任一通道开始产出时，其它通道已打开的块先收尾。
 * 同一通道内并行工具调用（不同 `tool_calls[].index`）允许交错，块之间靠 index 区分。
 *
 * @param chunks Chat Completions SDK 产生的原始流 chunk。
 * @param source 可保存原生思考详情的 OpenRouter 来源。
 * @returns 按统一块协议产生的异步事件流。
 * @throws `Error` 当流为空时抛出中断错误。
 */
export async function* mapChatCompletionsStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
  source?: ReplaySource,
): AsyncGenerator<ModelStreamEvent> {
  const openBlocks: PendingBlock[] = []
  const toolCallBlocks = new Map<number, PendingBlock>()
  const reasoningDetails: ReasoningDetail[] = []
  let nextIndex = 0
  let thinkingBlock: PendingBlock | undefined
  let textBlock: PendingBlock | undefined
  let endedToolCalls = 0
  let finishReason: string | undefined
  let usageFields: ChatCompletionsUsageFields | undefined
  let sawChunk = false

  /**
   * 为协议通道分配统一序号并开始累积内容。
   *
   * @param blockType 统一块类型。
   * @param providerIndex 协议工具调用序号；文本与 thinking 使用 -1。
   * @returns 新建的待收尾块状态。
   */
  function openBlock(blockType: BlockType, providerIndex: number): PendingBlock {
    const block: PendingBlock = {
      index: nextIndex,
      blockType,
      providerIndex,
      text: "",
      toolCallId: "",
      name: "",
      argumentsJson: "",
    }
    nextIndex += 1
    openBlocks.push(block)
    if (blockType === "thinking") thinkingBlock = block
    if (blockType === "text") textBlock = block
    if (blockType === "tool_call") toolCallBlocks.set(providerIndex, block)
    return block
  }

  /**
   * 收尾一个块并从打开状态中移除。
   *
   * @param block 待收尾的块状态。
   * @returns 对应的统一 block_end 事件。
   */
  function endBlock(block: PendingBlock): ModelStreamEvent {
    const position = openBlocks.indexOf(block)
    if (position >= 0) openBlocks.splice(position, 1)

    if (block.blockType === "thinking") thinkingBlock = undefined
    if (block.blockType === "text") textBlock = undefined

    if (block.blockType === "tool_call") {
      toolCallBlocks.delete(block.providerIndex)
      endedToolCalls += 1
      return {
        type: "block_end",
        index: block.index,
        block: {
          type: "tool_call",
          toolCallId: block.toolCallId,
          name: block.name,
          arguments: parseToolCallArguments(block.argumentsJson),
        },
      }
    }

    return {
      type: "block_end",
      index: block.index,
      block: { type: block.blockType, text: block.text },
    }
  }

  /**
   * 收尾所有不属于 `channel` 的已打开块，按 index 升序。
   *
   * @param channel 当前即将接收增量的通道。
   * @returns 其它通道的 block_end 事件。
   */
  function closeOtherChannels(channel: BlockType): ModelStreamEvent[] {
    const pending = openBlocks
      .filter((block) => block.blockType !== channel)
      .sort((a, b) => a.index - b.index)
    return pending.map(endBlock)
  }

  /**
   * 流结束时的收尾。
   *
   * 文本与思考块总是收尾：内容就是已累积到的增量，被截断时也应保留。
   *
   * 工具调用只在本次请求以工具调用正常结束时收尾。该协议没有显式的块结束事件，
   * `finish_reason` 是这里唯一的完整性信号（不能用统一完成状态来判断：
   * 那个状态本身要等工具调用收尾后才算得出来）。被 `length` 截断的工具调用参数
   * 可能只传了一半，产出 `block_end` 会让 AgentLoop 把它当成完整调用
   * 。
   *
   * @returns 根据结束原因收尾后的统一 block_end 事件。
   */
  function flushBlocks(): ModelStreamEvent[] {
    const toolCallsComplete = finishReason === "tool_calls" || finishReason === "function_call"
    const pending = openBlocks
      .filter((block) => toolCallsComplete || block.blockType !== "tool_call")
      .sort((a, b) => a.index - b.index)
    return pending.map(endBlock)
  }

  for await (const chunk of chunks) {
    sawChunk = true
    if (chunk.usage != null) usageFields = chunk.usage

    const choice = chunk.choices[0]
    if (choice === undefined) continue
    if (choice.finish_reason != null) finishReason = choice.finish_reason

    const delta = choice.delta

    const extensions = delta as Record<string, unknown>
    const rawDetails = extensions.reasoning_details
    const details = Array.isArray(rawDetails) ? rawDetails.filter(isReasoningDetail) : []
    if (isOpenRouterReplay(source)) appendReasoningDetails(reasoningDetails, details)

    const reasoning = readReasoningDelta(extensions, details)
    if (reasoning.length > 0) {
      for (const event of closeOtherChannels("thinking")) yield event
      if (thinkingBlock === undefined) {
        thinkingBlock = openBlock("thinking", -1)
        yield { type: "block_start", index: thinkingBlock.index, blockType: "thinking" }
      }
      const block = thinkingBlock
      block.text += reasoning
      yield {
        type: "block_delta",
        index: block.index,
        delta: { type: "thinking", text: reasoning },
      }
    }

    /** refusal 是拒绝回答的正文，统一格式没有独立表达，按 text 块发出去，不丢内容。 */
    const text = delta.content ?? delta.refusal ?? undefined
    if (typeof text === "string" && text.length > 0) {
      for (const event of closeOtherChannels("text")) yield event
      if (textBlock === undefined) {
        textBlock = openBlock("text", -1)
        yield { type: "block_start", index: textBlock.index, blockType: "text" }
      }
      const block = textBlock
      block.text += text
      yield { type: "block_delta", index: block.index, delta: { type: "text", text } }
    }

    if (delta.tool_calls !== undefined && delta.tool_calls.length > 0) {
      for (const event of closeOtherChannels("tool_call")) yield event

      for (const call of delta.tool_calls) {
        let block = toolCallBlocks.get(call.index)
        if (block === undefined) {
          block = openBlock("tool_call", call.index)
          yield { type: "block_start", index: block.index, blockType: "tool_call" }
        }

        if (call.id != null) block.toolCallId = call.id

        /** 工具名按分片累积：协议允许 name 分片到达。 */
        const nameDelta = call.function?.name
        if (nameDelta !== undefined && nameDelta.length > 0) {
          block.name += nameDelta
          yield {
            type: "block_delta",
            index: block.index,
            delta: { type: "tool_call", toolCallId: block.toolCallId, nameDelta },
          }
        }

        const argumentsDelta = call.function?.arguments
        if (argumentsDelta !== undefined && argumentsDelta.length > 0) {
          block.argumentsJson += argumentsDelta
          yield {
            type: "block_delta",
            index: block.index,
            delta: { type: "tool_call", toolCallId: block.toolCallId, argumentsDelta },
          }
        }
      }
    }
  }

  if (!sawChunk) throw streamInterruptedError("chat_completions")

  const finalBlocks = flushBlocks()
  const completion = resolveCompletion(finishReason, endedToolCalls)
  if (isOpenRouterReplay(source) && reasoningDetails.length > 0 &&
    (completion === "finished" || completion === "tool_calls")) {
    /** 回放属于整条消息，附到最后一个块上，避免尾部签名打断正文或工具分片。 */
    if (finalBlocks.length === 0) {
      const block = openBlock("thinking", -1)
      yield { type: "block_start", index: block.index, blockType: "thinking" }
      finalBlocks.push(endBlock(block))
    }
    const lastBlock = finalBlocks.at(-1)
    if (lastBlock?.type === "block_end") {
      lastBlock.block.replay = { name: source.name, protocol: source.protocol, payloadJson: JSON.stringify(reasoningDetails) }
    }
  }
  for (const event of finalBlocks) yield event

  yield {
    type: "stream_end",
    completion,
    ...(usageFields !== undefined && hasReportedUsage(usageFields)
      ? { usage: convertChatCompletionsUsage(usageFields) }
      : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
  }
}


/** Adapter */


/**
 * 创建 Chat Completions Adapter。
 *
 * 与 Anthropic 一样关闭 SDK 自身的重试（`maxRetries: 0`），重试统一由 `runtime/network/` 负责，
 * 否则一次逻辑请求会被两层重试各自放大。
 *
 * @param config 要绑定的 Chat Completions 模型配置。
 * @param options OpenAI SDK 客户端的凭据、地址和额外请求头。
 * @returns 已绑定配置并负责流式请求的 Chat Completions Adapter。
 */
export function createChatCompletionsAdapter(
  config: ModelConfig,
  options: ProtocolClientOptions,
): ModelAdapter {
  const { nativeHistory } = options
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders: options.defaultHeaders,
    maxRetries: 0,
  })

  /**
   * 执行一次绑定模型的 Chat Completions 流式请求，并统一处理重试与错误归一化。
   *
   * @param request 当前统一模型请求。
   * @param signal 调用方的取消信号。
   * @param options 此次调用的 SDK 超时与网络重试选项。
   * @returns Chat Completions 响应转换后的统一模型事件流。
   * @throws `AppError` 请求校验失败、协议请求失败或取消时抛出。
   */
  async function* stream(
    request: UnifiedModelRequest,
    signal: AbortSignal,
    options?: ModelStreamOptions,
  ): AsyncGenerator<ModelStreamEvent> {
    /** 校验与请求构建在迭代时抛出：AgentLoop 只需在一处处理 Adapter 的错误。 */
    assertRequestMatchesModel(request, config)
    const params = buildChatCompletionsRequest(request, config, nativeHistory)
    const source = request.context.purpose === "summary" ? undefined : nativeHistory

    yield* runModelStream((attemptSignal) => {
      return mapChatCompletionsStream(requestChatCompletionsStream(client, params, attemptSignal, options?.timeoutMs), source)
    }, signal, options?.retry)
  }

  return { stream }
}

/**
 * 发起一次真实请求并逐个产出协议 chunk；取消由 SDK 的 `signal` 传递。
 *
 * @param client OpenAI SDK 客户端。
 * @param params 已构建的流式请求参数。
 * @param signal 当前请求尝试的取消信号。
 * @param timeout SDK 超时毫秒数；省略时沿用默认值。
 * @returns 原始 Chat Completions chunk 异步生成器。
 * @throws SDK 请求失败或取消时抛出底层异常。
 */
async function* requestChatCompletionsStream(
  client: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  signal: AbortSignal,
  timeout?: number,
): AsyncGenerator<ChatCompletionChunk> {
  const stream = await client.chat.completions.create(params, { signal, ...(timeout === undefined ? {} : { timeout }) })
  for await (const chunk of stream) yield chunk
}
