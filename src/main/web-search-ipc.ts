/** 搜索配置管理：可信预置目录、输入校验及独立配置库之间的 IPC 边界。 */
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { WEB_SEARCH_IPC_CHANNELS } from "../preload/session-api.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import type { IpcMainHandlePort } from "./session-ipc.ts"
import { listWebSearchProviderDefinitions } from "./web-search-providers.ts"
import { readWebSearchProviderParameters } from "../../runtime/tools/src/web-search/provider-template.ts"
import { deleteWebSearchProvider, getWebSearchProvider, listWebSearchProviders, saveWebSearchProvider, setActiveWebSearchProvider, WEB_SEARCH_DATABASE_FILE } from "../../runtime/tools/src/web-search/store.ts"
import type { WebSearchProviderConfig, WebSearchProviderSaveInput, WebSearchProviderSummary } from "../../runtime/tools/src/web-search/types.ts"

/**
 * 要求配置身份为非空字符串，不在错误中显示输入。
 * @param value 未知 IPC 参数。
 * @returns 原样身份。
 * @throws TypeError 身份无效。
 */
function requireId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("搜索服务商 ID 无效。")
  return value
}

/**
 * 校验目录身份、参数和固定响应映射；不改变前端生成的请求原文。
 * @param value 未知页面保存内容。
 * @returns 完整保存内容，不含启用状态。
 * @throws Error 输入、服务商名称或参数无效；消息不含请求和凭据。
 */
function requireInput(value: unknown): WebSearchProviderSaveInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
      !("name" in value) || !("requestJson" in value) || !("responseJmespath" in value) ||
      typeof value.name !== "string" || typeof value.requestJson !== "string" || typeof value.responseJmespath !== "string") {
    throw new TypeError("搜索配置输入无效。")
  }
  const input = value as WebSearchProviderSaveInput
  const definition = listWebSearchProviderDefinitions().find((entry) => entry.name === input.name)
  if (!definition) throw new TypeError("搜索服务商不在预置目录中。")
  readWebSearchProviderParameters(definition, input.requestJson)
  if (input.responseJmespath !== definition.responseJmespath) throw new TypeError("搜索响应映射与预置定义不一致。")
  return input
}

/**
 * 注册七个搜索管理接口，创建身份由主进程生成，列表只返回无凭据摘要。
 * @param ipcMain 固定通道注册端口。
 * @param paths 启动阶段已初始化的用户配置根目录。
 * @throws Error 重复注册、输入无效或数据库操作失败；交由页面展示。
 */
export function registerWebSearchIpcHandlers(ipcMain: IpcMainHandlePort, paths: Pick<ConfigFilePaths, "rootDir">): void {
  const databasePath = join(paths.rootDir, WEB_SEARCH_DATABASE_FILE)
  /** @param id 配置身份。 @returns 现存完整配置。 @throws Error 配置不存在或数据库无效。 */
  function existing(id: unknown): WebSearchProviderConfig {
    const provider = getWebSearchProvider(databasePath, requireId(id))
    if (!provider) throw new Error("搜索服务商不存在。")
    return provider
  }
  ipcMain.handle(WEB_SEARCH_IPC_CHANNELS.listWebSearchProviderDefinitions, () => listWebSearchProviderDefinitions())
  ipcMain.handle(WEB_SEARCH_IPC_CHANNELS.listWebSearchProviders, (): WebSearchProviderSummary[] =>
    listWebSearchProviders(databasePath).map(({ id, name, enabled }) => ({ id, name, enabled })))
  ipcMain.handle(WEB_SEARCH_IPC_CHANNELS.getWebSearchProvider, (_event, id: unknown) => existing(id))
  ipcMain.handle(WEB_SEARCH_IPC_CHANNELS.createWebSearchProvider, (_event, raw: unknown): WebSearchProviderSummary => {
    const input = requireInput(raw)
    const id = randomUUID()
    saveWebSearchProvider(databasePath, { ...input, id })
    return { id, name: input.name, enabled: false }
  })
  ipcMain.handle(WEB_SEARCH_IPC_CHANNELS.updateWebSearchProvider, (_event, id: unknown, raw: unknown): void => {
    const current = existing(id)
    const input = requireInput(raw)
    if (input.name !== current.name) throw new TypeError("编辑时不能更换搜索服务商。")
    saveWebSearchProvider(databasePath, { ...input, id: current.id })
  })
  ipcMain.handle(WEB_SEARCH_IPC_CHANNELS.deleteWebSearchProvider, (_event, id: unknown): void => {
    deleteWebSearchProvider(databasePath, existing(id).id)
  })
  ipcMain.handle(WEB_SEARCH_IPC_CHANNELS.setActiveWebSearchProvider, (_event, id: unknown): void => {
    setActiveWebSearchProvider(databasePath, id === null ? null : existing(id).id)
  })
}
