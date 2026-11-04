/** 抓取结果整理，不在 Renderer 或整理阶段执行网络请求。 */
import type { AppError } from "../../../error/src/types.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolResult } from "../types.ts"
import type { WebFetchResult } from "../web-fetch/types.ts"

/**
 * 将正文放入统一结果，截断时在末尾追加模型可读说明和全文路径；不执行文件读写。
 * @param result 抓取成功的文本或统一错误。
 * @returns 单文本块成功结果（提示不计入正文上限），或不包含部分正文的错误结果。
 */
export function renderWebFetch(result: WebFetchResult | AppError): ToolResult {
  if ("source" in result) return renderCommonError(result)
  const notice = result.truncated ? `\n…\n\n[Output truncated: ${result.totalBytes} bytes total, showing the first 32 KiB or less.]\nFull output saved to:\n${result.fullOutputPath}\nUse read with this path to inspect the saved content.` : ""
  return { status: "success", content: [{ type: "text", text: result.text + notice }] }
}
