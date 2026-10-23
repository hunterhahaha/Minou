/** Electron `BrowserWindow` 到 NiCode 窗口生命周期端口的真实适配。 */

import { isAbsolute } from "node:path"

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
} from "electron"

import type { MainWindowLifecyclePort } from "./index.ts"
import { SESSION_IPC_CHANNELS } from "../preload/session-api.ts"
import type { SessionUpdate } from "../preload/session-api.ts"
import { WINDOW_IPC_CHANNELS } from "../preload/window-api.ts"

/** `BrowserWindow` 类在本模块使用的构造与静态能力。 */
export interface BrowserWindowConstructorPort {
  new(options: BrowserWindowConstructorOptions): BrowserWindow
  getAllWindows(): BrowserWindow[]
}

/** 主窗口静态资源和后台装载错误出口。 */
export interface ElectronWindowOptions {
  /** 编译后的 preload 入口绝对路径。 */
  preloadPath: string
  /** Vite 构建后的 Renderer HTML 绝对路径。 */
  rendererHtmlPath: string
  /** 开发时 Vite Renderer 地址；未提供时从构建后的 HTML 加载。 */
  rendererUrl?: string
  /** Renderer 页面后台装载失败时的进程级错误出口。 */
  onWindowLoadFailure(error: unknown): void
}

/**
 * 用真实 BrowserWindow 类创建 `startElectronApp` 需要的窗口端口。
 *
 * preload 当前由多个 CommonJS 文件组成、未使用打包器，因此显式关闭 Chromium preload sandbox；
 * Renderer 仍保持 `contextIsolation=true` 与 `nodeIntegration=false`，只能通过 contextBridge 使用 API。
 *
 * @param BrowserWindowClass Electron 提供的 BrowserWindow 构造器。
 * @param options preload、Renderer 文件路径及装载错误出口。
 * @returns 可创建主窗口并检查窗口存活状态的端口。
 * @throws Error 当任一静态资源路径不是绝对路径时立即抛出。
 */
export function createElectronWindowManager(
  BrowserWindowClass: BrowserWindowConstructorPort,
  options: ElectronWindowOptions,
): MainWindowLifecyclePort {
  if (!isAbsolute(options.preloadPath)) {
    throw new Error(`Electron preload 路径必须是绝对路径：${options.preloadPath}`)
  }
  if (!isAbsolute(options.rendererHtmlPath)) {
    throw new Error(`Electron Renderer 路径必须是绝对路径：${options.rendererHtmlPath}`)
  }

  const retainedWindows = new Set<BrowserWindow>()
  return {
    /** @param update 对话更新；单窗失败不会阻止其余窗口接收。 @throws AggregateError 有窗口发送失败。 */
    sendSessionUpdate(update: SessionUpdate): void {
      const failures: unknown[] = []
      for (const window of retainedWindows) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        try { window.webContents.send(SESSION_IPC_CHANNELS.update, update) }
        catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, "Session 窗口更新发送失败")
    },
    createMainWindow(): void {
      const window = new BrowserWindowClass({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        show: false,
        backgroundColor: "#f0f1ed",
        frame: false,
        autoHideMenuBar: true,
        webPreferences: {
          preload: options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })
      retainedWindows.add(window)
      /** 同步系统触发的最大化/还原；尺寸和拖动仍由 Electron 管理。 */
      const sendWindowState = (): void => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(WINDOW_IPC_CHANNELS.stateChanged, { maximized: window.isMaximized() })
      }
      window.on("maximize", sendWindowState)
      window.on("unmaximize", sendWindowState)
      let windowHasBeenShown = false
      /**
       * Electron 首帧事件或页面装载结束后只显示一次主窗口。
       * @returns 窗口显示完成时无返回值。
       */
      const showWindow = (): void => {
        if (windowHasBeenShown) return
        windowHasBeenShown = true
        window.show()
      }

      window.once("ready-to-show", showWindow)
      window.once("closed", () => retainedWindows.delete(window))
      const pageLoad = options.rendererUrl === undefined
        ? window.loadFile(options.rendererHtmlPath)
        : window.loadURL(options.rendererUrl)
      void pageLoad.then(showWindow).catch((error: unknown) => {
        options.onWindowLoadFailure(error)
        showWindow()
      })
    },
    hasOpenWindows(): boolean {
      return BrowserWindowClass.getAllWindows().length > 0
    },
  }
}
