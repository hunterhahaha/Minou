/**
 * Anthropic Messages Adapter（第 6 节，TODOList 阶段 3）。
 *
 * 两个方向都在本文件里，便于对照阅读：
 *   - 请求方向：统一上下文 → `system` + `messages`（`tool_use` 在 assistant content，
 *     `tool_result` 在 user content，靠 `tool_use_id` 配对）；
 *   - 响应方向：`RawMessageStreamEvent` → `ModelStreamEvent`。
 *
 * 协议侧参考：.git/技术文档/三个协议调用时传入的上下文示例.md 第 1 节。
 * 架构依据：开发备忘录第 6 节（模型协议层）、第 7 节（网络层）、第 8.4 / 8.5 节（流事件与完成态）、
 *          第 11.1 / 11.3 节（System Message 与回放）、第 16.2 节（工具结果只消费 text）、第 25 节（错误）
 * 设计文档：.git/技术文档/NiCode_Usage统一设计.md 第 2 节（Usage 映射）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 3
 *
 * 本文件的三条实现决定（均为文档未规定处，已在阶段报告中单列）：
 *   1. `max_tokens` 取 `ModelConfig.maxOutputTokens`，缺失时用
 *      `DEFAULT_MAX_OUTPUT_TOKENS`（Anthropic 必填，取值依据见 `./adapter.ts`）。
 *   2. 回放 assistant 历史时跳过 `thinking` 块：统一内容块只有 `text`，
 *      而 Anthropic 的 thinking 块回放必须带 `signature`，凑不出合法块。
 *   3. 协议里没有统一表达能力的块（`redacted_thinking`、`server_tool_use`、
 *      各种 server tool result 等）不进入统一流，其 index 被忽略。
 */

import Anthropic from "@anthropic-ai/sdk"

import type { ProtocolClientOptions } from "./adapter.ts"
import {
  assertRequestMatchesModel,
  joinTextBlocks,
  parseToolCallArguments,
  resolveToolCallInput,
  runModelStream,
  serializeToolCallArguments,
  splitSystemMessage,
  streamInterruptedError,
} from "./shared.ts"
import { convertAnthropicUsage } from "./usage.ts"
import type { AnthropicUsageFields } from "./usage.ts"
import type {
  AssistantContentBlock,
  BlockType,
  ModelAdapter,
  ModelCompletion,
  ModelConfig,
  ModelMessage,
  ModelStreamEvent,
  ModelTextBlock,
  UnifiedModelRequest,
  UnifiedToolDefinition,
} from "./types.ts"

// SDK 的协议类型都挂在 `Anthropic.Messages` 命名空间下，这里逐个取别名，
// 让函数签名保持可读（注意命名空间本身不能别名为类型）。
type MessageParam = Anthropic.Messages.MessageParam
type ContentBlockParam = Anthropic.Messages.ContentBlockParam
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam
type ToolUnion = Anthropic.Messages.ToolUnion
type RawMessageStreamEvent = Anthropic.Messages.RawMessageStreamEvent
type MessageCreateParamsStreaming = Anthropic.Messages.MessageCreateParamsStreaming
type ToolInputSchema = Anthropic.Messages.Tool.InputSchema

/**
 * Anthropic Messages 的默认 `max_tokens`。
 *
 * `ModelConfig.maxOutputTokens` 是可选的，而该协议的 `max_tokens` 是必填的，
 * 因此必须有一个兜底值。4096 取自协议上下文示例（`.git/技术文档/三个协议调用时传入的上下文示例.md`）。
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096

// ---------------------------------------------------------------------------
// 请求方向：统一上下文 → Anthropic Messages
// ---------------------------------------------------------------------------

/** 统一 user content → Anthropic 文本块，空文本块不发送。 */
function toUserContent(content: string | ModelTextBlock[]): ModelTextBlock[] {
  const blocks: ModelTextBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content
  return blocks.filter((block) => block.text.length > 0)
}

/**
 * 统一 assistant content → Anthropic content。
 *
 * `thinking` 被跳过，原因见文件头第 2 条。
 */
