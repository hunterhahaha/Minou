/**
 * Anthropic Messages 的请求与统一流事件转换。
 *
 * 请求映射 system、messages、tool_use 与 tool_result；max_tokens 使用模型最大输出配置。
 * 启用兼容规则时回放完整原生历史，在签名边界之后发送内联工具变更。
 * SDK 自动重试关闭，流请求通过共享入口处理重试、取消与错误归一化。
 */

import Anthropic from "@anthropic-ai/sdk"

import type { NativeHistoryPolicy, ProtocolClientOptions } from "./adapter.ts"
import {
  applyHistoryToolChange,
  assertRequestMatchesModel,
  historyMessage,
  invalidRequest,
  joinTextBlocks,
  parseToolCallArguments,
  reasoningRequestFragment,
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
  ModelStreamOptions,
  ModelCompletion,
  ModelConfig,
  ModelMessage,
  ModelHistory,
  ReplaySource,
  ModelStreamEvent,
  ModelTextBlock,
  UnifiedModelRequest,
  UnifiedToolDefinition,
} from "./types.ts"

/** SDK 的协议类型都挂在 `Anthropic.Messages` 命名空间下，这里逐个取别名， */
/** 让函数签名保持可读（注意命名空间本身不能别名为类型）。 */
type MessageParam = Anthropic.Messages.MessageParam
type ContentBlockParam = Anthropic.Messages.ContentBlockParam
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam
type ToolUnion = Anthropic.Messages.ToolUnion
type RawMessageStreamEvent = Anthropic.Messages.RawMessageStreamEvent
type MessageCreateParamsStreaming = Anthropic.Messages.MessageCreateParamsStreaming
type ToolInputSchema = Anthropic.Messages.Tool.InputSchema
type NativeBlock = Extract<Anthropic.Messages.RawContentBlockStartEvent["content_block"],
  { type: "text" | "thinking" | "redacted_thinking" | "tool_use" }>
type InlineToolBlock =
  | { type: "tool_addition"; tool: { type: "tool_definition"; definition: ToolUnion } }
  | { type: "tool_removal"; tool: { type: "tool_reference"; name: string } }
type AnthropicRequest = Omit<MessageCreateParamsStreaming, "messages"> & {
  messages: Array<MessageParam | { role: "system"; content: InlineToolBlock[] }>
}
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15"


/** 请求方向：统一上下文 → Anthropic Messages */


/**
 * 统一 user content → Anthropic 文本块，空文本块不发送。
 *
 * @param content 统一格式的用户字符串或文本块数组。
 * @returns 非空 Anthropic 文本块数组。
 */
function toUserContent(content: string | ModelTextBlock[]): ModelTextBlock[] {
  const blocks: ModelTextBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content
  return blocks.filter((block) => block.text.length > 0)
}

/**
 * 统一 assistant content → Anthropic content。
 *
 * 历史 thinking 块缺少协议回放要求的 signature，因此不回传。
 *
 * @param blocks 统一 assistant 内容块。
 * @returns Anthropic 可接受的文本块和 `tool_use` 块；thinking 及空文本被跳过。
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

/**
 * 判断上一条消息是否由工具结果拼成，用于合并连续的 tool 结果。
 *
 * @param message 待检查的 Anthropic 消息。
 * @returns 消息是以 `tool_result` 为首个 content block 的 user 消息时返回 `true`。
 */
function isToolResultMessage(message: MessageParam): boolean {
  if (message.role !== "user" || typeof message.content === "string") return false
  return message.content[0]?.type === "tool_result"
}

/**
 * 统一 `messages[1...]` → Anthropic `messages`。
 *
 * 两个协议特有的约束：
 *   - `tool_result` 必须放在 user 消息的 content 里，不能单独成消息，因此连续的 tool 结果
 *     合并进同一个 user 消息，保证 tool_use / tool_result 的配对顺序不变；
 *   - content 不能为空数组，因此空文本、只剩 thinking 的 assistant 消息直接跳过。
 *
 * @param messages 除首个 System Message 外的统一会话消息。
 * @returns Anthropic 消息数组；连续工具结果会合并进同一 user 消息。
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
      /** 工具结果只消费 text 块。 */
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

/**
 * 将统一工具定义映射为 Anthropic `tools`。
 *
 * @param tools 统一工具定义。
 * @returns Anthropic 工具定义数组。
 */
function toAnthropicTools(tools: UnifiedToolDefinition[]): ToolUnion[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    /** 统一格式固定 inputSchema 为 JSON Schema，字段名差异只在这里出现。 */
    input_schema: tool.inputSchema as ToolInputSchema,
  }))
}

