/**
 * Electron 主进程的 Session IPC handler。
 *
 * Renderer 输入先在进程边界校验，再调用主进程中的 SessionRuntime。异步事件流与 completion
 * 不可跨 IPC，主进程只返回可序列化结果，并在后台筛选事件、观察运行错误及管理活动实例。
 */

import type { ModelRef } from "../../runtime/model/src/types.ts"
import type { SessionEvent, UserMessageInput } from "../../runtime/session/src/events.ts"
import {
  SessionRuntimePorts,
  startNewSession,
} from "../../runtime/agent/src/session-runtime.ts"
import type {
  ContinueSessionInput,
  EnqueuedSessionMessageResponse,
  SessionRuntimeProcessing,
  StartedSessionTurn,
} from "../../runtime/agent/src/session-runtime.ts"
import {
  SESSION_IPC_CHANNELS,
} from "../preload/session-api.ts"
import type { StartedSessionResponse } from "../preload/session-api.ts"

export interface IpcMainHandlePort {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void
}

export interface SessionCompletionFailure {
  sessionId: string
  turn: number
  error: unknown
}

export type HandleSessionCompletionFailure = (failure: SessionCompletionFailure) => void

/**
 * 按 Project 和 Session 身份创建已经绑定全部宿主能力的活动 Runtime。
 *
 * @param projectId Session 所属 Project 的数字身份。
 * @param sessionId 要绑定的 Session 身份。
 * @returns 使用对应 Project Session 目录的活动 Runtime。
 * @throws Error 当宿主依赖无法完成 Runtime 构造时抛出。
 */
export type CreateSessionRuntime = (
  projectId: number,
  sessionId: string,
) => SessionRuntimePorts

/** SessionEvent 到最终 Renderer 事件之间尚待确定的筛选与发送边界。 */
export interface SessionEventForwardingPort {
  /**
   * 选择并转换允许发送给 Renderer 的事件。
   *
   * @param event 已经成功持久化的内部 SessionEvent。
   * @returns Renderer 事件，或在当前事件不应发送时返回 undefined。
   */
  filterSessionEventForRenderer(event: SessionEvent): unknown | undefined
  /**
   * 把已经筛选的事件发送给 Renderer。
   *
   * @param event 筛选后的 Renderer 事件；具体 wire shape 尚未确定。
   */
  sendSessionEventToRenderer(event: unknown): void | Promise<void>
}

const NO_SESSION_EVENT_FORWARDING: SessionEventForwardingPort = {
  filterSessionEventForRenderer: () => undefined,
  sendSessionEventToRenderer: () => {},
}

/** 注册一次；Electron 启动装配负责传入 ipcMain、Runtime 工厂和后台错误出口。 */
export function registerSessionIpcHandlers(
  ipcMain: IpcMainHandlePort,
  createRuntime: CreateSessionRuntime,
  onCompletionFailure: HandleSessionCompletionFailure,
  eventForwarding: SessionEventForwardingPort = NO_SESSION_EVENT_FORWARDING,
): void {
  const activeSessions = new Map<string, SessionRuntimePorts>()

  ipcMain.handle(SESSION_IPC_CHANNELS.startNewSession, async (_event, rawProjectId, rawInput) => {
    const projectId = requireProjectId(rawProjectId)
    const input = requireUserMessageInput(rawInput)
    let sessionId: string
    do sessionId = SessionRuntimePorts.createSessionId()
    while (activeSessions.has(sessionId))

    const runtime = createAndRegisterRuntime(projectId, sessionId, activeSessions, createRuntime)
    try {
      const started = await startNewSession(input, runtime)
      const processing = runtime.processMessageQueue(started)
      observeActiveRuntime(
        runtime,
        started,
        processing,
        activeSessions,
        onCompletionFailure,
        eventForwarding,
      )
      return startedResponse(started)
    } catch (error) {
      removeActiveRuntime(runtime, activeSessions)
      runtime.close()
      throw error
    }
  })

  ipcMain.handle(
    SESSION_IPC_CHANNELS.continueSession,
    async (_event, rawProjectId, rawSessionId, rawInput) => {
      const projectId = requireProjectId(rawProjectId)
      const sessionId = requireSessionId(rawSessionId)
      const input = requireContinueSessionInput(rawInput)
      if (activeSessions.has(sessionId)) {
        throw new Error(`Session 正在运行，请使用 enqueueSessionMessage：${sessionId}`)
      }

      const runtime = createAndRegisterRuntime(projectId, sessionId, activeSessions, createRuntime)
      try {
        runtime.enqueueSessionMessage(input.content)
        const processing = runtime.processMessageQueue()
        // started 可能在 repair/批次提交阶段失败；立即观察 completion，避免其先行拒绝成为未处理 Promise。
        void processing.completion.catch(() => {})
        const started = await processing.started
        observeActiveRuntime(
          runtime,
          started,
          processing,
          activeSessions,
          onCompletionFailure,
          eventForwarding,
        )
        return startedResponse(started)
      } catch (error) {
        removeActiveRuntime(runtime, activeSessions)
        runtime.close()
        throw error
      }
    },
  )

  ipcMain.handle(
    SESSION_IPC_CHANNELS.enqueueSessionMessage,
    (_event, rawProjectId, rawSessionId, rawInput) => {
      requireProjectId(rawProjectId)
      const sessionId = requireSessionId(rawSessionId)
      const input = requireEnqueueSessionMessageInput(rawInput)
      const runtime = activeSessions.get(sessionId)
      if (runtime === undefined) {
        throw new Error(`Session 当前未运行，不能追加消息：${sessionId}`)
      }
      return runtime.enqueueSessionMessage(input.content)
    },
  )
}

