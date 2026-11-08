import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { MCPManager } from "../src/index.ts"
import type { SessionLoadedMCPTool } from "../src/types.ts"
import { checkConfig } from "../../../src/main/config-schema.ts"
import { createExecuteToolCall, registerMCPTools, ToolRegistry, RenderRegistry } from "../../tools/src/index.ts"
import type { ToolCallContext, MCPToolRuntimeContext } from "../../tools/src/types.ts"
import type { SandboxMode } from "../../session/src/session-state.ts"
import { renderMCPResult, MCP_NON_TEXT_FALLBACK } from "../../tools/src/render/mcp.ts"
import { createMCPTestServer, testTool, eventually } from "./helpers.ts"

/** @param server MCP 配置项。 @returns 测试用完整 V2 配置。 */
function config(server: Record<string, unknown>) { return { version: 2, mcpServers: [server], runtime: { userMessageMode: "queue" } } }

/** 正常配置、超时边界、URL、旧字段及重复鉴权均在启动校验处决定。 */
function testConfig(): void {
  const base = { name: "remote", enabled: true, transport: "streamable-http", url: "https://example.com/mcp" }
  checkConfig(config({ ...base, http_headers: { "X-Test": "value" }, startup_timeout_sec: 0.1, tool_timeout_sec: 20 }))
  checkConfig(config({ name: "stdio", enabled: true, transport: "stdio", command: "node", args: [], env: { A: "" }, cwd: "relative" }))
  for (const extra of [{ headers: {} }, { startup_timeout_sec: 0 }, { tool_timeout_sec: -1 }, { tool_timeout_sec: Infinity }, { tool_timeout_sec: 3e10 }, { url: "relative" }, { url: "file:///tmp/mcp" }, { bearer_token_env_var: "TOKEN", http_headers: { aUtHoRiZaTiOn: "x" } }]) {
    assert.throws(() => checkConfig(config({ ...base, ...extra })))
  }
}

