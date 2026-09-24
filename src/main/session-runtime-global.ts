/** 进程启动时创建一次的 Session Runtime 共享能力。 */

import { isAbsolute } from "node:path"
import type { ModelAdapter, ModelRef, UnifiedToolDefinition } from "../../runtime/model/src/types.ts"
import type { ExecuteToolCall } from "../../runtime/agent/src/loop.ts"
import type { ToolCallContext, ToolResult } from "../../runtime/tools/src/types.ts"
import { createExecuteToolCall, type RenderRegistry, type ToolRegistry } from "../../runtime/tools/src/index.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { createTurnModelAdapter } from "./model-adapters.ts"
import { resolveProjectContext } from "./project-context.ts"
import { estimateLocalTokens } from "./token-estimator.ts"

/**
 * 持有进程级配置和工具注册表；Session 专属状态由 SessionRuntime 自己持有。
 */
export class SessionRuntimeGlobal {
  private readonly paths: ConfigFilePaths
  private readonly toolRegistry: ToolRegistry
  private readonly toolExecutor: ExecuteToolCall

  /**
   * 绑定启动时初始化的配置和工具注册表。
   * @param paths 启动时初始化的配置与数据库位置。
   * @param toolRegistry 当前进程的工具注册表。
   * @param renderRegistry 当前进程的工具结果整理器。
   * @throws Error 配置根目录不是绝对路径。
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
    this.toolExecutor = createExecuteToolCall(toolRegistry, renderRegistry)
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

  /** @returns 当前注册工具的模型可见定义，包含 callDescription 参数。 */
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
