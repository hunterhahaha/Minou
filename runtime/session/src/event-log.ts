/**
 * 共享 SQLite 中按 Project 与 Session 联合身份隔离的追加事件日志。
 *
 * 同一进程中同一日志身份的写入按队列串行执行；日志层分配事件身份与序号，
 * 单条追加及 Turn 首批事件使用事务提交，读取返回按序排列且仍需上层校验的事件。
 */

import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { MESSAGE_QUEUE_SCHEMA, sessionTransaction } from "./message-queue.ts"
import { TEAM_SCHEMA } from "./team-store.ts"
import { TEAM_META_SCHEMA } from "./meta-store.ts"
import { requireProjectId } from "./project-id.ts"

import type {
  McpToolChangeInput, SessionEvent, SessionEventInput, TurnStartEvent, TurnStartEventInput,
  UserMessageEvent, UserMessageEventInput,
} from "./events.ts"

/** 单个 Session 的存储位置和事件身份来源。 */
export interface FileSessionEventLogOptions {
  /** Team Session 使用独立事件表，并允许尚未开始首轮。 */
  team?: boolean
  /** 当前日志由具备持久队列的 SessionRuntime 使用。 */
  desktop?: boolean
  /** 当前日志绑定的 Session ID。 */
  sessionId: string
  /** 所属 Project/default 分组 ID。 */
  projectGroupId: string
  /** 当前 Session 目录的绝对路径。 */
  sessionDirectory: string
  /** 共享的 .nicode/events.sqlite 绝对路径。 */
  databasePath: string
  /** 可选时间来源。 */
  now?: () => Date
  /** 可选事件 ID 来源。 */
  createEventId?: () => string
}

/** 保持原有异步事件读写契约的 SQLite 访问器。 */
export interface FileSessionEventLog {
  /**
   * 按 seq 读取当前 Session 的已提交事件。
   * @returns 尚待上层校验的事件值。
   * @throws Error 当目录、数据库、日志或事件内容无效时抛出。
   */
  readEvents(): Promise<readonly unknown[]>
  /**
   * 分配事件身份并提交一条事件。
   * @param event 尚未分配身份的事件。
   * @returns 已提交的完整事件。
   * @throws Error 当日志缺失、seq 无效或事务失败时抛出。
   */
  appendEvent(event: SessionEventInput): Promise<SessionEvent>
  /**
   * 原子提交同一次载入的有序工具变更。
   * @param events 同一工具调用产生的事件，移除排在新增前。
   * @returns 具有连续序号的已提交事件。
   * @throws Error 日志不可写或事务失败时抛出。
   */
  appendMcpToolChanges(events: readonly McpToolChangeInput[]): Promise<SessionEvent[]>
  /**
   * 在一个事务内提交新 Turn 的两条首批事件，并按需出队或写入 Team 身份。
   * @param events 按 turn/start、user/message 排列的事件对。
   * @param queuedMessageId 应在同一事务移除的持久队首消息。
   * @param onCommit 提交前执行的同步初始化；抛出时一并回滚。
   * @returns 已提交的完整事件对。
   * @throws Error 当 Turn 身份或事务无效时抛出。
   */
  appendTurnStartAndUserMessage(
    events: readonly [TurnStartEventInput, UserMessageEventInput],
    queuedMessageId?: string,
    onCommit?: (db: DatabaseSync) => void,
  ): Promise<readonly [TurnStartEvent, UserMessageEvent]>
}

/** 同一进程、同一 Session 的共享写入队列。 */
const WRITE_TAILS = new Map<string, Promise<void>>()
const CREATE_EVENTS_TABLE = `CREATE TABLE IF NOT EXISTS session_events (
  project_group_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (project_group_id, session_id, seq),
  UNIQUE (project_group_id, session_id, event_id)
) STRICT`
const CREATE_TEAM_EVENTS_TABLE = CREATE_EVENTS_TABLE.replace("session_events", "team_session_events")

