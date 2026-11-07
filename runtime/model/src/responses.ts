/**
 * Responses 的请求与统一流事件转换。
 *
 * 每次完整传入 instructions 和 input，不使用 previous_response_id，请求设置 store 为 false。
 * 工具调用与结果作为独立 input 项按 call_id 配对；文本与思考按块累积。
 * 失败或取消终态抛出异常，incomplete 作为完成状态交付；共享入口负责重试与错误归一化。
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
import { convertResponsesUsage } from "./usage.ts"
import type { ResponsesUsageFields } from "./usage.ts"
import type {
  BlockType,
  ModelAdapter,
  ModelStreamOptions,
  ModelCompletion,
  ModelConfig,
  ModelMessage,
  ModelStreamEvent,
  UnifiedModelRequest,
  UnifiedToolDefinition,
} from "./types.ts"

type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent
type ResponseInputItem = OpenAI.Responses.ResponseInputItem
type ResponseCreateParamsStreaming = OpenAI.Responses.ResponseCreateParamsStreaming
type FunctionTool = OpenAI.Responses.FunctionTool

/** 该协议的工具项类型：`input` 与 `output` 两种方向共用的形状。 */
type FunctionCallItem = Extract<ResponseInputItem, { type: "function_call" }>


/** 请求方向：统一上下文 → Responses */


/**
 * 统一 `messages[1...]` → Responses `input`。
 *
 * 该协议的 message content 是字符串；工具调用与工具结果是与 message 同级的 InputItem，
 * 因此一条 assistant 消息在请求里会展开成若干 item（text message + function_call），
 * 这与协议一致，也让 `function_call_output` 能紧跟其 `function_call`。
 *
 * `function_call` 的 id 用统一 `toolCallId`：该协议回传历史调用时以 `call_id` 配对，
 * 不要求服务端生成的 item id（本轮新调用才由服务端生成）。
 *
 * @param messages 除首个 System Message 外的统一会话消息。
 * @returns Responses InputItem 数组。
 */
export function toResponsesInput(messages: ModelMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = []

  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string" ? message.content : joinTextBlocks(message.content)
      if (text.length > 0) items.push({ role: "user", content: text })
      continue
    }

    if (message.role === "assistant") {
      let text = ""
      for (const block of message.content) {
        if (block.type === "text") text += block.text
      }

      if (text.length > 0) items.push({ role: "assistant", content: text })

      for (const block of message.content) {
        if (block.type !== "tool_call") continue
        const call: FunctionCallItem = {
          type: "function_call",
          call_id: block.toolCallId,
          name: block.name,
          arguments: serializeToolCallArguments(block.arguments),
        }
        items.push(call)
      }
      continue
    }

    if (message.role === "tool") {
      /** 工具结果只消费 text 块。 */
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: joinTextBlocks(message.content),
      })
    }
  }

  return items
}

/**
 * 将统一工具定义映射为 Responses function tools。
 *
 * @param tools 统一工具定义。
 * @returns Responses 工具定义数组。
 */
function toResponsesTools(tools: UnifiedToolDefinition[]): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    /** 该协议的 parameters 直接是 JSON Schema；统一格式的 inputSchema 原样转过去。 */
    parameters: tool.inputSchema,
    strict: false,
  }))
}

/**
 * 构建一次 Responses 流式请求。
 *
 * `tools` 为空时不传该字段（协议不接受空数组）。
 *
 * @param request 待转换的统一模型请求。
 * @param config 当前 Adapter 绑定的完整模型配置，包含推理字段路径。
 * @returns SDK 可接受的流式 Responses 请求参数。
 * @throws `AppError` 当统一上下文或推理等级配置无效时抛出。
 */
