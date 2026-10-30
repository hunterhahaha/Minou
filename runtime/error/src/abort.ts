/**
 * 按错误形状识别取消，并构造 name 为 AbortError 的错误。
 *
 * 取消识别供网络重试、模型错误转换和运行循环共同使用；
 * 检查当前对象及最多八层 cause，不区分取消的发起来源。
 */

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
 * 判定错误是否属于 Abort / 取消类错误。
 *
 * 需要覆盖三类来源：
 *   - Web 标准 `AbortController.abort()` → `DOMException` / `Error`，`name === "AbortError"`；
 *   - undici 抛出的取消 → `code` 为 `UND_ERR_ABORT`（AbortError）或 `UND_ERR_ABORTED`（RequestAbortedError）；
 *   - 官方 SDK 抛出的取消 → 类名 `APIUserAbortError`，`name` 同为 `"APIUserAbortError"`。
 *
 * 本函数只依据错误形状判断，无法区分用户主动取消、Runtime 关闭或其他内部取消来源。
 * 判定必须偏向「认定为取消」：把取消误判为可重试错误，可能在请求已被终止后继续发出请求。
 *
 * @param error 待识别的未知抛出物。
 * @returns 如果错误本身或其有限深度的 `cause` 链符合取消错误形状则返回 `true`，否则返回 `false`。
 * @throws Error 错误对象的属性访问器或 Proxy 抛出异常时传播，调用方需自行处理。
 */
export function isAbortError(error: unknown): boolean {
  return inspectAbort(error, 0)
}

/**
 * cause 链的最大追溯深度。
 *
 * 用于兜住 `a.cause = b; b.cause = a` 这类循环引用：取消判定必须总能返回，
 * 否则重试逻辑会在处理取消错误时卡死。
 */
const MAX_CAUSE_DEPTH = 8

/**
 * 在当前值及其有限深度的 `cause` 链中检查取消错误标记。
 *
 * @param error 当前待检查的值。
 * @param depth 当前已追溯的 `cause` 层数。
 * @returns 当前值或其有限深度的 `cause` 链是否符合取消错误形状。
 * @throws Error 错误对象的属性访问器或 Proxy 抛出异常时传播，调用方需自行处理。
 */
function inspectAbort(error: unknown, depth: number): boolean {
  if (typeof error !== "object" || error === null) return false

  const name = readProperty(error, "name")
  if (name === "AbortError" || name === "APIUserAbortError") return true

  const code = readProperty(error, "code")
  if (code === "UND_ERR_ABORT" || code === "UND_ERR_ABORTED") return true

  /**
   * 部分实现把取消信息放在 cause 上。
   */
  if (depth >= MAX_CAUSE_DEPTH) return false
  return inspectAbort(readProperty(error, "cause"), depth + 1)
}

/**
 * 构造一个标准形状的取消错误。
 *
 * 用于在重试退避等待期间收到取消、但又没有底层错误可复用的情形，
 * 使上层能得到与其他取消路径一致的 `name`。
 *
 * @param message 要放入错误对象的取消说明，省略时使用默认中文说明。
 * @returns `name` 为 `AbortError` 且消息为指定内容的标准 `Error` 实例。
 */
export function createAbortError(message = "请求已取消"): Error {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}
