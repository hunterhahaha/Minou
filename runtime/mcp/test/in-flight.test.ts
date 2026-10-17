/** 配置变更立即中断外部调用，并在审批/持久化让出执行权后阻止旧连接发送。 */
import assert from "node:assert/strict"
import { MCPManager } from "../src/manager.ts"
import type { MCPConfig, SessionLoadedMCPTool } from "../src/types.ts"
import { createExecuteToolCall, registerMCPTools, ToolRegistry, RenderRegistry } from "../../tools/src/index.ts"
import type { MCPToolRuntimeContext, ToolCallContext } from "../../tools/src/types.ts"
import { createReloadableServer } from "./reloadable-server.ts"
import { eventually, testTool } from "./helpers.ts"

/** @returns 进行中、等待审批、持久化间隙以及初始化期间退出的验证完成。 */
async function main(): Promise<void> {
  const fixture = await createReloadableServer([testTool("sample")])
  const manager = new MCPManager(() => 1)
  const tools = new ToolRegistry(), renders = new RenderRegistry()
  registerMCPTools(tools, renders, manager)
  const execute = createExecuteToolCall(tools, renders)
  const config: MCPConfig = { name: "remote", enabled: true, transport: "streamable-http", url: fixture.url }
  let loaded: SessionLoadedMCPTool[] = []
  const runtime: MCPToolRuntimeContext = {
    projectId: "default", sessionId: "test", contextWindow: 1000,
    readLoadedTools: async () => loaded,
    writeLoadedTools: async (next) => { loaded = next },
    readSandboxMode: async () => "full-access", requestApproval: async () => "approved",
  }
  const context: ToolCallContext = { turn: 1, step: 1, blockId: "b", toolCallId: "c", signal: new AbortController().signal, mcpRuntime: runtime }
  let releaseCall: (() => void) | undefined, releaseWrite: (() => void) | undefined
  let releaseApproval: (() => void) | undefined, releaseList: (() => void) | undefined
  try {
    await manager.initialize([config])
    const name = manager.listTools()[0].name
    loaded = manager.loadTools([name], [], 1000).loaded
    fixture.state.callGate = new Promise<void>((resolve) => { releaseCall = resolve })
    const calling = execute(name, { value: "before" }, context)
    await eventually(() => fixture.state.calls === 1)
    await manager.applyConfigurations([{ ...config, tool_timeout_sec: 2 }])
    assert.equal((await calling).status, "error")
    assert.equal(fixture.state.calls, 1, "重连不能自动重放原调用")
    releaseCall!(); fixture.state.callGate = undefined
    assert.equal((await execute(name, { value: "after" }, context)).status, "success")

    let writing = false
    const persist = runtime.writeLoadedTools
    runtime.writeLoadedTools = async (...args) => { writing = true; await new Promise<void>((resolve) => { releaseWrite = resolve }); await persist(...args) }
    const beforeWrite = fixture.state.calls
    const waitingWrite = execute(name, { value: "unsent" }, context)
    await eventually(() => writing)
    await manager.applyConfigurations([{ ...config, tool_timeout_sec: 3 }])
    releaseWrite!()
    assert.match(JSON.stringify(await waitingWrite), /MCP_TOOL_UNAVAILABLE/)
    assert.equal(fixture.state.calls, beforeWrite)
    runtime.writeLoadedTools = persist

    let approving = false
    runtime.readSandboxMode = async () => "sandbox-read-only"
    runtime.requestApproval = async () => { approving = true; await new Promise<void>((resolve) => { releaseApproval = resolve }); return "approved" }
    const waitingApproval = execute(name, { value: "old schema" }, context)
    await eventually(() => approving)
    fixture.state.tools = [{ ...testTool("sample"), inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } }]
    await manager.applyConfigurations([{ ...config, tool_timeout_sec: 4 }])
    releaseApproval!()
    assert.match(JSON.stringify(await waitingApproval), /INVALID_TOOL_ARGUMENTS/)
    assert.equal(fixture.state.calls, beforeWrite)

    const beforeList = fixture.state.lists
    fixture.state.listGate = new Promise<void>((resolve) => { releaseList = resolve })
    const initializing = manager.applyConfigurations([{ ...config, tool_timeout_sec: 5 }])
    await eventually(() => fixture.state.lists > beforeList)
    await manager.dispose()
    releaseList!()
    await initializing
    assert.deepEqual(manager.listTools(), [])
    assert.ok(manager.getConnectionStates().every((state) => state.status === "disconnected"))
    console.log("in-flight.test.ts: 立即中断、不重放、持久化/审批间隙重新校验、初始化退出通过")
  } finally {
    releaseCall?.(); releaseWrite?.(); releaseApproval?.(); releaseList?.()
    await manager.dispose(); await fixture.close()
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
