/** Electron `BrowserWindow` 到 NiCode 窗口生命周期端口的真实适配。 */

import { isAbsolute } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMain,
  IpcMainInvokeEvent,
} from "electron"

import type { MainWindowLifecyclePort } from "./index.ts"
import { SESSION_IPC_CHANNELS } from "../preload/session-api.ts"
import type { SessionUpdate } from "../preload/session-api.ts"
import { WINDOW_IPC_CHANNELS } from "../preload/window-api.ts"

/** `BrowserWindow` 类在本模块使用的构造与静态能力。 */
export interface BrowserWindowConstructorPort {
  new(options: BrowserWindowConstructorOptions): BrowserWindow
  /**
   * 查询当前 Electron 窗口集合，不创建新窗口。
   *
   * @returns 当前全部窗口实例。
   */
  getAllWindows(): BrowserWindow[]
}

/** 主窗口静态资源和后台装载错误出口。 */
export interface ElectronWindowOptions {
  /** 编译后的 preload 入口绝对路径。 */
  preloadPath: string
  /** 登记允许调用浏览器 IPC 的窗口。 */
  browserTags?: import("./tag-manager.ts").TagManager
  /** Vite 构建后的 Renderer HTML 绝对路径。 */
  rendererHtmlPath: string
  /** 开发时 Vite Renderer 地址；未提供时从构建后的 HTML 加载。 */
  rendererUrl?: string
  /** 在系统浏览器中打开已检查的 HTTP(S) 外链；不复用带 preload 的主窗口。 */
  openExternal?(url: string): void
  /** 为已创建的主窗口登记桌面关闭策略。 */
  onWindowCreated?(window: BrowserWindow): void
  /**
   * Renderer 页面后台装载失败时的进程级错误出口。
   * @param error 后台页面加载时捕获的原始错误。
   */
  onWindowLoadFailure(error: unknown): void
}

/** 桌面窗口生命周期及其 IPC 来源检查。 */
export interface ElectronWindowManager extends MainWindowLifecyclePort {
  /** 显示并聚焦已有主窗口，或创建一个新窗口。 */
  showMainWindow(): void
  /**
   * 切换主窗口的显示状态，关闭或最小化后可再次恢复。
   * @param keepTaskbar 隐藏方向改为任务栏最小化时为 true。
   */
  toggleMainWindowVisibility(keepTaskbar: boolean): void
  /**
   * 检查存活主窗口、主 frame 和当前文档地址，不信任仅有同源地址的其它窗口。
   * @param event Electron IPC 请求身份。
   * @returns 请求来自本管理器拥有的 NiCode 文档时为 true。
   */
  isTrustedSender(event: IpcMainInvokeEvent): boolean
}

/**
 * 为所有桌面 IPC 通道统一检查来源；参数校验仍由各通道处理。
 * @param ipcMain Electron 原始注册端口。
 * @param trusted 检查请求是否来自可信主文档。
 * @returns 具有相同注册契约的受保护端口。
 */