function toAssistantContent(blocks: AssistantContentBlock[]): ContentBlockParam[] {
  const content: ContentBlockParam[] = []

  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) content.push({ type: "text", text: block.text })
      continue
    }

    if (block.type === "tool_call") {
      content.push({
        type: "tool_use",
        id: block.toolCallId,
        name: block.name,
        input: resolveToolCallInput(block.arguments),
      })
    }
  }

  return content
}

/** 判断上一条消息是否由工具结果拼成，用于合并连续的 tool 结果。 */
function isToolResultMessage(message: MessageParam): boolean {
  if (message.role !== "user" || typeof message.content === "string") return false
  return message.content[0]?.type === "tool_result"
}

/**
 * 统一 `messages[1...]` → Anthropic `messages`。
 *
 * 两个协议特有的约束：
 *   - `tool_result` 必须放在 user 消息的 content 里，不能单独成消息，因此连续的 tool 结果
 *     合并进同一个 user 消息，保证 tool_use / tool_result 的配对顺序不变（第 11.3 节）；
 *   - content 不能为空数组，因此空文本、只剩 thinking 的 assistant 消息直接跳过。
 */
export function toAnthropicMessages(messages: ModelMessage[]): MessageParam[] {
  const result: MessageParam[] = []

  for (const message of messages) {
    if (message.role === "user") {
      const content = toUserContent(message.content)
      if (content.length > 0) result.push({ role: "user", content })
      continue
    }

    if (message.role === "assistant") {
      const content = toAssistantContent(message.content)
      if (content.length > 0) result.push({ role: "assistant", content })
      continue
    }

    if (message.role === "tool") {
      // 工具结果只消费 text 块（第 16.2 节）。
      const block: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: joinTextBlocks(message.content),
      }
      if (message.isError) block.is_error = true

      const last = result[result.length - 1]
      if (last !== undefined && isToolResultMessage(last)) {
        ;(last.content as ContentBlockParam[]).push(block)
      } else {
        result.push({ role: "user", content: [block] })
      }
    }
  }

  return result
}

function toAnthropicTools(tools: UnifiedToolDefinition[]): ToolUnion[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // 统一格式固定 inputSchema 为 JSON Schema，字段名差异只在这里出现（第 6 节）。
    input_schema: tool.inputSchema as ToolInputSchema,
  }))
}

/**
 * 构建一次 Anthropic Messages 流式请求。
 *
 * `system` 取 `messages[0]`；`tools` 为空时不传该字段（协议不接受空数组）。
 */
export function buildAnthropicRequest(
  request: UnifiedModelRequest,
  maxOutputTokens: number,
): MessageCreateParamsStreaming {
  const { system, rest } = splitSystemMessage(request)

  const params: MessageCreateParamsStreaming = {
    model: request.model.modelId,
    max_tokens: maxOutputTokens,
    system,
    messages: toAnthropicMessages(rest),
    stream: true,
  }

  if (request.tools.length > 0) {
    params.tools = toAnthropicTools(request.tools)
  }

  return params
}

// ---------------------------------------------------------------------------
// 响应方向：RawMessageStreamEvent → ModelStreamEvent
// ---------------------------------------------------------------------------

/** 正在拼装的块：Anthropic 的块只有增量，`block_end` 需要自己累积出的完整内容。 */
interface PendingBlock {
  /** 统一流里的块序号，从 0 起连续（协议侧的 content block index 不直接透出）。 */
  index: number
  blockType: BlockType
  text: string
  toolCallId: string
  name: string
  argumentsJson: string
}

/** `message_delta.usage` 是累计值，用非 null 的新值覆盖 `message_start` 的旧值。 */
function pickCount(
  next: number | null | undefined,
  previous: number | null | undefined,
): number | undefined {
  if (next !== null && next !== undefined) return next
  if (previous !== null && previous !== undefined) return previous
  return undefined
}

