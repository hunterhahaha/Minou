/** Project 与 default 工作区配置在独立 SQLite 数据库中的持久化。 */

import { isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { requireProjectId } from "../../runtime/session/src/project-id.ts"

/** 工作区配置中的对话索引条目。 */
export interface WorkspaceSession {
  /** 对话目录使用的身份。 */
  id: string
  /** 对话显示名称。 */
  name: string
  /** 创建时间。 */
  createdAt: string
  /** 最近更新时间。 */
  updatedAt: string
}

/** Project 分组保留的 V1 工作区字段。 */
export interface ProjectWorkspace {
  /** 原有工作区配置版本。 */
  version: 1
  /** Project UUID 身份。 */
  id: string
  /** Project 显示名称。 */
  name: string
  /** Project 配置最近更新时间，由写入方提供。 */
  updatedAt: string
  /** 按配置顺序排列的关联目录。 */
  directories: string[]
  /** 按配置顺序排列的对话索引。 */
  sessions: WorkspaceSession[]
}

/** default 分组保留的 V1 工作区字段。 */
export interface DefaultWorkspace {
  /** 原有工作区配置版本。 */
  version: 1
  /** 未归属 Project 的对话索引。 */
  sessions: WorkspaceSession[]
}

/** 分组表的查询结果；不对值重复执行 V1 结构检查。 */
interface GroupRow {
  version: number
  name: string | null
  updated_at: string | null
}

/** 关联目录表的查询结果。 */
interface DirectoryRow {
  directory: string
}

/** 对话索引表的查询结果。 */
interface SessionRow {
  session_id: string
  name: string
  created_at: string
  updated_at: string
}

const CREATE_GROUPS = `CREATE TABLE IF NOT EXISTS workspace_groups (
  group_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT,
  updated_at TEXT
) STRICT`

const CREATE_DIRECTORIES = `CREATE TABLE IF NOT EXISTS workspace_directories (
  group_id TEXT NOT NULL REFERENCES workspace_groups(group_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  directory TEXT NOT NULL,
  PRIMARY KEY (group_id, position)
) STRICT`

const CREATE_SESSIONS = `CREATE TABLE IF NOT EXISTS workspace_sessions (
  group_id TEXT NOT NULL REFERENCES workspace_groups(group_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, position)
) STRICT`

/**
 * 打开工作区数据库，在操作结束后关闭连接。
 * @param databasePath 数据库的绝对路径。
 * @param readOnly 是否只读打开，避免查询时意外创建缺失数据库。
 * @param operation 使用连接完成的同步操作。
 * @returns 操作结果。
 * @throws Error 当路径无效或数据库无法打开、操作失败时抛出。
 */
function withDatabase<T>(
  databasePath: string,
  readOnly: boolean,
  operation: (db: DatabaseSync) => T,
): T {
  if (!isAbsolute(databasePath)) {
    throw new Error(`工作区数据库路径必须是绝对路径：${databasePath}`)
  }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(databasePath, { readOnly })
  } catch (error) {
    throw new Error(`无法打开工作区数据库：${databasePath}`, { cause: error })
  }
  try {
    db.exec("PRAGMA foreign_keys = ON")
    return operation(db)
  } catch (error) {
    throw new Error(`工作区数据库操作失败：${databasePath}`, { cause: error })
  } finally {
    db.close()
  }
}

/**
 * 在一个事务内执行工作区配置写入。
 * @param db 已打开的数据库。
 * @param operation 事务内的写入操作。
 * @returns 已提交的操作结果。
 * @throws Error 当写入失败时回滚并由调用方处理。
 */
