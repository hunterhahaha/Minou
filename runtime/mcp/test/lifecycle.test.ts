/** MCP 配置热更新、完整重载与旧连接异步回写的真实 SDK 回归测试。 */
import assert from "node:assert/strict"
import { MCPManager } from "../src/manager.ts"
import type { MCPConfig, MCPConnection } from "../src/types.ts"
import { registerMCPTools, ToolRegistry, RenderRegistry } from "../../tools/src/index.ts"
import { createReloadableServer } from "./reloadable-server.ts"
import { eventually, testTool } from "./helpers.ts"

/**
 * 验证连接次数、目录、注册表及旧异步通知，独立服务不依赖公网。
 * @returns 所有生命周期场景验证完成。
 */
async function main(): Promise<void> {
  const first = await createReloadableServer([testTool("old_tool")])
  const other = await createReloadableServer([testTool("other_tool")])
  const manager = new MCPManager(() => 1)
  const tools = new ToolRegistry(), renders = new RenderRegistry()
  registerMCPTools(tools, renders, manager)
  const a: MCPConfig = { name: "a", enabled: true, transport: "streamable-http", url: first.url }
  const b: MCPConfig = { name: "b", enabled: true, transport: "streamable-http", url: other.url }
  let releaseList: (() => void) | undefined
  try {
    await manager.initialize([a, b])
    assert.equal(first.state.starts, 1)
    assert.equal(other.state.starts, 1)
    const old = manager.listTools().find((tool) => tool.serverId === "a")!.name
    const loaded = manager.loadTools([old], [], 1000).loaded
    assert.ok(tools.get(old)); assert.ok(renders.get(old))

    first.state.tools = [testTool("new_tool")]
    await manager.applyConfigurations([{ ...a, tool_timeout_sec: 3 }, b])
    assert.equal(first.state.starts, 2)
    assert.equal(other.state.starts, 1, "未变化的 Server 不得重新连接")
    assert.equal(tools.get(old), undefined)
    assert.equal(renders.get(old), undefined)
    assert.deepEqual(manager.getDefinitions(loaded), [])
    assert.equal(manager.searchTools("old_tool").includes(old), false)
    assert.equal(manager.listTools().filter((tool) => tool.serverId === "a").length, 1)

    const before = first.state.lists
    first.state.listGate = new Promise<void>((resolve) => { releaseList = resolve })
    await first.notify()
    await eventually(() => first.state.lists > before)
    first.state.tools = [testTool("latest_tool")]
    const gate = releaseList!
    first.state.listGate = undefined
    await manager.applyConfigurations([{ ...a, tool_timeout_sec: 4 }, b])
    const latest = manager.listTools().find((tool) => tool.serverId === "a")!.name
    gate()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(manager.getTool(latest)?.originalToolName, "latest_tool")
    assert.equal(manager.listTools().some((tool) => manager.getTool(tool.name)?.originalToolName === "new_tool"), false)

    const renamed = { ...a, name: "renamed" }
    await manager.applyConfigurations([renamed, b])
    assert.equal(manager.getConnectionStates().some((state) => state.name === "a"), false)
    assert.equal(manager.listTools().some((tool) => tool.serverId === "a"), false)
    await manager.applyConfigurations([{ ...renamed, enabled: false }, b])
    assert.equal(manager.listTools().some((tool) => tool.serverId === "renamed"), false)
    assert.equal(other.state.starts, 1)
    await manager.applyConfigurations([a, b])
    const firstStarts = first.state.starts
    await manager.applyConfigurations([a, b], { restartAll: true })
    assert.equal(first.state.starts, firstStarts + 1)
    assert.equal(other.state.starts, 2)

    /** 通过实际资源方法的失败模拟验证：未关闭的旧身份不会产生第二个实例。 */
    const connections = (manager as unknown as { connections: Map<string, MCPConnection> }).connections
    const connection = connections.get("a")!
    const close = connection.client!.close.bind(connection.client)
    connection.client!.close = async () => { throw new Error("fixture close failed") }
    await assert.rejects(manager.applyConfigurations([{ ...a, tool_timeout_sec: 2 }, b]), /清理失败/)
    assert.equal(first.state.starts, firstStarts + 1)
    assert.equal(manager.listTools().some((tool) => tool.serverId === "a"), false)
    connection.client!.close = close
    await manager.applyConfigurations([a, b], { restartAll: true })
    assert.equal(manager.getConnectionStates().find((state) => state.name === "a")?.status, "connected")
    await manager.applyConfigurations([])
    assert.deepEqual(manager.getConnectionStates(), [])
    assert.deepEqual(manager.listTools(), [])
    assert.equal(tools.listDefinitions().some((tool) => tool.name.startsWith("mcp_") && tool.name !== "mcp_list_tools" && tool.name !== "mcp_load_tools"), false)
    await eventually(() => first.state.closedStreams > 0 && other.state.closedStreams > 0)
    const initializing = manager.applyConfigurations([a])
    const disposal = manager.dispose()
    await assert.rejects(initializing, /已释放/)
    await disposal
    await assert.rejects(manager.applyConfigurations([a]), /已释放/)
    console.log("lifecycle.test.ts: 增量连接、改名、禁用、全量重载、旧通知、清理失败及退出通过")
  } finally {
    releaseList?.()
    await manager.dispose()
    await first.close(); await other.close()
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