function mergeAnthropicUsage(
  previous: AnthropicUsageFields,
  next: AnthropicUsageFields,
): AnthropicUsageFields {
  const merged: AnthropicUsageFields = {
    input_tokens: pickCount(next.input_tokens, previous.input_tokens),
    output_tokens: pickCount(next.output_tokens, previous.output_tokens),
    cache_read_input_tokens: pickCount(
      next.cache_read_input_tokens,
      previous.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: pickCount(
      next.cache_creation_input_tokens,
      previous.cache_creation_input_tokens,
    ),
  }

  const thinkingTokens = pickCount(
    next.output_tokens_details?.thinking_tokens,
    previous.output_tokens_details?.thinking_tokens,
  )
  if (thinkingTokens !== undefined) merged.output_tokens_details = { thinking_tokens: thinkingTokens }

  return merged
}

function hasReportedUsage(fields: AnthropicUsageFields): boolean {
  return (
    fields.input_tokens != null ||
    fields.output_tokens != null ||
    fields.cache_read_input_tokens != null ||
    fields.cache_creation_input_tokens != null ||
    fields.output_tokens_details?.thinking_tokens != null
  )
}

/**
 * `stop_reason` → 统一完成状态（第 8.5 节）。
 *
 * 只有"已结束的完整 tool_call"才算待执行：`tool_use` 但没有任何 `content_block_stop` 过的
 * tool_call 块时不能报 `tool_calls`。`pause_turn` 等其它取值按 unknown 处理，
 * 不凭文本存在推断 finished（第 8.5 节）。
 */
function resolveCompletion(
  stopReason: string | undefined,
  endedToolCalls: number,
): ModelCompletion {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "refusal":
      return "finished"
    case "tool_use":
      return endedToolCalls > 0 ? "tool_calls" : "unknown"
    case "max_tokens":
    case "model_context_window_exceeded":
      return "incomplete"
    default:
      return "unknown"
  }
}

/**
 * Anthropic 协议流 → 统一流事件。
 *
 * 与 SDK 解耦的纯转换，便于离线验证；真正的网络与取消由 `createAnthropicAdapter` 接上。
 * 流在 `message_stop` 之前结束（连接被截断等）时抛错，不产出 `stream_end`。
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  /** key 是协议侧的 content block index；不在表里表示该 index 已被忽略。 */
  const blocks = new Map<number, PendingBlock>()
  let nextIndex = 0
  let endedToolCalls = 0
  let usageFields: AnthropicUsageFields = {}
  let stopReason: string | undefined
  let sawMessageStop = false

  function openBlock(protocolIndex: number, blockType: BlockType): PendingBlock {
    const block: PendingBlock = {
      index: nextIndex,
      blockType,
      text: "",
      toolCallId: "",
      name: "",
      argumentsJson: "",
    }
    nextIndex += 1
    blocks.set(protocolIndex, block)
    return block
  }

  /** 收尾一个块：产出 block_end 并移出拼装表。 */
  function closeBlock(protocolIndex: number): ModelStreamEvent | undefined {
    const block = blocks.get(protocolIndex)
    if (block === undefined) return undefined
    blocks.delete(protocolIndex)

    if (block.blockType === "tool_call") {
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
   * `message_stop` 时收尾仍未结束的 thinking / text 块。
   *
   * 文本与思考的内容是随增量累积的，此处产出的就是已收到的全部内容（被 `max_tokens`
   * 截断时也应当保留）。
   *
   * **未结束的 tool_call 不在这里收尾**：它意味着参数可能只传了一半，产出 `block_end`
   * 会让 AgentLoop 把它当成完整调用（第 8.5 节："未结束的 tool_call 不进入消息"）。
   * 不产出 `block_end` 时该块自然不进 `assistant/message`，也不会被执行。
   */
  function flushTextBlocks(): ModelStreamEvent[] {
    const pending = [...blocks.entries()]
      .filter(([, block]) => block.blockType !== "tool_call")
      .sort((a, b) => a[1].index - b[1].index)

    return pending
      .map(([protocolIndex]) => closeBlock(protocolIndex))
      .filter((event): event is ModelStreamEvent => event !== undefined)
  }

  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        usageFields = mergeAnthropicUsage(usageFields, event.message.usage)
        break
      }

      case "content_block_start": {
        const content = event.content_block

        if (content.type === "text" || content.type === "thinking") {
          const blockType: BlockType = content.type
          const text = content.type === "text" ? content.text : content.thinking
          const block = openBlock(event.index, blockType)
          yield { type: "block_start", index: block.index, blockType }
          // 起始事件里已经带文本时补一条增量，避免增量之和与 block_end 的内容不一致。
          if (text.length > 0) {
            block.text += text
            yield {
              type: "block_delta",
              index: block.index,
              delta: { type: blockType, text },
            }
          }
          break
        }

        if (content.type === "tool_use") {
          const block = openBlock(event.index, "tool_call")
          block.toolCallId = content.id
          block.name = content.name
          // 非流式给出 input 时（空对象是常态）把它当作已拼装的参数起点。
          if (hasKeys(content.input)) block.argumentsJson = serializeToolCallArguments(content.input)

          yield { type: "block_start", index: block.index, blockType: "tool_call" }
          // 先给出 id 与 name：下游不必等到第一个参数增量才知道调用的是哪个工具。
          yield {
            type: "block_delta",
            index: block.index,
            delta: { type: "tool_call", toolCallId: block.toolCallId, nameDelta: block.name },
          }
          break
        }

        // 其余块类型（redacted_thinking / server_tool_use / 各类 server tool result 等）
        // 没有统一表达，忽略该 index 的后续增量与结束事件。
        break
      }

      case "content_block_delta": {
        const block = blocks.get(event.index)
        if (block === undefined) break

        const delta = event.delta
        if (delta.type === "text_delta" && block.blockType === "text") {
          block.text += delta.text
          yield { type: "block_delta", index: block.index, delta: { type: "text", text: delta.text } }
          break
        }

        if (delta.type === "thinking_delta" && block.blockType === "thinking") {
          block.text += delta.thinking
          yield {
            type: "block_delta",
            index: block.index,
            delta: { type: "thinking", text: delta.thinking },
          }
          break
        }

        if (delta.type === "input_json_delta" && block.blockType === "tool_call") {
          block.argumentsJson += delta.partial_json
          yield {
            type: "block_delta",
            index: block.index,
            delta: {
              type: "tool_call",
              toolCallId: block.toolCallId,
              argumentsDelta: delta.partial_json,
            },
          }
          break
        }

        // signature_delta / citations_delta：统一格式没有对应表达，忽略。
        break
      }

      case "content_block_stop": {
        const closed = closeBlock(event.index)
        if (closed !== undefined) yield closed
        break
      }

      case "message_delta": {
        usageFields = mergeAnthropicUsage(usageFields, event.usage)
        if (event.delta.stop_reason !== null) stopReason = event.delta.stop_reason
        break
      }

      case "message_stop": {
        sawMessageStop = true
        for (const flushed of flushTextBlocks()) yield flushed
        yield {
          type: "stream_end",
          completion: resolveCompletion(stopReason, endedToolCalls),
          ...(hasReportedUsage(usageFields) ? { usage: convertAnthropicUsage(usageFields) } : {}),
          ...(stopReason !== undefined ? { finishReason: stopReason } : {}),
        }
        break
      }

      default:
        break
    }
  }

  if (!sawMessageStop) throw streamInterruptedError("anthropic_messages")
}