function transaction<T>(db: DatabaseSync, operation: () => T): T {
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
 * 确保工作区表存在，并仅在缺失时补入 default 空分组；不检查或回填已有 Project 内容。
 * @param databasePath `.nicode/workspace.sqlite` 的绝对路径。
 * @throws Error 当数据库无法初始化时抛出，已有记录不会被覆盖。
 */
export function initializeWorkspaceDatabase(databasePath: string): void {
  try {
    withDatabase(databasePath, false, (db) => transaction(db, () => {
      db.exec(CREATE_GROUPS)
      db.exec(CREATE_DIRECTORIES)
      db.exec(CREATE_SESSIONS)
      db.prepare(`INSERT OR IGNORE INTO workspace_groups
        (group_id, version, name) VALUES ('default', 1, NULL)`).run()
    }))
  } catch (error) {
    throw new Error(`无法初始化工作区数据库：${databasePath}`, { cause: error })
  }
}

/**
 * 读取一个分组按原字段组成的配置，不执行 V1 结构检查。
 * @param db 已打开的数据库。
 * @param groupId Project ID 字符串或 default。
 * @returns 已有分组及其有序目录、对话；分组缺失时返回 null。
 * @throws Error 当数据库查询失败时抛出。
 */
function readGroup(db: DatabaseSync, groupId: string): {
  group: GroupRow
  directories: string[]
  sessions: WorkspaceSession[]
} | null {
  const group = db.prepare(`SELECT version, name, updated_at
    FROM workspace_groups WHERE group_id = ?`)
    .get(groupId) as GroupRow | undefined
  if (group === undefined) return null
  const directoryRows = db.prepare(`SELECT directory FROM workspace_directories
    WHERE group_id = ? ORDER BY position`).all(groupId) as unknown as DirectoryRow[]
  const sessionRows = db.prepare(`SELECT session_id, name, created_at, updated_at FROM workspace_sessions
    WHERE group_id = ? ORDER BY position`).all(groupId) as unknown as SessionRow[]
  return {
    group,
    directories: directoryRows.map((row) => row.directory),
    sessions: sessionRows.map((row) => ({
      id: row.session_id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

/**
 * 按 Project ID 读取工作区配置。
 * @param databasePath `.nicode/workspace.sqlite` 的绝对路径。
 * @param projectId 要读取的 Project ID。
 * @returns 数据库中对应项目的原有配置字段。
 * @throws Error 当项目记录不存在时报告项目损坏；数据库错误包含路径。
 */
export function readProjectWorkspace(databasePath: string, projectId: string): ProjectWorkspace {
  if (projectId === "default") throw new TypeError("Project ID 不能是 default")
  requireProjectId(projectId)
  const result = withDatabase(databasePath, true, (db) => readGroup(db, projectId))
  if (result === null) {
    throw new Error(`项目损坏：工作区数据库中不存在 Project ${projectId} 的配置（${databasePath}）。`)
  }
  return {
    version: result.group.version as 1,
    id: projectId,
    name: result.group.name as string,
    updatedAt: result.group.updated_at as string,
    directories: result.directories,
    sessions: result.sessions,
  }
}

/**
 * 读取所有非 default Project 及其有序目录、对话索引。
 * @param databasePath `.nicode/workspace.sqlite` 的绝对路径。
 * @returns 按更新时间倒序排列的 Project；同一时间按 UUID 字符串升序排列。
 * @throws Error 当数据库无法读取或 Project 缺少有效更新时间时抛出。
 */
export function listProjectWorkspaces(databasePath: string): ProjectWorkspace[] {
  return withDatabase(databasePath, true, (db) => {
    const rows = db.prepare(`SELECT group_id FROM workspace_groups
      WHERE group_id <> 'default'`).all() as unknown as Array<{ group_id: string }>
    const projects = rows.map((row) => {
      requireProjectId(row.group_id)
      const result = readGroup(db, row.group_id)
      if (result === null) throw new Error(`Project 分组不存在：${row.group_id}`)
      const updatedAt = result.group.updated_at
      if (updatedAt === null || !Number.isFinite(Date.parse(updatedAt))) {
        throw new Error(`Project ${row.group_id} 的更新时间无效。`)
      }
      return {
        version: result.group.version as 1,
        id: row.group_id,
        name: result.group.name as string,
        updatedAt,
        directories: result.directories,
        sessions: result.sessions,
      }
    })
    return projects.sort((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))
  })
}

/**
 * 读取 default 分组及其对话索引。
 * @param databasePath `.nicode/workspace.sqlite` 的绝对路径。
 * @returns default 的原有配置字段。
 * @throws Error 当 default 记录不存在或数据库无法读取时抛出。
 */
export function readDefaultWorkspace(databasePath: string): DefaultWorkspace {
  const result = withDatabase(databasePath, true, (db) => readGroup(db, "default"))
  if (result === null) {
    throw new Error(`工作区数据库中不存在 default 配置：${databasePath}`)
  }
  return { version: result.group.version as 1, sessions: result.sessions }
}

/**
 * 事务式写入一个分组的字段和有序列表。
 * @param databasePath `.nicode/workspace.sqlite` 的绝对路径。
 * @param groupId Project ID 字符串或 default。
 * @param name Project 名称；default 为 null。
 * @param updatedAt Project 配置更新时间；default 为 null。
 * @param version 原有工作区配置版本。
 * @param directories 关联目录有序列表。
 * @param sessions 对话索引有序列表。
 * @throws Error 当数据库写入失败时回滚本次改动。
 */
function saveGroup(
  databasePath: string,
  groupId: string,
  name: string | null,
  updatedAt: string | null,
  version: 1,
  directories: readonly string[],
  sessions: readonly WorkspaceSession[],
): void {
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    db.prepare(`INSERT INTO workspace_groups (group_id, version, name, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET
      version = excluded.version, name = excluded.name, updated_at = excluded.updated_at`)
      .run(groupId, version, name, updatedAt)
    db.prepare("DELETE FROM workspace_directories WHERE group_id = ?").run(groupId)
    db.prepare("DELETE FROM workspace_sessions WHERE group_id = ?").run(groupId)
    const insertDirectory = db.prepare(`INSERT INTO workspace_directories
      (group_id, position, directory) VALUES (?, ?, ?)`)
    directories.forEach((directory, position) => insertDirectory.run(groupId, position, directory))
    const insertSession = db.prepare(`INSERT INTO workspace_sessions
      (group_id, position, session_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    sessions.forEach((session, position) => insertSession.run(
      groupId, position, session.id, session.name, session.createdAt, session.updatedAt,
    ))
  }))
}

/**
 * 保存 Project 的原有工作区字段，供项目管理入口调用。
 * @param databasePath `.nicode/workspace.sqlite` 的绝对路径。
 * @param workspace 要写入的 Project 配置。
 * @throws Error 当数据库写入失败时抛出，原配置保持不变。
 */
export function saveProjectWorkspace(databasePath: string, workspace: ProjectWorkspace): void {
  if (workspace.id === "default") throw new TypeError("Project ID 不能是 default")
  requireProjectId(workspace.id)
  saveGroup(
    databasePath, workspace.id, workspace.name, workspace.updatedAt,
    workspace.version, workspace.directories, workspace.sessions,
  )
}

/**
 * 保存 default 分组的原有工作区字段。
 * @param databasePath `.nicode/workspace.sqlite` 的绝对路径。
 * @param workspace 要写入的 default 配置。
 * @throws Error 当数据库写入失败时抛出，原配置保持不变。
 */
export function saveDefaultWorkspace(databasePath: string, workspace: DefaultWorkspace): void {
  saveGroup(databasePath, "default", null, null, workspace.version, [], workspace.sessions)
}
