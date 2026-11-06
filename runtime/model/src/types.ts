/**
 * 统一模型引用、配置、消息、工具定义、流事件与 Usage 的数据契约。
 *
 * Adapter 负责协议字段映射，Runtime 使用统一消息与事件；
 * 本文件还提供完整输入、总 Token、Usage 累计及累计缓存命中率计算。
 */


/** 协议与模型引用 */


/**
 * 三种原生支持的协议：Anthropic Messages / OpenAI Chat Completions / OpenAI Responses。
 *
 * 协议配置使用的三个值，并导出运行期常量供配置校验。
 */
export const PROTOCOLS = ["anthropic_messages", "chat_completions", "responses"] as const

/** `PROTOCOLS` 中允许出现在模型引用和模型配置里的协议字面量。 */
export type Protocol = (typeof PROTOCOLS)[number]

/** 统一模型引用。 */
export interface ModelRef {
  /** Provider 配置中的稳定标识。 */
  providerId: string
  /** Provider 下负责请求转换的协议。 */
  protocol: Protocol
  /** 全局唯一的模型身份。 */
  modelId: string
  /** Provider API 请求中使用的模型名称。 */
  name: string
  /** 当前 Session 为本 Turn 选择的推理等级。 */
  reasoningLevel: string
}

/** 推理等级在协议请求体中的字段路径，以 JSON 对象保存。 */
export interface ReasoningField {
  /** 从请求体根对象到等级字符串的逐级键名。 */
  path: string[]
}

/** 模型配置。 */
export interface ModelConfig {
  /** 全局唯一的模型身份。 */
  modelId: string
  /** Provider API 请求中使用的模型名称。 */
  name: string
  /** 该模型所属 Provider 的标识。 */
  providerId: string
  /** 该模型使用的协议。 */
  protocol: Protocol

  /** 已解析的有效上下文窗口；模型创建 IPC 在写入数据库前补齐缺省值。 */
  contextWindow: number
  /** 模型创建时确定的最大输出 Token 数；是否使用由具体 Adapter 决定。 */
  maxOutputTokens: number
  /** 是否支持发送思考模式配置。 */
  supportsReasoning: boolean
  /** 模型允许选择的推理等级，按页面展示顺序保存。 */
  reasoningLevels: string[]
  /** 将所选等级放入协议请求体的字段路径。 */
  reasoningField: ReasoningField
}


/** 内容块 */


/** 块类型。 */
export type BlockType = "thinking" | "text" | "tool_call"

/** Assistant 内容块，也是 `assistant/message.content` 的元素类型。 */
export type AssistantContentBlock =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | {
      type: "tool_call"
      toolCallId: string
      name: string
      arguments: unknown
    }

/** `assistant/block_delta.delta` 的增量形态。 */
export type AssistantBlockDelta =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | {
      type: "tool_call"
      toolCallId: string
      nameDelta?: string
      argumentsDelta?: string
    }


/** Unified Usage */

/** Usage 使用未缓存输入、缓存读取、缓存写入三个互不重叠的输入桶。 */
/** 可选桶缺失表示未报告，不等同于零。 */


/**
 * 统一 Usage。三个协议必须由各自 Adapter 把厂商字段转换为此格式，Runtime 不再理解厂商原始字段。
 *
 * 字段语义：
 *   - `inputTokens` 语义上是**未落入缓存读取、缓存写入两个桶**的输入 Token，不是完整输入。
 *     完整输入见 `promptTokens()`。
 *   - `inputTokens`、`cacheReadTokens`、`cacheWriteTokens` 三个输入桶互不重叠。
 *   - `reasoningTokens` 是 `outputTokens` 的子集，不能再次加入 Total。
 *
 * 可选字段的 undefined 表示**未报告**，而不是 0；两者要尽量保留区别。
 * `cacheWriteTokens` 只在厂商明确提供时才填，不自行推算。
 *
 * 协议字段由 Adapter 映射为此格式，调用方不处理原始 Usage 字段。
 */
export interface Usage {
  /** 未落入缓存读取与缓存写入两个桶的输入 Token。 */
  inputTokens: number
  /** 本次模型完整输出 Token。 */
  outputTokens: number