/**
 * 读取同来源的完整块，任一块不可用时交给通用消息转换。
 * @param blocks 按响应顺序提交的内容块。
 * @param source 当前端点的回放来源。
 * @returns 可按顺序重放的原生内容。
 */
function replayBlocks(blocks: AssistantContentBlock[], source: ReplaySource): NativeBlock[] | undefined {
  const result: NativeBlock[] = []
  for (const block of blocks) {
    const replay = block.replay
    if (replay?.name !== source.name || replay.protocol !== source.protocol) return undefined
    try {
      const native = JSON.parse(replay.payloadJson) as NativeBlock | null
      if (native === null) return undefined
      if (block.type === "text" && native.type === "text" && native.text === block.text ||
        block.type === "thinking" && native.type === "thinking" && native.thinking === block.text &&
          typeof native.signature === "string" && native.signature.length > 0 ||
        block.type === "thinking" && native.type === "redacted_thinking" &&
          typeof native.data === "string" && native.data.length > 0 ||
        block.type === "tool_call" && native.type === "tool_use" && native.id === block.toolCallId &&
          native.name === block.name && isToolInput(native.input)) {
        result.push(native)
      } else return undefined
    } catch {
      return undefined
    }
  }
  return result
}

/**
 * 重建有原生回放能力的请求历史及签名所绑定的顶层工具表。
 * @param history 宿主裁剪后的有序历史。
 * @param baseTools 每次请求提供的基础工具。
 * @param policy 当前端点能力与回放来源。
 * @returns 原生协议消息与顶层工具列表。
 */
function buildNativeHistory(history: ModelHistory, baseTools: UnifiedToolDefinition[], policy: NativeHistoryPolicy): {
  messages: AnthropicRequest["messages"]; tools: UnifiedToolDefinition[]
} {
  const tools = new Map([...baseTools, ...history.mcpBaseline].map((tool) => [tool.name, tool]))
  const messages: AnthropicRequest["messages"] = []
  let frozen = false
  let changes: InlineToolBlock[] = []
  let resultRound: { turn: number; step: number } | undefined
  const flushChanges = () => {
    if (changes.length === 0) return
    if (messages.at(-1)?.role !== "user") throw invalidRequest("Anthropic 内联工具变更缺少前置的用户消息或工具结果。")
    messages.push({ role: "system", content: changes })
    changes = []
  }

  for (const event of history.events) {
    if (event.type === "mcp/tools_added" || event.type === "mcp/tools_removed") {
      if (!frozen || !policy.inlineToolChanges) applyHistoryToolChange(tools, event)
      else if (event.type === "mcp/tools_added") {
        for (const definition of toAnthropicTools(event.definitions)) {
          changes.push({ type: "tool_addition", tool: { type: "tool_definition", definition } })
        }
      } else {
        for (const name of event.toolNames) changes.push({ type: "tool_removal", tool: { type: "tool_reference", name } })
      }
      continue
    }
    const projection = historyMessage(event)
    if (projection === undefined) continue
    if (event.type === "assistant/message") {
      const replay = event.finishReason ? replayBlocks(event.content, policy) : undefined
      const content = replay ?? toAssistantContent(event.content)
      if (content.length === 0) continue
      flushChanges()
      messages.push({ role: "assistant", content })
      if (replay?.some((block) => block.type === "thinking" || block.type === "redacted_thinking")) frozen = true
      resultRound = undefined
      continue
    }
    const converted = toAnthropicMessages([projection])[0]
    if (converted === undefined) continue
    const last = messages.at(-1)
    if (event.type === "tool/result" && last?.role === "user" &&
      resultRound?.turn === event.turn && resultRound.step === event.step) {
      ;(last.content as ContentBlockParam[]).push(...converted.content as ContentBlockParam[])
    } else {
      messages.push(converted)
    }
    resultRound = event.type === "tool/result" ? event : undefined
  }
  flushChanges()
  return { messages, tools: [...tools.values()] }
}

/**
 * 将独立摘要所需的通用历史编码为文本材料。
 * @param messages 通用消息，末项为摘要指令。
 * @returns 单条包含材料和指令的 user 消息。
 */
function summaryMessages(messages: ModelMessage[]): MessageParam[] {
  const material = messages.slice(0, -1).map((message) => message.role !== "assistant" ? message : {
    ...message, content: message.content.map(({ replay: _replay, ...block }) => block),
  })
  const instruction = messages.at(-1)
  const prompt = instruction?.role === "user" ? joinTextBlocks(toUserContent(instruction.content)) : ""
  return [{ role: "user", content: JSON.stringify(material) + "\n\n" + prompt }]
}

