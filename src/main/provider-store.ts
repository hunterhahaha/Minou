/** Provider、模型、协议连接参数与凭据在独立 SQLite 数据库中的持久化。 */

import { lstatSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { ProviderCredential } from "../../runtime/credential/src/index.ts"
import { PROTOCOLS } from "../../runtime/model/src/types.ts"
import type { ModelConfig, ModelRef, Protocol } from "../../runtime/model/src/types.ts"
import { isReasoningField, isReasoningLevels } from "../../runtime/model/src/reasoning.ts"

/** Provider 创建来源；两个值都必须由创建 IPC 显式提供。 */
export type ProviderType = "compatible" | "custom"

/** 一个 Provider 唯一协议的连接配置，不包含 API Key。 */
export interface ProviderRecord {
  /** 稳定且唯一的 Provider 身份。 */
  id: string
  /** 用户可见名称。 */
  name: string
  /** 创建来源，不随名称、URL 或模型编辑自动改变。 */
  type: ProviderType
  /** 当前 Provider 唯一的协议。 */
  protocol: Protocol
  /** 可选的协议服务地址。 */
  baseURL?: string
  /** 可选的额外请求头。 */
  defaultHeaders?: Record<string, string>
}

/** Provider 数据库中的模型记录；协议由所属 Provider 决定。 */
export interface ProviderModelRecord extends Omit<ModelConfig, "protocol"> {}

/** Provider 与 ModelRef 共用的模型引用；modelId 是全局唯一的模型身份。 */
export interface ProviderModelReference {
  /** 模型所属的 Provider 身份。 */
  providerId: string
  /** 全局唯一的模型身份。 */
  modelId: string
}

/** 更新模型补丁；数值限制只接受正整数，省略名称时保持原值。 */
export interface ProviderModelUpdate {
  /** Provider API 请求中使用的非空模型名称；省略时本次不更新名称。 */
  name?: string
  /** 新的声明上下文窗口。 */
  contextWindow?: number
  /** 新的最大输出 Token 数。 */
  maxOutputTokens?: number
  /** 完整替换可选等级列表。 */
  reasoningLevels?: string[]
  /** 完整替换请求字段路径。 */
  reasoningField?: ModelConfig["reasoningField"]
}

/** 不含凭据的 Provider 与模型列表项。 */
export interface ProviderCatalogEntry extends ProviderRecord {
  /** 按保存顺序排列的模型。 */
  models: ProviderModelRecord[]
}

/** 供单个 Turn 创建 Adapter 的同一数据库快照。 */
export interface TurnProviderSnapshot {
  /** 当前 Provider 及唯一协议的连接参数。 */
  provider: ProviderRecord
  /** 已绑定 Provider 与协议的模型。 */
  model: ModelConfig
  /** 当前 Provider 的凭据；尚未配置时为 undefined。 */
  credential?: ProviderCredential
}

/**
 * Provider SQLite 查询返回的原始列值，供转换为业务记录。
 */
interface ProviderRow {
  id: string
  name: string
  type: string
  protocol: string
  base_url: string | null
  default_headers_json: string | null
}

/**
 * 模型 SQLite 查询返回的原始列值，推理配置 JSON 在转换时解析。
 */
interface ModelRow {
  id: string
  name: string
  provider_id: string
  context_window: number
  max_output_tokens: number
  reasoning_levels_json: string
  reasoning_field_json: string
}

const CREATE_PROVIDERS = `CREATE TABLE providers (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  type TEXT NOT NULL CHECK (type IN ('compatible', 'custom')),
  protocol TEXT NOT NULL CHECK (protocol IN ('anthropic_messages', 'chat_completions', 'responses')),
  base_url TEXT,
  default_headers_json TEXT
) STRICT`
const CREATE_MODELS = `CREATE TABLE models (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  reasoning_levels_json TEXT NOT NULL,
  reasoning_field_json TEXT NOT NULL,
  UNIQUE (provider_id, position)
) STRICT`
const CREATE_CREDENTIALS = `CREATE TABLE provider_credentials (
  provider_id TEXT PRIMARY KEY NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  api_key TEXT NOT NULL CHECK (length(trim(api_key)) > 0)
) STRICT`
const CREATE_SETTINGS = `CREATE TABLE provider_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_provider_id TEXT,
  default_model_id TEXT,
  CHECK ((default_provider_id IS NULL) = (default_model_id IS NULL))
) STRICT`

/**
 * 检查数据库文件身份；普通读写入口不得隐式创建缺失文件。
 * @param databasePath Provider 数据库绝对路径。
 * @returns 路径已经存在时为 true。
 * @throws Error 当路径不是普通文件或不可访问时抛出。
 */
function fileExists(databasePath: string): boolean {
  if (!isAbsolute(databasePath)) throw new Error(`Provider 数据库路径必须是绝对路径：${databasePath}`)
  try {
    const state = lstatSync(databasePath)
    if (!state.isFile()) throw new Error(`Provider 数据库不是普通文件：${databasePath}`)
    return true
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

/**
 * 打开已有数据库并在操作完成后关闭，错误只报告路径而不包含凭据。
 * @param databasePath Provider 数据库绝对路径。
 * @param readOnly 是否只读打开。
 * @param operation 在连接上执行的操作。
 * @returns 操作结果。
 * @throws Error 当数据库缺失、损坏、版本不符或操作失败时抛出。
 */
function withDatabase<T>(databasePath: string, readOnly: boolean, operation: (db: DatabaseSync) => T): T {
  if (!fileExists(databasePath)) throw new Error(`Provider 数据库不存在：${databasePath}`)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(databasePath, { readOnly })
  } catch {
    throw new Error(`无法打开 Provider 数据库：${databasePath}`)
  }
  try {
    db.exec("PRAGMA foreign_keys = ON")
    requireVersion(db)
    return operation(db)
  } catch (error) {
    throw new Error(`Provider 数据库操作失败：${databasePath} ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    db.close()
  }
}

/**
 * 要求数据库采用 V2，Provider 类型和模型能力列具有必需的非空约束。
 * @param db 已打开的数据库。
 * @throws Error 当版本不受支持或必需列允许 null 时抛出。
 */
function requireVersion(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number }
  if (version.user_version !== 2) throw new Error(`不支持 Provider 数据库版本 ${version.user_version}。`)
  const columns = db.prepare("PRAGMA table_info(models)").all() as Array<{ name: string; notnull: number }>
  for (const name of ["context_window", "max_output_tokens", "reasoning_levels_json", "reasoning_field_json"] as const) {
    if (!columns.some((column) => column.name === name && column.notnull === 1)) {
      throw new Error(`Provider 数据库字段 models.${name} 必须定义为 NOT NULL。`)
    }
  }
  const providerColumns = db.prepare("PRAGMA table_info(providers)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>
  if (!providerColumns.some((column) => column.name === "type" && column.notnull === 1 && column.dflt_value === null)) {
    throw new Error("Provider 数据库字段 providers.type 必须为无默认值的 NOT NULL 列。")
  }
}

/**
 * 在一个写事务内提交操作，失败时回滚。
 * @param db 已打开的数据库。
 * @param operation 事务内的写入。
 * @returns 已提交的操作结果。
 * @throws Error 当任一写入失败时抛出，原状态保留。
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
 * 缺失时创建空 Provider 数据库；已有数据库校验 V2 版本与必需列约束，不执行迁移。
 * @param databasePath `.nicode/providers.sqlite` 的绝对路径。
 * @throws Error 当路径无效、目标不是普通文件、已有结构不兼容或数据库无法创建时抛出。
 */
export function initializeProviderDatabase(databasePath: string): void {
  const exists = fileExists(databasePath)
  if (exists) {
    withDatabase(databasePath, true, () => undefined)
    return
  }

  let db: DatabaseSync
  try {
    db = new DatabaseSync(databasePath)
    try {
      db.exec("PRAGMA foreign_keys = ON")
      transaction(db, () => {
        db.exec(CREATE_PROVIDERS)
        db.exec(CREATE_MODELS)
        db.exec(CREATE_CREDENTIALS)
        db.exec(CREATE_SETTINGS)
        db.prepare("INSERT INTO provider_settings (id, default_provider_id, default_model_id) VALUES (1, NULL, NULL)").run()
        db.exec("PRAGMA user_version = 2")
      })
    } finally {
      db.close()
    }
  } catch {
    throw new Error(`无法初始化 Provider 数据库：${databasePath}`)
  }
}

/**
 * 检查非空字符串。
 * @param value 待检查的值。
 * @param field 字段名称，不包含凭据内容。
 * @returns 原字符串。
 * @throws Error 当值为空或类型错误时抛出。
 */
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} 必须是非空字符串。`)
  return value
}

/**
 * 将请求头对象校验并复制为可序列化值。
 * @param value 请求头对象。
 * @returns 可安全保存的对象；未配置时为 undefined。
 * @throws Error 当字段类型错误时抛出。
 */
function headers(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider defaultHeaders 必须是字符串映射。")
  }
  const copy: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    nonEmpty(key, "Provider defaultHeaders 的键")
    if (typeof entry !== "string") throw new Error("Provider defaultHeaders 的值必须是字符串。")
    Object.defineProperty(copy, key, { value: entry, enumerable: true, configurable: true, writable: true })
  }
  return copy
}

/**
 * 从数据库行恢复协议配置并检查持久化值。
 * @param row Provider 数据库行。
 * @returns 不含凭据的 Provider 配置。
 * @throws Error 当行中有非法协议或 JSON 时抛出。
 */
function providerFromRow(row: ProviderRow): ProviderRecord {
  nonEmpty(row.id, "Provider id")
  nonEmpty(row.name, "Provider name")
  if (row.type !== "compatible" && row.type !== "custom") throw new Error("Provider 类型无效。")
  if (!(PROTOCOLS as readonly string[]).includes(row.protocol)) throw new Error("Provider 协议无效。")
  let defaultHeaders: Record<string, string> | undefined
  if (row.default_headers_json !== null) {
    defaultHeaders = headers(JSON.parse(row.default_headers_json))
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    protocol: row.protocol as Protocol,
    ...(row.base_url === null ? {} : { baseURL: nonEmpty(row.base_url, "Provider baseURL") }),
    ...(defaultHeaders === undefined ? {} : { defaultHeaders }),
  }
}

/**
 * 将 SQLite 模型行校验并恢复成持久化模型记录。
 * @param row 模型数据库行。
 * @param protocol 从所属 Provider 读取的协议，用于检查推理字段路径。
 * @returns 不含协议的模型字段。
 * @throws Error 当持久化字段无效时抛出。
 */
function modelFromRow(row: ModelRow, protocol: Protocol): ProviderModelRecord {
  nonEmpty(row.id, "Model id")
  nonEmpty(row.name, "Model Name")
  nonEmpty(row.provider_id, "Model providerId")
  const model: ProviderModelRecord = {
    modelId: row.id,
    name: row.name,
    providerId: row.provider_id,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    reasoningLevels: JSON.parse(row.reasoning_levels_json) as unknown as string[],
    reasoningField: JSON.parse(row.reasoning_field_json) as unknown as ModelConfig["reasoningField"],
  }
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const value = model[field]
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Model ${field} 必须是正整数。`)
  }
  if (!isReasoningLevels(model.reasoningLevels) || !isReasoningField(model.reasoningField, protocol)) {
    throw new Error("Model 推理配置无效。")
  }
  return model
}

/**
 * 查询 Provider 与模型的有序列表，不接触凭据表。
 * @param db 已打开的数据库。
 * @returns Provider 及其模型列表。
 * @throws Error 当持久化字段无效时抛出。
 */
function listProvidersInDatabase(db: DatabaseSync): ProviderCatalogEntry[] {
  const providerRows = db.prepare(`SELECT id, name, type, protocol, base_url, default_headers_json
    FROM providers ORDER BY position, id`).all() as unknown as ProviderRow[]
  const modelRows = db.prepare(`SELECT id, name, provider_id, context_window, max_output_tokens,
    reasoning_levels_json, reasoning_field_json
    FROM models ORDER BY provider_id, position, id`).all() as unknown as ModelRow[]
  const providers = providerRows.map(providerFromRow)
  const protocols = new Map(providers.map((provider) => [provider.id, provider.protocol]))
  const models = new Map<string, ProviderModelRecord[]>()
  for (const row of modelRows) {
    const protocol = protocols.get(row.provider_id)
    if (protocol === undefined) throw new Error(`Model 所属 Provider ${row.provider_id} 不存在。`)
    const list = models.get(row.provider_id) ?? []
    list.push(modelFromRow(row, protocol))
    models.set(row.provider_id, list)
  }
  return providers.map((provider) => ({ ...provider, models: models.get(provider.id) ?? [] }))
}

/**
 * 读取不含任何 API Key 的 Provider 与模型有序列表。
 * @param databasePath Provider 数据库绝对路径。
 * @returns 当前配置的独立对象列表。
 * @throws Error 当数据库无法读取或配置损坏时抛出。
 */
export function listProviders(databasePath: string): ProviderCatalogEntry[] {
  return withDatabase(databasePath, true, listProvidersInDatabase)
}

/**
 * 读取有效默认模型身份；未显式设置时选有序列表的第一个模型。
 * @param databasePath Provider 数据库绝对路径。
 * @returns Provider 与模型的组合身份；空库时为 undefined。
 * @throws Error 当数据库无法读取时抛出。
 */
export function readDefaultModel(databasePath: string): ProviderModelReference | undefined {
  return withDatabase(databasePath, true, (db) => {
    const settings = db.prepare("SELECT default_provider_id, default_model_id FROM provider_settings WHERE id = 1")
      .get() as { default_provider_id: string | null; default_model_id: string | null } | undefined
    if (settings === undefined) throw new Error("缺少默认模型设置记录。")
    if (settings.default_provider_id !== null || settings.default_model_id !== null) {
      if (settings.default_provider_id === null || settings.default_model_id === null) {
        throw new Error("默认模型 Provider ID 与模型 ID 必须同时存在。")
      }
      if (db.prepare("SELECT 1 FROM models WHERE provider_id = ? AND id = ? LIMIT 1")
        .get(settings.default_provider_id, settings.default_model_id) === undefined) {
        throw new Error(`默认模型 ${settings.default_provider_id}/${settings.default_model_id} 不存在。`)
      }
      return { providerId: settings.default_provider_id, modelId: settings.default_model_id }
    }
    const first = db.prepare(`SELECT m.provider_id, m.id FROM models m JOIN providers p ON p.id = m.provider_id
      ORDER BY p.position, m.position, m.id LIMIT 1`).get() as { provider_id: string; id: string } | undefined
    return first === undefined ? undefined : { providerId: first.provider_id, modelId: first.id }
  })
}

/**
 * 新增或更新一个 Provider，更新时保留其顺序与模型。
 * @param databasePath Provider 数据库绝对路径。
 * @param provider 不含凭据的 Provider 配置。
 * @throws Error 当配置无效或写入失败时抛出，原状态保留。
 */
export function saveProvider(databasePath: string, provider: ProviderRecord): void {
  const id = nonEmpty(provider.id, "Provider id")
  const name = nonEmpty(provider.name, "Provider name")
  if (provider.type !== "compatible" && provider.type !== "custom") throw new Error("Provider 类型无效。")
  if (!(PROTOCOLS as readonly string[]).includes(provider.protocol)) throw new Error("Provider 协议无效。")
  const baseURL = provider.baseURL === undefined ? null : nonEmpty(provider.baseURL, "Provider baseURL")
  const defaultHeaders = headers(provider.defaultHeaders)
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    const position = db.prepare("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM providers")
      .get() as { next: number }
    db.prepare(`INSERT INTO providers (id, position, name, type, protocol, base_url, default_headers_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, protocol = excluded.protocol, base_url = excluded.base_url,
      default_headers_json = excluded.default_headers_json`)
      .run(id, position.next, name, provider.type, provider.protocol, baseURL,
        defaultHeaders === undefined ? null : JSON.stringify(defaultHeaders))
  }))
}

/**
 * 删除 Provider 及其模型、凭据；被删除的默认模型引用自动清空。
 * @param databasePath Provider 数据库绝对路径。
 * @param providerId 要删除的 Provider ID。
 * @throws Error 当数据库无法写入时抛出。
 */
export function deleteProvider(databasePath: string, providerId: string): void {
  nonEmpty(providerId, "Provider id")
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    db.prepare(`UPDATE provider_settings SET default_provider_id = NULL, default_model_id = NULL
      WHERE id = 1 AND default_provider_id = ?`).run(providerId)
    db.prepare("DELETE FROM providers WHERE id = ?").run(providerId)
  }))
}

/**
 * 在 Provider 模型列表末尾新增一条全局唯一 modelId 的记录。
 * @param databasePath Provider 数据库绝对路径。
 * @param model 模型字段与所属 Provider。
 * @throws Error 当 Provider 不存在或模型字段无效时抛出。
 */
export function saveModel(databasePath: string, model: ProviderModelRecord): void {
  const id = nonEmpty(model.modelId, "Model id")
  const name = nonEmpty(model.name, "Model Name")
  const providerId = nonEmpty(model.providerId, "Model providerId")
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const value = model[field]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Model ${field} 必须是正整数。`)
    }
  }
  if (!isReasoningLevels(model.reasoningLevels)) throw new Error("Model reasoningLevels 无效。")
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    const provider = db.prepare("SELECT protocol FROM providers WHERE id = ?").get(providerId) as { protocol: Protocol } | undefined
    if (provider === undefined) throw new Error(`Provider ${providerId} 不存在。`)
    if (!isReasoningField(model.reasoningField, provider.protocol)) throw new Error("Model reasoningField 无效。")
    const position = db.prepare("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM models WHERE provider_id = ?")
      .get(providerId) as { next: number }
    db.prepare(`INSERT INTO models (id, name, provider_id, position, context_window, max_output_tokens,
      reasoning_levels_json, reasoning_field_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, providerId, position.next, model.contextWindow, model.maxOutputTokens,
        JSON.stringify(model.reasoningLevels), JSON.stringify(model.reasoningField))
  }))
}

/**
 * 更新由 Provider 与全局唯一 modelId 指定的模型记录。
 * @param databasePath Provider 数据库绝对路径。
 * @param reference 要更新的 Provider 与模型引用。
 * @param update 要替换的名称、数值限制或推理配置；省略字段时保持原值。
 * @throws Error 当模型不存在、字段无效或数据库无法写入时抛出。
 */
export function updateModel(
  databasePath: string,
  reference: ProviderModelReference,
  update: ProviderModelUpdate,
): void {
  const providerId = nonEmpty(reference.providerId, "Model providerId")
  const modelId = nonEmpty(reference.modelId, "Model id")
  if (update.name !== undefined &&
      (typeof update.name !== "string" || update.name.trim() === "")) {
    throw new TypeError("name must not be empty or whitespace-only")
  }
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const value = update[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Model ${field} 必须是正整数。`)
    }
  }
  if (update.reasoningLevels !== undefined && !isReasoningLevels(update.reasoningLevels)) {
    throw new Error("Model reasoningLevels 无效。")
  }
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    const row = db.prepare(`SELECT models.id, providers.protocol FROM models
      JOIN providers ON providers.id = models.provider_id
      WHERE models.provider_id = ? AND models.id = ? LIMIT 1`)
      .get(providerId, modelId) as { id: string; protocol: Protocol } | undefined
    if (row === undefined) throw new Error(`Provider ${providerId} 不包含模型 ${modelId}。`)
    if (update.reasoningField !== undefined && !isReasoningField(update.reasoningField, row.protocol)) {
      throw new Error("Model reasoningField 无效。")
    }

    const assignments: string[] = []
    const values: (number | string | null)[] = []
    if (update.name !== undefined) {
      assignments.push("name = ?")
      values.push(update.name)
    }
    if (update.contextWindow !== undefined) {
      assignments.push("context_window = ?")
      values.push(update.contextWindow)
    }
    if (update.maxOutputTokens !== undefined) {
      assignments.push("max_output_tokens = ?")
      values.push(update.maxOutputTokens)
    }
    if (update.reasoningLevels !== undefined) {
      assignments.push("reasoning_levels_json = ?")
      values.push(JSON.stringify(update.reasoningLevels))
    }
    if (update.reasoningField !== undefined) {
      assignments.push("reasoning_field_json = ?")
      values.push(JSON.stringify(update.reasoningField))
    }
    if (assignments.length === 0) return
    const result = db.prepare(`UPDATE models SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values, row.id)
    if (result.changes !== 1) throw new Error(`Provider ${providerId} 的模型 ${modelId} 更新失败。`)
  }))
}

/**
 * 删除 Provider 下由 modelId 标识的模型；若其为显式默认模型，引用同时清空。
 * @param databasePath Provider 数据库绝对路径。
 * @param providerId 模型所属 Provider 的 ID。
 * @param modelId Provider 下要删除的全局唯一模型身份。
 * @throws Error 当数据库无法写入时抛出。
 */
export function deleteModel(databasePath: string, providerId: string, modelId: string): void {
  nonEmpty(providerId, "Model providerId")
  nonEmpty(modelId, "Model id")
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    db.prepare("DELETE FROM models WHERE provider_id = ? AND id = ?").run(providerId, modelId)
    db.prepare(`UPDATE provider_settings SET default_provider_id = NULL, default_model_id = NULL
      WHERE id = 1 AND default_provider_id = ? AND default_model_id = ?`).run(providerId, modelId)
  }))
}

/**
 * 设置或移除单个 Provider 的 API Key，错误信息不含密钥内容。
 * @param databasePath Provider 数据库绝对路径。
 * @param providerId 已配置的 Provider ID。
 * @param apiKey 新密钥；null 表示移除。
 * @throws Error 当 Provider 不存在、密钥为空或写入失败时抛出。
 */
export function setProviderApiKey(databasePath: string, providerId: string, apiKey: string | null): void {
  nonEmpty(providerId, "Provider id")
  if (apiKey !== null) nonEmpty(apiKey, "API Key")
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    if (db.prepare("SELECT id FROM providers WHERE id = ?").get(providerId) === undefined) {
      throw new Error(`Provider ${providerId} 不存在。`)
    }
    if (apiKey === null) {
      db.prepare("DELETE FROM provider_credentials WHERE provider_id = ?").run(providerId)
    } else {
      db.prepare(`INSERT INTO provider_credentials (provider_id, api_key) VALUES (?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET api_key = excluded.api_key`).run(providerId, apiKey)
    }
  }))
}

/**
 * 设置显式默认模型；null 表示恢复按顺序选择第一个模型。
 * @param databasePath Provider 数据库绝对路径。
 * @param reference 已配置模型的 Provider 与模型组合身份，或 null。
 * @throws Error 当模型不存在或数据库无法写入时抛出。
 */
export function setDefaultModel(databasePath: string, reference: ProviderModelReference | null): void {
  if (reference !== null) {
    nonEmpty(reference.providerId, "默认模型 Provider ID")
    nonEmpty(reference.modelId, "默认模型 ID")
  }
  withDatabase(databasePath, false, (db) => transaction(db, () => {
    if (reference !== null && db.prepare("SELECT id FROM models WHERE provider_id = ? AND id = ? LIMIT 1")
      .get(reference.providerId, reference.modelId) === undefined) {
      throw new Error(`Provider ${reference.providerId} 中的默认模型 ${reference.modelId} 不存在。`)
    }
    const result = db.prepare(`UPDATE provider_settings
      SET default_provider_id = ?, default_model_id = ? WHERE id = 1`)
      .run(reference?.providerId ?? null, reference?.modelId ?? null)
    if (result.changes !== 1) throw new Error("缺少默认模型设置记录。")
  }))
}

/**
 * 在同一次只读事务中读取全局唯一 modelId 指定的模型、协议参数和 API Key。
 * @param databasePath Provider 数据库绝对路径。
 * @param reference 当前 Turn 的模型引用。
 * @returns 当前数据库快照中的模型装配输入。
 * @throws Error 当引用不匹配、配置缺失或数据库损坏时抛出；错误不含 API Key。
 */
export function readTurnProviderSnapshot(databasePath: string, reference: ModelRef): TurnProviderSnapshot {
  return withDatabase(databasePath, true, (db) => {
    db.exec("BEGIN")
    try {
      const providerRow = db.prepare(`SELECT id, name, type, protocol, base_url, default_headers_json
        FROM providers WHERE id = ?`).get(reference.providerId) as ProviderRow | undefined
      if (providerRow === undefined) throw new Error(`Provider ${reference.providerId} 不存在。`)
      const provider = providerFromRow(providerRow)
      if (provider.protocol !== reference.protocol) {
        throw new Error(`Provider ${provider.id} 的唯一协议 ${provider.protocol} 与 Session 协议不一致。`)
      }
      const modelRow = db.prepare(`SELECT id, name, provider_id, context_window, max_output_tokens,
        reasoning_levels_json, reasoning_field_json
        FROM models WHERE id = ? AND provider_id = ? ORDER BY position, id LIMIT 1`)
        .get(reference.modelId, reference.providerId) as ModelRow | undefined
      if (modelRow === undefined) throw new Error(`Provider ${provider.id} 不包含模型 ${reference.modelId}。`)
      const modelRecord = modelFromRow(modelRow, provider.protocol)
      const model: ModelConfig = {
        ...modelRecord,
        protocol: provider.protocol,
        contextWindow: modelRecord.contextWindow,
      }
      const credentialRow = db.prepare("SELECT api_key FROM provider_credentials WHERE provider_id = ?")
        .get(provider.id) as { api_key: string } | undefined
      const credential = credentialRow === undefined ? undefined : {
        providerId: provider.id,
        apiKey: nonEmpty(credentialRow.api_key, "API Key"),
      }
      db.exec("COMMIT")
      return { provider, model, ...(credential === undefined ? {} : { credential }) }
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  })
}
