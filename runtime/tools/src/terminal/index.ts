import { authorizeProcess, processError, type LoadProcessAccess } from "../process/access.ts"
import { isPlainRecord, registerTool, type RenderRegistry, type ToolRegistry } from "../tool-registry.ts"
import { renderTerminalInput } from "../render/process.ts"
import { TerminalRouter } from "./router.ts"
import type { TerminalInputResult } from "./types.ts"
import type { AppError } from "../../../error/src/types.ts"
export * from "./types.ts"
export * from "./backend.ts"
export * from "./router.ts"

/**
 * 登记新建并执行、复用终端两个工具；两者执行前都经过进程权限检查。
 * @param tools - 保存模型定义和业务执行函数的工具注册表。
 * @param renders - 按工具名保存结果整理器的注册表。
 * @param router - 按 Project 与 Session 隔离并跨 Turn 持有终端的路由。
 * @param loadAccess - 每次修改操作时读取最新权限和新进程工作目录的端口。
 * @throws Error - 工具或 render 已登记，或注册定义无效；启动装配负责处理登记失败。
 */
export function registerTerminalTools(tools: ToolRegistry, renders: RenderRegistry, router: TerminalRouter, loadAccess: LoadProcessAccess): void {
  const descriptions = {
    terminal_open: `Open a persistent terminal in the current project working directory, run the supplied command, and return its ID and collected output. Current platform: ${process.platform}. Use PowerShell 7 syntax for commands. Collects up to 3 seconds or until command completion. Use terminal_input to reuse the terminal or poll more output. Creating a terminal at capacity evicts the least recently used terminal.`,
    terminal_input: `Write input verbatim to a terminal. Current platform: ${process.platform}. Use PowerShell 7 syntax for shell commands. Include \\r to submit a command; use an empty string to poll unread output. Collects up to 3 seconds or until a command completion marker. A running status after timeout does not mean the command has finished. Large output is saved to an absolute path readable with read.`,
  }
  for (const name of ["terminal_open", "terminal_input"] as const) {
    const properties: Record<string, unknown> = name === "terminal_input" ? { terminalId: { type: "string" }, input: { type: "string" } } : { command: { type: "string", minLength: 1 } }
    registerTool<Record<string, string>, TerminalInputResult | AppError>(tools, renders, {
      kind: "builtin", definition: { name, description: descriptions[name], inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } },
      validateArguments: (value) => isPlainRecord(value) && Object.keys(value).every((key) => Object.hasOwn(properties, key)) && Object.keys(properties).every((key) => typeof value[key] === "string" && (key === "input" || (value[key] as string).trim().length > 0))
        ? { success: true, data: value as Record<string, string> } : { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message: `${name} 参数无效` } },
      execute: async (input, context) => {
        try {
          const { runtime, cwd } = await authorizeProcess(name, context, loadAccess)
          if (name === "terminal_open") {
            return await router.openAndRun(runtime.projectId, runtime.sessionId, cwd, runtime.outputDirectory, input.command, context.toolCallId, context.signal)
          }
          return await router.input(runtime.projectId, runtime.sessionId, input.terminalId, input.input, context.toolCallId, context.signal)
        } catch (error) { return processError(error, "TERMINAL_EXECUTION_FAILED") }
      },
      render: renderTerminalInput,
    })
  }
}