/**
 * 初始化 Event Log 数据库；桌面启用共享消息队列及 Team 存储。
 * @param databasePath `.nicode/events.sqlite` 的绝对路径。
 * @param desktop 是否初始化桌面协作表；独立 CLI 仅使用普通事件表。
 * @returns 缺失数据库创建完成，或已有普通文件确认存在后解析的 Promise。
 * @throws Error 当路径不是普通文件或缺失数据库无法创建时抛出。
 */
export async function initializeSessionEventDatabase(databasePath: string, desktop = false): Promise<void> {
  if (!isAbsolute(databasePath)) {
    throw new Error(`Session Event Log 数据库必须是绝对路径：${databasePath}`)
  }
  const path = resolve(databasePath)
  const kind = await pathKind(path)
  if (kind !== "missing" && kind !== "file") {
    throw new Error(`Session Event Log 数据库不是普通文件：${path}`)
  }
  if (kind === "file" && !desktop) return
  try {
    withDatabase(path, (db) => {
      db.exec(CREATE_EVENTS_TABLE)
      if (desktop) db.exec(CREATE_TEAM_EVENTS_TABLE + ";" + MESSAGE_QUEUE_SCHEMA + TEAM_SCHEMA + TEAM_META_SCHEMA)
    })
  } catch (error) {
    throw new Error(`无法初始化 Session Event Log 数据库：${path}`, { cause: error })
  }
}

/**
 * 创建只访问指定分组和 Session 的 Event Log。
 * @param options 存储路径、身份及可选时间和 ID 来源。
 * @returns 异步 Event Log 访问器。
 * @throws Error 当身份或路径无效时抛出。
 */
export function createFileSessionEventLog(options: FileSessionEventLogOptions): FileSessionEventLog {
  validateSegment(options.sessionId, "Session ID")
  requireProjectId(options.projectGroupId)
  if (!isAbsolute(options.sessionDirectory)) {
    throw new Error(`Session 目录必须是绝对路径：${options.sessionDirectory}`)
  }
  if (!isAbsolute(options.databasePath)) {
    throw new Error(`Session Event Log 数据库必须是绝对路径：${options.databasePath}`)
  }
  const sessionDirectory = resolve(options.sessionDirectory)
  const databasePath = resolve(options.databasePath)
  const queueKey = JSON.stringify([databasePath, options.projectGroupId, options.sessionId])
  const now = options.now ?? (() => new Date())
  const createEventId = options.createEventId ?? randomUUID
  const table = options.team ? "team_session_events" : "session_events"

  /**
   * 在同一事务分配序号并提交事件。
   * @param inputs 本次需要原子提交的事件。
   * @param history 序号分配前校验完整历史或只校验尾部。
   * @returns 按提交顺序排列的已持久化事件。
   * @throws Error 日志不可读、序号无效或事务失败时拒绝。
   */
  const append = (inputs: readonly SessionEventInput[], history: "all" | "tail" = "all") => runSerializedWrite(queueKey, async () => {
    await requireDirectory(sessionDirectory)
    await requireDatabase(databasePath)
    return withDatabase(databasePath, (db) => sessionTransaction(db, () => {
      const values = readSessionEvents(db, options.projectGroupId, options.sessionId, databasePath, false, history, table)
      const seq = nextSequence(values, databasePath, inputs.length)
      const events = materializeEvents(inputs, options.sessionId, seq, now, createEventId, databasePath)
      insertEvents(db, options.projectGroupId, events, databasePath, table)
      return events
    }))
  })

  return {
    readEvents: async () => {
      await (WRITE_TAILS.get(queueKey) ?? Promise.resolve())
      await requireDirectory(sessionDirectory)
      await requireDatabase(databasePath)
      return withDatabase(databasePath, (db) =>
        readSessionEvents(db, options.projectGroupId, options.sessionId, databasePath, options.team, "all", table))
    },
    appendEvent: async (input) => (await append([input], "tail"))[0],
    appendMcpToolChanges: (inputs) => inputs.length === 0 ? Promise.resolve([]) : append(inputs),
    appendTurnStartAndUserMessage: (inputs, queuedMessageId, onCommit) => runSerializedWrite(queueKey, async () => {
      await requireDirectory(sessionDirectory)
      validateTurnBatch(inputs, databasePath)
      if (queuedMessageId !== undefined && queuedMessageId !== inputs[1].message.id) {
        throw new Error("Turn 用户消息身份与持久队首不一致")
      }
      const kind = await pathKind(databasePath)
      if (kind !== "missing" && kind !== "file") {
        throw new Error(`Session Event Log 数据库不是普通文件：${databasePath}`)
      }
      return withDatabase(databasePath, (db) => sessionTransaction(db, () => {
        db.exec(options.team ? CREATE_TEAM_EVENTS_TABLE : CREATE_EVENTS_TABLE)
        if (options.desktop) db.exec(MESSAGE_QUEUE_SCHEMA)
        const values = readSessionEvents(db, options.projectGroupId, options.sessionId, databasePath, true, "all", table)
        let nextSeq = 1
        if (values.length === 0) {
          if (inputs[0].turn !== 1) {
            throw new Error(`无法创建 Session Event Log：首个 Turn 必须为 1（${databasePath}）。`)
          }
        } else {
          validateNextTurn(values, inputs[0].turn, databasePath)
          nextSeq = nextSequence(values, databasePath, 2)
        }
        const written = materializeEvents(
          inputs, options.sessionId, nextSeq, now, createEventId, databasePath,
        ) as [TurnStartEvent, UserMessageEvent]
        if (queuedMessageId !== undefined) {
          const removed = db.prepare(`DELETE FROM session_message_queue WHERE message_id = ?
            AND position = (SELECT MIN(position) FROM session_message_queue WHERE project_id = ? AND session_id = ?)
            AND NOT EXISTS (SELECT 1 FROM session_queue_pauses WHERE project_id = ? AND session_id = ?)`)
            .run(queuedMessageId, options.projectGroupId, options.sessionId, options.projectGroupId, options.sessionId)
          if (removed.changes !== 1) throw new Error("队首消息已变更或队列已暂停")
        }
        insertEvents(db, options.projectGroupId, written, databasePath, table)
        onCommit?.(db)
        return written
      }))
    }),
  }
}

