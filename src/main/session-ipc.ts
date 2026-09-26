/**
 * Electron 主进程的 Session IPC handler。
 *
 * Renderer 输入先在进程边界校验，再调用主进程中的 SessionRuntime。异步事件流与 completion
 * 不可跨 IPC，主进程只返回可序列化结果，并在后台筛选事件、观察运行错误及管理活动实例。
 */

import type { ModelRef } from "../../runtime/model/src/types.ts"
import { requireProjectId } from "../../runtime/session/src/project-id.ts"
import type { ProjectId } from "../../runtime/session/src/project-id.ts"
import type { SessionEvent, UserMessageInput } from "../../runtime/session/src/events.ts"
import { SessionRuntime } from "../../runtime/agent/src/session-runtime.ts"
import type {
  ContinueSessionInput,
  EnqueueSessionMessageInput,
  SessionRuntimeProcessing,
  StartedSessionTurn,
} from "../../runtime/agent/src/session-runtime.ts"
import {
  SESSION_IPC_CHANNELS,
} from "../preload/session-api.ts"
import type { StartedSessionResponse, StoppedSessionResponse } from "../preload/session-api.ts"

export interface SessionCompletionFailure {
  sessionId: string
  turn: number
  error: unknown
}

export type HandleSessionCompletionFailure = (failure: SessionCompletionFailure) => void

/**
 * 按 Project 和 Session 身份创建已经绑定全部宿主能力的活动 Runtime。
 *
 * @param projectId Session 所属 Project UUID 或 default。
 * @param sessionId 要绑定的 Session 身份。
 * @returns 使用对应 Project Session 目录的活动 Runtime。
 * @throws Error 当宿主依赖无法完成 Runtime 构造时抛出。
 */
export type CreateSessionRuntime = (
  projectId: ProjectId,
  sessionId: string,
) => SessionRuntime

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
  ipcMain: Electron.IpcMain,
  createRuntime: CreateSessionRuntime,
  onCompletionFailure: HandleSessionCompletionFailure,
  eventForwarding: SessionEventForwardingPort = NO_SESSION_EVENT_FORWARDING,
): void {
  const activeSessions = new Map<string, SessionRuntime>()

  ipcMain.handle(SESSION_IPC_CHANNELS.startNewSession, async (_event, rawProjectId, rawInput) => {
    const projectId = requireProjectId(rawProjectId)
    const input = requireUserMessageInput(rawInput)
    let sessionId: string
    do sessionId = SessionRuntime.createSessionId()
    while (activeSessions.has(sessionKey(projectId, sessionId)))

    const key = sessionKey(projectId, sessionId)
    const runtime = createAndRegisterRuntime(projectId, sessionId, activeSessions, createRuntime)
    try {
      const started = await runtime.startNewSession(input)
      const processing = runtime.processMessageQueue(started)
      observeActiveRuntime(
        runtime,
        key,
        started,
        processing,
        activeSessions,
        onCompletionFailure,
        eventForwarding,
      )
      return startedResponse(started)
    } catch (error) {
      removeActiveRuntime(runtime, key, activeSessions)
      runtime.close()
      throw error
    }
  })

  ipcMain.handle(
    SESSION_IPC_CHANNELS.continueSession,
    async (_event, rawProjectId, rawSessionId, rawInput) => {
      const projectId = requireProjectId(rawProjectId)
      const sessionId = requireSessionId(rawSessionId)
      const key = sessionKey(projectId, sessionId)
      const input = requireContinueSessionInput(rawInput)
      if (activeSessions.has(key)) {
        throw new Error(`Session 正在运行，请使用 enqueueSessionMessage：${sessionId}`)
      }

      const runtime = createAndRegisterRuntime(projectId, sessionId, activeSessions, createRuntime)
      try {
        const started = await runtime.continueSession(input)
        const processing = runtime.processMessageQueue(started)
        observeActiveRuntime(
          runtime,
          key,
          started,
          processing,
          activeSessions,
          onCompletionFailure,
          eventForwarding,
        )
        return startedResponse(started)
      } catch (error) {
        removeActiveRuntime(runtime, key, activeSessions)
        runtime.close()
        throw error
      }
    },
  )

  ipcMain.handle(
    SESSION_IPC_CHANNELS.enqueueSessionMessage,
    (_event, rawProjectId, rawSessionId, rawInput) => {
      const projectId = requireProjectId(rawProjectId)
      const sessionId = requireSessionId(rawSessionId)
      const input = requireEnqueueSessionMessageInput(rawInput)
      const runtime = activeSessions.get(sessionKey(projectId, sessionId))
      if (runtime === undefined) {
        throw new Error(`Session 当前未运行，不能追加消息：${sessionId}`)
      }
      return runtime.enqueueSessionMessage(input)
    },
  )

  ipcMain.handle(
    SESSION_IPC_CHANNELS.stopSession,
    (_event, rawProjectId, rawSessionId): StoppedSessionResponse => {
      const projectId = requireProjectId(rawProjectId)
      const sessionId = requireSessionId(rawSessionId)
      activeSessions.get(sessionKey(projectId, sessionId))?.stop()
      return { sessionId }
    },
  )
}

