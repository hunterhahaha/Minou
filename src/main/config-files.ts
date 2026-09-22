/**
 * 启动配置文件的初始化与 V1 结构检查。
 *
 * 架构依据：开发备忘录第 2–4 节，以及配置与凭据、工作区配置文件结构 V1。
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import type { ProviderCredential } from "../../runtime/credential/src/index.ts"
import type { ModelConfig, Protocol } from "../../runtime/model/src/types.ts"
import { checkConfig, checkCredentials, checkDefaultWorkspace } from "./config-schema.ts"

const INITIAL_CONFIG = `${JSON.stringify({
  version: 1,
  providers: [],
  mcpServers: [],
  runtime: { userMessageMode: "queue" },
}, null, 2)}\n`
const INITIAL_CREDENTIALS = "{}\n"
const INITIAL_DEFAULT_WORKSPACE = `${JSON.stringify({ version: 1, sessions: [] }, null, 2)}\n`

export interface ConfigFilePaths {
  /** `.nicode` 配置根目录。 */
  rootDir: string
  /** 全局普通配置文件。 */
  configPath: string
  /** 与普通配置分离的 Provider 凭据文件。 */
  credentialsPath: string
  /** default 分组的工作区配置文件。 */
  defaultWorkspacePath: string
}

/** V1 Protocol 配置中可传给协议客户端的连接参数。 */
export interface ValidatedProtocolConfig {
  /** 覆盖协议 SDK 默认地址的 Provider URL。 */
  baseURL?: string
  /** 传给协议 SDK 的额外请求头。 */
  defaultHeaders?: Record<string, string>
}

/** Provider 内尚未补入所属 Provider 与协议的 V1 模型配置。 */
export type ValidatedProviderModelConfig = Omit<ModelConfig, "providerId" | "protocol">

/** 已通过 V1 字段与引用检查的 Provider 配置。 */
export interface ValidatedProviderConfig {
  /** Provider 的稳定标识。 */
  id: string
  /** Provider 的显示名称。 */
  name: string
  /** 当前 Provider 配置的协议及各协议连接参数。 */
  protocols: Partial<Record<Protocol, ValidatedProtocolConfig>>
  /** 当前 Provider 下的模型，尚未绑定唯一协议。 */
  models: ValidatedProviderModelConfig[]
}

/** Electron 启动入口消费的已校验 config.json 内容。 */
export interface ValidatedStartupConfig {
  /** V1 持久化结构版本。 */
  version: 1
  /** 按配置顺序保存的 Provider。 */
  providers: ValidatedProviderConfig[]
  /** 可选的默认模型 ID；本次启动构建不消费该字段。 */
  defaultModel?: string
  /** 已校验的 MCP 配置；本次启动构建不消费其内容。 */
  mcpServers: unknown[]
  /** 已校验的全局 Runtime 普通配置。 */
  runtime: { userMessageMode: "insert" | "queue" }
}

/** Electron 启动入口消费的已校验 credentials.json 内容。 */
export interface ValidatedStartupCredentials {
  /** Provider 凭据；初始化器允许该字段在尚未配置凭据时缺省。 */
  providers?: ProviderCredential[]
}

/** 同一次初始化中得到的路径与已校验配置快照。 */
export interface InitializedConfigFilesSnapshot {
  /** 已初始化的固定配置路径。 */
  paths: ConfigFilePaths
  /** 本次读取并通过检查的全局配置。 */
  config: ValidatedStartupConfig
  /** 本次读取并通过检查的 Provider 凭据。 */
  credentials: ValidatedStartupCredentials
}

