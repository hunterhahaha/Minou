/** 网页抓取执行：共享取消与超时、流式限量读取和 HTML 转换。 */
import TurndownService from "turndown"
import { randomUUID } from "node:crypto"
import { lstat, open, unlink } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { AppError } from "../../../error/src/types.ts"
import type { WebFetchInput, WebFetchResult } from "./types.ts"

/** 网络请求与完整正文读取共用的超时，不开放为模型参数。 */
export const WEB_FETCH_TIMEOUT_MS = 30_000
/** 解压后正文的字节上限；等于上限允许，超过则丢弃全部正文。 */
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
/** 最终文本正文的 UTF-8 输出上限，截断提示另计。 */
export const WEB_FETCH_OUTPUT_LIMIT = 32 * 1024
/** 初始请求之后最多跟随的跳转次数。 */
export const WEB_FETCH_MAX_REDIRECTS = 5

/**
 * 最多跟随五次跳转抓取网页，转换后超限则保存全文并返回开头；网络失败不返回部分正文。
 * @param input 已由工具入口校验的 HTTP/HTTPS URL。
 * @param signal 当前工具调用的取消信号。
 * @param outputDirectory 宿主已创建的 tool_output 绝对目录，仅超限时需要。
 * @returns 完整小文本或带全文路径的截断结果；失败返回不包含正文和底层异常的统一错误。
 */
export async function executeWebFetch(input: WebFetchInput, signal: AbortSignal, outputDirectory?: string): Promise<WebFetchResult | AppError> {
  if (signal.aborted) return failure("CANCELLED", "网页抓取已取消。")
  const timeout = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
  const controller = new AbortController()
  const requestSignal = AbortSignal.any([signal, timeout, controller.signal])
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const chunks: Uint8Array[] = []
  let stage: "request" | "read" | "conversion" | "output" = "request"
  try {
    let url = input.url
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, { method: "GET", redirect: "manual", signal: requestSignal })
      requestSignal.throwIfAborted()
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get("location")
      if (location === null) break
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) return failure("WEB_FETCH_TOO_MANY_REDIRECTS", "网页重定向超过 5 次。")
      try {
        const target = new URL(location, url)
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error()
        url = target.href
      } catch { return failure("WEB_FETCH_INVALID_REDIRECT", "网页重定向地址不是有效的 HTTP/HTTPS URL。") }
      if (response.body) await response.body.cancel()
    }
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
    let text = Buffer.concat(chunks, size).toString("utf8")
    chunks.length = 0
    if (contentType !== "text/plain" && contentType !== "text/markdown") {
      stage = "conversion"
      const converter = new TurndownService()
      converter.remove(["script", "style"])
      text = converter.turndown(text)
    }
    stage = "output"
    return await prepareOutput(text, outputDirectory, signal)
  } catch {
    if (signal.aborted) return failure("CANCELLED", "网页抓取已取消。")
    if (stage === "output") return failure("WEB_FETCH_OUTPUT_WRITE_FAILED", "无法将完整网页内容保存到工具输出目录。")
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
 * 按 UTF-8 字节保留正文开头；超限时独占写入完整文本，成功后才交付路径。
 * @param text 转换后的完整正文。
 * @param directory 已存在的宿主输出目录；缺失、相对路径或非目录均不能保存。
 * @param signal 当前调用取消信号，取消时清理本次文件。
 * @returns 小结果原文，或不拆分 UTF-8 字符的前缀及完整文件元数据。
 * @throws Error 目录无效、写入失败或取消；调用方按工具错误转换。
 */
async function prepareOutput(text: string, directory: string | undefined, signal: AbortSignal): Promise<WebFetchResult> {
  signal.throwIfAborted()
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= WEB_FETCH_OUTPUT_LIMIT) return { text }
  if (!directory || !isAbsolute(directory) || !(await lstat(directory)).isDirectory()) throw new Error("工具输出目录不可用")
  const fullOutputPath = join(directory, `web_fetch_${randomUUID()}.md`)
  const file = await open(fullOutputPath, "wx", 0o600)
  try {
    await file.writeFile(bytes)
    await file.close()
    signal.throwIfAborted()
  } catch (error) {
    await file.close().catch(() => undefined)
    await unlink(fullOutputPath).catch(() => undefined)
    throw error
  }
  let end = WEB_FETCH_OUTPUT_LIMIT
  while ((bytes[end] & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true, totalBytes: bytes.length, fullOutputPath }
}

/**
 * 构造不暴露 URL、正文和底层异常的抓取错误。
 * @param code 稳定错误码。
 * @param message 模型与用户可读的失败说明。
 * @returns 统一工具错误。
 */
function failure(code: string, message: string): AppError { return { source: "tool", code, message } }
