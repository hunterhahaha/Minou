/** 可重复建立独立 SDK 会话的本机 MCP 测试服务，用于连接生命周期断言。 */
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"

/** 可从测试中控制目录、请求挂起及统计的状态。 */
interface ReloadableState {
  /** 当前远端目录。 */ tools: Tool[]
  /** 实际完成 SDK 会话建立的次数。 */ starts: number
  /** 实际收到的目录请求次数。 */ lists: number
  /** 实际收到的工具调用次数。 */ calls: number
  /** 已关闭的 SSE 连接次数。 */ closedStreams: number
  /** 目录请求在读取快照后等待的门。 */ listGate?: Promise<void>
  /** 工具执行在收到请求后等待的门。 */ callGate?: Promise<void>
}

/**
 * 启动允许多次重新连接的本机服务，所有会话共享可控业务状态。
 * @param tools 初始远端工具定义。
 * @returns 端点、统计、通知和资源清理入口。
 * @throws Error 本地监听或 SDK 服务初始化失败。
 */
export async function createReloadableServer(tools: Tool[]) {
  const state: ReloadableState = { tools, starts: 0, lists: 0, calls: 0, closedStreams: 0 }
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>()
  const http = createServer((request, response) => {
    if (request.method === "GET") response.once("close", () => { state.closedStreams++ })
    void (async () => {
      let body: unknown
      if (request.method === "POST") {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        body = JSON.parse(Buffer.concat(chunks).toString())
      }
      const sessionId = request.headers["mcp-session-id"]
      let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined
      if (!session) {
        if (request.method !== "POST" || sessionId !== undefined) { response.writeHead(400); response.end(); return }
        const server = new Server({ name: "reloadable-test", version: "1" }, { capabilities: { tools: { listChanged: true } } })
        server.setRequestHandler(ListToolsRequestSchema, async () => {
          const snapshot = structuredClone(state.tools)
          state.lists++
          await state.listGate
          return { tools: snapshot }
        })
        server.setRequestHandler(CallToolRequestSchema, async () => {
          state.calls++
          await state.callGate
          return { content: [{ type: "text", text: "done" }] }
        })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => { sessions.set(id, { server, transport }); state.starts++ } })
        await server.connect(transport)
        session = { server, transport }
      }
      await session.transport.handleRequest(request, response, body)
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("缺少本机 MCP 测试端口")
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, state,
    /** @returns 向所有已有会话发送一次目录变化通知。 */
    notify: async () => { await Promise.allSettled([...sessions.values()].map(({ server }) => server.notification({ method: "notifications/tools/list_changed" }))) },
    /** @returns 所有测试会话及监听端口完成清理。 */
    close: async () => {
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()))
      http.closeAllConnections()
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
    },
  }
}
