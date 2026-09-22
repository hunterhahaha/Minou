/** Electron `BrowserWindow` 到 NiCode 窗口生命周期端口的真实适配。 */

import { isAbsolute } from "node:path"

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
} from "electron"

import type { MainWindowLifecyclePort } from "./index.ts"

/** `BrowserWindow` 类在本模块使用的构造与静态能力。 */
export interface BrowserWindowConstructorPort {
  new(options: BrowserWindowConstructorOptions): BrowserWindow
  getAllWindows(): BrowserWindow[]
}

/** 主窗口静态资源和后台装载错误出口。 */
export interface ElectronWindowOptions {
  /** 编译后的 preload 入口绝对路径。 */
  preloadPath: string
  /** 构建复制后的静态 Renderer HTML 绝对路径。 */
  rendererHtmlPath: string
  /** `loadFile` 后台失败时的进程级错误出口。 */
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
    createMainWindow(): void {
      const window = new BrowserWindowClass({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        show: false,
        backgroundColor: "#111318",
        webPreferences: {
          preload: options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })
      retainedWindows.add(window)
      window.once("ready-to-show", () => window.show())
      window.once("closed", () => retainedWindows.delete(window))
      void window.loadFile(options.rendererHtmlPath).catch(options.onWindowLoadFailure)
    },
    hasOpenWindows(): boolean {
      return BrowserWindowClass.getAllWindows().length > 0
    },
  }
}
