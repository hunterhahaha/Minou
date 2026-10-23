/** 独立于业务 API 的窗口控制桥；Renderer 只能控制发起请求的当前窗口。 */
import type { ContextBridge, IpcRenderer, IpcRendererEvent } from "electron"

/** 窗口专用通道，不复用或改动 Session 等业务通道。 */
export const WINDOW_IPC_CHANNELS = {
  minimize: "nicode:window:minimize",
  toggleMaximize: "nicode:window:toggle-maximize",
  getState: "nicode:window:get-state",
  stateChanged: "nicode:window:state-changed",
} as const

/** 标题栏渲染所需的当前窗口状态。 */
export interface WindowState {
  /** 当前窗口是否最大化，用于显示还原按钮。 */
  maximized: boolean
}

/** 提供当前窗口的控制和状态订阅，不暴露窗口对象、标识或应用退出能力。 */
export interface NiCodeWindowApi {
  /** @returns 当前窗口最小化完成；IPC 失败由调用方展示。 */
  minimize(): Promise<void>
  /** @returns 切换后的最大化状态；IPC 失败由调用方展示。 */
  toggleMaximize(): Promise<WindowState>
  /** @returns 当前窗口状态；IPC 失败由调用方展示。 */
  getState(): Promise<WindowState>
  /** @param listener 接收校验后的状态，不接收 Electron 事件。 @returns 取消本次订阅。 */
  onStateChanged(listener: (state: WindowState) => void): () => void
}

/** @param value 主进程返回或推送的未知数据。 @returns 纯窗口状态。 @throws TypeError 状态字段非法。 */
function requireWindowState(value: unknown): WindowState {
  if (typeof value !== "object" || value === null || !("maximized" in value) || typeof value.maximized !== "boolean") throw new TypeError("窗口状态无效")
  return { maximized: value.maximized }
}

/**
 * 构建不可扩展的窄窗口 API；事件订阅的取消操作只移除当前监听器。
 * @param ipcRenderer preload 内部使用的 Electron IPC 能力。
 * @returns 可通过 contextBridge 暴露的窗口控制 API。
 */
export function createWindowApi(ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): NiCodeWindowApi {
  return Object.freeze({
    /** @returns 当前窗口最小化完成；失败由调用方捕获。 */
    async minimize(): Promise<void> { await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.minimize) },
    /** @returns 校验后的最大化状态；失败由调用方捕获。 */
    async toggleMaximize(): Promise<WindowState> { return requireWindowState(await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.toggleMaximize)) },
    /** @returns 校验后的初始窗口状态；失败由调用方捕获。 */
    async getState(): Promise<WindowState> { return requireWindowState(await ipcRenderer.invoke(WINDOW_IPC_CHANNELS.getState)) },
    /** @param listener 不接收 Electron 事件的状态监听器。 @returns 只取消当前监听的清理函数。 */
    onStateChanged(listener: (state: WindowState) => void): () => void {
      /** @param _event 不向 Renderer 转发的 Electron 事件。 @param value 未知窗口状态。 */
      const receive = (_event: IpcRendererEvent, value: unknown): void => { listener(requireWindowState(value)) }
      ipcRenderer.on(WINDOW_IPC_CHANNELS.stateChanged, receive)
      return () => { ipcRenderer.removeListener(WINDOW_IPC_CHANNELS.stateChanged, receive) }
    },
  })
}

/** @param contextBridge Electron 隔离桥。 @param ipcRenderer preload 的 IPC 端口。 @returns 窗口 API 注册完成。 */
export function exposeWindowApi(contextBridge: Pick<ContextBridge, "exposeInMainWorld">, ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): void {
  contextBridge.exposeInMainWorld("nicodeWindow", createWindowApi(ipcRenderer))
}
