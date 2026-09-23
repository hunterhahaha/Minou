/** 全局普通配置的 V2 持久化字段检查。 */

type JsonObject = Record<string, unknown>

function object(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`)
  }
  return value as JsonObject
}

function fields(value: JsonObject, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field}.${key} 不是 V2 字段。`)
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须是非空字符串。`)
  }
  return value
}

function stringMap(value: unknown, field: string): void {
  const entries = object(value, field)
  for (const [key, entry] of Object.entries(entries)) {
    nonEmptyString(key, `${field} 的键`)
    if (typeof entry !== "string") throw new Error(`${field}.${key} 必须是字符串。`)
  }
}

function optionalString(value: JsonObject, key: string, field: string): void {
  if (key in value) nonEmptyString(value[key], `${field}.${key}`)
}

function optionalStringMap(value: JsonObject, key: string, field: string): void {
  if (key in value) stringMap(value[key], `${field}.${key}`)
}

function stringList(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组。`)
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") throw new Error(`${field}[${index}] 必须是字符串。`)
  }
}

export function checkConfig(value: JsonObject): void {
  if (value.version !== 2) throw new Error("config.version 必须是 2；旧版配置不会自动迁移。")
  fields(value, "config", ["version", "mcpServers", "runtime"])

  if (!Array.isArray(value.mcpServers)) throw new Error("config.mcpServers 必须是数组。")
  for (const [index, serverValue] of value.mcpServers.entries()) {
    const field = `config.mcpServers[${index}]`
    const server = object(serverValue, field)
    nonEmptyString(server.name, `${field}.name`)
    if (typeof server.enabled !== "boolean") throw new Error(`${field}.enabled 必须是布尔值。`)
    if (server.transport === "stdio") {
      fields(server, field, ["name", "enabled", "transport", "command", "args", "env", "cwd"])
      nonEmptyString(server.command, `${field}.command`)
      if ("args" in server) stringList(server.args, `${field}.args`)
      optionalStringMap(server, "env", field)
      optionalString(server, "cwd", field)
    } else if (server.transport === "streamable-http") {
      fields(server, field, ["name", "enabled", "transport", "url", "headers"])
      nonEmptyString(server.url, `${field}.url`)
      optionalStringMap(server, "headers", field)
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
