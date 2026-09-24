/**
 * NiCode 的真实 Electron 主进程入口。
 *
 * 本文件直接构造 `startElectronApp` 的完整参数。启动期只初始化配置路径、Dispatcher、
 * Project Context、工具执行器和 BrowserWindow；Adapter 由每个 Turn 的工厂按磁盘状态创建。
 */

import { join } from "node:path"

import { app, BrowserWindow, dialog, ipcMain } from "electron"

import { initNetworkDispatcher } from "../../runtime/network/src/dispatcher.ts"
import {
  registerFileTools,
  bundledRipgrepPath,
  RenderRegistry,
  ToolRegistry,
} from "../../runtime/tools/src/index.ts"
import { initializeConfigFiles } from "./config-files.ts"
import { createElectronWindowManager } from "./electron-windows.ts"
import { startElectronApp } from "./index.ts"
import { SessionRuntimeGlobal } from "./session-runtime-global.ts"
import { loadFileAccessState } from "./file-access.ts"

const SYSTEM_PROMPT = "You are an AI agent powered by NiCode."

/**
 * 初始化进程级资源，并以真实实现逐字段调用 `startElectronApp`。
 *
 * @returns Electron ready、IPC 注册和首个 BrowserWindow 创建完成后解析的 Promise。
 * @throws Error 当启动配置、窗口端口或 Electron 生命周期初始化失败时抛出。
 */
async function main(): Promise<void> {
  const paths = await initializeConfigFiles()

  initNetworkDispatcher()
  const toolRegistry = new ToolRegistry()
  const renderRegistry = new RenderRegistry()
  registerFileTools(toolRegistry, renderRegistry, {
    rgPath: bundledRipgrepPath(join(__dirname, "../../..")),
    loadAccess: (projectId, sessionId) => loadFileAccessState(paths, projectId, sessionId),
  })
  const sessionRuntimeGlobal = new SessionRuntimeGlobal(paths, toolRegistry, renderRegistry)
  const windows = createElectronWindowManager(BrowserWindow, {
    preloadPath: join(__dirname, "../preload/index.js"),
    rendererHtmlPath: join(__dirname, "../renderer/index.html"),
    onWindowLoadFailure: (error) => {
      console.error("NiCode 主窗口页面装载失败。", error)
    },
  })

  await startElectronApp({
    app,
    ipcMain,
    dialog,
    windows,
    configPaths: paths,
    sessionRuntime: {
      systemPrompt: SYSTEM_PROMPT,
      global: sessionRuntimeGlobal,
    },
    onSessionCompletionFailure: ({ sessionId, turn, error }) => {
      console.error(`Session ${sessionId} 的 Turn ${turn} 在后台失败。`, error)
    },
  })
}

void main().catch((error: unknown) => {
  console.error("NiCode 启动失败。", error)
  process.exitCode = 1
  app.quit()
})
