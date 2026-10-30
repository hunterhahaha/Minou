/**
 * 将未知异常转换为 AppError，供调用方记录或展示。
 *
 * 通用转换保留指定来源和错误码；模型转换区分取消与请求失败，
 * 并按固定字段优先级提取状态码、请求 ID 和 Provider 错误码。本文件不执行重试。
 */

import { isAbortError } from "./abort.ts"
import type { AppError, AppErrorSource } from "./types.ts"

/** 模型请求在重试耗尽后仍失败。 */
export const MODEL_REQUEST_FAILED = "REQUEST_FAILED"

/** 请求被取消。 */
export const CANCELLED = "CANCELLED"

/**
 * 从非空对象读取指定属性；不捕获 getter 或 Proxy 访问异常。
 *
 * 非对象值和 `null` 没有可读取的属性，统一返回 `undefined`。
 *
 * @param source 待检查的未知值。
 * @param key 要读取的属性名。
 * @returns 属性当前值；非对象、null 或缺失属性返回 undefined。
 * @throws Error 属性访问器或 Proxy 抛出的异常原样传播，调用方需自行处理。
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
 * @returns 属性为 number 时返回该值，不检查有限性或范围；其他类型返回 undefined。
 * @throws Error 对象属性访问失败时传播，调用方需自行处理。
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
 * @returns 属性为长度大于零的字符串时返回原值，不裁剪空白；否则返回 undefined。
 * @throws Error 对象属性访问失败时传播，调用方需自行处理。
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
 * @throws Error 属性读取或字符串转换失败时传播，调用方需自行处理。
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
 * 不解读 Provider 元数据或自动识别取消；需要模型分类和附加字段时用
 * `normalizeModelError`。
 *
 * @param error 任意被抛出的值。
 * @param source 要写入统一错误的来源边界。
 * @param code 要写入统一错误的稳定错误码。
 * @returns 包含指定来源和错误码、并从抛出物提取说明的 `AppError`。
 * @throws Error 属性读取或字符串转换失败时传播，调用方需自行处理。
 */
export function normalizeError(error: unknown, source: AppErrorSource, code: string): AppError {
  return { source, code, message: readMessage(error) }
}

/**
 * 模型请求错误的归一化。
 *
 * 识别到 Abort / 取消类错误 → `CANCELLED`；其余 → `REQUEST_FAILED`。
 * `isAbortError` 只依据错误形状判断，不能区分具体取消来源。
 * 尽力保留可获得的 Provider 状态码、错误码与 requestId，
 * 三者都取不到时 details 字段的值为 undefined；取消分支直接返回，不提取 details。
 *
 * 字段来源按两个官方 SDK 与 undici 的实际形状做兼容读取，均为可选：
 *   - 状态码：`status`
 *   - requestId：`requestID`（两个 SDK 均用此名）｜`requestId`｜`request_id`
 *   - Provider 错误码：错误体 `error.code` ／ `error.type`，回退到顶层的 `code` ／ `type`
 *
 * @param error 模型请求阶段抛出的 Provider、SDK 或网络错误。
 * @returns `source` 为 `model` 的统一错误；取消错误使用 `CANCELLED`，其他错误使用
 * `REQUEST_FAILED`，并尽可能携带 Provider 元数据。
 * @throws Error 错误属性、cause 或消息转换访问失败时传播，调用方需自行处理。
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

  /**
   * 错误体的形状因厂商而异：Anthropic 用 error.type，OpenAI 常用 error.code。
   */
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
