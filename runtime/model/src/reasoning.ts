/** 模型推理等级配置的协议默认值、校验与请求字段拼装。 */

import type { Protocol, ReasoningField } from "./types.ts"

const DEFAULT_LEVELS = ["low", "medium", "high"] as const

const DEFAULT_PATHS: Record<Protocol, readonly string[]> = {
  anthropic_messages: ["output_config", "effort"],
  chat_completions: ["reasoning_effort"],
  responses: ["reasoning", "effort"],
}

const RESERVED_ROOTS: Record<Protocol, readonly string[]> = {
  anthropic_messages: ["model", "max_tokens", "system", "messages", "stream", "tools", "tool_choice"],
  chat_completions: ["model", "messages", "stream", "stream_options", "tools", "tool_choice"],
  responses: ["model", "instructions", "input", "stream", "store", "tools", "tool_choice"],
}

/**
 * 返回创建模型时使用的协议默认推理配置，不共享可变数组。
 * @param protocol 模型所属 Provider 的唯一协议。
 * @returns 默认等级和请求字段路径。
 */
export function defaultReasoningConfig(protocol: Protocol): { reasoningLevels: string[]; reasoningField: ReasoningField } {
  return { reasoningLevels: [...DEFAULT_LEVELS], reasoningField: { path: [...DEFAULT_PATHS[protocol]] } }
}

/**
 * 校验模型支持的等级；自定义 Provider 可使用协议默认值以外的字符串。
 * @param value 来自 IPC 或数据库 JSON 的未知值。
 * @returns 非空、无重复且不含首尾空白的字符串数组是否有效。
 */
export function isReasoningLevels(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((level) => typeof level === "string" && level !== "" && level.trim() === level) &&
    new Set(value).size === value.length
}

/**
 * 检查 JSON 字段路径能否安全写入指定协议的请求体。
 * @param value 来自 IPC 或数据库 JSON 的未知值。
 * @param protocol 模型所属 Provider 的协议。
 * @returns 路径有效且不会覆盖固定请求字段时为 true。
 */
export function isReasoningField(value: unknown, protocol: Protocol): value is ReasoningField {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !("path" in value) || !Array.isArray(value.path) || value.path.length === 0) {
    return false
  }
  const path = value.path
  if (!path.every((part) => typeof part === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) &&
    part !== "__proto__" && part !== "prototype" && part !== "constructor")) return false
  return !RESERVED_ROOTS[protocol].includes(path[0])
}

/**
 * 从持久化路径构建只包含推理等级字段的协议请求片段。
 * @param field 已保存的字段路径。
 * @param level 当前 Turn 选择的等级字符串。
 * @param protocol 当前请求协议，用于再次检查固定字段冲突。
 * @returns 可拼入协议请求体的嵌套对象。
 * @throws TypeError 当路径或等级无效时抛出；调用方须转换为模型请求错误。
 */
export function renderReasoningField(field: ReasoningField, level: string, protocol: Protocol): Record<string, unknown> {
  if (!isReasoningField(field, protocol) || typeof level !== "string" || level.trim() === "") {
    throw new TypeError("推理等级字段或选择无效")
  }
  let value: unknown = level
  for (let index = field.path.length - 1; index >= 0; index -= 1) {
    value = { [field.path[index]]: value }
  }
  return value as Record<string, unknown>
}

/**
 * 在切换模型时保留仍可用的等级，否则优先使用 medium。
 * @param levels 新模型保存的非空等级列表。
 * @param previous 用户此前在页面选择的等级。
 * @returns 当前模型实际应选的等级。
 * @throws TypeError 当模型等级列表无效时抛出。
 */
export function preferredReasoningLevel(levels: readonly string[], previous?: string): string {
  if (!isReasoningLevels(levels)) throw new TypeError("模型推理等级列表无效")
  if (previous !== undefined && levels.includes(previous)) return previous
  return levels.includes("medium") ? "medium" : levels[0]
}
