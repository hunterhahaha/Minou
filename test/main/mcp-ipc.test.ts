/** MCP IPC 使用真实配置文件、共享 Manager 和本机服务验证持久化与运行状态同步。 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { MCPManager } from "../../runtime/mcp/src/manager.ts"
import type { MCPConfig } from "../../runtime/mcp/src/types.ts"
import { createReloadableServer } from "../../runtime/mcp/test/reloadable-server.ts"
import { testTool } from "../../runtime/mcp/test/helpers.ts"
import { registerMcpIpcHandlers } from "../../src/main/mcp-ipc.ts"
import { readConfigFile, writeMcpServers } from "../../src/main/config-files.ts"
import { MCP_IPC_CHANNELS as channels, type MCPServerSummary } from "../../src/preload/session-api.ts"

/** @param event 不使用的测试事件。 @param args IPC 参数。 @returns handler 的异步或同步结果。 */
type Handler = (event: unknown, ...args: unknown[]) => unknown
/** 可验证固定 channel 注册和调用的主进程端口。 */
class TestIpc {
  /** 当前全部已注册的 handler。 */ readonly handlers = new Map<string, Handler>()
  /** @param channel 固定 channel。 @param handler 待注册的处理器。 @throws Error 重复注册。 */
  handle(channel: string, handler: Handler): void { assert.equal(this.handlers.has(channel), false); this.handlers.set(channel, handler) }
  /** @param channel 要调用的固定 channel。 @param args Renderer 参数。 @returns 页面快照。 */
  async invoke(channel: string, ...args: unknown[]): Promise<MCPServerSummary[]> {
    const handler = this.handlers.get(channel)
    assert.ok(handler)
    return await handler({}, ...args) as MCPServerSummary[]
  }
}

