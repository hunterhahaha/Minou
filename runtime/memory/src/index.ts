/** Project/default 的 Markdown 长期记忆存储；不负责工具注册、render 或 Session 事件。 */
import { randomUUID } from "node:crypto"
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { requireProjectId } from "../../session/src/project-id.ts"

/** 一级分类及其二级分类索引，不包含记忆正文。 */
export interface MemorySectionIndex {
  /** 一级分类原文。 */
  level1: string
  /** 按文件顺序排列的二级分类。 */
  level2: string[]
}
/** memory_list 的成功数据。 */
export interface MemoryListResult {
  /** 保留标题从属关系的分类索引。 */
  sections: MemorySectionIndex[]
}
/** 一个持久化记忆条目。 */
export interface MemoryEntry {
  /** ISO 创建时间，读取时保留文件中的时区表示。 */
  createdAt: string
  /** 包含自身换行的记忆正文。 */
  content: string
}
/** memory_read 返回的一个二级分类。 */
export interface MemoryReadSection {
  /** 一级分类名称。 */
  level1: string
  /** 二级分类名称。 */
  level2: string
  /** 按创建时间从新到旧排列的记录。 */
  memories: MemoryEntry[]
  /** limit 是否省略了该分类中的记录。 */
  truncated: boolean
}
/** memory_read 的成功数据。 */
export interface MemoryReadResult {
  /** 按请求顺序排列的分类，缺失分类保留空结果。 */
  sections: MemoryReadSection[]
}
/** 尚未由 Runtime 分配创建时间的新增记忆。 */
export interface NewMemory {
  /** 目标一级分类。 */
  level1: string
  /** 目标二级分类。 */
  level2: string
  /** 非空正文，结构标记只能出现在闭合的代码围栏中。 */
  content: string
}
/** 已提交位置与 Runtime 生成的时间，不重复正文。 */
export interface WrittenMemory {
  /** 已写入的一级分类。 */
  level1: string
  /** 已写入的二级分类。 */
  level2: string
  /** 毫秒精度的 UTC ISO 时间。 */
  createdAt: string
}
/** memory_write 的整批成功数据。 */
export interface MemoryWriteResult {
  /** 按输入顺序排列的已提交条目。 */
  memories: WrittenMemory[]
}
/** 解析后的一级分类，数组顺序就是文件顺序。 */
interface MemoryCategory {
  /** 一级分类原文。 */
  level1: string
  /** 该分类所属的二级分类及追加顺序中的记录。 */
  sections: { level2: string; memories: MemoryEntry[] }[]
}
/** 当前未闭合的 Markdown 代码围栏。 */
interface Fence {
  /** 反引号或波浪号。 */
  marker: string
  /** 开始围栏的长度。 */
  length: number
}
const HEADING = /^ {0,3}(#{1,2})[ \t](.*)$/
const TIMESTAMP_LINE = /^ {0,3}<(\d{4}-\d{2}-\d{2}T[^<>]*)>[ \t]*$/

/**
 * 校验分类名称，不做 trim 或大小写归一化。
 * @param title 一级或二级分类。
 * @throws Error 空名称、换行或控制字符产生 INVALID_TOOL_ARGUMENTS。
 */
export function validateMemoryTitle(title: unknown): asserts title is string {
  if (typeof title !== "string" || title.trim().length === 0 || /[\x00-\x1f\x7f\u2028\u2029]/.test(title)) {
    throw memoryError("INVALID_TOOL_ARGUMENTS", "记忆分类必须是非空单行字符串")
  }
}

/**
 * 检查正文结构冲突，代码围栏内的结构标记按正文处理。
 * @param content 待追加的非空、多行正文。
 * @throws Error 空正文、围栏外结构标记或未闭合围栏产生 INVALID_TOOL_ARGUMENTS。
 */
export function validateMemoryContent(content: unknown): asserts content is string {
  if (typeof content !== "string" || content.trim().length === 0) throw memoryError("INVALID_TOOL_ARGUMENTS", "记忆正文必须包含非空内容")
  let fence: Fence | undefined
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence === undefined && (HEADING.test(line) || TIMESTAMP_LINE.test(line))) {
      throw memoryError("INVALID_TOOL_ARGUMENTS", "记忆正文包含分类标题或记录时间标记，请改写或放入代码块")
    }
    fence = updateFence(line, fence)
  }
  if (fence !== undefined) throw memoryError("INVALID_TOOL_ARGUMENTS", "记忆正文的代码围栏必须闭合")
}