export function createTrustedIpcMain(
  ipcMain: Pick<IpcMain, "handle">,
  trusted: (event: IpcMainInvokeEvent) => boolean,
): Pick<IpcMain, "handle"> {
  return { handle(channel, listener): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error("IPC 请求来源无效")
      return listener(event, ...args)
    })
  } }
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
): ElectronWindowManager {
  if (!isAbsolute(options.preloadPath)) {
    throw new Error(`Electron preload 路径必须是绝对路径：${options.preloadPath}`)
  }
  if (!isAbsolute(options.rendererHtmlPath)) {
    throw new Error(`Electron Renderer 路径必须是绝对路径：${options.rendererHtmlPath}`)
  }

  const rendererAddress = new URL(options.rendererUrl ?? pathToFileURL(options.rendererHtmlPath).href)
  rendererAddress.hash = ""
  /** @param value 文档或导航地址。 @returns 除 hash 路由外与入口完全一致时为 true。 */
  const isRendererAddress = (value: string): boolean => {
    try {
      const address = new URL(value)
      address.hash = ""
      if (address.protocol === "file:" && rendererAddress.protocol === "file:") {
        // Chromium and Node can serialize the same file path differently, e.g. "~" and "%7E".
        return address.search === rendererAddress.search && fileURLToPath(address) === fileURLToPath(rendererAddress)
      }
      return address.href === rendererAddress.href
    } catch { return false }
  }
  /** @param value 已被主窗口拒绝的目标。仅 HTTP(S) 外链交给系统浏览器。 */
  const openWebLink = (value: string): void => {
    const address = URL.parse(value)
    if (address?.protocol === "https:" || address?.protocol === "http:") options.openExternal?.(address.href)
  }
  const retainedWindows = new Set<BrowserWindow>()
  const awaitingFirstShow = new Set<BrowserWindow>()
  /**
   * 选择一个仍存活的 NiCode 主窗口。
   * @returns 聚焦窗口优先，否则返回最近创建的主窗口或 undefined。
   */
  function mainWindow(): BrowserWindow | undefined {
    const alive = [...retainedWindows].filter((window) => !window.isDestroyed())
    return alive.find((window) => window.isFocused()) ?? alive.at(-1)
  }
  const manager: ElectronWindowManager = {
    showMainWindow(): void {
      const window = mainWindow()
      if (!window) {
        manager.createMainWindow()
        return
      }
      if (awaitingFirstShow.has(window)) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    },
    toggleMainWindowVisibility(keepTaskbar): void {
      const window = mainWindow()
      if (!window || !window.isVisible() || window.isMinimized()) {
        manager.showMainWindow()
      } else if (keepTaskbar) {
        window.minimize()
      } else {
        window.hide()
      }
    },
    isTrustedSender(event): boolean {
      for (const window of retainedWindows) {
        if (window.isDestroyed()) continue
        const contents = window.webContents
        if (contents.isDestroyed() || event.sender !== contents) continue
        return event.senderFrame !== null && event.senderFrame === contents.mainFrame
          && isRendererAddress(event.senderFrame.url) && isRendererAddress(contents.getURL())
      }
      return false
    },
    /**
     * 向存活主窗口发送当前对话更新，窗口发送失败交给宿主处理。
     *
     * @param update 对话更新；单窗失败不会阻止其余窗口接收。
     * @throws AggregateError 有窗口发送失败。
     */
    sendSessionUpdate(update: SessionUpdate): void {
      const failures: unknown[] = []
      for (const window of retainedWindows) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        if (!isRendererAddress(window.webContents.getURL())) continue
        try { window.webContents.send(SESSION_IPC_CHANNELS.update, update) }
        catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, "Session 窗口更新发送失败")
    },
    /**
     * 构造并保留主窗口，装载开发地址或本地页面，按加载结果显示窗口。
     *
     * @throws Error 窗口构造等同步错误向上传播；异步加载失败交给宿主回调并尝试显示窗口。
     */
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
      awaitingFirstShow.add(window)
      options.onWindowCreated?.(window)
      window.webContents.on("will-navigate", (event, url) => {
        const target = event.url ?? url
        if (isRendererAddress(target)) return
        event.preventDefault()
        openWebLink(target)
      })
      window.webContents.on("will-redirect", (event, url) => {
        if (!isRendererAddress(event.url ?? url)) event.preventDefault()
      })
      window.webContents.setWindowOpenHandler(({ url }) => {
        openWebLink(url)
        return { action: "deny" }
      })
      options.browserTags?.register(window)
      /** 同步系统触发的最大化/还原；尺寸和拖动仍由 Electron 管理。 */
      const sendWindowState = (): void => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(WINDOW_IPC_CHANNELS.stateChanged, { maximized: window.isMaximized() })
      }
      window.on("maximize", sendWindowState)
      window.on("unmaximize", sendWindowState)
      /**
       * Electron 首帧事件或页面装载结束后只显示一次主窗口。
       * @returns 窗口显示完成时无返回值。
       */
      const showWindow = (): void => {
        if (!awaitingFirstShow.delete(window) || window.isDestroyed()) return
        window.show()
      }

      window.once("ready-to-show", showWindow)
      window.once("closed", () => {
        awaitingFirstShow.delete(window)
        retainedWindows.delete(window)
      })
      const pageLoad = options.rendererUrl === undefined
        ? window.loadFile(options.rendererHtmlPath)
        : window.loadURL(options.rendererUrl)
      void pageLoad.then(showWindow).catch((error: unknown) => {
        if (window.isDestroyed()) return
        options.onWindowLoadFailure(error)
        showWindow()
      })
    },
    /**
     * 查询 Electron 当前窗口集合，不创建新窗口。
     *
     * @returns 当前是否至少存在一个打开的窗口。
     */
    hasOpenWindows(): boolean {
      return BrowserWindowClass.getAllWindows().length > 0
    },
  }
  return manager
}
