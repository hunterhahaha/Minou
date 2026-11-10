import type { MCPLoadResult } from "../../mcp/src/manager.ts"
/**
 * 工具调用身份、Session 资源、业务执行上下文和统一 ToolResult 的数据契约。
 *
 * 身份与权限资源由 Runtime 注入；模型只提供工具业务参数。
 * 结果整理器将业务结果或 AppError 转为模型可见内容，运行层负责事件记录与上下文回填。
 */

import type { AppError } from "../../error/src/types.ts"
import type { ApprovalDecision } from "../../session/src/events.ts"
import type { TurnFileChangeTracker } from "../../session/src/file-changes.ts"
import type { SessionLoadedMCPTool } from "../../mcp/src/types.ts"
import type { SandboxMode } from "../../session/src/session-state.ts"
import type { BlackboardInput, CommunicationInput, TeamToolOutput } from "./team/types.ts"

/**
 * AgentLoop 交给统一工具执行入口的调用身份。
 *
 * 这些字段由 Runtime 产生，不来自模型参数；Session 专属资源由调用方通过闭包提供。
 */
export interface ToolCallContext {
  /** 仅 Team Runtime 注入的协作权限与操作。 */
  teamRuntime?: {
    role: "router" | "member"
    communicate(input: CommunicationInput, signal: AbortSignal): Promise<TeamToolOutput>
    blackboard(input: BlackboardInput): TeamToolOutput
  }
  /** SessionRuntime 注入的 Project/default 身份；记忆工具要求此字段，模型不可指定。 */
  projectId?: string
  /** 当前工具调用所属的 Turn 编号。 */
  turn: number
  /** 当前工具调用所属的 Step 编号。 */
  step: number
  /** 工具调用对应的 assistant Block ID。 */
  blockId: string
  /** 模型生成的工具调用 ID。 */
  toolCallId: string
  /** 已持久化工具调用块的事件身份；审批事件需要引用它。 */
  toolCallEventId?: string
  /** 当前 AgentLoop 的取消信号。 */
  signal: AbortSignal
  /** 由 SessionRuntime 注入的当前 Session 文件工具资源。 */
  fileRuntime?: FileToolRuntimeContext
  /** Runtime 注入的进程工具身份、输出目录和审批出口。 */
  processRuntime?: ProcessToolRuntimeContext
  /** 当前 Session 的 MCP 持久化、模型预算和审批边界。 */
  mcpRuntime?: MCPToolRuntimeContext
}

/** 由 SessionRuntime 注入的 MCP 访问端口；模型不能提供这些字段。 */
export interface MCPToolRuntimeContext {
  /** 当前所属分组。 */ projectId: string
  /** 当前 Session 身份。 */ sessionId: string
  /** 当前 Turn 固定的上下文窗口；未装配模型规格时不能载入工具。 */ contextWindow?: number
  /**
   * 从当前 Session Meta 读取并校验独立的 MCP 载入状态。
   * @returns 当前 Meta 中的独立载入记录。
   * @throws Error 状态损坏或不可读取。
   */
  readLoadedTools(): Promise<SessionLoadedMCPTool[]>
  /**
   * 更新 Session 的 MCP 状态。载入操作带变更批次，普通调用只刷新 Meta。
   * @param tools 完整新状态。
   * @param change 本次载入结果。
   * @throws Error 持久化失败，由执行边界归一化。
   * @returns 载入状态与定义保存完成后解析。
   */
  writeLoadedTools(tools: SessionLoadedMCPTool[], change?: MCPLoadResult): Promise<void>
  /**
   * 重新读取当前 Session 的持久化权限模式。
   * @returns 本次检查时当前权限。
   * @throws Error 设置不可读取。
   */
  readSandboxMode(): Promise<SandboxMode>
  /**
   * 通过 Session 端口提交审批请求并等待决定或取消。
   * @param toolName 模型侧名称。
   * @param reason 审批原因。
   * @param context 完整调用身份。
   * @returns 审批或取消结果。
   * @throws Error 审批事件写入失败。
   */
  requestApproval(toolName: string, reason: string, context: ToolExecutionContext<object>): Promise<ApprovalDecision>
}

/** 进程工具的 Session 边界；不包含文件变更追踪器。 */
export interface ProcessToolRuntimeContext {
  /** 所属分组。 */ projectId: string
  /** 对话身份。 */ sessionId: string
  /** Session 已初始化的工具输出绝对目录。 */ outputDirectory: string
  /**
   * 通过当前 Session 的审批出口记录请求，顺序等待用户决定，再记录结果。
   * @param toolName - 需要审批的进程工具名称。
   * @param reason - 供审批卡片和事件记录使用的操作说明。
   * @param context - 当前调用身份、已校验的完整参数和取消信号。
   * @returns 用户的 approved/denied 决定，或 Stop 产生的 cancelled。
   * @throws Error - 审批事件写入失败或缺少调用事件身份；工具执行边界负责转换为错误结果。
   */
  requestApproval(toolName: string, reason: string, context: ToolExecutionContext<object>): Promise<ApprovalDecision>
}

