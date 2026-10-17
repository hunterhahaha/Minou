/** MCP preload 的固定 channel、参数顺序和页面快照校验。 */
import assert from "node:assert/strict"
import { createSessionApi, MCP_IPC_CHANNELS, type MCPServerSummary } from "../../src/preload/session-api.ts"

/** @returns 五个接口及无效返回值拒绝验证完成。 */
async function main(): Promise<void> {
  const summary: MCPServerSummary = { config: { name: "local", enabled: false, transport: "stdio", command: "node", args: ["", "a b"], env: { EMPTY: "" } }, status: "disconnected", toolCount: 0 }
  const calls: unknown[][] = []
  let response: unknown = [summary]
  const api = createSessionApi({ invoke: async (...args) => { calls.push(args); return response } })
  assert.ok(Object.isFrozen(api))
  assert.deepEqual(await api.listMcpServers(), [summary])
  await api.createMcpServer(summary.config)
  await api.updateMcpServer("old", summary.config)
  await api.deleteMcpServer("local")
  await api.reloadMcpServers()
  assert.deepEqual(calls, [
    [MCP_IPC_CHANNELS.listMcpServers], [MCP_IPC_CHANNELS.createMcpServer, summary.config],
    [MCP_IPC_CHANNELS.updateMcpServer, "old", summary.config], [MCP_IPC_CHANNELS.deleteMcpServer, "local"], [MCP_IPC_CHANNELS.reloadMcpServers],
  ])
  for (const invalid of [null, {}, [null], [{ ...summary, status: "invalid" }], [{ ...summary, toolCount: -1 }],
    [{ ...summary, config: { ...summary.config, args: [1] } }], [{ ...summary, config: { ...summary.config, env: [] } }],
    [{ ...summary, config: { ...summary.config, tool_timeout_sec: Infinity } }], [{ ...summary, error: { source: "unknown", code: "x", message: "x" } }],
    [{ ...summary, config: { name: "remote", enabled: true, transport: "streamable-http", url: "file:///bad" } }],
    [{ ...summary, config: { name: "remote", enabled: true, transport: "streamable-http", url: "https://example.com/mcp", bearer_token_env_var: "TOKEN", http_headers: { Authorization: "x" } } }],
  ]) {
    response = invalid
    await assert.rejects(api.listMcpServers(), TypeError)
  }
  response = [{ config: { name: "remote", enabled: true, transport: "streamable-http", url: "https://example.com/mcp", http_headers: { "X-Test": "" } }, status: "error", toolCount: 0,
    error: { source: "mcp", code: "MCP_STARTUP_FAILED", message: "连接失败" } }]
  assert.equal((await api.reloadMcpServers())[0].status, "error")
  console.log("mcp-api.test.ts: 固定 channel、完整参数、状态快照与非法返回值拒绝通过")
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
