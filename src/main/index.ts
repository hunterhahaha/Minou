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

import {
  SessionRuntimeBindings,
  SessionRuntimePorts,
} from "../../runtime/agent/src/session-runtime.ts"
import type { CurrentSessionBaseline } from "../../runtime/session/src/session-state.ts"
import type { ProjectId } from "../../runtime/session/src/project-id.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { registerStartupDataIpcHandlers } from "./startup-data-ipc.ts"
import { registerSessionIpcHandlers } from "./session-ipc.ts"
import type {
  CreateSessionRuntime,
  HandleSessionCompletionFailure,
  IpcMainHandlePort,
  SessionEventForwardingPort,
} from "./session-ipc.ts"

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
  /** 创建并开始装载一个主窗口。 */
  createMainWindow(): void
  /**
   * 检查当前是否仍有打开的窗口。
   *
   * @returns 至少有一个窗口仍打开时返回 true。
   */
  hasOpenWindows(): boolean
}

/** `SessionRuntimeBindings` 当前构造函数接受的完整参数。 */
type SessionRuntimeBindingsOptions = ConstructorParameters<typeof SessionRuntimeBindings>[0]

/** 一个 Project/default 分组为 SessionRuntime 提供的固定上下文来源。 */
export interface SessionRuntimeProjectContext {
  /** 当前 Project/default 的工作区说明。 */
  workspaceInfo: string
  /**
   * 读取当前 Project 的 AGENTS.md、Skill 与 MCP 基线。
   *
   * @returns 当前 Turn 开始与上下文构建共同使用的固定基线。
   */
  resolveCurrentBaseline(): Promise<CurrentSessionBaseline>
}

/**
 * 按 Project 身份取得一个 SessionRuntime 的固定上下文来源。
 *
 * @param projectId IPC 边界已经检查过的 UUID 或 default。
 * @returns 当前 Project 的工作区说明与异步 baseline 解析函数。
 * @throws Error 当 Project 尚未初始化或其上下文来源无法建立时抛出。
 */
export type ResolveSessionRuntimeProjectContext = (
  projectId: ProjectId,
) => SessionRuntimeProjectContext

/**
 * 启动期共享的 SessionRuntime 宿主依赖。
 *
 * Session 身份、目录、workspaceInfo 与 baseline 由每次 IPC 请求依据 projectId 填写，
 * 不允许启动入口提前固化为所有 Project 共用的一份值。
 */
export type SessionRuntimeStartupDependencies = Omit<
  SessionRuntimeBindingsOptions,
  "sessionId" | "sessionDirectory" | "projectGroupId" | "databasePath" | "metaDatabasePath" | "workspaceInfo" | "resolveCurrentBaseline"
> & {
  /** 按 Project 身份取得当前 Session 的固定上下文来源。 */
  resolveProjectContext: ResolveSessionRuntimeProjectContext
}

/** Electron 可执行入口完成真实依赖装配后交给 `startElectronApp` 的输入。 */
export interface ElectronStartupOptions {
  /** Electron 应用生命周期端口。 */
  app: ElectronAppPort
  /** Electron 主进程 IPC handler 注册端口。 */
  ipcMain: IpcMainHandlePort
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
  const createRuntime: CreateSessionRuntime = (projectId, sessionId) => {
    const projectContext = options.sessionRuntime.resolveProjectContext(projectId)
    const bindings = new SessionRuntimeBindings({
      sessionId,
      sessionDirectory: join(sessionsDirectory, String(projectId), sessionId),
      projectGroupId: String(projectId),
      databasePath: join(options.configPaths.rootDir, "events.sqlite"),
      metaDatabasePath: options.configPaths.metaDatabasePath,
      systemPrompt: options.sessionRuntime.systemPrompt,
      workspaceInfo: projectContext.workspaceInfo,
      resolveCurrentBaseline: () => projectContext.resolveCurrentBaseline(),
      estimateSkillTokens: options.sessionRuntime.estimateSkillTokens,
      createTurnModelAdapter: options.sessionRuntime.createTurnModelAdapter,
      executeTool: options.sessionRuntime.executeTool,
      now: options.sessionRuntime.now,
      createEventId: options.sessionRuntime.createEventId,
    })
    return new SessionRuntimePorts(sessionId, bindings)
  }

  registerSessionIpcHandlers(
    options.ipcMain,
    createRuntime,
    options.onSessionCompletionFailure,
    options.sessionEventForwarding,
  )
  registerStartupDataIpcHandlers(options.ipcMain, options.configPaths)

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
  CreateSessionRuntime,
  HandleSessionCompletionFailure,
  IpcMainHandlePort,
  SessionCompletionFailure,
  SessionEventForwardingPort,
} from "./session-ipc.ts"
