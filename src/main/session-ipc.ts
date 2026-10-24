/** Electron Session 命令、历史读取和已提交事件推送；短操作按对话身份串行。 */
import type { ModelRef } from "../../runtime/model/src/types.ts"
import { normalizeError } from "../../runtime/error/src/index.ts"
import { requireProjectId } from "../../runtime/session/src/project-id.ts"
import type { ProjectId } from "../../runtime/session/src/project-id.ts"
import type { UserMessageInput } from "../../runtime/session/src/events.ts"
import type { SandboxMode, SessionSettingsPatch } from "../../runtime/session/src/session-state.ts"
import { SessionRuntime } from "../../runtime/agent/src/session-runtime.ts"
import type { ContinueSessionInput, SessionRuntimeSnapshot, StartNewSessionInput, StartedSessionTurn } from "../../runtime/agent/src/session-runtime.ts"
import { INITIAL_SESSION_NAME } from "../../runtime/session/src/meta-store.ts"
import { SESSION_IPC_CHANNELS } from "../preload/session-api.ts"
import type { SessionControl, SessionData, SessionUpdate } from "../preload/session-api.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { reconcileWorkspaceSessions } from "./workspace-store.ts"

/** Electron 与无框架测试共用的最小 handler 注册边界。 */
export interface IpcMainHandlePort {
  /**
   * @param channel 固定通道。
   * @param listener 校验参数并返回可序列化结果的处理器。
   */
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}
/** 后台执行、索引或窗口发送错误；宿主负责记录。 */
export interface SessionCompletionFailure {
  /** 发生错误的对话身份。 */
  sessionId: string
  /** 当前或最近一轮编号；无法确定时为 0。 */
  turn: number
  /** 供宿主记录的原始错误。 */
  error: unknown
}
/**
 * @param failure 后台错误及所属对话。
 */
export type HandleSessionCompletionFailure = (failure: SessionCompletionFailure) => void
/**
 * @param projectId 所属分组。
 * @param sessionId 对话身份。
 * @param onStateChanged Queue、初始化或关闭通知。
 * @returns 完整绑定宿主能力的 Runtime。
 */
export type CreateSessionRuntime = (projectId: ProjectId, sessionId: string, onStateChanged?: () => void) => SessionRuntime
/** 原始事件、控制快照与宿主错误共用的窗口出口。 */
export interface SessionEventForwardingPort {
  /**
   * @param update 可序列化更新。
   * @throws Error 发送失败，调用方只报告，不中断 Runtime。
   */
  sendSessionUpdateToRenderer(update: SessionUpdate): void | Promise<void>
}
/** 每个对话的短操作尾链与控制版本；不保存模型配置或凭据。 */
interface SessionIpcState {
  tail: Promise<void>
  revision: number
  control?: SessionControl
}

/**
 * 注册 Session IPC，管理活动实例，并在成功持久化后发送更新。
 * @param ipcMain 主进程注册端口。
 * @param createRuntime 按联合身份构造 Runtime 的工厂。
 * @param onCompletionFailure 宿主错误记录出口。
 * @param eventForwarding 存活窗口更新出口；测试可省略。
 * @param paths 索引核对需要的既有数据库路径；单元测试可省略。
 * @throws Error 注册重复、请求参数无效或短操作失败时抛给 IPC 调用方。
 */
