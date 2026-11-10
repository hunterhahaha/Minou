/** 桌面 Team 协作的进程级调度，持久状态由 TeamStore 维护。 */
import { randomUUID } from "node:crypto"
import type { TeamRuntimeOptions } from "../../runtime/agent/src/session-runtime.ts"
import type { ProjectId } from "../../runtime/session/src/project-id.ts"
import { TeamStore, type TeamIdentity, type TeamWakeupConfig } from "../../runtime/session/src/team-store.ts"
import type { SandboxMode } from "../../runtime/session/src/session-state.ts"
import { createAbortError } from "../../runtime/error/src/abort.ts"
import type { HandleSessionCompletionFailure, SessionDispatch } from "./session-ipc.ts"

/** 在模型系统提示中限定 Router 的调度职责和各成员的写入范围。 */
export const ROUTER_PROMPT = "You are the Team Router. Delegate the actual work with communication, track the results and authorization requests, and report to the user. For parallel code tasks, assign explicit non-overlapping file or directory write scopes."

/** 在模型系统提示中说明成员的协作职责与授权边界。 */
export const MEMBER_PROMPT = "You are a Team Session. Work within the scope assigned by the Router. Publish useful shared results on the Workspace blackboard. Use communication to report completion or to request a decision before changing architecture, scope, or collaboration rules. When woken by the blackboard, use unread to discover the relevant posts."

/** 持有当前进程的 Team 工具端口和各空闲成员的轮询任务。 */
export class TeamMode {
  /** Team 身份和持久协作状态。 */
  readonly store: TeamStore
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly reportFailure: HandleSessionCompletionFailure
  private readonly closeTerminals?: (projectId: ProjectId, sessionId: string) => Promise<void>
  private dispatch?: SessionDispatch
  private exiting = false

  /**
   * 绑定已初始化的桌面事件数据库。
   * @param databasePath 共享 SQLite 路径。
   * @param reportFailure 桌面后台失败出口。
   * @param closeTerminals 成员永久关闭后清理其跨 Turn 保留的终端。
   */
  constructor(
    databasePath: string,
    reportFailure: HandleSessionCompletionFailure,
    closeTerminals?: (projectId: ProjectId, sessionId: string) => Promise<void>,
  ) {
    this.store = new TeamStore(databasePath)
    this.reportFailure = reportFailure
    this.closeTerminals = closeTerminals
  }

  /**
   * 连接现有桌面会话调度。
   * @param dispatch 会话 IPC 注册返回的活动实例入口。
   */
  connect(dispatch: SessionDispatch): void { this.dispatch = dispatch }

  /**
   * 生成与首轮事务一起保存的 Router 与 Workspace 身份。
   * @param projectId 所属 Project。
   * @param sessionId 已生成的 Router 会话 ID。
   * @param sandboxMode 首轮权限。
   * @returns 供 Runtime 初始化使用的身份。
   */
  router(projectId: ProjectId, sessionId: string, sandboxMode: SandboxMode): TeamIdentity {
    return { role: "router", projectId, sessionId, routerId: sessionId, workspaceId: randomUUID(), sandboxMode }
  }

