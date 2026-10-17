/** 仅由 MCPManager 的真实 StdioClientTransport 启动的独立测试进程。 */
import { createInterface } from "node:readline"

const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const request = JSON.parse(line) as { id?: string | number; method: string; params?: Record<string, unknown> }
  if (request.id === undefined) return
  let result: unknown
  if (request.method === "initialize") {
    result = { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stdio-fixture", version: "1" } }
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "inspect_environment", description: "inspect stdio environment", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }
  } else if (request.method === "tools/call") {
    result = { content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), explicit: process.env.MCP_EXPLICIT, inherited: process.env.MCP_INHERITED, path: Boolean(process.env.PATH ?? process.env.Path) }) }] }
  } else { result = {} }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
})
