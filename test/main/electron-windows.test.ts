/** BrowserWindow 真实适配层的配置和生命周期测试。 */

import assert from "node:assert/strict"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent } from "electron"

import {
  createElectronWindowManager,
  createTrustedIpcMain,
} from "../../src/main/electron-windows.ts"
import type {
  BrowserWindowConstructorPort,
} from "../../src/main/electron-windows.ts"
import type { SessionUpdate } from "../../src/preload/session-api.ts"
import { SESSION_IPC_CHANNELS } from "../../src/preload/session-api.ts"

type Listener = () => void

/** 记录构造参数、文件加载与事件监听器的最小假窗口。 */
class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  static loadFailure: unknown | undefined
  readonly listeners = new Map<string, Listener>()
  readonly options: BrowserWindowConstructorOptions
  loadedPath: string | undefined
  loadedUrl: string | undefined
  showCalls = 0
  destroyed = false
  sendFailure?: Error
  sent: Array<{ channel: string; update: SessionUpdate }> = []
  navigation = new Map<string, (event: { url: string; preventDefault(): void }, url: string) => void>()
  openWindow?: (details: { url: string }) => { action: string }
  webContents = {
    mainFrame: { url: "" },
    getURL: () => this.webContents.mainFrame.url,
    on: (event: string, listener: (event: { url: string; preventDefault(): void }, url: string) => void) => { this.navigation.set(event, listener) },
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => { this.openWindow = handler },
    isDestroyed: () => this.destroyed,
    send: (channel: string, update: SessionUpdate) => {
      if (this.sendFailure) throw this.sendFailure
      this.sent.push({ channel, update })
    },
  }
  /** @returns 当前窗口是否已销毁。 */
  isDestroyed(): boolean { return this.destroyed }

  constructor(options: BrowserWindowConstructorOptions) {
    this.options = options
    FakeBrowserWindow.instances.push(this)
  }

  static getAllWindows(): FakeBrowserWindow[] {
    return [...FakeBrowserWindow.instances]
  }

  once(event: string, listener: Listener): this {
    this.listeners.set(event, listener)
    return this
  }

  /** @param event 窗口状态事件。 @param listener 状态同步回调。 @returns 当前假窗口。 */
  on(event: string, listener: Listener): this {
    this.listeners.set(event, listener)
    return this
  }

  show(): void {
    this.showCalls += 1
  }

  async loadFile(path: string): Promise<void> {
    this.loadedPath = path
    this.webContents.mainFrame.url = pathToFileURL(path).href
    if (FakeBrowserWindow.loadFailure !== undefined) throw FakeBrowserWindow.loadFailure
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrl = url
    this.webContents.mainFrame.url = url
    if (FakeBrowserWindow.loadFailure !== undefined) throw FakeBrowserWindow.loadFailure
  }

  emit(event: string): void {
    this.listeners.get(event)?.()
  }
}

/** 验证安全选项、静态资源路径和窗口存活查询。 */
async function testCreatesAndLoadsWindow(): Promise<void> {
  FakeBrowserWindow.instances = []
  FakeBrowserWindow.loadFailure = undefined
  const preloadPath = join(process.cwd(), "dist", "src", "preload", "index.js")
  const rendererHtmlPath = join(process.cwd(), "dist", "src", "renderer", "index.html")
  const failures: unknown[] = []
  const windows = createElectronWindowManager(
    FakeBrowserWindow as unknown as BrowserWindowConstructorPort,
    {
      preloadPath,
      rendererHtmlPath,
      onWindowLoadFailure: (error) => failures.push(error),
    },
  )

  assert.equal(windows.hasOpenWindows(), false)
  windows.createMainWindow()
  await Promise.resolve()
  const window = FakeBrowserWindow.instances[0]
  assert.equal(windows.hasOpenWindows(), true)
  assert.equal(window.loadedPath, rendererHtmlPath)
  assert.equal(window.options.backgroundColor, "#f0f1ed")
  assert.equal(window.options.frame, false)
  assert.equal(window.options.titleBarOverlay, undefined)
  assert.equal(window.options.autoHideMenuBar, true)
  assert.deepEqual(window.options.webPreferences, {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  })
  window.emit("ready-to-show")
  assert.equal(window.showCalls, 1)
  assert.deepEqual(failures, [])
}

/** 验证开发模式使用 Vite 地址加载 Renderer。 */
async function testLoadsRendererFromDevServer(): Promise<void> {
  FakeBrowserWindow.instances = []
  FakeBrowserWindow.loadFailure = undefined
  const rendererUrl = "http://127.0.0.1:5173/"
  const windows = createElectronWindowManager(
    FakeBrowserWindow as unknown as BrowserWindowConstructorPort,
    {
      preloadPath: join(process.cwd(), "dist", "src", "preload", "index.js"),
      rendererHtmlPath: join(process.cwd(), "dist", "src", "renderer", "index.html"),
      rendererUrl,
      onWindowLoadFailure: () => {},
    },
  )

  windows.createMainWindow()
  await Promise.resolve()
  assert.equal(FakeBrowserWindow.instances[0].loadedUrl, rendererUrl)
  assert.equal(FakeBrowserWindow.instances[0].loadedPath, undefined)
}