/** 文件工具调用所需的 Session 身份、Turn 追踪器和审批出口。 */
export interface FileToolRuntimeContext {
  /** 当前 Project/default 分组身份。 */
  projectId: string
  /** 当前对话身份。 */
  sessionId: string
  /** 当前 Turn 的临时文件快照字典。 */
  tracker: TurnFileChangeTracker
  /**
   * 写审批事件并等待本次调用的决定。
   * @param toolName 当前工具名称。
   * @param path 已规范化的绝对目标路径。
   * @param context 当前工具调用身份及完整参数。
   * @returns 用户决定或 Stop 产生的 cancelled。
   */
  requestApproval(toolName: string, path: string, context: ToolExecutionContext<object>): Promise<ApprovalDecision>
}

/**
 * 已完成参数检查后传给已登记工具的执行上下文。
 *
 * `validatedArguments` 保留完整的已校验业务参数，用于审批记录。
 */
export interface ToolExecutionContext<TArguments extends object = Record<string, unknown>>
  extends ToolCallContext {
  /** 完整的已检查业务参数。 */
  validatedArguments: TArguments
}

/**
 * 工具结果的统一内容块。
 *
 * 成功与错误分支都必须有 content。当前三种模型协议的工具结果转换**只处理 `type = "text"`**，
 * 其余类型是统一结构保留的表达能力，不在当前协议转换范围内。
 */
export type ToolResultContent =
  | ToolResultTextContent
  | ToolResultImageContent
  | ToolResultAudioContent
  | ToolResultResourceContent
  | ToolResultResourceLinkContent

/**
 * 模型可消费的纯文本工具内容。
 */
export interface ToolResultTextContent {
  /** 当前内容块的固定类型标记。 */
  type: "text"
  /** 纯文本内容。 */
  text: string
}

/**
 * 携带 base64 数据和 MIME 类型的图像内容。
 */
export interface ToolResultImageContent {
  /** 当前内容块的固定类型标记。 */
  type: "image"
  /** base64。 */
  data: string
  /** 内容对应的 MIME 类型。 */
  mimeType: string
}

/**
 * 携带 base64 数据和 MIME 类型的音频内容。
 */
export interface ToolResultAudioContent {
  /** 当前内容块的固定类型标记。 */
  type: "audio"
  /** base64。 */
  data: string
  /** 内容对应的 MIME 类型。 */
  mimeType: string
}

/**
 * 内嵌的文本或二进制资源，按 URI 标识。
 */
export interface ToolResultResourceContent {
  /** 当前内容块的固定类型标记。 */
  type: "resource"
  /** 内嵌资源的位置、类型与文本或二进制内容。 */
  resource: {
    uri: string
    mimeType?: string
    /** 文本资源。 */
    text?: string
    /** base64 二进制资源。 */
    blob?: string
  }
}

/**
 * 指向外部资源的 URI 与可选描述信息。
 */
export interface ToolResultResourceLinkContent {
  /** 当前内容块的固定类型标记。 */
  type: "resource_link"
  /** 资源的 URI 标识。 */
  uri: string
  /** 资源的可选显示名称。 */
  name?: string
  /** 资源的可选说明。 */
  description?: string
  /** 内容对应的 MIME 类型。 */
  mimeType?: string
}

/**
 * 统一 ToolResult。
 *
 * `error` 保存 Runtime 统一错误；`content` 保存经过 render 处理的模型可见内容，
 * 内部堆栈等 details 不默认暴露。普通工具失败只用 `status = "error"` 表示，
 * 不为同一次失败额外写 `app/error`。
 */
export type ToolResult =
  | {
      status: "success"
      content: ToolResultContent[]
    }
  | {
      status: "error"
      content: ToolResultContent[]
      error: AppError
    }

/**
 * AgentLoop 使用的统一工具调用边界。
 *
 * 工具业务失败、参数错误和取消必须返回错误状态的 `ToolResult`；只有执行入口本身无法完成
 * 调用边界时才允许抛出异常。具体实现由 `createExecuteToolCall` 创建。
 *
 * @param toolName 模型请求执行的工具名称。
 * @param toolArguments 模型提供、尚未由统一入口检查的参数。
 * @param context 当前 Turn、Step、Block、调用 ID 和取消信号。
 * @returns 已经过对应结果整理器转换的统一工具结果。
 * @throws 调用入口之外的不可恢复错误；普通工具失败不应抛出。
 */
export type ExecuteToolCall = (
  toolName: string,
  toolArguments: unknown,
  context: ToolCallContext,
) => Promise<ToolResult>