function hasKeys(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * 创建 Anthropic Messages Adapter。
 *
 * `config` 提供一个具体模型的配置：请求里的 `model` 用它校验，`max_tokens` 用它取默认值。
 * SDK 自身的重试被关闭（`maxRetries: 0`），重试统一由 `runtime/network/` 负责，
 * 否则一次逻辑请求会被两层重试各自放大（第 7 节）。
 */
export function createAnthropicAdapter(
  config: ModelConfig,
  options: ProtocolClientOptions,
): ModelAdapter {
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders: options.defaultHeaders,
    maxRetries: 0,
  })
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS

  async function* stream(
    request: UnifiedModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent> {
    // 校验与请求构建在迭代时抛出：AgentLoop 只需在一处处理 Adapter 的错误。
    assertRequestMatchesModel(request, config)
    const params = buildAnthropicRequest(request, maxOutputTokens)

    yield* runModelStream((attemptSignal) => {
      return mapAnthropicStream(requestAnthropicStream(client, params, attemptSignal))
    }, signal)
  }

  return { stream }
}

/** 发起一次真实请求并逐个产出协议事件；取消由 SDK 的 `signal` 传递（第 6 节）。 */
async function* requestAnthropicStream(
  client: Anthropic,
  params: MessageCreateParamsStreaming,
  signal: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
  const stream = await client.messages.create(params, { signal })
  for await (const event of stream) yield event
}
