/**
 * 工具查表、参数校验、调用说明分离、取消检查、业务执行与结果整理的统一入口。
 *
 * 普通业务失败转换为错误 ToolResult；专属整理器失败时使用公共错误结果。
 * 调度由 ToolScheduler 处理，事件关联由运行层处理，具体权限与审批由各工具实现和注入资源完成。
 */

import { isAbortError } from "../../error/src/abort.ts"
import { CANCELLED, normalizeError } from "../../error/src/normalizer.ts"
import type { AppError } from "../../error/src/types.ts"
import {
  isPlainRecord,
  type RenderRegistry,
  type ToolRegistry,
  type ToolRender,
} from "./tool-registry.ts"
import type {
  ExecuteToolCall,
  ToolCallContext,
  ToolCallMeta,
  ToolResult,
} from "./types.ts"

/** 模型请求了当前注册表中不存在的工具。 */
export const TOOL_NOT_FOUND = "TOOL_NOT_FOUND"
/** 工具存在，但没有同名结果整理器。 */
export const TOOL_RENDER_NOT_FOUND = "TOOL_RENDER_NOT_FOUND"
/** 统一入口收到的参数外壳或 callDescription 不合法。 */
export const INVALID_TOOL_ARGUMENTS = "INVALID_TOOL_ARGUMENTS"
/** 已登记的参数检查器意外抛出或返回了非法成功值。 */
export const TOOL_VALIDATION_FAILED = "TOOL_VALIDATION_FAILED"
/** 工具业务函数抛出了非取消异常。 */
export const TOOL_EXECUTION_FAILED = "TOOL_EXECUTION_FAILED"
/** 工具专属结果整理器抛出了异常。 */
export const TOOL_RENDER_FAILED = "TOOL_RENDER_FAILED"

/**
 * 分离后的业务参数与 Runtime 调用说明，避免调用说明进入业务参数校验。
 */
interface SeparatedArguments {
  /** 去除 Runtime 调用说明后的业务参数。 */
  businessArguments: Record<string, unknown>
  /** 从模型参数中分离的 Runtime 调用元数据。 */
  meta: ToolCallMeta
}

/**
 * 使用指定注册表创建可直接注入 AgentLoop 的统一工具执行函数。
 * @param toolRegistry 保存工具定义、参数检查器和业务函数的注册表。
 * @param renderRegistry 保存同名结果整理器的注册表。
 * @returns 与 AgentLoop `ExecuteToolCall` 契约一致的异步函数。
 */
export function createExecuteToolCall(
  toolRegistry: ToolRegistry,
  renderRegistry: RenderRegistry,
): ExecuteToolCall {
  return async (toolName, toolArguments, context) => {
    const tool = toolRegistry.get(toolName)
    if (tool === undefined) {
      return renderCommonError({
        source: "tool",
        code: TOOL_NOT_FOUND,
        message: `未找到可用工具：${toolName}`,
      })
    }

    const render = renderRegistry.get(toolName)
    if (render === undefined) {
      return renderCommonError({
        source: "runtime",
        code: TOOL_RENDER_NOT_FOUND,
        message: `工具缺少结果整理器：${toolName}`,
      })
    }

    const separated = separateArguments(toolArguments)
    if ("error" in separated) return renderWithFallback(toolName, render, separated.error)

    let validation: ReturnType<typeof tool.validateArguments>
    try {
      validation = tool.validateArguments(separated.businessArguments)
    } catch (error) {
      return renderWithFallback(
        toolName,
        render,
        normalizeError(error, "runtime", TOOL_VALIDATION_FAILED),
      )
    }

    if (!validation.success) return renderWithFallback(toolName, render, validation.error)
    if (!isPlainRecord(validation.data)) {
      return renderWithFallback(toolName, render, {
        source: "runtime",
        code: TOOL_VALIDATION_FAILED,
        message: `工具参数检查器返回了非对象结果：${toolName}`,
      })
    }

    /** callDescription 是 Runtime 元数据，即使某个检查器错误地补回同名字段，也不能传给业务函数。 */
    const businessArguments = { ...validation.data }
    delete businessArguments.callDescription
    const validatedArguments = {
      ...businessArguments,
      ...separated.meta,
    }

    /** 参数错误比取消更早进入对应 render；但取消后绝不调用业务函数。 */
    if (context.signal.aborted) {
      return renderWithFallback(toolName, render, cancellationError())
    }

    let result: unknown
    try {
      result = await tool.execute(businessArguments, {
        ...context,
        validatedArguments,
      })
    } catch (error) {
      result = normalizeToolExecutionError(error, context)
    }

    return renderWithFallback(toolName, render, result)
  }
}

/**
 * 将公共注册表或结果整理失败转换为统一错误结果。
 *
 * 该函数只输出稳定错误码与说明，不读取未知异常的堆栈或附加字段。
 * @param error 要保留在 ToolResult 中的统一错误。
 * @returns 模型可见文本为 `错误码: 错误说明` 的错误 ToolResult。
 */
export function renderCommonError(error: AppError): ToolResult {
  return {
    status: "error",
    content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    error,
  }
}

/**
 * 分离 Runtime 调用说明与工具业务参数。
 * @param input 模型提供的原始工具参数。
 * @returns 分离后的普通业务参数和调用元数据，或统一参数错误。
 */
function separateArguments(
  input: unknown,
): SeparatedArguments | { error: AppError } {
  if (!isPlainRecord(input)) {
    return {
      error: {
        source: "tool",
        code: INVALID_TOOL_ARGUMENTS,
        message: "工具参数必须是普通对象",
      },
    }
  }

  const businessArguments = { ...input }
  const hasCallDescription = Object.prototype.hasOwnProperty.call(
    businessArguments,
    "callDescription",
  )
  const callDescription = businessArguments.callDescription
  delete businessArguments.callDescription

  if (hasCallDescription && typeof callDescription !== "string") {
    return {
      error: {
        source: "tool",
        code: INVALID_TOOL_ARGUMENTS,
        message: "callDescription 必须是字符串",
      },
    }
  }

  return {
    businessArguments,
    meta: typeof callDescription === "string" ? { callDescription } : {},
  }
}

/**
 * 调用工具专属结果整理器；整理器自身失败时改用公共错误结果，且不重复调用失败整理器。
 * @param toolName 当前工具名称，用于稳定错误说明。
 * @param render 当前工具的结果整理器。
 * @param result 工具专属结果或 AppError。
 * @returns 专属结果整理器的 ToolResult，或公共 `TOOL_RENDER_FAILED` 结果。
 */
function renderWithFallback(
  toolName: string,
  render: ToolRender<unknown>,
  result: unknown,
): ToolResult {
  try {
    return render(result)
  } catch {
    return renderCommonError({
      source: "runtime",
      code: TOOL_RENDER_FAILED,
      message: `工具结果整理失败：${toolName}`,
    })
  }
}

/**
 * 将工具业务函数抛出的异常归一为工具错误。
 * @param error 工具业务函数抛出的未知值。
 * @param context 当前调用上下文；其信号可能在业务函数运行期间变为已取消。
 * @returns 取消错误或普通工具执行错误。
 */
function normalizeToolExecutionError(
  error: unknown,
  context: ToolCallContext,
): AppError {
  if (context.signal.aborted || isAbortError(error)) return cancellationError()
  return normalizeError(error, "tool", TOOL_EXECUTION_FAILED)
}

/**
 * 构造标准工具取消错误，不携带底层异常细节。
 * @returns 不包含底层异常细节的标准工具取消错误。
 */
function cancellationError(): AppError {
  return { source: "tool", code: CANCELLED, message: "工具调用已取消" }
}