export function buildResponsesRequest(
  request: UnifiedModelRequest,
  config: ModelConfig,
): ResponseCreateParamsStreaming {
  const { system, rest, tools } = splitSystemMessage(request)

  const params: ResponseCreateParamsStreaming = {
    model: request.model.name,
    instructions: system,
    input: toResponsesInput(rest),
    stream: true,
    store: false,
  }

  if (tools.length > 0) {
    params.tools = toResponsesTools(tools)
  }
  if (request.toolChoice === "none") params.tool_choice = "none"

  Object.assign(params, reasoningRequestFragment(request, config))

  return params
}


/** 响应方向：ResponseStreamEvent → ModelStreamEvent */


/**
 * 正在拼装的块。
 *
 * 一个块可能收到多种增量事件（`content_part.added` 与 `output_text.delta`、
 * `output_item.added` 与 `function_call_arguments.delta`），因此用 key 而不是单值变量标识。
 */
interface PendingBlock {
  /** 统一流里的块序号，从 0 起连续。 */
  index: number
  /** 统一块类型。 */
  blockType: BlockType
  /** 已收到的文本或 thinking 内容。 */
  text: string
  /** Responses `function_call.call_id`。非工具块为空字符串。 */
  toolCallId: string
  /** 工具名称。非工具块为空字符串。 */
  name: string
  /** 已收到的工具参数 JSON 分片拼接结果。 */
  argumentsJson: string
}

/** 工具调用的累积信息：`call_id` 与 `name` 不在参数增量事件里，另外攒着。 */
interface PendingCall {
  /** 该调用在流里的键（见 `callKey`）。 */
  key: string
  /** 用于和 `function_call_output` 配对的调用 ID。 */
  callId: string
  /** Responses function call 的工具名称。 */
  name: string
  /** 已收到的参数 JSON 分片拼接结果。 */
  argumentsJson: string
}

/**
 * 一个 output item 在流里的查找键。
 *
 * `function_call` 的 `id` 在协议类型里是可选的（`id?: string`），因此没有它时退回
 * `call_id`；参数增量事件里的 `item_id` 用同一套规则解析（见 `resolveCallKey`）。
 *
 * @param item Responses function call item。
 * @returns 优先使用 item id、否则使用 call id 的稳定查找键。
 */
function callKey(item: { id?: string | null; call_id: string }): string {
  return item.id ?? item.call_id
}

/** 完成状态的原始信息：`response.completed` 带完整 Response，便于判断是否含工具调用。 */
interface TerminalInfo {
  /** Responses 终态事件类型。 */
  type: "completed" | "incomplete"
  /** Provider 报告的响应状态。 */
  status: string | undefined
  /** 不完整响应的原始原因。 */
  incompleteReason: string | undefined
  /** 终态响应中是否包含 function call item。 */
  hasFunctionCall: boolean
  /** 终态响应提供的 Usage；缺失时为 `undefined`。 */
  usage: ResponsesUsageFields | undefined
}

/**
 * 统一完成状态。
 *
 *   status=completed → 已结束的完整 tool_call 是否存在决定 tool_calls / finished
 *   status=incomplete → incomplete
 *   status=failed / cancelled → 抛错，不到达这里
 *
 * @param info Responses 终态信息。
 * @param endedToolCalls 已完整收尾的工具调用数量。
 * @returns Runtime 使用的统一完成状态。
 */
function resolveCompletion(info: TerminalInfo, endedToolCalls: number): ModelCompletion {
  if (info.type === "incomplete" || info.status === "incomplete") return "incomplete"
  if (info.status === "completed") {
    return endedToolCalls > 0 || info.hasFunctionCall ? "tool_calls" : "finished"
  }
  return "unknown"
}

