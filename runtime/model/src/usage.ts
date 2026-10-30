/**
 * 将三种协议的 Usage 字段转换为互不重叠的输入、缓存与输出计数。
 *
 * Chat Completions 和 Responses 的完整输入需扣除已报告的缓存桶；
 * 可选桶缺失时保留未报告状态，reasoning 属于输出子集，不重复计入总量。
 * 本文件只做字段映射，累计及派生量由统一 Usage 函数计算。
 */

import type { Usage } from "./types.ts"

/**
 * 读取一个可能为 null / undefined 的数字。
 *
 * 两个官方 SDK 把厂商可能缺省的计数字段标成 `T | null`，兼容厂商还可能整段字段缺失，
 * 因此所有读取都走这里，统一把 null 与 undefined 归一为**未报告**。
 *
 * @param value 厂商原始计数字段。
 * @returns 数字原样返回；`null`、`undefined` 或其它值视为未报告。
 */
function readCount(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined
}

/**
 * 从"完整输入 Token"里扣除已报告的缓存桶，得到统一 `inputTokens`（未缓存输入）。
 *
 * 只扣实际报告的桶：缺少 `cacheWriteTokens` 时只扣缓存读取部分，
 * 两个桶都缺时 `inputTokens` 就是完整输入。结果为负说明厂商数字自相矛盾，
 * 按 0 处理（未缓存输入不可能是负值）。
 *
 * @param fullInputTokens 协议报告的完整输入 Token。
 * @param cacheReadTokens 已报告的缓存读取桶。
 * @param cacheWriteTokens 已报告的缓存写入桶。
 * @returns 扣除已报告缓存桶后的非负未缓存输入 Token。
 */
function subtractCacheBuckets(
  fullInputTokens: number,
  cacheReadTokens: number | undefined,
  cacheWriteTokens: number | undefined,
): number {
  const uncached = fullInputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)
  return Math.max(0, uncached)
}


/** Anthropic Messages */


/**
 * Anthropic Messages 的 Usage 原始字段。
 *
 * `message_start` 的 `usage` 与 `message_delta` 的 `usage` 都是这个形状（后者是累计值）。
 */
export interface AnthropicUsageFields {
  /** 未缓存输入 Token。 */
  input_tokens?: number | null
  /** 输出 Token。 */
  output_tokens?: number | null
  /** 从已有 Prompt Cache 读取的输入 Token。 */
  cache_read_input_tokens?: number | null
  /** 创建或写入 Prompt Cache 的输入 Token。 */
  cache_creation_input_tokens?: number | null
  /** 输出中属于 thinking 的 Token；可能不被 Provider 报告。 */
  output_tokens_details?: { thinking_tokens?: number | null } | null
}

/**
 * Anthropic Messages → 统一 Usage。
 *
 *   inputTokens       ← input_tokens（该字段本身就是未缓存输入，不再拆分）
 *   cacheReadTokens   ← cache_read_input_tokens
 *   cacheWriteTokens  ← cache_creation_input_tokens
 *   reasoningTokens   ← output_tokens_details.thinking_tokens
 *
 * `totalTokens` 留空：Anthropic 不返回该字段，统一总量由 `resolveTotalTokens` 从各输入桶与
 * `outputTokens` 相加得到。
 *
 * `thinking_tokens`：仅在 output_tokens_details.thinking_tokens 提供数值时映射 reasoning，缺失时不推算。
 *
 * @param fields Anthropic `message_start` 或 `message_delta` 提供的 Usage 字段。
 * @returns 符合统一 Usage 契约的字段；未报告的可选桶保持为 `undefined`。
 */
export function convertAnthropicUsage(fields: AnthropicUsageFields): Usage {
  const reasoningTokens = readCount(fields.output_tokens_details?.thinking_tokens)

  const usage: Usage = {
    inputTokens: readCount(fields.input_tokens) ?? 0,
    outputTokens: readCount(fields.output_tokens) ?? 0,
  }

  const cacheReadTokens = readCount(fields.cache_read_input_tokens)
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens

  const cacheWriteTokens = readCount(fields.cache_creation_input_tokens)
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens

  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens

  return usage
}


/** OpenAI Chat Completions */


/**
 * Chat Completions 的 Usage 原始字段，含兼容厂商的字段位置。
 *
 * `prompt_cache_hit_tokens` 与顶层 `cached_tokens` 不是 OpenAI 官方字段，
 * 是部分兼容厂商放置缓存命中数的地方，读取顺序见 `convertChatCompletionsUsage`。
 */
