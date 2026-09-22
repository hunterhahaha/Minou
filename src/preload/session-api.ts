/**
 * Renderer 可调用的 Session 入口，以及 preload 与主进程之间的 IPC 契约。
 *
 * preload 只暴露窄接口，不把 ipcRenderer 本体交给 Renderer。Runtime 仍运行在主进程；
 * 主进程在首批事件提交后返回可结构化克隆的 sessionId / turn，运行中追加返回入队确认，
 * Stop 返回幂等处理确认；后台事件流与 completion 均不跨 IPC。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 1、13、28 节。
 */

import type {
  ContinueSessionInput,
  EnqueuedSessionMessageResponse,
} from "../../runtime/agent/src/session-runtime.ts"
import type { UserMessageInput } from "../../runtime/session/src/events.ts"

export const NICODE_PRELOAD_GLOBAL = "nicode"

export const SESSION_IPC_CHANNELS = {
  startNewSession: "nicode:session:start-new",
  continueSession: "nicode:session:continue",
  enqueueSessionMessage: "nicode:session:enqueue-message",
  stopSession: "nicode:session:stop",
} as const

/** 首批 Turn 事件成功提交后即可返回前端的可序列化结果。 */
export interface StartedSessionResponse {
  sessionId: string
  turn: number
}

/** 主进程已接受 Session Stop 命令的可序列化确认。 */
export interface StoppedSessionResponse {
  /** 已停止或当前无需停止的 Session。 */
  sessionId: string
}

/** 暴露为 `window.nicode` 的 Session 命令。 */
export interface NiCodePreloadApi {
  /**
   * 在指定 Project 分组中创建并启动 Session。
   *
   * @param projectId Session 所属 Project 的数字身份。
   * @param input 首轮用户消息与模型选择。
   * @returns 首批 Turn 事件成功提交后的 Session 身份和 Turn 编号。
   */
  startNewSession(
    projectId: number,
    input: UserMessageInput,
  ): Promise<StartedSessionResponse>
  /**
   * 在指定 Project 分组中恢复已有 Session。
   *
   * @param projectId Session 所属 Project 的数字身份。
   * @param sessionId 要恢复的 Session 身份。
   * @param input 新 Turn 的用户消息。
   * @returns 新 Turn 首批事件成功提交后的 Session 身份和 Turn 编号。
   */
  continueSession(
    projectId: number,
    sessionId: string,
    input: ContinueSessionInput,
  ): Promise<StartedSessionResponse>
  /**
   * 向指定 Project 中正在运行的 Session 追加消息。
   *
   * @param projectId Session 所属 Project 的数字身份。
   * @param sessionId 正在运行的 Session 身份。
   * @param input 要入队的用户消息。
   * @returns Runtime 接受消息后的入队确认。
   */
  enqueueSessionMessage(
    projectId: number,
    sessionId: string,
    input: ContinueSessionInput,
  ): Promise<EnqueuedSessionMessageResponse>
  /**
   * 停止指定 Project 中的活动 Session Runtime。
   *
   * @param projectId Session 所属 Project 的数字身份。
   * @param sessionId 要停止的 Session 身份。
   * @returns 主进程已完成幂等 Stop 处理的确认。
   */
  stopSession(
    projectId: number,
    sessionId: string,
  ): Promise<StoppedSessionResponse>
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
    async startNewSession(
      projectId: number,
      input: UserMessageInput,
    ): Promise<StartedSessionResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.startNewSession,
        projectId,
        input,
      )
      return requireStartedSessionResponse(response)
    },

    async continueSession(
      projectId: number,
      sessionId: string,
      input: ContinueSessionInput,
    ): Promise<StartedSessionResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.continueSession,
        projectId,
        sessionId,
        input,
      )
      return requireStartedSessionResponse(response)
    },

    async enqueueSessionMessage(
      projectId: number,
      sessionId: string,
      input: ContinueSessionInput,
    ): Promise<EnqueuedSessionMessageResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.enqueueSessionMessage,
        projectId,
        sessionId,
        input,
      )
      return requireEnqueuedSessionMessageResponse(response)
    },

    async stopSession(
      projectId: number,
      sessionId: string,
    ): Promise<StoppedSessionResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.stopSession,
        projectId,
        sessionId,
      )
      return requireStoppedSessionResponse(response)
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

function requireEnqueuedSessionMessageResponse(value: unknown): EnqueuedSessionMessageResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    !("content" in value) ||
    !isTextContent(value.content)
  ) {
    throw new TypeError("主进程返回了无效的 Session 消息入队结果")
  }
  return { sessionId: value.sessionId, content: value.content }
}

function requireStoppedSessionResponse(value: unknown): StoppedSessionResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0
  ) {
    throw new TypeError("主进程返回了无效的 Session 停止结果")
  }
  return { sessionId: value.sessionId }
}

function isTextContent(value: unknown): value is ContinueSessionInput["content"] {
  return Array.isArray(value) && value.every((block) =>
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
  )
}
