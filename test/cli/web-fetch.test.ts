/** 编译后的真实 CLI 子进程，通过假模型调用本地抓取服务并检查内部日志。 */
import TurndownService from "turndown"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { initializeConfigFilesSnapshot } from "../../src/main/config-files.ts"
import { saveModel, saveProvider, setProviderApiKey } from "../../src/main/provider-store.ts"
import type { RunResult } from "../../src/cli/protocol.ts"

/**
 * 输出真实 SDK 可读取的 Chat Completions SSE，第一步调用抓取，第二步回答。
 * @param response 模型 HTTP 响应。
 * @param first 是否发布抓取调用。
 * @param url 本地抓取地址。
 */
function reply(response: ServerResponse, first: boolean, url: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "fetch-call", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url }) } }] } : { role: "assistant", content: "CLI fetch consumed" }
  for (const [content, reason] of [[delta, null], [{}, first ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "model", object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}

/**
 * 验证实际 CLI 装配、HTTP 抓取、结果回填和私有事件持久化，不使用远端服务。
 * @returns 所有子进程和日志断言完成。
 * @throws Error 子进程、HTTP 或断言失败。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "minou-cli-web-"))
  let fetchCalls = 0, modelCalls = 0
  const fullText = new TurndownService().turndown("<p>CLI fetched <strong>content</strong></p><pre>" + "完整正文😀\n".repeat(4000) + "</pre>")
  let modelText = ""
  let endpoint = ""
  let serverError: unknown
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/page") {
        fetchCalls += 1
        assert.equal(request.method, "GET")
        response.setHeader("Content-Type", "text/html")
        response.end("<p>CLI fetched <strong>content</strong></p><pre>" + "完整正文😀\n".repeat(4000) + "</pre>")
        return
      }
      modelCalls += 1
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }>
        messages: Array<{ role: string; content: string; tool_call_id?: string }>
      }
      const fetchTool = body.tools.find((tool) => tool.function.name === "web_fetch")
      assert.ok(fetchTool)
      assert.deepEqual(fetchTool.function.parameters, { type: "object", properties: { url: { type: "string", minLength: 1 } }, required: ["url"], additionalProperties: false })
      if (modelCalls === 2) {
        const result = body.messages.find((message) => message.role === "tool" && message.tool_call_id === "fetch-call")
        assert.ok(result)
        modelText = result.content
        assert.match(modelText, /Output truncated:/)
        assert.match(result.content, /CLI fetched \*\*content\*\*/)
      }
      reply(response, modelCalls === 1, `${endpoint}/page`)
    })().catch((error: unknown) => { serverError = error; response.writeHead(500); response.end() })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  try {
    const profile = join(directory, "profile"), workspace = join(directory, "workspace")
    await mkdir(workspace)
    const { paths } = await initializeConfigFilesSnapshot(profile)
    endpoint = `http://127.0.0.1:${address.port}`
    saveProvider(paths.providerDatabasePath, { id: "model", name: "model", type: "custom", protocol: "chat_completions", baseURL: `${endpoint}/v1` })
    saveModel(paths.providerDatabasePath, { providerId: "model", modelId: "fake", name: "fake", contextWindow: 128000, maxOutputTokens: 4096, supportsReasoning: false })
    setProviderApiKey(paths.providerDatabasePath, "model", "model-secret")
    const input = join(directory, "request.json"), output = join(directory, "result.json")
    await writeFile(input, JSON.stringify({ version: 1, prompt: "fetch", workspace, isolated: { skill: true, memory: true, mcp: true } }))
    const child = spawn(process.execPath, [resolve("dist/src/cli/main.js"), "run", "--request", input, "--output", output, "--format", "jsonl"], { env: { ...process.env, USERPROFILE: profile }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI 抓取测试超时: ${stderr}`)) }, 15000)
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("close", (value) => { clearTimeout(timer); done(value) })
    })
    if (serverError) throw serverError
    assert.equal(code, 0, stderr)
    assert.equal(fetchCalls, 1)
    assert.equal(modelCalls, 2)
    const result = JSON.parse(await readFile(output, "utf8")) as RunResult
    assert.equal(result.answer, "CLI fetch consumed")
    assert.equal(result.metrics.steps, 2)
    assert.doesNotMatch(stdout + stderr, /model-secret/)
    assert.ok(result.record_directory)
    const db = new DatabaseSync(join(result.record_directory, "events.sqlite"), { readOnly: true })
    try {
      const rows = db.prepare("SELECT event_json FROM session_events WHERE type = 'tool/result'").all()
      assert.equal(rows.length, 1)
      const event = JSON.parse(String(rows[0].event_json))
      assert.equal(event.result.status, "success")
      assert.equal(event.toolCallId, "fetch-call")
      assert.match(JSON.stringify(event.result), /CLI fetched/)
      assert.equal(event.result.content[0].text, modelText)
      const outputPath = /Full output saved to:\n([^\n]+)/.exec(modelText)?.[1]
      assert.ok(outputPath)
      assert.equal(dirname(outputPath), join(result.record_directory, "tool_output"))
      assert.equal(await readFile(outputPath, "utf8"), fullText)
    } finally { db.close() }
    console.log("CLI web-fetch: 真实子进程注册、HTTP 抓取、结果回填和内部日志通过")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