export interface ChatCompletionsUsageFields {
  /** 完整输入 Token，包含缓存读取与写入桶。 */
  prompt_tokens?: number | null
  /** 完整输出 Token。 */
  completion_tokens?: number | null
  /** 输入与输出 Token 总数。 */
  total_tokens?: number | null
  /** 官方及兼容厂商提供的输入缓存细分。 */
  prompt_tokens_details?: {
    /** 缓存读取 Token。 */
    cached_tokens?: number | null
    /** 缓存写入 Token。 */
    cache_write_tokens?: number | null
  } | null
  /** 兼容厂商提供的缓存读取 Token 备用字段。 */
  prompt_cache_hit_tokens?: number | null
  /** 兼容厂商提供的缓存读取 Token 顶层备用字段。 */
  cached_tokens?: number | null
  /** 输出中属于 reasoning 的 Token。 */
  completion_tokens_details?: { reasoning_tokens?: number | null } | null
}

/**
 * Chat Completions → 统一 Usage。
 *
 *   cacheReadTokens  ← prompt_tokens_details.cached_tokens
 *                       ｜prompt_cache_hit_tokens｜cached_tokens（兼容读取）
 *   cacheWriteTokens ← prompt_tokens_details.cache_write_tokens（没有则留空，不推算）
 *   inputTokens      ← prompt_tokens − cacheReadTokens − cacheWriteTokens
 *   outputTokens     ← completion_tokens
 *   reasoningTokens  ← completion_tokens_details.reasoning_tokens
 *   totalTokens      ← total_tokens；缺失时用 prompt_tokens + completion_tokens
 *
 * @param fields Chat Completions 最后一个带 Usage 的流 chunk 的字段。
 * @returns 符合统一 Usage 契约的字段；缓存细分缺失时不将其伪造为 0。
 */
export function convertChatCompletionsUsage(fields: ChatCompletionsUsageFields): Usage {
  const promptTokens = readCount(fields.prompt_tokens)
  const completionTokens = readCount(fields.completion_tokens)

  const cacheReadTokens =
    readCount(fields.prompt_tokens_details?.cached_tokens) ??
    readCount(fields.prompt_cache_hit_tokens) ??
    readCount(fields.cached_tokens)
  const cacheWriteTokens = readCount(fields.prompt_tokens_details?.cache_write_tokens)

  const usage: Usage = {
    inputTokens: subtractCacheBuckets(promptTokens ?? 0, cacheReadTokens, cacheWriteTokens),
    outputTokens: completionTokens ?? 0,
  }

  const totalTokens = readCount(fields.total_tokens)
  if (totalTokens !== undefined) {
    usage.totalTokens = totalTokens
  } else if (promptTokens !== undefined && completionTokens !== undefined) {
    usage.totalTokens = promptTokens + completionTokens
  }

  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens

  const reasoningTokens = readCount(fields.completion_tokens_details?.reasoning_tokens)
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens

  return usage
}


/** OpenAI Responses */


/** Responses 的 Usage 原始字段（`response.completed` / `response.incomplete` 的 `response.usage`）。 */
export interface ResponsesUsageFields {
  /** 完整输入 Token，包含缓存读取与写入桶。 */
  input_tokens?: number | null
  /** 完整输出 Token。 */
  output_tokens?: number | null
  /** 输入与输出 Token 总数。 */
  total_tokens?: number | null
  /** 输入缓存细分。 */
  input_tokens_details?: {
    /** 缓存读取 Token。 */
    cached_tokens?: number | null
    /** 缓存写入 Token。 */
    cache_write_tokens?: number | null
  } | null
  /** 输出中属于 reasoning 的 Token。 */
  output_tokens_details?: { reasoning_tokens?: number | null } | null
}

/**
 * Responses → 统一 Usage。
 *
 *   cacheReadTokens  ← input_tokens_details.cached_tokens
 *   cacheWriteTokens ← input_tokens_details.cache_write_tokens（没有则留空，不推算）
 *   inputTokens      ← input_tokens − cacheReadTokens − cacheWriteTokens
 *   outputTokens     ← output_tokens
 *   reasoningTokens  ← output_tokens_details.reasoning_tokens
 *   totalTokens      ← total_tokens（该协议直接提供，缺失则留空，不自行相加）
 *
 * @param fields Responses 终态事件中的 `response.usage` 字段。
 * @returns 符合统一 Usage 契约的字段；缺失的可选协议字段保持未报告。
 */
export function convertResponsesUsage(fields: ResponsesUsageFields): Usage {
  const cacheReadTokens = readCount(fields.input_tokens_details?.cached_tokens)
  const cacheWriteTokens = readCount(fields.input_tokens_details?.cache_write_tokens)
  const inputTokens = readCount(fields.input_tokens) ?? 0

  const usage: Usage = {
    inputTokens: subtractCacheBuckets(inputTokens, cacheReadTokens, cacheWriteTokens),
    outputTokens: readCount(fields.output_tokens) ?? 0,
  }

  const totalTokens = readCount(fields.total_tokens)
  if (totalTokens !== undefined) usage.totalTokens = totalTokens

  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens

  const reasoningTokens = readCount(fields.output_tokens_details?.reasoning_tokens)
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens

  return usage
}
