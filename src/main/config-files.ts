/**
 * 启动配置文件的初始化、V2 结构检查与 SQLite 数据库准备。
 *
 * 架构依据：开发备忘录第 2–4 节，以及配置 V2、Provider 和工作区 SQLite 结构。
 */

import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { isAbsolute, join } from "node:path"

import { initializeSessionEventDatabase } from "../../runtime/session/src/event-log.ts"
import { initializeSessionMetaDatabase } from "../../runtime/session/src/meta-store.ts"
import { checkConfig } from "./config-schema.ts"
import type { MCPConfig } from "../../runtime/mcp/src/types.ts"
import { initializeProviderDatabase } from "./provider-store.ts"
import { initializeSkillSource, synchronizeSkillSource } from "../../runtime/skill/src/index.ts"
import { initializeWorkspaceDatabase, listProjectWorkspaces } from "./workspace-store.ts"

const INITIAL_CONFIG = `${JSON.stringify({
  version: 2,
  mcpServers: [],
  runtime: { userMessageMode: "queue" },
}, null, 2)}\n`
export interface ConfigFilePaths {
  /** `.nicode` 配置根目录。 */
  rootDir: string
  /** 全局普通配置文件。 */
  configPath: string
  /** Provider、模型、协议及凭据的独立数据库。 */
  providerDatabasePath: string
  /** Project 与 default 共用的工作区配置数据库。 */
  workspaceDatabasePath: string
  /** 所有 Session 共用的 Meta 数据库。 */
  metaDatabasePath: string
}

/** Electron 启动入口消费的已校验 config.json 内容。 */
export interface ValidatedStartupConfig {
  /** V2 持久化结构版本。 */
  version: 2
  /** 已校验、供启动时全局 MCPManager 消费的配置。 */
  mcpServers: MCPConfig[]
  /** 已校验的全局 Runtime 普通配置。 */
  runtime: { userMessageMode: "insert" | "queue" }
}

/** 同一次初始化中得到的路径与已校验配置快照。 */
export interface InitializedConfigFilesSnapshot {
  /** 已初始化的固定配置路径。 */
  paths: ConfigFilePaths
  /** 本次读取并通过 V2 检查的全局配置。 */
  config: ValidatedStartupConfig
}

/** 独立启动入口可选择跳过的模块初始化；省略时保持桌面启动行为。 */
export interface ConfigInitializationOptions {
  /** 为 true 时不创建、扫描或同步任何 Skill 来源目录与 registry。 */
  skipSkills?: boolean
}

function isFileExistsError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST"
}

async function ensureJsonObjectFile(filePath: string, initialContent: string): Promise<Record<string, unknown>> {
  try {
    await writeFile(filePath, initialContent, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw new Error(`无法创建配置文件：${filePath}`, { cause: error })
    }
  }

  return readJsonObjectFile(filePath)
}

/**
 * 只读打开一个既有配置文件，并要求顶层是 JSON 对象。
 *
 * @param filePath 必须已经存在的配置文件路径。
 * @returns 每次调用本次从磁盘解析的新对象。
 * @throws Error 当路径缺失、不是普通文件、不可读或不是有效 JSON 对象时抛出。
 */
async function readJsonObjectFile(filePath: string): Promise<Record<string, unknown>> {
  const file = await lstat(filePath).catch((error: unknown) => {
    throw new Error(`无法检查配置文件：${filePath}`, { cause: error })
  })
  if (!file.isFile()) {
    throw new Error(`配置文件检查失败：${filePath} 不是普通文件。`)
  }
  const content = await readFile(filePath, "utf8").catch((error: unknown) => {
    throw new Error(`无法读取配置文件：${filePath}`, { cause: error })
  })

  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`配置文件检查失败：${filePath} 不是有效的 JSON。`, { cause: error })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`配置文件检查失败：${filePath} 的 JSON 顶层必须是对象。`)
  }
  return value as Record<string, unknown>
}

