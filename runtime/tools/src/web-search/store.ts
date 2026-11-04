/** 搜索配置的独立 SQLite 存储；只保存请求原文，不解释服务商字段。 */
import { lstatSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { compile } from "@jmespath-community/jmespath"
import type { WebSearchProviderConfig, WebSearchProviderInput } from "./types.ts"

/** 用户 .nicode 根目录下的搜索配置数据库文件名。 */
export const WEB_SEARCH_DATABASE_FILE = "web-search.sqlite"

/** SQLite 原始配置行；读取时还原 enabled 并检查配置语法。 */
interface ProviderRow {
  /** 服务商 ID。 */
  id: string
  /** SQLite 布尔列。 */
  enabled: number
  /** 完整请求配置原文。 */
  request_json: string
  /** 响应映射表达式。 */
  response_jmespath: string
}

/**
 * 检查数据库路径为绝对路径，存在时必须是普通文件。
 * @param databasePath 数据库绝对路径。
 * @returns 数据库是否已经存在。
 * @throws Error 路径无效、不是普通文件或无法检查；不附带配置内容。
 */
function databaseExists(databasePath: string): boolean {
  if (!isAbsolute(databasePath)) throw new Error("搜索数据库路径必须是绝对路径。")
  try {
    if (!lstatSync(databasePath).isFile()) throw new Error("搜索数据库必须是普通文件。")
    return true
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
    throw new Error("无法检查搜索数据库文件。")
  }
}

/**
 * 打开已有 V1 数据库，执行操作并关闭连接；错误不暴露请求或凭据。
 * @param databasePath 数据库绝对路径。
 * @param readOnly 是否只读打开。
 * @param operation 在连接上运行的操作。
 * @returns 操作返回值。
 * @throws Error 数据库缺失、版本不符、损坏或操作失败；调用方负责错误展示。
 */
function withDatabase<T>(databasePath: string, readOnly: boolean, operation: (db: DatabaseSync) => T): T {
  if (!databaseExists(databasePath)) throw new Error("搜索数据库不存在。")
  const db = new DatabaseSync(databasePath, { readOnly })
  try {
    const row = db.prepare("PRAGMA user_version").get()
    if (row?.user_version !== 1) throw new Error("不支持的搜索数据库版本。")
    return operation(db)
  } catch {
    throw new Error("搜索数据库操作失败，请检查版本、结构和配置。")
  } finally { db.close() }
}

/**
 * 执行写事务，任一步失败时回滚。
 * @param db 已打开的数据库。
 * @param operation 事务内的同步操作。
 * @throws Error 写入或提交失败，事务回滚后向调用方传播。
 */
function transaction(db: DatabaseSync, operation: () => void): void {
  db.exec("BEGIN IMMEDIATE")
  try { operation(); db.exec("COMMIT") }
  catch (error) { db.exec("ROLLBACK"); throw error }
}

/**
 * 缺失时创建 V1 空库，已有库只校验版本、表和唯一启用索引，不迁移或覆盖。
 * @param databasePath 用户 .nicode 下的数据库绝对路径；父目录由启动流程创建。
 * @throws Error 路径、数据库版本或结构不合法，或初始化失败。
 */
export function initializeWebSearchDatabase(databasePath: string): void {
  if (databaseExists(databasePath)) {
    withDatabase(databasePath, true, (db) => {
      db.prepare("SELECT id, enabled, request_json, response_jmespath FROM web_search_providers LIMIT 0").all()
      const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'web_search_single_enabled'").get()
      if (!index?.sql) throw new Error("搜索数据库缺少唯一启用索引。")
    })
    return
  }
  const db = new DatabaseSync(databasePath)
  try {
    transaction(db, () => {
      db.exec(`CREATE TABLE web_search_providers (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        response_jmespath TEXT NOT NULL CHECK (length(trim(response_jmespath)) > 0)
      ) STRICT`)
      db.exec("CREATE UNIQUE INDEX web_search_single_enabled ON web_search_providers(enabled) WHERE enabled = 1")
      db.exec("PRAGMA user_version = 1")
    })
  } catch { throw new Error("无法初始化搜索数据库。") }
  finally { db.close() }
}

/**
 * 检查必要字符串、请求 JSON 和表达式语法，不校验 fetch 选项或业务字段。
 * @param input 待保存或从数据库读取的配置。
 * @throws Error 字符串、JSON 或表达式语法无效，不包含输入原文。
 */
function validateProvider(input: WebSearchProviderInput): void {
  if ([input.id, input.requestJson, input.responseJmespath].some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error("搜索服务商 ID、请求 JSON 和 JMESPath 必须是非空字符串。")
  }
  try { JSON.parse(input.requestJson) }
  catch { throw new Error("搜索请求配置必须是合法 JSON。") }
  try { compile(input.responseJmespath) }
  catch { throw new Error("搜索响应 JMESPath 语法无效。") }
}

/**
 * 将数据库行还原为配置并校验语法，不改写请求原文。
 * @param row SQLite 配置行。
 * @returns 完整后端配置。
 * @throws Error 持久化配置语法或启用值无效。
 */
function readProvider(row: ProviderRow): WebSearchProviderConfig {
  const config = { id: row.id, enabled: row.enabled === 1, requestJson: row.request_json, responseJmespath: row.response_jmespath }
  validateProvider(config)
  if (row.enabled !== 0 && row.enabled !== 1) throw new Error("搜索服务商启用值无效。")
  return config
}

/**
 * 查询全部配置；返回值可能含凭据，只能由后端消费。
 * @param databasePath 已初始化的数据库绝对路径。
 * @returns 按 ID 排序的完整配置。
 * @throws Error 数据库或配置无效。
 */
export function listWebSearchProviders(databasePath: string): WebSearchProviderConfig[] {
  return withDatabase(databasePath, true, (db) => (db.prepare("SELECT * FROM web_search_providers ORDER BY id").all() as unknown as ProviderRow[]).map(readProvider))
}

/**
 * 读取本次搜索使用的启用配置快照，返回前关闭数据库。
 * @param databasePath 已初始化的数据库绝对路径。
 * @returns 启用配置；没有启用项时为 undefined。
 * @throws Error 数据库、配置无效或存在多个启用项。
 */
export function readActiveWebSearchProvider(databasePath: string): WebSearchProviderConfig | undefined {
  return withDatabase(databasePath, true, (db) => {
    const rows = db.prepare("SELECT * FROM web_search_providers WHERE enabled = 1 LIMIT 2").all() as unknown as ProviderRow[]
    if (rows.length > 1) throw new Error("搜索服务商启用状态无效。")
    return rows[0] === undefined ? undefined : readProvider(rows[0])
  })
}

/**
 * 新增或更新请求与映射配置；新增默认禁用，更新保留启用状态。
 * @param databasePath 已初始化的数据库绝对路径。
 * @param input 不含启用状态的完整配置，请求字符串按原文保存。
 * @throws Error 配置语法不合法或数据库操作失败。
 */
export function saveWebSearchProvider(databasePath: string, input: WebSearchProviderInput): void {
  validateProvider(input)
  withDatabase(databasePath, false, (db) => {
    db.prepare(`INSERT INTO web_search_providers (id, request_json, response_jmespath) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET request_json = excluded.request_json, response_jmespath = excluded.response_jmespath`)
      .run(input.id, input.requestJson, input.responseJmespath)
  })
}

/**
 * 在同一事务内切换唯一启用项，失败保留原状态。
 * @param databasePath 已初始化的数据库绝对路径。
 * @param providerId 要启用的服务商 ID；null 禁用全部。
 * @throws Error 目标不存在、配置无效或事务失败。
 */
export function setActiveWebSearchProvider(databasePath: string, providerId: string | null): void {
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    if (providerId !== null) {
      const row = db.prepare("SELECT * FROM web_search_providers WHERE id = ?").get(providerId) as unknown as ProviderRow | undefined
      if (!row) throw new Error("搜索服务商不存在。")
      readProvider(row)
    }
    db.exec("UPDATE web_search_providers SET enabled = 0 WHERE enabled = 1")
    if (providerId !== null) db.prepare("UPDATE web_search_providers SET enabled = 1 WHERE id = ?").run(providerId)
  }))
}

/**
 * 删除指定配置，删除启用项后不自动选择替代项；不存在时不执行更改。
 * @param databasePath 已初始化的数据库绝对路径。
 * @param providerId 要删除的服务商 ID。
 * @throws Error 数据库操作失败。
 */
export function deleteWebSearchProvider(databasePath: string, providerId: string): void {
  withDatabase(databasePath, false, (db) => { db.prepare("DELETE FROM web_search_providers WHERE id = ?").run(providerId) })
}
