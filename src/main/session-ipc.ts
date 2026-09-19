/**
 * Electron 主进程的 Session IPC handler。
 *
 * Renderer 输入先在进程边界校验，再调用主进程中的 SessionRuntime。StartedAgentLoop.completion
 * 不可跨 IPC，主进程只返回 sessionId / turn，并接管后台 Promise 的错误观察。
 */

import type { ModelRef } from "../../runtime/model/src/types.ts"
import type { UserMessageInput } from "../../runtime/session/src/events.ts"
import {
  continueSession,
  startNewSession,
} from "../../runtime/agent/src/session-runtime.ts"
import type {
  ContinueSessionInput,
  SessionRuntimePorts,
  StartedAgentLoop,
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

/** 注册一次；Electron 启动装配负责传入真实 ipcMain、Runtime ports 和后台错误出口。 */
export function registerSessionIpcHandlers(
  ipcMain: IpcMainHandlePort,
  ports: SessionRuntimePorts,
  onCompletionFailure: HandleSessionCompletionFailure,
): void {
  ipcMain.handle(SESSION_IPC_CHANNELS.startNewSession, async (_event, rawInput) => {
    const input = requireUserMessageInput(rawInput)
    return startAndObserve(await startNewSession(input, ports), onCompletionFailure)
  })

  ipcMain.handle(
    SESSION_IPC_CHANNELS.continueSession,
    async (_event, rawSessionId, rawInput) => {
      const sessionId = requireSessionId(rawSessionId)
      const input = requireContinueSessionInput(rawInput)
      return startAndObserve(
        await continueSession(sessionId, input, ports),
        onCompletionFailure,
      )
    },
  )
}

function startAndObserve(
  started: StartedAgentLoop,
  onCompletionFailure: HandleSessionCompletionFailure,
): StartedSessionResponse {
  void started.completion.catch((error: unknown) => {
    onCompletionFailure({ sessionId: started.sessionId, turn: started.turn, error })
  })
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
  if (value.model !== undefined && !isModelRef(value.model)) {
    throw new TypeError("continueSession.model 无效")
  }
  return value.model === undefined
    ? { content: value.content }
    : { content: value.content, model: value.model }
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("continueSession.sessionId 无效")
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
