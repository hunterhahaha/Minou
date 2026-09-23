/**
 * Project 工作区数据库、AGENTS.md 与 Skill 固定上下文的实现。
 *
 * 工作区数据库在同步 Runtime 构造边界读取；可能随 Turn 变化的 AGENTS.md 与 Skill
 * 内容由异步 baseline 函数重新读取。MCP Runtime 尚未实现，因此当前基线明确返回空 MCP 列表。
 */

import { createHash } from "node:crypto"
import {
  lstatSync,
} from "node:fs"
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { parseDocument } from "yaml"

import type { SkillScope } from "../../runtime/session/src/events.ts"
import type {
  CurrentSessionBaseline,
  SessionSkillContextEntry,
} from "../../runtime/session/src/session-state.ts"
import { readProjectWorkspace } from "./workspace-store.ts"
import type { ProjectWorkspace } from "./workspace-store.ts"
import type {
  ResolveSessionRuntimeProjectContext,
  SessionRuntimeProjectContext,
} from "./index.ts"

/** Project Context resolver 的固定进程级输入。 */
export interface ProjectContextResolverOptions {
  /** 已初始化的 `.nicode` 绝对目录。 */
  rootDirectory: string
  /** Skill description 的本地 Token 粗估函数。 */
  estimateSkillTokens(description: string): number
}

/** 一个 `registry.json` 中已经通过检查的引用。 */
interface SkillRegistryEntry {
  name: string
  scope: SkillScope
  enabled: boolean
}

/** 从一个 `SKILL.md` YAML frontmatter 读取的事实。 */
interface SkillDefinition {
  /** Skill 唯一身份；目录名不参与身份判断。 */
  name: string
  description: string
  /** YAML frontmatter 之后的完整正文。 */
  content: string
  /** 当前 Skill 文件的绝对路径，用于错误定位和后续 skill_load 接线。 */
  filePath: string
}

/** 一个来源目录中由 registry 和 YAML 定义共同解析出的 Skill。 */
interface RegisteredSkill extends SkillDefinition {
  scope: SkillScope
  enabled: boolean
}

/** Skill registry 的 V1 JSON 顶层结构。 */
interface SkillRegistry {
  version: 1
  skills: SkillRegistryEntry[]
}

/**
 * 创建按数字 Project ID 解析真实文件系统上下文的同步工厂。
 *
 * @param options `.nicode` 根目录与共享 Token 估算器。
 * @returns 可直接传给 `ElectronStartupOptions.sessionRuntime.resolveProjectContext` 的函数。
 * @throws Error 当根目录不是绝对路径时立即抛出；具体 Project 错误在解析该 ID 时抛出。
 */
export function createProjectContextResolver(
  options: ProjectContextResolverOptions,
): ResolveSessionRuntimeProjectContext {
  if (!isAbsolute(options.rootDirectory)) {
    throw new Error(`Project Context 根目录必须是绝对路径：${options.rootDirectory}`)
  }

  return (projectId) => resolveProjectContext(options, projectId)
}

/**
 * 同步读取一个 Project 的身份和路径，并建立其异步 baseline 来源。
 *
 * @param options `.nicode` 根目录与共享 Token 估算器。
 * @param projectId IPC 已校验的非负安全整数 Project ID。
 * @returns 当前 Project 的模型可见工作区信息与 baseline 解析函数。
 * @throws Error 当 Project 目录或 workspace 目录不可用，或数据库中缺少对应项目配置时抛出。
 */
