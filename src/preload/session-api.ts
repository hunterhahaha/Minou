/**
 * Renderer 可调用的 Session 入口，以及 preload 与主进程之间的 IPC 契约。
 *
 * preload 只暴露窄接口，不把 ipcRenderer 本体交给 Renderer。Runtime 仍运行在主进程；
 * 主进程在首批事件提交后返回可结构化克隆的 sessionId / turn，后台 completion 不跨 IPC。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 1、13、28 节。
 */

import type { ContinueSessionInput } from "../../runtime/agent/src/session-runtime.ts"
import type { UserMessageInput } from "../../runtime/session/src/events.ts"

export const NICODE_PRELOAD_GLOBAL = "nicode"

export const SESSION_IPC_CHANNELS = {
  startNewSession: "nicode:session:start-new",
  continueSession: "nicode:session:continue",
} as const

/** 首批 Turn 事件成功提交后即可返回前端的可序列化结果。 */
export interface StartedSessionResponse {
  sessionId: string
  turn: number
}

/** 暴露为 `window.nicode` 的两个 Session 命令。 */
export interface NiCodePreloadApi {
  startNewSession(input: UserMessageInput): Promise<StartedSessionResponse>
  continueSession(
    sessionId: string,
    input: ContinueSessionInput,
  ): Promise<StartedSessionResponse>
}

/** Electron ipcRenderer.invoke 的最小接口，便于在不引入 Electron 类型依赖时测试。 */
export interface IpcRendererInvokePort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

/** Electron contextBridge.exposeInMainWorld 的最小接口。 */
export interface ContextBridgePort {
  exposeInMainWorld(apiKey: string, api: unknown): void
}

export function createSessionApi(ipcRenderer: IpcRendererInvokePort): NiCodePreloadApi {
  return Object.freeze({
    async startNewSession(input: UserMessageInput): Promise<StartedSessionResponse> {
      const response = await ipcRenderer.invoke(SESSION_IPC_CHANNELS.startNewSession, input)
      return requireStartedSessionResponse(response)
    },

    async continueSession(
      sessionId: string,
      input: ContinueSessionInput,
    ): Promise<StartedSessionResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.continueSession,
        sessionId,
        input,
      )
      return requireStartedSessionResponse(response)
    },
  })
}

/** 把窄化后的 Session API 安装到 Renderer 的 `window.nicode`。 */
export function exposeSessionApi(
  contextBridge: ContextBridgePort,
  ipcRenderer: IpcRendererInvokePort,
): NiCodePreloadApi {
  const api = createSessionApi(ipcRenderer)
  contextBridge.exposeInMainWorld(NICODE_PRELOAD_GLOBAL, api)
  return api
}

function requireStartedSessionResponse(value: unknown): StartedSessionResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    !("turn" in value) ||
    typeof value.turn !== "number" ||
    !Number.isInteger(value.turn) ||
    value.turn <= 0
  ) {
    throw new TypeError("主进程返回了无效的 Session 启动结果")
  }
  return { sessionId: value.sessionId, turn: value.turn }
}
