import type { ToolCallMeta } from "../types.ts"
import type { ProcessOutputResult } from "../process/types.ts"
/** 一次性 PowerShell 命令；cwd 由 Runtime 提供。 */
export interface ShellInput extends ToolCallMeta {
  /** 原始 PowerShell 命令。 */
  command: string
}
/** 正常结束的命令结果；非零退出码仍属于成功结果。 */
export interface ShellResult extends ProcessOutputResult {
  /** 实际 PowerShell 进程退出码。 */
  exitCode: number
}
