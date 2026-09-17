/**
 * 取消（Abort）错误的统一识别与构造。
 *
 * 单独成文件是因为有两个使用方：重试逻辑要据此排除取消类错误，
 * 错误归一化要据此产出 `CANCELLED`。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 7 节（网络层）、第 14 节（用户停止 Agent）、
 *          第 25 节（工具错误与取消处理）
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

function inspectAbort(error: unknown, depth: number): boolean {
  if (typeof error !== "object" || error === null) return false

  const name = readProperty(error, "name")
  if (name === "AbortError" || name === "APIUserAbortError") return true

  const code = readProperty(error, "code")
  if (code === "UND_ERR_ABORT" || code === "UND_ERR_ABORTED") return true

  // 部分实现把取消信息放在 cause 上。
  if (depth >= MAX_CAUSE_DEPTH) return false
  return inspectAbort(readProperty(error, "cause"), depth + 1)
}

/**
 * 构造一个标准形状的取消错误。
 *
 * 用于在重试退避等待期间收到取消、但又没有底层错误可复用的情形，
 * 使上层能得到与其他取消路径一致的 `name`。
 */
export function createAbortError(message = "请求已取消"): Error {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}
