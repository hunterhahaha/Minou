/** 记忆三件套的模型定义、参数检查与执行接线；存储由 MemoryManager 负责。 */
import type { AppError } from "../../../error/src/types.ts"
import { MemoryManager, validateMemoryContent, validateMemoryTitle } from "../../../memory/src/index.ts"
import type { MemorySectionIndex, NewMemory } from "../../../memory/src/index.ts"
import { isProjectId } from "../../../session/src/project-id.ts"
import { renderMemoryList, renderMemoryRead, renderMemoryWrite } from "../render/memory.ts"
import { isPlainRecord, registerTool } from "../tool-registry.ts"
import type { RenderRegistry, ToolArgumentValidation, ToolRegistry } from "../tool-registry.ts"
import type { ToolCallMeta, ToolExecutionContext } from "../types.ts"

/** memory_list 没有业务参数，仅允许 Runtime 调用说明。 */
export interface MemoryListInput extends ToolCallMeta {}
/** memory_read 的分类请求和独立的每分类条数限制。 */
export interface ReadMemoryInput extends ToolCallMeta {
  /** 按请求顺序读取的二级分类；空 level2 不选择其他章节。 */
  sections: MemorySectionIndex[]
  /** 正安全整数，省略则返回全部记录。 */
  limitPerSection?: number
}
/** memory_write 的整批追加输入；时间和位置根目录由 Runtime 决定。 */
export interface WriteMemoryInput extends ToolCallMeta {
  /** 按顺序追加的记忆，空数组不创建文件。 */
  memories: NewMemory[]
}

/** 用户指定的 memory_write 模型提示词，保留原文及换行。 */
export const MEMORY_WRITE_DESCRIPTION = `Project Memory stores durable knowledge learned
across sessions.

Save:
- User preferences and corrections.
- Project decisions not evident from code.
- Important context useful in future sessions.

Do not save:
- Information already in AGENTS.md.
- Facts derivable from current code or Git history.
- Temporary task details.

Treat AGENTS.md as explicit project instructions.
Treat Memory as historical knowledge that may be stale.

When conflicts occur, do not silently override
AGENTS.md. Verify or ask the user.`

/**
 * 将三件工具及各自 render 成对登记，不读取或创建记忆文件。
 * @param tools 当前进程的工具注册表。
 * @param renders 同名结果整理器注册表。
 * @param manager 启动时创建、所有 Session 共享的 MemoryManager。
 * @throws Error 工具或 render 名称冲突，或注册定义无效。
 */
