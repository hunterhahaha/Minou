/** 搜索工具专属结果整理器，不访问数据库、网络或改写搜索条目。 */
import type { AppError } from "../../../error/src/types.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolResult } from "../types.ts"
import type { WebSearchResult } from "../web-search/types.ts"

/**
 * 将搜索条目按原顺序编号，保留标题、URL、摘要和可选发布时间。
 * @param result JMESPath 结果包装或统一错误。
 * @returns 模型可读搜索文本；空数组为成功的无结果说明，错误使用公共 render。
 */
export function renderWebSearch(result: WebSearchResult | AppError): ToolResult {
  if ("source" in result) return renderCommonError(result)
  const text = result.results.length === 0 ? "No search results found." : result.results.map((item, index) => [
    `${index + 1}. ${item.title}`,
    item.url,
    ...(item.snippet === null ? [] : [item.snippet]),
    ...(item.publishedAt == null ? [] : [`Published: ${item.publishedAt}`]),
  ].join("\n")).join("\n\n")
  return { status: "success", content: [{ type: "text", text }] }
}
