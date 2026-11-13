import type { ProcessOutputResult } from "../process/types.ts"
/** 按 Session 隔离的活动终端状态，不持续注入模型上下文。 */
export interface TerminalState {
  /** Runtime 创建的终端身份。 */
  id: string
  /** 最后通过后端标记确认的 cwd。 */
  cwd: string
  /** 仅由命令开始/完成标记更新；unknown 用于尚未就绪或已退出记录。 */
  status: "unknown" | "running" | "idle"
}
/** 新建终端并提交的首条命令，工作目录由 Runtime 决定。 */
export interface TerminalOpenInput {
  /** 非空白的 PowerShell 命令。 */
  command: string
}
/** 原样发送命令、交互字符或空输入轮询。 */
export interface TerminalInputInput {
  /** 当前 Session 的目标终端。 */
  terminalId: string
  /** 原样写入；提交命令须包含回车，空字符串仅收集输出。 */
  input: string
}
/** 单次收集窗口的输出与状态快照。 */
export interface TerminalInputResult extends ProcessOutputResult {
  /** 对应终端身份。 */ terminalId: string
  /** 收集边界时的状态；后续事件不修改该结果。 */ status: TerminalState["status"]
}