function checkFile<T>(filePath: string, check: () => T): T {
  try {
    return check()
  } catch (error) {
    throw new Error(`配置文件检查失败：${filePath} ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/**
 * 读取现有普通配置并校验 V2，不创建文件或改写内容。
 * @param configPath 已初始化的 config.json 路径。
 * @returns 本次从磁盘读取的已校验配置。
 * @throws Error 文件缺失、不是普通文件、JSON 损坏或 V2 字段无效；错误包含路径。
 */
export async function readConfigFile(configPath: string): Promise<ValidatedStartupConfig> {
  const config = await readJsonObjectFile(configPath)
  checkFile(configPath, () => checkConfig(config))
  return config as unknown as ValidatedStartupConfig
}

/**
 * 校验并原子替换 MCP 配置，保留本次读取到的其他 V2 字段。
 * @param configPath 已初始化的 config.json 路径；调用方负责串行化读改写流程。
 * @param mcpServers 将完整替换的 MCP 配置列表。
 * @returns 已成功写入的配置快照，供同一次操作同步 Runtime。
 * @throws Error 读取、校验或临时文件替换失败；替换失败时保留原文件。
 */
export async function writeMcpServers(configPath: string, mcpServers: readonly MCPConfig[]): Promise<ValidatedStartupConfig> {
  const config = { ...await readConfigFile(configPath), mcpServers: structuredClone([...mcpServers]) }
  checkFile(configPath, () => checkConfig(config))
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    await rename(temporaryPath, configPath)
  } catch (error) {
    throw new Error(`无法保存配置文件：${configPath}`, { cause: error })
  } finally { await unlink(temporaryPath).catch(() => undefined) }
  return config
}

/**
 * 按启动顺序补齐配置目录、配置文件和四份 SQLite 数据库，并检查全局配置的 V2 结构。
 *
 * 已有全局普通配置不会被覆盖；Skill registry 会按实际来源目录扫描并同步。
 * 检查失败时由调用方决定如何呈现启动错误。
 *
 * @param userProfile 用户目录；省略时读取当前进程的 USERPROFILE。
 * @returns 已初始化并检查通过的固定配置路径。
 * @throws Error 当用户目录无效、文件或数据库无法创建读取，或全局配置未通过 V2 检查时抛出。
 */
export async function initializeConfigFiles(
  userProfile: string | undefined = process.env.USERPROFILE,
): Promise<ConfigFilePaths> {
  return (await initializeConfigFilesSnapshot(userProfile)).paths
}

/**
 * 按启动顺序初始化配置，并返回与路径属于同一次读取的已校验内容快照。
 *
 * 该入口供 Electron 可执行入口使用；普通调用方继续使用 {@link initializeConfigFiles}，
 * 保持调用方只接触不含凭据的全局配置。
 *
 * @param userProfile 用户目录；省略时读取当前进程的 USERPROFILE。
 * @param options 可选的模块初始化控制；默认仍初始化全部 Skill 来源。
 * @returns 固定配置路径，以及本次初始化中读取并通过 V2 检查的普通配置。
 * @throws Error 当用户目录无效、文件或数据库无法创建读取，或全局配置未通过 V2 检查时抛出。
 */
export async function initializeConfigFilesSnapshot(
  userProfile: string | undefined = process.env.USERPROFILE,
  options: ConfigInitializationOptions = {},
): Promise<InitializedConfigFilesSnapshot> {
  if (!userProfile || !isAbsolute(userProfile)) {
    throw new Error("USERPROFILE 必须是非空的绝对路径。")
  }

  const rootDir = join(userProfile, ".nicode")
  const configPath = join(rootDir, "config.json")
  const providerDatabasePath = join(rootDir, "providers.sqlite")
  const sessionsDir = join(rootDir, "sessions")
  const defaultDir = join(sessionsDir, "default")
  const workspaceDatabasePath = join(rootDir, "workspace.sqlite")
  const metaDatabasePath = join(rootDir, "meta.sqlite")

  await mkdir(rootDir, { recursive: true })
  const config = await ensureJsonObjectFile(configPath, INITIAL_CONFIG)
  checkFile(configPath, () => checkConfig(config))

  if (!options.skipSkills) await mkdir(join(rootDir, "skills"), { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(join(rootDir, "logs"), { recursive: true })

  await mkdir(defaultDir, { recursive: true })
  await mkdir(join(defaultDir, "workspace"), { recursive: true })
  initializeProviderDatabase(providerDatabasePath)
  initializeWorkspaceDatabase(workspaceDatabasePath)
  const sources = options.skipSkills ? [] : [
    { directory: join(rootDir, "skills"), scope: "global" as const },
    ...listProjectWorkspaces(workspaceDatabasePath).map((project) => ({ directory: join(sessionsDir, project.id, "skills"), scope: "project" as const })),
  ]
  await Promise.all(sources.map(({ directory }) => initializeSkillSource(directory)))
  await Promise.all(sources.map(({ directory, scope }) => synchronizeSkillSource(directory, scope)))
  await initializeSessionEventDatabase(join(rootDir, "events.sqlite"))
  initializeSessionMetaDatabase(metaDatabasePath)

  return {
    paths: { rootDir, configPath, providerDatabasePath, workspaceDatabasePath, metaDatabasePath },
    config: config as unknown as ValidatedStartupConfig,
  }
}
