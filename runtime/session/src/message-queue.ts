/** 持久队列与 Event Log 共用数据库，使开始 Turn 与出队可以一起提交。 */
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type { UserMessageContent } from "./events.ts"

/** 已持久化的用户消息，直到首批 Turn 事件提交后才从队列移除。 */
export interface QueuedMessage extends UserMessageContent {
  /** 与 user/message 使用相同的身份。 */
  messageId: string
  /** Team 内部消息的来源，用于审计；普通用户输入省略。 */
  origin?: "assignment" | "completion" | "authorization" | "blackboard"
}

/** 持久队列在同一 Project 下按 Session 独立排序。 */
export const MESSAGE_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_message_queue (
  position INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  origin TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS session_queue_fifo
  ON session_message_queue(project_id, session_id, position);
CREATE TABLE IF NOT EXISTS session_queue_pauses (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY(project_id, session_id)
) STRICT;`

/**
 * 在共享会话数据库运行同步操作，并在返回前关闭连接。
 * @param path 事件数据库路径。
 * @param operation 使用当前连接的操作。
 * @returns 操作结果。
 * @throws Error 数据库访问失败时抛出。
 */
export function withSessionDatabase<T>(path: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try { return operation(db) } finally { db.close() }
}

/**
 * 在已有连接内原子提交一组同步写入。
 * @param db 尚未开始事务的连接。
 * @param operation 同步事务内容。
 * @returns 已提交的操作结果。
 * @throws Error 写入失败时回滚并抛出。
 */
export function sessionTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = operation()
    db.exec("COMMIT")
    return result
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

/**
 * 在调用方事务内追加一条用户消息。
 * @param db 事件数据库连接。
 * @param projectId 所属 Project。
 * @param sessionId 接收方会话。
 * @param input 用户内容。
 * @param origin Team 消息来源，普通用户消息省略。
 * @returns 新消息身份。
 * @throws Error 写入失败时抛出。
 */
export function insertQueuedMessage(
  db: DatabaseSync, projectId: string, sessionId: string, input: UserMessageContent, origin?: QueuedMessage["origin"],
): string {
  const messageId = randomUUID()
  db.prepare(`INSERT INTO session_message_queue (project_id, session_id, message_id, payload, origin)
    VALUES (?, ?, ?, ?, ?)`).run(projectId, sessionId, messageId, JSON.stringify(input), origin ?? null)
  return messageId
}

/** 一个会话的队列访问器。停止或错误不会移除尚未开始的消息。 */
export class SessionMessageQueue {
  private readonly path: string
  private readonly projectId: string
  private readonly sessionId: string
  /**
   * 绑定共享数据库和会话身份。
   * @param path 事件数据库路径。
   * @param projectId 所属 Project。
   * @param sessionId 会话 ID。
   */
  constructor(path: string, projectId: string, sessionId: string) {
    this.path = path
    this.projectId = projectId
    this.sessionId = sessionId
  }

  /**
   * 持久化消息；主动发送时在同一事务清除暂停标记。
   * @param input 用户消息。
   * @param resume 本次是否由用户主动恢复。
   * @returns 新消息 ID。
   * @throws Error 写入失败时抛出。
   */
  enqueue(input: UserMessageContent, resume = false): string {
    return withSessionDatabase(this.path, (db) => sessionTransaction(db, () => {
      const id = insertQueuedMessage(db, this.projectId, this.sessionId, input)
      if (resume) db.prepare("DELETE FROM session_queue_pauses WHERE project_id = ? AND session_id = ?")
        .run(this.projectId, this.sessionId)
      return id
    }))
  }

  /**
   * 读取队列快照或仅获取可调度的队首。
   * @param headOnly 为 true 时忽略暂停的队列并最多读取一条。
   * @returns 以 FIFO 排列的消息。
   * @throws Error 查询或解析失败时抛出。
   */
  read(headOnly = false): QueuedMessage[] {
    return withSessionDatabase(this.path, (db) => {
      const rows = db.prepare(`SELECT message_id, payload, origin FROM session_message_queue q
        WHERE project_id = ? AND session_id = ?
        ${headOnly ? `AND NOT EXISTS (SELECT 1 FROM session_queue_pauses p
          WHERE p.project_id = q.project_id AND p.session_id = q.session_id)` : ""}
        ORDER BY position ${headOnly ? "LIMIT 1" : ""}`).all(this.projectId, this.sessionId) as {
          message_id: string; payload: string; origin: QueuedMessage["origin"] | null
        }[]
      return rows.map((row) => ({
        ...JSON.parse(row.payload) as UserMessageContent,
        messageId: row.message_id,
        ...(row.origin && { origin: row.origin }),
      }))
    })
  }

  /**
   * 持久化暂停标记，阻止自动消费。
   * @throws Error 写入失败时抛出。
   */
  pause(): void {
    withSessionDatabase(this.path, (db) => db.prepare(
      "INSERT OR IGNORE INTO session_queue_pauses (project_id, session_id) VALUES (?, ?)",
    ).run(this.projectId, this.sessionId))
  }
}

/**
 * 查询重启时可自动继续的会话。
 * @param path 共享事件数据库。
 * @returns 各非暂停且队列非空的会话身份。
 * @throws Error 查询失败时抛出。
 */
export function listRunnableQueues(path: string): { projectId: string; sessionId: string }[] {
  return withSessionDatabase(path, (db) => db.prepare(`SELECT DISTINCT q.project_id AS projectId, q.session_id AS sessionId
    FROM session_message_queue q WHERE NOT EXISTS (SELECT 1 FROM session_queue_pauses p
      WHERE p.project_id = q.project_id AND p.session_id = q.session_id)`).all() as { projectId: string; sessionId: string }[])
}
