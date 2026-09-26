/**
 * Chat Completions Adapter（第 6 节，TODOList 阶段 4）。
 *
 * 两个方向都在本文件里：
 *   - 请求方向：统一上下文 → `messages`（系统指令在最前，`tool_calls` 在 assistant 消息，
 *     工具结果是独立的 `role: "tool"` 消息，靠 `tool_call_id` 配对）；
 *   - 响应方向：`ChatCompletionChunk` 流 → `ModelStreamEvent`。
 *
 * 协议侧参考：.git/技术文档/三个协议调用时传入的上下文示例.md 第 2 节。
 * 架构依据：开发备忘录第 6 节（模型协议层）、第 7 节（网络层）、第 8.4 / 8.5 节、
 *          第 11.1 / 11.3 节、第 16.2 节（工具结果只消费 text）、第 25 节（错误）
 * 设计文档：.git/技术文档/NiCode_Usage统一设计.md 第 3 节（Usage 映射，含兼容字段读取）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 4
 *
 * 本文件的四条实现决定（均为文档未规定处，已在阶段报告中单列）：
 *   1. 系统消息用 `system` 而不是 `developer`：示例文档两个都提过，但 `system` 是
 *      各兼容厂商的公共子集，NiCode 的 Provider 可以是任意 baseURL。
 *   2. 不发送 `max_tokens` / `max_completion_tokens`：两者在不同 Provider 上互不兼容
 *      （新推理模型要求改名后的 `max_completion_tokens`），config 结构未定，
 *      先由 Provider 默认值决定输出上限。
 *   3. thinking 增量读取厂商扩展字段 `reasoning_content` / `reasoning`（字符串）：
 *      该协议本身没有思考通道，统一 thinking 块只能来自这里。
 *   4. 已废弃且不带 id 的 `delta.function_call` 不转换为 tool_call：统一块必须有
 *      `toolCallId`，缺失时无法与工具结果配对，该种结束原因按 unknown 处理。
 */

import OpenAI from "openai"

import type { ProtocolClientOptions } from "./adapter.ts"
import {
  assertRequestMatchesModel,
  joinTextBlocks,
  parseToolCallArguments,
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
  ModelCompletion,
  ModelConfig,
  ModelMessage,
  ModelStreamEvent,
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

// ---------------------------------------------------------------------------
// 请求方向：统一上下文 → Chat Completions
// ---------------------------------------------------------------------------

/**
 * 统一 `messages[1...]` → Chat Completions `messages`（不含系统消息）。
 *
 * 该协议的 content 是字符串，多块文本按顺序直接拼接、不添加分隔符（见 `./types.ts`）。
 * content 为空且没有 tool_call 的 assistant 消息、以及空文本消息都不发送。
 *
 * @param messages 除首个 System Message 外的统一会话消息。
 * @returns Chat Completions 消息数组。
 */
export function toChatCompletionsMessages(messages: ModelMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

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
      if (text.length === 0 && toolCalls.length === 0) continue

      const param: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        // 只有工具调用时 content 必须是 null，不能是空字符串。
        content: text.length > 0 ? text : null,
      }
      if (toolCalls.length > 0) param.tool_calls = toolCalls
      result.push(param)
      continue
    }

    if (message.role === "tool") {
      // 工具结果只消费 text 块（第 16.2 节）。
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
 * assistant 消息的文本部分：thinking 块不回放（协议没有对应的回传位置）。
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
        // 协议的 arguments 是 JSON 字符串。
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
      // 协议侧的字段名是 parameters，统一格式固定叫 inputSchema。
      parameters: tool.inputSchema,
    },
  }))
}

/**
 * 构建一次 Chat Completions 流式请求。
 *
 * 必须带 `stream_options.include_usage`：该协议默认不在流里返回 Usage，
 * 而权威 Usage 是 Adapter 的输出契约之一（第 8.5、27.1 节）。
 *
 * @param request 待转换的统一模型请求。
 * @returns SDK 可接受的流式 Chat Completions 请求参数。
 * @throws `AppError` 当统一上下文缺少首个 System Message 或包含多个 System Message 时抛出。
 */
