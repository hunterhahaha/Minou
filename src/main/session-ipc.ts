/** Electron Session 命令、历史读取和活动事件推送；短操作按对话身份串行。 */
import type { IpcMainInvokeEvent, WebContents, WebContentsDidStartNavigationEventParams } from "electron"
import type { ModelRef } from "../../runtime/model/src/types.ts"
import { normalizeError } from "../../runtime/error/src/index.ts"
import { requireProjectId } from "../../runtime/session/src/project-id.ts"
import type { ProjectId } from "../../runtime/session/src/project-id.ts"
import type { AssistantContentBlock } from "../../runtime/model/src/types.ts"
import type { SessionEvent, UserMessageContent } from "../../runtime/session/src/events.ts"
import { DEFAULT_SESSION_SANDBOX_MODE, SANDBOX_MODES, type SandboxMode, type SessionSettingsPatch } from "../../runtime/session/src/session-state.ts"
import { listRunnableQueues, SessionMessageQueue } from "../../runtime/session/src/message-queue.ts"
import { insertTeamWorkspace, type TeamIdentity } from "../../runtime/session/src/team-store.ts"
import type { TeamMode } from "./team-mode.ts"
import { join } from "node:path"
import { SessionRuntime } from "../../runtime/agent/src/session-runtime.ts"
import type { SessionRuntimeProcessing, SessionRuntimeSnapshot, StartNewSessionInput } from "../../runtime/agent/src/session-runtime.ts"
import { INITIAL_SESSION_NAME, updateSessionMetaNameIfDefault } from "../../runtime/session/src/meta-store.ts"
import { SESSION_IPC_CHANNELS, START_TEAM_SESSION_CHANNEL, TEAM_SESSION_CHANNELS, TEAM_WAKEUP_CHANNELS } from "../preload/session-api.ts"
import type { SessionControl, SessionData, SessionKind, SessionSummary, SessionUpdate } from "../preload/session-api.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { reconcileWorkspaceSessions } from "./workspace-store.ts"
import { validateMessageFileReferences } from "./file-explorer-ipc.ts"

/**
 * 投影可向渲染进程公开的事件字段，保留日志序号和块索引。
 * @param event 已提交的会话事件。
 * @returns 剔除协议原生内容的同一事件投影。
 */
function publicSessionEvent(event: SessionEvent): SessionEvent {
  const project = ({ replay: _replay, ...block }: AssistantContentBlock): AssistantContentBlock => block
  if (event.type === "assistant/block_end") return { ...event, block: project(event.block) }
  if (event.type === "assistant/message") {
    return { ...event, message: { ...event.message, content: event.message.content.map(project) } }
  }
  return event
}

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
export type CreateSessionRuntime = (
  projectId: ProjectId, sessionId: string, onStateChanged?: () => void, teamIdentity?: TeamIdentity,
) => SessionRuntime

/** 主进程持有的桌面会话调度入口。 */
export interface SessionDispatch {
  /** 开始或继续某个可消费队列，已经有活动实例时交给该实例。 */
  kick(projectId: ProjectId, sessionId: string): void
  /** 终止已被 Router 永久关闭的成员 Runtime。 */
  cancelMember(projectId: ProjectId, sessionId: string): void
  /** 恢复应用关闭前未暂停的队列。 */
  restore(): void
  /** 停止接收新任务、取消活动 Turn，并等待日志收尾。 */
  shutdown(): Promise<void>
}
/** 原始事件、控制快照与宿主错误共用的窗口出口。 */
export interface SessionEventForwardingPort {
  /**
   * @param update 可序列化更新。
   * @param recipients 成员更新只发给这些 WebContents；省略时广播。
   * @throws Error 发送失败，调用方只报告，不中断 Runtime。
   */
  sendSessionUpdateToRenderer(update: SessionUpdate, recipients?: ReadonlySet<number>): void | Promise<void>
}
/** 每个对话的短操作尾链与控制版本；不保存模型配置或凭据。 */
interface SessionIpcState {
  tail: Promise<void>
  revision: number
}

/** IPC 形状校验后的正文与尚未验证的文件引用。 */
interface RawMessageContent {
  content: UserMessageContent["content"]
  fileReferences?: unknown
}