/** 验证路径检查和异步 loadFile 失败出口。 */
async function testRejectsRelativePathsAndForwardsLoadFailure(): Promise<void> {
  assert.throws(() => createElectronWindowManager(
    FakeBrowserWindow as unknown as BrowserWindowConstructorPort,
    {
      preloadPath: "relative.js",
      rendererHtmlPath: join(process.cwd(), "index.html"),
      onWindowLoadFailure: () => {},
    },
  ), /preload 路径必须是绝对路径/)

  FakeBrowserWindow.instances = []
  const failure = new Error("load failed")
  FakeBrowserWindow.loadFailure = failure
  let forwarded: unknown
  const windows = createElectronWindowManager(
    FakeBrowserWindow as unknown as BrowserWindowConstructorPort,
    {
      preloadPath: join(process.cwd(), "preload.js"),
      rendererHtmlPath: join(process.cwd(), "index.html"),
      onWindowLoadFailure: (error) => { forwarded = error },
    },
  )
  windows.createMainWindow()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(forwarded, failure)
}

/** 依次运行 BrowserWindow 适配断言。 */
async function main(): Promise<void> {
  await testCreatesAndLoadsWindow()
  await testLoadsRendererFromDevServer()
  await testRejectsRelativePathsAndForwardsLoadFailure()
  await testBroadcast()
  await testNavigationAndIpcTrust()
  console.log("electron-windows.test.ts: BrowserWindow 适配断言通过")
}

/** @returns 主窗口外链、弹窗、重定向和所有 IPC 注册路径的来源校验通过。 */
async function testNavigationAndIpcTrust(): Promise<void> {
  for (const rendererUrl of [undefined, "http://127.0.0.1:5173/"]) {
    FakeBrowserWindow.instances = []
    FakeBrowserWindow.loadFailure = undefined
    const external: string[] = []
    const windows = createElectronWindowManager(FakeBrowserWindow as unknown as BrowserWindowConstructorPort, {
      preloadPath: join(process.cwd(), "preload.js"), rendererHtmlPath: join(process.cwd(), "index.html"),
      rendererUrl, openExternal: (url) => external.push(url), onWindowLoadFailure: () => {},
    })
    windows.createMainWindow()
    await Promise.resolve()
    const window = FakeBrowserWindow.instances[0]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent
    assert.equal(windows.isTrustedSender(event), true)
    window.webContents.mainFrame.url += "#/session/test"
    assert.equal(windows.isTrustedSender(event), true, "hash 路由不会失去 IPC 权限")
    assert.equal(windows.isTrustedSender({ ...event, senderFrame: { url: window.webContents.getURL() } } as IpcMainInvokeEvent), false)
    assert.equal(windows.isTrustedSender({ ...event, sender: { ...window.webContents } } as IpcMainInvokeEvent), false)
    let blocked = 0
    const navigate = (type: string, url: string) => window.navigation.get(type)!({ url, preventDefault: () => { blocked++ } }, url)
    navigate("will-navigate", window.webContents.getURL())
    assert.equal(blocked, 0)
    navigate("will-navigate", "https://example.com/review")
    navigate("will-navigate", "file:///other.html")
    navigate("will-redirect", "https://example.com/redirect")
    assert.equal(blocked, 3)
    assert.deepEqual(external, ["https://example.com/review"])
    assert.deepEqual(window.openWindow!({ url: "https://example.com/popup" }), { action: "deny" })
    assert.deepEqual(window.openWindow!({ url: "javascript:alert(1)" }), { action: "deny" })
    assert.equal(external.length, 2)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const ipc = createTrustedIpcMain({ handle: (channel, listener) => { handlers.set(channel, listener) } } as Pick<IpcMain, "handle">,
      (incoming) => windows.isTrustedSender(incoming))
    ipc.handle("test:privileged", (_event, value) => value)
    assert.equal(handlers.get("test:privileged")!(event, "ok"), "ok")
    window.webContents.mainFrame.url = "https://example.com/review"
    assert.equal(windows.isTrustedSender(event), false, "绕过导航限制的文档仍不能调用 IPC")
    windows.sendSessionUpdate!({ kind: "error", projectId: "default", sessionId: "private", stage: "runtime", error: { source: "runtime", code: "TEST", message: "private update" } })
    assert.equal(window.sent.length, 0, "外部文档不能接收会话广播")
    assert.throws(() => handlers.get("test:privileged")!(event), /IPC 请求来源无效/)
    window.destroyed = true
    assert.equal(windows.isTrustedSender(event), false)
  }
}

/** @returns 多窗口广播、销毁窗口跳过以及单窗失败隔离验证。 */
async function testBroadcast(): Promise<void> {
  FakeBrowserWindow.instances = []
  FakeBrowserWindow.loadFailure = undefined
  const windows = createElectronWindowManager(FakeBrowserWindow as unknown as BrowserWindowConstructorPort, {
    preloadPath: join(process.cwd(), "preload.js"), rendererHtmlPath: join(process.cwd(), "index.html"), onWindowLoadFailure: () => {},
  })
  windows.createMainWindow(); windows.createMainWindow()
  const [first, second] = FakeBrowserWindow.instances
  const update: SessionUpdate = { kind: "error", projectId: "default", sessionId: "s", stage: "index", error: { source: "runtime", code: "INDEX", message: "失败" } }
  windows.sendSessionUpdate!(update)
  assert.deepEqual(first.sent, [{ channel: SESSION_IPC_CHANNELS.update, update }])
  assert.deepEqual(second.sent, first.sent)
  first.sendFailure = new Error("窗口发送失败")
  assert.throws(() => windows.sendSessionUpdate!(update), AggregateError)
  assert.equal(second.sent.length, 2, "一个窗口失败后仍发送给其他窗口")
  first.destroyed = true
  windows.sendSessionUpdate!(update)
  assert.equal(second.sent.length, 3)
  second.emit("closed")
  windows.sendSessionUpdate!(update)
  assert.equal(second.sent.length, 3)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
