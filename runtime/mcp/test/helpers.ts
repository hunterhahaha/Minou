import { createServer } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"

/** 本地测试 Server 的可控行为与实际请求记录。 */
export interface MCPTestState {
  /** 当前工具目录，可在通知前替换。 */ tools: Tool[]
  /** 每页最多工具数。 */ pageSize?: number
  /** 是否拒绝目录请求。 */ failList?: boolean
  /** listTools 的人为延时。 */ listDelay?: number
  /** 远端真正收到的业务调用。 */ calls: Array<{ name: string; arguments?: Record<string, unknown> }>
  /** 实际 HTTP 请求头，用于鉴权断言。 */ headers: IncomingHttpHeaders[]
  /** 自定义调用返回或挂起行为。 */ call?: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>
}

/**
 * 创建使用官方 Server Transport 的本地 HTTP MCP 服务，不访问公网。
 * @param tools 初始目录。
 * @param withTools 是否声明 tools 能力。
 * @returns 端点、可控状态、通知入口和关闭方法。
 * @throws Error 本地监听或 SDK 初始化失败。
 */
export async function createMCPTestServer(tools: Tool[], withTools = true) {
  const state: MCPTestState = { tools, calls: [], headers: [] }
  const server = new Server({ name: "local-test", version: "1" }, { capabilities: withTools ? { tools: { listChanged: true } } : {} })
  if (withTools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (state.listDelay) await new Promise<void>((resolve) => setTimeout(resolve, state.listDelay))
      if (state.failList) throw new Error("fixture list failed")
      const offset = Number(request.params?.cursor ?? 0)
      const size = state.pageSize ?? Math.max(state.tools.length, 1)
      return { tools: state.tools.slice(offset, offset + size), ...(offset + size < state.tools.length ? { nextCursor: String(offset + size) } : {}) }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      state.calls.push(structuredClone(request.params))
      return state.call ? state.call(request.params.name, request.params.arguments ?? {}) : { content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] }
    })
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
  await server.connect(transport)
  const http = createServer((request, response) => {
    state.headers.push({ ...request.headers })
    void (async () => {
      let body: unknown
      if (request.method === "POST") {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        body = JSON.parse(Buffer.concat(chunks).toString()) as unknown
      }
      await transport.handleRequest(request, response, body)
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("没有测试监听端口")
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, state,
    /** @returns SDK 工具变化通知发送完成。 */
    notify: () => server.notification({ method: "notifications/tools/list_changed" }),
    /** @returns 本地连接和监听端口全部清理完成。 */
    close: async () => { await server.close(); http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())) },
  }
}

/**
 * 等待确定状态，超时使测试失败；只用于本地通知等异步边界。
 * @param predicate 需要观察到的条件。
 * @returns 条件成立时解析。
 * @throws Error 三秒内条件未成立。
 */
export async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待 MCP 状态超时")
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

/** @param name 工具名称。 @param description 可搜索描述。 @returns 严格字符串参数的测试工具。 */
export function testTool(name: string, description = "calendar schedule event"): Tool {
  return { name, description, inputSchema: { type: "object", properties: { value: { type: "string", description: "schemaOnlySecretWord" } }, required: ["value"], additionalProperties: false } }
}