/**
 * Responses 协议流 → 统一流事件。
 *
 * 块与协议 item 的对应关系：
 *   - `output_item.added`(message) → text 块；文本增量来自 `output_text.delta`；
 *   - `output_item.added`(function_call) → tool_call 块，`call_id` / `name` 在这里确定，
 *     参数增量来自 `function_call_arguments.delta`；
 *   - `output_item.added`(reasoning) → thinking 块，增量来自 reasoning 摘要或原文。
 *
 * 结束事件之前流就断了（未收到 completed / incomplete / failed）时抛错，不产出 `stream_end`。
 *
 * @param events Responses SDK 产生的原始流事件。
 * @returns 按统一块协议产生的异步事件流。
 * @throws `Error` 当协议报告失败、错误事件或在终态事件前结束时抛出。
 */
export async function* mapResponsesStream(
  events: AsyncIterable<ResponseStreamEvent>,
): AsyncGenerator<ModelStreamEvent> {
  const textBlocks = new Map<string, PendingBlock>()
  const thinkingBlocks = new Map<string, PendingBlock>()
  const toolCallBlocks = new Map<string, PendingBlock>()
  const calls = new Map<string, PendingCall>()
  /** 协议 item id → 已打开的块，用于按 item id 收尾。 */
  const blocksByItem = new Map<string, PendingBlock>()
  let nextIndex = 0
  let endedToolCalls = 0
  let terminal: TerminalInfo | undefined

  /**
   * 为 Responses item 分配统一序号并登记到对应类型的查找表。
   *
   * @param blockType 统一块类型。
   * @param itemId Responses item 的查找键。
   * @returns 新建的待收尾块状态。
   */
  function openBlock(blockType: BlockType, itemId: string): PendingBlock {
    const block: PendingBlock = {
      index: nextIndex,
      blockType,
      text: "",
      toolCallId: "",
      name: "",
      argumentsJson: "",
    }
    nextIndex += 1
    blocksByItem.set(itemId, block)
    if (blockType === "text") textBlocks.set(itemId, block)
    if (blockType === "thinking") thinkingBlocks.set(itemId, block)
    if (blockType === "tool_call") toolCallBlocks.set(itemId, block)
    return block
  }

  /**
   * 收尾块并从所有查找表移除，生成统一 block_end 事件。
   *
   * @param block 待收尾的块状态。
   * @returns 对应的统一 block_end 事件。
   */
  function closeBlock(block: PendingBlock): ModelStreamEvent {
    blocksByItem.forEach((value, key) => {
      if (value === block) blocksByItem.delete(key)
    })
    textBlocks.forEach((value, key) => {
      if (value === block) textBlocks.delete(key)
    })
    thinkingBlocks.forEach((value, key) => {
      if (value === block) thinkingBlocks.delete(key)
    })
    toolCallBlocks.forEach((value, key) => {
      if (value === block) toolCallBlocks.delete(key)
    })

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
   * 收尾某个 item 的块；不传 itemId 时收尾全部。
   *
   * @param itemId 可选的 Responses item 键。
   * @returns 收尾得到的统一 block_end 事件数组。
   */
  function closeItem(itemId: string | undefined): ModelStreamEvent[] {
    if (itemId !== undefined) {
      const block = blocksByItem.get(itemId)
      return block === undefined ? [] : [closeBlock(block)]
    }
    const pending = [...blocksByItem.values()].sort((a, b) => a.index - b.index)
    return pending.map(closeBlock)
  }

  /**
   * 收尾仍未结束的 thinking / text 块，按 index 升序；不含工具调用（见调用处说明）。
   *
   * @returns 尚未收尾的文本与 thinking 块的 block_end 事件。
   */
  function flushTextBlocks(): ModelStreamEvent[] {
    const pending = [...blocksByItem.values()]
      .filter((block) => block.blockType !== "tool_call")
      .sort((a, b) => a.index - b.index)
    return pending.map(closeBlock)
  }

  /**
   * 参数增量事件里的 `item_id` 解析成块键。
   *
   * 事件里的 `item_id` 与 `output_item.added` 的 item id 对应；当 item 没有 id 时
   * （function_call 的 id 是可选的）协议给的是 `call_id`，用登记的调用信息换回块键。
   *
   * @param itemId 参数增量事件提供的 item_id 或 call_id。
   * @returns 对应的内部查找键；无法匹配时返回 `undefined`。
   */
  function resolveCallKey(itemId: string): string | undefined {
    if (toolCallBlocks.has(itemId)) return itemId

    for (const call of calls.values()) {
      if (call.callId === itemId) return call.key
    }

    return undefined
  }

  for await (const event of events) {
    switch (event.type) {
      case "response.output_item.added": {
        const item = event.item
        if (item.type === "message") {
          const block = openBlock("text", item.id)
          yield { type: "block_start", index: block.index, blockType: "text" }
          break
        }

        if (item.type === "function_call") {
          const key = callKey(item)
          calls.set(key, {
            key,
            callId: item.call_id,
            name: item.name,
            argumentsJson: "",
          })
          const block = openBlock("tool_call", key)
          block.toolCallId = item.call_id
          block.name = item.name
          yield { type: "block_start", index: block.index, blockType: "tool_call" }
          /** 先给出 id 与 name：下游不必等到第一个参数增量才知道调用的是哪个工具。 */
          yield {
            type: "block_delta",
            index: block.index,
            delta: { type: "tool_call", toolCallId: item.call_id, nameDelta: item.name },
          }
          break
        }

        if (item.type === "reasoning") {
          const block = openBlock("thinking", item.id)
          yield { type: "block_start", index: block.index, blockType: "thinking" }
          break
        }

        /** 其它 item 类型（web_search_call / code_interpreter_call / mcp_call 等） */
        /** 没有统一表达，忽略。 */
        break
      }

      case "response.output_text.delta": {
        const block = textBlocks.get(event.item_id)
        if (block === undefined || event.delta.length === 0) break
        block.text += event.delta
        yield { type: "block_delta", index: block.index, delta: { type: "text", text: event.delta } }
        break
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const block = thinkingBlocks.get(event.item_id)
        if (block === undefined || event.delta.length === 0) break
        block.text += event.delta
        yield {
          type: "block_delta",
          index: block.index,
          delta: { type: "thinking", text: event.delta },
        }
        break
      }

      case "response.function_call_arguments.delta": {
        const key = resolveCallKey(event.item_id)
        const call = key === undefined ? undefined : calls.get(key)
        const block = key === undefined ? undefined : toolCallBlocks.get(key)
        if (block === undefined || call === undefined || event.delta.length === 0) break

        call.argumentsJson += event.delta
        block.argumentsJson = call.argumentsJson
        yield {
          type: "block_delta",
          index: block.index,
          delta: {
            type: "tool_call",
            toolCallId: block.toolCallId,
            argumentsDelta: event.delta,
          },
        }
        break
      }

      case "response.function_call_arguments.done": {
        const block = toolCallBlocks.get(event.item_id)
        const call = calls.get(event.item_id)
        if (block === undefined || call === undefined) break
        /** done 事件带最终完整参数：以它为准，避免增量丢包导致参数不完整。 */
        call.argumentsJson = event.arguments
        block.argumentsJson = event.arguments
        break
      }

      case "response.output_item.done": {
        /** 该 item 的块到此结束；reasoning 的正文也可能只在这里出现（摘要模式下没有 delta）。 */
        const item = event.item

        if (item.type === "function_call") {
          /** function_call 的 id 可选，收尾键必须与打开时一致（见 `callKey`）。 */
          for (const mapped of closeItem(callKey(item))) yield mapped
          break
        }

        if (item.type === "reasoning" && item.summary.length > 0) {
          const block = thinkingBlocks.get(item.id)
          if (block !== undefined && block.text.length === 0) {
            const text = item.summary.map((part) => part.text).join("")
            if (text.length > 0) {
              block.text = text
              yield {
                type: "block_delta",
                index: block.index,
                delta: { type: "thinking", text },
              }
            }
          }
        }

        if (item.type === "message" || item.type === "reasoning") {
          for (const mapped of closeItem(item.id)) yield mapped
        }
        break
      }

      case "response.completed":
      case "response.incomplete": {
        const response = event.response
        terminal = {
          type: event.type === "response.completed" ? "completed" : "incomplete",
          status: response.status,
          incompleteReason: response.incomplete_details?.reason ?? undefined,
          hasFunctionCall: response.output.some((item) => item.type === "function_call"),
          usage: response.usage ?? undefined,
        }
        break
      }

      case "response.failed": {
        const error = event.response.error
        throw new Error(error === null ? "Responses 请求失败" : `${error.code}: ${error.message}`)
      }

      case "error": {
        throw new Error(event.message)
      }

      default:
        break
    }
  }

  if (terminal === undefined) throw streamInterruptedError("responses")

  /** 收尾仍未结束的 thinking / text 块：内容就是已累积的增量，被截断时也应保留。 */
  /** ------------------------------------------------------------------------- */
  /** 工具调用块只能由 `response.output_item.done`(function_call) 收尾 —— 那是协议对 */
  /** "该调用已完整"的显式声明。没有收到它的调用参数可能只传了一半，产出 `block_end` */
  /** 会让 AgentLoop 把它当成完整调用。 */
  for (const mapped of flushTextBlocks()) yield mapped

  const finishReason = terminal.incompleteReason ?? terminal.status
  yield {
    type: "stream_end",
    completion: resolveCompletion(terminal, endedToolCalls),
    ...(terminal.usage !== undefined ? { usage: convertResponsesUsage(terminal.usage) } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
  }
}


/** Adapter */


/**
 * 创建 Responses Adapter。
 *
 * 与另外两个 Adapter 一样关闭 SDK 自身的重试（`maxRetries: 0`），
 * 重试统一由 `runtime/network/` 负责。
 *
 * @param config 要绑定的 Responses 模型配置。
 * @param options OpenAI SDK 客户端的凭据、地址和额外请求头。
 * @returns 已绑定配置并负责流式请求的 Responses Adapter。
 */
export function createResponsesAdapter(
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
   * 执行一次绑定模型的 Responses 流式请求，并统一处理重试与错误归一化。
   *
   * @param request 当前统一模型请求。
   * @param signal 调用方的取消信号。
   * @param options 单次请求的 SDK 选项。
   * @returns Responses 响应转换后的统一模型事件流。
   * @throws `AppError` 请求校验失败、协议请求失败或取消时抛出。
   */
  async function* stream(
    request: UnifiedModelRequest,
    signal: AbortSignal,
    options?: ModelStreamOptions,
  ): AsyncGenerator<ModelStreamEvent> {
    /** 校验与请求构建在迭代时抛出：AgentLoop 只需在一处处理 Adapter 的错误。 */
    assertRequestMatchesModel(request, config)
    const params = buildResponsesRequest(request, config)

    yield* runModelStream((attemptSignal) => {
      return mapResponsesStream(requestResponsesStream(client, params, attemptSignal, options?.timeoutMs))
    }, signal)
  }

  return { stream }
}

/**
 * 发起一次真实请求并逐个产出协议事件；取消由 SDK 的 `signal` 传递。
 *
 * @param client OpenAI SDK 客户端。
 * @param params 已构建的流式请求参数。
 * @param signal 当前请求尝试的取消信号。
 * @param timeout SDK 超时毫秒数；省略时沿用默认值。
 * @returns 原始 Responses 流事件异步生成器。
 * @throws SDK 请求失败或取消时抛出底层异常。
 */
async function* requestResponsesStream(
  client: OpenAI,
  params: ResponseCreateParamsStreaming,
  signal: AbortSignal,
  timeout?: number,
): AsyncGenerator<ResponseStreamEvent> {
  const stream = await client.responses.create(params, { signal, ...(timeout === undefined ? {} : { timeout }) })
  for await (const event of stream) yield event
}
