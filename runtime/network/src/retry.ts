/**
 * 模型请求的自动重试与流式重试边界（第 7 节）。
 *
 * 允许自动重试的情形（第 7 节）：
 *   连接失败、连接超时、429、临时 5xx、Provider 临时不可用
 *
 * 流式请求的重试边界（第 7 节）：
 *   尚未产生有效模型输出 → 可以重新请求
 *   已经产生有效事件     → 当前请求状态进入错误处理
 *
 * 识别到 Abort / 取消类错误，或调用方的取消信号已触发时，不进入自动重试（第 7、14 节）。
 *
 * 本文件只负责「重试与否」；重试耗尽后的错误包装由调用方用
 * `runtime/error/` 的 `normalizeModelError` 完成（第 25 节）。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 7 节
 */

import { createAbortError, isAbortError } from "../../error/src/abort.ts"

/**
 * 最大尝试次数（含首次请求）。
 *
 * 备忘录与《NiCode_Usage统一设计.md》都未规定重试次数与退避策略。
 * 这里取「总 3 次（首次 + 2 次重试）」，实现为常量而非配置项：config.json 的
 * Provider / Protocol 配置结构本身尚未定义（TODOList 缺口 3），现在做成可配置
 * 等于先定义那套结构。等配置结构确定后再改为可配置。
 */
export const RETRY_MAX_ATTEMPTS = 3

/** 退避基数。实际等待为 500ms、1000ms、2000ms…（叠加抖动后）。 */
export const RETRY_BASE_DELAY_MS = 500

/**
 * 可重试的 HTTP 状态码。
 *
 *   408 请求超时（连接超时族）
 *   429 限流
 *   500-599 临时 5xx；Anthropic 的 overloaded_error（529）也落在本区间
 */
const RETRYABLE_STATUS_CODES = new Set([408, 429])

/**
 * 可重试的错误码（Node 系统调用错误 + undici 错误码）。
 *
 * 连接失败：ECONNREFUSED / ECONNRESET / ENOTFOUND / EPIPE / ETIMEDOUT / EAI_AGAIN
 * 连接超时：UND_ERR_CONNECT_TIMEOUT / UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT
 * 连接中断：UND_ERR_SOCKET
 *
 * 错误码取自 undici 8.x 的 `undici.errors` 实际取值。
 */
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
])

/** 可重试的错误类名：两个官方 SDK 的连接错误与超时错误。 */
const RETRYABLE_ERROR_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"])

/** Provider 明确报告「临时不可用」时的错误类型标记。 */
const RETRYABLE_PROVIDER_TYPES = new Set(["overloaded_error", "server_error", "unavailable"])

