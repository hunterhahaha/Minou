/**
 * 启动配置文件的初始化与 V1 结构检查。
 *
 * 架构依据：开发备忘录第 2–4 节，以及配置与凭据、工作区配置文件结构 V1。
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
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
  rootDir: string
  configPath: string
  credentialsPath: string
  defaultWorkspacePath: string
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
 */
export async function initializeConfigFiles(
  userProfile: string | undefined = process.env.USERPROFILE,
): Promise<ConfigFilePaths> {
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

  return { rootDir, configPath, credentialsPath, defaultWorkspacePath }
}
