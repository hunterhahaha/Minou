/**
 * Electron 主进程的启动装配，注册 IPC、连接 Session Runtime 与窗口生命周期。
 *
 * 本文件依赖最小宿主端口；真实 Electron 对象、窗口配置和页面加载由桌面入口提供。
 */

import { join } from "node:path"

import { SessionRuntime } from "../../runtime/agent/src/session-runtime.ts"
import type { SessionRuntimeGlobal } from "./session-runtime-global.ts"
import type { ConfigFilePaths, ValidatedStartupConfig } from "./config-files.ts"
import { registerModelIpcHandlers } from "./provider-ipc.ts"
import { registerWebSearchIpcHandlers } from "./web-search-ipc.ts"
import { registerMcpIpcHandlers } from "./mcp-ipc.ts"
import { registerSkillIpcHandlers } from "./skill-ipc.ts"
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
import type { ElectronTray } from "./electron-tray.ts"
import { MEMBER_PROMPT, ROUTER_PROMPT, TeamMode } from "./team-mode.ts"

/** Electron 主进程启动装配使用的应用生命周期事件。 */
export type ElectronAppLifecycleEvent = "activate" | "window-all-closed" | "before-quit"

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
   * @param event 要监听的 Electron 应用事件。
   * @param listener 生命周期监听器，退出事件可先阻止退出以等待进程清理。
   */
  on(event: ElectronAppLifecycleEvent, listener: (event?: { preventDefault(): void }) => void): void
  /** 退出当前应用进程。 */
  quit(): void
}

/** BrowserWindow 具体实现之外，启动流程需要的窗口生命周期能力。 */
export interface MainWindowLifecyclePort {
  /**
   * 向存活主窗口发送当前对话更新，窗口发送失败交给宿主处理。
   *
   * @param update 向全部存活的 NiCode 窗口发送的更新。
   */
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
  /** 桌面宿主的托盘及关闭策略；无托盘的宿主可以省略。 */
  tray?: Pick<ElectronTray, "available" | "start" | "showMainWindow" | "beginQuit">
  /** 启动入口已经初始化并校验的配置路径。 */
  configPaths: ConfigFilePaths
  /** 真实桌面入口传入待连接的 MCP 配置；其它宿主可以自行初始化。 */
  mcpServers?: ValidatedStartupConfig["mcpServers"]
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
  const eventsPath = join(options.configPaths.rootDir, "events.sqlite")
  const team = new TeamMode(eventsPath, options.onSessionCompletionFailure,
    (projectId, sessionId) => options.sessionRuntime.global.closeSessionTerminals(projectId, sessionId))
  let processesDisposed = false
  let disposingProcesses = false
  let started = false

  /**
   * 为 IPC 请求构建绑定到指定 Project 分组的 Session Runtime。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param sessionId 要绑定的 Session 身份。
   * @returns 使用 `sessions/<project-id>/<session-id>` 目录的 Runtime。
   */
  const createRuntime: CreateSessionRuntime = (projectId, sessionId, onStateChanged, pendingTeam) => {
    const identity = pendingTeam ?? team.store.identity(projectId, sessionId)
    return new SessionRuntime({
      sessionId,
      sessionDirectory: join(sessionsDirectory, String(projectId), sessionId),
      projectGroupId: String(projectId),
      databasePath: eventsPath,
      metaDatabasePath: identity?.role === "member" ? eventsPath : options.configPaths.metaDatabasePath,
      systemPrompt: identity ? `${options.sessionRuntime.systemPrompt}\n\n${identity.role === "router" ? ROUTER_PROMPT : MEMBER_PROMPT}`
        : options.sessionRuntime.systemPrompt,
      global: options.sessionRuntime.global,
      onStateChanged,
      ...(identity && { team: team.runtime(identity) }),
    })
  }

  const sessionDispatch = registerSessionIpcHandlers(
    options.ipcMain,
    createRuntime,
    options.onSessionCompletionFailure,
    options.sessionEventForwarding ?? {
      sendSessionUpdateToRenderer: (update) => options.windows.sendSessionUpdate?.(update),
    },
    options.configPaths,
    team,
  )
  team.connect(sessionDispatch)
  registerStartupDataIpcHandlers(options.ipcMain, options.configPaths)
  registerModelIpcHandlers(options.ipcMain, options.configPaths)
  registerWebSearchIpcHandlers(options.ipcMain, options.configPaths)
  registerProjectIpcHandlers(options.ipcMain, options.dialog, options.configPaths)
  registerMcpIpcHandlers(options.ipcMain, options.configPaths, options.sessionRuntime.global.mcpManager)
  registerSkillIpcHandlers(options.ipcMain, options.configPaths, options.sessionRuntime.global.skillManager)

  options.app.on("before-quit", (event) => {
    if (processesDisposed) return
    event?.preventDefault()
    if (disposingProcesses) return
    disposingProcesses = true
    team.shutdown()
    void Promise.all([
      options.tray?.beginQuit(),
      sessionDispatch.shutdown().catch((error: unknown) => {
        options.onSessionCompletionFailure({ sessionId: "application", turn: 0, error })
      }),
      options.sessionRuntime.global.disposeProcessTools().catch((error: unknown) => {
        options.onSessionCompletionFailure({ sessionId: "application", turn: 0, error })
      }),
    ]).finally(() => {
      processesDisposed = true
      options.app.quit()
    })
  })
  options.app.on("activate", () => {
    if (!started || disposingProcesses) return
    if (options.tray) options.tray.showMainWindow()
    else if (!options.windows.hasOpenWindows()) options.windows.createMainWindow()
  })
  options.app.on("window-all-closed", () => {
    if (!disposingProcesses && !options.tray?.available && (options.platform ?? process.platform) !== "darwin") options.app.quit()
  })
  if (options.mcpServers) {
    const manager = options.sessionRuntime.global.mcpManager
    await manager.initialize(options.mcpServers)
    for (const state of manager.getConnectionStates()) {
      if (state.error) console.error(`MCP Server ${state.name} 初始化失败。`, state.error)
    }
  }
  await options.app.whenReady()
  if (disposingProcesses) return
  options.tray?.start()
  options.windows.createMainWindow()
  started = true
  sessionDispatch.restore()
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
