import type { MinouPreloadApi, SessionUpdate } from "../preload/session-api.ts"
import { errorMessage, sessionKey, WorkspaceSessionState } from "./session-state.ts"

/** 内置浏览器中的成员及其所属 Router。 */
export interface TeamSessionTarget {
  /** 所属项目或独立会话分组。 */
  projectId: string
  /** 拥有此成员的 Router。 */
  routerId: string
  /** Team Session 的持久化身份。 */
  sessionId: string
}

/** 工作台内的成员历史缓存。只有可见成员页订阅它的渲染通知。 */
export class TeamSessionState {
  private readonly opened = new Map<string, TeamSessionTarget>()
  private readonly receiving = new Set<string>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()

  /** 发起订阅变更和历史查询的 preload 端口。 */
  private readonly api: Pick<MinouPreloadApi, "subscribeTeamSession" | "unsubscribeTeamSession" | "getSessionData">

  /** 原始事件和控制快照共用普通会话的合并和补查规则。 */
  readonly history: WorkspaceSessionState

  /**
   * @param api 成员订阅和历史查询的 preload 接口。
   */
  constructor(api: TeamSessionState["api"]) {
    this.api = api
    this.history = new WorkspaceSessionState(api, (key) => {
      this.revisions.set(key, this.version(key) + 1)
      this.listeners.get(key)?.forEach((listener) => listener())
    })
  }

  /**
   * @param key 成员缓存键。
   * @returns 与该成员渲染数据对应的版本。
   */
  version(key: string): number { return this.revisions.get(key) ?? 0 }

  /**
   * @param key 可见的成员缓存键。
   * @param listener 对应页面的渲染通知。
   * @returns 页面卸载时移除监听的函数。
   */
  observe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(key)
    }
  }

  /**
   * 打开标签后登记增量接收，再订阅并取历史。
   * @param target 新打开的成员。
   */
  open(target: TeamSessionTarget): void {
    const key = sessionKey(target.projectId, target.sessionId)
    if (this.opened.has(key)) return
    const opening = { ...target }
    this.opened.set(key, opening)
    this.load(opening)
  }

  /**
   * 重试打开中的成员。快速重开时等待旧查询结束再取得新快照。
   * @param target 成员身份。
   */
  retry(target: TeamSessionTarget): void {
    const key = sessionKey(target.projectId, target.sessionId)
    const opened = this.opened.get(key)
    if (opened && !this.history.view(key).loading) this.load(opened)
  }

  /**
   * 立即停止合并该成员的增量，依序取消 IPC 订阅。
   * @param target 已关闭最后一个标签的成员。
   */
  close(target: TeamSessionTarget): void {
    const { projectId, routerId, sessionId } = target
    const key = sessionKey(projectId, sessionId)
    if (!this.opened.delete(key)) return
    this.receiving.delete(key)
    void this.enqueue(key, () => this.api.unsubscribeTeamSession(projectId, routerId, sessionId))
      .catch((error: unknown) => console.error("解除团队成员订阅失败", error))
  }

  /**
   * @param update 通过独立团队通道收到的增量。
   */
  receive(update: SessionUpdate): void {
    const key = sessionKey(update.projectId, update.sessionId)
    if (!this.receiving.has(key)) return
    try { this.history.receive(update) }
    catch (error) { this.history.setView(key, { operationError: errorMessage(error) }) }
  }

  /**
   * @param target 当前打开周期的身份对象。
   */
  private load(target: TeamSessionTarget): void {
    const { projectId, routerId, sessionId } = target
    const key = sessionKey(projectId, sessionId)
    this.history.setView(key, { loading: true, loadError: undefined, operationError: undefined })
    void this.enqueue(key, async () => {
      if (this.opened.get(key) !== target) return
      this.receiving.add(key)
      try { await this.api.subscribeTeamSession(projectId, routerId, sessionId) }
      catch (error) {
        if (this.opened.get(key) === target) this.receiving.delete(key)
        throw error
      }
    }).then(async () => {
      await this.history.sessionLoadsRef.get(key)?.catch(() => {})
      if (this.opened.get(key) === target) await this.history.load(projectId, sessionId, true)
    }).catch((error: unknown) => {
      if (this.opened.get(key) === target) this.history.setView(key, { loading: false, loadError: errorMessage(error) })
    })
  }

  /**
   * 订阅切换串行，历史查询独立完成。
   * @param key 成员缓存键。
   * @param action 订阅或取消订阅。
   * @returns 本次请求的结果。
   */
  private enqueue(key: string, action: () => Promise<void>): Promise<void> {
    const task = (this.tails.get(key) ?? Promise.resolve()).then(action)
    const tail = task.then(() => {}, () => {})
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    return task
  }
}
