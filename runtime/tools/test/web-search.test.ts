/** 搜索工具的真实 HTTP、配置透传、JMESPath、错误脱敏和取消测试。 */
import { estimateLocalTokens } from "../../../src/main/token-estimator.ts"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  createExecuteToolCall, RenderRegistry, ToolRegistry, toolScheduleGroup,
  registerWebSearchTool, initializeWebSearchDatabase, saveWebSearchProvider,
  setActiveWebSearchProvider, executeWebSearch, WEB_SEARCH_TIMEOUT_MS,
} from "../src/index.ts"
import type { WebSearchProviderInput, WebSearchResult } from "../src/web-search/types.ts"
import type { ToolCallContext } from "../src/types.ts"
import type { AppError } from "../../error/src/types.ts"
import { renderWebSearch } from "../src/render/web-search.ts"

/**
 * 断言业务结果为指定错误，且不含请求、响应和凭据原文。
 * @param result 执行结果。
 * @param code 预期错误码。
 * @throws AssertionError 错误或脱敏行为不符。
 */
function assertError(result: WebSearchResult | AppError, code: string): void {
  assert.ok("code" in result)
  assert.equal(result.code, code)
  assert.doesNotMatch(JSON.stringify(result), /secret-key|raw-secret|private-query/)
}

/**
 * 验证请求原文替换、fetch 透传、解析包装、render 和工具执行边界。
 * @returns 全部场景完成。
 * @throws Error 本地服务、工具或断言失败。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-web-search-"))
  const database = join(directory, "web-search.sqlite")
  let route = "", method = "", body = "", header = "", attempts = 0
  let respond = (response: ServerResponse): void => { response.end(JSON.stringify({ items: [
    { name: "One", link: "https://one.example", summary: null, date: "original-date" },
    { name: "Two", link: "https://two.example", summary: "snippet" },
  ] })) }
  const server = createServer((request, response) => {
    void (async () => {
      attempts += 1
      route = request.url ?? ""
      method = request.method ?? ""
      header = String(request.headers["x-api-key"] ?? "")
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      body = Buffer.concat(chunks).toString()
      respond(response)
    })().catch(() => response.destroy())
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const endpoint = `http://127.0.0.1:${address.port}`
  const provider: WebSearchProviderInput = {
    name: "Test",
    id: "local", requestJson: JSON.stringify({
      url: `${endpoint}/search?q=\${query}`, method: "POST",
      headers: { "X-API-Key": "secret-key-${query}", "Content-Type": "application/json" },
      body: '{"q":"${query}","also":"${query}","num":10}',
    }), responseJmespath: "items[].{title: name, url: link, snippet: summary, publishedAt: date}",
  }
  const signal = new AbortController().signal
  const search = (query = "coding-agent") => executeWebSearch(database, { query }, signal, estimateLocalTokens)
  /** @param patch 完整配置的覆盖值。保存并启用当前测试配置。 */
  const configure = (patch: Partial<WebSearchProviderInput> = {}): void => {
    saveWebSearchProvider(database, { ...provider, ...patch })
    setActiveWebSearchProvider(database, provider.id)
  }
  try {
    initializeWebSearchDatabase(database)
    assertError(await search(), "WEB_SEARCH_NOT_CONFIGURED")
    configure()
    const result = await search("cash-$&")
    assert.deepEqual(result, { results: [
      { title: "One", url: "https://one.example", snippet: null, publishedAt: "original-date" },
      { title: "Two", url: "https://two.example", snippet: "snippet", publishedAt: null },
    ] })
    assert.equal(route, "/search?q=cash-$&")
    assert.equal(method, "POST")
    assert.equal(header, "secret-key-cash-$&")
    assert.equal(body, '{"q":"cash-$&","also":"cash-$&","num":10}')
    assertError(await search('private-query"\n'), "WEB_SEARCH_REQUEST_INVALID")

    /** 完整字符串占位符使用 JSON 转义，包含原生 body 字符串和其中预序列化的 JSON。 */
    for (const query of ['quoted "query"', "line1\nline2\r\tend", "C:\\path\\file", '中文 $& ${query} \\"\n']) {
      configure({ requestJson: JSON.stringify({ url: `${endpoint}/safe`, method: "POST", body: "${query}" }) })
      assert.ok("results" in await search(query))
      assert.equal(body, query, "外层完整占位符不能改变 query 原文")
      configure({ requestJson: JSON.stringify({ url: `${endpoint}/safe`, method: "POST", headers: { "Content-Type": "application/json" }, body: '{"q":"${query}","also":"${query}","num":10}' }) })
      assert.ok("results" in await search(query))
      assert.deepEqual(JSON.parse(body), { q: query, also: query, num: 10 }, "内层 JSON 的多处占位符也必须完整保留 query")
    }
    configure({ requestJson: JSON.stringify({ url: `${endpoint}/safe`, method: "POST", body: JSON.stringify({ q: '"${query}"' }) }) })
    assert.ok("results" in await search("literal"))
    assert.deepEqual(JSON.parse(body), { q: '"literal"' }, "嵌入值中的字面量引号不能被误认作占位符边界")

    configure({ responseJmespath: "items" })
    const snippets = [null, "", "a".repeat(3199), "a".repeat(3200), "a".repeat(3201), "中".repeat(3201), "a".repeat(3198) + "😀tail", "😀".repeat(1700)]
    const entries = snippets.map((snippet, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}`, snippet, publishedAt: "date", extra: index }))
    respond = (response) => response.end(JSON.stringify({ items: entries }))
    const filesBeforeSearch = await readdir(directory)
    const limited = await search()
    assert.deepEqual(await readdir(directory), filesBeforeSearch, "摘要截断不生成完整输出文件")
    assert.ok("results" in limited)
    for (const [index, item] of limited.results.entries()) {
      const original = entries[index]
      assert.deepEqual({ ...item, snippet: original.snippet }, original)
      if (typeof original.snippet !== "string" || estimateLocalTokens(original.snippet) <= 800) assert.equal(item.snippet, original.snippet)
      else {
        assert.ok(typeof item.snippet === "string")
        assert.ok(estimateLocalTokens(item.snippet) <= 800)
        assert.ok(item.snippet.endsWith("…"))
        assert.ok(original.snippet.startsWith(item.snippet.slice(0, -1)))
        assert.equal(Buffer.from(item.snippet, "utf8").toString("utf8") === item.snippet, true)
      }
    }
    assert.equal(limited.results[4].snippet, "a".repeat(3199) + "…")
    assert.equal(limited.results[6].snippet, "a".repeat(3198) + "…")

    const originalFetch = globalThis.fetch
    try {
      configure({ requestJson: JSON.stringify({ url: `${endpoint}/direct`, method: "POST", body: "already-serialized-${query}", redirect: "manual", cache: "no-store" }), responseJmespath: "items" })
      const entries = [{ arbitrary: "untouched", snippet: undefined }]
      globalThis.fetch = async (url, init) => {
        assert.equal(url, `${endpoint}/direct`)
        assert.deepEqual({ ...init, signal: undefined }, { method: "POST", body: "already-serialized-query", redirect: "manual", cache: "no-store", signal: undefined })
        assert.ok(init?.signal instanceof AbortSignal)
        return new Response(JSON.stringify({ items: entries }))
      }
      assert.deepEqual(await search("query"), { results: [{ arbitrary: "untouched" }] }, "只检查数组，不补齐或筛选条目字段")
    } finally { globalThis.fetch = originalFetch }

    configure({ requestJson: JSON.stringify({ url: `${endpoint}/get?query=\${query}` }), responseJmespath: "items" })
    respond = (response) => { response.end('{"items":[]}') }
    assert.deepEqual(await search(), { results: [] })
    assert.equal(method, "GET")
    assert.equal(body, "")
    respond = (response) => { response.end('{"items":null}') }
    assertError(await search(), "WEB_SEARCH_RESULT_INVALID")
    configure({ responseJmespath: "length(items)" })
    respond = (response) => { response.end('{"items":7}') }
    assertError(await search(), "WEB_SEARCH_MAPPING_FAILED")
    respond = (response) => { response.end("raw-secret-invalid-json") }
    assertError(await search(), "WEB_SEARCH_RESPONSE_INVALID")
    const previous = attempts
    respond = (response) => { response.writeHead(401); response.end("raw-secret-response") }
    assertError(await search(), "WEB_SEARCH_HTTP_ERROR")
    assert.equal(attempts, previous + 1, "失败不能自动重试")
    configure({ requestJson: "{}" })
    assertError(await search(), "WEB_SEARCH_REQUEST_INVALID")
    configure({ requestJson: JSON.stringify({ url: "invalid-url-secret-key" }) })
    assertError(await search(), "WEB_SEARCH_REQUEST_FAILED")

    configure()
    const abort = new AbortController()
    abort.abort()
    assertError(await executeWebSearch(database, { query: "private-query" }, abort.signal, estimateLocalTokens), "CANCELLED")
    let releaseHeaders!: () => void
    const headersSent = new Promise<void>((done) => { releaseHeaders = done })
    respond = (response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.flushHeaders(); releaseHeaders() }
    const duringRead = new AbortController()
    const cancelled = executeWebSearch(database, { query: "private-query" }, duringRead.signal, estimateLocalTokens)
    await headersSent
    duringRead.abort()
    assertError(await cancelled, "CANCELLED")

    const originalTimeout = AbortSignal.timeout
    try {
      AbortSignal.timeout = (milliseconds) => { assert.equal(milliseconds, WEB_SEARCH_TIMEOUT_MS); return originalTimeout(10) }
      assertError(await search(), "WEB_SEARCH_TIMEOUT")
    } finally { AbortSignal.timeout = originalTimeout }

    const tools = new ToolRegistry(), renders = new RenderRegistry()
    registerWebSearchTool(tools, renders, database, estimateLocalTokens)
    assert.equal(toolScheduleGroup("web_search"), "shared")
    assert.deepEqual(tools.listDefinitions()[0].inputSchema, { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false })
    const execute = createExecuteToolCall(tools, renders)
    const context: ToolCallContext = { turn: 1, step: 1, blockId: "block", toolCallId: "call", signal }
    for (const args of [{}, { query: " " }, { query: 3 }, { query: "x", provider: "local" }]) {
      const invalid = await execute("web_search", args, context)
      assert.ok(invalid.status === "error")
      assert.equal(invalid.error.code, "INVALID_TOOL_ARGUMENTS")
    }
    respond = (response) => { response.end('{"items":[]}') }
    configure()
    assert.deepEqual(await execute("web_search", { query: "ok" }, context), renderWebSearch({ results: [] }))
    const rendered = renderWebSearch({ results: [{ title: "Title", url: "https://one.example", snippet: "Description", publishedAt: "date" }] })
    assert.match(JSON.stringify(rendered), /1\. Title.*https:\/\/one.example.*Description.*Published: date/)
    assert.equal(renderWebSearch({ source: "tool", code: "FAILED", message: "safe" }).status, "error")
    const db = new DatabaseSync(database)
    try { db.exec("UPDATE web_search_providers SET response_jmespath = '['") }
    finally { db.close() }
    assertError(await search(), "WEB_SEARCH_CONFIG_INVALID")
    console.log("web-search.test.ts: 请求透传、字面量替换、JMESPath、render、取消和超时通过")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
