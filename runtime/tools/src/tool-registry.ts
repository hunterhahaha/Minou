/**
 * 工具与结果整理器注册表（第 16、16.3 节）。
 *
 * ToolRegistry 保存模型可见定义、来源、参数检查器与业务执行函数；RenderRegistry 按同一名称
 * 保存结果整理器。正常调用方应使用 `registerTool` 成对登记，避免只登记其中一侧。
 */

import type { AppError } from "../../error/src/types.ts"
import type { ToolExecutionContext, ToolResult } from "./types.ts"

/** 架构第 16 节规定的基础内置工具名称。 */
export const BUILTIN_TOOL_NAMES = [
  "glob",
  "grep",
  "read",
  "write",
  "edit",
  "present",
  "shell",
  "terminal_open",
  "terminal_input",
  "terminal_close",
  "terminal_list",
  "skill_load",
  "memory_list",
  "memory_read",
  "memory_write",
  "mcp_list_tools",
  "mcp_load_tools",
  "tool_search",
] as const

/** NiCode 自带工具的稳定名称。 */
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number]

/** 动态 MCP 工具在模型侧使用的名称。 */
export type MCPToolName = `mcp_${string}`

/** 可进入统一工具调用入口的名称。 */
export type ToolName = BuiltinToolName | MCPToolName

/** 工具实现的来源；真正的 MCP 工具与内置工具使用不同执行分派。 */
export type ToolKind = "builtin" | "mcp"

/** ToolRegistry 保存、后续可由 ToolExposureManager 转换为模型定义的基础信息。 */
export interface ToolDefinition {
  /** 协议侧使用的工具名称。 */
  name: ToolName
  /** 给模型看的工具说明。 */
  description?: string
  /** 工具自身的业务参数 JSON Schema；`callDescription` 由未来的暴露层统一加入。 */
  inputSchema: Record<string, unknown>
}

/** 工具参数检查器的结果。 */
export type ToolArgumentValidation<TArguments extends object> =
  | { success: true; data: TArguments }
  | { success: false; error: AppError }

/**
 * 一个可执行工具在 ToolRegistry 中的完整登记信息。
 *
 * 参数检查器只接收已移除 `callDescription` 的业务参数。业务函数可以返回专属结果或 AppError；
 * 两者都由同名结果整理器解释。
 */
export interface RegisteredTool<TArguments extends object = Record<string, unknown>, TOutput = unknown> {
  /** 工具来自 NiCode 内置实现还是真正的 MCP 工具。 */
  kind: ToolKind
  /** 工具名称、说明和基础业务参数 Schema。 */
  definition: ToolDefinition
  /**
   * 检查并按需要规范化业务参数。
   *
   * @param input 已移除 `callDescription`、但尚未检查的业务参数对象。
   * @returns 检查成功后的业务参数，或应交给结果整理器的 AppError。
   */
  validateArguments(input: unknown): ToolArgumentValidation<TArguments>
  /**
   * 执行工具业务。
   *
   * @param input 已检查且不含 `callDescription` 的业务参数。
   * @param context 调用身份、取消信号和包含调用说明的完整已检查参数。
   * @returns 工具专属结果或 AppError。
   */
  execute(input: TArguments, context: ToolExecutionContext<TArguments>): Promise<TOutput | AppError>
}

/**
 * 将一个工具的专属结果或 AppError 转成统一 ToolResult。
 *
 * @param result 工具专属结果或统一错误。
 * @returns 可持久化并交还模型的统一工具结果。
 */
export type ToolRender<TOutput = unknown> = (result: TOutput | AppError) => ToolResult

/** 正常成对登记一个工具时需要提供的全部信息。 */
export interface ToolRegistration<TArguments extends object = Record<string, unknown>, TOutput = unknown>
  extends RegisteredTool<TArguments, TOutput> {
  /** 与 `definition.name` 对应的结果整理器。 */
  render: ToolRender<TOutput>
}

type StoredTool = RegisteredTool<Record<string, unknown>, unknown>
type StoredRender = ToolRender<unknown>

const BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES)

/** 保存工具定义、参数检查器和执行函数的进程内注册表。 */
export class ToolRegistry {
  private readonly tools = new Map<string, StoredTool>()

  /**
   * 登记一个工具。正常业务装配应优先使用 `registerTool` 同时登记结果整理器。
   *
   * @param tool 要登记的工具。
   * @throws Error 当名称为空、名称与来源不符、Schema 不是普通对象或名称已经登记时抛出。
   */
  register<TArguments extends object, TOutput>(
    tool: RegisteredTool<TArguments, TOutput>,
  ): void {
    this.assertCanRegister(tool)

    const stored: StoredTool = {
      kind: tool.kind,
      definition: cloneDefinition(tool.definition),
      validateArguments: (input) => {
        const validation = tool.validateArguments(input)
        if (!validation.success) return validation
        return {
          success: true,
          data: validation.data as unknown as Record<string, unknown>,
        }
      },
      execute: (input, context) => tool.execute(
        input as unknown as TArguments,
        context as unknown as ToolExecutionContext<TArguments>,
      ),
    }
    this.tools.set(stored.definition.name, stored)
  }