/** 应用启动时创建一次；持有分组写队列，每次访问重读磁盘，不缓存正文。 */
export class MemoryManager {
  private readonly rootDirectory: string
  private readonly now: () => Date
  private readonly writeTails = new Map<string, Promise<void>>()

  /**
   * 绑定根目录，不创建目录或记忆文件。
   * @param rootDirectory `.minou` 的绝对路径。
   * @param now 每条新增记忆的时钟，默认当前时间；测试可传固定时钟。
   * @throws Error 根目录不是绝对路径。
   */
  constructor(rootDirectory: string, now: () => Date = () => new Date()) {
    if (!isAbsolute(rootDirectory)) throw memoryError("MEMORY_ROOT_INVALID", "Memory 根目录必须是绝对路径")
    this.rootDirectory = resolve(rootDirectory)
    this.now = now
  }

  /**
   * 只读取分类索引，缺失文件视为空记忆。
   * @param projectId Runtime 提供的 Project UUID 或 default。
   * @param signal 当前调用的取消信号。
   * @returns 保留文件顺序和从属关系的索引。
   * @throws Error 身份、目录、格式、I/O 无效或已取消；调用方转为工具错误。
   */
  async list(projectId: string, signal?: AbortSignal): Promise<MemoryListResult> {
    const document = await this.load(projectId, signal)
    return { sections: document.map((category) => ({ level1: category.level1, level2: category.sections.map((section) => section.level2) })) }
  }

  /**
   * 按二级分类读取，每个分类独立排序和限制条数。
   * @param projectId 当前 Project UUID 或 default。
   * @param sections 分类请求；空 level2 不隐式选择整个一级分类。
   * @param limitPerSection 正安全整数，省略则读取全部。
   * @param signal 当前调用的取消信号。
   * @returns 按请求顺序排列的结果，缺失分类返回空记录。
   * @throws Error 参数、存储或格式无效，或已取消；调用方转为工具错误。
   */
  async read(projectId: string, sections: MemorySectionIndex[], limitPerSection?: number, signal?: AbortSignal): Promise<MemoryReadResult> {
    for (const section of sections) {
      validateMemoryTitle(section.level1)
      for (const title of section.level2) validateMemoryTitle(title)
    }
    if (limitPerSection !== undefined && (!Number.isSafeInteger(limitPerSection) || limitPerSection <= 0)) throw memoryError("INVALID_TOOL_ARGUMENTS", "limitPerSection 必须是正安全整数")
    const document = await this.load(projectId, signal)
    const result: MemoryReadSection[] = []
    for (const requested of sections) {
      const category = document.find((item) => item.level1 === requested.level1)
      for (const level2 of requested.level2) {
        const entries = category?.sections.find((section) => section.level2 === level2)?.memories ?? []
        const sorted = entries.map((entry, index) => ({ entry, index }))
          .sort((left, right) => Date.parse(right.entry.createdAt) - Date.parse(left.entry.createdAt) || right.index - left.index)
        const selected = limitPerSection === undefined ? sorted : sorted.slice(0, limitPerSection)
        result.push({ level1: requested.level1, level2, memories: selected.map(({ entry }) => ({ ...entry })), truncated: selected.length < entries.length })
      }
    }
    return { sections: result }
  }

