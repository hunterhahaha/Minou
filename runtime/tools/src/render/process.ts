import type { AppError } from "../../../error/src/types.ts"
import type { ShellResult } from "../shell/types.ts"
import type { ProcessOutputResult } from "../process/types.ts"
import type { TerminalInputResult } from "../terminal/types.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolResult } from "../types.ts"
/**
 * 将已经格式化的文本封装为统一成功工具结果。
 * @param text - 本次工具返回给模型和 UI 的文本。
 * @returns 包含一个 text 内容块的 success 结果。
 */
function success(text: string): ToolResult { return { status: "success", content: [{ type: "text", text }] } }
/**
 * 根据输出元数据拼接截断提示、日志路径、正文和总字节数；只格式化数据，不读取文件或再次截断输出。
 * @param value - 当前输出批次的完整小输出或截断尾部及日志元数据。
 * @param empty - 输出字符串为空时显示的工具专属说明。
 * @returns 可直接放入工具文本内容块的输出说明。
 */
function outputText(value: ProcessOutputResult, empty: string): string {
  const notice = value.truncated ? `[Output truncated: ${Math.ceil(value.totalBytes / 1024)} KB total, showing last 64 KB]\nFull output saved to:\n${value.fullOutputPath}\n\n` : ""
  return `${notice}${value.output.length === 0 ? empty : value.output}\n\nTotal output: ${value.totalBytes} bytes`
}
/**
 * 格式化 Shell 结果；非零退出码仍使用成功结果，AppError 只显示错误说明。
 * @param result - 本次命令的专属成功数据或工具边界产生的 AppError。
 * @returns 含退出码、输出和字节数的成功结果，或不附带部分输出的错误结果。
 */
export function renderShell(result: ShellResult | AppError): ToolResult { return "source" in result ? renderCommonError(result) : success(`Exit code: ${result.exitCode}\n\n${outputText(result, "No output.")}`) }
/**
 * 格式化单次收集窗口的输出与状态快照，不根据正文推断命令状态。
 * @param result - 收集窗口成功数据，或输入、审批、取消和存储失败的 AppError。
 * @returns 包含终端身份、窗口结束时状态、输出和字节数的结果；错误时只包含错误说明。
 */
export function renderTerminalInput(result: TerminalInputResult | AppError): ToolResult { return "source" in result ? renderCommonError(result) : success(`Terminal ID: ${result.terminalId}\nStatus: ${result.status}\n\n${outputText(result, "No new output.")}`) }