/**
 * 构建一次 Anthropic Messages 流式请求。
 *
 * `system` 取 `messages[0]`；`tools` 为空时不传该字段（协议不接受空数组）。
 *
 * @param request 待转换的统一模型请求。
 * @param config 当前 Adapter 绑定的完整模型配置。
 * @param policy 可选的原生块回放与工具变更规则。
 * @returns SDK 可接受的流式 Messages 请求参数。
 * @throws `AppError` 当统一上下文或推理等级配置无效时抛出。
 */
export function buildAnthropicRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
  policy?: NativeHistoryPolicy,
): AnthropicRequest {
  const history = request.context.history
  let system: string
  let messages: AnthropicRequest["messages"]
  let definitions: UnifiedToolDefinition[]
  if (policy && history) {
    system = history.system
    const native = buildNativeHistory(history, request.tools, policy)
    messages = native.messages
    definitions = native.tools
  } else {
    const context = splitSystemMessage(request)
    system = context.system
    definitions = context.tools
    messages = policy && request.context.purpose === "summary" ? summaryMessages(context.rest) : toAnthropicMessages(context.rest)
  }

  const params: AnthropicRequest = {
    model: request.model.name,
    max_tokens: config.maxOutputTokens,
    system,
    messages,
    stream: true,
  }

  if (definitions.length > 0) {
    params.tools = toAnthropicTools(definitions)
  }
  if (request.toolChoice === "none") params.tool_choice = { type: "none" }

  Object.assign(params, reasoningRequestFragment(request, config))

  return params
}


/** 响应方向：RawMessageStreamEvent → ModelStreamEvent */


/** 正在拼装的块：Anthropic 的块只有增量，`block_end` 需要自己累积出的完整内容。 */
interface PendingBlock {
  /** 统一流里的块序号，从 0 起连续（协议侧的 content block index 不直接透出）。 */
  index: number
  /** 统一块类型。 */
  blockType: BlockType
  /** 已收到的文本或 thinking 内容。 */
  text: string
  /** Anthropic `tool_use.id`。非工具块为空字符串。 */
  toolCallId: string
  /** Anthropic 工具名称。非工具块为空字符串。 */
  name: string
  /** 已收到的工具参数 JSON 文本。 */
  argumentsJson: string
  /** 原生起始块及随流更新的协议字段。 */
  native?: NativeBlock
  signatureStarted?: boolean
}

/**
 * `message_delta.usage` 是累计值，用非 null 的新值覆盖 `message_start` 的旧值。
 *
 * @param next 较新的协议计数。
 * @param previous 之前保存的协议计数。
 * @returns 新值已报告时返回新值，否则保留旧值；都未报告时返回 `undefined`。
 */
function pickCount(
  next: number | null | undefined,
  previous: number | null | undefined,
): number | undefined {
  if (next !== null && next !== undefined) return next
  if (previous !== null && previous !== undefined) return previous
  return undefined
}

/**
 * 合并 Anthropic 流中 `message_start` 与 `message_delta` 的累计 Usage。
 *
 * @param previous 已保存的 Usage 字段。
 * @param next 新事件提供的 Usage 字段。
 * @returns 以新值优先、缺失时保留旧值的合并字段对象。
 */
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