function resolveProjectContext(
  options: ProjectContextResolverOptions,
  projectId: number,
): SessionRuntimeProjectContext {
  if (!Number.isSafeInteger(projectId) || projectId < 0) {
    throw new Error(`Project ID 必须是非负安全整数：${projectId}`)
  }

  const projectDirectory = join(options.rootDirectory, "sessions", String(projectId))
  const workspaceDirectory = join(projectDirectory, "workspace")
  requireDirectorySync(projectDirectory, "Project 配置目录")
  requireDirectorySync(workspaceDirectory, "Project workspace 目录")
  const workspace = readProjectWorkspace(join(options.rootDirectory, "workspace.sqlite"), projectId)
  const cwd = workspace.directories[0] ?? workspaceDirectory
  const allowedRoots = workspace.directories.length > 0
    ? [...workspace.directories]
    : [workspaceDirectory]
  const agentsMdPath = join(cwd, "AGENTS.md")

  return {
    workspaceInfo: formatWorkspaceInfo(
      workspace,
      projectDirectory,
      workspaceDirectory,
      cwd,
      allowedRoots,
    ),
    resolveCurrentBaseline: async () => {
      const [agentsContent, skills] = await Promise.all([
        readOptionalTextFile(agentsMdPath, "AGENTS.md"),
        resolveEffectiveSkills(
          options.rootDirectory,
          projectDirectory,
          options.estimateSkillTokens,
        ),
      ])
      return {
        agentsmd: {
          path: agentsMdPath,
          hash: hashText(agentsContent),
          content: agentsContent,
        },
        skills,
        mcp: [],
      }
    },
  }
}

/**
 * 生成 ContextBuilder 放入 System Message 的 Project Workspace Info。
 *
 * @param workspace 从数据库读取的 Project 配置。
 * @param projectDirectory Project 分组目录。
 * @param workspaceDirectory Project 内置工作目录。
 * @param cwd 当前默认工作目录。
 * @param allowedRoots 当前明确允许的根目录。
 * @returns 带稳定字段名的 JSON 文本块。
 */
function formatWorkspaceInfo(
  workspace: ProjectWorkspace,
  projectDirectory: string,
  workspaceDirectory: string,
  cwd: string,
  allowedRoots: readonly string[],
): string {
  return `<workspace_info>\n${JSON.stringify({
    projectId: workspace.id,
    projectName: workspace.name,
    projectDirectory,
    workspaceDirectory,
    directories: workspace.directories,
    cwd,
    allowedRoots,
  }, null, 2)}\n</workspace_info>`
}

/**
 * 读取、合并并格式化 Global 与 Project Skill。
 *
 * Project 中同 YAML `name` 的 registry 项覆盖 Global 项，包括以 disabled 状态屏蔽 Global Skill。
 * 目录名不参与身份判断；registry 的 name 只引用扫描得到的 YAML name。
 *
 * @param rootDirectory `.nicode` 根目录。
 * @param projectDirectory 当前 Project 分组目录。
 * @param estimateSkillTokens Skill description 的本地估算器。
 * @returns 当前实际启用 Skill 的模型可见内容、比较条目和 description 映射。
 * @throws Error 当 registry、目录、SKILL.md 或 YAML frontmatter 无效时抛出。
 */
async function resolveEffectiveSkills(
  rootDirectory: string,
  projectDirectory: string,
  estimateSkillTokens: (description: string) => number,
): Promise<CurrentSessionBaseline["skills"]> {
  const [globalSkills, projectSkills] = await Promise.all([
    readSkillSource(join(rootDirectory, "skills"), "global"),
    readSkillSource(join(projectDirectory, "skills"), "project"),
  ])
  const effective = new Map<string, RegisteredSkill>()
  for (const skill of globalSkills) effective.set(skill.name, skill)
  for (const skill of projectSkills) effective.set(skill.name, skill)
  const enabled = [...effective.values()].filter((skill) => skill.enabled)

  const entries: SessionSkillContextEntry[] = enabled.map((skill) => {
    const estimatedTokens = estimateSkillTokens(skill.description)
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) {
      throw new Error(`Skill ${skill.name} 的 estimatedTokens 必须是非负安全整数。`)
    }
    return {
      name: skill.name,
      scope: skill.scope,
      enabled: true,
      estimatedTokens,
    }
  })
  const descriptions = Object.fromEntries(
    enabled.map((skill) => [skill.name, skill.description]),
  )

  return {
    content: enabled.length === 0
      ? ""
      : `<skills>\n${JSON.stringify(enabled.map((skill) => ({
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
      })), null, 2)}\n</skills>`,
    entries,
    descriptions,
  }
}

