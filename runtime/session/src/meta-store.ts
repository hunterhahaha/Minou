/**
 * 按 Project 与 Session 联合身份读写共享 SQLite Meta。
 *
 * 初始化检查数据库版本和表结构；模型、权限、Usage、Skill 与附加字段分别序列化。
 * 此层处理数据库记录与 JSON，完整 Meta 业务结构由派生状态层进一步校验。
 */

import { lstatSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { requireProjectId } from "./project-id.ts"
import type { SessionMeta } from "./session-state.ts"

/** 新建 Session 的固定显示名称。 */
export const INITIAL_SESSION_NAME = "新对话"

const CREATE_META_TABLE = `CREATE TABLE session_meta (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  current_model_json TEXT NOT NULL,
  sandbox_mode_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  additional_meta_json TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ordinary' CHECK(kind IN ('ordinary', 'router', 'member')),
  PRIMARY KEY (project_id, session_id)
) STRICT`

/** Team Session Meta 表与普通会话使用相同字段和独立身份空间。 */
export const TEAM_META_SCHEMA = CREATE_META_TABLE.replace("CREATE TABLE session_meta", "CREATE TABLE IF NOT EXISTS team_session_meta")

const META_COLUMNS = [
  "project_id", "session_id", "name", "version", "current_model_json",
  "sandbox_mode_json", "usage_json", "skills_json", "additional_meta_json", "kind",
] as const
const META_TYPES = ["TEXT", "TEXT", "TEXT", "INTEGER", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT"] as const

/** 一条数据库记录的原始列值；JSON 列尚未解析。 */
interface MetaRow {
  /** SQLite 原始 project_id 列值；JSON 列在此尚未解析。 */
  project_id: string
  /** SQLite 原始 session_id 列值；JSON 列在此尚未解析。 */
  session_id: string
  /** SQLite 原始 name 列值；JSON 列在此尚未解析。 */
  name: string
  /** SQLite 原始 version 列值；JSON 列在此尚未解析。 */
  version: number
  /** SQLite 原始 current_model_json 列值；JSON 列在此尚未解析。 */
  current_model_json: string
  /** SQLite 原始 sandbox_mode_json 列值；JSON 列在此尚未解析。 */
  sandbox_mode_json: string
  /** SQLite 原始 usage_json 列值；JSON 列在此尚未解析。 */
  usage_json: string
  /** SQLite 原始 skills_json 列值；JSON 列在此尚未解析。 */
  skills_json: string
  /** SQLite 原始 additional_meta_json 列值；JSON 列在此尚未解析。 */
  additional_meta_json: string
}

/**
 * 检查 Session ID 的目录安全性。
 * @param sessionId 待检查的 Session ID。
 * @throws TypeError 当 ID 为空或包含路径分隔符时抛出。
 */
export function requireMetaSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.trim() === "" || sessionId === "." ||
      sessionId === ".." || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new TypeError(`sessionId 无效：${sessionId}`)
  }
}

/**
 * 缺失时创建 Meta 数据库；已有数据库必须是普通文件且具有当前完整表结构。
 * @param databasePath `.minou/meta.sqlite` 的绝对路径。
 * @throws Error 当路径、SQLite 文件或表结构无效时抛出，已有文件不会被覆盖。
 */
export function initializeSessionMetaDatabase(databasePath: string): void {
  const path = requireDatabasePath(databasePath)
  let exists = false
  try {
    const stats = lstatSync(path)
    if (!stats.isFile()) throw new Error(`Session Meta 数据库不是普通文件：${path}`)
    exists = true
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error
  }
  if (!exists) {
    const db = new DatabaseSync(path)
    try {
      db.exec(CREATE_META_TABLE)
      db.exec("PRAGMA user_version = 2")
    } finally {
      db.close()
    }
    return
  }
  withDatabase(path, true, (db) => {
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number }
    if (version.user_version !== 2) throw new Error(`Session Meta 数据库版本无效：${path}`)
    const columns = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
      name: string; type: string; notnull: number; pk: number
    }>
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_meta'")
      .get() as { sql: string } | undefined
    if (columns.length !== META_COLUMNS.length ||
        META_COLUMNS.some((name, index) => {
          const column = columns[index]
          return column.name !== name || column.type !== META_TYPES[index] ||
            column.notnull !== 1 || column.pk !== (index < 2 ? index + 1 : 0)
        }) || !table || !/\bSTRICT\s*$/i.test(table.sql)) {
      throw new Error(`Session Meta 数据库表结构无效：${path}`)
    }
    db.prepare(`SELECT ${META_COLUMNS.join(", ")} FROM session_meta LIMIT 1`).get()
  })
}

/**
 * 读取一条 Session Meta；无行或 JSON 列损坏时返回 undefined，供恢复流程补建。
 * @param databasePath 共享 Meta 数据库路径。
 * @param projectId Project UUID 或 default。
 * @param sessionId Session ID。
 * @param team 是否读取独立的 Team Session Meta 表。
 * @returns 由各列合成的未校验 Meta，或 undefined。
 * @throws Error 当数据库本身不可读取时抛出。
 */