/**
 * 判断 Anthropic 流是否至少报告过一个 Usage 字段。
 *
 * @param fields 已合并的 Anthropic Usage 字段。
 * @returns 至少有一个字段非 null / undefined 时返回 `true`。
 */
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
 * `stop_reason` → 统一完成状态。
 *
 * 只有"已结束的完整 tool_call"才算待执行：`tool_use` 但没有任何 `content_block_stop` 过的
 * tool_call 块时不能报 `tool_calls`。`pause_turn` 等其它取值按 unknown 处理，
 * 不凭文本存在推断 finished。
 *
 * @param stopReason Anthropic 的原始 `stop_reason`。
 * @param endedToolCalls 已收到结束事件的完整工具调用数量。
 * @returns Runtime 使用的统一完成状态。
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
 *
 * @param events Anthropic SDK 产生的原始流事件。
 * @param source 需要收取完整原生内容块时的来源。
 * @returns 按统一块协议产生的异步事件流。
 * @throws `Error` 当原始流在 `message_stop` 前结束时抛出。
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<RawMessageStreamEvent>,
  source?: ReplaySource,
): AsyncGenerator<ModelStreamEvent> {
  /** key 是协议侧的 content block index；不在表里表示该 index 已被忽略。 */
  const blocks = new Map<number, PendingBlock>()
  let nextIndex = 0
  let endedToolCalls = 0
  let usageFields: AnthropicUsageFields = {}
  let stopReason: string | undefined
  let sawMessageStop = false

  /**
   * 为协议块分配统一序号并开始累积其内容。
   *
   * @param protocolIndex Anthropic content block 的序号。
   * @param blockType 统一块类型。
   * @returns 新建的待收尾块状态。
   */
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

  /**
   * 收尾一个块：产出 block_end 并移出拼装表。
   *
   * @param protocolIndex Anthropic content block 的序号。
   * @returns 完整块事件；找不到对应块时返回 `undefined`。
   */
  function closeBlock(protocolIndex: number): ModelStreamEvent | undefined {
    const block = blocks.get(protocolIndex)
    if (block === undefined) return undefined
    blocks.delete(protocolIndex)

    const native = block.native
    if (native?.type === "text") native.text = block.text
    if (native?.type === "thinking") {
      native.thinking = block.text
      if (typeof native.signature !== "string" || native.signature.length === 0) throw streamInterruptedError("anthropic_messages")
    }
    if (native?.type === "redacted_thinking" && (typeof native.data !== "string" || native.data.length === 0)) {
      throw streamInterruptedError("anthropic_messages")
    }
    if (native?.type === "tool_use" && block.argumentsJson.length > 0) {
      try { native.input = JSON.parse(block.argumentsJson) }
      catch { throw streamInterruptedError("anthropic_messages") }
    }
    if (native?.type === "tool_use" && (!native.id || !native.name || !isToolInput(native.input))) {
      throw streamInterruptedError("anthropic_messages")
    }
    const replay = source && native ? { name: source.name, protocol: source.protocol, payloadJson: JSON.stringify(native) } : undefined
    if (block.blockType === "tool_call") {
      endedToolCalls += 1
      return {
        type: "block_end",
        index: block.index,
        block: {
          type: "tool_call",
          toolCallId: block.toolCallId,
          name: block.name,
          arguments: native?.type === "tool_use" ? native.input : parseToolCallArguments(block.argumentsJson),
          ...(replay ? { replay } : {}),
        },
      }
    }

    return {
      type: "block_end",
      index: block.index,
      block: { type: block.blockType, text: block.text, ...(replay ? { replay } : {}) },
    }
  }

  /**
   * 收尾仍未结束的文本或 thinking 块，不收尾未完成的工具调用。
   *
   * 文本与思考的内容是随增量累积的，此处产出的就是已收到的全部内容（被 `max_tokens`
   * 截断时也应当保留）。未结束的工具调用不产生 `block_end`，避免被 AgentLoop 当作完整调用。
   *
   * @returns 按统一块序号排序的 block_end 事件。
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
        if (source && (event.index !== nextIndex || blocks.size > 0)) throw streamInterruptedError("anthropic_messages")

        if (content.type === "text" || content.type === "thinking") {
          const blockType: BlockType = content.type
          const text = content.type === "text" ? content.text : content.thinking
          const block = openBlock(event.index, blockType)
          if (source) block.native = structuredClone(content)
          yield { type: "block_start", index: block.index, blockType }
          /** 起始事件里已经带文本时补一条增量，避免增量之和与 block_end 的内容不一致。 */
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
          if (source) block.native = structuredClone(content)
          block.toolCallId = content.id
          block.name = content.name
          /** 非流式给出 input 时（空对象是常态）把它当作已拼装的参数起点。 */
          if (!source && hasKeys(content.input)) block.argumentsJson = serializeToolCallArguments(content.input)

          yield { type: "block_start", index: block.index, blockType: "tool_call" }
          /** 先给出 id 与 name：下游不必等到第一个参数增量才知道调用的是哪个工具。 */
          yield {
            type: "block_delta",
            index: block.index,
            delta: { type: "tool_call", toolCallId: block.toolCallId, nameDelta: block.name },
          }
          break
        }

        if (source) {
          if (content.type !== "redacted_thinking") throw streamInterruptedError("anthropic_messages")
          const block = openBlock(event.index, "thinking")
          block.native = structuredClone(content)
          yield { type: "block_start", index: block.index, blockType: "thinking" }
        }
        /** 未启用原生回放时，其余类型继续走通用投影。 */
        /** 没有统一表达，忽略该 index 的后续增量与结束事件。 */
        break
      }

      case "content_block_delta": {
        const block = blocks.get(event.index)
        if (block === undefined) {
          if (source) throw streamInterruptedError("anthropic_messages")
          break
        }

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

        if (block.native?.type === "thinking" && delta.type === "signature_delta") {
          block.native.signature = (block.signatureStarted ? block.native.signature : "") + delta.signature
          block.signatureStarted = true
        } else if (block.native?.type === "text" && delta.type === "citations_delta") {
          ;(block.native.citations ??= []).push(delta.citation)
        } else if (source) throw streamInterruptedError("anthropic_messages")
        break
      }

      case "content_block_stop": {
        const closed = closeBlock(event.index)
        if (closed !== undefined) yield closed
        else if (source) throw streamInterruptedError("anthropic_messages")
        break
      }

      case "message_delta": {
        usageFields = mergeAnthropicUsage(usageFields, event.usage)
        if (event.delta.stop_reason !== null) stopReason = event.delta.stop_reason
        break
      }

      case "message_stop": {
        if (source && (blocks.size > 0 || stopReason === undefined)) throw streamInterruptedError("anthropic_messages")
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

/**
 * 校验原生 tool_use 的最终参数对象。
 * @param value 由起始块或 JSON 增量获得的参数。
 * @returns 参数是否为工具输入对象。
 */
function isToolInput(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 判断一个值是否为非空对象，用于区分 Anthropic 的空 `input` 和已有参数。
 *
 * @param value 待检查的协议值。
 * @returns 值为非 null 对象且至少包含一个自有键时返回 `true`。
 */
function hasKeys(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0
}


/** Adapter */


/**
 * 创建 Anthropic Messages Adapter。
 *
 * `config` 提供一个具体模型的配置：请求里的 `model` 用它校验，`max_tokens` 用它取默认值。
 * SDK 自身的重试被关闭（`maxRetries: 0`），重试统一由 `runtime/network/` 负责，
 * 否则一次逻辑请求会被两层重试各自放大。
 *
 * @param config 要绑定的 Anthropic 模型配置。
 * @param options Anthropic 客户端的凭据、地址和额外请求头。
 * @returns 已绑定配置并负责流式请求的 Anthropic Adapter。
 */
export function createAnthropicAdapter(
  config: ModelConfig,
  options: ProtocolClientOptions,
): ModelAdapter {
  const { nativeHistory } = options
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders: options.defaultHeaders,
    maxRetries: 0,
  })
  /**
   * 执行一次绑定模型的 Anthropic 流式请求，并统一处理重试与错误归一化。
   *
   * @param request 当前统一模型请求。
   * @param signal 调用方的取消信号。
   * @param options 单次请求的 SDK 选项。
   * @returns Anthropic 响应转换后的统一模型事件流。
   * @throws `AppError` 请求校验失败、协议请求失败或取消时抛出。
   */
  async function* stream(
    request: UnifiedModelRequest,
    signal: AbortSignal,
    options?: ModelStreamOptions,
  ): AsyncGenerator<ModelStreamEvent> {
    /** 校验与请求构建在迭代时抛出：AgentLoop 只需在一处处理 Adapter 的错误。 */
    assertRequestMatchesModel(request, config)
    const source = request.context.history ? nativeHistory : undefined
    const params = buildAnthropicRequest(request, config, nativeHistory)

    yield* runModelStream((attemptSignal) => {
      return mapAnthropicStream(requestAnthropicStream(client, params, attemptSignal, source !== undefined, options?.timeoutMs), source)
    }, signal)
  }

  return { stream }
}