/**
 * 在当前 Session 的队列中按调用顺序运行写入。
 * @param key 数据库、分组和 Session 的组合身份。
 * @param operation 独占的写入操作。
 * @returns 写入结果。
 */
function runSerializedWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = WRITE_TAILS.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const settled = result.then(() => undefined, () => undefined)
  WRITE_TAILS.set(key, settled)
  void settled.then(() => {
    if (WRITE_TAILS.get(key) === settled) WRITE_TAILS.delete(key)
  })
  return result
}

/**
 * 打开数据库并在操作完成后关闭连接。
 * @param path 数据库绝对路径。
 * @param operation 使用连接的同步操作。
 * @returns 操作结果。
 * @throws Error 当数据库无法打开时抛出。
 */
function withDatabase<T>(path: string, operation: (db: DatabaseSync) => T): T {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path)
  } catch (error) {
    throw new Error(`无法打开 Session Event Log 数据库：${path}`, { cause: error })
  }
  try {
    return operation(db)
  } finally {
    db.close()
  }
}

/**
 * 读取当前 Session 的事件并核对索引列。
 * @param db 已打开的数据库。
 * @param projectGroupId Project/default 分组 ID。
 * @param sessionId Session ID。
 * @param path 错误定位用的数据库路径。
 * @param allowMissing 是否允许新 Session 没有日志。
 * @param history 完整读取，或只读取末尾事件以分配单条追加的序号。
 * @param table 当前角色对应的独立事件表。
 * @returns 按 seq 排序的事件值。
 * @throws Error 当表、日志或事件内容无效时抛出。
 */
