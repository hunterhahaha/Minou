/**
 * Error Normalizer：底层异常 → 统一 `AppError`（第 25 节）。
 *
 * 职责链（第 25 节）：
 *   底层异常 / Provider Error / Tool Error → Error Normalizer → AppError → Session Event Log / SSE / UI
 *
 * 本文件只做归一化，不做重试；重试在 `runtime/network/`。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 25 节（工具错误与取消处理）、
 *          第 7 节（重试耗尽后的模型错误包装）、第 14 节（用户停止）
 */

import { isAbortError } from "./abort.ts"
import type { AppError, AppErrorSource } from "./types.ts"

/** 模型请求在重试耗尽后仍失败（第 25 节示例中的 `code`）。 */
export const MODEL_REQUEST_FAILED = "REQUEST_FAILED"

/** 请求被取消（第 14、25 节）。 */
export const CANCELLED = "CANCELLED"

/**
 * 从未知值中安全读取一个对象属性。
 *
 * 非对象值和 `null` 没有可读取的属性，统一返回 `undefined`。
 *
 * @param source 待检查的未知值。
 * @param key 要读取的属性名。
 * @returns 属性当前值；值不是对象或对象不含该属性时返回 `undefined`。
 */
function readProperty(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

/**
 * 读取并验证一个数值属性。
 *
 * @param source 待检查的未知值。
 * @param key 要读取的属性名。
 * @returns 属性为 `number` 时返回该值，否则返回 `undefined`。
 */
function readNumber(source: unknown, key: string): number | undefined {
  const value = readProperty(source, key)
  return typeof value === "number" ? value : undefined
}

/**
 * 读取并验证一个非空字符串属性。
 *
 * @param source 待检查的未知值。
 * @param key 要读取的属性名。
 * @returns 属性为非空字符串时返回该值，否则返回 `undefined`。
 */
function readString(source: unknown, key: string): string | undefined {
  const value = readProperty(source, key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * 从任意抛出物提取一条可读消息。
 *
 * 优先使用 `Error.message`，其次读取对象的非空 `message` 属性，最后将值转为字符串。
 *
 * @param error 待转换的未知抛出物。
 * @returns 用于填充 `AppError.message` 的可读文本。
 */
function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = readString(error, "message")
  if (message !== undefined) return message
  return String(error)
}

/**
 * 通用归一化：任意抛出物 → 指定 `source` 的 `AppError`。
 *
 * 这是 Error Normalizer 的最小形态，不尝试解读厂商字段；需要保留厂商信息时用
 * `normalizeModelError`。
 *
 * @param error 任意被抛出的值。
 * @param source 要写入统一错误的来源边界。
 * @param code 要写入统一错误的稳定错误码。
 * @returns 包含指定来源和错误码、并从抛出物提取说明的 `AppError`。
 */
export function normalizeError(error: unknown, source: AppErrorSource, code: string): AppError {
  return { source, code, message: readMessage(error) }
}

/**
 * 模型请求错误的归一化（第 25 节）。
 *
 * 识别到 Abort / 取消类错误 → `CANCELLED`；其余 → `REQUEST_FAILED`。
 * `isAbortError` 只依据错误形状判断，不能区分具体取消来源。
 * 尽力保留可获得的 Provider 状态码、错误码与 requestId（第 25 节要求），
 * 三者都取不到时 `details` 为 undefined，不写空对象。
 *
 * 字段来源按两个官方 SDK 与 undici 的实际形状做兼容读取，均为可选：
 *   - 状态码：`status`
 *   - requestId：`requestID`（两个 SDK 均用此名）｜`requestId`｜`request_id`
 *   - Provider 错误码：错误体 `error.code` ／ `error.type`，回退到顶层的 `code` ／ `type`
 *
 * @param error 模型请求阶段抛出的 Provider、SDK 或网络错误。
 * @returns `source` 为 `model` 的统一错误；取消错误使用 `CANCELLED`，其他错误使用
 * `REQUEST_FAILED`，并尽可能携带 Provider 元数据。
 */
export function normalizeModelError(error: unknown): AppError {
  if (isAbortError(error)) {
    return { source: "model", code: CANCELLED, message: readMessage(error) }
  }

  const details: Record<string, unknown> = {}

  const status = readNumber(error, "status")
  if (status !== undefined) details.status = status

  const requestId =
    readString(error, "requestID") ??
    readString(error, "requestId") ??
    readString(error, "request_id")
  if (requestId !== undefined) details.requestId = requestId

  // 错误体的形状因厂商而异：Anthropic 用 error.type，OpenAI 常用 error.code。
  const body = readProperty(error, "error")
  const providerCode =
    readString(body, "code") ??
    readString(body, "type") ??
    readString(error, "code") ??
    readString(error, "type")
  if (providerCode !== undefined) details.providerCode = providerCode

  return {
    source: "model",
    code: MODEL_REQUEST_FAILED,
    message: readMessage(error),
    details: Object.keys(details).length > 0 ? details : undefined,
  }
}
