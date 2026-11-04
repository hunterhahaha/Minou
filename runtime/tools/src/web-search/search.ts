/** 搜索执行：字符串占位符替换、fetch 透传、JMESPath 映射和结果包装。 */
import { search } from "@jmespath-community/jmespath"
import type { AppError } from "../../../error/src/types.ts"
import { isPlainRecord } from "../tool-registry.ts"
import { readActiveWebSearchProvider } from "./store.ts"
import type { WebSearchInput, WebSearchItem, WebSearchResult } from "./types.ts"

/** 请求和完整响应读取共用的默认超时，不暴露为模型参数。 */
export const WEB_SEARCH_TIMEOUT_MS = 30_000

/**
 * 从当前配置执行一次搜索，仅限制映射后字符串摘要的本地 token 预算，不重试。
 * @param databasePath 已初始化的配置数据库绝对路径。
 * @param input 已校验的模型 query。
 * @param signal 当前工具调用的取消信号。
 * @param estimateTokens 宿主提供的单调文本 token 粗估函数。
 * @returns 摘要至多 800 token 的条目数组，或不包含请求、凭据与原始响应的统一错误。
 */
export async function executeWebSearch(databasePath: string, input: WebSearchInput, signal: AbortSignal, estimateTokens: (text: string) => number): Promise<WebSearchResult | AppError> {
  if (signal.aborted) return failure("CANCELLED", "搜索已取消。")
  let provider
  try { provider = readActiveWebSearchProvider(databasePath) }
  catch { return failure("WEB_SEARCH_CONFIG_INVALID", "无法读取有效的搜索服务商配置。") }
  if (!provider) return failure("WEB_SEARCH_NOT_CONFIGURED", "尚未启用搜索服务商。")

  let url: string
  let requestInit: RequestInit
  try {
    const config: unknown = JSON.parse(substituteQuery(provider.requestJson, input.query))
    if (!isPlainRecord(config) || typeof config.url !== "string" || config.url.trim() === "") throw new Error()
    const { url: requestUrl, ...options } = config
    url = requestUrl
    requestInit = options as RequestInit
  } catch { return failure("WEB_SEARCH_REQUEST_INVALID", "替换后的搜索请求 JSON 或 URL 无效。") }

  const timeout = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)
  const requestSignal = AbortSignal.any([signal, timeout])
  let response: Response | undefined
  let stage: "request" | "json" | "mapping" = "request"
  try {
    response = await fetch(url, { ...requestInit, signal: requestSignal })
    if (!response.ok) return failure("WEB_SEARCH_HTTP_ERROR", `搜索服务返回 HTTP ${response.status}。`)
    stage = "json"
    const data: unknown = await response.json()
    requestSignal.throwIfAborted()
    stage = "mapping"
    const items: unknown = search(data, provider.responseJmespath)
    if (!Array.isArray(items)) return failure("WEB_SEARCH_RESULT_INVALID", "搜索响应的 JMESPath 输出必须是数组。")
    return { results: items.map((item) => {
      if (!isPlainRecord(item) || typeof item.snippet !== "string" || estimateTokens(item.snippet) <= 800) return item
      const snippet = item.snippet
      let low = 0, high = snippet.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (estimateTokens(snippet.slice(0, middle) + "…") <= 800) low = middle
        else high = middle - 1
      }
      /** 避免在高、低代理项之间截断；省略号计入预算。 */
      if (low > 0 && /[\uD800-\uDBFF]/.test(snippet[low - 1]) && /[\uDC00-\uDFFF]/.test(snippet[low] ?? "")) low--
      return { ...item, snippet: snippet.slice(0, low) + "…" }
    }) as WebSearchItem[] }
  } catch {
    if (signal.aborted) return failure("CANCELLED", "搜索已取消。")
    if (timeout.aborted) return failure("WEB_SEARCH_TIMEOUT", "搜索请求超时。")
    if (stage === "json") return failure("WEB_SEARCH_RESPONSE_INVALID", "无法读取搜索服务的 JSON 响应。")
    if (stage === "mapping") return failure("WEB_SEARCH_MAPPING_FAILED", "搜索响应 JMESPath 执行失败。")
    return failure("WEB_SEARCH_REQUEST_FAILED", "搜索请求执行失败，请检查配置或网络。")
  } finally {
    /** 非成功状态不读取正文，但仍释放响应资源；清理失败不覆盖已确定的结果。 */
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined)
  }
}

/**
 * 在请求原文中替换 query；完整字符串占位符按所在 JSON 字符串层级转义。
 * 普通双引号包围的占位符使用 JSON.stringify，预序列化 body 中的转义双引号再多编码一层；
 * URL 等字符串内的嵌入占位符仍按原文字面量替换，不做 URL 编码，也不递归替换 query 内容。
 * @param template 保存的完整 fetch 请求 JSON 原文。
 * @param query 查询原文。
 * @returns 替换后的请求字符串；调用方负责 JSON.parse 和错误处理。
 */
function substituteQuery(template: string, query: string): string {
  const serialized = JSON.stringify(query)
  return template.replace(/(?<!\\)(\\?")\$\{query\}\1|\$\{query\}/g, (_match, quote: string | undefined) => {
    if (quote === '"') return serialized
    if (quote === '\\"') return JSON.stringify(serialized).slice(1, -1)
    return query
  })
}

/**
 * 构造搜索工具的稳定错误，不附带底层异常。
 * @param code 稳定错误码。
 * @param message 不包含请求或响应原文的说明。
 * @returns 统一工具错误。
 */
function failure(code: string, message: string): AppError { return { source: "tool", code, message } }