  /**
   * 先校验整批，再按 Project 串行重读和一次替换文件，失败不提交半批。
   * @param projectId Runtime 提供的分组身份。
   * @param memories 新记忆；空数组不创建文件，相同内容分别追加。
   * @param signal 提交前可取消，替换成功后返回成功。
   * @returns 已提交位置及时间，不包含正文。
   * @throws Error 参数、存储、时钟无效或提交前取消；调用方转为工具错误。
   */
  async write(projectId: string, memories: NewMemory[], signal?: AbortSignal): Promise<MemoryWriteResult> {
    const id = requireProjectId(projectId)
    const additions = memories.map((memory) => {
      validateMemoryTitle(memory.level1)
      validateMemoryTitle(memory.level2)
      validateMemoryContent(memory.content)
      return { ...memory, content: memory.content.replace(/\r\n?/g, "\n") }
    })
    const previous = this.writeTails.get(id) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const document = await this.load(id, signal)
      if (additions.length === 0) return { memories: [] }
      const written: WrittenMemory[] = []
      for (const memory of additions) {
        let category = document.find((item) => item.level1 === memory.level1)
        if (category === undefined) { category = { level1: memory.level1, sections: [] }; document.push(category) }
        let section = category.sections.find((item) => item.level2 === memory.level2)
        if (section === undefined) { section = { level2: memory.level2, memories: [] }; category.sections.push(section) }
        const createdAt = this.now().toISOString()
        section.memories.push({ createdAt, content: memory.content })
        written.push({ level1: memory.level1, level2: memory.level2, createdAt })
      }
      const path = this.memoryPath(id)
      const temporary = join(this.rootDirectory, "sessions", id, `.memory.${randomUUID()}.tmp`)
      try {
        checkCancelled(signal)
        await writeFile(temporary, serializeMemory(document), { encoding: "utf8", flag: "wx" })
        await requireFileOrMissing(path)
        checkCancelled(signal)
        await rename(temporary, path)
      } catch (error) {
        throw memoryError(signal?.aborted ? "CANCELLED" : "MEMORY_WRITE_FAILED", `无法提交长期记忆：${path}`, error)
      } finally { await unlink(temporary).catch(() => {}) }
      return { memories: written }
    })
    const tail = operation.then(() => {}, () => {})
    this.writeTails.set(id, tail)
    try { return await operation }
    finally { if (this.writeTails.get(id) === tail) this.writeTails.delete(id) }
  }

  /** @param projectId 已检查的分组身份。 @returns 固定分组内的文件路径。 */
  private memoryPath(projectId: string): string { return join(this.rootDirectory, "sessions", projectId, "memory.md") }

  /**
   * 检查分组和普通文件后重读；仅文件 ENOENT 作为空记忆。
   * @param projectId 当前分组身份。
   * @param signal 调用取消信号。
   * @returns 完整解析结果，不创建文件或目录。
   * @throws Error 存储或格式错误包含路径，取消使用 CANCELLED。
   */
  private async load(projectId: string, signal?: AbortSignal): Promise<MemoryCategory[]> {
    const id = requireProjectId(projectId)
    const path = this.memoryPath(id)
    checkCancelled(signal)
    const directory = join(this.rootDirectory, "sessions", id)
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error("分组不是普通目录")
    } catch (error) { throw memoryError("MEMORY_PROJECT_UNAVAILABLE", `记忆所属分组目录不可用：${directory}`, error) }
    try {
      if (!await requireFileOrMissing(path)) { checkCancelled(signal); return [] }
      const text = await readFile(path, { encoding: "utf8", signal })
      checkCancelled(signal)
      return parseMemory(text, path)
    } catch (error) {
      if (signal?.aborted) throw memoryError("CANCELLED", "记忆工具调用已取消")
      if (error instanceof Error && "code" in error && String(error.code).startsWith("MEMORY_")) throw error
      throw memoryError("MEMORY_READ_FAILED", `无法读取长期记忆：${path}`, error)
    }
  }
}

/** @param line 当前正文行。 @param current 已打开的围栏。 @returns 处理当前行后的围栏状态。 */
function updateFence(line: string, current: Fence | undefined): Fence | undefined {
  const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (marker === null) return current
  if (current !== undefined) return marker[1][0] === current.marker && marker[1].length >= current.length && marker[2].trim() === "" ? undefined : current
  if (marker[1][0] === "`" && marker[2].includes("`")) return undefined
  return { marker: marker[1][0], length: marker[1].length }
}

/**
 * 解析固定标题/时间结构，不忽略未知结构或重复分类。
 * @param text 文件全文。
 * @param path 格式错误说明使用的文件路径。
 * @returns 按文件顺序排列的分类与记录。
 * @throws Error 结构、时间、正文或围栏无效时抛出 MEMORY_FORMAT_INVALID。
 */
