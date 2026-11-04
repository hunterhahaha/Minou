import { authorizeProcess, processError, type LoadProcessAccess } from "../process/access.ts"
import { isPlainRecord, registerTool, type RenderRegistry, type ToolRegistry } from "../tool-registry.ts"
import { renderShell } from "../render/process.ts"
import { ShellRouter } from "./backend.ts"
export * from "./types.ts"
export * from "./backend.ts"

/**
 * 将 shell 的模型定义、参数检查、执行函数与专属 render 成对登记；进程创建前通过 Session 上下文完成权限检查和审批。
 * @param tools - 保存工具定义和业务执行函数的注册表。
 * @param renders - 保存同名结果整理器的注册表。
 * @param router - 应用启动时创建并共用的一次性 Shell 路由。
 * @param loadAccess - 每次操作时读取最新沙箱模式和工作目录的端口。
 * @throws Error - 工具或 render 已登记，或注册定义无效；启动装配负责处理登记失败。
 */
export function registerShellTools(tools: ToolRegistry, renders: RenderRegistry, router: ShellRouter, loadAccess: LoadProcessAccess): void {
  registerTool(tools, renders, {
    kind: "builtin",
    definition: { name: "shell", description: `Run one command with the bundled PowerShell 7 in the current project working directory. Current platform: ${process.platform}. Use PowerShell 7 syntax. Waits for process exit. Output is limited to the last 64 KB; use read with the saved absolute path for full output.`, inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } },
    validateArguments: (value) => isPlainRecord(value) && Object.keys(value).every((key) => key === "command") && typeof value.command === "string" && value.command.trim().length > 0
      ? { success: true, data: { command: value.command } } : { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message: "shell 只接受非空 command" } },
    execute: async (input, context) => {
      try {
        const { runtime, cwd } = await authorizeProcess("shell", context, loadAccess)
        return await router.execute(input.command, cwd, runtime.outputDirectory, context.toolCallId, context.signal)
      } catch (error) { return processError(error, "SHELL_EXECUTION_FAILED") }
    }, render: renderShell,
  })
}
