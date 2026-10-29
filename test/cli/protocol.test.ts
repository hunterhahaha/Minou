/** CLI 协议校验、公开映射和输出故障的离线验证。 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { createStatistics, mapEvent, mapUsage, normalizeRequest, observeEvent, readCliInput, writeResult } from "../../src/cli/protocol.ts"
import { toolGroup, writeOutput } from "../../src/cli/main.ts"
import type { RunResult } from "../../src/cli/protocol.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import type { ToolRegistry } from "../../runtime/tools/src/tool-registry.ts"
import { initializeConfigFilesSnapshot } from "../../src/main/config-files.ts"

/** @returns 完成协议和配置隔离断言。 @throws AssertionError 行为偏离协议。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-cli-protocol-"))
  try {
    const input = { version: 1, prompt: "  Task\n", run_id: "same", workspace: root, model: "model" }
    const base = await normalizeRequest(input, root, root)
    assert.equal(base.prompt, "  Task\n")
    assert.deepEqual(base.isolated, { skill: false, memory: false, mcp: false })
    assert.equal(base.maxSteps, 100)
    assert.equal(base.timeoutSeconds, 1800)
    await writeFile(join(root, "task.txt"), input.prompt)
    await writeFile(join(root, "request.json"), JSON.stringify(input))
    const flags = await readCliInput(["run", "--prompt-file", "task.txt", "--output", "out.json", "--run-id", "same", "--model", "model"], root)
    const json = await readCliInput(["run", "--request", "request.json", "--output", "out.json"], root)
    assert.deepEqual(flags, json)
    const nested = join(root, "nested")
    await mkdir(nested)
    await writeFile(join(nested, "request.json"), JSON.stringify({ version: 1, prompt: "x", workspace: "." }))
    assert.equal((await readCliInput(["run", "--request", "nested/request.json", "--output", "out"], root)).request.workspace, nested)
    await assert.rejects(readCliInput(["run", "--request", "request.json", "--output", "out", "--model", "x"], root), /互斥/)
    for (const args of [
      ["run"], ["benchmark"], ["run", "--output", "x", "--prompt-file", "task.txt", "--bad", "x"],
      ["run", "--output", "a", "--output", "b"], ["run", "--output", "x", "--prompt-file", "task.txt", "--format", "yaml"],
    ]) await assert.rejects(readCliInput(args, root))
    for (const patch of [
      { version: 2 }, { prompt: " " }, { surprise: true }, { isolated: { unknown: true } },
      { isolated: { skill: "false" } }, { isolated: null }, { permissions: null }, { limits: null },
      { permissions: { sandbox_mode: "invalid" } }, { permissions: { auto_approve: { groups: ["mcp_*"] } } },
      { permissions: { auto_approve: { tools: [2] } } }, { permissions: { auto_approve: { groups: null } } },
      { limits: { max_steps: 0 } }, { limits: { max_steps: null } }, { limits: { timeout_seconds: 2_147_484 } },
      { limits: { max_steps: 1.5 } }, { workspace: "missing" },
    ]) await assert.rejects(normalizeRequest({ ...input, ...patch }, root, root), JSON.stringify(patch))
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: [] }))
    const mcp = await normalizeRequest({ ...input, mcp_config: "mcp.json" }, root, root)
    assert.deepEqual(mcp.mcpServers, [])
    await assert.rejects(normalizeRequest({ ...input, mcp_config: "mcp.json", isolated: { mcp: true } }, root, root), /冲突/)

    const profile = join(root, "profile")
    const { paths } = await initializeConfigFilesSnapshot(profile, { skipSkills: true })
    await assert.rejects(readFile(join(paths.rootDir, "skills", "registry.json")), /ENOENT/)
    await mkdir(join(paths.rootDir, "skills"), { recursive: true })
    const registry = join(paths.rootDir, "skills", "registry.json")
    await writeFile(registry, "sentinel-invalid-registry")
    await initializeConfigFilesSnapshot(profile, { skipSkills: true })
    assert.equal(await readFile(registry, "utf8"), "sentinel-invalid-registry")
    await initializeConfigFilesSnapshot(profile)
    assert.equal(JSON.parse(await readFile(registry, "utf8")).version, 1)

    const state = createStatistics()
    /** @param event 本测试的内部载荷。 @returns 带身份的事件。 */
    const event = (event: object) => ({ eventId: "e", sessionId: "s", seq: 1, createdAt: "now", turn: 1, step: 1, ...event }) as SessionEvent
    observeEvent(state, event({ type: "step/start" }))
    observeEvent(state, event({ type: "assistant/block_end", block: { type: "tool_call" } }))
    observeEvent(state, event({ type: "assistant/message", message: { content: [{ type: "thinking", text: "private" }, { type: "text", text: "first" }] }, usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3 } }))
    observeEvent(state, event({ type: "assistant/message", message: { content: [{ type: "text", text: "last" }] }, usage: { inputTokens: 6, outputTokens: 5 } }))
    assert.equal(state.steps, 1)
    assert.equal(state.toolCalls, 1)
    assert.equal(state.answer, "last")
    assert.deepEqual(mapUsage(state.usage), { input_tokens: 10, output_tokens: 7 })
    assert.equal(mapEvent(event({ type: "assistant/block_delta", delta: { type: "thinking", text: "private" } })), undefined)
    assert.deepEqual(mapEvent(event({ type: "tool/result", toolCallId: "call", result: { status: "error", content: [{ type: "text", text: "private" }], error: { details: "credential" } } })), { type: "tool.completed", data: { step: 1, call_id: "call", status: "error" } })
    assert.equal(toolGroup("mcp_fake", { get: () => ({ kind: "builtin" }) } as unknown as ToolRegistry), undefined)
    assert.equal(toolGroup("mcp_remote", { get: () => ({ kind: "mcp" }) } as unknown as ToolRegistry), "mcp")

    let delivered = false
    const stream = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { setTimeout(() => { delivered = true; done() }, 25) } })
    await writeOutput(stream, "line")
    assert.equal(delivered, true, "不能在背压输出实际完成前返回")
    const broken = new Writable({ write(_chunk, _encoding, done) { done(new Error("broken pipe")) } })
    broken.on("error", () => {})
    await assert.rejects(writeOutput(broken, "line"), /broken pipe/)
    const stalled = new Writable({ write() { /* 消费方故意不确认写入。 */ } })
    await assert.rejects(writeOutput(stalled, "line"), /超时/)
    stalled.destroy()
    const target = join(root, "atomic.json")
    await writeFile(target, "old-result")
    await assert.rejects(writeResult(target, { circular: 1n } as unknown as RunResult))
    assert.equal(await readFile(target, "utf8"), "old-result")
    assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false)
    console.log("CLI protocol: passed")
  } finally { await rm(root, { recursive: true, force: true }) }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