  /** 完整 Prompt Token 与 Output Token 之和；厂商未提供时为 undefined。 */
  totalTokens?: number
  /** 从已有 Prompt Cache 中读取的输入 Token；未报告时为 undefined。 */
  cacheReadTokens?: number
  /** 被厂商单独统计为缓存创建 / 写入的输入 Token；未报告时为 undefined。 */
  cacheWriteTokens?: number
  /** `outputTokens` 中属于 reasoning / thinking 的部分。 */
  reasoningTokens?: number
}

/**
 * 完整 Prompt Token，即本次真正送入模型的上下文大小。
 *
 * 计算顺序：
 *   1. 三个输入桶都齐备时，取 `inputTokens + cacheReadTokens + cacheWriteTokens`；
 *   2. 否则若 `totalTokens` 可信，取 `totalTokens - outputTokens`；
 *   3. 两者都无法确定时返回 undefined。
 *
 * 第 3 种情形是刻意的：可选缓存字段缺失表示**未报告**，不能当作 0 参与相加，
 * 否则会低估上下文大小。
 *
 * 完整输入不包含当前请求的输出 Token。
 *
 * @param usage 本次请求已经统一化的 Usage。
 * @returns 可确定的完整 Prompt Token；缓存桶不完整且没有可信 `totalTokens` 时返回 `undefined`。
 */
export function promptTokens(usage: Usage): number | undefined {
  const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens } = usage

  if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined) {
    return inputTokens + cacheReadTokens + cacheWriteTokens
  }
  if (totalTokens !== undefined) {
    return totalTokens - outputTokens
  }
  return undefined
}

/**
 * 完整请求 Token：优先使用协议返回的 `totalTokens`，否则由
 * Prompt Token + `outputTokens` 相加得到；无法确定时返回 undefined。
 *
 * `reasoningTokens` 已含在 `outputTokens` 内，不重复加入。
 *
 * @param usage 本次请求已经统一化的 Usage。
 * @returns 协议提供或由输入与输出推导出的完整 Token 数；无法确定 Prompt 时返回 `undefined`。
 */
export function resolveTotalTokens(usage: Usage): number | undefined {
  if (usage.totalTokens !== undefined) {
    return usage.totalTokens
  }
  const prompt = promptTokens(usage)
  return prompt === undefined ? undefined : prompt + usage.outputTokens
}

/**
 * 把一次真实请求的 Usage 累计进累计值。
 *
 * `previous` 传 undefined 表示「此前还没有任何请求」。
 *
 * 累计规则：
 *   - 必备字段逐次相加；
 *   - 可选字段只有在**每一次**参与累计的请求都报告了该字段时才保留；
 *     任意一次未报告，累计值即为 undefined（未报告），不把该次当作 0。
 *
 * Retry 属于一次新的真实请求，按其自身 Usage 正常参与累计。
 *
 * @param previous 此前累计的 Usage；`undefined` 表示这是第一笔请求。
 * @param usage 当前真实请求的 Usage。
 * @returns 合并后的新对象；不会修改任一入参，可选字段任一轮未报告时在累计值中保持未报告。
 */
export function accumulateUsage(previous: Usage | undefined, usage: Usage): Usage {
  if (previous === undefined) return { ...usage }

  const accumulated: Usage = {
    inputTokens: previous.inputTokens + usage.inputTokens,
    outputTokens: previous.outputTokens + usage.outputTokens,
  }

  accumulated.totalTokens = sumOptional(previous.totalTokens, usage.totalTokens)
  accumulated.cacheReadTokens = sumOptional(previous.cacheReadTokens, usage.cacheReadTokens)
  accumulated.cacheWriteTokens = sumOptional(previous.cacheWriteTokens, usage.cacheWriteTokens)
  accumulated.reasoningTokens = sumOptional(previous.reasoningTokens, usage.reasoningTokens)

  return accumulated
}

/**
 * 两个可选计数相加；任一未报告则为未报告。
 *
 * @param a 第一个累计计数。
 * @param b 第二个累计计数。
 * @returns 两个都已报告时的和，否则返回 `undefined`。
 */
function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined
  return a + b
}