/** 单个 Turn 创建模型 Adapter 时重新读取的两份配置快照。 */
export interface ModelAdapterConfigSnapshot {
  /** 本次磁盘读取并通过完整 V1 检查的普通配置。 */
  config: ValidatedStartupConfig
  /** 本次磁盘读取并通过 Provider 引用检查的凭据。 */
  credentials: ValidatedStartupCredentials
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
 * 按启动顺序补齐配置目录与文件，并检查三份配置文件的 V1 结构。
 * 已有文件不会被覆盖。
 * 检查失败时由调用方决定如何呈现启动错误。
 *
 * @param userProfile 用户目录；省略时读取当前进程的 USERPROFILE。
 * @returns 已初始化并检查通过的固定配置路径。
 * @throws Error 当用户目录无效、目录或文件无法创建读取，或任一配置未通过 V1 检查时抛出。
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
 * 避免把包含凭据的配置内容扩散到主进程其它边界。
 *
 * @param userProfile 用户目录；省略时读取当前进程的 USERPROFILE。
 * @returns 固定配置路径，以及本次初始化中读取并通过 V1 检查的普通配置与凭据。
 * @throws Error 当用户目录无效、目录或文件无法创建读取，或任一配置未通过 V1 检查时抛出。
 */
export async function initializeConfigFilesSnapshot(
  userProfile: string | undefined = process.env.USERPROFILE,
): Promise<InitializedConfigFilesSnapshot> {
  if (!userProfile || !isAbsolute(userProfile)) {
    throw new Error("USERPROFILE 必须是非空的绝对路径。")
  }

  const rootDir = join(userProfile, ".nicode")
  const configPath = join(rootDir, "config.json")
  const credentialsPath = join(rootDir, "credentials.json")
  const sessionsDir = join(rootDir, "sessions")
  const defaultDir = join(sessionsDir, "default")
  const defaultWorkspacePath = join(defaultDir, "workspace.json")

  await mkdir(rootDir, { recursive: true })
  const config = await ensureJsonObjectFile(configPath, INITIAL_CONFIG)
  const providerIds = checkFile(configPath, () => checkConfig(config))
  const credentials = await ensureJsonObjectFile(credentialsPath, INITIAL_CREDENTIALS)
  checkFile(credentialsPath, () => checkCredentials(credentials, providerIds))

  await mkdir(join(rootDir, "skills"), { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(join(rootDir, "logs"), { recursive: true })

  await mkdir(defaultDir, { recursive: true })
  const workspace = await ensureJsonObjectFile(defaultWorkspacePath, INITIAL_DEFAULT_WORKSPACE)
  checkFile(defaultWorkspacePath, () => checkDefaultWorkspace(workspace))
  await mkdir(join(defaultDir, "workspace"), { recursive: true })

  return {
    paths: { rootDir, configPath, credentialsPath, defaultWorkspacePath },
    config: config as unknown as ValidatedStartupConfig,
    credentials: credentials as unknown as ValidatedStartupCredentials,
  }
}

/**
 * 为一次 Turn 重新读取并校验模型 Adapter 所需的普通配置与凭据。
 *
 * 该入口严格只读，不创建缺失文件，也不读取 default/Project workspace；配置先完成
 * V1 与 Provider 协议检查，随后凭据才按本次 Provider 集合检查引用。
 *
 * @param paths 启动阶段已经确定的 config 与 credentials 固定路径。
 * @returns 属于本次调用、不会跨 Turn 缓存的已校验配置快照。
 * @throws Error 当任一文件缺失、损坏或不符合当前 V1 结构时抛出；错误包含对应路径。
 */
export async function readModelAdapterConfigSnapshot(
  paths: Pick<ConfigFilePaths, "configPath" | "credentialsPath">,
): Promise<ModelAdapterConfigSnapshot> {
  const config = await readJsonObjectFile(paths.configPath)
  const providerIds = checkFile(paths.configPath, () => checkConfig(config))
  const credentials = await readJsonObjectFile(paths.credentialsPath)
  checkFile(paths.credentialsPath, () => checkCredentials(credentials, providerIds))
  return {
    config: config as unknown as ValidatedStartupConfig,
    credentials: credentials as unknown as ValidatedStartupCredentials,
  }
}
