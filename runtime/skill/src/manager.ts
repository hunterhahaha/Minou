/**
 * 管理 Global 与 Project Skill 来源目录。
 *
 * 本模块负责补齐来源、同步 registry、合并启用项并读取 Skill 正文。
 */
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parseDocument } from "yaml"
import { requireProjectId } from "../../session/src/project-id.ts"
import type { SkillScope } from "../../session/src/events.ts"
import { buildSkillContext } from "./context.ts"

/**
 * 一个 Global 或 Project 来源目录中的 Skill 登记信息。
 */
export interface SkillRegistryEntry {
  /**
   * Skill 文件夹名，也是当前来源内的唯一名称。
   */
  name: string
  /**
   * Skill 文件夹的绝对路径。
   */
  path: string
  /**
   * 由 Global 或 Project 来源目录确定的作用域。
   */
  scope: SkillScope
  /**
   * 当前来源配置中的启用状态。
   */
  enabled: boolean
}
/**
 * 每个来源目录持久化的 registry.json 结构。
 */
export interface SkillRegistry {
  /**
   * 当前 registry 结构版本。
   */
  version: 1
  /**
   * 按名称排序、且名称在本来源内唯一的 Skill 登记项。
   */
  skills: SkillRegistryEntry[]
}
/**
 * skill_load 成功时返回的 Skill 名称、来源和完整正文。
 */
export interface SkillLoadResult {
  /**
   * Skill 文件夹名。
   */
  name: string
  /**
   * 包含 frontmatter 的完整 SKILL.md 文本，不受元信息 Token 上限影响。
   */
  content: string
  /**
   * 本次读取的实际来源作用域。
   */
  scope: SkillScope
}

/**
 * 按来源目录串行化启动初始化与 Runtime 同步，避免并发覆盖 registry。
 */
const sourceQueues = new Map<string, Promise<void>>()

/**
 * 在同一来源目录的前序操作完成后运行一次独占操作。
 *
 * @param directory 用于生成队列身份的来源目录。
 * @param action 取得该目录独占执行权后运行的异步操作。
 * @returns 异步操作返回的结果。
 * @throws 操作本身失败时传递其异常；失败不会阻塞后续排队操作。
 */
async function serializeSource<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory)
  const result = (sourceQueues.get(key) ?? Promise.resolve()).then(action)
  const tail = result.then(() => undefined, () => undefined)
  sourceQueues.set(key, tail)
  try { return await result } finally { if (sourceQueues.get(key) === tail) sourceQueues.delete(key) }
}

/**
 * 检查路径指向一个已经存在的普通目录。
 *
 * @param path 要检查的目录绝对路径。
 * @throws 文件系统检查失败或路径不是普通目录时抛出 Error。
 */