export function registerSessionIpcHandlers(
  ipcMain: IpcMainHandlePort,
  createRuntime: CreateSessionRuntime,
  onCompletionFailure: HandleSessionCompletionFailure,
  eventForwarding: SessionEventForwardingPort = { sendSessionUpdateToRenderer: () => {} },
  paths?: Pick<ConfigFilePaths, "rootDir" | "workspaceDatabasePath" | "metaDatabasePath">,
): void {
  const activeSessions = new Map<string, SessionRuntime>()
  const sessionIpcStates = new Map<string, SessionIpcState>()

  /**
   * @param projectId 分组。
   * @param sessionId 对话。
   * @returns 不含拼接歧义的身份。
   */
  function keyOf(projectId: string, sessionId: string): string { return JSON.stringify([projectId, sessionId]) }
  /**
   * @param key 联合身份。
   * @returns 懒创建的版本与短操作状态。
   */
  function stateOf(key: string): SessionIpcState {
    let state = sessionIpcStates.get(key)
    if (!state) { state = { tail: Promise.resolve(), revision: 0 }; sessionIpcStates.set(key, state) }
    return state
  }
  /**
   * @param key 联合身份。
   * @param action 只覆盖短操作的异步任务。
   * @returns 独立传播本次失败的结果。
   */
  function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const state = stateOf(key)
    const result = state.tail.then(action)
    state.tail = result.then(() => {}, () => {})
    return result
  }
  /**
   * @param update 原始更新。
   * @returns 发送尝试完成；传输失败交给宿主。
   */
  async function send(update: SessionUpdate): Promise<void> {
    try { await eventForwarding.sendSessionUpdateToRenderer(update) }
    catch (error) { onCompletionFailure({ sessionId: update.sessionId, turn: update.kind === "event" ? update.event.turn ?? 0 : 0, error }) }
  }
  /**
   * @param projectId 分组。
   * @param runtime 实例。
   * @param stage 失败环节。
   * @param error 原错误。
   * @returns 报告完成。
   */
  async function report(projectId: string, runtime: SessionRuntime, stage: "runtime" | "index", error: unknown): Promise<void> {
    onCompletionFailure({ sessionId: runtime.sessionId, turn: runtime.currentTurn ?? 0, error })
    await send({ kind: "error", projectId, sessionId: runtime.sessionId, stage,
      error: normalizeError(error, "runtime", stage === "index" ? "SESSION_INDEX_FAILED" : "SESSION_RUNTIME_FAILED") })
  }
  /**
   * @param projectId 分组。
   * @param runtime 实例。
   * @returns 索引检查完成；错误不会撤销日志。
   */
  async function index(projectId: string, runtime: SessionRuntime): Promise<void> {
    if (!paths) return
    try { reconcileWorkspaceSessions(paths, projectId) }
    catch (error) { await report(projectId, runtime, "index", error) }
  }
  /**
   * @param key 联合身份。
   * @param snapshot 已提交历史与控制状态。
   * @returns 新版本控制快照。
   */
  function controlOf(key: string, snapshot: SessionRuntimeSnapshot): SessionControl {
    const state = stateOf(key)
    const { events: _events, settings, ...control } = snapshot
    const discardedMessages = control.phase === "idle" && control.discardedMessages.length === 0
      ? state.control?.discardedMessages ?? [] : control.discardedMessages
    state.control = { ...control, discardedMessages, revision: ++state.revision,
      currentModel: settings.currentModel, sandboxMode: settings.sandboxMode }
    return state.control
  }
  /**
   * @param projectId 分组。
   * @param runtime 实例。
   * @returns 当前快照发布完成。
   */
  async function publishState(projectId: string, runtime: SessionRuntime): Promise<void> {
    const key = keyOf(projectId, runtime.sessionId)
    const newer = activeSessions.get(key)
    if (newer && newer !== runtime) return
    const snapshot = await runtime.readSnapshot()
    if (snapshot.phase === "idle" && activeSessions.get(key) === runtime) activeSessions.delete(key)
    const control = controlOf(key, snapshot)
    await send({ kind: "state", projectId, sessionId: runtime.sessionId, control })
  }
  /**
   * @param projectId 分组。
   * @param sessionId 对话。
   * @returns 身份匹配并能通知状态的实例。
   * @throws Error 工厂返回其他身份。
   */
  function createActive(projectId: ProjectId, sessionId: string): SessionRuntime {
    const key = keyOf(projectId, sessionId)
    const runtime = createRuntime(projectId, sessionId, () => {
      void serial(key, () => publishState(projectId, runtime)).catch((error) => report(projectId, runtime, "runtime", error))
    })
    if (runtime.sessionId !== sessionId) { runtime.close(); throw new Error("SessionRuntime 工厂返回了错误实例") }
    activeSessions.set(key, runtime)
    return runtime
  }
  /**
   * @param projectId 分组。
   * @param runtime 活动实例。
   * @param started 首轮提交。
   */
  function observe(projectId: ProjectId, runtime: SessionRuntime, started: StartedSessionTurn): void {
    const key = keyOf(projectId, runtime.sessionId)
    const consuming = (async () => {
      for await (const event of started.events) {
        await send({ kind: "event", projectId, sessionId: runtime.sessionId, event })
        if (event.type === "user/message" || event.type === "turn/end") await index(projectId, runtime)
      }
    })().catch((error) => report(projectId, runtime, "runtime", error))
    const processing = runtime.processMessageQueue(started)
    /** 运行完成先移除活动身份，再报告错误；消息流仍继续排空。 */
    const finished = processing.completion.then(() => {
      if (activeSessions.get(key) === runtime) activeSessions.delete(key)
    }, async (error: unknown) => {
      if (activeSessions.get(key) === runtime) activeSessions.delete(key)
      await report(projectId, runtime, "runtime", error)
    })
    void finished.then(async () => {
      await consuming
      await serial(key, async () => {
        await publishState(projectId, runtime)
      })
    }).catch((error) => report(projectId, runtime, "runtime", error))
  }
  /**
   * @param projectId 分组。
   * @param sessionId 对话。
   * @param action 快照或设置短操作。
   * @returns 操作结果；临时实例始终关闭。
   */
  async function withRuntime<T>(projectId: ProjectId, sessionId: string, action: (runtime: SessionRuntime) => Promise<T>): Promise<T> {
    const active = activeSessions.get(keyOf(projectId, sessionId))
    if (active) return action(active)
    const runtime = createRuntime(projectId, sessionId)
    if (runtime.sessionId !== sessionId) { runtime.close(); throw new Error("SessionRuntime 工厂返回了错误实例") }
    try {
      const before = (await runtime.readEvents()).length
      await runtime.repairSession()
      const snapshot = await runtime.readSnapshot()
      for (const event of snapshot.events.slice(before)) await send({ kind: "event", projectId, sessionId, event })
      await index(projectId, runtime)
      return await action(runtime)
    } finally { runtime.close() }
  }

  ipcMain.handle(SESSION_IPC_CHANNELS.startNewSession, async (_event, rawProjectId, rawInput) => {
    const projectId = requireProjectId(rawProjectId)
    const input = requireUserMessageInput(rawInput)
    const sessionId = SessionRuntime.createSessionId()
    const key = keyOf(projectId, sessionId)
    return serial(key, async () => {
      const runtime = createActive(projectId, sessionId)
      try {
        const started = await runtime.startNewSession(input)
        observe(projectId, runtime, started)
        await index(projectId, runtime)
        return { sessionId, turn: started.turn }
      } catch (error) { activeSessions.delete(key); runtime.close(); throw error }
    })
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.continueSession, async (_event, rawProjectId, rawSessionId, rawInput) => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId)
    const input = requireContinueSessionInput(rawInput)
    const key = keyOf(projectId, sessionId)
    return serial(key, async () => {
      if (activeSessions.has(key)) throw new Error(`Session 正在运行，请使用 enqueueSessionMessage：${sessionId}`)
      const runtime = createActive(projectId, sessionId)
      try {
        const started = await runtime.continueSession(input)
        observe(projectId, runtime, started)
        return { sessionId, turn: started.turn }
      } catch (error) { activeSessions.delete(key); runtime.close(); throw error }
    })
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.enqueueSessionMessage, async (_event, rawProjectId, rawSessionId, rawInput) => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId)
    if (!isRecord(rawInput) || Object.keys(rawInput).length !== 1 || !isTextContent(rawInput.content)) throw new TypeError("enqueueSessionMessage 输入无效")
    return serial(keyOf(projectId, sessionId), async () => {
      const runtime = activeSessions.get(keyOf(projectId, sessionId))
      if (!runtime) throw new Error(`Session 当前未运行，不能追加消息：${sessionId}`)
      const response = runtime.enqueueSessionMessage({ content: rawInput.content as UserMessageInput["content"] })
      try { await publishState(projectId, runtime) }
      catch (error) { await report(projectId, runtime, "runtime", error) }
      return response
    })
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.stopSession, async (_event, rawProjectId, rawSessionId) => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId)
    return serial(keyOf(projectId, sessionId), async () => {
      const runtime = activeSessions.get(keyOf(projectId, sessionId))
      if (runtime) {
        runtime.stop()
        try { await publishState(projectId, runtime) }
        catch (error) { await report(projectId, runtime, "runtime", error) }
      }
      return { sessionId }
    })
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.getSessionData, async (_event, rawProjectId, rawSessionId): Promise<SessionData> => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId), key = keyOf(projectId, sessionId)
    return serial(key, () => withRuntime(projectId, sessionId, async (runtime) => {
      const snapshot = await runtime.readSnapshot()
      const last = snapshot.events.at(-1)
      return { projectId, sessionId, events: snapshot.events, latestSeq: last?.seq ?? 0,
        summary: { sessionId, name: snapshot.settings.name || INITIAL_SESSION_NAME, updatedAt: last?.createdAt ?? new Date().toISOString() },
        control: controlOf(key, snapshot) }
    }))
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.updateSessionSettings, async (_event, rawProjectId, rawSessionId, rawPatch) => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId)
    const patch = requireSettingsPatch(rawPatch)
    return serial(keyOf(projectId, sessionId), () => withRuntime(projectId, sessionId, async (runtime) => {
      await runtime.updateSettings(patch)
      const control = controlOf(keyOf(projectId, sessionId), await runtime.readSnapshot())
      await send({ kind: "state", projectId, sessionId, control })
      return control
    }))
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.decideSessionApproval, async (_event, rawProjectId, rawSessionId, rawApprovalId, decision) => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId), approvalId = requireSessionId(rawApprovalId)
    if (decision !== "approved" && decision !== "denied") throw new TypeError("审批决定无效")
    return serial(keyOf(projectId, sessionId), () => withRuntime(projectId, sessionId, async (runtime) => {
      const accepted = runtime.decideApproval(approvalId, decision)
      try { await publishState(projectId, runtime) }
      catch (error) { await report(projectId, runtime, "runtime", error) }
      return { accepted }
    }))
  })
}

