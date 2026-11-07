/** Step 前压缩的独立请求边界：不执行工具、不写事件，也不改写调用方上下文。 */
import { createAbortError } from "../../error/src/abort.ts"
import type { ModelAdapter, ModelMessage, ModelRef, UnifiedToolDefinition, Usage } from "../../model/src/types.ts"
import { COMPACT_PROMPT } from "./compact-prompt.ts"

/** 独立压缩调用的输入；Adapter 与规格由当前 Turn 固定。 */
export interface SummaryRequest {
  /** 当前 Turn 绑定的协议 Adapter。 */
  adapter: ModelAdapter
  /** 与 Adapter 一致的模型引用。 */
  model: ModelRef
  /** 同步后的完整上下文，首项必须为原有系统消息。 */
  content: readonly ModelMessage[]
  /** 紧随压缩执行的正常请求所用的同一份工具快照。 */
  tools: readonly UnifiedToolDefinition[]
  /** 当前 Turn 的取消信号。 */
  signal: AbortSignal
}

/** 只有正常完成且非空的文本才能成为待提交 Summary。 */
export interface SummaryResult {
  /** 已结束文本块按顺序组合出的正文；不含 thinking。 */
  summary: string
  /** 压缩请求本身的最终 Usage。 */
  usage?: Usage
}

/**
 * 按项目确认的公式计算阈值，不对非正结果额外夹值。
 * @param contextWindow 当前模型的最大上下文。
 * @param maxOutputTokens 同一配置快照的最大输出。
 * @returns 触发完整上下文压缩的 Token 阈值。
 * @throws Error 模型规格缺失、不是正安全整数时抛出，调用方应终止 Turn。
 */
export function summaryThreshold(contextWindow: number | undefined, maxOutputTokens: number | undefined): number {
  if (contextWindow === undefined || maxOutputTokens === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("Summary 需要当前 Turn 模型有效的 contextWindow 和 maxOutputTokens。")
  }
  return Math.min(contextWindow * 0.8, contextWindow - maxOutputTokens - (10000 + maxOutputTokens))
}

/**
 * 直接消费 Adapter 流，保留完整输入并追加临时压缩指令，拒绝任何工具调用。
 * @param options 当前模型、完整输入、工具快照及取消信号；不接收工具执行器。
 * @returns 可提交的完整文本及本次 Usage；不修改入参、不产生 Session 事件。
 * @throws Error 空输出、非正常结束、未闭合内容块或工具调用时抛出；协议异常原样传播。
 * @throws Error 取消时抛出 AbortError；调用方负责 Turn 收尾且不得提交 Summary。
 */
export async function compressContext(options: SummaryRequest): Promise<SummaryResult> {
  const { adapter, model, content, tools, signal } = options
  if (signal.aborted) throw createAbortError()
  const pending = new Set<number>()
  const texts = new Map<number, string>()
  let finished = false
  let usage: Usage | undefined
  const request = {
    model: structuredClone(model),
    context: { purpose: "summary" as const, messages: [...structuredClone(content), { role: "user" as const, content: COMPACT_PROMPT }] },
    tools: structuredClone([...tools]),
    toolChoice: "none" as const,
  }
  for await (const event of adapter.stream(request, signal)) {
    if (signal.aborted) throw createAbortError()
    if (finished) throw new Error("Summary 在流结束后仍收到内容。")
    if ((event.type === "block_start" && event.blockType === "tool_call") ||
        (event.type === "block_delta" && event.delta.type === "tool_call") ||
        (event.type === "block_end" && event.block.type === "tool_call")) {
      throw new Error("Summary 模型返回了工具调用，压缩失败。")
    }
    if (event.type === "block_start") {
      if (pending.has(event.index) || texts.has(event.index)) throw new Error("Summary 内容块重复。")
      pending.add(event.index)
    } else if (event.type === "block_end") {
      if (!pending.delete(event.index)) throw new Error("Summary 内容块未开始。")
      if (event.block.type === "text") texts.set(event.index, event.block.text)
    } else if (event.type === "stream_end") {
      if (event.completion !== "finished" || pending.size > 0) throw new Error("Summary 模型未正常完成压缩。")
      finished = true
      usage = event.usage === undefined ? undefined : structuredClone(event.usage)
    }
  }
  if (signal.aborted) throw createAbortError()
  const summary = [...texts].sort(([left], [right]) => left - right).map(([, value]) => value).join("")
  if (!finished || summary.trim().length === 0) throw new Error("Summary 缺少完整的非空正文或最终结束事件。")
  return { summary, ...(usage === undefined ? {} : { usage }) }
}
