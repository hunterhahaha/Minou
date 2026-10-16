/** 进程启动时创建一次的 Session Runtime 共享能力。 */

import { isAbsolute, join } from "node:path"
import type { ModelAdapter, ModelRef, UnifiedToolDefinition } from "../../runtime/model/src/types.ts"
import type { ExecuteToolCall } from "../../runtime/agent/src/loop.ts"
import type { ToolCallContext, ToolResult } from "../../runtime/tools/src/types.ts"
import { createExecuteToolCall, registerShellTools, registerTerminalTools, ShellRouter, TerminalRouter, type RenderRegistry, type ToolRegistry } from "../../runtime/tools/src/index.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { createTurnModelAdapter } from "./model-adapters.ts"
import { resolveProjectContext } from "./project-context.ts"
import { estimateLocalTokens } from "./token-estimator.ts"
import { loadFileAccessState } from "./file-access.ts"
import { readProjectWorkspace } from "./workspace-store.ts"

/**
 * 持有应用启动时确定的配置路径、工具注册表和共享进程路由。
 * PTY 资源由 TerminalRouter 按 Project 与 Session 身份管理，以便跨 Runtime 活动期复用；Session 持久化状态和 Turn 生命周期仍由 SessionRuntime 管理。
 */
export class SessionRuntimeGlobal {
  private readonly paths: ConfigFilePaths
  private readonly toolRegistry: ToolRegistry
  private readonly toolExecutor: ExecuteToolCall
  /** 不缓存配置；只持有应用期间的进程资源。 */
  readonly shellRouter = new ShellRouter()
  /** 联合 Session 身份绑定终端，正常 Runtime 关闭不会清理它。 */
  readonly terminalRouter = new TerminalRouter()

  /**
   * 绑定启动配置与注册表，成对登记 Shell/PTY 工具并创建统一执行入口；构造时不启动命令或终端进程。
   *
   * @param paths - 启动时初始化的配置根目录及各数据库路径。
   * @param toolRegistry - 应用共用的模型工具定义和业务执行注册表。
   * @param renderRegistry - 应用共用的工具结果整理器注册表。
   * @throws Error - 配置根目录不是绝对路径，或 Shell/PTY 工具登记失败；启动装配负责报告初始化错误。
   */
  constructor(
    paths: ConfigFilePaths,
    toolRegistry: ToolRegistry,
    renderRegistry: RenderRegistry,
  ) {
    if (!isAbsolute(paths.rootDir)) {
      throw new Error("Project Context 根目录必须是绝对路径：" + paths.rootDir)
    }
    this.paths = paths
    this.toolRegistry = toolRegistry
    const loadProcessAccess = (projectId: string, sessionId: string) => {
      const { sandboxMode } = loadFileAccessState(this.paths, projectId, sessionId)
      const directories = projectId === "default" ? [] : readProjectWorkspace(this.paths.workspaceDatabasePath, projectId).directories
      return { sandboxMode, cwd: directories[0] ?? join(this.paths.rootDir, "sessions", projectId, "workspace") }
    }
    registerShellTools(toolRegistry, renderRegistry, this.shellRouter, loadProcessAccess)
    registerTerminalTools(toolRegistry, renderRegistry, this.terminalRouter, loadProcessAccess)
    this.toolExecutor = createExecuteToolCall(toolRegistry, renderRegistry)
  }

  /**
   * 请求此对话全部活动 PTY 发送一次 Ctrl+C；发送本身不改变状态，状态仍由对应后端完成标记更新。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 需要中断其活动终端的 Session ID。
   * @returns 发送 Ctrl+C 时捕获的异常列表，供 SessionRuntime 的错误记录出口处理。
   */
  interruptTerminals(projectId: string, sessionId: string): unknown[] {
    return this.terminalRouter.interrupt(projectId, sessionId)
  }

  /**
   * 应用退出时并发清理共享 Shell 和 PTY 资源，等待所有清理任务结束后统一报告失败。
   *
   * @returns 全部进程工具清理完成时兑现的 Promise。
   * @throws AggregateError - 一个或多个清理任务失败；Electron 宿主负责记录并完成退出流程。
   */
  async disposeProcessTools(): Promise<void> {
    const results = await Promise.allSettled([this.shellRouter.dispose(), this.terminalRouter.dispose()])
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason)
    if (errors.length) throw new AggregateError(errors, "部分进程工具清理失败")
  }

  /**
   * 使用现有 Project Context 解析逻辑读取对应分组。
   * @param projectId 当前 Session 所属 Project/default 分组。
   * @returns 该分组的工作区说明和基线读取能力。
   * @throws Error Project 配置或目录不可用。
   */
  resolveProjectContext(projectId: string): ReturnType<typeof resolveProjectContext> {
    return resolveProjectContext({
      rootDirectory: this.paths.rootDir,
      estimateSkillTokens: (description) => this.estimateSkillTokens(description),
    }, projectId)
  }

  /**
   * 使用现有本地 Token 估算器计算 Skill 描述。
   * @param description Skill 的描述。
   * @returns 用于上下文计算的本地 Token 估算值。
   */
  estimateSkillTokens(description: string): number {
    return estimateLocalTokens(description)
  }

  /**
   * 每次调用现有模型工厂创建一个 Turn 的 Adapter。
   * @param model 当前 Turn 的模型引用。
   * @returns 此 Turn 独占的 Adapter。
   * @throws Error 模型配置或凭据不可用。
   */
  createTurnModelAdapter(model: ModelRef): Promise<ModelAdapter> {
    return createTurnModelAdapter(this.paths, model)
  }

  /**
   * 复制当前注册工具的模型定义，并在参数 Schema 中加入可选 callDescription；不修改注册表原定义。
   *
   * @returns 当前模型请求可使用的工具定义副本。
   */
  listToolDefinitions(): UnifiedToolDefinition[] {
    return this.toolRegistry.listDefinitions().map((tool) => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...(tool.inputSchema.properties as Record<string, unknown>),
          callDescription: { type: "string" },
        },
      },
    }))
  }

  /**
   * 通过启动时创建的统一执行器运行一次工具调用。
   * @param name 工具名称。
   * @param args 模型给出的原始参数。
   * @param context 当前工具调用身份和 Session 执行上下文。
   * @returns 现有统一工具执行器的结果。
   */
  executeTool(
    name: string,
    args: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    return this.toolExecutor(name, args, context)
  }
}
