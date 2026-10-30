import type { SandboxMode } from "../../../session/src/session-state.ts"
import type { ToolExecutionContext, ProcessToolRuntimeContext } from "../types.ts"
import type { AppError } from "../../../error/src/types.ts"

/** 执行时从数据库重读的权限和初始 cwd。 */
export interface ProcessAccessState {
  /** 当前 Session Meta 的沙箱模式。 */
  sandboxMode: SandboxMode
  /** 第一个关联目录或分组 workspace。 */
  cwd: string
}
/**
 * 读取当前对话的权限与新进程初始工作目录；实现不得跨调用缓存数据库结果。
 *
 * @param projectId - 对话所属的 Project ID 或 default 分组身份。
 * @param sessionId - 用于读取当前 Session Meta 的对话身份。
 * @returns 本次读取的沙箱模式和工作目录。
 * @throws Error - 配置、Meta 或工作区记录缺失或损坏；工具执行入口负责转换为错误结果。
 */
export type LoadProcessAccess = (projectId: string, sessionId: string) => ProcessAccessState

/**
 * 验证 Runtime 进程上下文，按当前沙箱模式等待顺序审批，并在执行前再次读取配置和取消状态。Full Access 不需要审批，其他模式需要一次明确批准。
 * @param name - 当前请求执行的进程工具名称，用于审批记录和原因说明。
 * @param context - 已检查的业务参数、调用身份、取消信号和 Runtime 注入资源。
 * @param load - 从数据库读取当前权限与工作目录的端口。
 * @returns Runtime 控制的 Session 资源和最新读取的工作目录。
 * @throws Error - 上下文缺失、审批拒绝、取消或配置读取失败；业务工具负责转换为 AppError。
 */
export async function authorizeProcess(name: string, context: ToolExecutionContext<object>, load: LoadProcessAccess): Promise<{ runtime: ProcessToolRuntimeContext; cwd: string }> {
  const runtime = context.processRuntime
  if (!runtime) throw processException("PROCESS_RUNTIME_MISSING", "当前 Session 缺少进程工具上下文")
  let approved = false
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = load(runtime.projectId, runtime.sessionId)
    if (!approved && state.sandboxMode !== "full-access") {
      const decision = await runtime.requestApproval(name, `执行进程工具需要授权：${name}`, context)
      if (decision !== "approved") throw processException(decision === "cancelled" ? "CANCELLED" : "APPROVAL_DENIED", decision === "cancelled" ? "工具调用已取消" : "进程操作未获批准")
      approved = true
    }
  }
  if (context.signal.aborted) throw processException("CANCELLED", "工具调用已取消")
  return { runtime, cwd: load(runtime.projectId, runtime.sessionId).cwd }
}
/**
 * 构造带稳定错误码的异常，供进程操作抛出并由工具边界转换。
 * @param code - Runtime 使用的稳定错误码。
 * @param message - 可以向调用方公开的错误说明。
 * @returns 带 code 属性的 Error；本函数只构造异常，不抛出它。
 */
export function processException(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
/**
 * 将进程边界捕获的异常转为工具 AppError，不添加业务输出或内部堆栈。
 * @param error - 捕获的未知异常或带错误码的 Error。
 * @param fallback - 异常没有字符串 code 属性时使用的默认错误码。
 * @returns source 为 tool 的错误对象，保留可用的错误码和说明。
 */
export function processError(error: unknown, fallback: string): AppError {
  return { source: "tool", code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : fallback, message: error instanceof Error ? error.message : "进程工具执行失败" }
}
