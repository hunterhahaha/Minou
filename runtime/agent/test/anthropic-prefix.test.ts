/** 通过真实 Session 存储与本地 Anthropic SSE 服务验证跨 Turn 的签名前缀。 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionRuntime } from "../src/session-runtime.ts"
import { createAnthropicAdapter } from "../../model/src/anthropic.ts"
import type { ModelConfig } from "../../model/src/types.ts"
import type { SessionEvent } from "../../session/src/events.ts"
import { sseEvent, startFakeProvider } from "../../model/test/helpers.ts"
import { ToolRegistry, RenderRegistry } from "../../tools/src/index.ts"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"

const MODEL: ModelConfig = {
  providerId: "offline", modelId: "claude", name: "claude-sonnet-5-5", protocol: "anthropic_messages",
  supportsReasoning: true, reasoningLevels: ["medium"], reasoningField: { path: ["output_config", "effort"] },
  contextWindow: 128000, maxOutputTokens: 4096,
}

/**
 * 为本地测试服务生成绑定系统提示、工具表及前序消息的可验证标记。
 * @param system 请求的顶层系统提示。
 * @param tools 请求的顶层工具表。
 * @param messages 思考块之前的消息。
 * @returns 确定性的测试签名；不模拟服务端密码学实现。
 */
function signature(system: unknown, tools: unknown, messages: unknown): string {
  return createHash("sha256").update(JSON.stringify({ system, tools, messages })).digest("hex")
}

/**
 * 重启 Runtime 并修改或清空规则，验证旧签名对应的前缀与完整原生块始终不变。
 * @param initialRules 首轮规则；空字符串覆盖初始没有规则的场景。
 * @returns 跨 Turn、重启、重复恢复和多次规则更新验证完成。
 * @throws Error 前缀、持久化或模型请求不符合预期时拒绝。
 */
async function testPrefix(initialRules: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-anthropic-prefix-"))
  let mismatches = 0
  const provider = await startFakeProvider(({ body }, attempt) => {
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    for (const [index, message] of messages.entries()) {
      if (message.role !== "assistant") continue
      const thinking = message.content[0]
      if (thinking.type !== "thinking" || thinking.signature !== signature(body.system, body.tools, messages.slice(0, index))) {
        mismatches++
        return { status: 400 }
      }
    }
    const signed = signature(body.system, body.tools, messages)
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: signed } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: `done-${attempt}` } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
      { type: "message_stop" },
    ]
    return { events: events.map((event) => sseEvent(event.type, event)) }
  })
  const paths = await initializeConfigFiles(root)
  const global = new SessionRuntimeGlobal(paths, new ToolRegistry(), new RenderRegistry())
  global.createTurnModelAdapter = async () => Object.assign(createAnthropicAdapter(MODEL, {
    apiKey: "fixture", baseURL: provider.baseURL("anthropic_messages"),
    nativeHistory: { name: "anthropic", protocol: "anthropic_messages", inlineToolChanges: true },
  }), { contextWindow: MODEL.contextWindow, maxOutputTokens: MODEL.maxOutputTokens })
  const sessionDirectory = join(paths.rootDir, "sessions", "default", "prefix")
  const agentsPath = join(paths.rootDir, "sessions", "default", "workspace", "AGENTS.md")
  const versions = [initialRules, "rules-v2", "", "rules-v3"]
  let runtime: SessionRuntime | undefined
  try {
    for (const [index, rules] of versions.entries()) {
      await writeFile(agentsPath, rules)
      runtime = new SessionRuntime({
        projectGroupId: "default", sessionId: "prefix", sessionDirectory,
        databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath,
        systemPrompt: "fixed system", global,
      })
      const input = { model: { ...MODEL, reasoningLevel: "medium" }, content: [{ type: "text" as const, text: `turn-${index}` }] }
      if (index === 0) await (await runtime.startNewSession(input)).completion
      else {
        await runtime.repairSession()
        await runtime.repairSession()
        await (await runtime.continueSession(input)).completion
      }
      const body = provider.requests.at(-1)!.body
      assert.equal(body.system, provider.requests[0].body.system, "规则更新和重启不能改写旧思考的系统前缀")
      assert.deepEqual(body.tools, provider.requests[0].body.tools)
      const events = await runtime.readEvents() as SessionEvent[]
      assert.equal(events.filter((event) => event.type === "context_update").length, index)
      assert.equal(events.some((event) => event.type === "app/error"), false)
      if (index > 0 && rules !== "") assert.match(JSON.stringify(body.messages), new RegExp(rules))
      const state = JSON.parse(await readFile(join(sessionDirectory, "contextstate.json"), "utf8")) as { agentsmd: { content: string } }
      assert.equal(state.agentsmd.content, initialRules)
      assert.equal(await readFile(join(sessionDirectory, "agents_md.snapshot"), "utf8"), rules)
      runtime.close()
    }
    assert.equal(mismatches, 0)
    assert.equal(provider.requests.length, versions.length)
    const messages = provider.requests.at(-1)!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const firstAssistant = messages.find((message) => message.role === "assistant")!
    assert.deepEqual(firstAssistant.content, [
      { type: "thinking", thinking: "", signature: signature(provider.requests[0].body.system, provider.requests[0].body.tools, provider.requests[0].body.messages) },
      { type: "text", text: "done-0" },
    ])
  } finally {
    runtime?.close()
    await global.disposeProcessTools()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  }
}

/** @returns 两种初始规则下的跨 Turn 签名前缀验证完成。 @throws Error 任一场景失败时拒绝。 */
async function main(): Promise<void> {
  await testPrefix("rules-v1")
  await testPrefix("")
  console.log("anthropic-prefix.test.ts: 固定前缀、原生思考回放、规则更新与重启恢复通过")
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
