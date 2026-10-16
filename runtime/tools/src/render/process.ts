import type { AppError } from "../../../error/src/types.ts"
import type { ShellResult } from "../shell/types.ts"
import type { ProcessOutputResult } from "../process/types.ts"
import type { TerminalCloseResult, TerminalInputResult, TerminalListResult, TerminalOpenResult } from "../terminal/types.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolResult } from "../types.ts"
/**
 * 将已经格式化的文本封装为统一成功工具结果。
 *
 * @param text - 本次工具返回给模型和 UI 的文本。
 * @returns 包含一个 text 内容块的 success 结果。
 */
function success(text: string): ToolResult { return { status: "success", content: [{ type: "text", text }] } }
/**
 * 根据输出元数据拼接截断提示、日志路径、正文和总字节数；只格式化数据，不读取文件或再次截断输出。
 *
 * @param value - 当前输出批次的完整小输出或截断尾部及日志元数据。
 * @param empty - 输出字符串为空时显示的工具专属说明。
 * @returns 可直接放入工具文本内容块的输出说明。
 */
function outputText(value: ProcessOutputResult, empty: string): string {
  const notice = value.truncated ? `[Output truncated: ${Math.ceil(value.totalBytes / 1024)} KB total, showing last 64 KB]\nFull output saved to:\n${value.fullOutputPath}\n\n` : ""
  return `${notice}${value.output.length === 0 ? empty : value.output}\n\nTotal output: ${value.totalBytes} bytes`
}
/**
 * 按第 22、33 节格式化 Shell 结果；非零退出码仍使用成功结果，AppError 只显示错误说明。
 *
 * @param result - 本次命令的专属成功数据或工具边界产生的 AppError。
 * @returns 含退出码、输出和字节数的成功结果，或不附带部分输出的错误结果。
 */
export function renderShell(result: ShellResult | AppError): ToolResult { return "source" in result ? renderCommonError(result) : success(`Exit code: ${result.exitCode}\n\n${outputText(result, "No output.")}`) }
/**
 * 格式化打开终端后的状态快照或启动错误，不创建或查询终端。
 *
 * @param result - 已就绪终端的独立状态副本，或本次打开失败的 AppError。
 * @returns 包含终端身份、cwd 和实际状态的成功文本，或错误说明。
 */
export function renderTerminalOpen(result: TerminalOpenResult | AppError): ToolResult { return "source" in result ? renderCommonError(result) : success(`Terminal opened.\n\nID: ${result.terminal.id}\nCWD: ${result.terminal.cwd}\nStatus: ${result.terminal.status}`) }
/**
 * 格式化单次收集窗口的输出与状态快照，不根据正文推断命令状态。
 *
 * @param result - 收集窗口成功数据，或输入、审批、取消和存储失败的 AppError。
 * @returns 包含终端身份、窗口结束时状态、输出和字节数的结果；错误时只包含错误说明。
 */
export function renderTerminalInput(result: TerminalInputResult | AppError): ToolResult { return "source" in result ? renderCommonError(result) : success(`Terminal ID: ${result.terminalId}\nStatus: ${result.status}\n\n${outputText(result, "No new output.")}`) }
/**
 * 格式化显式关闭确认或关闭错误，不附带被丢弃的未读输出。
 *
 * @param result - 已完成的关闭确认或本次关闭失败的 AppError。
 * @returns 已关闭终端身份的成功文本，或错误说明。
 */
export function renderTerminalClose(result: TerminalCloseResult | AppError): ToolResult { return "source" in result ? renderCommonError(result) : success(`Terminal closed.\nTerminal ID: ${result.terminalId}`) }
/**
 * 格式化当前对话的活动终端状态副本；查询和权限处理由工具执行函数完成。
 *
 * @param result - 当前 Session 活动终端数组，或查询失败的 AppError。
 * @returns 终端身份、cwd 和状态列表；空列表显示无终端，错误时显示错误说明。
 */
export function renderTerminalList(result: TerminalListResult | AppError): ToolResult { return "source" in result ? renderCommonError(result) : success(result.terminals.length === 0 ? "No terminals found." : result.terminals.map((t) => `${t.id}\nCWD: ${t.cwd}\nStatus: ${t.status}`).join("\n\n")) }
