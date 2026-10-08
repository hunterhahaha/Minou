/** BrowserWindow 真实适配层的配置和生命周期测试。 */

import assert from "node:assert/strict"
import { join } from "node:path"

import type { BrowserWindowConstructorOptions } from "electron"

import {
  createElectronWindowManager,
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
  webContents = {
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

  show(): void {
    this.showCalls += 1
  }

  async loadFile(path: string): Promise<void> {
    this.loadedPath = path
    if (FakeBrowserWindow.loadFailure !== undefined) throw FakeBrowserWindow.loadFailure
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrl = url
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
  assert.equal(window.options.backgroundColor, "#fbfcfe")
  assert.equal(window.options.titleBarStyle, "hidden")
  assert.deepEqual(window.options.titleBarOverlay, {
    color: "#f6f8fb", symbolColor: "#626c78", height: 40,
  })
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
  console.log("electron-windows.test.ts: BrowserWindow 适配断言通过")
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