async function requireDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Skill 来源父目录不是普通目录：${path}`)
}

/**
 * 补齐来源目录和 registry 文件，但不读取已有 registry 内容。
 *
 * @param directory 来源目录的绝对路径；调用方必须先取得该来源的串行队列。
 * @throws 父目录无效、目录创建失败或 registry 不是普通文件时抛出 Error。
 */
async function ensureSource(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error(`Skill 来源目录必须是绝对路径：${directory}`)
  await requireDirectory(dirname(directory))
  await mkdir(directory, { recursive: true })
  await requireDirectory(directory)
  const path = join(directory, "registry.json")
  try { await writeFile(path, `${JSON.stringify({ version: 1, skills: [] }, null, 2)}\n`, { encoding: "utf8", flag: "wx" }) }
  catch (error) { if (!hasCode(error, "EEXIST")) throw new Error(`无法创建 Skill 配置：${path}`, { cause: error }) }
  if (!(await lstat(path)).isFile()) throw new Error(`Skill 配置不是普通文件：${path}`)
}

/**
 * 执行只检查文件缺失与类型的来源初始化。
 *
 * @param directory 来源目录的绝对路径。
 * @returns 来源目录与 registry 文件补齐后兑现的 Promise。
 * @throws Error 创建失败或路径类型错误；既有 registry 内容不会被读取。
 */
export async function initializeSkillSource(directory: string): Promise<void> {
  await serializeSource(directory, () => ensureSource(directory))
}

/**
 * 校验 registry 的 JSON 结构和当前来源作用域。
 *
 * @param content registry 文件原文。
 * @param scope 由来源目录确定的固定作用域。
 * @returns 有效 registry；内容不合法时返回 undefined，供调用方按实际目录重建。
 */
function parseRegistry(content: string, scope: SkillScope): SkillRegistry | undefined {
  let value: unknown
  try { value = JSON.parse(content) } catch { return undefined }
  if (!isRecord(value) || !exactFields(value, ["version", "skills"]) || value.version !== 1 || !Array.isArray(value.skills)) return undefined
  const skills: SkillRegistryEntry[] = []
  const names = new Set<string>()
  for (const entry of value.skills) {
    if (!isRecord(entry) || !exactFields(entry, ["name", "path", "scope", "enabled"]) ||
        typeof entry.name !== "string" || entry.name.trim() === "" || entry.name === "." || entry.name === ".." || /[/\\]/.test(entry.name) ||
        typeof entry.path !== "string" || !isAbsolute(entry.path) || entry.scope !== scope || typeof entry.enabled !== "boolean" || names.has(entry.name)) return undefined
    names.add(entry.name)
    skills.push({ name: entry.name, path: entry.path, scope, enabled: entry.enabled })
  }
  return { version: 1, skills }
}

/**
 * 扫描直接子目录并同步登记，非法内容整体重建，不检查 SKILL.md。
 *
 * @param directory 来源绝对路径。
 * @param scope 来源固定作用域。
 * @returns 同步后的登记结果。
 * @throws Error 扫描、读取或原子保存失败；I/O 失败保留原配置。
 */
export async function synchronizeSkillSource(directory: string, scope: SkillScope): Promise<SkillRegistry> {
  return serializeSource(directory, async () => {
    try {
      await ensureSource(directory)
      const directories = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
      const path = join(directory, "registry.json")
      const content = await readFile(path, "utf8")
      const old = parseRegistry(content, scope)
      const enabled = new Map(old?.skills.map((entry) => [entry.name, entry.enabled]))
      const registry: SkillRegistry = { version: 1, skills: directories.map(({ name }) => ({ name, path: join(directory, name), scope, enabled: enabled.get(name) ?? true })) }
      const next = `${JSON.stringify(registry, null, 2)}\n`
      if (content !== next) {
        const temporary = `${path}.${randomUUID()}.tmp`
        try { await writeFile(temporary, next, { encoding: "utf8", flag: "wx" }); await rename(temporary, path) }
        finally { await unlink(temporary).catch(() => undefined) }
      }
      return registry
    } catch (error) { throw new Error(`无法同步 Skill 来源：${directory}`, { cause: error }) }
  })
}

/**
 * 只读当前来源 registry，供 skill_load 按实时配置执行权限检查。
 *
 * @param directory 来源目录。
 * @param scope 来源目录决定的固定作用域。
 * @returns 当前登记项；registry 缺失时返回空数组。
 * @throws Error registry 内容损坏、路径越界或文件系统读取失败；本函数不会修复文件。
 */
async function readRegistry(directory: string, scope: SkillScope): Promise<SkillRegistryEntry[]> {
  const path = join(directory, "registry.json")
  let content: string
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Skill 配置不是普通文件：${path}`)
    content = await readFile(path, "utf8")
  } catch (error) { if (hasCode(error, "ENOENT")) return []; throw error }
  const registry = parseRegistry(content, scope)
  if (registry === undefined) throw new Error(`Skill 配置内容无效：${path}`)
  for (const entry of registry.skills) {
    if (resolve(entry.path) !== resolve(directory, entry.name)) throw new Error(`Skill 配置路径与来源不一致：${path} ${entry.name}`)
  }
  return registry.skills
}

/**
 * 读取指定 Skill 文件夹中的完整 SKILL.md。
 *
 * @param directory Skill 文件夹的绝对路径。
 * @param signal 可选的工具调用取消信号。
 * @returns 包含 YAML frontmatter 的 UTF-8 文本。
 * @throws Error 文件缺失、不是普通文件、读取失败或调用被取消时抛出。
 */
async function readDefinition(directory: string, signal?: AbortSignal): Promise<string> {
  const path = join(directory, "SKILL.md")
  try {
    signal?.throwIfAborted()
    if (!(await lstat(path)).isFile()) throw new Error(`SKILL.md 不是普通文件：${path}`)
    return await readFile(path, { encoding: "utf8", signal })
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw Object.assign(new Error(`未找到 Skill 文件：${path}`, { cause: error }), { code: "SKILL_NOT_FOUND" })
    throw new Error(`无法读取 Skill 文件：${path}`, { cause: error })
  }
}

/**
 * 从 SKILL.md 的 YAML frontmatter 中读取元信息描述。
 *
 * @param content SKILL.md 完整原文。
 * @param path 用于错误信息的 SKILL.md 绝对路径。
 * @returns frontmatter 中非空的 description 字符串。
 * @throws Error frontmatter 缺失、YAML 无效或 description 不是非空字符串时抛出。
 */
function readDescription(content: string, path: string): string {
  const match = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/.exec(content)
  if (match === null) throw new Error(`SKILL.md 缺少 YAML frontmatter：${path}`)
  const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) throw new Error(`SKILL.md YAML 无效：${path}`)
  const value: unknown = document.toJS()
  if (!isRecord(value) || typeof value.description !== "string" || value.description.trim() === "") throw new Error(`SKILL.md description 必须是非空字符串：${path}`)
  return value.description
}

