/**
 * Electron 主进程的可测试启动装配。
 *
 * 进程划分（AGENTS.md 实现约定）：主进程承载 Runtime，渲染进程承载 UI。本文件只依赖
 * Electron 生命周期、IPC 与窗口管理的最小宿主端口；真实 Electron 包、BrowserWindow 参数和
 * Renderer 页面加载由之后的桌面壳入口提供。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 1、4、28、29 节
 */

import { join } from "node:path"

import { SessionRuntime } from "../../runtime/agent/src/session-runtime.ts"
import type { SessionRuntimeGlobal } from "./session-runtime-global.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { registerModelIpcHandlers } from "./provider-ipc.ts"
import { registerStartupDataIpcHandlers } from "./startup-data-ipc.ts"
import { registerProjectIpcHandlers } from "./project-ipc.ts"
import type { DirectoryDialogPort } from "./project-ipc.ts"
import { registerSessionIpcHandlers } from "./session-ipc.ts"
import type {
  CreateSessionRuntime,
  HandleSessionCompletionFailure,
  SessionEventForwardingPort,
  IpcMainHandlePort,
} from "./session-ipc.ts"
import type { SessionUpdate } from "../preload/session-api.ts"

/** Electron 主进程启动装配使用的应用生命周期事件。 */
export type ElectronAppLifecycleEvent = "activate" | "window-all-closed"

/** Electron `app` 在当前启动流程中需要提供的最小能力。 */
export interface ElectronAppPort {
  /**
   * 等待 Electron 完成初始化。
   *
   * @returns 应用进入可创建窗口状态时完成的 Promise。
   */
  whenReady(): Promise<void>
  /**
   * 注册应用生命周期监听器。
   *
   * @param event 要监听的 Electron 应用事件。
   * @param listener 事件发生时同步执行的监听器。
   */
  on(event: ElectronAppLifecycleEvent, listener: () => void): void
  /** 退出当前应用进程。 */
  quit(): void
}

/** BrowserWindow 具体实现之外，启动流程需要的窗口生命周期能力。 */
export interface MainWindowLifecyclePort {
  /** @param update 向全部存活的 NiCode 窗口发送的更新。 */
  sendSessionUpdate?(update: SessionUpdate): void
  /** 创建并开始装载一个主窗口。 */
  createMainWindow(): void
  /**
   * 检查当前是否仍有打开的窗口。
   *
   * @returns 至少有一个窗口仍打开时返回 true。
   */
  hasOpenWindows(): boolean
}

/** 主进程为所有 Session 共用的运行能力与基础 System Prompt。 */
export interface SessionRuntimeStartupDependencies {
  systemPrompt: string
  global: SessionRuntimeGlobal
}

/** Electron 可执行入口完成真实依赖装配后交给 `startElectronApp` 的输入。 */
export interface ElectronStartupOptions {
  /** Electron 应用生命周期端口。 */
  app: ElectronAppPort
  /** Electron 主进程 IPC handler 注册端口。 */
  ipcMain: IpcMainHandlePort
  /** 系统目录选择窗口。 */
  dialog: DirectoryDialogPort
  /** 主窗口创建与存活状态端口。 */
  windows: MainWindowLifecyclePort
  /** 启动入口已经初始化并校验的配置路径。 */
  configPaths: ConfigFilePaths
  /** 每个 Project Session 共用的 Runtime 宿主依赖。 */
  sessionRuntime: SessionRuntimeStartupDependencies
  /** 后台 Turn 或 Renderer 事件发送失败时的错误出口。 */
  onSessionCompletionFailure: HandleSessionCompletionFailure
  /** 可选的内部 SessionEvent 筛选与 Renderer 发送出口。 */
  sessionEventForwarding?: SessionEventForwardingPort
  /** 测试或宿主覆盖的平台；省略时使用当前 Node 进程平台。 */
  platform?: NodeJS.Platform
}

/**
 * 消费已构建的启动 options，注册 Session IPC，并接入 Electron 窗口生命周期。
 *
 * IPC 提供的 Project 身份用作 `sessions/<project-id>` 分组目录名。该函数只应在同一个 `ipcMain`
 * 上调用一次；重复调用时由 IPC 实现报告重复 handler 注册错误。
 *
 * @param options Electron 端口、窗口端口、Runtime 宿主依赖与错误出口。
 * @returns 首个主窗口创建完成后解析的 Promise。
 * @throws Error 当 IPC 注册、Electron ready 或首窗创建失败时抛出。后续 IPC 请求创建 Runtime 时，
 * Project Context 解析或 Runtime 构造错误由对应 handler 继续抛给调用方。
 */
export async function startElectronApp(options: ElectronStartupOptions): Promise<void> {
  const sessionsDirectory = join(options.configPaths.rootDir, "sessions")

  /**
   * 为 IPC 请求构建绑定到指定 Project 分组的 Session Runtime。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param sessionId 要绑定的 Session 身份。
   * @returns 使用 `sessions/<project-id>/<session-id>` 目录的 Runtime。
   */
  const createRuntime: CreateSessionRuntime = (projectId, sessionId, onStateChanged) => {
    return new SessionRuntime({
      sessionId,
      sessionDirectory: join(sessionsDirectory, String(projectId), sessionId),
      projectGroupId: String(projectId),
      databasePath: join(options.configPaths.rootDir, "events.sqlite"),
      metaDatabasePath: options.configPaths.metaDatabasePath,
      systemPrompt: options.sessionRuntime.systemPrompt,
      global: options.sessionRuntime.global,
      onStateChanged,
    })
  }

  registerSessionIpcHandlers(
    options.ipcMain,
    createRuntime,
    options.onSessionCompletionFailure,
    options.sessionEventForwarding ?? {
      sendSessionUpdateToRenderer: (update) => options.windows.sendSessionUpdate?.(update),
    },
    options.configPaths,
  )
  registerStartupDataIpcHandlers(options.ipcMain, options.configPaths)
  registerModelIpcHandlers(options.ipcMain, options.configPaths)
  registerProjectIpcHandlers(options.ipcMain, options.dialog, options.configPaths)

  await options.app.whenReady()
  options.app.on("activate", () => {
    if (!options.windows.hasOpenWindows()) options.windows.createMainWindow()
  })
  options.app.on("window-all-closed", () => {
    if ((options.platform ?? process.platform) !== "darwin") options.app.quit()
  })
  options.windows.createMainWindow()
}

export { initializeConfigFiles } from "./config-files.ts"
export type { ConfigFilePaths } from "./config-files.ts"
export { registerSessionIpcHandlers }
export type {
  IpcMainHandlePort,
  CreateSessionRuntime,
  HandleSessionCompletionFailure,
  SessionCompletionFailure,
  SessionEventForwardingPort,
} from "./session-ipc.ts"