  /**
   * 确认一个工具当前可以登记，但不修改注册表。
   *
   * 该预检供 `registerTool` 在写入两个注册表前完成全部会失败的检查。
   *
   * @param tool 待检查的工具。
   * @throws Error 当工具定义无效或名称已存在时抛出。
   */
  assertCanRegister<TArguments extends object, TOutput>(
    tool: RegisteredTool<TArguments, TOutput>,
  ): void {
    validateToolDefinition(tool.kind, tool.definition)
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`工具已经登记：${tool.definition.name}`)
    }
  }

  /**
   * 按模型给出的名称查找工具。
   *
   * @param name 工具名称。
   * @returns 已登记工具；不存在时返回 `undefined`。
   */
  get(name: string): StoredTool | undefined {
    return this.tools.get(name)
  }

  /**
   * 判断名称是否已经登记。
   *
   * @param name 工具名称。
   * @returns 名称存在时为 `true`。
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * 按登记顺序返回基础工具定义的副本。
   *
   * @returns 可供未来 ToolExposureManager 读取的定义；修改返回值不会改变注册表。
   */
  listDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => cloneDefinition(tool.definition))
  }
}

/** 保存每个工具对应结果整理器的进程内注册表。 */
export class RenderRegistry {
  private readonly renders = new Map<string, StoredRender>()

  /**
   * 登记一个工具的结果整理器。
   *
   * @param toolName 对应的工具名称。
   * @param render 要登记的结果整理函数。
   * @throws Error 当名称为空或已经登记时抛出。
   */
  register<TOutput>(toolName: string, render: ToolRender<TOutput>): void {
    this.assertCanRegister(toolName)
    this.renders.set(toolName, (result) => render(result as TOutput | AppError))
  }

  /**
   * 确认一个名称当前可以登记结果整理器，但不修改注册表。
   *
   * @param toolName 待检查的工具名称。
   * @throws Error 当名称为空或已经登记时抛出。
   */
  assertCanRegister(toolName: string): void {
    if (toolName.length === 0) throw new Error("结果整理器的工具名称不能为空")
    if (this.renders.has(toolName)) throw new Error(`工具结果整理器已经登记：${toolName}`)
  }

  /**
   * 按工具名称查找结果整理器。
   *
   * @param toolName 工具名称。
   * @returns 已登记的结果整理器；不存在时返回 `undefined`。
   */
  get(toolName: string): StoredRender | undefined {
    return this.renders.get(toolName)
  }

  /**
   * 判断工具是否有已登记的结果整理器。
   *
   * @param toolName 工具名称。
   * @returns 结果整理器存在时为 `true`。
   */
  has(toolName: string): boolean {
    return this.renders.has(toolName)
  }
}

/**
 * 把一个工具及其结果整理器成对登记到两个注册表。
 *
 * 两侧都先完成只读预检，再依次写入；JavaScript 同步执行期间不会被其它登记操作插入，
 * 因此正常返回后两侧一定同时存在，预检失败时两侧都不改变。
 *
 * @param toolRegistry 工具注册表。
 * @param renderRegistry 结果整理器注册表。
 * @param registration 工具、参数检查器、执行函数和结果整理器。
 * @throws Error 当任一侧定义无效或名称重复时抛出，且不会产生半登记状态。
 */
export function registerTool<TArguments extends object, TOutput>(
  toolRegistry: ToolRegistry,
  renderRegistry: RenderRegistry,
  registration: ToolRegistration<TArguments, TOutput>,
): void {
  toolRegistry.assertCanRegister(registration)
  renderRegistry.assertCanRegister(registration.definition.name)

  toolRegistry.register(registration)
  renderRegistry.register(registration.definition.name, registration.render)
}

/**
 * 检查工具名称、来源与基础 Schema 是否符合注册表约束。
 *
 * @param kind 工具来源。
 * @param definition 待登记的工具定义。
 * @throws Error 当定义不符合第 16 节名称规则或 Schema 不是普通对象时抛出。
 */
function validateToolDefinition(kind: ToolKind, definition: ToolDefinition): void {
  const name = definition.name as string
  if (name.length === 0) throw new Error("工具名称不能为空")

  if (kind === "builtin" && !BUILTIN_TOOL_NAME_SET.has(name)) {
    throw new Error(`未知的内置工具名称：${name}`)
  }
  if (kind === "mcp" && (!name.startsWith("mcp_") || name.length === "mcp_".length)) {
    throw new Error(`MCP 工具名称必须使用 mcp_ 前缀并包含实际名称：${name}`)
  }
  if (!isPlainRecord(definition.inputSchema)) {
    throw new Error(`工具参数 Schema 必须是普通对象：${name}`)
  }
}

/**
 * 创建不会与注册表内部对象共享 Schema 引用的工具定义。
 *
 * @param definition 原始工具定义。
 * @returns 名称、说明及深拷贝后的参数 Schema。
 */
function cloneDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    name: definition.name,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    inputSchema: structuredClone(definition.inputSchema),
  }
}

/**
 * 判断值是否为可按工具参数或 JSON Schema 处理的普通对象。
 *
 * @param value 待检查值。
 * @returns 值不是 null、数组或自定义类实例时为 `true`。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