/**
 * @param value IPC 输入。
 * @returns 已校验首轮输入。
 * @throws TypeError 无效文本、模型或权限。
 */
function requireUserMessageInput(value: unknown): StartNewSessionInput {
  if (!isRecord(value) || !isTextContent(value.content) || !isModelRef(value.model) ||
    (value.sandboxMode !== undefined && !isSandboxMode(value.sandboxMode))) throw new TypeError("Session 输入无效")
  return { content: value.content, model: value.model, ...(value.sandboxMode === undefined ? {} : { sandboxMode: value.sandboxMode }) }
}
/**
 * 校验已有对话的 content-only 输入，模型选择由 Session Meta 提供。
 * @param value Renderer 发来的未知值。
 * @returns 只含文本内容的继续输入。
 * @throws TypeError 当内容无效或试图覆盖模型、权限时抛出。
 */
function requireContinueSessionInput(value: unknown): ContinueSessionInput {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isTextContent(value.content)) {
    throw new TypeError("继续对话输入无效")
  }
  return { content: value.content }
}
/**
 * @param value IPC patch。
 * @returns 仅含已知设置字段的 patch。
 * @throws TypeError 空 patch 或未知字段。
 */
function requireSettingsPatch(value: unknown): SessionSettingsPatch {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => key !== "model" && key !== "sandboxMode") ||
    ("model" in value && !isModelRef(value.model)) || ("sandboxMode" in value && !isSandboxMode(value.sandboxMode))) throw new TypeError("Session 设置无效")
  return value as SessionSettingsPatch
}
/**
 * @param value 待校验身份。
 * @returns 非空身份。
 * @throws TypeError 无效身份。
 */
function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("sessionId 无效")
  return value
}
/**
 * @param value 权限值。
 * @returns 是否为已确定的权限模式。
 */
function isSandboxMode(value: unknown): value is SandboxMode { return value === "sandbox-full-access" || value === "sandbox-read-only" || value === "full-access" }
/**
 * @param value IPC 模型引用。
 * @returns 是否含恰好五个有效字段。
 */
function isModelRef(value: unknown): value is ModelRef {
  return isRecord(value) && Object.keys(value).length === 5 &&
    typeof value.providerId === "string" && value.providerId.length > 0 && typeof value.modelId === "string" && value.modelId.length > 0 &&
    typeof value.name === "string" && value.name.length > 0 &&
    typeof value.reasoningLevel === "string" && value.reasoningLevel.trim() !== "" &&
    (value.protocol === "anthropic_messages" || value.protocol === "chat_completions" || value.protocol === "responses")
}
/**
 * @param value IPC 文本数组。
 * @returns 是否只有文本块。
 */
function isTextContent(value: unknown): value is UserMessageInput["content"] {
  return Array.isArray(value) && value.every((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
}
/**
 * @param value 未知值。
 * @returns 是否为普通对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
