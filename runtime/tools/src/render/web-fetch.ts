/** 抓取结果整理，不在 Renderer 或整理阶段执行网络请求。 */
import type { AppError } from "../../../error/src/types.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolResult } from "../types.ts"
import type { WebFetchResult } from "../web-fetch/types.ts"

/**
 * 将已处理的完整文本放入统一结果，错误沿用公共整理器。
 * @param result 抓取成功的文本或统一错误。
 * @returns 单文本块成功结果，或不包含部分正文的错误结果。
 */
export function renderWebFetch(result: WebFetchResult | AppError): ToolResult {
  if ("source" in result) return renderCommonError(result)
  return { status: "success", content: [{ type: "text", text: result.text }] }
}
