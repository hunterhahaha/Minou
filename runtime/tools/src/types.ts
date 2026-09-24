/**
 * 工具运行时的统一结果结构（第 16.2 节）。
 *
 * 每个工具的 render 把该工具的专属 Result 或 AppError 转成本文件的 `ToolResult`，
 * 统一 execute 返回它，AgentLoop 据此写 `tool/result` 事件、并把它转成回放用的 tool 消息。
 * 因此这里是「工具 → 上下文 / Event Log」这条数据流的契约。
 *
 * 本文件还定义 AgentLoop 与统一 ToolExecutor 共享的调用边界；注册表与具体执行编排分别位于
 * `tool-registry.ts`、`tool-executor.ts`。文件工具的专属结果结构位于 `file/types.ts`。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 16.2 节（统一 ToolResult 与内容块）、
 *          第 16.4 节（统一 execute 流程）、第 16.5 节（日志、上下文与 UI）
 * 实施阶段：TODOList 阶段 6.4 的 ToolResult + 第 16.4 节通用执行入口契约
 */

import type { AppError } from "../../error/src/types.ts"
import type { ApprovalDecision } from "../../session/src/events.ts"
import type { TurnFileChangeTracker } from "../../session/src/file-changes.ts"

/** 模型附在工具参数上的 Runtime 调用说明；它不属于工具的业务参数。 */
export interface ToolCallMeta {
  /** 供 UI 描述本次调用用途的可选文本。 */
  callDescription?: string
}

/**
 * AgentLoop 交给统一工具执行入口的调用身份。
 *
 * 这些字段由 Runtime 产生，不来自模型参数；Session 专属资源由调用方通过闭包提供。
 */
export interface ToolCallContext {
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
 * `validatedArguments` 保留完整业务参数和可选 `callDescription`，用于审批记录；
 * 工具业务函数自己的第一个参数不含 `callDescription`。
 */
export interface ToolExecutionContext<TArguments extends object = Record<string, unknown>>
  extends ToolCallContext {
  /** 完整的已检查参数，包含可选的 Runtime 调用说明。 */
  validatedArguments: TArguments & ToolCallMeta
}

/**
 * 工具结果的统一内容块（第 16.2 节）。
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

export interface ToolResultTextContent {
  type: "text"
  text: string
}

export interface ToolResultImageContent {
  type: "image"
  /** base64。 */
  data: string
  mimeType: string
}

export interface ToolResultAudioContent {
  type: "audio"
  /** base64。 */
  data: string
  mimeType: string
}

export interface ToolResultResourceContent {
  type: "resource"
  resource: {
    uri: string
    mimeType?: string
    /** 文本资源。 */
    text?: string
    /** base64 二进制资源。 */
    blob?: string
  }
}

export interface ToolResultResourceLinkContent {
  type: "resource_link"
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/**
 * 统一 ToolResult（第 16.2 节）。
 *
 * `error` 保存 Runtime 统一错误；`content` 保存经过 render 处理的模型可见内容，
 * 内部堆栈等 details 不默认暴露。普通工具失败只用 `status = "error"` 表示，
 * 不为同一次失败额外写 `app/error`（第 8.6 节）。
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
 * AgentLoop 使用的统一工具调用边界（第 16.4 节）。
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
