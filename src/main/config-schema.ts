/** V1 持久化配置的字段检查；只检查当前启动流程涉及的三份文件。 */

import { PROTOCOLS } from "../../runtime/model/src/types.ts"

type JsonObject = Record<string, unknown>

function object(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`)
  }
  return value as JsonObject
}

function fields(value: JsonObject, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field}.${key} 不是 V1 字段。`)
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

function optionalPositiveInteger(value: JsonObject, key: string, field: string): void {
  if (key in value && (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0)) {
    throw new Error(`${field}.${key} 必须是正整数。`)
  }
}

function optionalBoolean(value: JsonObject, key: string, field: string): void {
  if (key in value && typeof value[key] !== "boolean") {
    throw new Error(`${field}.${key} 必须是布尔值。`)
  }
}

function stringList(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组。`)
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") throw new Error(`${field}[${index}] 必须是字符串。`)
  }
}

function isZonedIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59
    && (offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59))
}

export function checkConfig(value: JsonObject): Set<string> {
  fields(value, "config", ["version", "providers", "defaultModel", "mcpServers", "runtime"])
  if (value.version !== 1) throw new Error("config.version 必须是 1。")
  if (!Array.isArray(value.providers)) throw new Error("config.providers 必须是数组。")
  const providerIds = new Set<string>()
  const modelIds = new Set<string>()

  for (const [providerIndex, entry] of value.providers.entries()) {
    const field = `config.providers[${providerIndex}]`
    const provider = object(entry, field)
    fields(provider, field, ["id", "name", "protocols", "models"])
    const id = nonEmptyString(provider.id, `${field}.id`)
    nonEmptyString(provider.name, `${field}.name`)
    if (providerIds.has(id)) throw new Error(`${field}.id 重复。`)
    providerIds.add(id)

    const protocols = object(provider.protocols, `${field}.protocols`)
    for (const [protocol, optionsValue] of Object.entries(protocols)) {
      if (!(PROTOCOLS as readonly string[]).includes(protocol)) {
        throw new Error(`${field}.protocols.${protocol} 不是支持的协议。`)
      }
      const optionsField = `${field}.protocols.${protocol}`
      const options = object(optionsValue, optionsField)
      fields(options, optionsField, ["baseURL", "defaultHeaders"])
      optionalString(options, "baseURL", optionsField)
      optionalStringMap(options, "defaultHeaders", optionsField)
    }

    if (!Array.isArray(provider.models)) throw new Error(`${field}.models 必须是数组。`)
    for (const [modelIndex, modelValue] of provider.models.entries()) {
      const modelField = `${field}.models[${modelIndex}]`
      const model = object(modelValue, modelField)
      fields(model, modelField, ["id", "contextWindow", "maxOutputTokens", "supportsReasoning",
        "supportsTools", "supportsParallelTools", "supportsResponseId"])
      const modelId = nonEmptyString(model.id, `${modelField}.id`)
      if (modelIds.has(modelId)) throw new Error(`${modelField}.id 重复。`)
      modelIds.add(modelId)
      for (const key of ["contextWindow", "maxOutputTokens"]) optionalPositiveInteger(model, key, modelField)
      for (const key of ["supportsReasoning", "supportsTools", "supportsParallelTools", "supportsResponseId"]) {
        optionalBoolean(model, key, modelField)
      }
    }
  }

  if ("defaultModel" in value && !modelIds.has(nonEmptyString(value.defaultModel, "config.defaultModel"))) {
    throw new Error("config.defaultModel 未引用已配置的模型。")
  }

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
  return providerIds
}

export function checkCredentials(value: JsonObject, providerIds: ReadonlySet<string>): void {
  fields(value, "credentials", ["providers"])
  // V1 文档明确允许旧初始化器写入的 {} 作为尚未配置凭据的状态。
  if (!("providers" in value)) return
  if (!Array.isArray(value.providers)) throw new Error("credentials.providers 必须是数组。")
  const seen = new Set<string>()
  for (const [index, entry] of value.providers.entries()) {
    const field = `credentials.providers[${index}]`
    const credential = object(entry, field)
    fields(credential, field, ["providerId", "apiKey"])
    const providerId = nonEmptyString(credential.providerId, `${field}.providerId`)
    nonEmptyString(credential.apiKey, `${field}.apiKey`)
    if (seen.has(providerId)) throw new Error(`${field}.providerId 重复。`)
    if (!providerIds.has(providerId)) throw new Error(`${field}.providerId 未引用已配置的 Provider。`)
    seen.add(providerId)
  }
}

export function checkDefaultWorkspace(value: JsonObject): void {
  fields(value, "workspace", ["version", "sessions"])
  if (value.version !== 1) throw new Error("workspace.version 必须是 1。")
  if (!Array.isArray(value.sessions)) throw new Error("workspace.sessions 必须是数组。")
  const ids = new Set<string>()
  for (const [index, entry] of value.sessions.entries()) {
    const field = `workspace.sessions[${index}]`
    const session = object(entry, field)
    fields(session, field, ["id", "name", "createdAt", "updatedAt"])
    const id = nonEmptyString(session.id, `${field}.id`)
    nonEmptyString(session.name, `${field}.name`)
    if (ids.has(id)) throw new Error(`${field}.id 重复。`)
    ids.add(id)
    for (const key of ["createdAt", "updatedAt"]) {
      const timestamp = nonEmptyString(session[key], `${field}.${key}`)
      if (!isZonedIsoTimestamp(timestamp)) {
        throw new Error(`${field}.${key} 必须是带时区的 ISO 8601 时间。`)
      }
    }
  }
}