function readSessionEvents(
  db: DatabaseSync, projectGroupId: string, sessionId: string, path: string,
  allowMissing = false, history: "all" | "tail" = "all",
  table: "session_events" | "team_session_events" = "session_events",
): unknown[] {
  let rows: Array<Record<string, unknown>>
  try {
    rows = db.prepare(`SELECT seq, event_id, type, created_at, event_json
      FROM ${table} WHERE project_group_id = ? AND session_id = ? ORDER BY seq ${history === "tail" ? "DESC LIMIT 1" : "ASC"}`)
      .all(projectGroupId, sessionId) as Array<Record<string, unknown>>
  } catch (error) {
    throw new Error(`无法读取 Session Event Log：${path}`, { cause: error })
  }
  if (rows.length === 0 && !allowMissing) {
    throw new Error(`Session Event Log不存在或无法访问：${path}（${projectGroupId}/${sessionId}）`)
  }
  return rows.map((row, index) => {
    const position = history === "tail" ? "末尾事件" : `第 ${index + 1} 条`
    if (typeof row.event_json !== "string") {
      throw new Error(`Session Event Log ${position}内容无效：${path}`)
    }
    let value: unknown
    try {
      value = JSON.parse(row.event_json) as unknown
    } catch (error) {
      throw new Error(`Session Event Log ${position}不是有效 JSON：${path}`, { cause: error })
    }
    if (
      !isRecord(value) || value.seq !== row.seq || value.eventId !== row.event_id
      || value.type !== row.type || value.createdAt !== row.created_at || value.sessionId !== sessionId
    ) {
      throw new Error(`Session Event Log ${position}索引与事件内容不一致：${path}`)
    }
    return value
  })
}

/**
 * 插入一批事件；失败时由调用方事务回滚。
 * @param db 已打开的数据库。
 * @param projectGroupId Project/default 分组 ID。
 * @param events 已分配身份的事件。
 * @param path 错误定位用的数据库路径。
 * @param table 当前角色对应的独立事件表。
 * @throws Error 当序列化或插入失败时抛出。
 */
function insertEvents(db: DatabaseSync, projectGroupId: string, events: readonly SessionEvent[], path: string,
  table: "session_events" | "team_session_events",
): void {
  const insert = db.prepare(`INSERT INTO ${table}
    (project_group_id, session_id, seq, event_id, type, created_at, event_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (const event of events) {
    let json: string
    try {
      json = JSON.stringify(event)
      if (typeof json !== "string") throw new Error("事件无法表示为 JSON")
    } catch (error) {
      throw new Error(`无法序列化 Session Event：${path}`, { cause: error })
    }
    try {
      insert.run(projectGroupId, event.sessionId, event.seq, event.eventId, event.type, event.createdAt, json)
    } catch (error) {
      throw new Error(`无法追加 Session Event：${path}`, { cause: error })
    }
  }
}

/**
 * 校验首批事件的顺序及共同身份。
 * @param events 固定事件对。
 * @param path 错误定位用的数据库路径。
 * @throws Error 当事件无效时抛出。
 */
function validateTurnBatch(events: readonly [TurnStartEventInput, UserMessageEventInput], path: string): void {
  const [start, message] = events
  if (start.type !== "turn/start" || message.type !== "user/message") {
    throw new Error(`Session Turn 批次顺序无效：${path}`)
  }
  if (!isPositiveSafeInteger(start.turn) || message.turn !== start.turn) {
    throw new Error(`Session Turn 批次编号无效：${path}`)
  }
  if (
    !isRecord(message.message) || message.message.role !== "user"
    || typeof message.message.id !== "string" || message.message.id.trim() === ""
  ) {
    throw new Error(`Session Turn 批次的用户消息无效：${path}`)
  }
}

/**
 * 校验新 Turn 紧接最后一个已结束 Turn。
 * @param values 当前 Session 的事件值。
 * @param turn 待创建的 Turn 编号。
 * @param path 错误定位用的数据库路径。
 * @throws Error 当上一 Turn 未结束或编号不连续时抛出。
 */
function validateNextTurn(values: readonly unknown[], turn: number, path: string): void {
  const lastStart = [...values].reverse().find((value) => isRecord(value) && value.type === "turn/start")
  const lastEnd = [...values].reverse().find((value) => isRecord(value) && value.type === "turn/end")
  if (
    !isRecord(lastStart) || !isPositiveSafeInteger(lastStart.turn)
    || !isRecord(lastEnd) || lastEnd.turn !== lastStart.turn
  ) {
    throw new Error(`上一个 Session Turn 尚未完整结束：${path}`)
  }
  const expectedTurn = lastStart.turn + 1
  if (turn !== expectedTurn) {
    throw new Error(`Session Turn 编号不连续：期望 ${expectedTurn}，实际 ${turn}（${path}）。`)
  }
  for (const value of values) {
    if (
      isRecord(value) && value.type === "context_update"
      && typeof value.turn === "number" && value.turn > lastStart.turn && value.turn !== turn
    ) {
      throw new Error(`Session context_update 不属于待提交 Turn ${turn}：${path}`)
    }
  }
}

/**
 * 计算下一批事件的起始 seq。
 * @param values 当前 Session 的事件值。
 * @param path 错误定位用的数据库路径。
 * @param count 本批事件数量。
 * @returns 下一批第一条事件的 seq。
 * @throws Error 当末尾 seq 无效或空间不足时抛出。
 */
function nextSequence(values: readonly unknown[], path: string, count: number): number {
  const last = values.at(-1)
  if (!isRecord(last) || !isPositiveSafeInteger(last.seq)) {
    throw new Error(`无法追加 Session Event：${path} 的末尾事件缺少有效 seq。`)
  }
  if (last.seq > Number.MAX_SAFE_INTEGER - count) {
    throw new Error(`无法追加 Session Event：${path} 的 seq 已达到安全整数上限。`)
  }
  return last.seq + 1
}

/**
 * 给事件输入分配连续身份。
 * @param inputs 尚未分配身份的事件。
 * @param sessionId 当前 Session ID。
 * @param firstSeq 第一条事件的 seq。
 * @param now 时间来源。
 * @param createEventId 事件 ID 来源。
 * @param path 错误定位用的数据库路径。
 * @returns 尚未提交的完整事件。
 * @throws Error 当事件 ID 为空时抛出。
 */
function materializeEvents(
  inputs: readonly SessionEventInput[], sessionId: string, firstSeq: number,
  now: () => Date, createEventId: () => string, path: string,
): SessionEvent[] {
  return inputs.map((input, index) => {
    const eventId = createEventId()
    if (eventId.trim() === "") {
      throw new Error(`无法追加 Session Event：事件 ID 不能为空（${path}）。`)
    }
    return { ...input, eventId, sessionId, seq: firstSeq + index, createdAt: now().toISOString() } as SessionEvent
  })
}

/**
 * 校验不含路径分隔符的非空身份。
 * @param value 待校验的身份。
 * @param label 错误信息中的身份名称。
 * @throws Error 当身份无效时抛出。
 */
function validateSegment(value: string, label: string): void {
  if (value.trim() === "" || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} 必须是不含路径分隔符的非空目录名：${value}`)
  }
}

