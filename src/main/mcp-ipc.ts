/** MCP 设置的配置读改写及全局连接同步；所有请求共用同一串行边界。 */
import type { MCPManager } from "../../runtime/mcp/src/manager.ts"
import type { MCPConfig } from "../../runtime/mcp/src/types.ts"
import { MCP_IPC_CHANNELS, type MCPServerSummary } from "../preload/session-api.ts"
import { readConfigFile, writeMcpServers, type ConfigFilePaths } from "./config-files.ts"
import { checkConfig } from "./config-schema.ts"
import type { IpcMainHandlePort } from "./session-ipc.ts"

/**
 * 注册 MCP 查询、配置增删改和完整重载；持久化成功后才改变共享连接。
 * @param ipcMain 主进程固定 channel 注册端口。
 * @param paths 已初始化的全局配置路径。
 * @param manager 启动时创建、与所有 Session 共用的唯一 MCPManager。
 * @throws Error channel 重复注册；各请求的校验、文件或资源清理错误通过 IPC 返回。
 */
export function registerMcpIpcHandlers(ipcMain: IpcMainHandlePort, paths: Pick<ConfigFilePaths, "configPath">, manager: MCPManager): void {
  let pending: Promise<unknown> = Promise.resolve()
  /**
   * 排队执行完整配置操作；失败后的队列仍可接受下一次请求。
   * @param task 本次读取、保存及运行状态同步。
   * @returns 此请求的页面快照；任务错误保持拒绝状态。
   */
  function enqueue(task: () => Promise<MCPServerSummary[]>): Promise<MCPServerSummary[]> {
    const result = pending.then(task)
    pending = result.catch(() => undefined)
    return result
  }
  /**
   * 合并有效配置与当前连接状态，不暴露 SDK 资源或解析后的鉴权值。
   * @param configs 同名以后项生效的磁盘配置。
   * @returns 按有效名称排列的页面快照；禁用或尚未连接项显示 disconnected。
   */
  function summarize(configs: readonly MCPConfig[]): MCPServerSummary[] {
    const states = new Map(manager.getConnectionStates().map((state) => [state.name, state]))
    const counts = new Map<string, number>()
    for (const tool of manager.listTools()) counts.set(tool.serverId, (counts.get(tool.serverId) ?? 0) + 1)
    return [...new Map(configs.map((config) => [config.name, config])).values()].map((config) => {
      const state = states.get(config.name)
      return { config: structuredClone(config), status: state?.status ?? "disconnected", toolCount: counts.get(config.name) ?? 0,
        ...(state?.error ? { error: { ...state.error } } : {}) }
    })
  }
  /**
   * 保存配置并等待连接同步，启动失败由快照中的 error 状态表达。
   * @param configs 完整新配置；其他普通配置由文件模块保留。
   * @returns 已保存配置与同步完成后的运行状态。
   * @throws Error 持久化或旧连接清理失败；清理失败发生在配置保存之后。
   */
  async function save(configs: MCPConfig[]): Promise<MCPServerSummary[]> {
    const saved = await writeMcpServers(paths.configPath, configs)
    await manager.applyConfigurations(saved.mcpServers)
    return summarize(saved.mcpServers)
  }

  ipcMain.handle(MCP_IPC_CHANNELS.listMcpServers, () => enqueue(async () => summarize((await readConfigFile(paths.configPath)).mcpServers)))
  ipcMain.handle(MCP_IPC_CHANNELS.createMcpServer, (_event, value: unknown) => enqueue(async () => {
    const config = requireConfig(value)
    const current = await readConfigFile(paths.configPath)
    if (current.mcpServers.some((entry) => entry.name === config.name)) throw new Error("MCP 名称已存在。")
    return save([...current.mcpServers, config])
  }))
  ipcMain.handle(MCP_IPC_CHANNELS.updateMcpServer, (_event, originalName: unknown, value: unknown) => enqueue(async () => {
    const name = requireName(originalName)
    const config = requireConfig(value)
    const current = await readConfigFile(paths.configPath)
    if (!current.mcpServers.some((entry) => entry.name === name)) throw new Error("MCP 配置不存在。")
    if (config.name !== name && current.mcpServers.some((entry) => entry.name === config.name)) throw new Error("MCP 名称已存在。")
    const last = current.mcpServers.reduce((index, entry, position) => entry.name === name ? position : index, -1)
    return save(current.mcpServers.flatMap((entry, position) => entry.name !== name ? [entry] : position === last ? [config] : []))
  }))
  ipcMain.handle(MCP_IPC_CHANNELS.deleteMcpServer, (_event, value: unknown) => enqueue(async () => {
    const name = requireName(value)
    const current = await readConfigFile(paths.configPath)
    if (!current.mcpServers.some((entry) => entry.name === name)) throw new Error("MCP 配置不存在。")
    return save(current.mcpServers.filter((entry) => entry.name !== name))
  }))
  ipcMain.handle(MCP_IPC_CHANNELS.reloadMcpServers, () => enqueue(async () => {
    const current = await readConfigFile(paths.configPath)
    await manager.applyConfigurations(current.mcpServers, { restartAll: true })
    return summarize(current.mcpServers)
  }))
}

/**
 * 复用当前 V2 配置校验检查未知 IPC 输入，不补默认值。
 * @param value 来自 Renderer 的完整单项配置。
 * @returns 独立的已校验 MCP 配置。
 * @throws Error 字段、传输类型或鉴权配置无效。
 */
function requireConfig(value: unknown): MCPConfig {
  checkConfig({ version: 2, runtime: { userMessageMode: "queue" }, mcpServers: [value] })
  return structuredClone(value) as MCPConfig
}

/**
 * 要求 IPC 名称为非空字符串，保留其原始内容。
 *
 * @param value 未知身份。
 * @returns 原样保留的有效名称。
 * @throws TypeError 名称为空或不是字符串。
 */
function requireName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError("MCP 名称必须是非空字符串。")
  return value
}
