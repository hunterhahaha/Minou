import { createHash } from "node:crypto"
import type { Readable } from "node:stream"
import { isDeepStrictEqual } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ToolListChangedNotificationSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js"
import type { AppError } from "../../error/src/types.ts"
import type { UnifiedToolDefinition } from "../../model/src/types.ts"
import type { ToolExecutionContext } from "../../tools/src/types.ts"
import { MCPToolSearch } from "./search.ts"
import type { MCPCatalogTool, MCPConfig, MCPConnection, MCPToolCallResult, MCPToolNameInfo, SessionLoadedMCPTool } from "./types.ts"

/**
 * 构造可公开的 MCP 错误；不复制 SDK 异常、URL 或鉴权值。
 * @param code Runtime 稳定错误码。
 * @param message 可以提供给模型或宿主的固定说明。
 * @returns MCP 来源的统一错误。
 */
export function mcpError(code: string, message: string): AppError { return { source: "mcp", code, message } }

/** 搜索与指定载入共用的预算计算结果，由 SessionState 负责持久化。 */
export interface MCPLoadResult {
  /** 新加入的工具数，不含已经载入项。 */ loadedCount: number
  /** 预算治理后的完整载入记录。 */ loaded: SessionLoadedMCPTool[]
  /** 当前有效的模型定义。 */ definitions: UnifiedToolDefinition[]
}

/** 应用启动时创建一次的 MCP 连接、Catalog、搜索和调用管理器。 */
export class MCPManager {
  private readonly connections = new Map<string, MCPConnection>()
  private catalog = new Map<string, MCPCatalogTool>()
  private searchIndex = new MCPToolSearch()
  private readonly listeners = new Set<() => void>()
  private readonly refreshes = new Map<MCPConnection, Promise<void>>()
  private readonly startupControllers = new Set<AbortController>()
  private initialization: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private disposed = false
  /** 串行化连接配置变更；失败不阻塞后续重试。 */
  private operations: Promise<void> = Promise.resolve()
  private readonly estimateTokens: (text: string) => number

  /**
   * 绑定项目已有的 Token 估算器；构造时不启动任何连接。
   * @param estimateTokens 仅用于 MCP 定义预算的稳定本地估算函数。
   */
  constructor(estimateTokens: (text: string) => number) { this.estimateTokens = estimateTokens }

