import { WebContentsView, session, type BrowserWindow, type IpcMain } from "electron"
import { randomUUID } from "node:crypto"
import { BROWSER_COMMAND, BROWSER_STATE, type BrowserCommand, type WebTagRef, type WebTagState } from "../preload/browser-api.ts"

/** 单个宿主拥有的网页实例及上一次布局版本。 */
interface Host {
  window: BrowserWindow
  views: Map<string, { view: WebContentsView; state: WebTagState; load(url: string): void }>
  visible?: WebContentsView
  revision: number
}

/** 校验网页身份并生成无分隔符冲突的索引。
 * @param ref Renderer 提交的标签引用
 * @returns 对话与标签联合键。
 * @throws Error 当身份缺失或不是字符串。
 */
function tagKey(ref: WebTagRef): string {
  if (typeof ref?.sessionId !== "string" || !ref.sessionId || typeof ref.tagId !== "string" || !ref.tagId) {
    throw new Error("无效的网页标签")
  }
  return JSON.stringify([ref.sessionId, ref.tagId])
}

/** 校验网页地址的协议。
 * @param value 待校验地址
 * @returns 地址是否使用 HTTP(S)。
 */
function isWebUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  const url = URL.parse(value)
  return url?.protocol === "https:" || url?.protocol === "http:"
}

/** 管理所有宿主的网页实例与共享网页存储。 */
export class TagManager {
  private readonly hosts = new Map<number, Host>()
  private browserSession?: Electron.Session

  /** 注册浏览器命令入口。
   * @param ipc Electron 主进程 IPC
   */
  constructor(ipc: IpcMain) {
    ipc.handle(BROWSER_COMMAND, (event, command: BrowserCommand) => {
      const host = this.hosts.get(event.sender.id)
      if (!host || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
        throw new Error("无权访问内置浏览器")
      }
      this.handle(host, command)
    })
  }

  /** 登记宿主并在文档销毁时释放网页实例。
   * @param window NiCode 主窗口
   */
  register(window: BrowserWindow): void {
    const id = window.webContents.id
    const host: Host = { window, views: new Map(), revision: -1 }
    this.hosts.set(id, host)
    const clear = () => {
      for (const key of host.views.keys()) this.close(host, key)
      host.revision = -1
    }
    window.webContents.on("did-start-navigation", (details, _url, isSameDocument, isMainFrame) => {
      if ((details.isMainFrame ?? isMainFrame) && !(details.isSameDocument ?? isSameDocument)) clear()
    })
    window.webContents.on("render-process-gone", clear)
    window.webContents.once("destroyed", () => {
      this.hosts.delete(id)
      clear()
    })
  }

  /** 移除一个视图并关闭其内容。
   * @param host 网页所属窗口
   * @param key 网页索引
   */
  private close(host: Host, key: string): void {
    const entry = host.views.get(key)
    if (!entry) return
    host.views.delete(key)
    if (host.visible === entry.view) host.visible = undefined
    if (!host.window.isDestroyed()) host.window.contentView.removeChildView(entry.view)
    const contents = entry.view.webContents
    if (contents && !contents.isDestroyed()) contents.close()
  }

