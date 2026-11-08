/** Electron preload 入口：只把经过约束的 NiCode API 暴露给 Renderer。 */

import { contextBridge, ipcRenderer } from "electron"
import { BROWSER_COMMAND, BROWSER_STATE, FILE_EXPLORER_CHANNELS, type BrowserCommand, type NiCodeBrowserApi, type WebTagState } from "./browser-api.ts"

/** 向主进程提交浏览器命令。
 * @param command 受限浏览器命令
 * @returns 命令执行结果。
 */
function browserCommand(command: BrowserCommand): Promise<void> {
  return ipcRenderer.invoke(BROWSER_COMMAND, command)
}

import {
  exposeSessionApi,
} from "./session-api.ts"
import { exposeWindowApi } from "./window-api.ts"

exposeSessionApi(contextBridge, ipcRenderer)
exposeWindowApi(contextBridge, ipcRenderer)

export * from "./session-api.ts"

const browserApi: NiCodeBrowserApi = {
  createWebTag: (ref, url) => browserCommand({ action: "create", ref, url }),
  closeWebTag: (ref) => browserCommand({ action: "close", ref }),
  navigateWebTag: (ref, url) => browserCommand({ action: "navigate", ref, url }),
  goBack: (ref) => browserCommand({ action: "back", ref }),
  goForward: (ref) => browserCommand({ action: "forward", ref }),
  reload: (ref) => browserCommand({ action: "reload", ref }),
  present: (presentation) => browserCommand({ action: "present", presentation }),
  openFileExplorer: (source) => ipcRenderer.invoke(FILE_EXPLORER_CHANNELS.open, source),
  listExplorerDirectory: (handle, path) => ipcRenderer.invoke(FILE_EXPLORER_CHANNELS.list, handle, path),
  readExplorerFile: (handle, path) => ipcRenderer.invoke(FILE_EXPLORER_CHANNELS.read, handle, path),
  closeFileExplorer: (handle) => ipcRenderer.invoke(FILE_EXPLORER_CHANNELS.close, handle),
  onWebTagState(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: WebTagState) => listener(state)
    ipcRenderer.on(BROWSER_STATE, receive)
    return () => { ipcRenderer.removeListener(BROWSER_STATE, receive) }
  },
}
contextBridge.exposeInMainWorld("nicodeBrowser", browserApi)
