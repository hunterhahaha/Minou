/**
 * 定义各 Runtime 子系统共用的错误来源和结构化错误数据。
 *
 * 类型描述来源、稳定错误码、说明及可选上下文，不执行校验、重试、持久化或展示。
 */

/**
 * 错误所属的 Runtime 子系统边界，供调用方分类处理与记录。
 */
export type AppErrorSource = "runtime" | "model" | "tool" | "mcp" | "storage" | "system"

/**
 * 统一错误数据，供 Runtime、事件记录与界面传递错误信息。
 *
 * 模型归一化函数可在 details 中携带状态码、Provider 错误码与请求 ID。
 * 工具的模型可见结果由工具结果整理流程另行生成；此结构本身不执行脱敏或字段过滤。
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