/**
 * 读取一个 Global 或 Project Skill 来源目录。
 *
 * 缺失 registry 表示该来源当前没有登记 Skill。registry 存在时扫描全部直接子目录，
 * 每个目录必须包含普通文件 `SKILL.md`，且 YAML name 在该来源内必须唯一。
 *
 * @param sourceDirectory 包含 registry 和 Skill 子目录的来源目录。
 * @param scope 该目录由路径决定的固定作用域。
 * @returns 按 registry 顺序解析出的 Skill。
 * @throws Error 当 registry 或被扫描到的 Skill 结构无效时抛出。
 */
async function readSkillSource(
  sourceDirectory: string,
  scope: SkillScope,
): Promise<RegisteredSkill[]> {
  const registryPath = join(sourceDirectory, "registry.json")
  const registryKind = await pathKind(registryPath)
  if (registryKind === "missing") return []
  if (registryKind !== "file") {
    throw new Error(`Skill registry 不是普通文件：${registryPath}`)
  }
  const registry = checkSkillRegistry(
    await readRequiredJsonObject(registryPath, "Skill registry"),
    registryPath,
    scope,
  )
  const definitions = new Map<string, SkillDefinition>()
  let directoryEntries
  try {
    directoryEntries = await readdir(sourceDirectory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`无法读取 Skill 目录：${sourceDirectory}`, { cause: error })
  }

  for (const directory of directoryEntries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const skillPath = join(sourceDirectory, directory.name, "SKILL.md")
    const definition = await readSkillDefinition(skillPath)
    const duplicate = definitions.get(definition.name)
    if (duplicate !== undefined) {
      throw new Error(
        `Skill YAML name 重复：${definition.name}（${duplicate.filePath}、${definition.filePath}）`,
      )
    }
    definitions.set(definition.name, definition)
  }

  return registry.skills.map((entry) => {
    const definition = definitions.get(entry.name)
    if (definition === undefined) {
      throw new Error(
        `Skill registry 引用的 YAML name 不存在：${entry.name}（${registryPath}）`,
      )
    }
    return { ...definition, scope: entry.scope, enabled: entry.enabled }
  })
}

/**
 * 检查一个 Skill registry 的 V1 字段、作用域和名称唯一性。
 *
 * @param value 未检查的 JSON 顶层对象。
 * @param registryPath 错误中使用的绝对文件路径。
 * @param expectedScope 由来源目录决定、不能由文件改变的作用域。
 * @returns 已检查的 registry。
 * @throws Error 当存在未知字段、无效条目、作用域错配或重复引用时抛出。
 */
function checkSkillRegistry(
  value: Record<string, unknown>,
  registryPath: string,
  expectedScope: SkillScope,
): SkillRegistry {
  requireExactFields(value, ["version", "skills"], "Skill registry", registryPath)
  if (value.version !== 1) {
    throw new Error(`Skill registry.version 必须是 1：${registryPath}`)
  }
  if (!Array.isArray(value.skills)) {
    throw new Error(`Skill registry.skills 必须是数组：${registryPath}`)
  }

  const names = new Set<string>()
  const skills = value.skills.map((rawEntry, index): SkillRegistryEntry => {
    if (!isRecord(rawEntry)) {
      throw new Error(`Skill registry.skills[${index}] 必须是对象：${registryPath}`)
    }
    requireExactFields(
      rawEntry,
      ["name", "scope", "enabled"],
      `Skill registry.skills[${index}]`,
      registryPath,
    )
    if (typeof rawEntry.name !== "string" || rawEntry.name.trim() === "") {
      throw new Error(`Skill registry.skills[${index}].name 必须是非空字符串：${registryPath}`)
    }
    if (rawEntry.scope !== expectedScope) {
      throw new Error(
        `Skill registry.skills[${index}].scope 必须是 ${expectedScope}：${registryPath}`,
      )
    }
    if (typeof rawEntry.enabled !== "boolean") {
      throw new Error(`Skill registry.skills[${index}].enabled 必须是布尔值：${registryPath}`)
    }
    if (names.has(rawEntry.name)) {
      throw new Error(`Skill registry name 重复：${rawEntry.name}（${registryPath}）`)
    }
    names.add(rawEntry.name)
    return {
      name: rawEntry.name,
      scope: expectedScope,
      enabled: rawEntry.enabled,
    }
  })
  return { version: 1, skills }
}

