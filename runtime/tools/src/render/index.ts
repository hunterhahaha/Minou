/** 五个文件工具的专属结果整理器，输出模型可见的 ToolResult 文本。 */
import type { AppError } from "../../../error/src/types.ts"
import type {
  GlobResult, GrepResult, ReadResult, WriteResult, EditResult,
} from "../file/types.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolResult } from "../types.ts"

/**
 * 根据结果字段区分业务输出与 AppError。
 * @param value 专属结果或 AppError。
 * @returns 是否为统一错误。
 */
function isError(value: object): value is AppError {
  return "source" in value && "code" in value && "message" in value
}

/**
 * 将业务结果格式化为文本，统一错误交给公共错误整理器。
 * @param value 成功结果或错误。
 * @param format 成功文本格式化函数。
 * @returns 统一工具结果。
 */
function render<T extends object>(value: T | AppError, format: (value: T) => string): ToolResult {
  if (isError(value)) return renderCommonError(value)
  return { status: "success", content: [{ type: "text", text: format(value) }] }
}

/**
 * 整理 glob 路径列表与截断提示，错误使用公共格式。
 * @param value glob 结果或错误。
 * @returns 模型可见的绝对路径列表。
 */
export function renderGlob(value: GlobResult | AppError): ToolResult {
  return render(value, (result) => result.files.length === 0 ? "No files found."
    : `${result.files.join("\n")}${result.truncated ? "\n[Results truncated. Narrow the path or pattern.]" : ""}`)
}

/**
 * 整理匹配行、可选上下文及截断提示，错误使用公共格式。
 * @param value grep 结果或错误。
 * @returns 包含行号和可选上下文的文本。
 */
export function renderGrep(value: GrepResult | AppError): ToolResult {
  return render(value, (result) => {
    if (result.matches.length === 0) return "No matches found."
    const blocks = result.matches.map((match) => [
      match.path,
      ...(match.before ?? []).map((line) => `  ${line.line} | ${line.text}`),
      `> ${match.line} | ${match.text}`,
      ...(match.after ?? []).map((line) => `  ${line.line} | ${line.text}`),
    ].join("\n"))
    return `${blocks.join("\n\n")}${result.truncated ? "\n[Results truncated. Narrow the path or pattern.]" : ""}`
  })
}

/**
 * 整理读取路径、行号和续读提示，错误使用公共格式。
 * @param value read 结果或错误。
 * @returns 含路径、行号和续读提示的文本。
 */
export function renderRead(value: ReadResult | AppError): ToolResult {
  return render(value, (result) => {
    const lines = result.lines.length === 0 ? "No content found."
      : result.lines.map((line) => `${line.number}${line.column === undefined ? "" : `:${line.column}`} | ${line.text}`).join("\n")
    return `${result.path}\n\n${lines}${result.truncated && result.nextOffset !== undefined
      ? `\n[More content available. Continue with offset=${result.nextOffset}${result.nextColumn === undefined ? "" : `, column=${result.nextColumn}`}.]` : ""}`
  })
}

/**
 * 整理文件创建或覆盖操作及写入字节数。
 * @param value write 结果或错误。
 * @returns 文件创建或覆盖说明。
 */
export function renderWrite(value: WriteResult | AppError): ToolResult {
  return render(value, (result) => `${result.path}\n\n${result.operation === "created" ? "Created" : "Overwritten"} successfully.\nBytes written: ${result.bytesWritten}`)
}

/**
 * 整理替换次数和写入字节数。
 * @param value edit 结果或错误。
 * @returns 修改次数和字节数。
 */
export function renderEdit(value: EditResult | AppError): ToolResult {
  return render(value, (result) => `${result.path}\n\nEdited successfully.\nReplacements: ${result.replacements}\nBytes written: ${result.bytesWritten}`)
}