  /**
   * 对最终同名覆盖后的启用配置并行初始化，单个失败保留错误状态。
   * @param configs 已由启动配置入口校验的 Server 配置。
   * @returns 所有初始化尝试结束后解析；重复调用复用同一次初始化。
   * @throws Error Manager 已经释放时拒绝再次初始化。
   */
  initialize(configs: readonly MCPConfig[]): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("MCPManager 已释放"))
    return this.initialization ??= this.applyConfigurations(configs)
  }

  /**
   * 在同一 Manager 内同步已持久化配置，先使旧目录失效，再关闭和替换连接。
   * @param configs 已校验配置；同名以后项为准，禁用项不建立连接。
   * @param options restartAll 为 true 时也重启未变化的连接。
   * @returns 全部连接尝试结束；单项启动失败保留为 error 状态。
   * @throws Error Manager 已释放，或旧资源清理失败；清理失败的身份不会启动替代实例。
   */
  applyConfigurations(configs: readonly MCPConfig[], options: { restartAll?: boolean } = {}): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("MCPManager 已释放"))
    const final = new Map(configs.map((config) => [config.name, structuredClone(config)]))
    const operation = this.operations.then(async () => {
      if (this.disposed) throw new Error("MCPManager 已释放")
      const retiring = [...this.connections].filter(([name, connection]) => {
        const next = final.get(name)
        return options.restartAll || !next?.enabled || !isDeepStrictEqual(connection.config, next)
      })
      const removed = new Set(retiring.map(([name]) => name))
      for (const [, connection] of retiring) connection.status = "disconnected"
      if (removed.size) this.publish(new Map([...this.catalog].filter(([, tool]) => !removed.has(tool.serverId))))
      const results = await Promise.allSettled(retiring.map(async ([name, connection]) => {
        try {
          await this.closeConnection(connection)
          if (this.connections.get(name) === connection) this.connections.delete(name)
        } catch {
          connection.status = "error"
          connection.error = mcpError("MCP_CLOSE_FAILED", "MCP 连接清理失败，配置已保存，请刷新重试。")
          throw new Error("MCP 连接清理失败")
        } finally { this.refreshes.delete(connection) }
      }))
      if (results.some((result) => result.status === "rejected")) throw new Error("MCP 配置已保存，但旧连接清理失败，请刷新重试。")
      if (this.disposed) throw new Error("MCPManager 已释放")
      await Promise.all([...final.values()].filter((config) => config.enabled && !this.connections.has(config.name)).map((config) => this.connect(config)))
    })
    this.operations = operation.catch(() => undefined)
    return operation
  }

  /**
   * 订阅完整 Catalog 的替换或失效；回调只同步维护注册表。
   * @param listener Catalog 发布后的同步订阅者。
   * @returns 解除订阅函数。
   */
  onCatalogChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @returns 不含配置或凭据的连接状态副本。 */
  getConnectionStates(): Array<{ name: string; status: MCPConnection["status"]; error?: AppError }> {
    return [...this.connections].map(([name, connection]) => ({ name, status: connection.status, ...(connection.error ? { error: { ...connection.error } } : {}) }))
  }

  /** @returns 当前启用且已连接 Server 的轻量工具列表。 */
  listTools(): MCPToolNameInfo[] { return [...this.catalog.values()].map(({ name, serverId }) => ({ name, serverId })) }

  /**
   * 查找当前有效的完整工具定义，仅用于 Runtime 注册，不返回给发现工具。
   * @param name 模型侧稳定名称。
   * @returns 有效 Catalog 条目；不存在或断开时为 undefined。
   */
  getTool(name: string): MCPCatalogTool | undefined { return this.catalog.get(name) }

  /** @param query 查询文本。 @returns 至多八个实际匹配工具的稳定名称。 */
  searchTools(query: string): string[] { return this.searchIndex.search(query) }

  /**
   * 根据当前 Catalog 过滤 Session 工具，绝不使用持久化的旧 Schema 发起请求。
   * @param loaded Session 已载入的身份与治理记录。
   * @returns 仍然匹配 Server 和原始工具身份的定义副本。
   */
  getDefinitions(loaded: readonly SessionLoadedMCPTool[]): UnifiedToolDefinition[] {
    return loaded.flatMap((entry) => {
      const tool = this.catalog.get(entry.name)
      return tool && tool.serverId === entry.serverId && tool.originalToolName === entry.originalToolName ? [structuredClone(tool.definition)] : []
    })
  }

  /**
   * 对去重后的有效新工具整批应用文档规定的 5% 预算与 LRU。
   * @param names 搜索或名称载入选出的工具标识。
   * @param previous 当前 Session 持久化的载入状态。
   * @param contextWindow 本 Turn 模型配置快照中的上下文窗口。
   * @returns 新载入数量、完整治理状态与有效定义，不在此方法写磁盘。
   * @throws Error 上下文窗口无效，调用边界应转换为统一错误。
   */
  loadTools(names: readonly string[], previous: readonly SessionLoadedMCPTool[], contextWindow: number): MCPLoadResult {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) throw new Error("MCP 预算缺少有效模型上下文窗口")
    const loaded = previous.filter((entry) => {
      const tool = this.catalog.get(entry.name)
      return tool?.serverId === entry.serverId && tool.originalToolName === entry.originalToolName
    }).map((entry) => ({ ...entry, estimatedTokens: this.estimateTokens(JSON.stringify(this.exposeDefinition(this.catalog.get(entry.name)!.definition))) }))
    const existing = new Set(loaded.map((entry) => entry.name))
    const batch = [...new Set(names)].flatMap((name) => {
      const tool = this.catalog.get(name)
      return !tool || existing.has(name) ? [] : [{ name, serverId: tool.serverId, originalToolName: tool.originalToolName,
        estimatedTokens: this.estimateTokens(JSON.stringify(this.exposeDefinition(tool.definition))), lastCalledAt: 0 }]
    })
    const batchTokens = batch.reduce((sum, entry) => sum + entry.estimatedTokens, 0)
    const budget = contextWindow * 0.05
    if (batchTokens <= budget && batch.length > 0) {
      let total = batchTokens + loaded.reduce((sum, entry) => sum + entry.estimatedTokens, 0)
      const oldest = [...loaded].sort((a, b) => a.lastCalledAt - b.lastCalledAt)
      while (total > budget && oldest.length) {
        const entry = oldest.shift()!
        loaded.splice(loaded.indexOf(entry), 1)
        total -= entry.estimatedTokens
      }
    }
    loaded.push(...batch)
    return { loadedCount: batch.length, loaded, definitions: this.getDefinitions(loaded) }
  }

  /**
   * 复制模型工具定义，保持远端业务 Schema 不变。
   * @param definition Catalog 的业务定义。
   * @returns 独立的工具定义副本。
   */
  exposeDefinition(definition: UnifiedToolDefinition): UnifiedToolDefinition {
    return structuredClone(definition)
  }

  /**
   * 在统一 execute 内检查 Session 载入状态、审批和取消，再调用唯一 Client。
   * @param name 当前模型侧工具名称。
   * @param args 已检查的业务参数。
   * @param context 当前 Session 的状态端口、审批出口及调用身份。
   * @returns SDK 原始返回对象或不含内部详情的 AppError。
   */
  async executeMCPTool(name: string, args: Record<string, unknown>, context: ToolExecutionContext<object>): Promise<MCPToolCallResult | AppError> {
    const runtime = context.mcpRuntime
    if (!runtime) return mcpError("MCP_RUNTIME_MISSING", "当前 Session 缺少 MCP 执行上下文。")
    try {
      if (context.signal.aborted) return mcpError("CANCELLED", "MCP 工具调用已取消。")
      let loaded = await runtime.readLoadedTools()
      if (!this.getDefinitions(loaded).some((tool) => tool.name === name)) return mcpError("MCP_TOOL_NOT_LOADED", "当前 Session 尚未载入此 MCP 工具，或该工具已失效。")
      const mode = await runtime.readSandboxMode()
      if (mode !== "full-access") {
        const decision = await runtime.requestApproval(name, `执行 MCP 工具需要授权：${name}`, context)
        if (decision !== "approved") return mcpError(decision === "cancelled" ? "CANCELLED" : "APPROVAL_DENIED", "MCP 工具调用未获批准。")
      }
      // Full Access 可能在读取载入状态后改变，发起外部操作前再次检查。
      if (mode === "full-access" && await runtime.readSandboxMode() !== "full-access") {
        const decision = await runtime.requestApproval(name, `执行 MCP 工具需要授权：${name}`, context)
        if (decision !== "approved") return mcpError(decision === "cancelled" ? "CANCELLED" : "APPROVAL_DENIED", "MCP 工具调用未获批准。")
      }
      if (context.signal.aborted) return mcpError("CANCELLED", "MCP 工具调用已取消。")
      loaded = await runtime.readLoadedTools()
      let tool = this.catalog.get(name)
      const connection = tool && this.connections.get(tool.serverId)
      if (!tool || connection?.status !== "connected" || !connection.client || !this.getDefinitions(loaded).some((entry) => entry.name === name)) {
        return mcpError("MCP_TOOL_UNAVAILABLE", "MCP 工具或连接当前不可用。")
      }
      // 审批等待期间 Catalog 可能更新，发送前按最新业务 Schema 再检查一次。
      if (!tool.validate(args).valid) return mcpError("INVALID_TOOL_ARGUMENTS", "MCP 工具参数不符合当前 Schema。")
      const updated = loaded.map((entry) => entry.name === name ? { ...entry, lastCalledAt: Date.now() } : entry)
      await runtime.writeLoadedTools(updated, this.getDefinitions(updated))
      if (context.signal.aborted) return mcpError("CANCELLED", "MCP 工具调用已取消。")
      // 持久化让出执行权期间目录也可能更新，真正发送前必须重新定位和校验。
      tool = this.catalog.get(name)
      if (!tool || connection.status !== "connected" || this.connections.get(tool.serverId) !== connection || this.disposed) return mcpError("MCP_TOOL_UNAVAILABLE", "MCP 工具或连接当前不可用。")
      if (!tool.validate(args).valid) return mcpError("INVALID_TOOL_ARGUMENTS", "MCP 工具参数不符合当前 Schema。")
      const timeout = (connection.config.tool_timeout_sec ?? 60) * 1000
      const result = await connection.client.callTool({ name: tool.originalToolName, arguments: args }, undefined,
        { signal: context.signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false })
      return { serverId: tool.serverId, rawToolName: tool.originalToolName, result }
    } catch (error) {
      if (context.signal.aborted) return mcpError("CANCELLED", "MCP 工具调用已取消。")
      const timeout = typeof error === "object" && error !== null && "code" in error && error.code === ErrorCode.RequestTimeout
      return mcpError(timeout ? "MCP_TOOL_TIMEOUT" : "MCP_REQUEST_FAILED", timeout ? "MCP 工具执行超时。" : "MCP 工具调用失败。")
    }
  }

  /**
   * 中止初始化并关闭所有 Client/Transport；不会中断其他 Session 的普通工具。
   * @returns 全部 MCP 清理完成；重复调用共用 Promise。
   * @throws AggregateError 一个或多个 Transport 无法清理，宿主应记录后完成退出。
   */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposed = true
      for (const controller of this.startupControllers) controller.abort()
      for (const connection of this.connections.values()) connection.status = "disconnected"
      this.publish(new Map())
      await this.operations
      const results = await Promise.allSettled([...this.connections.values()].map(async (connection) => {
        connection.status = "disconnected"
        await this.closeConnection(connection)
      }))
      this.refreshes.clear()
      this.publish(new Map())
      const failures = results.filter((result) => result.status === "rejected")
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "MCP 连接清理失败。")
    })()
  }

  /**
   * 尽力关闭同一连接的 Client 和 Transport，保留失败供宿主或后续刷新重试。
   * @param connection 待清理且已从有效目录移除的连接。
   * @returns 两项资源均完成清理。
   * @throws AggregateError 任一资源关闭失败。
   */
  private async closeConnection(connection: MCPConnection): Promise<void> {
    const errors: unknown[] = []
    try { await connection.client?.close() } catch (error) { errors.push(error) }
    try { await connection.transport?.close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, "MCP 连接清理失败")
  }

  /**
   * 连接一个 Server；其整个首次目录加载共用一个截止信号。
   * @param config 已决定同名覆盖后的单项配置。
   * @returns 成功或失败状态均已写入 Map 后解析。
   */
  private async connect(config: MCPConfig): Promise<void> {
    if (this.disposed) return
    const connection: MCPConnection = { config, status: "connecting" }
    this.connections.set(config.name, connection)
    const controller = new AbortController()
    this.startupControllers.add(controller)
    const timeout = (config.startup_timeout_sec ?? 10) * 1000
    const timer = setTimeout(() => controller.abort(), timeout)
    let changedDuringStartup = false
    try {
      const client = new Client({ name: "NiCode", version: "0.1.0" })
      connection.client = client
      if (config.transport === "stdio") {
        const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: config.env, stderr: "pipe" })
        const stderr = transport.stderr as Readable | null
        stderr?.resume()
        connection.transport = transport
      } else {
        const headers = new Headers(config.http_headers)
        if (config.bearer_token_env_var !== undefined) {
          if (headers.has("authorization")) throw new Error("重复鉴权来源")
          const token = process.env[config.bearer_token_env_var]
          if (!token?.trim()) throw new Error("缺少 Bearer 环境变量")
          headers.set("Authorization", `Bearer ${token}`)
        }
        connection.transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
      }
      client.onclose = () => {
        if (this.connections.get(config.name) === connection && connection.status === "connected") {
          connection.status = "disconnected"
          this.removeServer(config.name)
        }
      }
      client.onerror = () => {
        if (this.connections.get(config.name) === connection && connection.status === "connected") connection.error = mcpError("MCP_CONNECTION_ERROR", "MCP 连接发生错误。")
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (this.disposed || this.connections.get(config.name) !== connection) return
        if (connection.status === "connecting") { changedDuringStartup = true; return }
        const previous = this.refreshes.get(connection) ?? Promise.resolve()
        const refresh = previous.then(async () => {
          if (this.disposed || this.connections.get(config.name) !== connection || connection.status !== "connected") return
          try {
            const tools = await this.readTools(connection, AbortSignal.timeout(timeout), timeout)
            if (!this.disposed && this.connections.get(config.name) === connection && connection.status === "connected") {
              this.replaceServer(config.name, tools)
              connection.error = undefined
            }
          } catch {
            if (!this.disposed && this.connections.get(config.name) === connection && connection.status === "connected") {
              connection.error = mcpError("MCP_CATALOG_REFRESH_FAILED", "MCP 工具目录刷新失败，保留上次完整目录。")
            }
          }
        })
        this.refreshes.set(connection, refresh)
        await refresh
      })
      await client.connect(connection.transport, { signal: controller.signal, timeout, maxTotalTimeout: timeout })
      let tools: MCPCatalogTool[]
      do {
        changedDuringStartup = false
        tools = await this.readTools(connection, controller.signal, timeout)
      } while (changedDuringStartup && !controller.signal.aborted)
      if (controller.signal.aborted || this.disposed) throw new Error("初始化取消")
      connection.status = "connected"
      this.replaceServer(config.name, tools)
      connection.error = undefined
    } catch {
      connection.status = "error"
      connection.error = mcpError(controller.signal.aborted ? "MCP_STARTUP_TIMEOUT" : "MCP_STARTUP_FAILED", "MCP Server 初始化失败或超时。")
      try { await connection.client?.close() } catch { /* 原始初始化错误仍是此 Server 的主要状态。 */ }
      try { await connection.transport?.close() } catch { /* SDK close 已尽力清理。 */ }
      this.removeServer(config.name)
    } finally {
      clearTimeout(timer)
      this.startupControllers.delete(controller)
    }
  }

  /**
   * 获取并编译完整分页目录，在成功返回之前不改变共享 Catalog。
   * @param connection 具有 Client 的连接。
   * @param signal 本轮目录获取的总截止信号。
   * @param timeout 每个 SDK 请求的最大毫秒数。
   * @returns 已完成全部 Schema 编译的条目。
   * @throws Error SDK 请求、分页或 Schema 编译失败。
   */
  private async readTools(connection: MCPConnection, signal: AbortSignal, timeout: number): Promise<MCPCatalogTool[]> {
    const client = connection.client!
    if (!client.getServerCapabilities()?.tools) return []
    const tools: Tool[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal, timeout, maxTotalTimeout: timeout })
      tools.push(...page.tools)
      cursor = page.nextCursor
      if (cursor !== undefined && cursors.has(cursor)) throw new Error("MCP 工具目录重复分页")
      if (cursor !== undefined) cursors.add(cursor)
    } while (cursor !== undefined)
    return tools.map((tool) => {
      const identity = JSON.stringify([connection.config.name, tool.name])
      const prefix = `${connection.config.name}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 38)
      const name = `mcp_${prefix}_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}` as const
      const schema = structuredClone(tool.inputSchema)
      // 每份 Schema 独立编译，避免不同 Server 重用 $id 时共享错误的校验器。
      const validate = new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(schema)
      return { name, serverId: connection.config.name, originalToolName: tool.name,
        definition: { name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: schema }, validate }
    })
  }

  /** @param serverId 待替换 Server。 @param tools 此 Server 完整新目录。 @throws Error 目录标识冲突或索引构建失败。 */
  private replaceServer(serverId: string, tools: readonly MCPCatalogTool[]): void {
    const next = new Map([...this.catalog].filter(([, tool]) => tool.serverId !== serverId))
    for (const tool of tools) {
      if (next.has(tool.name)) throw new Error("MCP 工具标识冲突")
      next.set(tool.name, tool)
    }
    this.publish(next)
  }

  /** @param serverId 已断开的 Server 身份，从有效目录与索引同时移除。 */
  private removeServer(serverId: string): void { this.publish(new Map([...this.catalog].filter(([, tool]) => tool.serverId !== serverId))) }

  /** @param next 已完整验证的新目录；先完成索引再同步发布目录和通知。 @throws Error 索引构建或同步注册失败。 */
  private publish(next: Map<string, MCPCatalogTool>): void {
    const search = new MCPToolSearch()
    search.rebuild([...next.values()])
    this.catalog = next
    this.searchIndex = search
    for (const listener of this.listeners) listener()
  }
}