/**
 * 注册 Session IPC，管理活动实例，并在成功持久化后发送更新。
 * @param ipcMain 主进程注册端口。
 * @param createRuntime 按联合身份构造 Runtime 的工厂。
 * @param onCompletionFailure 宿主错误记录出口。
 * @param eventForwarding 存活窗口更新出口；测试可省略。
 * @param paths 索引核对需要的既有数据库路径；单元测试可省略。
 * @param team 负责 Team 工具与空闲唤醒的桌面调度器。
 * @returns 供启动、退出和 Team 工具唤醒使用的调度入口。
 * @throws Error 注册重复、请求参数无效或短操作失败时抛给 IPC 调用方。
 */
export function registerSessionIpcHandlers(
  ipcMain: IpcMainHandlePort,
  createRuntime: CreateSessionRuntime,
  onCompletionFailure: HandleSessionCompletionFailure,
  eventForwarding: SessionEventForwardingPort = { sendSessionUpdateToRenderer: () => {} },
  paths?: Pick<ConfigFilePaths, "rootDir" | "workspaceDatabasePath" | "metaDatabasePath">,
  team?: TeamMode,
): SessionDispatch {
  const activeSessions = new Map<string, SessionRuntime>()
  const sessionIpcStates = new Map<string, SessionIpcState>()
  const processing = new Set<Promise<void>>()
  const eventsPath = paths && join(paths.rootDir, "events.sqlite")
  let exiting = false

  /**
   * 附加经主进程校验的文件引用；没有引用时沿用纯文本输入。
   * @param projectId 当前对话所属项目。
   * @param input 已通过请求形状校验的消息。
   * @returns 文本与可选引用，供 Runtime 原子提交或排队。
   * @throws Error 当引用缺少关联目录、文件或正确的正文位置时抛出。
   */
  async function messageContent(projectId: ProjectId, input: RawMessageContent): Promise<UserMessageContent> {
    const { content, fileReferences } = input
    if (fileReferences === undefined) return { content }
    if (!paths || content.length !== 1) throw new TypeError("文件引用需要单个项目消息文本块")
    return { content, fileReferences: await validateMessageFileReferences(paths.workspaceDatabasePath, projectId, content[0].text, fileReferences) }
  }

  /**
   * @param projectId 分组。
   * @param sessionId 对话。
   * @returns 不含拼接歧义的身份。
   */
  function keyOf(projectId: string, sessionId: string): string { return JSON.stringify([projectId, sessionId]) }
  /** 按成员联合身份索引订阅窗口。 */
  const memberSubscribers = new Map<string, Set<number>>()
  /** 每个文档只注册一次生命周期清理。 */
  const watchedSenders = new Set<number>()

  /**
   * 在主文档离开或进程退出时清空该窗口的订阅。
   * @param sender 已由可信 IPC 检查的主窗口。
   */
  function watchSender(sender: WebContents): void {
    if (watchedSenders.has(sender.id)) return
    const senderId = sender.id
    watchedSenders.add(senderId)
    /** 清理窗口的订阅和当前文档的监听。 */
    function clear(): void {
      watchedSenders.delete(senderId)
      for (const [key, recipients] of memberSubscribers) {
        recipients.delete(senderId)
        if (recipients.size === 0) memberSubscribers.delete(key)
      }
      sender.removeListener("destroyed", clear)
      sender.removeListener("render-process-gone", clear)
      sender.removeListener("did-start-navigation", onNavigation)
    }
    /**
     * @param navigation 主进程提供的导航信息，hash 路由继续使用原文档。
     */
    function onNavigation(navigation: WebContentsDidStartNavigationEventParams): void {
      if (navigation.isMainFrame && !navigation.isSameDocument) clear()
    }
    sender.on("destroyed", clear)
    sender.on("render-process-gone", clear)
    sender.on("did-start-navigation", onNavigation)
  }

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
   * @param role 热路径已知的持久化角色；其他调用按联合身份查询。
   * @returns 发送尝试完成；传输失败交给宿主。
   */
  async function send(update: SessionUpdate, role?: SessionKind): Promise<void> {
    try {
      const member = (role ?? team?.store.identity(update.projectId, update.sessionId)?.role) === "member"
      const recipients = member ? memberSubscribers.get(keyOf(update.projectId, update.sessionId)) : undefined
      if (member && !recipients?.size) return
      await eventForwarding.sendSessionUpdateToRenderer(
        update.kind === "event" ? { ...update, event: publicSessionEvent(update.event) } : update, recipients,
      )
    }
    catch (error) { onCompletionFailure({ sessionId: update.sessionId, turn: "event" in update ? update.event.turn ?? 0 : 0, error }) }
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
    const { events: _events, streamEvents: _streamEvents, settings, ...control } = snapshot
    return { ...control, revision: ++state.revision,
      currentModel: settings.currentModel, sandboxMode: settings.sandboxMode }
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
    if (snapshot.phase === "idle" && activeSessions.get(key) === runtime) return
    const control = controlOf(key, snapshot)
    await send({ kind: "state", projectId, sessionId: runtime.sessionId, control })
  }
  /**
   * @param projectId 分组。
   * @param sessionId 对话。
   * @param teamIdentity 仅 Team 首发时显式传入待提交的身份。
   * @returns 身份匹配并能通知状态的实例。
   * @throws Error 工厂返回其他身份。
   */
  function createActive(projectId: ProjectId, sessionId: string, teamIdentity?: TeamIdentity): SessionRuntime {
    if (exiting) throw new Error("应用正在退出")
    const key = keyOf(projectId, sessionId)
    const runtime = createRuntime(projectId, sessionId, () => {
      void serial(key, () => publishState(projectId, runtime)).catch((error) => report(projectId, runtime, "runtime", error))
    }, teamIdentity)
    if (runtime.sessionId !== sessionId) { runtime.close(); throw new Error("SessionRuntime 工厂返回了错误实例") }
    activeSessions.set(key, runtime)
    return runtime
  }
  /**
   * @param projectId 分组。
   * @param runtime 活动实例。
   * @param run 首轮提交和活动期完成任务。
   * @param sessionKind 当前持久化角色，用于窗口分流、首个事件标记与工作区索引筛选。
   */
  function observe(projectId: ProjectId, runtime: SessionRuntime, run: SessionRuntimeProcessing, sessionKind: SessionKind): void {
    const key = keyOf(projectId, runtime.sessionId)
    const consuming = (async () => {
      for await (const event of runtime.events) {
        if ("streamSeq" in event) {
          await send({ kind: "stream", projectId, sessionId: runtime.sessionId, event }, sessionKind)
          continue
        }
        await send({ kind: "event", projectId, sessionId: runtime.sessionId, event, ...(event.seq === 1 && { sessionKind }) }, sessionKind)
        if (sessionKind !== "member" && (event.type === "user/message" || event.type === "turn/end")) {
          await index(projectId, runtime)
        }
      }
    })().catch((error) => report(projectId, runtime, "runtime", error))
    void run.started.catch(() => {})
    const completion = run.completion.catch((error: unknown) => report(projectId, runtime, "runtime", error))
      .then(async () => {
        await consuming
        await serial(key, async () => {
          const active = activeSessions.get(key)
          if (active && active !== runtime) return
          activeSessions.delete(key)
          try { await publishState(projectId, runtime) }
          finally { team?.settled(projectId, runtime.sessionId) }
        })
        kick(projectId, runtime.sessionId)
      }).catch((error) => report(projectId, runtime, "runtime", error))
      .finally(() => {
        if (activeSessions.get(key) === runtime) activeSessions.delete(key)
        processing.delete(completion)
      })
    processing.add(completion)
  }

  /**
   * 激活已持久化的可消费队列，等待现有实例收尾时由其回调再次检查。
   * @param projectId 所属 Project。
   * @param sessionId 目标 Session。
   */
  function kick(projectId: ProjectId, sessionId: string): void {
    if (exiting || eventsPath === undefined) return
    const key = keyOf(projectId, sessionId)
    void serial(key, async () => {
      if (exiting || activeSessions.has(key) || new SessionMessageQueue(eventsPath, projectId, sessionId).read(true).length === 0) return
      const identity = team?.store.identity(projectId, sessionId)
      if (identity?.role === "member" && team?.store.status(identity) === "closed") return
      const runtime = createActive(projectId, sessionId)
      try { observe(projectId, runtime, runtime.processMessageQueue(), identity?.role ?? "ordinary") }
      catch (error) { activeSessions.delete(key); runtime.close(); throw error }
    }).catch((error) => onCompletionFailure({ sessionId, turn: 0, error }))
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

  /**
   * 通过普通或 Team 首发入口提交首条用户消息。
   * @param rawProjectId IPC 所属 Project。
   * @param rawInput 首发输入。
   * @param mode Team 调度器，普通入口省略。
   * @returns 会话和首个 Turn 身份，Team 同时返回 Workspace ID。
   */
  async function start(rawProjectId: unknown, rawInput: unknown, mode?: TeamMode) {
    const projectId = requireProjectId(rawProjectId)
    const { model, sandboxMode, ...rawMessage } = requireUserMessageInput(rawInput)
    const sessionId = SessionRuntime.createSessionId()
    const key = keyOf(projectId, sessionId)
    return serial(key, async () => {
      const input = { ...await messageContent(projectId, rawMessage), model, ...(sandboxMode === undefined ? {} : { sandboxMode }) }
      const identity = mode?.router(projectId, sessionId, sandboxMode ?? DEFAULT_SESSION_SANDBOX_MODE)
      const runtime = createActive(projectId, sessionId, identity)
      try {
        const started = await runtime.startNewSession(input, paths === undefined ? undefined : async (title, stopSignal) => {
          try {
            await serial(key, async () => {
              if (stopSignal.aborted || !updateSessionMetaNameIfDefault(paths.metaDatabasePath, projectId, sessionId, title)) return
              reconcileWorkspaceSessions(paths, projectId)
              const snapshot = await (activeSessions.get(key) ?? runtime).readSnapshot()
              const summary = { sessionId, name: snapshot.settings.name, updatedAt: snapshot.events.at(-1)?.createdAt ?? new Date().toISOString() }
              await send({ kind: "state", projectId, sessionId, control: controlOf(key, snapshot), summary })
            })
          } catch (error) {
            onCompletionFailure({ sessionId, turn: 1, error })
          }
        }, identity && ((db) => insertTeamWorkspace(db, identity)))
        observe(projectId, runtime, runtime.processMessageQueue(started), identity?.role ?? "ordinary")
        await index(projectId, runtime)
        return { sessionId, turn: started.turn, ...(identity && { workspaceId: identity.workspaceId }) }
      } catch (error) { activeSessions.delete(key); runtime.close(); throw error }
    })
  }
  ipcMain.handle(SESSION_IPC_CHANNELS.startNewSession, (_event, projectId, input) => start(projectId, input))
  if (team) {
    ipcMain.handle(START_TEAM_SESSION_CHANNEL, (_event, projectId, input) => start(projectId, input, team))
    /**
     * @param projectId 目标项目。
     * @param routerId 必须是同项目的 Router。
     * @returns 已验证的团队身份。
     * @throws Error 当会话不是 Router 时。
     */
    const requireRouter = (projectId: ProjectId, routerId: unknown): TeamIdentity => {
      const identity = team.store.identity(projectId, requireSessionId(routerId))
      if (identity?.role !== "router") throw new Error("团队 Router 不存在")
      return identity
    }
    ipcMain.handle(TEAM_SESSION_CHANNELS.list, (_event, rawProjectId, routerId) => {
      const router = requireRouter(requireProjectId(rawProjectId), routerId)
      return team.store.memberIds(router.workspaceId)
    })
    for (const channel of [TEAM_SESSION_CHANNELS.subscribe, TEAM_SESSION_CHANNELS.unsubscribe]) {
      ipcMain.handle(channel, (event, rawProjectId, routerId, rawSessionId) => {
        const projectId = requireProjectId(rawProjectId)
        const router = requireRouter(projectId, routerId)
        const sessionId = requireSessionId(rawSessionId)
        const member = team.store.identity(projectId, sessionId)
        if (member?.role !== "member" || member.workspaceId !== router.workspaceId) throw new Error("成员不属于当前团队")
        const sender = (event as IpcMainInvokeEvent | undefined)?.sender
        if (!sender || sender.isDestroyed()) throw new Error("订阅窗口不可用")
        const key = keyOf(projectId, sessionId)
        if (channel === TEAM_SESSION_CHANNELS.subscribe) {
          watchSender(sender)
          const recipients = memberSubscribers.get(key) ?? new Set<number>()
          recipients.add(sender.id)
          memberSubscribers.set(key, recipients)
        } else {
          const recipients = memberSubscribers.get(key)
          recipients?.delete(sender.id)
          if (recipients?.size === 0) memberSubscribers.delete(key)
        }
      })
    }
    ipcMain.handle(TEAM_WAKEUP_CHANNELS.read, () => team.readConfig())
    ipcMain.handle(TEAM_WAKEUP_CHANNELS.update, (_event, input) => team.updateConfig(input))
  }
  ipcMain.handle(SESSION_IPC_CHANNELS.continueSession, async (_event, rawProjectId, rawSessionId, rawInput) => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId)
    const rawMessage = requireContinueSessionInput(rawInput)
    const key = keyOf(projectId, sessionId)
    return serial(key, async () => {
      const kind = team?.store.identity(projectId, sessionId)?.role ?? "ordinary"
      if (kind === "member") throw new Error("Team Session 任务由所属 Router 派发")
      if (activeSessions.has(key)) throw new Error(`Session 正在运行，请使用 enqueueSessionMessage：${sessionId}`)
      const input = await messageContent(projectId, rawMessage)
      const runtime = createActive(projectId, sessionId)
      try {
        await runtime.readEvents()
        runtime.enqueueSessionMessage(input, true)
        const run = runtime.processMessageQueue()
        observe(projectId, runtime, run, kind)
        const started = await run.started
        return { sessionId, turn: started.turn }
      } catch (error) { activeSessions.delete(key); runtime.close(); throw error }
    })
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.enqueueSessionMessage, async (_event, rawProjectId, rawSessionId, rawInput) => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId)
    const input = requireContinueSessionInput(rawInput, "enqueueSessionMessage 输入无效")
    return serial(keyOf(projectId, sessionId), async () => {
      if (team?.store.identity(projectId, sessionId)?.role === "member") throw new Error("Team Session 任务由所属 Router 派发")
      const runtime = activeSessions.get(keyOf(projectId, sessionId))
      if (!runtime) throw new Error(`Session 当前未运行，不能追加消息：${sessionId}`)
      const response = runtime.enqueueSessionMessage(await messageContent(projectId, input))
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
      } else if (eventsPath) {
        const queue = new SessionMessageQueue(eventsPath, projectId, sessionId)
        if (queue.read(true).length > 0) queue.pause()
      }
      return { sessionId }
    })
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.getSessionData, async (_event, rawProjectId, rawSessionId): Promise<SessionData> => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId), key = keyOf(projectId, sessionId)
    return serial(key, () => withRuntime(projectId, sessionId, async (runtime) => {
      const snapshot = await runtime.readSnapshot()
      const last = snapshot.events.at(-1)
      const kind = team?.store.identity(projectId, sessionId)?.role ?? "ordinary"
      return { projectId, sessionId, kind, events: snapshot.events.map(publicSessionEvent),
        streamEvents: snapshot.streamEvents, latestSeq: last?.seq ?? 0,
        summary: { sessionId, name: snapshot.settings.name || INITIAL_SESSION_NAME, updatedAt: last?.createdAt ?? new Date().toISOString() },
        control: controlOf(key, snapshot) }
    }))
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.renameSession, async (_event, rawProjectId, rawSessionId, name): Promise<SessionSummary> => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId)
    if (typeof name !== "string" || name.trim() === "") throw new TypeError("对话名称不能为空")
    const key = keyOf(projectId, sessionId)
    return serial(key, () => withRuntime(projectId, sessionId, async (runtime) => {
      await runtime.updateSettings({ name: name.trim() })
      const snapshot = await runtime.readSnapshot()
      if (paths) reconcileWorkspaceSessions(paths, projectId)
      const summary = { sessionId, name: snapshot.settings.name, updatedAt: snapshot.events.at(-1)?.createdAt ?? new Date().toISOString() }
      await send({ kind: "state", projectId, sessionId, control: controlOf(key, snapshot), summary })
      return summary
    }))
  })
  ipcMain.handle(SESSION_IPC_CHANNELS.exportSessionMarkdown, async (_event, rawProjectId, rawSessionId): Promise<string> => {
    const projectId = requireProjectId(rawProjectId), sessionId = requireSessionId(rawSessionId)
    const key = keyOf(projectId, sessionId)
    return serial(key, async () => {
      const active = activeSessions.get(key)
      const runtime = active ?? createRuntime(projectId, sessionId)
      try {
        if (runtime.sessionId !== sessionId) throw new Error("SessionRuntime 工厂返回了错误实例")
        const { events } = await runtime.readSnapshot()
        const messages: string[] = []
        for (const event of events) {
          if (event.type !== "user/message" && event.type !== "assistant/message") continue
          const body = event.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n")
          if (body.trim()) messages.push(`## ${event.type === "user/message" ? "用户" : "助手"}\n\n${body}`)
        }
        if (messages.length === 0) throw new Error("对话没有可复制的正文")
        return messages.join("\n\n")
      } finally {
        if (!active) runtime.close()
      }
    })
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
  return {
    kick,
    cancelMember(projectId, sessionId) {
      activeSessions.get(keyOf(projectId, sessionId))?.stop(false)
    },
    restore() {
      if (eventsPath !== undefined) {
        team?.restore()
        for (const { projectId, sessionId } of listRunnableQueues(eventsPath)) kick(projectId, sessionId)
      }
    },
    async shutdown() {
      exiting = true
      for (const runtime of activeSessions.values()) runtime.stop(false)
      await Promise.allSettled([...sessionIpcStates.values()].map(({ tail }) => tail))
      await Promise.allSettled(processing)
    },
  }
}

/**
 * @param value IPC 输入。
 * @returns 已校验首轮输入。
 * @throws TypeError 无效文本、模型或权限。
 */
function requireUserMessageInput(value: unknown): RawMessageContent & Pick<StartNewSessionInput, "model" | "sandboxMode"> {
  if (!isRecord(value) || !isTextContent(value.content) || !isModelRef(value.model) ||
    (value.sandboxMode !== undefined && !isSandboxMode(value.sandboxMode))) throw new TypeError("Session 输入无效")
  return { content: value.content, model: value.model, sandboxMode: value.sandboxMode, fileReferences: value.fileReferences }
}
/**
 * 校验已有对话的文本与可选引用字段，模型选择由 Session Meta 提供。
 * @param value Renderer 发来的未知值。
 * @param errorMessage 请求形状错误时的提示。
 * @returns 含文本与待验证引用的继续输入。
 * @throws TypeError 当内容无效或试图覆盖模型、权限时抛出。
 */
function requireContinueSessionInput(value: unknown, errorMessage = "继续对话输入无效"): RawMessageContent {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "content" && key !== "fileReferences") || !isTextContent(value.content)) {
    throw new TypeError(errorMessage)
  }
  return { content: value.content, fileReferences: value.fileReferences }
}
/**
 * @param value IPC patch。
 * @returns 仅含已知设置字段的 patch。
 * @throws TypeError 空 patch 或未知字段。
 */
function requireSettingsPatch(value: unknown): Omit<SessionSettingsPatch, "name"> {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => key !== "model" && key !== "sandboxMode") ||
    ("model" in value && !isModelRef(value.model)) || ("sandboxMode" in value && !isSandboxMode(value.sandboxMode))) throw new TypeError("Session 设置无效")
  return value as Omit<SessionSettingsPatch, "name">
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
function isSandboxMode(value: unknown): value is SandboxMode { return SANDBOX_MODES.includes(value as SandboxMode) }
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
function isTextContent(value: unknown): value is UserMessageContent["content"] {
  return Array.isArray(value) && value.every((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
}
/**
 * @param value 未知值。
 * @returns 是否为普通对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