export function readSessionMeta(databasePath: string, projectId: string, sessionId: string, team = false): unknown | undefined {
  requireProjectId(projectId)
  requireMetaSessionId(sessionId)
  return withDatabase(databasePath, true, (db) => {
    const row = db.prepare(`SELECT ${META_COLUMNS.join(", ")} FROM ${team ? "team_session_meta" : "session_meta"}
      WHERE project_id = ? AND session_id = ?`).get(projectId, sessionId) as MetaRow | undefined
    if (row === undefined) return undefined
    try {
      const additional = JSON.parse(row.additional_meta_json) as unknown
      if (!isRecord(additional)) return undefined
      return {
        ...additional,
        projectId: row.project_id,
        sessionId: row.session_id,
        name: row.name,
        version: row.version,
        currentModel: JSON.parse(row.current_model_json) as unknown,
        sandboxMode: JSON.parse(row.sandbox_mode_json) as unknown,
        usage: JSON.parse(row.usage_json) as unknown,
        skills: JSON.parse(row.skills_json) as unknown,
      }
    } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
  })
}

/**
 * 原子保存 Meta 的结构字段；冲突更新不触及名称列。
 * @param databasePath 共享 Meta 数据库路径。
 * @param meta 已通过 SessionState 校验的完整 Meta。
 * @param kind 决定 Meta 写入的表与新增记录的类型。
 * @throws Error 当身份无效或数据库写入失败时抛出。
 */
export function saveSessionMeta(databasePath: string, meta: SessionMeta, kind: "ordinary" | "router" | "member" = "ordinary"): void {
  requireProjectId(meta.projectId)
  requireMetaSessionId(meta.sessionId)
  const { projectId, sessionId, name, version, currentModel, sandboxMode, usage, skills, ...additional } = meta
  withDatabase(databasePath, false, (db) => {
    db.prepare(`INSERT INTO ${kind === "member" ? "team_session_meta" : "session_meta"}
      (project_id, session_id, name, version, current_model_json, sandbox_mode_json,
       usage_json, skills_json, additional_meta_json, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, session_id) DO UPDATE SET
        version = excluded.version,
        current_model_json = excluded.current_model_json,
        sandbox_mode_json = excluded.sandbox_mode_json,
        usage_json = excluded.usage_json,
        skills_json = excluded.skills_json,
        additional_meta_json = excluded.additional_meta_json`)
      .run(projectId, sessionId, name, version, JSON.stringify(currentModel),
        JSON.stringify(sandboxMode), JSON.stringify(usage), JSON.stringify(skills), JSON.stringify(additional), kind)
  })
}

/**
 * 只修改已有 Session 的显示名称，供后续命名流程调用。
 * @param databasePath 共享 Meta 数据库路径。
 * @param projectId Project UUID 或 default。
 * @param sessionId Session ID。
 * @param name 新名称；保留调用方提供的非空原文。
 * @param team 是否更新独立的 Team Session Meta 表。
 * @throws Error 当身份、名称无效，记录不存在或数据库写入失败时抛出。
 */
export function updateSessionMetaName(databasePath: string, projectId: string, sessionId: string, name: string, team = false): void {
  requireProjectId(projectId)
  requireMetaSessionId(sessionId)
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("Session 名称不能为空")
  withDatabase(databasePath, false, (db) => {
    const result = db.prepare(`UPDATE ${team ? "team_session_meta" : "session_meta"} SET name = ? WHERE project_id = ? AND session_id = ?`)
      .run(name, projectId, sessionId)
    if (result.changes === 0) throw new Error(`Session Meta 不存在：${projectId}/${sessionId}`)
  })
}

/**
 * 仅在现有名称仍为默认值时写入自动生成的标题。
 * @param databasePath 共享 Meta 数据库路径。
 * @param projectId Project UUID 或 default。
 * @param sessionId Session ID。
 * @param name 已验证的非空标题。
 * @returns 更新一行时为 true；会话缺失或已有自定义名称时为 false。
 * @throws Error 当身份、标题无效或数据库写入失败时抛出。
 */
export function updateSessionMetaNameIfDefault(databasePath: string, projectId: string, sessionId: string, name: string): boolean {
  requireProjectId(projectId)
  requireMetaSessionId(sessionId)
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("Session 名称不能为空")
  return withDatabase(databasePath, false, (db) => db.prepare(
    "UPDATE session_meta SET name = ? WHERE project_id = ? AND session_id = ? AND name = ?",
  ).run(name, projectId, sessionId, INITIAL_SESSION_NAME).changes !== 0)
}

/**
 * 规范化共享数据库的绝对路径。
 * @param databasePath 调用方提供的数据库路径。
 * @returns 规范化的绝对路径。
 * @throws Error 当路径不是绝对路径时抛出。
 */
function requireDatabasePath(databasePath: string): string {
  if (!isAbsolute(databasePath)) throw new Error(`Session Meta 数据库必须是绝对路径：${databasePath}`)
  return resolve(databasePath)
}

/**
 * 以指定模式打开数据库，完成单次操作后关闭连接。
 * @param databasePath 共享 Meta 数据库路径。
 * @param readOnly 是否只读打开，防止读取时创建缺失文件。
 * @param operation 使用连接执行的同步操作。
 * @returns 操作返回值。
 * @throws Error 当数据库无法打开或操作失败时抛出。
 */
function withDatabase<T>(databasePath: string, readOnly: boolean, operation: (db: DatabaseSync) => T): T {
  const path = requireDatabasePath(databasePath)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly })
  } catch (error) {
    throw new Error(`无法打开 Session Meta 数据库：${path}`, { cause: error })
  }
  try {
    return operation(db)
  } finally {
    db.close()
  }
}

/**
 * 检查额外 Meta JSON 是否是对象。
 * @param value 待检查的解析值。
 * @returns 值是否是非数组对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * 窄化文件系统错误以识别缺失路径。
 * @param error 捕获的未知错误。
 * @returns 错误是否包含 Node 错误码。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
