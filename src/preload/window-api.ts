/** 独立于业务 API 的窗口控制桥；Renderer 只能控制发起请求的当前窗口。 */
import type { ContextBridge, IpcRenderer, IpcRendererEvent } from "electron"

/** 窗口专用通道，不复用或改动 Session 等业务通道。 */
export const WINDOW_IPC_CHANNELS = {
  minimize: "minou:window:minimize",
  close: "minou:window:close",
  getCloseSettings: "minou:window:get-close-settings",
  setCloseBehavior: "minou:window:set-close-behavior",
  toggleMaximize: "minou:window:toggle-maximize",
  getState: "minou:window:get-state",
  stateChanged: "minou:window:state-changed",
} as const

/** 标题栏渲染所需的当前窗口状态。 */
export interface WindowState {
  /** 当前窗口是否最大化，用于显示还原按钮。 */
  maximized: boolean
}

/** 主窗口关闭时采用的用户偏好。 */
export type CloseBehavior = "tray" | "quit"

/** 已保存的关闭偏好及当前桌面可用的后台方式。 */
export interface CloseSettings {
  /** 下次关闭窗口时生效的偏好。 */
  behavior: CloseBehavior
  /** 选择关闭到托盘时实际隐藏窗口或保留任务栏入口。 */
  backgroundAction: "hide" | "minimize"
}

/**
 * 检查窗口关闭偏好是否属于允许值。
 * @param value 来自 IPC 或磁盘的未知偏好。
 * @returns 偏好为 tray 或 quit 时返回 true。
 */
export function isCloseBehavior(value: unknown): value is CloseBehavior {
  return value === "tray" || value === "quit"
}

/**
 * 校验主进程返回的设置快照。
 * @param value 未知 IPC 响应。
 * @returns 供界面使用的关闭设置。
 * @throws TypeError 响应字段无效时由调用方处理。
 */
function requireCloseSettings(value: unknown): CloseSettings {
  if (typeof value !== "object" || value === null || !("behavior" in value) || !isCloseBehavior(value.behavior)
    || !("backgroundAction" in value) || (value.backgroundAction !== "hide" && value.backgroundAction !== "minimize")) {
    throw new TypeError("窗口关闭设置无效")
  }
  return { behavior: value.behavior, backgroundAction: value.backgroundAction }
}

/** 提供当前窗口的控制、关闭偏好和状态订阅，不暴露 Electron 对象。 */
export interface MinouWindowApi {
  /**
   * 请求将当前窗口最小化。
   *
   * @returns 当前窗口最小化完成；IPC 失败由调用方展示。
   */
  minimize(): Promise<void>
  /** @returns 发起当前窗口的正常关闭请求。应用退出时页面随窗口销毁。 */
  close(): Promise<void>
  /** @returns 当前已保存的关闭偏好及关闭到托盘的实际方式。 */
  getCloseSettings(): Promise<CloseSettings>
  /**
   * 保存全局桌面关闭偏好。
   * @param behavior 下次关闭窗口时生效的偏好。
   * @returns 持久化成功后的设置，失败时 Promise 拒绝。
   */
  setCloseBehavior(behavior: CloseBehavior): Promise<CloseSettings>
  /**
   * 请求切换当前窗口最大化状态并读取确认结果。
   *
   * @returns 切换后的最大化状态；IPC 失败由调用方展示。
   */
  toggleMaximize(): Promise<WindowState>
  /**
   * 请求读取当前窗口状态。
   *
   * @returns 当前窗口状态；IPC 失败由调用方展示。
   */
  getState(): Promise<WindowState>
  /**
   * 订阅校验后的窗口状态更新，并返回当前订阅的清理函数。
   *
   * @param listener 接收校验后的状态，不接收 Electron 事件。
   * @returns 取消本次订阅。
   */
  onStateChanged(listener: (state: WindowState) => void): () => void
}

/**
 * 检查窗口状态字段，只向页面返回业务状态。
 *
 * @param value 主进程返回或推送的未知数据。
 * @returns 纯窗口状态。
 * @throws TypeError 状态字段非法。
 */
function requireWindowState(value: unknown): WindowState {
  if (typeof value !== "object" || value === null || !("maximized" in value) || typeof value.maximized !== "boolean") throw new TypeError("窗口状态无效")
  return { maximized: value.maximized }
}

/**
 * 构建不可扩展的窄窗口 API；事件订阅的取消操作只移除当前监听器。
 * @param ipcRenderer preload 内部使用的 Electron IPC 能力。
 * @returns 可通过 contextBridge 暴露的窗口控制 API。
 */
export function createWindowApi(ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): MinouWindowApi {
  return Object.freeze({
    /**
     * 请求将当前窗口最小化。
     *
     * @returns 当前窗口最小化完成；失败由调用方捕获。
     */
    async minimize(): Promise<void> { await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.minimize) },
    async close(): Promise<void> { await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.close) },
    async getCloseSettings(): Promise<CloseSettings> { return requireCloseSettings(await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.getCloseSettings)) },
    async setCloseBehavior(behavior: CloseBehavior): Promise<CloseSettings> {
      if (!isCloseBehavior(behavior)) throw new TypeError("窗口关闭偏好无效")
      return requireCloseSettings(await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.setCloseBehavior, behavior))
    },
    /**
     * 请求切换当前窗口最大化状态并读取确认结果。
     *
     * @returns 校验后的最大化状态；失败由调用方捕获。
     */
    async toggleMaximize(): Promise<WindowState> { return requireWindowState(await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.toggleMaximize)) },
    /**
     * 请求读取当前窗口状态。
     *
     * @returns 校验后的初始窗口状态；失败由调用方捕获。
     */
    async getState(): Promise<WindowState> { return requireWindowState(await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.getState)) },
    /**
     * 订阅校验后的窗口状态更新，并返回当前订阅的清理函数。
     *
     * @param listener 不接收 Electron 事件的状态监听器。
     * @returns 只取消当前监听的清理函数。
     */
    onStateChanged(listener: (state: WindowState) => void): () => void {
      /** @param _event 不向 Renderer 转发的 Electron 事件。 @param value 未知窗口状态。 */
      const receive = (_event: IpcRendererEvent, value: unknown): void => { listener(requireWindowState(value)) }
      ipcRenderer.on(WINDOW_IPC_CHANNELS.stateChanged, receive)
      return () => { ipcRenderer.removeListener(WINDOW_IPC_CHANNELS.stateChanged, receive) }
    },
  })
}

/**
 * 通过隔离桥发布当前窗口的控制与状态订阅接口。
 *
 * @param contextBridge Electron 隔离桥。
 * @param ipcRenderer preload 的 IPC 端口。
 * @returns 窗口 API 注册完成。
 */
export function exposeWindowApi(contextBridge: Pick<ContextBridge, "exposeInMainWorld">, ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): void {
  contextBridge.exposeInMainWorld("minouWindow", createWindowApi(ipcRenderer))
}