export function registerMemoryTools(tools: ToolRegistry, renders: RenderRegistry, manager: MemoryManager): void {
  registerTool(tools, renders, {
    kind: "builtin",
    definition: { name: "memory_list", description: "List the current Project Memory's first-level and second-level headings without reading memory contents. Use memory_read to read relevant sections.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    validateArguments: (input): ToolArgumentValidation<MemoryListInput> => isPlainRecord(input) && hasOnly(input, [])
      ? { success: true, data: {} } : invalid("memory_list 不接受业务参数"),
    execute: (_input, context) => runMemory(context, (id) => manager.list(id, context.signal)),
    render: renderMemoryList,
  })
  registerTool(tools, renders, {
    kind: "builtin",
    definition: { name: "memory_read", description: "Read selected second-level sections of the current Project Memory, newest first. limitPerSection applies independently to each section; omit it to read all entries. Historical knowledge may be stale.",
      inputSchema: { type: "object", properties: {
        sections: { type: "array", items: { type: "object", properties: { level1: { type: "string", minLength: 1 }, level2: { type: "array", items: { type: "string", minLength: 1 } } }, required: ["level1", "level2"], additionalProperties: false } },
        limitPerSection: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      }, required: ["sections"], additionalProperties: false } },
    validateArguments: validateRead,
    execute: (input, context) => runMemory(context, (id) => manager.read(id, input.sections, input.limitPerSection, context.signal)),
    render: renderMemoryRead,
  })
  registerTool(tools, renders, {
    kind: "builtin",
    definition: { name: "memory_write", description: MEMORY_WRITE_DESCRIPTION,
      inputSchema: { type: "object", properties: {
        memories: { type: "array", items: { type: "object", properties: {
          level1: { type: "string", minLength: 1 }, level2: { type: "string", minLength: 1 }, content: { type: "string", minLength: 1 },
        }, required: ["level1", "level2", "content"], additionalProperties: false } },
      }, required: ["memories"], additionalProperties: false } },
    validateArguments: validateWrite,
    execute: (input, context) => runMemory(context, (id) => manager.write(id, input.memories, context.signal)),
    render: renderMemoryWrite,
  })
}

/** @param input 已分离 callDescription 的业务参数。 @returns 已复制的读取请求或参数错误。 */
function validateRead(input: unknown): ToolArgumentValidation<ReadMemoryInput> {
  if (!isPlainRecord(input) || !hasOnly(input, ["sections", "limitPerSection"]) || !Array.isArray(input.sections)) return invalid("memory_read 需要 sections 数组")
  if (input.limitPerSection !== undefined && (typeof input.limitPerSection !== "number" || !Number.isSafeInteger(input.limitPerSection) || input.limitPerSection <= 0)) return invalid("limitPerSection 必须是正安全整数")
  const sections: MemorySectionIndex[] = []
  try {
    for (const section of input.sections) {
      if (!isPlainRecord(section) || !hasOnly(section, ["level1", "level2"]) || !Array.isArray(section.level2)) return invalid("sections 每项需要 level1 和 level2 数组")
      validateMemoryTitle(section.level1)
      const level2: string[] = []
      for (const title of section.level2) { validateMemoryTitle(title); level2.push(title) }
      sections.push({ level1: section.level1, level2 })
    }
  } catch (error) { return invalid(error instanceof Error ? error.message : "记忆分类无效") }
  return { success: true, data: { sections, ...(input.limitPerSection === undefined ? {} : { limitPerSection: input.limitPerSection }) } }
}

/** @param input 已分离 callDescription 的业务参数。 @returns 整批检查并复制的新增记忆或参数错误。 */
function validateWrite(input: unknown): ToolArgumentValidation<WriteMemoryInput> {
  if (!isPlainRecord(input) || !hasOnly(input, ["memories"]) || !Array.isArray(input.memories)) return invalid("memory_write 需要 memories 数组")
  const memories: NewMemory[] = []
  try {
    for (const memory of input.memories) {
      if (!isPlainRecord(memory) || !hasOnly(memory, ["level1", "level2", "content"])) return invalid("memories 每项需要 level1、level2、content")
      validateMemoryTitle(memory.level1)
      validateMemoryTitle(memory.level2)
      validateMemoryContent(memory.content)
      memories.push({ level1: memory.level1, level2: memory.level2, content: memory.content })
    }
  } catch (error) { return invalid(error instanceof Error ? error.message : "记忆参数无效") }
  return { success: true, data: { memories } }
}

/** @param input 参数对象。 @param keys 允许的字段。 @returns 是否没有 Schema 之外的字段。 */
function hasOnly(input: Record<string, unknown>, keys: string[]): boolean { return Object.keys(input).every((key) => keys.includes(key)) }
/** @param message 参数错误说明。 @returns 统一参数错误。 */
function invalid<T extends object>(message: string): ToolArgumentValidation<T> { return { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message } } }

/**
 * 检查可信调用身份，并将存储异常转为无部分输出的 AppError。
 * @param context Runtime 注入的调用身份和取消信号。
 * @param action 只接受已检查 Project ID 的存储操作。
 * @returns 专属成功数据或稳定工具错误；成功提交不因后续取消改写为失败。
 */
async function runMemory<T>(context: ToolExecutionContext<object>, action: (projectId: string) => Promise<T>): Promise<T | AppError> {
  if (context.projectId === undefined) return { source: "tool", code: "MEMORY_PROJECT_MISSING", message: "当前记忆工具调用缺少 Project 身份" }
  if (!isProjectId(context.projectId)) return { source: "tool", code: "MEMORY_PROJECT_INVALID", message: "记忆工具的 Project 身份必须是 UUID 或 default" }
  try { return await action(context.projectId) }
  catch (error) {
    const code = context.signal.aborted ? "CANCELLED" : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "MEMORY_OPERATION_FAILED"
    return { source: "tool", code, message: error instanceof Error ? error.message : "长期记忆操作失败" }
  }
}