/**
 * 读取一个目录中的 `SKILL.md` 并解析 YAML frontmatter。
 *
 * @param filePath `SKILL.md` 的绝对路径。
 * @returns 以 YAML name 为身份的 Skill 定义及正文。
 * @throws Error 当文件缺失、不是普通文件、frontmatter 或必需字段无效时抛出。
 */
async function readSkillDefinition(filePath: string): Promise<SkillDefinition> {
  const kind = await pathKind(filePath)
  if (kind !== "file") {
    throw new Error(kind === "missing"
      ? `Skill 目录缺少 SKILL.md：${filePath}`
      : `SKILL.md 不是普通文件：${filePath}`)
  }
  const fileContent = await readTextFile(filePath, "SKILL.md")
  const match = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)([\s\S]*)$/.exec(fileContent)
  if (match === null) {
    throw new Error(`SKILL.md 必须以 --- 包围的 YAML frontmatter 开头：${filePath}`)
  }

  const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(
      `SKILL.md YAML 解析失败：${filePath} ${document.errors.map((error) => error.message).join("；")}`,
    )
  }
  const frontmatter: unknown = document.toJS()
  if (!isRecord(frontmatter)) {
    throw new Error(`SKILL.md YAML 顶层必须是对象：${filePath}`)
  }
  if (typeof frontmatter.name !== "string" || frontmatter.name.trim() === "") {
    throw new Error(`SKILL.md YAML name 必须是非空字符串：${filePath}`)
  }
  if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") {
    throw new Error(`SKILL.md YAML description 必须是非空字符串：${filePath}`)
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    content: match[2],
    filePath,
  }
}

/** @returns 输入文本的 SHA-256 十六进制摘要。 */
function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * 同步要求路径为目录。
 *
 * @param path 要检查的绝对路径。
 * @param label 错误中的路径职责。
 * @throws Error 当路径缺失、无法检查或不是目录时抛出。
 */
function requireDirectorySync(path: string, label: string): void {
  let state
  try {
    state = lstatSync(path)
  } catch (error) {
    throw new Error(`无法检查${label}：${path}`, { cause: error })
  }
  if (!state.isDirectory()) throw new Error(`${label}不是目录：${path}`)
}

/** 异步读取必需的 JSON 对象。 */
async function readRequiredJsonObject(
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  return parseJsonObject(await readTextFile(filePath, label), filePath, label)
}

/** 解析 JSON 并要求顶层为普通对象。 */
function parseJsonObject(
  content: string,
  filePath: string,
  label: string,
): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${filePath}`, { cause: error })
  }
  if (!isRecord(value)) throw new Error(`${label}的 JSON 顶层必须是对象：${filePath}`)
  return value
}

/** 读取普通文本文件，并在错误中保留绝对路径。 */
async function readTextFile(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    throw new Error(`无法读取${label}：${filePath}`, { cause: error })
  }
}

/** 缺失时返回空文本，其它文件类型和读取错误继续失败。 */
async function readOptionalTextFile(filePath: string, label: string): Promise<string> {
  const kind = await pathKind(filePath)
  if (kind === "missing") return ""
  if (kind !== "file") throw new Error(`${label}不是普通文件：${filePath}`)
  return readTextFile(filePath, label)
}

/** @returns 路径当前类型；只有 ENOENT 被解释为缺失。 */
async function pathKind(path: string): Promise<"missing" | "file" | "directory" | "other"> {
  let state
  try {
    state = await lstat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing"
    throw new Error(`无法检查路径：${path}`, { cause: error })
  }
  if (state.isFile()) return "file"
  if (state.isDirectory()) return "directory"
  return "other"
}

/** 检查对象是否为可按字段读取的普通 JSON/YAML 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 拒绝配置对象中的未知字段。
 *
 * @param value 要检查的对象。
 * @param allowed 允许的字段集合。
 * @param field 错误中的对象位置。
 * @param filePath 错误中的配置路径。
 * @throws Error 当对象包含 V1 未定义字段时抛出。
 */
function requireExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  filePath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${field}.${key} 不是 V1 字段：${filePath}`)
    }
  }
}

/** 判断未知异常是否携带 Node 文件系统错误码。 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
