/**
 * 启动配置文件的初始化、V2 结构检查与 SQLite 数据库准备。
 *
 * 架构依据：开发备忘录第 2–4 节，以及配置 V2、Provider 和工作区 SQLite 结构。
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { initializeSessionEventDatabase } from "../../runtime/session/src/event-log.ts"
import { checkConfig } from "./config-schema.ts"
import { initializeProviderDatabase } from "./provider-store.ts"
import { initializeWorkspaceDatabase } from "./workspace-store.ts"

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
}

/** Electron 启动入口消费的已校验 config.json 内容。 */
export interface ValidatedStartupConfig {
  /** V2 持久化结构版本。 */
  version: 2
  /** 已校验的 MCP 配置；本次启动构建不消费其内容。 */
  mcpServers: unknown[]
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
 * 按启动顺序补齐配置目录、配置文件和三份 SQLite 数据库，并检查全局配置的 V2 结构。
 * 已有文件不会被覆盖。
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
 * @returns 固定配置路径，以及本次初始化中读取并通过 V2 检查的普通配置。
 * @throws Error 当用户目录无效、文件或数据库无法创建读取，或全局配置未通过 V2 检查时抛出。
 */
export async function initializeConfigFilesSnapshot(
  userProfile: string | undefined = process.env.USERPROFILE,
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

  await mkdir(rootDir, { recursive: true })
  const config = await ensureJsonObjectFile(configPath, INITIAL_CONFIG)
  checkFile(configPath, () => checkConfig(config))

  await mkdir(join(rootDir, "skills"), { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(join(rootDir, "logs"), { recursive: true })

  await mkdir(defaultDir, { recursive: true })
  await mkdir(join(defaultDir, "workspace"), { recursive: true })
  initializeProviderDatabase(providerDatabasePath)
  initializeWorkspaceDatabase(workspaceDatabasePath)
  await initializeSessionEventDatabase(join(rootDir, "events.sqlite"))

  return {
    paths: { rootDir, configPath, providerDatabasePath, workspaceDatabasePath },
    config: config as unknown as ValidatedStartupConfig,
  }
}