/** HTTP 真实 SDK、分页、检索、预算、动态目录、权限、取消和原始结果。 */
async function testHTTP(): Promise<void> {
  const fixture = await createMCPTestServer(Array.from({ length: 12 }, (_, index) => testTool(`event_${index}`)))
  fixture.state.pageSize = 2
  const manager = new MCPManager(() => 10)
  const tools = new ToolRegistry(), renders = new RenderRegistry()
  registerMCPTools(tools, renders, manager)
  const execute = createExecuteToolCall(tools, renders)
  let loaded: SessionLoadedMCPTool[] = [], mode: SandboxMode = "full-access", approvals = 0
  let decision: "approved" | "denied" | "cancelled" = "approved"
  const runtime: MCPToolRuntimeContext = {
    projectId: "default", sessionId: "test", contextWindow: 1000,
    readLoadedTools: async () => structuredClone(loaded),
    writeLoadedTools: async (value) => { loaded = structuredClone(value) },
    readSandboxMode: async () => mode,
    requestApproval: async () => { approvals++; return decision },
  }
  const context: ToolCallContext = { turn: 1, step: 1, blockId: "b", toolCallId: "c", signal: new AbortController().signal, mcpRuntime: runtime }
  process.env.MCP_TEST_TOKEN = "fixture-private-value"
  try {
    await manager.initialize([{ name: "calendar", enabled: true, transport: "streamable-http", url: fixture.url, bearer_token_env_var: "MCP_TEST_TOKEN", http_headers: { "X-Custom-Header": "fixture" }, tool_timeout_sec: 0.05 }])
    assert.equal(manager.getConnectionStates()[0].status, "connected")
    assert.equal(manager.listTools().length, 12)
    assert.ok(fixture.state.headers.some((headers) => headers.authorization === "Bearer fixture-private-value" && headers["x-custom-header"] === "fixture"))
    const names = manager.listTools().map((tool) => tool.name)
    assert.ok(names.every((name) => /^mcp_[a-zA-Z0-9_-]+$/.test(name) && name.length <= 64))
    assert.equal(manager.searchTools("calendar").length, 8)
    assert.equal(manager.searchTools("event_11")[0], names[11])
    assert.deepEqual(manager.searchTools("schemaOnlySecretWord"), [])
    assert.deepEqual(manager.searchTools("unmatchedxyz"), [])
    assert.match(tools.get("tool_search")!.definition.description!, /Prefer tool_search/)
    assert.match(tools.get("mcp_list_tools")!.definition.description!, /mcp_load_tools/)
    assert.match(JSON.stringify(await execute("mcp_list_tools", {}, context)), /Server ID: calendar/)
    assert.equal((await execute("tool_search", { query: " " }, context)).status, "error")
    assert.match(JSON.stringify(await execute("mcp_load_tools", { names: [] }, context)), /Loaded 0 MCP tools/)
    assert.match(JSON.stringify(await execute("mcp_load_tools", { names: [names[0], names[0], "missing"] }, context)), /Loaded 1 MCP tools/)
    assert.match(JSON.stringify(await execute("mcp_load_tools", { names: [names[0]] }, context)), /Loaded 0 MCP tools/)
    assert.equal(loaded[0].lastCalledAt, 0)
    const remoteDefinition = manager.getTool(names[0])!.definition
    assert.deepEqual(manager.exposeDefinition(remoteDefinition), remoteDefinition)
    assert.equal("callDescription" in (manager.exposeDefinition(remoteDefinition).inputSchema.properties as object), false)
    assert.equal((await execute(names[0], { value: 1 }, context)).status, "error")
    assert.equal(fixture.state.calls.length, 0)
    assert.equal((await execute(names[0], { value: "ok" }, context)).status, "success")
    assert.deepEqual(fixture.state.calls[0].arguments, { value: "ok" })
    assert.ok(loaded[0].lastCalledAt > 0)
    assert.equal(approvals, 0)
    const other = { ...context, mcpRuntime: { ...runtime, readLoadedTools: async () => [] } }
    assert.equal((await execute(names[0], { value: "ok" }, other)).status, "error")
    for (const sandbox of ["sandbox-full-access", "sandbox-read-only"] as const) {
      mode = sandbox; decision = "denied"
      assert.equal((await execute(names[0], { value: "ok" }, context)).status, "error")
      decision = "approved"
      assert.equal((await execute(names[0], { value: "ok" }, context)).status, "success")
    }
    assert.equal(approvals, 4)
    mode = "full-access"
    const before = fixture.state.calls.length
    const cancelled = new AbortController(); cancelled.abort()
    assert.equal((await execute(names[0], { value: "ok" }, { ...context, signal: cancelled.signal })).status, "error")
    assert.equal(fixture.state.calls.length, before)
    fixture.state.call = async () => new Promise(() => {})
    assert.match(JSON.stringify(await execute(names[0], { value: "ok" }, context)), /MCP_TOOL_TIMEOUT/)
    const pendingAbort = new AbortController()
    const pending = execute(names[0], { value: "ok" }, { ...context, signal: pendingAbort.signal })
    await eventually(() => fixture.state.calls.length === before + 2)
    pendingAbort.abort()
    assert.match(JSON.stringify(await pending), /CANCELLED/)
    fixture.state.call = async () => ({ isError: true, content: [{ type: "text", text: "remote failure" }, { type: "image", data: "AA==", mimeType: "image/png" }], _meta: { hidden: true } })
    const business = await execute(names[0], { value: "ok" }, context)
    assert.equal(business.status, "error")
    assert.deepEqual(business.content, [{ type: "text", text: "remote failure" }])
    assert.match(JSON.stringify(business), /MCP_TOOL_CALL_ERROR/)

    const previous = manager.loadTools(names.slice(0, 3), [], 1000).loaded.map((entry, index) => ({ ...entry, lastCalledAt: index === 0 ? 100 : index === 1 ? 0 : 200 }))
    const budget = manager.loadTools([names[3]], previous, 600)
    assert.deepEqual(budget.loaded.map((entry) => entry.name), [names[0], names[2], names[3]])
    assert.deepEqual(budget.removed, [names[1]])
    assert.deepEqual(budget.added.map(({ entry, definition }) => [entry.name, definition.name]), [[names[3], names[3]]])
    const repeated = manager.loadTools([names[3], names[3]], budget.loaded, 600)
    assert.equal(repeated.loadedCount, 0, "刷新不重复计算新载入数量")
    assert.deepEqual(repeated.loaded, budget.loaded, "刷新保留预算和最近调用记录")
    assert.deepEqual(repeated.added.map(({ entry, definition }) => [entry.name, definition.name]), [[names[3], names[3]]])
    assert.deepEqual(repeated.removed, [])
    assert.equal(manager.loadTools(names.slice(3, 8), previous, 200).loaded.length, 8, "单批超预算仍保留旧工具并整批载入")
    assert.equal(manager.loadTools([names[3]], [{ ...previous[0], serverId: "invalid" }], 600).loaded.length, 1)

    // 审批期间更新 Schema，不能用审批前的旧参数定义发送请求。
    mode = "sandbox-read-only"
    const approval = runtime.requestApproval
    runtime.requestApproval = async () => {
      fixture.state.tools[0] = { ...testTool("event_0"), inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } }
      await fixture.notify()
      await eventually(() => (manager.getTool(names[0])!.definition.inputSchema.properties as Record<string, { type: string }>).value.type === "integer")
      return "approved"
    }
    const beforeSchemaChange = fixture.state.calls.length
    assert.match(JSON.stringify(await execute(names[0], { value: "old-schema" }, context)), /INVALID_TOOL_ARGUMENTS/)
    assert.equal(fixture.state.calls.length, beforeSchemaChange)
    runtime.requestApproval = approval
    mode = "full-access"

    fixture.state.failList = true
    await fixture.notify()
    await eventually(() => manager.getConnectionStates()[0].error?.code === "MCP_CATALOG_REFRESH_FAILED")
    assert.equal(manager.listTools().length, 12)
    fixture.state.failList = false
    fixture.state.tools = [testTool("only_remaining", "unique descriptionsignal")]
    await fixture.notify()
    await eventually(() => manager.listTools().length === 1)
    assert.deepEqual(manager.getDefinitions(loaded), [])
    assert.equal(tools.has(names[0]), false)
    assert.equal(renders.has(names[0]), false)
    assert.equal(manager.searchTools("descriptionsignal").length, 1, "单工具目录也可检索")
    assert.equal(manager.searchTools("only_remaining").length, 1)
    const search = await execute("tool_search", { query: "descriptionsignal" }, context)
    assert.match(JSON.stringify(search), /Loaded 1 tools/)
    assert.equal(JSON.stringify(manager.getConnectionStates()).includes("fixture-private-value"), false)
  } finally { delete process.env.MCP_TEST_TOKEN; await manager.dispose(); await manager.dispose(); await fixture.close() }
}

