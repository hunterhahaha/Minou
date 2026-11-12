/** 原生托盘、窗口关闭策略与退出期间的桌面状态。 */
import { join } from "node:path"
import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron"
import type { CloseBehavior, CloseSettings } from "../preload/window-api.ts"
import type { DesktopSettings } from "./desktop-settings.ts"
import type { ElectronWindowManager } from "./electron-windows.ts"

/** 当前桌面应用唯一的托盘控制器。 */
export class ElectronTray {
  private tray?: Tray
  private quitting = false

  /**
   * @param windows 负责主窗口的创建、显示和隐藏。
   * @param settings 已载入的桌面关闭偏好。
   */
  constructor(
    private readonly windows: Pick<ElectronWindowManager, "showMainWindow" | "toggleMainWindowVisibility">,
    private readonly settings: DesktopSettings,
  ) {}

  /** @returns 仍有原生托盘对象时为 true。 */
  get available(): boolean {
    return this.tray !== undefined && !this.tray.isDestroyed()
  }

  /** Electron ready 后创建托盘。初始化失败时释放部分资源并保留任务栏入口。 */
  start(): void {
    if (this.quitting || this.available) return
    const platform = process.platform
    const iconPath = join(__dirname, "../../../resources/minou.png")
    try {
      const icon = nativeImage.createFromPath(iconPath)
      if (icon.isEmpty()) throw new Error(`托盘图标无法读取：${iconPath}`)
      const tray = new Tray(icon.resize({ width: platform === "darwin" ? 18 : 32, quality: "best" }))
      this.tray = tray
      tray.setToolTip("Minou")
      const menu = Menu.buildFromTemplate([
        { label: "显示 Minou", click: () => this.showMainWindow() },
        { label: "退出 Minou", click: () => app.quit() },
      ])
      if (platform === "darwin") {
        tray.on("right-click", () => tray.popUpContextMenu(menu))
      } else {
        tray.setContextMenu(menu)
      }
      tray.on("click", () => {
        if (!this.quitting) this.windows.toggleMainWindowVisibility(platform === "linux")
      })
      app.once("will-quit", () => this.destroy())
    } catch (error) {
      this.destroy()
      console.error("无法初始化 Minou 系统托盘。", error)
    }
  }

  /** 恢复主窗口，退出期间忽略托盘、Dock 和第二实例的激活请求。 */
  showMainWindow(): void {
    if (!this.quitting) this.windows.showMainWindow()
  }

  /**
   * 为主窗口安装共同的关闭策略与 Windows 会话结束处理。
   * @param window 新创建的主窗口。
   */
  attachWindow(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (this.quitting) return
      event.preventDefault()
      if (this.settings.behavior === "quit") app.quit()
      else if (this.getCloseSettings().backgroundAction === "hide") window.hide()
      else window.minimize()
    })
    if (process.platform === "win32") {
      window.once("session-end", () => {
        this.destroy()
        app.quit()
      })
    }
  }

  /** @returns 已生效的偏好和当前平台可用的后台方式。 */
  getCloseSettings(): CloseSettings {
    return { behavior: this.settings.behavior, backgroundAction: this.available && process.platform !== "linux" ? "hide" : "minimize" }
  }

  /**
   * 持久化关闭偏好并在成功后返回当前设置。
   * @param behavior 下次关闭窗口时使用的偏好。
   * @returns 保存成功后的偏好和后台方式。
   * @throws Error 应用正在退出或保存失败。
   */
  async setCloseBehavior(behavior: CloseBehavior): Promise<CloseSettings> {
    if (this.quitting) throw new Error("Minou 正在退出")
    const saved = await this.settings.save(behavior)
    return { ...this.getCloseSettings(), behavior: saved }
  }

  /** @returns 已开始退出且全部已接受的偏好写入完成后的 Promise。 */
  beginQuit(): Promise<void> {
    this.quitting = true
    return this.settings.whenIdle()
  }

  /** 释放原生托盘资源。应用退出或托盘初始化失败时可重复调用。 */
  private destroy(): void {
    if (this.available) this.tray?.destroy()
    this.tray = undefined
  }
}