/** @returns 两种配置的 IPC、文件错误、连接恢复和串行边界验证完成。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "minou-mcp-ipc-"))
  const configPath = join(root, "config.json")
  const initial = { version: 2, runtime: { userMessageMode: "insert" }, mcpServers: [] }
  await writeFile(configPath, JSON.stringify(initial))
  const fixture = await createReloadableServer([testTool("sample")])
  const manager = new MCPManager(() => 1)
  await manager.initialize([])
  const ipc = new TestIpc()
  registerMcpIpcHandlers(ipc, { configPath }, manager)
  const http: MCPConfig = { name: "http", enabled: true, transport: "streamable-http", url: fixture.url, http_headers: { "X-Test": " value " }, startup_timeout_sec: 1, tool_timeout_sec: 2 }
  const stdio: MCPConfig = { name: "local", enabled: false, transport: "stdio", command: process.execPath,
    args: ["--experimental-strip-types", resolve("runtime/mcp/test/stdio-server.ts"), "with spaces", ""], env: { MCP_EXPLICIT: " value ", EMPTY: "" }, cwd: root }
  try {
    assert.deepEqual([...ipc.handlers.keys()], Object.values(channels))
    assert.deepEqual(await ipc.invoke(channels.listMcpServers), [])
    await Promise.all([ipc.invoke(channels.createMcpServer, http), ipc.invoke(channels.createMcpServer, stdio)])
    const saved = await readConfigFile(configPath)
    assert.deepEqual(saved.runtime, initial.runtime)
    assert.deepEqual(saved.mcpServers, [http, stdio])
    let listed = await ipc.invoke(channels.listMcpServers)
    assert.equal(listed[0].status, "connected"); assert.equal(listed[0].toolCount, 1)
    assert.equal(listed[1].status, "disconnected"); assert.equal(listed[1].toolCount, 0)
    await assert.rejects(ipc.invoke(channels.createMcpServer, http), /名称已存在/)
    await assert.rejects(ipc.invoke(channels.updateMcpServer, "local", { ...stdio, name: "http" }), /名称已存在/)
    await assert.rejects(ipc.invoke(channels.updateMcpServer, "absent", http), /不存在/)
    await assert.rejects(ipc.invoke(channels.deleteMcpServer, "absent"), /不存在/)
    const starts = fixture.state.starts
    const stateBefore = manager.getConnectionStates()
    const bytesBefore = await readFile(configPath, "utf8")
    for (const input of [null, {}, { ...http, url: "file:///bad" }, { ...http, headers: {} }, { ...http, startup_timeout_sec: 0 }, { ...stdio, args: [1] },
      { ...http, bearer_token_env_var: "TOKEN", http_headers: { aUtHoRiZaTiOn: "secret-value" } }]) {
      await assert.rejects(ipc.invoke(channels.createMcpServer, input))
    }
    assert.equal(await readFile(configPath, "utf8"), bytesBefore)
    assert.deepEqual(manager.getConnectionStates(), stateBefore)
    assert.equal(fixture.state.starts, starts)

    listed = await ipc.invoke(channels.updateMcpServer, "http", { name: "remote", enabled: true, transport: "streamable-http", url: fixture.url })
    assert.equal(listed[0].config.name, "remote")
    assert.equal(manager.getConnectionStates().some((state) => state.name === "http"), false)
    const cleared = (await readConfigFile(configPath)).mcpServers[0]
    assert.ok(cleared.transport === "streamable-http")
    assert.equal(cleared.http_headers, undefined)
    assert.equal((await readConfigFile(configPath)).mcpServers[0].startup_timeout_sec, undefined)
    listed = await ipc.invoke(channels.updateMcpServer, "local", { ...stdio, enabled: true })
    assert.equal(listed[1].status, "connected")
    const local = manager.listTools().find((tool) => tool.serverId === "local")!
    assert.ok(local)
    assert.deepEqual(listed[1].config, { ...stdio, enabled: true })
    listed = await ipc.invoke(channels.updateMcpServer, "local", { ...stdio, enabled: true, command: "minou-fixture-missing-command" })
    assert.equal(listed[1].status, "error", "连接失败应返回已保存的错误状态")
    assert.equal((await readConfigFile(configPath)).mcpServers[1].enabled, true)
    listed = await ipc.invoke(channels.updateMcpServer, "local", { ...stdio, enabled: true })
    assert.equal(listed[1].status, "connected")
    await ipc.invoke(channels.updateMcpServer, "local", { ...stdio, args: [], env: {}, cwd: undefined })
      .then(() => assert.fail("显式 undefined 字段不能写入配置"), () => undefined)
    listed = await ipc.invoke(channels.updateMcpServer, "local", { name: "local", enabled: false, transport: "stdio", command: process.execPath })
    assert.deepEqual(listed[1].config, { name: "local", enabled: false, transport: "stdio", command: process.execPath })

    const beforeReload = fixture.state.starts
    await ipc.invoke(channels.reloadMcpServers)
    assert.equal(fixture.state.starts, beforeReload + 1)
    const healthy = manager.getConnectionStates()
    const healthyFile = await readFile(configPath, "utf8")
    await writeFile(configPath, "{broken")
    await assert.rejects(ipc.invoke(channels.reloadMcpServers), /config.json/)
    assert.deepEqual(manager.getConnectionStates(), healthy)
    await writeFile(configPath, healthyFile)
    await ipc.invoke(channels.reloadMcpServers)

    const external: MCPConfig = { name: "external", enabled: false, transport: "stdio", command: "unused" }
    await writeMcpServers(configPath, [external, { ...external, command: "last-wins" }])
    listed = await ipc.invoke(channels.reloadMcpServers)
    assert.equal(listed.length, 1)
    assert.equal((listed[0].config as { command: string }).command, "last-wins")
    await ipc.invoke(channels.updateMcpServer, "external", { ...external, name: "renamed" })
    assert.equal((await readConfigFile(configPath)).mcpServers.length, 1)
    await ipc.invoke(channels.deleteMcpServer, "renamed")
    assert.deepEqual(manager.listTools(), [])
    const results = await Promise.allSettled([
      ipc.invoke(channels.createMcpServer, external), ipc.invoke(channels.createMcpServer, external),
      ipc.invoke(channels.createMcpServer, { ...external, name: "following" }),
    ])
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"])
    assert.equal((await readConfigFile(configPath)).mcpServers.length, 2)

    /** 超长临时文件名使真实文件写入失败，原配置与 Manager 必须保持原样。 */
    const longPath = join(root, `${"c".repeat(230)}.json`)
    await writeFile(longPath, JSON.stringify(initial))
    const filesBefore = (await readdir(root)).sort()
    const beforeWriteFailure = manager.getConnectionStates()
    const failing = new TestIpc()
    registerMcpIpcHandlers(failing, { configPath: longPath }, manager)
    await assert.rejects(failing.invoke(channels.createMcpServer, external), /无法保存配置文件/)
    assert.deepEqual(JSON.parse(await readFile(longPath, "utf8")), initial)
    assert.deepEqual(manager.getConnectionStates(), beforeWriteFailure)
    assert.deepEqual((await readdir(root)).sort(), filesBefore)
    console.log("mcp-ipc.test.ts: 双传输 CRUD、唯一名称、可选字段、并发、持久化失败、重载与故障恢复通过")
  } finally {
    await manager.dispose(); await fixture.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