/**
 * 累计缓存命中率：这是缓存命中率**唯一**的口径，不计算单次请求的命中率。
 *
 * ```text
 * 累计命中   = 累计 cacheReadTokens
 * 累计未命中 = 累计 inputTokens + 累计 cacheWriteTokens
 * 命中率     = 累计命中 ÷ (累计命中 + 累计未命中)
 * ```
 *
 * 不能对每次请求的命中率取平均 —— 不同请求规模不同，必须先累计 Token 再相除。
 *
 * 返回 undefined 的情形：
 *   - `cacheReadTokens` 未报告；
 *   - `cacheWriteTokens` 未报告 —— 它属于上述分母，若当作 0 会高估命中率；
 *   - 分母为 0。
 *
 * 入参是**累计后的** Usage（由 `accumulateUsage` 得到），不是单次请求的 Usage。
 *
 * @param accumulated 已累计的 Usage。
 * @returns 累计缓存命中率（0 到 1）；缓存桶未完整报告或分母为 0 时返回 `undefined`。
 */
export function cacheHitRate(accumulated: Usage): number | undefined {
  const hit = accumulated.cacheReadTokens
  const write = accumulated.cacheWriteTokens
  if (hit === undefined || write === undefined) return undefined

  const miss = accumulated.inputTokens + write
  const prompt = hit + miss
  if (prompt === 0) return undefined

  return hit / prompt
}


/** 上下文 */


/**
 * ContextBuilder 的有序消息数组。`messages[0]` 必须是唯一的 System Message；
 * `messages[1...]` 是真实会话上下文。Adapter 将首项分别映射到 Anthropic `system`、
 * Chat Completions `developer/system`、Responses `instructions`，其余项进入消息或 input。
 * 固定上下文与会话上下文的分界由位置表示，不增加重复的元信息字段。
 */
export interface UnifiedModelContext {
  /** 按送入模型的顺序排列；第一个元素必须是唯一的 System Message。 */
  messages: ModelMessage[]
}

/**
 * 用户文本块。Summary 可直接使用字符串，
 * 因此 user content 同时接受字符串与文本块数组；三个协议都只转换文本输入。
 */
export type ModelTextBlock = { type: "text"; text: string }

/**
 * 回放及当前 Turn 使用的统一消息。工具调用留在 assistant 的内容块中；工具结果单独成项，
 * 通过 `toolCallId` 与调用配对。三个协议分别映射为 `tool_result`、`role: "tool"`
 * 与 `function_call_output`。工具结果从 ToolResult.content 中保留所有 text 块及顺序；
 * Chat Completions / Responses 的字符串字段由 Adapter 按顺序直接拼接文本，不添加分隔符。
 * `isError` 来自 ToolResult.status，Anthropic 映射为 `is_error`，另两个协议只传文本。
 */
export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ModelTextBlock[] }
  | { role: "assistant"; content: AssistantContentBlock[] }
  | { role: "tool"; toolCallId: string; content: ModelTextBlock[]; isError: boolean }


/** 工具定义 */


/**
 * 工具暴露层交给 Adapter 的统一定义。`inputSchema` 固定为 JSON Schema；Adapter 映射为
 * Anthropic `input_schema`、Chat Completions / Responses `parameters`。的可选
 * 工具来源由 tools 模块管理；模型层只需要协议可见的名称、说明和参数结构。
 */
export interface UnifiedToolDefinition {
  /** 协议请求中暴露的工具名称。 */
  name: string
  /** 给模型看的工具说明。 */
  description?: string
  /** 该工具的参数 JSON Schema。 */
  inputSchema: Record<string, unknown>
}


/** 请求与流事件 */


/** 统一模型请求。 */
export interface UnifiedModelRequest {
  /** ContextBuilder 生成的完整上下文。 */
  context: UnifiedModelContext
  /** 本次请求向模型暴露的工具定义；为空时不发送协议工具字段。 */
  tools: UnifiedToolDefinition[]
  /** 本请求实际采用的模型，必须与 Adapter 绑定的配置一致。 */
  model: ModelRef
  /** 请求级禁止工具调用；未提供时沿用协议默认行为，仍可携带完整工具定义。 */
  toolChoice?: "none"
}

