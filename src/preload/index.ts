/** Electron preload 入口：只把经过约束的 NiCode API 暴露给 Renderer。 */

import { contextBridge, ipcRenderer } from "electron"

import {
  exposeSessionApi,
} from "./session-api.ts"
import { exposeWindowApi } from "./window-api.ts"

exposeSessionApi(contextBridge, ipcRenderer)
exposeWindowApi(contextBridge, ipcRenderer)

export * from "./session-api.ts"
