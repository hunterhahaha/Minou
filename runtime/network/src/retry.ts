/**
 * 流式请求的错误分类、指数退避与自动重试。
 *
 * 默认最多尝试三次；仅在尚无有效输出且错误可重试时重新请求。
 * 有效输出之前的事件先缓冲，失败重试时丢弃；最终错误归一化由调用方负责。
 */

import { createAbortError, isAbortError } from "../../error/src/abort.ts"

/**
 * 默认最大尝试次数，包含首次请求；调用方可通过 maxAttempts 覆盖。
 */
export const RETRY_MAX_ATTEMPTS = 3

/** 退避基数。指数基数依次为 500ms、1000ms、2000ms，实际等待需再乘以抖动因子。 */
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

/**
 * 从非空对象读取属性，不捕获 getter 或 Proxy 抛出的异常。
 *
 * @param source 待读取的未知值；非对象值按属性缺失处理。
 * @param key 要读取的属性名。
 * @returns 属性当前值；源值不是非空对象或属性不存在时返回 `undefined`。
 * @throws Error 属性或 cause 访问失败时传播，调用方需自行处理。
 */
function readProperty(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

/**
 * 读取长度大于零的字符串属性，不裁剪空白。
 *
 * @param source 待读取的未知值。
 * @param key 要读取的属性名。
 * @returns 非空字符串属性值；属性不是非空字符串时返回 `undefined`。
 * @throws Error 属性或 cause 访问失败时传播，调用方需自行处理。
 */
function readString(source: unknown, key: string): string | undefined {
  const value = readProperty(source, key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * 判定一个错误是否属于网络层支持自动重试的错误形状。
 *
 * 取消类错误一律返回 false —— 即便它同时带着连接中断的错误码，
 * 也不能在请求已被终止后继续重试。
 *
 * @param error 待判断的未知错误值。
 * @returns 错误属于可重试情形且不是取消错误时返回 `true`，否则返回 `false`。
 * @throws Error 属性或 cause 访问失败时传播，调用方需自行处理。
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

/**
 * 沿错误及其 `cause` 链判断是否命中网络层可重试条件。
 *
 * @param error 当前待判断的未知错误值。
 * @param depth 当前已经追溯的 `cause` 深度，用于限制循环引用的影响范围。
 * @returns 错误自身或有限深度内的底层原因满足可重试条件时返回 `true`，否则返回 `false`。
 * @throws Error 属性或 cause 访问失败时传播，调用方需自行处理。
 */
function classifyRetryable(error: unknown, depth: number): boolean {
  /**
   * 非对象输入直接结束。缺了这一条会退化成无限递归：readProperty 对非对象返回
   * undefined，而 undefined 又不是可重试错误，于是再次进入本函数。
   */
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

  /**
   * Provider 可能把「临时不可用」放在错误体或顶层的 type 上。
   */
  const body = readProperty(error, "error")
  const providerType = readString(body, "type") ?? readString(error, "type")
  if (providerType !== undefined && RETRYABLE_PROVIDER_TYPES.has(providerType)) return true

  /**
   * 部分包装错误把底层原因放在 cause。
   */
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
 *
 * @param attemptIndex 从 0 开始的重试序号。
 * @param baseDelayMs 指数退避的初始毫秒数，默认使用 `RETRY_BASE_DELAY_MS`。
 * @param random 返回抖动因子的随机函数，默认使用 `Math.random`。
 * @returns 当前重试前应等待的、经过四舍五入的毫秒数。
 */
export function computeBackoffDelay(
  attemptIndex: number,
  baseDelayMs: number = RETRY_BASE_DELAY_MS,
  random: () => number = Math.random,
): number {
  const exponential = baseDelayMs * 2 ** attemptIndex
  return Math.round(exponential * (0.5 + random() * 0.5))
}

/**
 * 等待指定毫秒；期间收到取消则立即结束等待。
 *
 * @param ms 等待时长，单位为毫秒。
 * @param signal 当前请求的取消信号。
 * @returns 在计时器到期后完成的 Promise。
 * @throws 当 signal 已取消或在等待期间取消时，返回的 Promise 以取消错误拒绝。
 */
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

/**
 * `streamWithRetry` 的取消、输出判定、重试策略与观测配置。
 *
 * @typeParam T 流式模型事件的类型。
 */
export interface StreamRetryOptions<T> {
  /**
   * 判定一个事件是否构成「有效模型输出」。
   *
   * 该事件一旦出现，本次请求就不再允许重试：已产生有效输出后重试会造成重复输出。
   *
   * 默认值 `() => true` 是保守选择 —— 把任何事件都视为有效输出即等于「流一旦
   * 开始就不能重试」。各 Adapter 会传入更精确的判定（首个内容增量），
   * 因为只有 Adapter 才知道事件语义。
   *
   * @param event 待判断的流式模型事件。
   * @returns 该事件已经构成有效模型输出时返回 `true`。
   */
  isValidOutput?: (event: T) => boolean

  /** 当前请求的取消信号。 */
  signal: AbortSignal

  /** 最大尝试次数，默认 `RETRY_MAX_ATTEMPTS`。测试可调小。 */
  maxAttempts?: number

  /** 退避基数，默认 `RETRY_BASE_DELAY_MS`。测试可调小。 */
  baseDelayMs?: number

  /**
   * 每次决定重试时调用，用于观测与日志。
   *
   * @param info 本次重试的序号、等待时长和触发重试的原始错误。
   */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

/**
 * 带自动重试的流式请求。
 *
 * 重试时机：
 *   - 仅在**尚未产出有效输出**时，且错误属于可重试情形；
 *   - 已经产出有效输出后再出错，原样抛出，交给错误处理；
 *   - 识别到取消类错误，或调用方取消信号已触发时，不重试；
 *   - 重试次数耗尽后原样抛出最后一个错误，由调用方包装成 `AppError`。
 *
 * **重试对消费方透明**：首个有效输出之前的事件先缓冲、不向下游吐出。若该次尝试随后失败并
 * 触发重试，被丢弃的正是这些缓冲区事件 —— 消费方不会看到上一次尝试留下的痕迹。
 * 否则按「首个内容增量」的判定边界，一次失败的尝试会先漏出一个 `block_start`，
 * 重试后再漏一个，消费方（AgentLoop）就会为同一次请求写出两个 `assistant/block_start`。
 *
 * 缓冲区保存有效输出之前的全部事件；判定始终为 false 时会缓存整次尝试。
 * 正常结束后不额外检查取消信号，运行中的取消需要 attempt 自行响应。
 * maxAttempts 不做范围校验，小于等于零时不执行请求。
 *
 * @typeParam T 流式模型事件的类型。
 * @param attempt 创建一次模型流式请求的函数；收到重试信号时会用同一个取消信号重新调用。
 * @param options 当前请求的取消信号、输出判定、尝试次数、退避和观测回调。
 * @returns 按重试边界向下游产生的模型事件流。
 * @throws 已产生有效输出后的流错误、不可重试错误、取消错误或重试耗尽后的最后一个错误。
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
          /**
           * 首个有效输出：先补发缓冲的事件，再按顺序产出后续事件。
           */
          producedValidOutput = true
          for (const pending of buffered) yield pending
          buffered.length = 0
          yield event
        } else {
          buffered.push(event)
        }
      }

      /**
       * 正常结束：把缓冲中尚未构成「有效输出」的事件一并吐出，它们同样是本次请求的合法产出。
       */
      for (const pending of buffered) yield pending
      return
    } catch (error) {
      /**
       * 已产生有效输出 → 进入错误处理，不再重试。缓冲此时已空。
       */
      if (producedValidOutput) throw error
      /**
       * 取消类错误或已触发的调用方取消信号，不进入自动重试。
       */
      if (isAbortError(error) || signal.aborted) throw error
      /**
       * 不属于允许重试的情形。
       */
      if (!isRetryableError(error)) throw error
      /**
       * 已是最后一次尝试。
       */
      if (attemptIndex === maxAttempts - 1) throw error

      /**
       * 尚未产生有效输出 → 丢弃缓冲、重新请求，消费方看不到这次失败的痕迹。
       */
      const delayMs = computeBackoffDelay(attemptIndex, baseDelayMs)
      onRetry?.({ attempt: attemptIndex + 1, delayMs, error })
      await sleep(delayMs, signal)
    }
  }
}