/**
 * 检查路径类型。
 * @param path 目标路径。
 * @returns 普通文件、目录、其它节点或不存在。
 */
async function pathKind(path: string): Promise<"file" | "directory" | "other" | "missing"> {
  try {
    const stats = await lstat(path)
    if (stats.isFile()) return "file"
    if (stats.isDirectory()) return "directory"
    return "other"
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing"
    throw new Error(`无法检查 Session Event Log：${path}`, { cause: error })
  }
}

/**
 * 要求 Session 目录存在。
 * @param path Session 目录的绝对路径。
 * @throws Error 当目标不是目录时抛出。
 * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
 */
async function requireDirectory(path: string): Promise<void> {
  const stats = await lstat(path).catch((error: unknown) => {
    throw new Error(`Session 目录不存在或无法访问：${path}`, { cause: error })
  })
  if (!stats.isDirectory()) throw new Error(`Session 目录不是目录：${path}`)
}

/**
 * 要求共享数据库是普通文件。
 * @param path 数据库绝对路径。
 * @throws Error 当数据库缺失或不是普通文件时抛出。
 * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
 */
async function requireDatabase(path: string): Promise<void> {
  const kind = await pathKind(path)
  if (kind === "missing") throw new Error(`Session Event Log 数据库不存在或无法访问：${path}`)
  if (kind !== "file") throw new Error(`Session Event Log 数据库不是普通文件：${path}`)
}

/**
 * 判断未知值是否为非数组对象。
 * @param value 待检查的值。
 * @returns 是否可按字符串字段读取。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 判断值是否为正的安全整数。
 * @param value 待检查的值。
 * @returns 是否可用作 Event seq。
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
