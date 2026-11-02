/** 五个文件工具的登记、参数检查与文件操作；路径和 ripgrep 设施位于 filesystem/。 */
import { createReadStream } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createInterface } from "node:readline"
import type { AppError } from "../../../error/src/types.ts"
import type { SandboxMode } from "../../../session/src/session-state.ts"
import { canonicalPath, isWithinRoot, runRipgrep } from "../filesystem/index.ts"
import { renderEdit, renderGlob, renderGrep, renderRead, renderWrite } from "../render/index.ts"
import { fileAccessDecision } from "../security/index.ts"
import { isPlainRecord, registerTool, type RenderRegistry, type ToolArgumentValidation, type ToolRegistry } from "../tool-registry.ts"
import type { ToolExecutionContext } from "../types.ts"
import type { EditInput, EditResult, GlobInput, GlobResult, GrepInput, GrepMatch, GrepResult, ReadInput, ReadResult, WriteInput, WriteResult } from "./types.ts"

export * from "./types.ts"

/** 每次调用从磁盘读取的当前沙箱信息。 */
export interface FileAccessState {
  /** Session Meta 中的当前沙箱模式。 */
  sandboxMode: SandboxMode
  /** workspace 与关联目录形成的允许根目录。 */
  roots: string[]
}
/** 文件工具从主进程取得的应用内资源与数据库读取端口。 */
export interface FileToolDependencies {
  /** 随应用依赖安装的 ripgrep 可执行文件。 */
  rgPath: string
  /**
   * 每次调用独立读取 Meta 与工作区数据库，不得缓存。
   * @param projectId Project/default 分组身份。
   * @param sessionId 当前对话身份。
   * @returns 当前沙箱模式与允许目录。
   * @throws Error 数据缺失或无效时拒绝本次调用。
   */
  loadAccess(projectId: string, sessionId: string): FileAccessState
}

/**
 * 参与路径权限判断的文件工具名称。
 */
type FileToolName = "glob" | "grep" | "read" | "write" | "edit"

/**
 * 将五个文件相关工具和各自 render 成对登记到现有注册表。
 * @param tools 工具定义与执行业务注册表。
 * @param renders 专属结果整理器注册表。
 * @param dependencies 当前应用内 ripgrep 与实时数据库读取端口。
 */
