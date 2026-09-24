/** 启动页面的 Project、default 对话与 Provider 只读 IPC。 */

import type { ConfigFilePaths } from "./config-files.ts"
import type { IpcMainHandlePort } from "./session-ipc.ts"
import { listProviders } from "./provider-store.ts"
import { listProjectWorkspaces, readDefaultWorkspace } from "./workspace-store.ts"
import { STARTUP_DATA_IPC_CHANNELS } from "../preload/session-api.ts"
import type {
  ProjectSummary,
  ProviderSummary,
  SessionSummary,
} from "../preload/session-api.ts"

/**
 * 注册三个无参数的数据查询 handler；每次调用都重新读取当前数据库。
 * @param ipcMain Electron 主进程 IPC 注册端口。
 * @param paths 启动阶段已确定的工作区与 Provider 数据库路径。
 * @throws Error 当 channel 重复注册时由 IPC 实现抛出；查询错误由 handler 传给调用方。
 */
export function registerStartupDataIpcHandlers(
  ipcMain: IpcMainHandlePort,
  paths: Pick<ConfigFilePaths, "workspaceDatabasePath" | "providerDatabasePath">,
): void {
  ipcMain.handle(STARTUP_DATA_IPC_CHANNELS.listProjects, (): ProjectSummary[] =>
    listProjectWorkspaces(paths.workspaceDatabasePath).map((project) => ({
      projectId: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      directories: project.directories,
      sessions: project.sessions.map((session) => ({
        sessionId: session.id,
        name: session.name,
        updatedAt: session.updatedAt,
      })),
    })))

  ipcMain.handle(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions, (): SessionSummary[] =>
    readDefaultWorkspace(paths.workspaceDatabasePath).sessions.map((session) => ({
      sessionId: session.id,
      name: session.name,
      updatedAt: session.updatedAt,
    })))

  ipcMain.handle(STARTUP_DATA_IPC_CHANNELS.listProviders, (): ProviderSummary[] =>
    listProviders(paths.providerDatabasePath).map((provider) => ({
      providerId: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      models: provider.models.map((model) => ({ modelId: model.id, name: model.id })),
    })))
}