export function buildChatCompletionsRequest(
  request: UnifiedModelRequest,
): ChatCompletionCreateParamsStreaming {
  const { system, rest } = splitSystemMessage(request)

  const params: ChatCompletionCreateParamsStreaming = {
    model: request.model.name,
    messages: [{ role: "system", content: system }, ...toChatCompletionsMessages(rest)],
    stream: true,
    stream_options: { include_usage: true },
  }

  if (request.tools.length > 0) {
    params.tools = toChatCompletionsTools(request.tools)
  }

  return params
}

// ---------------------------------------------------------------------------
// 响应方向：ChatCompletionChunk 流 → ModelStreamEvent
// ---------------------------------------------------------------------------

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

/**
 * 读取兼容厂商的思考增量。
 *
 * 该协议没有思考通道，各兼容厂商把它放在 `reasoning_content`（DeepSeek 系）或
 * `reasoning`（OpenRouter 系）上，且都可能是非字符串结构，因此只接受字符串。
 *
 * @param delta 协议 chunk 的未知增量对象。
 * @returns 非空思考文本；没有可用字符串时返回 `undefined`。
 */
function readReasoningDelta(delta: unknown): string | undefined {
  const record = delta as Record<string, unknown>
  const value = record["reasoning_content"] ?? record["reasoning"]
  return typeof value === "string" && value.length > 0 ? value : undefined
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
 * `finish_reason` → 统一完成状态（第 8.5 节）。
 *
 * 只有"已结束的完整 tool_call"才算待执行；`function_call` 属已废弃形态，
 * 没有 id 时无法配对（见文件头第 4 条），因此不可能满足该条件。
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
 * @returns 按统一块协议产生的异步事件流。
 * @throws `Error` 当流为空时抛出中断错误。
 */
export async function* mapChatCompletionsStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ModelStreamEvent> {
  const openBlocks: PendingBlock[] = []
  const toolCallBlocks = new Map<number, PendingBlock>()
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
   * （第 8.5 节："未结束的 tool_call 不进入消息"）。
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

    const reasoning = readReasoningDelta(delta)
    if (reasoning !== undefined) {
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

    // refusal 是拒绝回答的正文，统一格式没有独立表达，按 text 块发出去，不丢内容。
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

        // 工具名按分片累积：协议允许 name 分片到达。
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

  for (const event of flushBlocks()) yield event

  yield {
    type: "stream_end",
    completion: resolveCompletion(finishReason, endedToolCalls),
    ...(usageFields !== undefined && hasReportedUsage(usageFields)
      ? { usage: convertChatCompletionsUsage(usageFields) }
      : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * 创建 Chat Completions Adapter。
 *
 * 与 Anthropic 一样关闭 SDK 自身的重试（`maxRetries: 0`），重试统一由 `runtime/network/` 负责，
 * 否则一次逻辑请求会被两层重试各自放大（第 7 节）。
 *
 * @param config 要绑定的 Chat Completions 模型配置。
 * @param options OpenAI SDK 客户端的凭据、地址和额外请求头。
 * @returns 已绑定配置并负责流式请求的 Chat Completions Adapter。
 */
export function createChatCompletionsAdapter(
  config: ModelConfig,
  options: ProtocolClientOptions,
): ModelAdapter {
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
   * @returns Chat Completions 响应转换后的统一模型事件流。
   * @throws `AppError` 请求校验失败、协议请求失败或取消时抛出。
   */
  async function* stream(
    request: UnifiedModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent> {
    // 校验与请求构建在迭代时抛出：AgentLoop 只需在一处处理 Adapter 的错误。
    assertRequestMatchesModel(request, config)
    const params = buildChatCompletionsRequest(request)

    yield* runModelStream((attemptSignal) => {
      return mapChatCompletionsStream(requestChatCompletionsStream(client, params, attemptSignal))
    }, signal)
  }

  return { stream }
}

/**
 * 发起一次真实请求并逐个产出协议 chunk；取消由 SDK 的 `signal` 传递（第 6 节）。
 *
 * @param client OpenAI SDK 客户端。
 * @param params 已构建的流式请求参数。
 * @param signal 当前请求尝试的取消信号。
 * @returns 原始 Chat Completions chunk 异步生成器。
 * @throws SDK 请求失败或取消时抛出底层异常。
 */
async function* requestChatCompletionsStream(
  client: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  signal: AbortSignal,
): AsyncGenerator<ChatCompletionChunk> {
  const stream = await client.chat.completions.create(params, { signal })
  for await (const chunk of stream) yield chunk
}
