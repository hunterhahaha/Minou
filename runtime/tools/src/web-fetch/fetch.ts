/** 网页抓取执行：共享取消与超时、流式限量读取和 HTML 转换。 */
import TurndownService from "turndown"
import type { AppError } from "../../../error/src/types.ts"
import type { WebFetchInput, WebFetchResult } from "./types.ts"

/** 网络请求与完整正文读取共用的超时，不开放为模型参数。 */
export const WEB_FETCH_TIMEOUT_MS = 30_000
/** 解压后正文的字节上限；等于上限允许，超过则丢弃全部正文。 */
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024

/**
 * 获取一次网页，完整读取后转换 HTML 或原样返回文本；不重试、不返回部分正文。
 * @param input 已由工具入口校验的 HTTP/HTTPS URL。
 * @param signal 当前工具调用的取消信号。
 * @returns 完整处理后的文本，或不包含原始响应及底层异常的统一错误。
 */
export async function executeWebFetch(input: WebFetchInput, signal: AbortSignal): Promise<WebFetchResult | AppError> {
  if (signal.aborted) return failure("CANCELLED", "网页抓取已取消。")
  const timeout = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
  const controller = new AbortController()
  const requestSignal = AbortSignal.any([signal, timeout, controller.signal])
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const chunks: Uint8Array[] = []
  let stage: "request" | "read" | "conversion" = "request"
  try {
    response = await fetch(input.url, { method: "GET", signal: requestSignal })
    requestSignal.throwIfAborted()
    if (!response.ok) return failure("WEB_FETCH_HTTP_ERROR", `网页返回 HTTP ${response.status}。`)

    /** 压缩响应的 Content-Length 不能代表解压后大小，仍以流式累计为准。 */
    const length = response.headers.get("content-length")
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase()
    if ((!encoding || encoding === "identity") && length && /^\d+$/.test(length) && Number(length) > WEB_FETCH_MAX_BYTES) {
      return failure("WEB_FETCH_TOO_LARGE", "网页正文超过 5 MiB，已丢弃全部内容。")
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    if (contentType && !["text/html", "application/xhtml+xml", "text/plain", "text/markdown"].includes(contentType)) {
      return failure("WEB_FETCH_UNSUPPORTED_CONTENT_TYPE", "网页响应不是支持的 HTML、纯文本或 Markdown。")
    }

    stage = "read"
    reader = response.body?.getReader()
    let size = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        requestSignal.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (size > WEB_FETCH_MAX_BYTES) return failure("WEB_FETCH_TOO_LARGE", "网页正文超过 5 MiB，已丢弃全部内容。")
        chunks.push(value)
      }
    }
    requestSignal.throwIfAborted()
    const text = Buffer.concat(chunks, size).toString("utf8")
    chunks.length = 0
    if (contentType === "text/plain" || contentType === "text/markdown") return { text }
    stage = "conversion"
    const converter = new TurndownService()
    converter.remove(["script", "style"])
    return { text: converter.turndown(text) }
  } catch {
    if (signal.aborted) return failure("CANCELLED", "网页抓取已取消。")
    if (timeout.aborted) return failure("WEB_FETCH_TIMEOUT", "网页抓取超时（30 秒）。")
    if (stage === "read") return failure("WEB_FETCH_READ_FAILED", "无法完整读取网页正文。")
    if (stage === "conversion") return failure("WEB_FETCH_CONVERSION_FAILED", "无法将网页 HTML 转换为 Markdown。")
    return failure("WEB_FETCH_REQUEST_FAILED", "网页请求执行失败，请检查 URL 或网络。")
  } finally {
    /** 先中止请求、丢弃缓冲，再释放读取锁；清理失败不覆盖已确定的业务结果。 */
    controller.abort()
    chunks.length = 0
    if (reader) {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    } else if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => undefined)
    }
  }
}

/**
 * 构造不暴露 URL、正文和底层异常的抓取错误。
 * @param code 稳定错误码。
 * @param message 模型与用户可读的失败说明。
 * @returns 统一工具错误。
 */
function failure(code: string, message: string): AppError { return { source: "tool", code, message } }