export function registerFileTools(
  tools: ToolRegistry,
  renders: RenderRegistry,
  dependencies: FileToolDependencies,
): void {
  registerTool(tools, renders, {
    kind: "builtin", definition: definition("glob", "Find files matching a glob pattern within an absolute directory.",
      { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "integer" } }, ["pattern", "path"]),
    validateArguments: (value) => validateGlob(value),
    execute: (input, context) => executeGlob(input, context, dependencies), render: renderGlob,
  })
  registerTool(tools, renders, {
    kind: "builtin", definition: definition("grep", "Search file contents by regex or literal text within an absolute file or directory.",
      { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" }, literal: { type: "boolean" }, ignoreCase: { type: "boolean" }, context: { type: "integer" }, limit: { type: "integer" } }, ["pattern", "path"]),
    validateArguments: (value) => validateGrep(value),
    execute: (input, context) => executeGrep(input, context, dependencies), render: renderGrep,
  })
  registerTool(tools, renders, {
    kind: "builtin", definition: definition("read", "Read a known text file by absolute path and line range.",
      { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, ["path"]),
    validateArguments: (value) => validateRead(value),
    execute: (input, context) => executeRead(input, context, dependencies), render: renderRead,
  })
  registerTool(tools, renders, {
    kind: "builtin", definition: definition("write", "Write an entire file, creating the file and missing parent directories.",
      { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    validateArguments: (value) => validateWrite(value),
    execute: (input, context) => executeWrite(input, context, dependencies), render: renderWrite,
  })
  registerTool(tools, renders, {
    kind: "builtin", definition: definition("edit", "Read the target file first. Replace one exact, uniquely matching oldText in an existing file; expand oldText when ambiguous.",
      { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, ["path", "oldText", "newText"]),
    validateArguments: (value) => validateEdit(value),
    execute: (input, context) => executeEdit(input, context, dependencies), render: renderEdit,
  })
}

/**
 * 用名称、说明和业务字段构造不允许额外属性的文件工具定义。
 * @param name 工具名。
 * @param description 模型侧说明。
 * @param properties 业务字段。
 * @param required 必填字段。
 * @returns JSON Schema 工具定义。
 */
function definition(name: FileToolName, description: string, properties: Record<string, unknown>, required: string[]) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } }
}

/**
 * 构造参数校验失败结果，供统一执行入口交给结果整理器。
 * @param message 参数错误说明。
 * @returns 标准检查失败结果。
 */
function invalid<T extends object>(message: string): ToolArgumentValidation<T> {
  return { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message } }
}

/**
 * 检查未知值是否为不超过上限的正整数。
 * @param value 待检查数值。
 * @param maximum 上限。
 * @returns 是否为范围内正整数。
 */
function positiveInt(value: unknown, maximum: number): boolean {
  return Number.isInteger(value) && typeof value === "number" && value > 0 && value <= maximum
}

/**
 * 校验 glob 路径、模式和数量限制，返回业务参数或参数错误。
 * @param value 模型参数。
 * @returns glob 业务参数。
 */
function validateGlob(value: unknown): ToolArgumentValidation<GlobInput> {
  if (!isPlainRecord(value) || typeof value.pattern !== "string" || value.pattern.length === 0 || typeof value.path !== "string" || (value.limit !== undefined && !positiveInt(value.limit, 500))) return invalid("glob 需要 pattern、目录 path，limit 须为 1–500")
  return { success: true, data: { pattern: value.pattern, path: value.path, ...(value.limit === undefined ? {} : { limit: value.limit as number }) } }
}

/**
 * 校验 grep 搜索参数及上下文、结果数量边界。
 * @param value 模型参数。
 * @returns grep 业务参数。
 */
function validateGrep(value: unknown): ToolArgumentValidation<GrepInput> {
  if (!isPlainRecord(value) || typeof value.pattern !== "string" || value.pattern.length === 0 || typeof value.path !== "string" || (value.include !== undefined && typeof value.include !== "string") || (value.literal !== undefined && typeof value.literal !== "boolean") || (value.ignoreCase !== undefined && typeof value.ignoreCase !== "boolean") || (value.context !== undefined && (!Number.isInteger(value.context) || (value.context as number) < 0 || (value.context as number) > 20)) || (value.limit !== undefined && !positiveInt(value.limit, 500))) return invalid("grep 参数无效：context 须为 0–20，limit 须为 1–500")
  return { success: true, data: value as unknown as GrepInput }
}

/**
 * 校验 read 的路径、起始行与行数限制，返回读取请求或参数错误。
 * @param value 模型参数。
 * @returns read 业务参数。
 */
function validateRead(value: unknown): ToolArgumentValidation<ReadInput> {
  if (!isPlainRecord(value) || typeof value.path !== "string" || (value.offset !== undefined && !positiveInt(value.offset, Number.MAX_SAFE_INTEGER)) || (value.limit !== undefined && !positiveInt(value.limit, 2000))) return invalid("read 需要文件 path，offset 须为正行号，limit 须为 1–2000")
  return { success: true, data: value as unknown as ReadInput }
}

/**
 * 校验写入路径与完整文本，复制业务字段以排除额外参数。
 * @param value 模型参数。
 * @returns write 业务参数。
 */
function validateWrite(value: unknown): ToolArgumentValidation<WriteInput> {
  if (!isPlainRecord(value) || typeof value.path !== "string" || typeof value.content !== "string") return invalid("write 需要文件 path 和字符串 content")
  return { success: true, data: { path: value.path, content: value.content } }
}

/**
 * 校验文件路径、非空匹配文本和替换文本，返回精确替换参数。
 * @param value 模型参数。
 * @returns edit 业务参数。
 */
function validateEdit(value: unknown): ToolArgumentValidation<EditInput> {
  if (!isPlainRecord(value) || typeof value.path !== "string" || typeof value.oldText !== "string" || value.oldText.length === 0 || typeof value.newText !== "string") return invalid("edit 需要文件 path、非空 oldText 和字符串 newText")
  return { success: true, data: { path: value.path, oldText: value.oldText, newText: value.newText } }
}

/**
 * 在单次调用内读取最新权限并完成路径审批。
 * @param name 当前工具名称。
 * @param inputPath 模型提供的绝对目标路径。
 * @param context 包含调用身份、取消信号及 Session 注入资源的执行上下文。
 * @param dependencies 文件工具的路径设施和最新权限读取端口。
 * @returns 已规范化、完成必要审批并在执行前复查的目标路径。
 * @throws Error 上下文缺失、路径变化、权限读取失败、审批拒绝或取消时抛出，由文件业务边界转换为 AppError。
 */
async function authorizedPath<T extends object>(
  name: FileToolName, inputPath: string, context: ToolExecutionContext<T>, dependencies: FileToolDependencies,
): Promise<string> {
  const runtime = context.fileRuntime
  if (runtime === undefined) throw coded("FILE_RUNTIME_MISSING", "当前 Session 缺少文件工具运行上下文")
  const path = await canonicalPath(inputPath)
  const state = dependencies.loadAccess(runtime.projectId, runtime.sessionId)
  const roots = await Promise.all(state.roots.map(canonicalPath))
  let approved = false
  if (fileAccessDecision(state.sandboxMode, name, path, roots) === "APPROVAL") {
    const decision = await runtime.requestApproval(name, path, context)
    if (decision !== "approved") throw coded(decision === "cancelled" ? "CANCELLED" : "APPROVAL_DENIED", decision === "cancelled" ? "工具调用已取消" : "文件访问未获批准")
    approved = true
  }
  const current = await canonicalPath(inputPath)
  if (current !== path) throw coded("PATH_CHANGED", "审批或路径检查期间目标路径发生变化")
  /** 审批等待期间配置可能变化；实际文件 I/O 前再次从数据库读取。 */
  const latest = dependencies.loadAccess(runtime.projectId, runtime.sessionId)
  const latestRoots = await Promise.all(latest.roots.map(canonicalPath))
  if (!approved && fileAccessDecision(latest.sandboxMode, name, current, latestRoots) === "APPROVAL") {
    const decision = await runtime.requestApproval(name, current, context)
    if (decision !== "approved") throw coded(decision === "cancelled" ? "CANCELLED" : "APPROVAL_DENIED", decision === "cancelled" ? "工具调用已取消" : "文件访问未获批准")
    if (await canonicalPath(inputPath) !== current) throw coded("PATH_CHANGED", "审批期间目标路径发生变化")
  }
  if (context.signal.aborted) throw coded("CANCELLED", "工具调用已取消")
  return current
}

/**
 * 构造带稳定错误码的 Error，不在此处抛出。
 * @param code 稳定错误码。
 * @param message 模型可见说明。
 * @returns 带错误码的异常。
 */
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * 将文件工具捕获的异常转换为工具 AppError，保留可用错误码。
 * @param error 底层异常。
 * @param fallback 默认错误码。
 * @returns 可交给专属 render 的 AppError。
 */
function fileError(error: unknown, fallback: string): AppError {
  const code = error instanceof Error && error.name === "AbortError" ? "CANCELLED"
    : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : fallback
  return { source: "tool", code, message: error instanceof Error ? error.message : String(error) }
}

/**
 * 读取目标类型并要求其为普通文件或目录。
 * @param path 已授权文件或目录。
 * @param directory 是否要求目录。
 * @returns 目标类型检查通过后解析。
 * @throws Error 目标不存在、无法读取或类型不符时抛出，由工具业务边界转换为错误结果。
 */
async function requireKind(path: string, directory: boolean): Promise<void> {
  const info = await stat(path)
  if (directory ? !info.isDirectory() : !info.isFile()) throw coded("INVALID_FILE_TYPE", directory ? "目标不是目录" : "目标不是普通文件")
}

/**
 * 执行 glob 并返回规范绝对路径。
 * @param input 已通过参数检查的业务输入。
 * @param context 包含调用身份、取消信号及 Session 注入资源的执行上下文。
 * @param deps 文件工具的 ripgrep 路径及最新权限读取端口。
 * @returns 当前工具业务结果；捕获的路径、审批、取消及 I/O 异常转换为 AppError。
 */
async function executeGlob(input: GlobInput, context: ToolExecutionContext<GlobInput>, deps: FileToolDependencies): Promise<GlobResult | AppError> {
  try {
    const path = await authorizedPath("glob", input.path, context, deps)
    await requireKind(path, true)
    const limit = input.limit ?? 100
    const raw: string[] = []
    const truncated = await runRipgrep(deps.rgPath, ["--files", "--glob", input.pattern, "--", path], context.signal, (line) => {
      raw.push(line)
      return raw.length <= limit
    })
    const files: string[] = []
    for (const item of raw.slice(0, limit)) {
      const candidate = await canonicalPath(item)
      if (isWithinRoot(candidate, path)) files.push(candidate)
    }
    return { files, truncated }
  } catch (error) { return fileError(error, "GLOB_FAILED") }
}

/**
 * 执行 grep 并在需要时读取匹配行上下文。
 * @param input 已通过参数检查的业务输入。
 * @param context 包含调用身份、取消信号及 Session 注入资源的执行上下文。
 * @param deps 文件工具的 ripgrep 路径及最新权限读取端口。
 * @returns 当前工具业务结果；捕获的路径、审批、取消及 I/O 异常转换为 AppError。
 */
async function executeGrep(input: GrepInput, context: ToolExecutionContext<GrepInput>, deps: FileToolDependencies): Promise<GrepResult | AppError> {
  try {
    const path = await authorizedPath("grep", input.path, context, deps)
    const kind = await stat(path)
    if (!kind.isDirectory() && !kind.isFile()) throw coded("INVALID_FILE_TYPE", "grep 目标必须是普通文件或目录")
    const args = ["--json", ...(input.literal ? ["--fixed-strings"] : []), ...(input.ignoreCase ? ["--ignore-case"] : []), ...(input.include ? ["--glob", input.include] : []), "--", input.pattern, path]
    const limit = input.limit ?? 100
    const raw: GrepMatch[] = []
    const truncated = await runRipgrep(deps.rgPath, args, context.signal, (line) => {
      const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
      if (event.type !== "match" || typeof event.data?.path?.text !== "string" || typeof event.data.line_number !== "number") return true
      raw.push({ path: event.data.path.text, line: event.data.line_number, text: event.data.lines?.text?.replace(/\r?\n$/, "") ?? "" })
      return raw.length <= limit
    })
    const matches: GrepMatch[] = []
    for (const match of raw.slice(0, limit)) {
      if (context.signal.aborted) throw coded("CANCELLED", "工具调用已取消")
      const candidate = await canonicalPath(match.path)
      if (!(kind.isFile() ? candidate === path : isWithinRoot(candidate, path))) continue
      match.path = candidate
      if ((input.context ?? 0) > 0) {
        const lines = (await readFile(candidate, "utf8")).split(/\r?\n/)
        const distance = input.context ?? 0
        match.before = lines.slice(Math.max(0, match.line - distance - 1), match.line - 1)
          .map((text, index) => ({ line: Math.max(1, match.line - distance) + index, text }))
        match.after = lines.slice(match.line, match.line + distance)
          .map((text, index) => ({ line: match.line + index + 1, text }))
      }
      matches.push(match)
    }
    return { matches, truncated }
  } catch (error) { return fileError(error, "GREP_FAILED") }
}

/**
 * 使用流式读取按行号及大小限制读取文本文件。
 * @param input 已通过参数检查的业务输入。
 * @param context 包含调用身份、取消信号及 Session 注入资源的执行上下文。
 * @param deps 文件工具的 ripgrep 路径及最新权限读取端口。
 * @returns 当前工具业务结果；捕获的路径、审批、取消及 I/O 异常转换为 AppError。
 */
async function executeRead(input: ReadInput, context: ToolExecutionContext<ReadInput>, deps: FileToolDependencies): Promise<ReadResult | AppError> {
  try {
    const path = await authorizedPath("read", input.path, context, deps)
    await requireKind(path, false)
    const offset = input.offset ?? 1
    const limit = input.limit ?? 500
    const lines: ReadResult["lines"] = []
    let number = 0
    let bytes = 0
    let truncated = false
    const stream = createReadStream(path, { encoding: "utf8" })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of reader) {
        if (context.signal.aborted) throw coded("CANCELLED", "工具调用已取消")
        number += 1
        if (number < offset) continue
        const text = line.length > 2000 ? line.slice(0, 2000) : line
        if (lines.length >= limit || bytes + Buffer.byteLength(text, "utf8") > 50 * 1024) {
          truncated = true
          break
        }
        lines.push({ number, text })
        bytes += Buffer.byteLength(text, "utf8")
      }
    } finally { reader.close(); stream.destroy() }
    return { path, offset, lines, truncated, ...(truncated ? { nextOffset: offset + lines.length } : {}) }
  } catch (error) { return fileError(error, "READ_FAILED") }
}