  /**
   * 为单个活动 Runtime 创建协作工具入口。
   * @param identity 已从存储查明的 Team 身份，或首轮正在创建的 Router。
   * @returns 只操作所属 Workspace 的 Runtime 端口。
   */
  runtime(identity: TeamIdentity): TeamRuntimeOptions {
    return {
      identity,
      tools: (readSettings) => ({
        role: identity.role,
        communicate: async (input, signal) => {
          if (signal.aborted) throw createAbortError()
          if (this.exiting) throw new Error("应用正在退出")
          switch (input.event) {
            case "create_session": {
              const settings = await readSettings()
              if (signal.aborted) throw createAbortError()
              if (this.exiting) throw new Error("应用正在退出")
              const id = this.store.createMember(identity, settings, input.session_info)
              const member = this.store.identity(identity.projectId, id)!
              if (input.session_info === undefined) this.refresh(member, "idle")
              else this.dispatch?.kick(identity.projectId, id)
              return { data: { session_id: id, status: this.store.status(member) } }
            }
            case "send_message":
            case "close_session": {
              const sent = input.event === "send_message"
              const result = this.store.assignOrClose(identity, input.session_id, sent ? input.message : undefined)
              this.clearTimer(input.session_id)
              if (sent) this.dispatch?.kick(identity.projectId, input.session_id)
              else {
                this.dispatch?.cancelMember(identity.projectId, input.session_id)
                try { await this.closeTerminals?.(identity.projectId, input.session_id) }
                catch (error) { this.reportFailure({ sessionId: input.session_id, turn: 0, error }) }
              }
              return { data: { session_id: input.session_id, status: result.status, message_id: result.messageId } }
            }
            case "report_completion":
            case "request_authorization": {
              const status = input.event === "report_completion" ? "finished" : "waiting"
              const messageId = this.store.report(identity, status, input.message)
              this.dispatch?.kick(identity.projectId, identity.routerId)
              return { data: { status, message_id: messageId } }
            }
          }
        },
        blackboard: (input) => {
          if (this.exiting) throw new Error("应用正在退出")
          switch (input.mode) {
            case "read": return { data: this.store.read(identity, input.postId) }
            case "unread": return { summaries: this.store.unread(identity) }
            case "publish": {
              const post = this.store.publish(identity, input.post)
              for (const id of post.idle) {
                try {
                  const member = this.store.identity(identity.projectId, id)
                  if (member) this.refresh(member, "publish", post.mentions.includes(id))
                } catch (error) { this.reportFailure({ sessionId: id, turn: 0, error }) }
              }
              return { data: { id: post.id } }
            }
          }
        },
      }),
    }
  }

  /**
   * 处理会话活动期收尾；只有回到 idle 的成员才参与黑板轮询。
   * @param projectId 所属 Project。
   * @param sessionId 活动期已结束的会话。
   */
  settled(projectId: ProjectId, sessionId: string): void {
    if (this.exiting) return
    const member = this.store.identity(projectId, sessionId)
    if (member?.role === "member" && this.store.settle(member) === "idle") this.refresh(member, "idle")
  }

  /** 恢复重启后的成员状态和空闲轮询。 */
  restore(): void {
    for (const member of this.store.members()) {
      try {
        if (this.store.settle(member) === "idle") this.refresh(member, "idle")
      } catch (error) { this.reportFailure({ sessionId: member.sessionId, turn: 0, error }) }
    }
  }

  /** @returns 当前全局唤醒设置。 */
  readConfig(): TeamWakeupConfig { return this.store.config() }

  /**
   * 保存全局设置并以新间隔重排空闲轮询。
   * @param input 完整设置。
   * @returns 已保存的配置。
   * @throws TypeError 配置值不符合约束时抛出。
   */
  updateConfig(input: TeamWakeupConfig): TeamWakeupConfig {
    this.store.saveConfig(input)
    const config = this.store.config()
    for (const member of this.store.members()) {
      this.clearTimer(member.sessionId)
      if (this.store.status(member) === "idle") this.arm(member, config.pollingInterval)
    }
    return config
  }

  /** 阻止新调度并移除所有轮询定时器。 */
  shutdown(): void {
    this.exiting = true
    for (const id of this.timers.keys()) this.clearTimer(id)
  }

  /** 检查一次唤醒；既有轮询在普通发布时保留原有到期时间。 */
  private refresh(member: TeamIdentity, trigger: "publish" | "idle" | "poll", mentioned = false): void {
    if (this.exiting) return
    if (this.store.wake(member, trigger, mentioned)) {
      this.clearTimer(member.sessionId)
      this.dispatch?.kick(member.projectId, member.sessionId)
    } else if (this.store.status(member) === "idle" && !this.timers.has(member.sessionId)) {
      this.arm(member, this.store.config().pollingInterval)
    }
  }

  /** 设置唯一轮询任务；超出 Node 单次计时范围时分段等待。 */
  private arm(member: TeamIdentity, seconds: number): void {
    if (this.exiting) return
    const maxSeconds = Math.floor(0x7fffffff / 1000)
    const delay = Math.min(seconds, maxSeconds)
    const timer = setTimeout(() => {
      if (this.timers.get(member.sessionId) !== timer) return
      this.timers.delete(member.sessionId)
      if (seconds > delay) { this.arm(member, seconds - delay); return }
      try { this.refresh(member, "poll") }
      catch (error) {
        this.reportFailure({ sessionId: member.sessionId, turn: 0, error })
        this.arm(member, seconds)
      }
    }, delay * 1000)
    timer.unref()
    this.timers.set(member.sessionId, timer)
  }

  /** 停止指定成员的轮询。 */
  private clearTimer(id: string): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
  }
}