/**
 * Adapter 的流式输出。每个块按本次请求中的连续 `index` 依次 start / delta / end；
 * Adapter 把协议中的块序号或工具调用序号重新编号，Runtime 用 index 分配 blockId。
 * delta 的 type 必须与 start 的 blockType 一致，end 提供拼装后的完整内容块。
 *
 * 所有 block_end 后恰好产生一个 stream_end，交付最终 Usage、原始 finishReason 与
 * 统一完成状态。Runtime 自行生成 eventId / sessionId / seq / turn / step / blockId。
 * Provider 流错误或用户取消由 Adapter 抛出异常，经 Error Normalizer 处理；错误时
 * 不产生 stream_end，不增加并行的错误事件。
 */
export type ModelCompletion = "finished" | "tool_calls" | "incomplete" | "unknown"

/** 统一块生命周期事件及流结束事件，包含响应索引、完整内容与最终完成信息。 */
export type ModelStreamEvent =
  | {
      type: "block_start"
      /** 本 Step 内的块顺序，从 0 起。 */
      index: number
      /** 该块后续 delta 和 end 使用的统一类型。 */
      blockType: BlockType
    }
  | {
      type: "block_delta"
      /** 与对应 block_start / block_end 相同的块序号。 */
      index: number
      /** 本次收到的内容增量。 */
      delta: AssistantBlockDelta
    }
  | {
      type: "block_end"
      /** 与对应 block_start / block_delta 相同的块序号。 */
      index: number
      /** 已拼装的完整内容块。 */
      block: AssistantContentBlock
    }
  | {
      type: "stream_end"
      /**
       * 统一完成状态：正常最终回答为 finished；有完整工具调用待执行为 tool_calls；
       * token 上限、内容过滤等截断为 incomplete；无法从协议结束信息判定为 unknown。
       * 映射规则（只有已结束的完整 tool_call 才算待执行）：
       *   - Anthropic：end_turn / stop_sequence / refusal → finished；tool_use 且有完整
       *     tool_call → tool_calls；max_tokens / model_context_window_exceeded → incomplete。
       *   - Chat Completions：stop → finished；tool_calls / function_call 且有完整
       *     tool_call → tool_calls；length / content_filter → incomplete。
       *   - Responses：status=completed 且有 function_call → tool_calls，否则为 finished；
       *     status=incomplete → incomplete；status=failed / cancelled 抛出异常。
       * 其它或缺失的结束原因取 unknown；不能凭文本存在就推断 finished。
       */
      completion: ModelCompletion
      /** 该次请求最终确定的权威 Usage。 */
      usage?: Usage
      /** 厂商原始结束原因；Responses 无同名字段时取最终 status 或 incomplete_details.reason。 */
      finishReason?: string
    }

/** 传给协议 SDK 的单次请求选项。 */
export interface ModelStreamOptions {
  /** SDK 请求超时（毫秒）；缺省时沿用 SDK 默认值。 */
  timeoutMs?: number
}

/** 模型适配器。三个 Adapter 均实现此接口。 */
export interface ModelAdapter {
  /** 每 Turn 装配时从同一模型快照提供的压缩及 MCP 预算窗口；直接构造的 Adapter 可不提供。 */
  contextWindow?: number
  /** 与 contextWindow 同一 Turn 配置快照的最大输出；直接构造的 Adapter 可不提供。 */
  maxOutputTokens?: number
  /** 支持思考的 Turn 模型在同一配置快照中声明的档位。 */
  reasoningLevels?: readonly string[]
  /**
   * 把一次统一模型请求转换为协议请求并以统一事件流返回。
   *
   * @param request 当前请求的上下文、工具和模型引用。
   * @param signal 调用方的取消信号；实现必须把它传递到协议请求。
   * @param options 此次调用的 SDK 选项；调用方仍通过 signal 控制整个流的期限。
   * @returns 按块开始、增量、结束及最终流结束事件排列的异步迭代器。
   * @throws `AppError` 请求不符合统一契约、请求失败或被取消时抛出。
   */
  stream(request: UnifiedModelRequest, signal: AbortSignal, options?: ModelStreamOptions): AsyncIterable<ModelStreamEvent>
}
