/** 本地 HTTP 覆盖抓取转换、流式字节限制、超时、取消和统一工具结果。 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, readFile, readdir, rm, writeFile, open } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname, basename } from "node:path"
import { renderWebFetch } from "../src/render/web-fetch.ts"
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
  const directory = await mkdtemp(join(tmpdir(), "minou-fetch-output-"))
  let requestPath = ""
  let method: string | undefined
  const server = createServer((request, response) => { calls++; requestPath = request.url ?? ""; method = request.method; respond(response) })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}/page`
  const originalFetch = globalThis.fetch
  const originalTimeout = AbortSignal.timeout
  const originalTurndown = TurndownService.prototype.turndown
  const controller = new AbortController()
  /** @returns 使用生产入口抓取当前本地响应。 */
  const fetchPage = () => executeWebFetch({ url }, controller.signal, directory)
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
      else { assert.ok("text" in result && result.truncated); assert.equal(result.totalBytes, size); assert.equal(result.text.length, 32768); assert.equal((await readFile(result.fullOutputPath)).length, size) }
    }
    for (const size of [32767, 32768, 32769]) {
      const text = "x".repeat(size)
      respond = (response) => { response.setHeader("Content-Type", "text/plain"); response.end(text) }
      const beforeFiles = await readdir(directory)
      const result = await fetchPage()
      assert.ok("text" in result)
      if (size <= 32768) {
        assert.deepEqual(result, { text })
        assert.deepEqual(await readdir(directory), beforeFiles)
        assert.deepEqual(renderWebFetch(result), { status: "success", content: [{ type: "text", text }] })
      } else {
        assert.ok(result.truncated)
        assert.equal(result.text, text.slice(0, 32768))
        assert.equal(result.totalBytes, size)
        assert.equal(dirname(result.fullOutputPath), directory)
        assert.match(basename(result.fullOutputPath), /^web_fetch_[0-9a-f-]{36}\.md$/)
        assert.equal(await readFile(result.fullOutputPath, "utf8"), text)
        const rendered = renderWebFetch(result)
        assert.equal(rendered.content[0].type, "text")
        if (rendered.content[0].type === "text") assert.equal(rendered.content[0].text, result.text + `\n…\n\n[Output truncated: 32769 bytes total, showing the first 32 KiB or less.]\nFull output saved to:\n${result.fullOutputPath}\nUse read with this path to inspect the saved content.`)
      }
    }
    for (const text of ["中".repeat(12000), "x".repeat(32767) + "😀tail"]) {
      respond = (response) => { response.setHeader("Content-Type", "text/markdown"); response.end(text) }
      const results = await Promise.all([fetchPage(), fetchPage()])
      const paths = new Set<string>()
      for (const result of results) {
        assert.ok("text" in result && result.truncated)
        assert.ok(Buffer.byteLength(result.text) <= 32768)
        assert.equal(Buffer.from(result.text, "utf8").toString("utf8") === result.text, true)
        assert.ok(text.startsWith(result.text))
        assert.equal(result.totalBytes, Buffer.byteLength(text))
        assert.equal(await readFile(result.fullOutputPath, "utf8"), text)
        paths.add(result.fullOutputPath)
      }
      assert.equal(paths.size, 2)
    }
    respond = (response) => response.end("<script>" + "x".repeat(40000) + "</script><p>small</p>")
    const beforeConversion = await readdir(directory)
    assert.deepEqual(await fetchPage(), { text: "small" })
    assert.deepEqual(await readdir(directory), beforeConversion)
    const markdown = "converted ".repeat(4000)
    respond = (response) => response.end(`<p>${markdown}</p>`)
    const converted = await fetchPage()
    assert.ok("text" in converted && converted.truncated)
    assert.equal(await readFile(converted.fullOutputPath, "utf8"), markdown.trim())
    assert.equal(converted.totalBytes, Buffer.byteLength(markdown.trim()))
    const occupied = join(directory, "occupied")
    await writeFile(occupied, "keep")
    const beforeFailure = await readdir(directory)
    for (const output of [undefined, "relative", join(directory, "missing"), occupied]) {
      assertError(await executeWebFetch({ url }, controller.signal, output), "WEB_FETCH_OUTPUT_WRITE_FAILED")
    }
    assert.deepEqual(await readdir(directory), beforeFailure)
    assert.equal(await readFile(occupied, "utf8"), "keep")
    const probe = await open(occupied, "r")
    const prototype = Object.getPrototypeOf(probe)
    const originalWrite = prototype.writeFile
    await probe.close()
    try {
      /**
       * 模拟部分写入后磁盘失败，检查未交付文件已删除。
       * @throws Error 固定的磁盘故障，由抓取工具转换并清理。
       */
      prototype.writeFile = async function (this: FileHandle): Promise<void> {
        await this.write(Buffer.from("partial"))
        throw new Error("模拟磁盘写入失败")
      }
      assertError(await fetchPage(), "WEB_FETCH_OUTPUT_WRITE_FAILED")
      assert.deepEqual(await readdir(directory), beforeFailure)
      const duringOutput = new AbortController()
      /**
       * 全文写入完成时取消，检查文件不会作为成功结果交付。
       * @param data 待写入的完整字节。
       * @returns 写入并触发取消后完成。
       * @throws Error 底层写入失败。
       */
      prototype.writeFile = async function (this: FileHandle, data: Buffer): Promise<void> {
        await originalWrite.call(this, data)
        duringOutput.abort()
      }
      assertError(await executeWebFetch({ url }, duringOutput.signal, directory), "CANCELLED")
      assert.deepEqual(await readdir(directory), beforeFailure)
    } finally { prototype.writeFile = originalWrite }

    for (const status of [301, 302, 303, 307, 308]) {
      for (const hops of [0, 5, 6]) {
        const beforeCalls = calls
        respond = (response) => {
          const count = requestPath === "/page" ? 0 : Number(requestPath.slice(1))
          if (count < hops) { response.writeHead(status, { Location: `/${count + 1}` }); response.end() }
          else { response.setHeader("Content-Type", "text/plain"); response.end("redirected") }
        }
        const result = await fetchPage()
        if (hops <= 5) assert.deepEqual(result, { text: "redirected" })
        else assertError(result, "WEB_FETCH_TOO_MANY_REDIRECTS")
        assert.equal(calls - beforeCalls, Math.min(hops + 1, 6))
      }
    }
    respond = (response) => { response.writeHead(302, { Location: "/page" }); response.end() }
    assertError(await fetchPage(), "WEB_FETCH_TOO_MANY_REDIRECTS")
    for (const location of ["file:///private", "http://[", "ftp://example.com"]) {
      respond = (response) => { response.writeHead(302, { Location: location }); response.end() }
      assertError(await fetchPage(), "WEB_FETCH_INVALID_REDIRECT")
    }
    respond = (response) => { response.writeHead(302); response.end() }
    assertError(await fetchPage(), "WEB_FETCH_HTTP_ERROR")
    let timeoutCalls = 0
    AbortSignal.timeout = (milliseconds) => { assert.equal(milliseconds, 30000); timeoutCalls++; return originalTimeout(80) }
    respond = (response) => { setTimeout(() => { if (!response.destroyed) { response.writeHead(302, { Location: "/page" }); response.end() } }, 50) }
    assertError(await fetchPage(), "WEB_FETCH_TIMEOUT")
    assert.equal(timeoutCalls, 1, "跳转链共用一个超时")
    AbortSignal.timeout = originalTimeout
    const redirectAbort = new AbortController()
    respond = (response) => {
      if (requestPath === "/page") { response.writeHead(302, { Location: "/hold" }); response.end() }
      else setTimeout(() => redirectAbort.abort(), 10)
    }
    assertError(await executeWebFetch({ url }, redirectAbort.signal, directory), "CANCELLED")

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
    respond = (response) => { response.setHeader("Content-Type", "text/plain"); response.end("z".repeat(40000)) }
    const integrated = await execute("web_fetch", { url }, { ...context, processRuntime: { projectId: "default", sessionId: "test", outputDirectory: directory, requestApproval: async () => { throw new Error("不应审批") } } })
    assert.equal(integrated.status, "success")
    assert.match(JSON.stringify(integrated), /Output truncated.*Full output saved to/)
    const missing = await execute("web_fetch", { url }, context)
    assert.equal(missing.status, "error")
    if (missing.status === "error") assert.equal(missing.error.code, "WEB_FETCH_OUTPUT_WRITE_FAILED")
    console.log("web-fetch.test.ts: 转换、跳转、UTF-8 截断、全文存储及清理、大小、压缩、超时、取消和统一入口通过")
  } finally {
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalTimeout
    TurndownService.prototype.turndown = originalTurndown
    await rm(directory, { recursive: true, force: true })
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
