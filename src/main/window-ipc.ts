/** 桌面窗口控制，不访问 Session、模型、配置或 Runtime。 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { WINDOW_IPC_CHANNELS } from "../preload/window-api.ts"
import type { WindowState } from "../preload/window-api.ts"

/**
 * 注册窗口专用请求；每次根据发送者解析当前窗口，拒绝子 frame 和失效窗口。
 * @param ipcMain 主进程 handler 注册能力；启动期间仅注册一次。
 * @param windows Electron 的发送者到窗口解析能力。
 * @returns 注册完成；不创建窗口或退出应用。
 * @throws Error 重复注册时由 Electron 抛出；无效请求在对应 IPC Promise 中拒绝。
 */
export function registerWindowIpcHandlers(ipcMain: Pick<IpcMain, "handle">, windows: Pick<typeof BrowserWindow, "fromWebContents">): void {
  /** @param event 当前请求的发送者。 @returns 仅属于该发送者的存活主 frame 窗口。 @throws Error 非法或已销毁窗口请求。 */
  function currentWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const window = windows.fromWebContents(event.sender)
    if (!window || window.isDestroyed() || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error("窗口控制来源无效")
    return window
  }
  ipcMain.handle(WINDOW_IPC_CHANNELS.minimize, (event): void => { currentWindow(event).minimize() })
  ipcMain.handle(WINDOW_IPC_CHANNELS.toggleMaximize, (event): WindowState => {
    const window = currentWindow(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return { maximized: window.isMaximized() }
  })
  ipcMain.handle(WINDOW_IPC_CHANNELS.getState, (event): WindowState => ({ maximized: currentWindow(event).isMaximized() }))
}