/**
 * 提供共享的 Skill 来源管理能力；Session 的载入历史由各自 SessionState 保存。
 */
export class SkillManager {
  /**
   * 已规范化的 `.nicode` 绝对路径。
   */
  private readonly rootDirectory: string
  /**
   * 用于限制单条 Skill 元信息的本地 Token 估算器。
   */
  private readonly estimate: (text: string) => number

  /**
   * 创建共享来源管理器；构造过程只保存依赖，不访问磁盘。
   *
   * @param rootDirectory `.nicode` 根目录的绝对路径。
   * @param estimate 现有的本地 Token 估算器。
   * @throws Error 根目录不是绝对路径时抛出。
   */
  constructor(rootDirectory: string, estimate: (text: string) => number) {
    if (!isAbsolute(rootDirectory)) throw new Error(`Skill 根目录必须是绝对路径：${rootDirectory}`)
    this.rootDirectory = resolve(rootDirectory)
    this.estimate = estimate
  }

  /**
   * 同步当前来源并构建启用 Skill 的 Session 固定上下文基线。
   *
   * @param projectId 当前 Project UUID 或 default。
   * @returns 含来源记录、截断描述与模型可见内容的完整 Skill 基线。
   * @throws Error 来源同步失败，或有效 Skill 的文件与 description 无效时抛出。
   */
  async resolveSkills(projectId: string) {
    const sources = this.sources(projectId)
    await Promise.all(sources.map(({ directory }) => initializeSkillSource(directory)))
    const registries = await Promise.all(sources.map(({ directory, scope }) => synchronizeSkillSource(directory, scope)))
    const effective = new Map<string, SkillRegistryEntry>()
    for (const registry of registries) for (const entry of registry.skills) effective.set(entry.name, entry)
    const skills = await Promise.all([...effective.values()].filter((entry) => entry.enabled).map(async (entry) => ({
      ...entry, description: readDescription(await readDefinition(entry.path), join(entry.path, "SKILL.md")),
    })))
    return buildSkillContext(skills, this.estimate)
  }

  /**
   * 按执行当下配置检查启用状态，再读取完整正文；不写 registry。
   *
   * @param projectId 可信 Project UUID 或 default。
   * @param name 完整文件夹名，仅用于查表，不直接拼接路径。
   * @param signal 当前调用取消信号。
   * @returns 完整文件内容和实际来源。
   * @throws Error 未找到、禁用、配置或文件错误、取消；业务错误带稳定 code。
   */
  async loadSkill(projectId: string, name: string, signal?: AbortSignal): Promise<SkillLoadResult> {
    signal?.throwIfAborted()
    const registries = await Promise.all(this.sources(projectId).map(({ directory, scope }) => readRegistry(directory, scope)))
    const effective = new Map<string, SkillRegistryEntry>()
    for (const entries of registries) for (const entry of entries) effective.set(entry.name, entry)
    const skill = effective.get(name)
    if (skill === undefined) throw Object.assign(new Error(`未找到 Skill：${name}`), { code: "SKILL_NOT_FOUND" })
    if (!skill.enabled) throw Object.assign(new Error(`Skill 已禁用：${name}`), { code: "SKILL_DISABLED" })
    return { name: skill.name, scope: skill.scope, content: await readDefinition(skill.path, signal) }
  }

  /**
   * 按固定顺序生成当前对话可使用的来源目录。
   *
   * @param projectId 当前 Project UUID 或 default。
   * @returns Global 来源，以及非 default 对话对应的 Project 来源。
   * @throws TypeError Project 身份无效时由身份校验器抛出。
   */
  private sources(projectId: string): Array<{ directory: string; scope: SkillScope }> {
    requireProjectId(projectId)
    const sources: Array<{ directory: string; scope: SkillScope }> = [{ directory: join(this.rootDirectory, "skills"), scope: "global" }]
    if (projectId !== "default") sources.push({ directory: join(this.rootDirectory, "sessions", projectId, "skills"), scope: "project" })
    return sources
  }
}

/**
 * 判断值是否为非数组的 JSON 对象。
 *
 * @param value 尚未校验的 JSON 值。
 * @returns 值为非 null 对象且不是数组时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
/**
 * 检查对象的字段集合是否与预期完全一致。
 *
 * @param value 待校验的 JSON 对象。
 * @param fields 允许且必须出现的字段名称。
 * @returns 没有缺少或额外字段时返回 true。
 */
function exactFields(value: Record<string, unknown>, fields: string[]): boolean { return Object.keys(value).length === fields.length && fields.every((field) => field in value) }
/**
 * 判断异常是否携带指定错误码。
 *
 * @param error 待检查的未知异常。
 * @param code 要匹配的文件系统错误码。
 * @returns 异常对象的 `code` 字段与目标值相同时返回 true。
 */
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code }
