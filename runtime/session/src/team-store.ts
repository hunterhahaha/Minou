/** Team 协作身份、黑板与调度状态。与会话队列使用同一个 SQLite 事务。 */
import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { ModelRef } from "../../model/src/types.ts"
import type { ProjectId } from "./project-id.ts"
import type { SandboxMode } from "./session-state.ts"
import { insertQueuedMessage, sessionTransaction, withSessionDatabase, type QueuedMessage } from "./message-queue.ts"

/** Team Session 的协作生命周期。 */
export type TeamStatus = "idle" | "running" | "waiting" | "finished" | "closed"

/** 持久化且由宿主验证的协作身份。 */
export interface TeamIdentity {
  /** 外层 Project，决定当前会话可访问的文件范围。 */
  projectId: ProjectId
  /** Router 或成员自身的会话身份。 */
  sessionId: string
  /** 所属 Router 的会话身份。 */
  routerId: string
  /** 协作消息和黑板的隔离范围。 */
  workspaceId: string
  /** 决定模型工具暴露和 Runtime 访问权限。 */
  role: "router" | "member"
  /** 首次初始化或修复缺失 Meta 时使用的权限模式。 */
  sandboxMode: SandboxMode
  /** 成员未开始首轮时的继承模型。 */
  initialModel?: ModelRef
}

/** Team Session 黑板阅读和唤醒使用的配置，时长以秒计。 */
export interface TeamWakeupConfig {
  /** 发布与回到 idle 时，未读数需严格超过此值。 */
  unreadThreshold: number
  /** 空闲轮询间隔，单位为秒。 */
  pollingInterval: number
  /** 普通唤醒及达到提醒阈值后的 Mention 最短间隔，单位为秒。 */
  wakeupCooldown: number
  /** 达到该次数后，唤醒需提示调用 unread。 */
  unconsumedWakeupAlertThreshold: number
}

/** 应用默认的全局唤醒配置。 */
export const DEFAULT_TEAM_WAKEUP_CONFIG: Readonly<TeamWakeupConfig> = Object.freeze({
  unreadThreshold: 3, pollingInterval: 60, wakeupCooldown: 60, unconsumedWakeupAlertThreshold: 2,
})

/** 自动唤醒时由工具宿主提交的黑板摘要。 */
export interface BlackboardWakeupContext {
  /** 已读摘要的最大帖子编号。 */
  lastReadPostId: number
  /** 排除自身发布的未读帖子数。 */
  unreadCount: number
  /** 最近的 Mention 是否尚未越过阅读游标。 */
  mentioned: boolean
}

/** 发布帖子所需的业务参数。 */
export interface BlackboardPostInput {
  /** 未读列表显示的标题。 */
  name: string
  /** 未读列表显示的摘要。 */
  description: string
  /** read 返回的完整内容。 */
  body: string
  /** 同一 Workspace 中需特别关注此帖的其他成员 ID。 */
  mentions: string[]
}

interface MemberRow {
  session_id: string
  project_id: ProjectId
  workspace_id: string
  status: TeamStatus
  last_read: number
  unread: number
  latest_mention: number | null
  last_wakeup: number | null
  unconsumed: number
}

interface PostRow {
  post_id: number
  name: string
  description: string
  body: string
  mentions: string
}

/** Team 协作表与普通 Project 工作区表相互独立。 */
export const TEAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS team_workspaces (
  workspace_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  router_id TEXT NOT NULL,
  sandbox_mode TEXT NOT NULL,
  UNIQUE(project_id, router_id)
) STRICT;
CREATE TABLE IF NOT EXISTS team_members (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(workspace_id),
  initial_model TEXT NOT NULL,
  sandbox_mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'waiting', 'finished', 'closed')),
  last_read INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  latest_mention INTEGER,
  last_wakeup INTEGER,
  unconsumed INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS team_members_workspace ON team_members(workspace_id, status);
