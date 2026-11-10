/** 全局普通配置的 V2 持久化字段检查。 */

import { isTeamWakeupConfig } from "../../runtime/session/src/team-wakeup-config.ts"

type JsonObject = Record<string, unknown>

/**
 * 要求值为非 null、非数组的对象，不复制或改变字段。
 *
 * @param value 待检查的 JSON 值。
 * @param field 错误消息中的字段路径。
 * @returns 按字符串键访问的原对象。
 * @throws Error 值不是对象时抛出，调用方应拒绝该配置。
 */
function object(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`)
  }
  return value as JsonObject
}

/**
 * 拒绝对象中不在允许名单内的字段，不要求名单字段全部存在。
 *
 * @param value 待检查的对象。
 * @param field 错误消息中的对象路径。
 * @param allowed 允许存在的字段名称。
 * @throws Error 出现额外字段时抛出，调用方应拒绝该配置。
 */
function fields(value: JsonObject, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field}.${key} 不是 V2 字段。`)
  }
}

/**
 * 要求值为非空白字符串，保留原始内容而不裁剪空白。
 *
 * @param value 待检查的值。
 * @param field 错误消息中的字段路径。
 * @returns 通过检查的原始字符串。
 * @throws Error 字段不是字符串或只含空白时抛出。
 */
function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须是非空字符串。`)
  }
  return value
}

/**
 * 要求对象键为非空白字符串、值为字符串，不复制或规范化内容。
 *
 * @param value 待检查的键值对象。
 * @param field 错误消息中的对象路径。
 * @throws Error 对象、键或值无效时抛出，调用方应拒绝该配置。
 */
function stringMap(value: unknown, field: string): void {
  const entries = object(value, field)
  for (const [key, entry] of Object.entries(entries)) {
    nonEmptyString(key, `${field} 的键`)
    if (typeof entry !== "string") throw new Error(`${field}.${key} 必须是字符串。`)
  }
}

/**
 * 仅在对象包含指定键时检查其值为非空白字符串。
 *
 * @param value 已经确认的对象。
 * @param key 需要检查的可选字段。
 * @param field 错误消息中的父字段路径。
 * @throws Error 字段存在但值无效时抛出。
 */
function optionalString(value: JsonObject, key: string, field: string): void {
  if (key in value) nonEmptyString(value[key], `${field}.${key}`)
}

/**
 * 仅在对象包含指定键时检查字符串映射结构。
 *
 * @param value 已经确认的对象。
 * @param key 需要检查的可选字段。
 * @param field 错误消息中的父字段路径。
 * @throws Error 字段存在但映射结构无效时抛出。
 */
function optionalStringMap(value: JsonObject, key: string, field: string): void {
  if (key in value) stringMap(value[key], `${field}.${key}`)
}

/**
 * 要求值为字符串数组，允许空数组与空字符串元素。
 *
 * @param value 待检查的值。
 * @param field 错误消息中的字段路径。
 * @throws Error 值不是数组或含非字符串元素时抛出。
 */
function stringList(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组。`)
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") throw new Error(`${field}[${index}] 必须是字符串。`)
  }
}

/**
 * 校验 V2 全局配置及两种 MCP 传输，不补默认字段、不迁移或改写文件。
 * @param value 已解析的全局 JSON 对象。
 * @throws Error 字段、版本、超时、URL 或鉴权来源无效；启动文件入口补充路径后报告。
 */
export function checkConfig(value: JsonObject): void {
  if (value.version !== 2) throw new Error("config.version 必须是 2；旧版配置不会自动迁移。")
  fields(value, "config", ["version", "mcpServers", "runtime", "teamWakeup"])
  if ("teamWakeup" in value && !isTeamWakeupConfig(value.teamWakeup)) {
    throw new Error("config.teamWakeup 必须包含四个合法的唤醒配置整数。")
  }

  if (!Array.isArray(value.mcpServers)) throw new Error("config.mcpServers 必须是数组。")
  for (const [index, serverValue] of value.mcpServers.entries()) {
    const field = `config.mcpServers[${index}]`
    const server = object(serverValue, field)
    nonEmptyString(server.name, `${field}.name`)
    if (typeof server.enabled !== "boolean") throw new Error(`${field}.enabled 必须是布尔值。`)
    for (const key of ["startup_timeout_sec", "tool_timeout_sec"]) {
      if (key in server && (typeof server[key] !== "number" || !Number.isFinite(server[key]) || server[key] <= 0 || server[key] * 1000 > 2_147_483_647)) {
        throw new Error(`${field}.${key} 必须是计时器范围内的有限正数秒。`)
      }
    }
    const common = ["name", "enabled", "transport", "startup_timeout_sec", "tool_timeout_sec"]
    if (server.transport === "stdio") {
      fields(server, field, [...common, "command", "args", "env", "cwd"])
      nonEmptyString(server.command, `${field}.command`)
      if ("args" in server) stringList(server.args, `${field}.args`)
      optionalStringMap(server, "env", field)
      optionalString(server, "cwd", field)
    } else if (server.transport === "streamable-http") {
      fields(server, field, [...common, "url", "bearer_token_env_var", "http_headers"])
      nonEmptyString(server.url, `${field}.url`)
      let url: URL
      try { url = new URL(server.url as string) } catch { throw new Error(`${field}.url 必须是绝对 HTTP(S) URL。`) }
      if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${field}.url 必须使用 HTTP(S)。`)
      optionalStringMap(server, "http_headers", field)
      optionalString(server, "bearer_token_env_var", field)
      if ("bearer_token_env_var" in server && server.http_headers && Object.keys(server.http_headers).some((key) => key.toLowerCase() === "authorization")) {
        throw new Error(`${field} 不得重复配置 Authorization 和 bearer_token_env_var。`)
      }
    } else {
      throw new Error(`${field}.transport 不是支持的传输方式。`)
    }
  }

  const runtime = object(value.runtime, "config.runtime")
  fields(runtime, "config.runtime", ["userMessageMode"])
  if (runtime.userMessageMode !== "insert" && runtime.userMessageMode !== "queue") {
    throw new Error("config.runtime.userMessageMode 必须是 insert 或 queue。")
  }
}