/** STDIO 的真实子进程、环境边界和退出资源清理。 */
async function testStdio(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "nicode-mcp-"))
  const manager = new MCPManager((text) => Math.ceil(text.length / 4))
  process.env.MCP_INHERITED = "must-not-inherit"
  try {
    await manager.initialize([{ name: "stdio", transport: "stdio", enabled: true, command: process.execPath,
      args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", resolve("runtime/mcp/test/stdio-server.ts")], cwd, env: { MCP_EXPLICIT: "explicit" } }])
    assert.equal(manager.getConnectionStates()[0].status, "connected")
    const name = manager.listTools()[0].name
    const loaded = manager.loadTools([name], [], 10000).loaded
    const result = await manager.executeMCPTool(name, {}, { turn: 1, step: 1, blockId: "b", toolCallId: "c", validatedArguments: {}, signal: new AbortController().signal,
      mcpRuntime: { projectId: "default", sessionId: "stdio", contextWindow: 10000, readLoadedTools: async () => loaded, writeLoadedTools: async () => {}, readSandboxMode: async () => "full-access", requestApproval: async () => { throw new Error("不应审批") } } })
    assert.ok("result" in result)
    if ("result" in result) {
      const raw = result.result as { content: Array<{ text: string }> }
      const env = JSON.parse(raw.content[0].text) as Record<string, unknown>
      assert.equal(env.cwd, cwd); assert.equal(env.explicit, "explicit"); assert.equal(env.inherited, undefined); assert.equal(env.path, true)
    }
  } finally { delete process.env.MCP_INHERITED; await manager.dispose(); await rm(cwd, { recursive: true, force: true }) }
  assert.deepEqual(manager.listTools(), [])
  assert.equal(manager.getConnectionStates()[0].status, "disconnected")
}

/** 禁用、同名覆盖、无 tools 能力、初始化超时与单 Server 失败隔离。 */
async function testFailures(): Promise<void> {
  const fixture = await createMCPTestServer([testTool("one"), testTool("two")])
  const noTools = await createMCPTestServer([], false)
  const manager = new MCPManager(() => 1)
  try {
    await manager.initialize([
      { name: "duplicate", transport: "stdio", enabled: true, command: "this-process-must-not-start" },
      { name: "duplicate", transport: "streamable-http", enabled: true, url: fixture.url },
      { name: "disabled", transport: "stdio", enabled: false, command: "this-process-must-not-start" },
      { name: "missing", transport: "streamable-http", enabled: true, url: fixture.url, bearer_token_env_var: "MCP_UNSET_FIXTURE_TOKEN" },
      { name: "no-tools", transport: "streamable-http", enabled: true, url: noTools.url },
    ])
    assert.equal(manager.listTools().length, 2, "两个文档的目录可建立索引")
    assert.equal(manager.searchTools("one").length, 1)
    assert.equal(manager.getConnectionStates().length, 3)
    assert.equal(manager.getConnectionStates().find((state) => state.name === "missing")?.status, "error")
    assert.equal(manager.getConnectionStates().find((state) => state.name === "no-tools")?.status, "connected")
  } finally { await manager.dispose(); await fixture.close(); await noTools.close() }
  const slow = await createMCPTestServer([testTool("slow")])
  slow.state.listDelay = 100
  const timed = new MCPManager(() => 1)
  try {
    await timed.initialize([{ name: "slow", enabled: true, transport: "streamable-http", url: slow.url, startup_timeout_sec: 0.02 }])
    assert.equal(timed.getConnectionStates()[0].error?.code, "MCP_STARTUP_TIMEOUT")
    assert.deepEqual(timed.listTools(), [])
  } finally { await timed.dispose(); await slow.close() }
}

/** 纯 render 保留文本、业务失败和非文本兜底。 */
function testRender(): void {
  for (const content of [[], [{ type: "image", data: "AA==", mimeType: "image/png" }], [{ type: "resource", resource: { uri: "x:test", text: "hidden" } }]]) {
    assert.deepEqual(renderMCPResult({ serverId: "s", rawToolName: "t", result: { content } }).content, [{ type: "text", text: MCP_NON_TEXT_FALLBACK }])
  }
  assert.deepEqual(renderMCPResult({ source: "mcp", code: "X", message: "fixed" }).content, [{ type: "text", text: "X: fixed" }])
}

/** @returns 本地 MCP 管理、调用与配置断言完成。 @throws AssertionError 行为偏离契约。 */
async function main(): Promise<void> { testConfig(); testRender(); await testHTTP(); await testStdio(); await testFailures(); console.log("manager.test.ts: MCP 配置、SDK 传输、搜索、预算、审批和取消通过") }
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
