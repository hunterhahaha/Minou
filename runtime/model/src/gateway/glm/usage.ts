import type { Usage } from "../../types.ts"
import { convertAnthropicUsage, convertChatCompletionsUsage, convertResponsesUsage } from "../../usage.ts"
import type { AnthropicUsageFields, ChatCompletionsUsageFields, ResponsesUsageFields } from "../../usage.ts"
import type { GlmProvider } from "./provider.ts"

/**
 * 校验 SDK 返回的计数，保留显式零。
 * @param value Provider 报告的 token 数。
 * @returns 非负整数或未报告。
 */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * 将一块 Chat Usage 转换为可替换上一个快照的用量。
 * @param usage 原始块中的累计 Usage。
 * @param provider 已识别平台使用文档字段，自定义名称允许通用缓存字段。
 * @returns 收到有效计数时返回统一 Usage。
 */
export function chatUsage(usage: ChatCompletionsUsageFields | null | undefined, provider: GlmProvider): Usage | undefined {
  if (usage == null) return undefined
  const cached = count(usage.prompt_tokens_details?.cached_tokens)
  const written = count(usage.prompt_tokens_details?.cache_write_tokens)
  const reasoning = count(usage.completion_tokens_details?.reasoning_tokens)
  const fields = {
    prompt_tokens: count(usage.prompt_tokens),
    completion_tokens: count(usage.completion_tokens),
    total_tokens: count(usage.total_tokens),
    ...(provider === "default" ? {
      prompt_cache_hit_tokens: count(usage.prompt_cache_hit_tokens),
      cached_tokens: count(usage.cached_tokens),
    } : {}),
  }
  if (Object.values(fields).every((value) => value === undefined) && [cached, written, reasoning].every((value) => value === undefined)) return undefined
  return convertChatCompletionsUsage({ ...fields, prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    completion_tokens_details: { reasoning_tokens: reasoning } })
}

/**
 * 转换 Responses 终态用量，两家平台与通用协议使用相同的已报告字段。
 * @param usage 原始终态事件中的 Usage。
 * @returns 收到有效计数时返回统一 Usage。
 */
export function responsesUsage(usage?: ResponsesUsageFields | null): Usage | undefined {
  if (usage == null) return undefined
  const fields = {
    input_tokens: count(usage.input_tokens), output_tokens: count(usage.output_tokens), total_tokens: count(usage.total_tokens),
  }
  const cached = count(usage.input_tokens_details?.cached_tokens)
  const written = count(usage.input_tokens_details?.cache_write_tokens)
  const reasoning = count(usage.output_tokens_details?.reasoning_tokens)
  if (Object.values(fields).every((value) => value === undefined) && [cached, written, reasoning].every((value) => value === undefined)) return undefined
  return convertResponsesUsage({ ...fields, input_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    output_tokens_details: { reasoning_tokens: reasoning } })
}

/**
 * 按字段覆盖 Messages 用量快照，保留后续事件省略的早期输入及缓存。
 * @param previous 当前尝试已收到的原始用量。
 * @param update 新的 message_start 或 message_delta 用量。
 * @returns 合并的有效字段，始终未报告有效计数时省略。
 */
export function mergeMessagesUsage(previous?: AnthropicUsageFields, update?: AnthropicUsageFields | null): AnthropicUsageFields | undefined {
  const fields = {
    input_tokens: count(update?.input_tokens) ?? previous?.input_tokens,
    output_tokens: count(update?.output_tokens) ?? previous?.output_tokens,
    total_tokens: count(update?.total_tokens) ?? previous?.total_tokens,
    cache_read_input_tokens: count(update?.cache_read_input_tokens) ?? previous?.cache_read_input_tokens,
    cache_creation_input_tokens: count(update?.cache_creation_input_tokens) ?? previous?.cache_creation_input_tokens,
  }
  const thinking = count(update?.output_tokens_details?.thinking_tokens) ?? previous?.output_tokens_details?.thinking_tokens
  if (thinking == null && Object.values(fields).every((value) => value === undefined)) return undefined
  return { ...fields, ...(thinking != null ? { output_tokens_details: { thinking_tokens: thinking } } : {}) }
}
