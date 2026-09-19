/** Electron preload 入口：只把经过约束的 NiCode API 暴露给 Renderer。 */

import {
  exposeSessionApi,
} from "./session-api.ts"
import type {
  ContextBridgePort,
  IpcRendererInvokePort,
} from "./session-api.ts"

interface ElectronPreloadModule {
  contextBridge: ContextBridgePort
  ipcRenderer: IpcRendererInvokePort
}

// Electron 由桌面壳在 preload 运行时提供；当前工程尚未安装 Electron 类型包。
const electron = require("electron") as ElectronPreloadModule
exposeSessionApi(electron.contextBridge, electron.ipcRenderer)

export * from "./session-api.ts"
