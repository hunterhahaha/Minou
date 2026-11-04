/** 本地 HTTP 覆盖抓取转换、流式字节限制、超时、取消和统一工具结果。 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { gzipSync } from "node:zlib"
import TurndownService from "turndown"
import { executeWebFetch, WEB_FETCH_MAX_BYTES, WEB_FETCH_TIMEOUT_MS, registerWebFetchTool, ToolRegistry, RenderRegistry, createExecuteToolCall, toolScheduleGroup, planToolRounds } from "../src/index.ts"
import type { WebFetchResult } from "../src/web-fetch/types.ts"
import type { AppError } from "../../error/src/types.ts"

/**
 * 断言失败不返回任何已读取正文。
 * @param result 业务结果。
 * @param code 期望的错误码。
 * @throws AssertionError 错误码或丢弃行为不符。
 */
function assertError(result: WebFetchResult | AppError, code: string): void {
  assert.ok("code" in result)
  assert.equal(result.code, code)
  assert.equal("text" in result, false)
  assert.doesNotMatch(JSON.stringify(result), /private-body/)
}

/**
 * 通过本地服务及有限故障注入验证边界，不访问外网。
 * @returns 所有抓取断言完成。
 * @throws Error 服务、执行或断言失败。
 */
async function main(): Promise<void> {
  let respond = (_response: ServerResponse): void => {}
  let calls = 0
  let method: string | undefined
  const server = createServer((request, response) => { calls++; method = request.method; respond(response) })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}/page`
  const originalFetch = globalThis.fetch
  const originalTimeout = AbortSignal.timeout
  const originalTurndown = TurndownService.prototype.turndown
  const controller = new AbortController()
  /** @returns 使用生产入口抓取当前本地响应。 */
  const fetchPage = () => executeWebFetch({ url }, controller.signal)
  try {
    respond = (response) => {
      response.setHeader("Content-Type", "Text/HTML; charset=UTF-8")
      response.end('<h1>Title</h1><p>中文 <a href="https://example.com">link</a></p><ul><li>One</li></ul><pre><code>const a = 1</code></pre><script>private-body</script><style>private-body</style>')
    }
    const html = await fetchPage()
    assert.ok("text" in html)
    assert.match(html.text, /Title\n=+/)
    assert.match(html.text, /中文 \[link\]\(https:\/\/example.com\)/)
    assert.match(html.text, /\*\s+One/)
    assert.match(html.text, / {4}const a = 1/)
    assert.doesNotMatch(html.text, /private-body/)
    assert.equal(method, "GET")
    for (const type of ["text/plain", "text/markdown"]) {
      respond = (response) => { response.setHeader("Content-Type", `${type}; charset=UTF-8`); response.end("# 原文\n\n<a>literal</a>\n") }
      assert.deepEqual(await fetchPage(), { text: "# 原文\n\n<a>literal</a>\n" })
    }
    for (const type of [undefined, "application/xhtml+xml"]) {
      respond = (response) => { if (type) response.setHeader("Content-Type", type); response.end("<p>fallback</p>") }
      assert.deepEqual(await fetchPage(), { text: "fallback" })
    }
    respond = (response) => { response.setHeader("Content-Type", "image/png"); response.end("private-body") }
    assertError(await fetchPage(), "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE")
    respond = (response) => { response.writeHead(404); response.end("private-body") }
    assertError(await fetchPage(), "WEB_FETCH_HTTP_ERROR")

    for (const size of [WEB_FETCH_MAX_BYTES - 1, WEB_FETCH_MAX_BYTES, WEB_FETCH_MAX_BYTES + 1]) {
      respond = (response) => { response.setHeader("Content-Type", "text/plain"); response.end(Buffer.alloc(size, "x")) }
      const result = await fetchPage()
      if (size > WEB_FETCH_MAX_BYTES) assertError(result, "WEB_FETCH_TOO_LARGE")
      else { assert.ok("text" in result); assert.equal(result.text.length, size) }
    }
    /** 声明过大的长度时不发送正文，验证不会等待服务器传完。 */
    respond = (response) => { response.writeHead(200, { "Content-Length": WEB_FETCH_MAX_BYTES + 1 }); response.flushHeaders() }
    assertError(await fetchPage(), "WEB_FETCH_TOO_LARGE")
    /** 分块流永不主动结束，验证超限后确实关闭连接并停止继续获取。 */
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
    respond = (response) => {
      response.setHeader("Content-Type", "text/plain")
      response.write("private-body")
      const timer = setInterval(() => response.write(Buffer.alloc(64 * 1024)), 1)
      response.on("close", () => { clearInterval(timer); resolveClosed() })
    }
    assertError(await fetchPage(), "WEB_FETCH_TOO_LARGE")
    await Promise.race([closed, new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("超限后连接未关闭")), 2000)
      timer.unref()
    })])
    respond = (response) => {
      response.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" })
      response.end(gzipSync(Buffer.alloc(WEB_FETCH_MAX_BYTES + 1, "x")))
    }
    assertError(await fetchPage(), "WEB_FETCH_TOO_LARGE")
    /** 中文正文以字节计数，而不是字符串长度。 */
    respond = (response) => { response.setHeader("Content-Type", "text/plain"); response.write("中".repeat(Math.floor(WEB_FETCH_MAX_BYTES / 3))); response.end("中文") }
    assertError(await fetchPage(), "WEB_FETCH_TOO_LARGE")

    assert.equal(WEB_FETCH_TIMEOUT_MS, 30_000)
    AbortSignal.timeout = (milliseconds) => { assert.equal(milliseconds, 30_000); return originalTimeout(40) }
    respond = () => {}
    assertError(await fetchPage(), "WEB_FETCH_TIMEOUT")
    respond = (response) => { response.writeHead(200); response.write("private-body") }
    assertError(await fetchPage(), "WEB_FETCH_TIMEOUT")
    AbortSignal.timeout = originalTimeout
    const cancelled = new AbortController()
    cancelled.abort()
    const before = calls
    assertError(await executeWebFetch({ url }, cancelled.signal), "CANCELLED")
    assert.equal(calls, before)
    const during = new AbortController()
    respond = (response) => { response.writeHead(200); response.write("private-body"); setTimeout(() => during.abort(), 10) }
    assertError(await executeWebFetch({ url }, during.signal), "CANCELLED")
    respond = (response) => { response.write("private-body"); setImmediate(() => response.destroy()) }
    assertError(await fetchPage(), "WEB_FETCH_READ_FAILED")
    globalThis.fetch = async () => { throw new Error("private-body") }
    assertError(await fetchPage(), "WEB_FETCH_REQUEST_FAILED")
    globalThis.fetch = originalFetch
    respond = (response) => response.end("<p>ok</p>")
    TurndownService.prototype.turndown = () => { throw new Error("private-body") }
    assertError(await fetchPage(), "WEB_FETCH_CONVERSION_FAILED")
    TurndownService.prototype.turndown = originalTurndown

    const tools = new ToolRegistry(), renders = new RenderRegistry()
    registerWebFetchTool(tools, renders)
    const execute = createExecuteToolCall(tools, renders)
    const context = { turn: 1, step: 1, blockId: "b", toolCallId: "f", signal: controller.signal }
    for (const input of [{}, { url: " " }, { url: "/relative" }, { url: "file:///private" }, { url: "ftp://example.com" }, { url: "https://" }, { url, timeout: 1 }, { url: 1 }]) {
      const result = await execute("web_fetch", input, context)
      assert.equal(result.status, "error")
      if (result.status === "error") assert.equal(result.error.code, "INVALID_TOOL_ARGUMENTS")
    }
    assert.deepEqual(await execute("web_fetch", { url }, context), { status: "success", content: [{ type: "text", text: "ok" }] })
    respond = (response) => { response.writeHead(500); response.end("private-body") }
    const failure = await execute("web_fetch", { url }, context)
    assert.equal(failure.status, "error")
    assert.doesNotMatch(JSON.stringify(failure), /private-body/)
    assert.equal(toolScheduleGroup("web_fetch"), "shared")
    assert.equal(planToolRounds([{ toolName: "web_fetch" }, { toolName: "read" }, { toolName: "web_fetch" }]).length, 1)
    console.log("web-fetch.test.ts: 转换、大小、压缩、超时、取消、错误和统一入口通过")
  } finally {
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalTimeout
    TurndownService.prototype.turndown = originalTurndown
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
