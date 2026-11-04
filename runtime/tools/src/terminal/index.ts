import { authorizeProcess, processError, processException, type LoadProcessAccess } from "../process/access.ts"
import { isPlainRecord, registerTool, type RenderRegistry, type ToolRegistry } from "../tool-registry.ts"
import { renderTerminalClose, renderTerminalInput, renderTerminalList, renderTerminalOpen } from "../render/process.ts"
import { TerminalRouter } from "./router.ts"
export * from "./types.ts"
export * from "./backend.ts"
export * from "./router.ts"

/**
 * 登记四个 PTY 工具及其参数检查、执行函数和专属 render；修改工具执行前等待审批，terminal_list 只查询当前对话资源。
 * @param tools - 保存模型定义和业务执行函数的工具注册表。
 * @param renders - 按工具名保存结果整理器的注册表。
 * @param router - 按 Project 与 Session 隔离并跨 Turn 持有终端的路由。
 * @param loadAccess - 每次修改操作时读取最新权限和新进程工作目录的端口。
 * @throws Error - 工具或 render 已登记，或注册定义无效；启动装配负责处理登记失败。
 */
export function registerTerminalTools(tools: ToolRegistry, renders: RenderRegistry, router: TerminalRouter, loadAccess: LoadProcessAccess): void {
  const descriptions = {
    terminal_open: `Open a persistent terminal with the bundled PowerShell 7 in the current project working directory. Current platform: ${process.platform}. Use PowerShell 7 syntax for commands. Reuse existing terminals when possible.`,
    terminal_input: `Write input verbatim to a terminal. Current platform: ${process.platform}. Use PowerShell 7 syntax for shell commands. Include \\r to submit a command; use an empty string to poll unread output. Collects up to 3 seconds or until a command completion marker. A running status after timeout does not mean the command has finished. Large output is saved to an absolute path readable with read.`,
    terminal_close: "Terminate a terminal and discard unread output. Close terminals that are no longer needed.",
    terminal_list: "List this session's active terminals with their current working directories and marker-driven running/idle status. Query before choosing a terminal when its state is uncertain.",
  }
  for (const name of ["terminal_open", "terminal_input", "terminal_close", "terminal_list"] as const) {
    const properties: Record<string, unknown> = name === "terminal_input" ? { terminalId: { type: "string" }, input: { type: "string" } } : name === "terminal_close" ? { terminalId: { type: "string" } } : {}
    registerTool<Record<string, string>, object>(tools, renders, {
      kind: "builtin", definition: { name, description: descriptions[name], inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } },
      validateArguments: (value) => isPlainRecord(value) && Object.keys(value).every((key) => Object.hasOwn(properties, key)) && Object.keys(properties).every((key) => typeof value[key] === "string" && (key !== "terminalId" || (value[key] as string).length > 0))
        ? { success: true, data: value as Record<string, string> } : { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message: `${name} 参数无效` } },
      execute: async (input, context) => {
        try {
          if (name === "terminal_list") {
            const runtime = context.processRuntime
            if (!runtime) throw processException("PROCESS_RUNTIME_MISSING", "当前 Session 缺少进程工具上下文")
            return { terminals: router.list(runtime.projectId, runtime.sessionId) }
          }
          const { runtime, cwd } = await authorizeProcess(name, context, loadAccess)
          if (name === "terminal_open") return { terminal: await router.open(runtime.projectId, runtime.sessionId, cwd, runtime.outputDirectory, context.signal) }
          if (name === "terminal_input") return await router.input(runtime.projectId, runtime.sessionId, input.terminalId, input.input, context.toolCallId, context.signal)
          await router.close(runtime.projectId, runtime.sessionId, input.terminalId)
          return { terminalId: input.terminalId, closed: true }
        } catch (error) { return processError(error, "TERMINAL_EXECUTION_FAILED") }
      },
      render: (result) => {
        if ("source" in result) return renderTerminalList(result as import("../../../error/src/types.ts").AppError)
        if (name === "terminal_open") return renderTerminalOpen(result as import("./types.ts").TerminalOpenResult)
        if (name === "terminal_input") return renderTerminalInput(result as import("./types.ts").TerminalInputResult)
        if (name === "terminal_close") return renderTerminalClose(result as import("./types.ts").TerminalCloseResult)
        return renderTerminalList(result as import("./types.ts").TerminalListResult)
      },
    })
  }
}
