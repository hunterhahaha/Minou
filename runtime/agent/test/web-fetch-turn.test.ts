/** 真实 Session 与抓取工具的事件关联和模型上下文回填测试。 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeConfigFilesSnapshot } from "../../../src/main/config-files.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import type { ModelAdapter, ModelRef } from "../../model/src/types.ts"
import type { SessionEvent } from "../../session/src/events.ts"
import { registerWebFetchTool, RenderRegistry, ToolRegistry } from "../../tools/src/index.ts"
import { SessionRuntime } from "../src/session-runtime.ts"

/**
 * 让脚本模型执行抓取并消费回填结果，验证已提交事件引用真实调用身份。
 * @returns 抓取、回填和持久化断言完成。
 * @throws Error Session、本地 HTTP 或断言失败。
 */
async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "nicode-web-turn-"))
  const server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<p>Session fetched <strong>context</strong></p>") })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  let session: SessionRuntime | undefined
  let global: SessionRuntimeGlobal | undefined
  try {
    const { paths } = await initializeConfigFilesSnapshot(profile)
    const tools = new ToolRegistry(), renders = new RenderRegistry()
    registerWebFetchTool(tools, renders)
    global = new SessionRuntimeGlobal(paths, tools, renders)
    let requests = 0
    const adapter: ModelAdapter = { contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (request) {
      requests += 1
      const definition = request.tools?.find((tool) => tool.name === "web_fetch")
      assert.ok(definition)
      assert.deepEqual(Object.keys((definition.inputSchema.properties ?? {}) as object), ["url"])
      if (requests === 1) {
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: "fetch-call", name: "web_fetch", arguments: { url: `http://127.0.0.1:${address.port}/page` } } }
        yield { type: "stream_end", completion: "tool_calls" }
      } else {
        const tool = request.context.messages.find((message) => message.role === "tool" && message.toolCallId === "fetch-call")
        assert.ok(tool?.role === "tool" && !tool.isError)
        assert.match(JSON.stringify(tool.content), /Session fetched \*\*context\*\*/)
        yield { type: "block_start", index: 0, blockType: "text" }
        yield { type: "block_end", index: 0, block: { type: "text", text: "Fetch consumed" } }
        yield { type: "stream_end", completion: "finished" }
      }
    } }
    global.createTurnModelAdapter = async () => adapter
    const model: ModelRef = { providerId: "fake", modelId: "fake", protocol: "chat_completions", name: "fake", reasoningLevel: "low" }
    session = new SessionRuntime({ projectGroupId: "default", sessionId: "fetch-session", sessionDirectory: join(paths.rootDir, "sessions", "default", "fetch-session"), databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "offline", global })
    const started = await session.startNewSession({ model, sandboxMode: "sandbox-read-only", content: [{ type: "text", text: "Fetch" }] })
    await started.completion
    assert.equal(requests, 2)
    const events = await session.readEvents() as readonly SessionEvent[]
    const results = events.filter((event) => event.type === "tool/result")
    assert.equal(results.length, 1)
    const result = results[0]
    assert.equal(result.result.status, "success")
    const call = events.find((event) => event.eventId === result.toolCallEventId)
    assert.ok(call?.type === "assistant/block_end" && call.block.type === "tool_call")
    assert.equal(result.toolCallId, call.block.toolCallId)
    assert.equal(result.blockId, call.blockId)
    assert.equal(events.some((event) => event.type === "approval/request"), false)
    assert.ok(events.some((event) => event.type === "turn/end" && event.reason === "completed"))
    console.log("web-fetch-turn.test.ts: 桌面 Session 工具暴露、事件关联和模型回填通过")
  } finally {
    session?.close()
    await global?.disposeProcessTools()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(profile, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