function readProperty(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

function readString(source: unknown, key: string): string | undefined {
  const value = readProperty(source, key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * 判定一个错误是否属于第 7 节允许自动重试的情形。
 *
 * 取消类错误一律返回 false —— 即便它同时带着连接中断的错误码，
 * 也不能在请求已被终止后继续重试（第 7、14 节）。
 */
export function isRetryableError(error: unknown): boolean {
  return classifyRetryable(error, 0)
}

/**
 * cause 链的最大追溯深度。
 *
 * 用于兜住 `a.cause = b; b.cause = a` 这类循环引用，避免递归不终止。
 */
const MAX_CAUSE_DEPTH = 8

function classifyRetryable(error: unknown, depth: number): boolean {
  // 非对象输入直接结束。缺了这一条会退化成无限递归：readProperty 对非对象返回
  // undefined，而 undefined 又不是可重试错误，于是再次进入本函数。
  if (typeof error !== "object" || error === null) return false

  if (isAbortError(error)) return false

  const status = readProperty(error, "status")
  if (typeof status === "number") {
    if (RETRYABLE_STATUS_CODES.has(status)) return true
    if (status >= 500 && status <= 599) return true
  }

  const name = readString(error, "name")
  if (name !== undefined && RETRYABLE_ERROR_NAMES.has(name)) return true

  const code = readString(error, "code")
  if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) return true

  // Provider 可能把「临时不可用」放在错误体或顶层的 type 上。
  const body = readProperty(error, "error")
  const providerType = readString(body, "type") ?? readString(error, "type")
  if (providerType !== undefined && RETRYABLE_PROVIDER_TYPES.has(providerType)) return true

  // 部分包装错误把底层原因放在 cause。
  if (depth >= MAX_CAUSE_DEPTH) return false
  return classifyRetryable(readProperty(error, "cause"), depth + 1)
}

/**
 * 计算第 `attemptIndex` 次重试前的等待时间（attemptIndex 从 0 起）。
 *
 * 指数增长 `base * 2^attemptIndex`，再叠加抖动：乘以 `0.5 + random() * 0.5`，
 * 即落在原值的 50%–100% 之间。抖动用于避免多个请求同时重试。
 *
 * `random` 可注入，便于测试给出确定值。
 */
export function computeBackoffDelay(
  attemptIndex: number,
  baseDelayMs: number = RETRY_BASE_DELAY_MS,
  random: () => number = Math.random,
): number {
  const exponential = baseDelayMs * 2 ** attemptIndex
  return Math.round(exponential * (0.5 + random() * 0.5))
}

/** 等待指定毫秒；期间收到取消则立即以取消错误结束。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError())
      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(createAbortError())
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** `streamWithRetry` 的可选项。 */
export interface StreamRetryOptions<T> {
  /**
   * 判定一个事件是否构成「有效模型输出」（第 7 节的重试边界）。
   *
   * 该事件一旦出现，本次请求就不再允许重试：已产生有效输出后重试会造成重复输出。
   *
   * 默认值 `() => true` 是保守选择 —— 把任何事件都视为有效输出即等于「流一旦
   * 开始就不能重试」。各 Adapter 会传入更精确的判定（首个内容增量），
   * 因为只有 Adapter 才知道事件语义。
   */
  isValidOutput?: (event: T) => boolean

  /** 当前请求的取消信号（第 6 节由 AgentLoop 持有）。 */
  signal: AbortSignal

  /** 最大尝试次数，默认 `RETRY_MAX_ATTEMPTS`。测试可调小。 */
  maxAttempts?: number

  /** 退避基数，默认 `RETRY_BASE_DELAY_MS`。测试可调小。 */
  baseDelayMs?: number

  /** 每次决定重试时回调，用于观测与日志。 */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

/**
 * 带自动重试的流式请求。
 *
 * 重试时机：
 *   - 仅在**尚未产出有效输出**时，且错误属于第 7 节列出的可重试情形；
 *   - 已经产出有效输出后再出错，原样抛出，交给错误处理（第 7 节）；
 *   - 识别到取消类错误，或调用方取消信号已触发时，不重试（第 7、14 节）；
 *   - 重试次数耗尽后原样抛出最后一个错误，由调用方包装成 `AppError`（第 25 节）。
 *
 * **重试对消费方透明**：首个有效输出之前的事件先缓冲、不向下游吐出。若该次尝试随后失败并
 * 触发重试，被丢弃的正是这些缓冲区事件 —— 消费方不会看到上一次尝试留下的痕迹。
 * 否则按「首个内容增量」的判定边界，一次失败的尝试会先漏出一个 `block_start`，
 * 重试后再漏一个，消费方（AgentLoop）就会为同一次请求写出两个 `assistant/block_start`。
 *
 * 缓冲区只保存「有效输出之前」的事件，通常就是个别的 `block_start`，不会随响应长度增长。
 */
export async function* streamWithRetry<T>(
  attempt: (signal: AbortSignal) => AsyncIterable<T>,
  options: StreamRetryOptions<T>,
): AsyncGenerator<T, void, undefined> {
  const { signal, isValidOutput = () => true, onRetry } = options
  const maxAttempts = options.maxAttempts ?? RETRY_MAX_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    if (signal.aborted) throw createAbortError()

    let producedValidOutput = false
    const buffered: T[] = []

    try {
      for await (const event of attempt(signal)) {
        if (producedValidOutput) {
          yield event
        } else if (isValidOutput(event)) {
          // 首个有效输出：先补发缓冲的事件，再按顺序产出后续事件。
          producedValidOutput = true
          for (const pending of buffered) yield pending
          buffered.length = 0
          yield event
        } else {
          buffered.push(event)
        }
      }

      // 正常结束：把缓冲中尚未构成「有效输出」的事件一并吐出，它们同样是本次请求的合法产出。
      for (const pending of buffered) yield pending
      return
    } catch (error) {
      // 已产生有效输出 → 进入错误处理，不再重试（第 7 节）。缓冲此时已空。
      if (producedValidOutput) throw error
      // 取消类错误或已触发的调用方取消信号，不进入自动重试（第 7、14 节）。
      if (isAbortError(error) || signal.aborted) throw error
      // 不属于允许重试的情形。
      if (!isRetryableError(error)) throw error
      // 已是最后一次尝试。
      if (attemptIndex === maxAttempts - 1) throw error

      // 尚未产生有效输出 → 丢弃缓冲、重新请求，消费方看不到这次失败的痕迹。
      const delayMs = computeBackoffDelay(attemptIndex, baseDelayMs)
      onRetry?.({ attempt: attemptIndex + 1, delayMs, error })
      await sleep(delayMs, signal)
    }
  }
}
