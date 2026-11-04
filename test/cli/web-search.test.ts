/** 编译后的真实 CLI 子进程，通过假模型调用本地搜索服务并检查内部日志。 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { initializeConfigFilesSnapshot } from "../../src/main/config-files.ts"
import { saveModel, saveProvider, setProviderApiKey } from "../../src/main/provider-store.ts"
import { saveWebSearchProvider, setActiveWebSearchProvider, WEB_SEARCH_DATABASE_FILE } from "../../runtime/tools/src/web-search/store.ts"
import type { RunResult } from "../../src/cli/protocol.ts"

/**
 * 输出真实 SDK 可读取的 Chat Completions SSE，第一步调用搜索，第二步回答。
 * @param response 模型 HTTP 响应。
 * @param first 是否发布搜索调用。
 */
function reply(response: ServerResponse, first: boolean): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "search-call", type: "function", function: { name: "web_search", arguments: '{"query":"cli-query"}' } }] } : { role: "assistant", content: "CLI search consumed" }
  for (const [content, reason] of [[delta, null], [{}, first ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "model", object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}

/**
 * 验证实际 CLI 装配、HTTP 搜索、结果回填和私有事件持久化，不使用远端服务。
 * @returns 所有子进程和日志断言完成。
 * @throws Error 子进程、HTTP 或断言失败。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-cli-web-"))
  let searchCalls = 0, modelCalls = 0
  let serverError: unknown
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.startsWith("/search")) {
        searchCalls += 1
        assert.equal(request.url, "/search?q=cli-query")
        assert.equal(request.headers["x-api-key"], "search-secret")
        response.end(JSON.stringify({ hits: [{ title: "CLI Search", url: "https://example.com/cli", snippet: "CLI snippet" }] }))
        return
      }
      modelCalls += 1
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }>
        messages: Array<{ role: string; content: string; tool_call_id?: string }>
      }
      const search = body.tools.find((tool) => tool.function.name === "web_search")
      assert.ok(search)
      assert.deepEqual(search.function.parameters, { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false })
      if (modelCalls === 2) {
        const result = body.messages.find((message) => message.role === "tool" && message.tool_call_id === "search-call")
        assert.ok(result)
        assert.match(result.content, /CLI Search[\s\S]*CLI snippet/)
      }
      reply(response, modelCalls === 1)
    })().catch((error: unknown) => { serverError = error; response.writeHead(500); response.end() })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    const profile = join(directory, "profile"), workspace = join(directory, "workspace")
    await mkdir(workspace)
    const { paths } = await initializeConfigFilesSnapshot(profile)
    const endpoint = `http://127.0.0.1:${address.port}`
    saveProvider(paths.providerDatabasePath, { id: "model", name: "model", type: "custom", protocol: "chat_completions", baseURL: `${endpoint}/v1` })
    saveModel(paths.providerDatabasePath, { providerId: "model", modelId: "fake", name: "fake", contextWindow: 128000, maxOutputTokens: 4096, supportsReasoning: false })
    setProviderApiKey(paths.providerDatabasePath, "model", "model-secret")
    const database = join(paths.rootDir, WEB_SEARCH_DATABASE_FILE)
    saveWebSearchProvider(database, { id: "search", requestJson: JSON.stringify({ url: `${endpoint}/search?q=\${query}`, headers: { "X-API-KEY": "search-secret" } }), responseJmespath: "hits" })
    setActiveWebSearchProvider(database, "search")
    const input = join(directory, "request.json"), output = join(directory, "result.json")
    await writeFile(input, JSON.stringify({ version: 1, prompt: "search", workspace, isolated: { skill: true, memory: true, mcp: true } }))
    const child = spawn(process.execPath, [resolve("dist/src/cli/main.js"), "run", "--request", input, "--output", output, "--format", "jsonl"], { env: { ...process.env, USERPROFILE: profile }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI 搜索测试超时: ${stderr}`)) }, 15000)
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("close", (value) => { clearTimeout(timer); done(value) })
    })
    if (serverError) throw serverError
    assert.equal(code, 0, stderr)
    assert.equal(searchCalls, 1)
    assert.equal(modelCalls, 2)
    const result = JSON.parse(await readFile(output, "utf8")) as RunResult
    assert.equal(result.answer, "CLI search consumed")
    assert.equal(result.metrics.steps, 2)
    assert.doesNotMatch(stdout + stderr, /search-secret|model-secret/)
    assert.ok(result.record_directory)
    const db = new DatabaseSync(join(result.record_directory, "events.sqlite"), { readOnly: true })
    try {
      const rows = db.prepare("SELECT event_json FROM session_events WHERE type = 'tool/result'").all()
      assert.equal(rows.length, 1)
      const event = JSON.parse(String(rows[0].event_json))
      assert.equal(event.result.status, "success")
      assert.equal(event.toolCallId, "search-call")
      assert.match(JSON.stringify(event.result), /CLI Search/)
    } finally { db.close() }
    console.log("CLI web-search: 真实子进程注册、HTTP 搜索、结果回填和内部日志通过")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