function parseMemory(text: string, path: string): MemoryCategory[] {
  const categories: MemoryCategory[] = []
  let category: MemoryCategory | undefined
  let section: MemoryCategory["sections"][number] | undefined
  let createdAt: string | undefined
  let body: string[] = []
  let fence: Fence | undefined
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  if (lines.at(-1) === "") lines.pop()
  /** @param separator 是否移除结构间的一个空分隔行。 @throws Error 记录缺少正文。 */
  const finishEntry = (separator: boolean): void => {
    if (createdAt === undefined) return
    if (separator && body.at(-1) === "") body.pop()
    const content = body.join("\n")
    if (content.trim().length === 0 || section === undefined) throw memoryError("MEMORY_FORMAT_INVALID", `长期记忆记录缺少正文：${path}`)
    section.memories.push({ createdAt, content })
    createdAt = undefined
    body = []
  }
  for (const [index, line] of lines.entries()) {
    const heading = fence === undefined ? HEADING.exec(line) : null
    const timestamp = fence === undefined ? TIMESTAMP_LINE.exec(line) : null
    if (heading !== null || timestamp !== null) {
      finishEntry(true)
      if (heading !== null) {
        try { validateMemoryTitle(heading[2]) }
        catch { throw memoryError("MEMORY_FORMAT_INVALID", `长期记忆分类标题无效：${path}（第 ${index + 1} 行）`) }
        if (heading[1] === "#") {
          if (categories.some((item) => item.level1 === heading[2])) throw memoryError("MEMORY_FORMAT_INVALID", `长期记忆一级分类重复：${path}`)
          category = { level1: heading[2], sections: [] }; categories.push(category); section = undefined
        } else {
          if (category === undefined || category.sections.some((item) => item.level2 === heading[2])) throw memoryError("MEMORY_FORMAT_INVALID", `长期记忆二级分类缺少父分类或重复：${path}`)
          section = { level2: heading[2], memories: [] }; category.sections.push(section)
        }
      } else if (timestamp !== null) {
        if (section === undefined || !isIsoTime(timestamp[1])) throw memoryError("MEMORY_FORMAT_INVALID", `长期记忆时间或所属分类无效：${path}（第 ${index + 1} 行）`)
        createdAt = timestamp[1]
      }
    } else if (createdAt !== undefined) { body.push(line); fence = updateFence(line, fence) }
    else if (line.trim() !== "") throw memoryError("MEMORY_FORMAT_INVALID", `长期记忆结构无效：${path}（第 ${index + 1} 行）`)
  }
  if (fence !== undefined) throw memoryError("MEMORY_FORMAT_INVALID", `长期记忆代码围栏未闭合：${path}`)
  finishEntry(false)
  return categories
}

/** @param value 文件中的 ISO 时间。 @returns 是否具有有效日期、秒精度及明确时区。 */
function isIsoTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (match === null || !Number.isFinite(Date.parse(value))) return false
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`)
  return date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3])
}

/** @param document 已追加新条目的分类。 @returns 使用 LF 和空行分隔结构的 Markdown。 */
function serializeMemory(document: MemoryCategory[]): string {
  return document.map((category) => [`# ${category.level1}`, ...category.sections.map((section) => [
    `## ${section.level2}`, ...section.memories.map((memory) => `<${memory.createdAt}>\n${memory.content}`),
  ].join("\n\n"))].join("\n\n")).join("\n\n") + "\n"
}

/**
 * 检查普通文件或缺失文件，不跟随 memory.md 符号链接。
 * @param path 目标文件。
 * @returns 普通文件为 true，缺失为 false。
 * @throws Error 非普通文件使用 MEMORY_FILE_INVALID，其他 I/O 错误交给调用方。
 */
async function requireFileOrMissing(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) throw memoryError("MEMORY_FILE_INVALID", `长期记忆不是普通文件：${path}`)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}
/** @param signal 当前调用信号。 @throws Error 已取消时抛出 CANCELLED。 */
function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw memoryError("CANCELLED", "记忆工具调用已取消") }
/** @param code 稳定错误码。 @param message 可见说明。 @param cause 内部异常。 @returns 工具可转换为 AppError 的异常。 */
function memoryError(code: string, message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, { cause }), { code })
}
