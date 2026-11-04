/**
 * NiCode 的真实 Electron 主进程入口。
 *
 * 本文件直接构造 `startElectronApp` 的完整参数。启动期只初始化配置路径、Dispatcher、
 * Project Context、全局 MCPManager、工具执行器和 BrowserWindow；Adapter 由每个 Turn 的工厂按磁盘状态创建。
 */

import { join } from "node:path"

import { app, BrowserWindow, dialog, ipcMain } from "electron"

import { initNetworkDispatcher } from "../../runtime/network/src/dispatcher.ts"
import { MemoryManager } from "../../runtime/memory/src/index.ts"
import {
  registerFileTools,
  registerMemoryTools,
  registerWebSearchTool,
  registerWebFetchTool,
  WEB_SEARCH_DATABASE_FILE,
  bundledRipgrepPath,
  RenderRegistry,
  ToolRegistry,
} from "../../runtime/tools/src/index.ts"
import { initializeConfigFilesSnapshot } from "./config-files.ts"
import { TagManager } from "./tag-manager.ts"
import { createElectronWindowManager } from "./electron-windows.ts"
import { startElectronApp } from "./index.ts"
import { SessionRuntimeGlobal } from "./session-runtime-global.ts"
import { loadFileAccessState } from "./file-access.ts"
import { registerWindowIpcHandlers } from "./window-ipc.ts"

const SYSTEM_PROMPT = "You are an AI agent powered by NiCode."

/**
 * 初始化进程级资源，并以真实实现逐字段调用 `startElectronApp`。
 *
 * @returns Electron ready、IPC 注册和首个 BrowserWindow 创建完成后解析的 Promise。
 * @throws Error 当启动配置、窗口端口或 Electron 生命周期初始化失败时抛出。
 */
async function main(): Promise<void> {
  const { paths, config } = await initializeConfigFilesSnapshot()

  initNetworkDispatcher()
  const toolRegistry = new ToolRegistry()
  const renderRegistry = new RenderRegistry()
  registerFileTools(toolRegistry, renderRegistry, {
    rgPath: bundledRipgrepPath(join(__dirname, "../../..")),
    loadAccess: (projectId, sessionId) => loadFileAccessState(paths, projectId, sessionId),
  })
  const memoryManager = new MemoryManager(paths.rootDir)
  registerMemoryTools(toolRegistry, renderRegistry, memoryManager)
  registerWebSearchTool(toolRegistry, renderRegistry, join(paths.rootDir, WEB_SEARCH_DATABASE_FILE))
  registerWebFetchTool(toolRegistry, renderRegistry)
  const sessionRuntimeGlobal = new SessionRuntimeGlobal(paths, toolRegistry, renderRegistry)
  await sessionRuntimeGlobal.mcpManager.initialize(config.mcpServers)
  for (const state of sessionRuntimeGlobal.mcpManager.getConnectionStates()) {
    if (state.error) console.error(`MCP Server ${state.name} 初始化失败。`, state.error)
  }
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  const windows = createElectronWindowManager(BrowserWindow, {
    browserTags: new TagManager(ipcMain),
    preloadPath: join(__dirname, "../preload/index.js"),
    rendererHtmlPath: join(__dirname, "../renderer/index.html"),
    rendererUrl: process.env.NICODE_RENDERER_URL,
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
