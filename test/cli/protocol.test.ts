/** CLI 协议校验、公开映射和输出故障的离线验证。 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { createStatistics, mapUsage, observeEvent, readCliInput, readContinueInput, writeOutputFile } from "../../src/cli/protocol.ts"
import { toolGroup, writeOutput } from "../../src/cli/main.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import type { ToolRegistry } from "../../runtime/tools/src/tool-registry.ts"
import { initializeConfigFilesSnapshot } from "../../src/main/config-files.ts"

/** @returns 完成协议和配置隔离断言。 @throws AssertionError 行为偏离协议。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "minou-cli-protocol-"))
  try {
    const base = await readCliInput(["run", "--prompt", "  Task\n", "--modelid", "model"], root)
    assert.equal(base.request.prompt, "  Task\n")
    assert.equal(base.request.modelId, "model")
    assert.equal(base.request.supportsReasoning, true)
    assert.equal(base.request.workspace, root)
    assert.equal(base.output, undefined)
    assert.equal(base.outputJson, undefined)
    assert.deepEqual(base.request.isolated, { skill: false, memory: false, mcp: false })
    assert.equal(base.request.restrictSystemTools, false)
    assert.deepEqual(base.request.systemTools, [])
    assert.equal(base.request.useConfiguredMcp, true)
    assert.equal(base.request.sandboxMode, "sandbox-full-access")
    assert.equal(base.request.maxSteps, 100)
    assert.equal(base.request.timeoutSeconds, 1800)

    const id = "03ad078c-9f24-478c-a2af-7071429bf5ba"
    const continuation = ["continue", "--session-id", id, "--prompt", "  Follow-up\n"]
    assert.deepEqual(readContinueInput(continuation), { sessionId: id, prompt: "  Follow-up\n" })
    for (const option of ["workspace", "modelid", "mcp-config", "system-tools", "isolate", "timeout", "outputjson"]) {
      assert.throws(() => readContinueInput([...continuation, "--" + option, "x"]), /未知参数/)
    }
    assert.throws(() => readContinueInput(["continue", "--session-id", "../other", "--prompt", "x"]), /UUID/)
    assert.throws(() => readContinueInput([...continuation, "--prompt", "duplicate"]), /重复/)

    const nested = join(root, "nested")
    await mkdir(nested)
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: [] }))
    const selected = await readCliInput(["run", "--prompt=--literal task", "--workspace", "nested", "--output", "answer",
      "--supportreason=false", "--restrict-system-tools=true", "--system-tools", "read, glob,read",
      "--use-configured-mcp", "false", "--sandbox-mode", "auto", "--auto-approve-groups", "file,skill",
      "--auto-approve-tools", "read", "--isolate", "skill,memory", "--max-steps", "5", "--timeout", "20",
      "--reasoning-level", "high", "--mcp-config", "mcp.json", "--outputjson=summary.json"], root)
    assert.equal(selected.output, join(root, "answer"))
    assert.equal(selected.outputJson, join(root, "summary.json"))
    assert.equal(selected.request.prompt, "--literal task")
    assert.equal(selected.request.workspace, nested)
    assert.equal(selected.request.supportsReasoning, false)
    assert.equal(selected.request.reasoningLevel, "high")
    assert.equal(selected.request.restrictSystemTools, true)
    assert.deepEqual(selected.request.systemTools, ["read", "glob"])
    assert.equal(selected.request.useConfiguredMcp, false)
    assert.equal(selected.request.sandboxMode, "auto")
    assert.deepEqual(selected.request.isolated, { skill: true, memory: true, mcp: false })
    assert.deepEqual(selected.request.approveGroups, ["file", "skill"])
    assert.deepEqual(selected.request.approveTools, ["read"])
    assert.equal(selected.request.maxSteps, 5)
    assert.equal(selected.request.timeoutSeconds, 20)
    assert.deepEqual(selected.request.mcpServers, [])

    for (const args of [["run"], ["benchmark"], ["run", "--prompt", " "]]) {
      await assert.rejects(readCliInput(args, root))
    }
    for (const args of [
      ["--request", "task.json"], ["--prompt-file", "task.txt"], ["--run-id", "abc"], ["--version", "1"],
      ["--model", "model"], ["--format", "jsonl"], ["--bad", "x"], ["--output", "a", "--output", "b"],
      ["--restrict-system-tools", "yes"], ["--use-configured-mcp", "0"], ["--supportreason", "1"],
      ["--system-tools", "read,,glob"], ["--isolate", "unknown"], ["--sandbox-mode", "invalid"],
      ["--auto-approve-groups", "mcp_*"], ["--max-steps", "0"], ["--max-steps", "1.5"],
      ["--outputjson"], ["--outputjson", "a", "--outputjson", "b"], ["--output", "answer", "--outputjson", "./answer"],
      ["--timeout", "2147484"], ["--workspace", "missing"], ["--isolate", "mcp", "--mcp-config", "mcp.json"],
    ]) await assert.rejects(readCliInput(["run", "--prompt", "task", ...args], root), args.join(" "))

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
    assert.equal(state.turns, 0)
    observeEvent(state, event({ type: "turn/start" }))
    observeEvent(state, event({ type: "step/start" }))
    observeEvent(state, event({ type: "assistant/block_end", block: { type: "tool_call" } }))
    observeEvent(state, event({ type: "assistant/message", message: { content: [{ type: "thinking", text: "private" }, { type: "text", text: "first" }] }, usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3 } }))
    observeEvent(state, event({ type: "assistant/message", message: { content: [{ type: "text", text: "last" }] }, usage: { inputTokens: 6, outputTokens: 5 } }))
    assert.equal(state.steps, 1)
    assert.equal(state.turns, 1)
    assert.equal(state.toolCalls, 1)
    assert.equal(state.answer, "last")
    assert.deepEqual(mapUsage(state.usage), { input_tokens: 6, output_tokens: 5 })
    observeEvent(state, event({ type: "assistant/message", message: { content: [{ type: "text", text: "without usage" }] } }))
    assert.deepEqual(mapUsage(state.usage), { input_tokens: 6, output_tokens: 5 })
    assert.equal(state.reportedUsage, 2)
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
    const target = join(root, "answer.data")
    await writeFile(target, "old-result")
    await writeOutputFile(target, "  第一行\n第二行\n")
    assert.equal(await readFile(target, "utf8"), "  第一行\n第二行\n")
    await assert.rejects(writeOutputFile(nested, "cannot replace directory"))
    assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false)
    console.log("CLI protocol: passed")
  } finally { await rm(root, { recursive: true, force: true }) }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