/**
 * 完整写入文件、隐式创建父目录并更新 Turn 追踪器。
 * @param input 已通过参数检查的业务输入。
 * @param context 包含调用身份、取消信号及 Session 注入资源的执行上下文。
 * @param deps 文件工具的 ripgrep 路径及最新权限读取端口。
 * @returns 当前工具业务结果；捕获的路径、审批、取消及 I/O 异常转换为 AppError。
 */
async function executeWrite(input: WriteInput, context: ToolExecutionContext<WriteInput>, deps: FileToolDependencies): Promise<WriteResult | AppError> {
  try {
    const path = await authorizedPath("write", input.path, context, deps)
    const tracker = context.fileRuntime?.tracker
    if (tracker === undefined) throw coded("FILE_RUNTIME_MISSING", "当前 Session 缺少文件变更追踪器")
    let before: Buffer | null = null
    try { await requireKind(path, false); before = await readFile(path) }
    catch (error) { if (!isMissing(error)) throw error }
    await mkdir(dirname(path), { recursive: true })
    const current = await canonicalPath(input.path)
    if (current !== path) throw coded("PATH_CHANGED", "创建父目录期间目标路径发生变化")
    if (context.signal.aborted) throw coded("CANCELLED", "工具调用已取消")
    const after = Buffer.from(input.content, "utf8")
    await writeFile(path, after)
    tracker.record(path, before, after)
    return { path, operation: before === null ? "created" : "overwritten", bytesWritten: after.length }
  } catch (error) { return fileError(error, "WRITE_FAILED") }
}