  /** 创建隐藏的网页，并绑定与实例生命周期一致的状态通知。
   * @param host 网页所属窗口
   * @param key 网页索引
   * @param ref 网页标签身份
   * @param url 初始网页地址
   * @param child Chromium 为新窗口提供的视图选项与选中方式
   * @returns 新标签的视图。
   */
  private create(host: Host, key: string, ref: WebTagRef, url: string, child?: {
    // Electron supplies the Chromium-created contents at runtime; its public callback type omits it.
    options: Electron.BrowserWindowConstructorOptions & { webContents?: Electron.WebContents }
    opened: NonNullable<WebTagState["opened"]>
  }): WebContentsView {
    const existing = host.views.get(key)
    if (existing) return existing.view
    if (!this.browserSession) {
      this.browserSession = session.fromPartition("persist:nicode-browser")
      this.browserSession.setPermissionCheckHandler(() => false)
      this.browserSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
      this.browserSession.on("will-download", (event) => event.preventDefault())
    }
    const view = new WebContentsView(child?.options.webContents ? { webContents: child.options.webContents } : { webPreferences: {
      session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
    } })
    view.setVisible(false)
    const state: WebTagState = { ref, url, title: "", status: "loading", canGoBack: false, canGoForward: false }
    host.window.contentView.addChildView(view)
    const contents = view.webContents
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (!isWebUrl(url) && url !== "about:blank") return { action: "deny" }
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: {
          session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
        } },
        createWindow: (options) => {
          const childRef = { sessionId: ref.sessionId, tagId: randomUUID() }
          const opened = host.visible === view && disposition !== "background-tab" ? "foreground" : "background"
          return this.create(host, tagKey(childRef), childRef, url, { options, opened }).webContents
        },
      }
    })
    contents.on("will-navigate", (details, url) => { if (!isWebUrl(details.url ?? url)) details.preventDefault() })
    contents.on("will-redirect", (details, url) => { if (!isWebUrl(details.url ?? url)) details.preventDefault() })

    /** 发布当前实例状态，忽略已销毁的实例。 */
    const publish = () => {
      if (host.views.get(key)?.view !== view || contents.isDestroyed() || host.window.isDestroyed() || host.window.webContents.isDestroyed()) return
      state.canGoBack = contents.navigationHistory.canGoBack()
      state.canGoForward = contents.navigationHistory.canGoForward()
      host.window.webContents.send(BROWSER_STATE, state)
    }
    contents.on("did-start-navigation", (details, url, isSameDocument, isMainFrame) => {
      if (!(details.isMainFrame ?? isMainFrame) || (details.isSameDocument ?? isSameDocument)) return
      const address = details.url ?? url
      if (!isWebUrl(address)) return
      state.url = address
      state.title = ""
      state.status = "loading"
      state.error = undefined
      publish()
    })
    contents.on("did-navigate", (_event, address) => { state.url = address; publish() })
    contents.on("did-navigate-in-page", (_event, address, mainFrame) => {
      if (mainFrame) { state.url = address; publish() }
    })
    contents.on("page-title-updated", (_event, title) => { state.title = title; publish() })
    contents.on("did-finish-load", () => {
      // Chromium may finish rendering its internal error page after reporting failure.
      if (state.status === "error") return
      state.status = "ready"
      publish()
    })
    contents.on("did-fail-load", (_event, code, message, address, mainFrame) => {
      if (!mainFrame || code === -3) return
      if (isWebUrl(address)) state.url = address
      state.status = "error"
      state.error = message
      publish()
    })
    contents.on("render-process-gone", () => {
      state.status = "error"
      state.error = "网页进程已退出，请刷新重试"
      publish()
    })
    let loadVersion = 0
    /** 启动地址栏导航，并处理 Chromium 尚未提交文档时的失败。
     * @param address 已校验的 HTTP(S) 地址
     */
    const load = (address: string) => {
      const version = ++loadVersion
      state.url = address
      state.title = ""
      state.status = "loading"
      state.error = undefined
      publish()
      void contents.loadURL(address).catch((error: NodeJS.ErrnoException) => {
        if (version !== loadVersion || error.code === "ERR_ABORTED" || contents.isDestroyed()) return
        state.status = "error"
        state.error = error.code ?? error.message
        publish()
      })
    }
    host.views.set(key, { view, state, load })
    contents.once("destroyed", () => {
      if (!host.views.has(key)) return
      this.close(host, key)
      if (!host.window.isDestroyed() && !host.window.webContents.isDestroyed()) {
        host.window.webContents.send(BROWSER_STATE, { ...state, closed: true })
      }
    })
    if (child) {
      state.opened = child.opened
      publish()
      delete state.opened
      if (!child.options.webContents) load(url)
    } else load(url)
    return view
  }

  /** 校验并执行窗口级浏览器命令。
   * @param host 发起命令的宿主
   * @param command Renderer 请求
   * @throws Error 当请求、引用或 URL 无效。
   */
  private handle(host: Host, command: BrowserCommand): void {
    if (command?.action === "present") {
      const { revision, active } = command.presentation
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("无效的浏览器布局版本")
      if (revision <= host.revision) return
      const entry = active && host.views.get(tagKey(active.ref))
      const bounds = active?.bounds
      if (active && (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        || bounds.width < 0 || bounds.height < 0)) throw new Error("无效的浏览器布局尺寸")
      host.revision = revision
      if (host.visible && host.visible !== (entry && entry.view)) host.visible.setVisible(false)
      host.visible = undefined
      if (!entry || !bounds) return
      const zoom = host.window.webContents.getZoomFactor()
      const [width, height] = host.window.getContentSize()
      const x = Math.max(0, Math.round(bounds.x * zoom))
      const y = Math.max(0, Math.round(bounds.y * zoom))
      const right = Math.min(width, Math.round((bounds.x + bounds.width) * zoom))
      const bottom = Math.min(height, Math.round((bounds.y + bounds.height) * zoom))
      if (right <= x || bottom <= y || entry.state.status === "error") {
        entry.view.setVisible(false)
        return
      }
      entry.view.setBounds({ x, y, width: right - x, height: bottom - y })
      entry.view.setVisible(true)
      host.visible = entry.view
      return
    }
    const key = tagKey(command?.ref)
    if (command.action === "close") { this.close(host, key); return }
    if (command.action === "create" || command.action === "navigate") {
      if (!isWebUrl(command.url)) throw new Error("仅支持 HTTP 或 HTTPS 地址")
      if (command.action === "create") { this.create(host, key, command.ref, command.url); return }
    }
    const entry = host.views.get(key)
    if (!entry) throw new Error("网页标签已关闭")
    const contents = entry.view.webContents
    switch (command.action) {
      case "navigate": entry.load(command.url); break
      case "reload":
        if (entry.state.status === "error") entry.load(entry.state.url)
        else contents.reload()
        break
      case "back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break
      case "forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break
      default: throw new Error("未知的浏览器命令")
    }
  }
}
