/** 真实 Adapter、SessionRuntime、SQLite 与重启回放之间的不透明协议状态验证。 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAnthropicAdapter } from "../../model/src/anthropic.ts"
import type { ModelConfig, ModelRef } from "../../model/src/types.ts"
import { sseEvent, startFakeProvider } from "../../model/test/helpers.ts"
import { initializeSessionMetaDatabase } from "../../session/src/meta-store.ts"
import type { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import { SessionRuntime } from "../src/session-runtime.ts"

/** @returns 同轮工具结果和重启后历史均完整回传签名与遮蔽内容。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-protocol-state-"))
  const model: ModelRef = { providerId: "offline", modelId: "offline", protocol: "anthropic_messages", name: "claude-test", reasoningLevel: "medium" }
  const config: ModelConfig = { ...model, supportsReasoning: true, contextWindow: 128000, maxOutputTokens: 4096,
    reasoningLevels: ["medium"], reasoningField: { path: ["output_config", "effort"] } }
  const preserved = [
    { type: "thinking", thinking: "signed fixture", signature: "opaque-signature" },
    { type: "redacted_thinking", data: "opaque-redacted-data" },
    { type: "tool_use", id: "call-1", name: "read", input: {} },
  ]
  const provider = await startFakeProvider((_request, attempt) => {
    const blocks = attempt === 0 ? preserved : [{ type: "text", text: "done" }]
    const events = [sseEvent("message_start", { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } })]
    blocks.forEach((block, index) => {
      events.push(sseEvent("content_block_start", { type: "content_block_start", index, content_block: block }))
      events.push(sseEvent("content_block_stop", { type: "content_block_stop", index }))
    })
    events.push(sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: attempt === 0 ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }))
    events.push(sseEvent("message_stop", { type: "message_stop" }))
    return { events }
  })
  const metaDatabasePath = join(root, "meta.sqlite")
  initializeSessionMetaDatabase(metaDatabasePath)
  const global = {
    resolveProjectContext: () => ({ workspaceInfo: "workspace", resolveCurrentBaseline: async () => ({
      agentsmd: { path: join(root, "AGENTS.md"), content: "", hash: createHash("sha256").update("").digest("hex") },
      skills: { content: "", entries: [], descriptions: {} }, mcp: [],
    }) }),
    createTurnModelAdapter: async () => ({ ...createAnthropicAdapter(config, { apiKey: "offline", baseURL: provider.origin }),
      contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens }),
    listToolDefinitions: () => [{ name: "read", inputSchema: { type: "object" } }],
    executeTool: async () => ({ status: "success", content: [{ type: "text", text: "tool result" }] }),
    estimateSkillTokens: () => 0, interruptTerminals: () => [],
  } as unknown as SessionRuntimeGlobal
  const create = () => new SessionRuntime({ sessionId: "protocol-state", projectGroupId: "default", sessionDirectory: join(root, "session"),
    databasePath: join(root, "events.sqlite"), metaDatabasePath, systemPrompt: "test", global })
  try {
    const runtime = create()
    await runtime.processMessageQueue(await runtime.startNewSession({ model, content: [{ type: "text", text: "read" }] })).completion
    const reloaded = create()
    await reloaded.processMessageQueue(await reloaded.continueSession({ content: [{ type: "text", text: "continue" }] })).completion
    assert.equal(provider.requests.length, 3)
    for (const request of provider.requests.slice(1)) {
      const messages = request.body.messages as Array<{ role: string; content: unknown }>
      assert.deepEqual(messages.find((message) => message.role === "assistant")?.content, preserved)
    }
    global.listToolDefinitions = () => [{ name: "read", inputSchema: { type: "object" } }, { name: "new_tool", inputSchema: { type: "object" } }]
    const changedTools = create()
    await changedTools.processMessageQueue(await changedTools.continueSession({ content: [{ type: "text", text: "tools changed" }] })).completion
    const changedMessages = provider.requests.at(-1)!.body.messages as Array<{ role: string; content: unknown }>
    assert.deepEqual(changedMessages.find((message) => message.role === "assistant")?.content, [preserved[2]], "工具定义变化后不回传绑定旧前缀的签名")
    const { events } = await reloaded.readSnapshot()
    assert.ok(JSON.stringify(events).includes("opaque-signature"))
    console.log("protocol-state.test.ts: signed thinking survives tool calls and restart")
  } finally { await provider.close(); await rm(root, { recursive: true, force: true }) }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