/**
 * 发起一次真实请求并逐个产出协议事件；取消由 SDK 的 `signal` 传递。
 *
 * @param client Anthropic SDK 客户端。
 * @param params 已构建的流式请求参数。
 * @param signal 当前请求尝试的取消信号。
 * @param beta 正常请求是否使用端点启用的 beta Messages 接口。
 * @param timeout SDK 超时毫秒数；省略时沿用默认值。
 * @returns 原始 Anthropic 流事件异步生成器。
 * @throws SDK 请求失败或取消时抛出底层异常。
 */
async function* requestAnthropicStream(
  client: Anthropic,
  params: AnthropicRequest,
  signal: AbortSignal,
  beta: boolean,
  timeout?: number,
): AsyncGenerator<RawMessageStreamEvent> {
  const options = { signal, ...(timeout === undefined ? {} : { timeout }) }
  if (beta) {
    const betas = params.messages.some((message) => message.role === "system") ? [INLINE_TOOLS_BETA] : undefined
    // 锁定版本的 SDK 可以发送 inline tool_definition，类型定义只包含引用。
    const request = { ...params, ...(betas ? { betas } : {}) } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming
    const stream = await client.beta.messages.create(request, options)
    for await (const event of stream) yield event as RawMessageStreamEvent
    return
  }
  const stream = await client.messages.create(params as MessageCreateParamsStreaming, options)
  for await (const event of stream) yield event
}
