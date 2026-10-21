import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import type { ModelAdapter, ModelRef, UnifiedToolDefinition } from "../../model/src/types.ts"
import type { SessionEvent } from "../../session/src/events.ts"
import type { SessionMeta } from "../../session/src/session-state.ts"
import { readSessionMeta } from "../../session/src/meta-store.ts"
import { RenderRegistry, ToolRegistry } from "../../tools/src/index.ts"
import { SessionRuntime } from "../src/session-runtime.ts"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import { createMCPTestServer, testTool } from "../../mcp/test/helpers.ts"

const MODEL: ModelRef = { providerId: "offline", protocol: "responses", modelId: "offline", name: "Offline" }
const MESSAGE = [{ type: "text" as const, text: "测试 MCP" }]

/**
 * 从真正 Session、模型请求、审批事件到真实本地 MCP SDK 调用的完整链路。
 * @returns 新建、Queue、Continue、跨 Session 隔离和派生状态恢复验证完成。
 * @throws AssertionError 数据流、状态或调用事件偏离契约。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-mcp-turn-"))
  const fixture = await createMCPTestServer([testTool("send_event", "calendar schedule event")])
  const paths = await initializeConfigFiles(root)
  const tools = new ToolRegistry(), renders = new RenderRegistry()
  const global = new SessionRuntimeGlobal(paths, tools, renders)
  await global.mcpManager.initialize([{ name: "calendar", enabled: true, transport: "streamable-http", url: fixture.url }])
  const name = global.mcpManager.listTools()[0].name
  const dir = join(paths.rootDir, "sessions", "default", "mcp-session")
  let adapterCount = 0
  let firstRequest!: () => void, release!: () => void
  const requested = new Promise<void>((done) => { firstRequest = done })
  const gate = new Promise<void>((done) => { release = done })
  const visible: string[][] = []
  global.createTurnModelAdapter = async (): Promise<ModelAdapter> => {
    const turn = ++adapterCount
    let step = 0
    return { contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (request) {
      step++
      const names = request.tools?.map((tool) => tool.name) ?? []
      visible.push(names)
      if (turn === 1 && step === 1) {
        assert.equal(names.includes(name), false, "启动时不能暴露完整 Catalog")
        firstRequest(); await gate
      }
      let call: { name: string; arguments: Record<string, unknown> } | undefined
      if (turn === 1 && step === 1) call = { name: "tool_search", arguments: { query: "unmatchedword" } }
      else if (turn === 1 && step === 2) {
        assert.equal(names.includes(name), false)
        assert.match(JSON.stringify(request.context.messages.at(-1)), /Loaded 0 tools/)
        call = { name: "mcp_list_tools", arguments: {} }
      } else if (turn === 1 && step === 3) {
        assert.match(JSON.stringify(request.context.messages.at(-1)), /Server ID: calendar/)
        call = { name: "mcp_load_tools", arguments: { names: [name] } }
      } else if ((turn === 1 && step === 4) || (turn > 1 && step === 1)) {
        assert.equal(names.includes(name), true, "下一 Step、Queue 和 Continue 均应看到已载入工具")
        assert.ok(request.tools?.find((tool) => tool.name === name)?.inputSchema.properties)
        call = { name, arguments: { value: `turn-${turn}`, callDescription: "执行日历工具" } }
      }
      if (call) {
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: `turn-${turn}-step-${step}`, ...call } }
        yield { type: "stream_end", completion: "tool_calls" }
      } else {
        assert.equal(request.context.messages.at(-1)?.role, "tool")
        assert.equal(JSON.stringify(request.context.messages.at(-1)).includes(`turn-${turn}`), true)
        yield { type: "stream_end", completion: "finished" }
      }
    } }
  }
  /** @returns 同一 Session 的新活动实例；持久化状态不由实例缓存。 */
  const createRuntime = () => new SessionRuntime({ projectGroupId: "default", sessionId: "mcp-session", sessionDirectory: dir,
    databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "offline", global })
  const initial = createRuntime()
  let resumed: SessionRuntime | undefined
  try {
    const started = await initial.startNewSession({ content: MESSAGE, model: MODEL, sandboxMode: "sandbox-read-only" })
    const processing = initial.processMessageQueue(started)
    await requested
    initial.enqueueSessionMessage({ content: MESSAGE })
    release()
    /** 已有审批出口处理真实远程调用；发现与载入不产生审批。 */
    const approve = async (runtime: SessionRuntime) => {
      for await (const event of runtime.events) {
        if (event.type === "approval/request") assert.equal(await runtime.decideApproval(event.approvalId, "approved"), true)
      }
    }
    const approvals = approve(initial)
    await processing.completion
    initial.close(); await approvals
    assert.equal(adapterCount, 2)
    assert.equal(fixture.state.calls.length, 2)
    const meta = readSessionMeta(paths.metaDatabasePath, "default", "mcp-session") as SessionMeta
    assert.equal(meta.loadedMcpTools?.length, 1)
    assert.ok(meta.loadedMcpTools![0].lastCalledAt > 0)
    const statePath = join(dir, "contextstate.json")
    const state = JSON.parse(await readFile(statePath, "utf8")) as { mcp: UnifiedToolDefinition[] }
    assert.equal(state.mcp[0].name, name)
    // 模拟 Meta 提交后 contextstate 写入中断：恢复必须使用 Meta 身份和当前 Catalog。
    await writeFile(statePath, JSON.stringify({ ...state, mcp: [] }))
    resumed = createRuntime()
    const approvalResume = approve(resumed)
    const continued = await resumed.continueSession({ content: MESSAGE, model: MODEL })
    await continued.completion
    assert.equal(continued.turn, 3)
    const events = await resumed.readEvents() as readonly SessionEvent[]
    assert.equal(events.filter((event) => event.type === "approval/request").length, 3)
    const results = events.filter((event) => event.type === "tool/result")
    assert.equal(results.length, 6)
    for (const result of results) {
      assert.equal(result.result.status, "success")
      const call = events.find((event) => event.eventId === result.toolCallEventId)
      assert.ok(call?.type === "assistant/block_end" && call.block.type === "tool_call")
      assert.equal(call.block.toolCallId, result.toolCallId)
      assert.equal(call.blockId, result.blockId)
    }
    assert.equal(fixture.state.calls.every((call) => !Object.hasOwn(call.arguments!, "callDescription")), true)
    assert.equal((JSON.parse(await readFile(statePath, "utf8")) as { mcp: UnifiedToolDefinition[] }).mcp[0].name, name)
    assert.equal(global.listToolDefinitions().some((tool) => tool.name === name), false, "全局基础工具列表不能泄露其他 Session 的载入工具")
    resumed.close(); await approvalResume
    assert.equal(visible.length, 9)
    console.log("mcp-turn.test.ts: 逐 Step 暴露、fallback、Queue、Continue、审批和状态恢复通过")
  } finally {
    initial.close(); resumed?.close(); await global.disposeProcessTools(); await fixture.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
