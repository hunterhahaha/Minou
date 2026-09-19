/**
 * 统一错误结构（第 25 节，已定义）。
 *
 * 底层异常 / Provider Error / Tool Error → Error Normalizer → AppError，
 * 之后由 Session Event Log 的 `app/error`、SSE 错误消息与前端错误状态统一消费。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 25 节（工具错误与取消处理）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 1（AppError 类型）、阶段 2（Error Normalizer）
 */

/**
 * 统一错误结构中的错误来源。
 *
 * 来源用于区分 Runtime、模型、工具、MCP、存储和系统边界，供事件日志、SSE
 * 以及 UI 选择对应的错误处理路径。
 */
export type AppErrorSource = "runtime" | "model" | "tool" | "mcp" | "storage" | "system"

/**
 * Runtime / Event Log / SSE / UI 的统一错误结构（第 25 节，已定义）。
 *
 * 使用约定：
 *   - 模型请求的 Provider 原始报错在自动重试耗尽后包装为 `source = "model"`，
 *     并在 `details` 中保留可获得的状态码、Provider 错误码、requestId；
 *   - Tool / MCP 的内部执行异常同样先转为本结构，但不把内部细节原样塞给模型；
 *     `ToolResult.content` 由该工具的 render 生成模型可见内容。
 */
export interface AppError {
  /** 产生该错误的 Runtime 子系统边界。 */
  source: AppErrorSource
  /** 稳定的应用层错误码，供调用方进行机器判断。 */
  code: string
  /** 可直接展示或继续包装的错误说明。 */
  message: string
  /** 可选的结构化上下文；仅保存调用方允许向外传递的附加信息。 */
  details?: Record<string, unknown>
}
