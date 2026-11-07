import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { createFileSessionEventLog } from "../src/event-log.ts"
import { createFileSessionState } from "../src/session-state.ts"
import type { SessionContextState, SessionMeta } from "../src/session-state.ts"
import { readSessionMeta, saveSessionMeta, updateSessionMetaName } from "../src/meta-store.ts"
import type { ModelRef } from "../../model/src/types.ts"
import type { SessionLoadedMCPTool } from "../../mcp/src/types.ts"

/**
 * 依次执行当前文件的持久化与恢复场景，并按现有清理流程释放临时资源。
 * @returns MCP Meta、派生文件和设置并发更新验证完成。
 * @throws AssertionError 状态或恢复行为偏离契约。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-mcp-state-"))
  try {
    const paths = await initializeConfigFiles(root)
    const sessionDirectory = join(paths.rootDir, "sessions", "default", "mcp-state")
    await mkdir(sessionDirectory)
    const databasePath = join(paths.rootDir, "events.sqlite")
    const model: ModelRef = { modelId: "one", providerId: "p", name: "model", protocol: "responses", reasoningLevel: "medium" }
    const log = createFileSessionEventLog({ projectGroupId: "default", sessionId: "mcp-state", sessionDirectory, databasePath })
    await log.appendTurnStartAndUserMessage([{ type: "turn/start", turn: 1, model }, { type: "user/message", turn: 1, message: { id: "u", role: "user", content: [{ type: "text", text: "test" }] } }])
    const options = { projectId: "default" as const, sessionId: "mcp-state", sessionDirectory, databasePath, metaDatabasePath: paths.metaDatabasePath,
      readEvents: log.readEvents, estimateSkillTokens: (text: string) => text.length,
      resolveCurrentBaseline: async () => ({ agentsmd: { path: join(root, "AGENTS.md"), hash: "hash", content: "rules" }, skills: { content: "", entries: [], descriptions: {} }, mcp: [] }) }
    const state = createFileSessionState(options)
    const invalidBaseline = createFileSessionState({ ...options, resolveCurrentBaseline: async () => ({ ...await options.resolveCurrentBaseline(), additionalMeta: { loadedMcpTools: [{ name: "incomplete" }] } }) })
    await assert.rejects(invalidBaseline.initializeSession(), /loadedMcpTools 无效/)
    assert.equal(readSessionMeta(paths.metaDatabasePath, "default", "mcp-state"), undefined)
    await state.initializeSession()
    assert.deepEqual(await state.readLoadedMCPTools(), [])
    const entry: SessionLoadedMCPTool = { name: "mcp_s_t", serverId: "s", originalToolName: "t", estimatedTokens: 10, lastCalledAt: 0 }
    const definitions = [{ name: entry.name, description: "test", inputSchema: { type: "object", properties: {} } }]
    updateSessionMetaName(paths.metaDatabasePath, "default", "mcp-state", "保持名称")
    const [added] = await log.appendMcpToolChanges([{ type: "mcp/tools_added", turn: 1, step: 1,
      toolCallEventId: "call", tools: [{ entry, definition: definitions[0] }] }])
    await Promise.all([state.writeLoadedMCPTools([entry], added.seq), state.writeSettings({ sandboxMode: "full-access" })])
    let meta = readSessionMeta(paths.metaDatabasePath, "default", "mcp-state") as SessionMeta
    assert.equal(meta.name, "保持名称"); assert.equal(meta.sandboxMode, "full-access"); assert.deepEqual(meta.currentModel, model)
    assert.deepEqual(meta.loadedMcpTools, [entry]); assert.equal(meta.usage.inputTokens, 0)
    const copy = await state.readLoadedMCPTools(); copy[0].lastCalledAt = 123
    assert.equal((await state.readLoadedMCPTools())[0].lastCalledAt, 0)
    const contextPath = join(sessionDirectory, "contextstate.json")
    const context = JSON.parse(await readFile(contextPath, "utf8")) as SessionContextState
    assert.deepEqual(context.mcp, [])
    await state.writeLoadedMCPTools([{ ...entry, lastCalledAt: 123 }])
    const next = { ...entry, name: "mcp_s_other", originalToolName: "other" }
    const evicted = { ...entry, name: "mcp_s_evicted", originalToolName: "evicted" }
    const [loadedEvicted] = await log.appendMcpToolChanges([{ type: "mcp/tools_added", turn: 1, step: 1,
      toolCallEventId: "preload", tools: [{ entry: evicted, definition: { ...definitions[0], name: evicted.name } }] }])
    await state.writeLoadedMCPTools([{ ...entry, lastCalledAt: 123 }, evicted], loadedEvicted.seq)
    const [removed, addedNext] = await log.appendMcpToolChanges([
      { type: "mcp/tools_removed", turn: 1, step: 2, toolCallEventId: "second", toolNames: [evicted.name] },
      { type: "mcp/tools_added", turn: 1, step: 2, toolCallEventId: "second",
        tools: [{ entry: next, definition: { ...definitions[0], name: next.name } }] },
    ])
    assert.equal(removed.seq + 1, addedNext.seq)
    const restored = createFileSessionState(options)
    await restored.initializeSession()
    await restored.repairDerivedState(await log.readEvents() as import("../src/events.ts").SessionEvent[])
    assert.deepEqual(await restored.readLoadedMCPTools(), [{ ...entry, lastCalledAt: 123 }, next])
    assert.equal((readSessionMeta(paths.metaDatabasePath, "default", "mcp-state") as SessionMeta).loadedMcpToolsSeq, addedNext.seq)
    assert.deepEqual(JSON.parse(await readFile(contextPath, "utf8")), context)
    const baseline = { ...await options.resolveCurrentBaseline(), mcp: [definitions[0], { ...definitions[0], name: next.name }] }
    await log.appendEvent({ type: "summary/end", turn: 1, summaryId: "summary", summary: "compacted",
      fromEventSeq: 1, throughEventSeq: addedNext.seq, baseline })
    await writeFile(contextPath, JSON.stringify(context))
    await restored.repairDerivedState(await log.readEvents() as import("../src/events.ts").SessionEvent[])
    assert.deepEqual(JSON.parse(await readFile(contextPath, "utf8")).mcp, baseline.mcp)
    await assert.rejects(state.writeLoadedMCPTools([{ ...entry, estimatedTokens: -1 }]), /更新无效/)
    await assert.rejects(state.writeLoadedMCPTools([entry, entry]), /更新无效/)
    meta = readSessionMeta(paths.metaDatabasePath, "default", "mcp-state") as SessionMeta
    saveSessionMeta(paths.metaDatabasePath, { ...meta, loadedMcpTools: [{ ...entry, lastCalledAt: -1 }] })
    await assert.rejects(state.readLoadedMCPTools(), /Session MCP 状态无效/)
    assert.equal((readSessionMeta(paths.metaDatabasePath, "default", "mcp-state") as SessionMeta).loadedMcpTools![0].lastCalledAt, -1, "读取失败不能覆盖损坏数据")
    console.log("mcp-state.test.ts: Session MCP 串行持久化、隔离更新和中断恢复通过")
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