function createAndRegisterRuntime(
  projectId: ProjectId,
  sessionId: string,
  activeSessions: Map<string, SessionRuntime>,
  createRuntime: CreateSessionRuntime,
): SessionRuntime {
  const runtime = createRuntime(projectId, sessionId)
  if (runtime.sessionId !== sessionId) {
    runtime.close()
    throw new Error(
      `SessionRuntime 工厂返回了错误实例：期望 ${sessionId}，实际 ${runtime.sessionId}`,
    )
  }
  activeSessions.set(sessionKey(projectId, sessionId), runtime)
  return runtime
}

function observeActiveRuntime(
  runtime: SessionRuntime,
  key: string,
  started: StartedSessionTurn,
  processing: SessionRuntimeProcessing,
  activeSessions: Map<string, SessionRuntime>,
  onCompletionFailure: HandleSessionCompletionFailure,
  eventForwarding: SessionEventForwardingPort,
): void {
  void consumeSessionEvents(started.events, runtime, onCompletionFailure, eventForwarding)
  void processing.completion.then(
    () => {
      removeActiveRuntime(runtime, key, activeSessions)
    },
    (error: unknown) => {
      removeActiveRuntime(runtime, key, activeSessions)
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
  runtime: SessionRuntime,
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
  runtime: SessionRuntime,
  key: string,
  activeSessions: Map<string, SessionRuntime>,
): void {
  if (activeSessions.get(key) === runtime) {
    activeSessions.delete(key)
  }
}

/**
 * 以 Project 和 Session 联合身份定位活动 Runtime。
 * @param projectId Project UUID 或 default。
 * @param sessionId 对话身份。
 * @returns 不会产生简单拼接歧义的 Map 键。
 */
function sessionKey(projectId: ProjectId, sessionId: string): string {
  return JSON.stringify([projectId, sessionId])
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
  if (!isRecord(value) || !isTextContent(value.content) || !isModelRef(value.model)) {
    throw new TypeError("continueSession 输入无效")
  }
  return { content: value.content, model: value.model }
}

function requireEnqueueSessionMessageInput(
  value: unknown,
): EnqueueSessionMessageInput {
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || !isTextContent(value.content)
  ) {
    throw new TypeError("enqueueSessionMessage 输入无效")
  }
  return { content: value.content }
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("sessionId 无效")
  }
  return value
}

function isModelRef(value: unknown): value is ModelRef {
  return isRecord(value) &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) => key === "providerId" || key === "protocol" || key === "modelId" || key === "name") &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.modelId) &&
    isNonEmptyString(value.name) &&
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