/**
 * 唯一精确匹配 oldText 后写回已有文件并更新 Turn 追踪器。
 * @param input 已通过参数检查的业务输入。
 * @param context 包含调用身份、取消信号及 Session 注入资源的执行上下文。
 * @param deps 文件工具的 ripgrep 路径及最新权限读取端口。
 * @returns 当前工具业务结果；捕获的路径、审批、取消及 I/O 异常转换为 AppError。
 */
async function executeEdit(input: EditInput, context: ToolExecutionContext<EditInput>, deps: FileToolDependencies): Promise<EditResult | AppError> {
  try {
    const path = await authorizedPath("edit", input.path, context, deps)
    await requireKind(path, false)
    const before = await readFile(path)
    const content = before.toString("utf8")
    const first = content.indexOf(input.oldText)
    if (first < 0) throw coded("MATCH_NOT_FOUND", "oldText 未匹配目标文件")
    if (content.indexOf(input.oldText, first + input.oldText.length) >= 0) throw coded("AMBIGUOUS_MATCH", "oldText 匹配多处，请扩大上下文")
    const current = await canonicalPath(input.path)
    if (current !== path) throw coded("PATH_CHANGED", "写入前目标路径发生变化")
    if (context.signal.aborted) throw coded("CANCELLED", "工具调用已取消")
    const after = Buffer.from(content.slice(0, first) + input.newText + content.slice(first + input.oldText.length), "utf8")
    await writeFile(path, after)
    context.fileRuntime?.tracker.record(path, before, after)
    return { path, replacements: 1, bytesWritten: after.length }
  } catch (error) { return fileError(error, "EDIT_FAILED") }
}

/**
 * 检查文件系统异常是否带 ENOENT 错误码。
 * @param error 文件系统异常。
 * @returns 是否为目标不存在。
 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
