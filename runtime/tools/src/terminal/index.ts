import { authorizeProcess, authorizeSandboxedProcess, processError, processException, type LoadProcessAccess } from "../process/access.ts"
import { isPlainRecord, registerTool, type RenderRegistry, type ToolRegistry } from "../tool-registry.ts"
import { renderTerminalInput } from "../render/process.ts"
import type { MxcBackend } from "../security/mxc.ts"
import { executionPermissionProperties, readExecutionPermission, type ExecutionPermission } from "../security/permissions.ts"
import { TerminalRouter } from "./router.ts"
import type { TerminalInputResult } from "./types.ts"
import type { AppError } from "../../../error/src/types.ts"
export * from "./types.ts"
export * from "./backend.ts"
export * from "./router.ts"

/**
 * 登记新建并执行、复用终端两个工具；桌面终端仅在新建时决定进程权限。
 * @param tools - 保存模型定义和业务执行函数的工具注册表。
 * @param renders - 按工具名保存结果整理器的注册表。
 * @param router - 按 Project 与 Session 隔离并跨 Turn 持有终端的路由。
 * @param loadAccess - 读取最新会话权限和新进程工作目录的端口。
 * @param sandbox 桌面的 MXC 后端或受阻模式；CLI 省略。
 * @throws Error - 工具或 render 已登记，或注册定义无效；启动装配负责处理登记失败。
 */
export function registerTerminalTools(tools: ToolRegistry, renders: RenderRegistry, router: TerminalRouter, loadAccess: LoadProcessAccess, sandbox?: MxcBackend | null): void {
  const fields = sandbox === undefined ? {} : executionPermissionProperties
  const descriptions = {
    terminal_open: `Open a persistent terminal in the current project working directory, run the supplied command, and return its ID and collected output. Current platform: ${process.platform}. Use PowerShell 7 syntax for commands. Collects up to 3 seconds or until command completion. Prefer a new terminal for each independent command. Reuse a terminal only for related commands, interaction with the same program, or polling its output. Terminal permissions are fixed when it is opened. Creating a terminal at capacity evicts the least recently used terminal.`,
    terminal_input: `Write input verbatim to an existing terminal under its original permissions. Use only for related commands or interaction in that terminal. Current platform: ${process.platform}. Use PowerShell 7 syntax for shell commands. Include \\r to submit a command; use an empty string to poll unread output. Collects up to 3 seconds or until a command completion marker. A running status after timeout does not mean the command has finished. Large output is saved to an absolute path readable with read.`,
  }
  for (const name of ["terminal_open", "terminal_input"] as const) {
    const opening = name === "terminal_open"
    const properties = opening
      ? { command: { type: "string", minLength: 1 }, ...fields }
      : { terminalId: { type: "string" }, input: { type: "string" } }
    const required = opening ? ["command"] : ["terminalId", "input"]
    registerTool<{ command: string; execution?: ExecutionPermission } | { terminalId: string; input: string }, TerminalInputResult | AppError>(tools, renders, {
      kind: "builtin", definition: { name, description: descriptions[name], inputSchema: { type: "object", properties, required, additionalProperties: false } },
      validateArguments: (value) => {
        if (isPlainRecord(value) && Object.keys(value).every((key) => Object.hasOwn(properties, key))) {
          if (opening && typeof value.command === "string" && value.command.trim()) {
            const execution = readExecutionPermission(value)
            if (execution) return { success: true, data: { command: value.command, ...(sandbox !== undefined && { execution }) } }
          }
          if (!opening && typeof value.terminalId === "string" && value.terminalId.trim() && typeof value.input === "string") {
            return { success: true, data: { terminalId: value.terminalId, input: value.input } }
          }
        }
        return { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message: `${name} 参数无效` } }
      },
      execute: async (input, context) => {
        try {
          if ("command" in input) {
            const launch: Awaited<ReturnType<typeof authorizeSandboxedProcess>> = sandbox === undefined
              ? await authorizeProcess(name, context, loadAccess)
              : await authorizeSandboxedProcess("terminal_open", input.command, input.execution!, context, loadAccess, sandbox)
            const { runtime, cwd, access } = launch
            return await router.openAndRun(runtime.projectId, runtime.sessionId, cwd, runtime.outputDirectory,
              input.command, context.toolCallId, context.signal, access)
          }
          const runtime = sandbox === undefined ? (await authorizeProcess(name, context, loadAccess)).runtime : context.processRuntime
          if (!runtime) throw processException("PROCESS_RUNTIME_MISSING", "当前 Session 缺少进程工具上下文")
          return await router.input(runtime.projectId, runtime.sessionId, input.terminalId, input.input, context.toolCallId, context.signal)
        } catch (error) { return processError(error, "TERMINAL_EXECUTION_FAILED") }
      },
      render: renderTerminalInput,
    })
  }
}
