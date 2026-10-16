import type { ToolCallMeta } from "../types.ts"
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
/** 打开终端不接受模型指定 cwd。 */
export interface TerminalOpenInput extends ToolCallMeta {}
/** 原样发送命令、交互字符或空输入轮询。 */
export interface TerminalInputInput extends ToolCallMeta {
  /** 当前 Session 的目标终端。 */
  terminalId: string
  /** 原样写入；提交命令须包含回车，空字符串仅收集输出。 */
  input: string
}
/** 显式关闭当前 Session 的终端。 */
export interface TerminalCloseInput extends ToolCallMeta {
  /** 目标终端身份。 */
  terminalId: string
}
/** 查询当前 Session 活动终端，不触发进程审批。 */
export interface TerminalListInput extends ToolCallMeta {}
/** 打开成功后的终端快照。 */
export interface TerminalOpenResult { /** 已就绪终端。 */ terminal: TerminalState }
/** 单次收集窗口的输出与状态快照。 */
export interface TerminalInputResult extends ProcessOutputResult {
  /** 对应终端身份。 */ terminalId: string
  /** 收集边界时的状态；后续事件不修改该结果。 */ status: TerminalState["status"]
}
/** 关闭确认，不附带未读输出。 */
export interface TerminalCloseResult { /** 已关闭身份。 */ terminalId: string; /** 明确关闭成功。 */ closed: true }
/** 当前 Session 的活动终端快照。 */
export interface TerminalListResult { /** 已退出进程不包含在此列表。 */ terminals: TerminalState[] }