CREATE TABLE IF NOT EXISTS team_posts (
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(workspace_id),
  post_id INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL,
  PRIMARY KEY(workspace_id, post_id)
) STRICT;
CREATE TABLE IF NOT EXISTS team_wakeup_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  settings TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS team_coordination_events (
  seq INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES team_workspaces(workspace_id),
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL
) STRICT;`

/**
 * 保存 Router 的协作身份，由首轮事件的事务调用。
 * @param db 已开始事务的事件数据库连接。
 * @param identity Router 与唯一 Workspace。
 * @throws Error 身份冲突或写入失败时抛出。
 */
export function insertTeamWorkspace(db: DatabaseSync, identity: TeamIdentity): void {
  db.prepare("INSERT INTO team_workspaces VALUES (?, ?, ?, ?)").run(
    identity.workspaceId, identity.projectId, identity.routerId, identity.sandboxMode,
  )
}

/** 所有 Team 会话共享的持久化访问入口。 */
export class TeamStore {
  private readonly path: string
  private readonly now: () => number
  /**
   * 绑定同一进程的会话事件数据库。
   * @param path 已初始化的共享事件数据库。
   * @param now 产生毫秒时间戳，供冷却判定和测试。
   */
  constructor(path: string, now: () => number = Date.now) {
    this.path = path
    this.now = now
  }

  /**
   * 从持久化数据识别 Router 或 Team Session。
   * @param projectId 调用方的 Project。
   * @param sessionId 会话 ID。
   * @returns Team 身份；普通会话返回 undefined。
   * @throws Error 无法读取协作身份时抛出。
   */
  identity(projectId: ProjectId, sessionId: string): TeamIdentity | undefined {
    return withSessionDatabase(this.path, (db) => {
      const row = db.prepare(`SELECT w.workspace_id, w.router_id, w.sandbox_mode, NULL AS initial_model
        FROM team_workspaces w WHERE w.project_id = ? AND w.router_id = ?
        UNION ALL SELECT m.workspace_id, w.router_id, m.sandbox_mode, m.initial_model
        FROM team_members m JOIN team_workspaces w ON w.workspace_id = m.workspace_id
        WHERE m.project_id = ? AND m.session_id = ?`).get(projectId, sessionId, projectId, sessionId) as {
          workspace_id: string; router_id: string; sandbox_mode: SandboxMode; initial_model: string | null
        } | undefined
      if (!row) return undefined
      return {
        projectId, sessionId, workspaceId: row.workspace_id, routerId: row.router_id,
        role: row.initial_model === null ? "router" : "member", sandboxMode: row.sandbox_mode,
        ...(row.initial_model !== null && { initialModel: JSON.parse(row.initial_model) as ModelRef }),
      }
    })
  }

  /**
   * 创建 Team Session，有首条指令时同时入队。
   * @param router 已认证 Router。
   * @param settings 创建时从 Router 读取的模型与权限。
   * @param message 初始任务，可缺省。
   * @returns 创建的成员 ID。
   * @throws Error Workspace 已不可用或事务提交失败。
   */
  createMember(router: TeamIdentity, settings: { currentModel: ModelRef; sandboxMode: SandboxMode }, message?: string): string {
    return withSessionDatabase(this.path, (db) => sessionTransaction(db, () => {
      const id = randomUUID()
      const status = message === undefined ? "idle" : "running"
      db.prepare(`INSERT INTO team_members (session_id, project_id, workspace_id, initial_model, sandbox_mode, status, unread)
        VALUES (?, ?, ?, ?, ?, ?, (SELECT COUNT(*) FROM team_posts WHERE workspace_id = ?))`)
        .run(id, router.projectId, router.workspaceId, JSON.stringify(settings.currentModel), settings.sandboxMode, status, router.workspaceId)
      const messageId = message === undefined ? undefined : this.message(db, router.projectId, id, message, "assignment")
      this.audit(db, router.workspaceId, id, "team/member_created", { status, messageId })
      return id
    }))
  }

  /**
   * 给所属 Workspace 的成员派单，或永久关闭该成员。
   * @param router 已认证 Router。
   * @param sessionId 目标成员。
   * @param message 指令；缺省时执行关闭。
   * @returns 操作后的成员状态和可选消息 ID。
   * @throws Error 成员跨 Workspace、缺失或无法派单时抛出。
   */
  assignOrClose(router: TeamIdentity, sessionId: string, message?: string): { status: TeamStatus; messageId?: string } {
    return withSessionDatabase(this.path, (db) => sessionTransaction(db, () => {
      const member = this.member(db, router.workspaceId, sessionId)
      if (message === undefined) {
        if (member.status !== "closed") {
          db.prepare("UPDATE team_members SET status = 'closed' WHERE session_id = ?").run(sessionId)
          db.prepare("DELETE FROM session_message_queue WHERE project_id = ? AND session_id = ?").run(router.projectId, sessionId)
          this.audit(db, router.workspaceId, sessionId, "team/member_closed", {})
        }
        return { status: "closed" }
      }
      if (member.status === "closed") throw new Error("Team Session 已关闭")
      db.prepare("UPDATE team_members SET status = 'running' WHERE session_id = ?").run(sessionId)
      db.prepare("DELETE FROM session_queue_pauses WHERE project_id = ? AND session_id = ?").run(router.projectId, sessionId)
      const messageId = this.message(db, router.projectId, sessionId, message, "assignment")
      this.audit(db, router.workspaceId, sessionId, "team/assignment", { messageId })
      return { status: "running", messageId }
    }))
  }

  /**
   * 将成员的完成或授权请求入队给 Router，同时暂停成员队列。
   * @param identity 当前成员。
   * @param status 本次报告要求的状态。
   * @param message 报告正文。
   * @returns Router 队列中的消息 ID。
   * @throws Error 成员状态已变化或入队事务失败。
   */
  report(identity: TeamIdentity, status: "waiting" | "finished", message: string): string {
    return withSessionDatabase(this.path, (db) => sessionTransaction(db, () => {
      const member = this.member(db, identity.workspaceId, identity.sessionId)
      if (member.status !== "running") throw new Error("只有运行中的 Team Session 可以提交报告")
      db.prepare("UPDATE team_members SET status = ? WHERE session_id = ?").run(status, identity.sessionId)
      db.prepare("INSERT OR IGNORE INTO session_queue_pauses VALUES (?, ?)").run(identity.projectId, identity.sessionId)
      const origin = status === "waiting" ? "authorization" : "completion"
      const messageId = this.message(db, identity.projectId, identity.routerId,
        `Team Session ${identity.sessionId} ${status === "waiting" ? "请求授权" : "报告完成"}：\n${message}`, origin)
      this.audit(db, identity.workspaceId, identity.sessionId, "team/" + origin, { status, messageId })
      return messageId
    }))
  }

  /**
   * 读取成员状态，用于 Runtime 接续和轮询。
   * @param identity 已认证成员。
   * @returns 协作状态。
   * @throws Error 成员缺失或数据库不可用。
   */
  status(identity: TeamIdentity): TeamStatus {
    return withSessionDatabase(this.path, (db) => this.member(db, identity.workspaceId, identity.sessionId).status)
  }

  /**
   * 在运行完成或重启时，收尾没有可执行消息的成员，保留显式等待、完成和关闭。
   * @param identity 已认证成员。
   * @returns 收尾后的协作状态。
   * @throws Error 成员缺失或状态更新失败。
   */
  settle(identity: TeamIdentity): TeamStatus {
    return withSessionDatabase(this.path, (db) => sessionTransaction(db, () => {
      const member = this.member(db, identity.workspaceId, identity.sessionId)
      if (member.status !== "running") return member.status
      const pending = db.prepare(`SELECT 1 FROM session_message_queue q WHERE q.project_id = ? AND q.session_id = ?
        AND NOT EXISTS (SELECT 1 FROM session_queue_pauses p WHERE p.project_id = q.project_id AND p.session_id = q.session_id)
        LIMIT 1`).get(identity.projectId, identity.sessionId)
      if (pending) return "running"
      db.prepare("UPDATE team_members SET status = 'idle' WHERE session_id = ?").run(identity.sessionId)
      this.audit(db, identity.workspaceId, identity.sessionId, "team/idle", {})
      return "idle"
    }))
  }

  /**
   * 读取需要恢复或重新定时的成员。
   * @returns 未关闭的成员身份。
   * @throws Error 成员记录无法读取或解析。
   */
  members(): TeamIdentity[] {
    return withSessionDatabase(this.path, (db) => {
      const rows = db.prepare(`SELECT m.*, w.router_id FROM team_members m
        JOIN team_workspaces w ON w.workspace_id = m.workspace_id WHERE m.status <> 'closed'`).all() as
        unknown as (MemberRow & { router_id: string; sandbox_mode: SandboxMode; initial_model: string })[]
      return rows.map((row) => ({
        projectId: row.project_id, sessionId: row.session_id, workspaceId: row.workspace_id, routerId: row.router_id,
        role: "member", sandboxMode: row.sandbox_mode, initialModel: JSON.parse(row.initial_model) as ModelRef,
      }))
    })
  }

  /**
   * 原子发布帖子并为其他未关闭成员更新阅读状态。
   * @param identity 已认证发布者。
   * @param input 已验证的帖子内容。
   * @returns 编号、可能需要唤醒的成员和本帖的 Mention。
   * @throws Error 发布者已关闭、Mention 无效或事务失败。
   */
  publish(identity: TeamIdentity, input: BlackboardPostInput): { id: string; idle: string[]; mentions: string[] } {
    return withSessionDatabase(this.path, (db) => sessionTransaction(db, () => {
      const author = this.member(db, identity.workspaceId, identity.sessionId)
      if (author.status === "closed") throw new Error("Team Session 已关闭")
      const mentions = [...new Set(input.mentions)]
      for (const id of mentions) {
        if (id === identity.sessionId || this.member(db, identity.workspaceId, id).status === "closed") {
          throw new Error("Mention 目标必须是同一 Workspace 的其他未关闭成员")
        }
      }
      const { id } = db.prepare("SELECT COALESCE(MAX(post_id), 0) + 1 AS id FROM team_posts WHERE workspace_id = ?")
        .get(identity.workspaceId) as { id: number }
      db.prepare("INSERT INTO team_posts VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        identity.workspaceId, id, identity.sessionId, input.name, input.description, input.body, JSON.stringify(mentions),
      )
      db.prepare(`UPDATE team_members SET unread = unread + 1
        WHERE workspace_id = ? AND session_id <> ? AND status <> 'closed'`).run(identity.workspaceId, identity.sessionId)
      const mention = db.prepare("UPDATE team_members SET latest_mention = ? WHERE session_id = ?")
      for (const target of mentions) mention.run(id, target)
      const idle = db.prepare(`SELECT session_id FROM team_members
        WHERE workspace_id = ? AND session_id <> ? AND status = 'idle'`).all(identity.workspaceId, identity.sessionId) as { session_id: string }[]
      return { id: "#" + id, idle: idle.map((row) => row.session_id), mentions }
    }))
  }

  /**
   * 读取摘要并推进阅读进度，消费当前累积的唤醒次数。
   * @param identity 调用成员。
   * @returns Mention 优先和普通未读两组摘要。
   * @throws Error 成员已关闭或阅读状态更新失败。
   */
  unread(identity: TeamIdentity): { mentioned: { id: string; name: string; description: string }[]; unread: { id: string; name: string; description: string }[] } {
    return withSessionDatabase(this.path, (db) => sessionTransaction(db, () => {
      const member = this.member(db, identity.workspaceId, identity.sessionId)
      if (member.status === "closed") throw new Error("Team Session 已关闭")
      const rows = db.prepare(`SELECT post_id, name, description, mentions FROM team_posts
        WHERE workspace_id = ? AND post_id > ? AND author_id <> ? ORDER BY post_id`)
        .all(identity.workspaceId, member.last_read, identity.sessionId) as unknown as Omit<PostRow, "body">[]
      const last = rows.at(-1)?.post_id ?? member.last_read
      db.prepare("UPDATE team_members SET last_read = ?, unread = 0, unconsumed = 0 WHERE session_id = ?")
        .run(last, identity.sessionId)
      const result: ReturnType<TeamStore["unread"]> = { mentioned: [], unread: [] }
      for (const row of rows) {
        const group = (JSON.parse(row.mentions) as string[]).includes(identity.sessionId) ? result.mentioned : result.unread
        group.push({ id: "#" + row.post_id, name: row.name, description: row.description })
      }
      return result
    }))
  }

  /**
   * 读取已阅编号对应的帖子正文。
   * @param identity 调用成员。
   * @param postId 目标数字编号。
   * @returns 已发布正文和标题。
   * @throws Error 编号未读、帖子缺失或成员已关闭。
   */
  read(identity: TeamIdentity, postId: number): { id: string; name: string; body: string } {
    return withSessionDatabase(this.path, (db) => {
      const member = this.member(db, identity.workspaceId, identity.sessionId)
      if (member.status === "closed") throw new Error("Team Session 已关闭")
      if (postId > member.last_read) throw new Error("请先使用 unread 查看帖子摘要")
      const post = db.prepare("SELECT name, body FROM team_posts WHERE workspace_id = ? AND post_id = ?")
        .get(identity.workspaceId, postId) as Pick<PostRow, "name" | "body"> | undefined
      if (!post) throw new Error("黑板帖子不存在")
      return { id: "#" + postId, ...post }
    })
  }

  /**
   * 原子判断并提交一次黑板唤醒。
   * @param identity 目标成员。
   * @param trigger 唤醒检查入口。
   * @param mentionedByPost 发布入口中本帖是否提及目标。
   * @returns 是否为目标加入了唤醒消息。
   * @throws Error 成员缺失或入队事务失败。
   */
  wake(identity: TeamIdentity, trigger: "publish" | "idle" | "poll", mentionedByPost = false): boolean {
    return withSessionDatabase(this.path, (db) => sessionTransaction(db, () => {
      const member = this.member(db, identity.workspaceId, identity.sessionId)
      if (member.status !== "idle" || db.prepare("SELECT 1 FROM session_queue_pauses WHERE project_id = ? AND session_id = ?")
        .get(identity.projectId, identity.sessionId)) return false
      const config = this.configFrom(db)
      const now = this.now()
      const mentioned = member.latest_mention !== null && member.latest_mention > member.last_read
      const mentionEligible = mentioned && (trigger !== "publish" || mentionedByPost)
      const cooled = member.last_wakeup === null || now - member.last_wakeup >= config.wakeupCooldown * 1000
      const alert = member.unconsumed >= config.unconsumedWakeupAlertThreshold
      const ordinary = trigger === "poll" ? member.unread > 0 : member.unread > config.unreadThreshold
      if (!(mentionEligible && (!alert || cooled)) && !(ordinary && cooled)) return false
      const context: BlackboardWakeupContext = { lastReadPostId: member.last_read, unreadCount: member.unread, mentioned }
      const messageId = this.message(db, identity.projectId, identity.sessionId,
        `Workspace 黑板唤醒：${JSON.stringify(context)}${alert ? "\n请调用 blackboard 的 unread 查看未读帖子。" : ""}`, "blackboard")
      db.prepare("UPDATE team_members SET status = 'running', last_wakeup = ?, unconsumed = unconsumed + 1 WHERE session_id = ?")
        .run(now, identity.sessionId)
      this.audit(db, identity.workspaceId, identity.sessionId, "team/blackboard_wakeup", { messageId, trigger, ...context })
      return true
    }))
  }

  /** @returns 当前持久化配置，缺省时返回应用默认值。 */
  config(): TeamWakeupConfig { return withSessionDatabase(this.path, (db) => this.configFrom(db)) }

  /**
   * 验证并保存完整的全局唤醒配置。
   * @param input 完整设置。
   * @throws TypeError 任一设置不是合法整数时抛出。
   */
  saveConfig(input: TeamWakeupConfig): void {
    const minimums: Record<keyof TeamWakeupConfig, number> = {
      unreadThreshold: 0, pollingInterval: 30, wakeupCooldown: 30, unconsumedWakeupAlertThreshold: 0,
    }
    const keys = Object.keys(minimums) as (keyof TeamWakeupConfig)[]
    if (!input || Object.keys(input).length !== keys.length ||
      keys.some((key) => !Number.isSafeInteger(input[key]) || input[key] < minimums[key])) {
      throw new TypeError("Team 唤醒配置无效")
    }
    withSessionDatabase(this.path, (db) => db.prepare(
      "INSERT INTO team_wakeup_config VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings",
    ).run(JSON.stringify(input)))
  }

  /** 从同一连接读取配置，保证唤醒判定和入队使用同一快照。 */
  private configFrom(db: DatabaseSync): TeamWakeupConfig {
    const row = db.prepare("SELECT settings FROM team_wakeup_config WHERE id = 1").get() as { settings: string } | undefined
    return row ? JSON.parse(row.settings) as TeamWakeupConfig : { ...DEFAULT_TEAM_WAKEUP_CONFIG }
  }

  /** 按 Workspace 验证成员，拒绝跨 Workspace 的身份。 */
  private member(db: DatabaseSync, workspaceId: string, sessionId: string): MemberRow {
    const row = db.prepare("SELECT * FROM team_members WHERE workspace_id = ? AND session_id = ?")
      .get(workspaceId, sessionId) as unknown as MemberRow | undefined
    if (!row) throw new Error("当前 Workspace 中不存在该 Team Session")
    return row
  }

  /** 在当前事务追加 Team 用户消息。 */
  private message(db: DatabaseSync, projectId: ProjectId, sessionId: string, text: string, origin: NonNullable<QueuedMessage["origin"]>): string {
    return insertQueuedMessage(db, projectId, sessionId, { content: [{ type: "text", text }] }, origin)
  }

  /** 记录与队列或状态变化一同提交的协作事件。 */
  private audit(db: DatabaseSync, workspaceId: string, sessionId: string, type: string, detail: object): void {
    db.prepare("INSERT INTO team_coordination_events (workspace_id, session_id, type, created_at, detail) VALUES (?, ?, ?, ?, ?)")
      .run(workspaceId, sessionId, type, this.now(), JSON.stringify(detail))
  }
}