function createAndRegisterRuntime(
  projectId: number,
  sessionId: string,
  activeSessions: Map<string, SessionRuntimePorts>,
  createRuntime: CreateSessionRuntime,
): SessionRuntimePorts {
  const runtime = createRuntime(projectId, sessionId)
  if (runtime.sessionId !== sessionId) {
    runtime.close()
    throw new Error(
      `SessionRuntime 工厂返回了错误实例：期望 ${sessionId}，实际 ${runtime.sessionId}`,
    )
  }
  activeSessions.set(sessionId, runtime)
  return runtime
}

function observeActiveRuntime(
  runtime: SessionRuntimePorts,
  started: StartedSessionTurn,
  processing: SessionRuntimeProcessing,
  activeSessions: Map<string, SessionRuntimePorts>,
  onCompletionFailure: HandleSessionCompletionFailure,
  eventForwarding: SessionEventForwardingPort,
): void {
  void consumeSessionEvents(started.events, runtime, onCompletionFailure, eventForwarding)
  void processing.completion.then(
    () => {
      removeActiveRuntime(runtime, activeSessions)
    },
    (error: unknown) => {
      removeActiveRuntime(runtime, activeSessions)
      onCompletionFailure({
        sessionId: runtime.sessionId,
        turn: runtime.currentTurn ?? started.turn,
        error,
      })
    },
  )
}

async function consumeSessionEvents(
  events: AsyncIterable<SessionEvent>,
  runtime: SessionRuntimePorts,
  onCompletionFailure: HandleSessionCompletionFailure,
  eventForwarding: SessionEventForwardingPort,
): Promise<void> {
  for await (const event of events) {
    try {
      const selected = eventForwarding.filterSessionEventForRenderer(event)
      if (selected !== undefined) {
        await eventForwarding.sendSessionEventToRenderer(selected)
      }
    } catch (error) {
      onCompletionFailure({
        sessionId: runtime.sessionId,
        turn: runtime.currentTurn ?? event.turn ?? 0,
        error,
      })
    }
  }
}

function removeActiveRuntime(
  runtime: SessionRuntimePorts,
  activeSessions: Map<string, SessionRuntimePorts>,
): void {
  if (activeSessions.get(runtime.sessionId) === runtime) {
    activeSessions.delete(runtime.sessionId)
  }
}

function startedResponse(started: StartedSessionTurn): StartedSessionResponse {
  return { sessionId: started.sessionId, turn: started.turn }
}

function requireUserMessageInput(value: unknown): UserMessageInput {
  if (!isRecord(value) || !isTextContent(value.content) || !isModelRef(value.model)) {
    throw new TypeError("startNewSession 输入无效")
  }
  return { content: value.content, model: value.model }
}

function requireContinueSessionInput(value: unknown): ContinueSessionInput {
  if (!isRecord(value) || !isTextContent(value.content)) {
    throw new TypeError("continueSession 输入无效")
  }
  return { content: value.content }
}

function requireEnqueueSessionMessageInput(
  value: unknown,
): Pick<EnqueuedSessionMessageResponse, "content"> {
  if (!isRecord(value) || !isTextContent(value.content)) {
    throw new TypeError("enqueueSessionMessage 输入无效")
  }
  return { content: value.content }
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("continueSession.sessionId 无效")
  }
  return value
}

/**
 * 把 Renderer 提供的 Project 身份收窄为可安全作为目录名的数字 ID。
 *
 * @param value IPC 边界收到的未校验值。
 * @returns 非负的安全整数 Project ID。
 * @throws TypeError 当值不能对应既定的数字 Project 身份时抛出。
 */
function requireProjectId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("projectId 无效")
  }
  return value
}

function isModelRef(value: unknown): value is ModelRef {
  return isRecord(value) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.modelId) &&
    (
      value.protocol === "anthropic_messages" ||
      value.protocol === "chat_completions" ||
      value.protocol === "responses"
    )
}

function isTextContent(value: unknown): value is UserMessageInput["content"] {
  return Array.isArray(value) && value.every((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}
