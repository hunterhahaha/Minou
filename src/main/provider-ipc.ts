/** Provider 管理 IPC 与 Provider SQLite 写入之间的主进程边界。 */

import { randomUUID } from "node:crypto"

import type { ConfigFilePaths } from "./config-files.ts"
import {
  deleteModel,
  deleteProvider,
  readDefaultModel,
  saveModel,
  saveProvider,
  setDefaultModel,
  setProviderApiKey,
  updateModel as updateProviderModel,
} from "./provider-store.ts"
import { PROVIDER_IPC_CHANNELS } from "../preload/session-api.ts"
import type {
  ModelAppend,
  ModelSummary,
  ProviderModelInput,
  ProviderModelReference,
  ProviderModelUpdate,
  ProviderSummary,
} from "../preload/session-api.ts"
import type { Protocol } from "../../runtime/model/src/types.ts"

type Models = ProviderModelInput[]

/**
 * 验证模型协议是否属于 Runtime 支持的协议。
 * @param value Renderer 传入的未知协议值。
 * @returns value 是受支持协议时为 true。
 */
function isProtocol(value: unknown): value is Protocol {
  return value === "anthropic_messages" || value === "chat_completions" || value === "responses"
}

/**
 * 检查模型创建输入及数据库约束要求的字段范围。
 * @param value Renderer 传入的未知模型对象。
 * @returns value 可保存为一条模型记录时为 true。
 */
function isModelInput(value: unknown): value is ProviderModelInput {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim() === "") return false
  if (!isPositiveInteger(value.contextWindow) || !isOptionalPositiveInteger(value.maxOutputTokens)) return false
  return isOptionalBoolean(value.supportsReasoning) && isOptionalBoolean(value.supportsTools) &&
    isOptionalBoolean(value.supportsParallelTools) && isOptionalBoolean(value.supportsResponseId)
}

/**
 * 检查新 Provider 提交的模型列表。
 * @param value Renderer 传入的未知模型列表。
 * @returns 每条记录都符合模型创建契约时为 true。
 */
function isModels(value: unknown): value is Models {
  return Array.isArray(value) && value.every(isModelInput)
}

/**
 * 检查模型补丁；至少提交一个已知字段，名称可用 null 表示不更新，能力字段可用 null 清除。
 * @param value Renderer 传入的未知补丁。
 * @returns 补丁字段合法且至少有一个可更新字段时为 true。
 */
function isModelUpdate(value: unknown): value is ProviderModelUpdate {
  if (!isRecord(value)) return false
  const fields = [
    "name", "contextWindow", "maxOutputTokens", "supportsReasoning", "supportsTools",
    "supportsParallelTools", "supportsResponseId",
  ] as const
  if (Object.keys(value).length === 0 || !Object.keys(value).every((key) => fields.includes(key as typeof fields[number]))) {
    return false
  }
  for (const field of ["name"] as const) {
    if (field in value) {
      const name = value[field]
      if (name === null) continue
      if (typeof name !== "string") {
        return false
      }
      if (name.trim() === "") {
        return false
      }
    }
  }
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    if (field in value && !isNullablePositiveInteger(value[field])) return false
  }
  for (const field of ["supportsReasoning", "supportsTools", "supportsParallelTools", "supportsResponseId"] as const) {
    if (field in value && !isNullableBoolean(value[field])) return false
  }
  return true
}

/**
 * 检查 Provider 与模型组合引用。
 * @param value Renderer 传入的未知引用。
 * @returns value 含有非空 Provider 与 Model ID 时为 true。
 */
function isProviderModelReference(value: unknown): value is ProviderModelReference {
  return isRecord(value) && isNonEmptyString(value.providerId) && isNonEmptyString(value.modelId)
}

/**
 * 注册 Provider 管理的七个 IPC handler，校验 Renderer 输入后调用 Provider Store。
 * 创建 Provider 由多笔 Store 写入组成；中途失败时删除已创建的 Provider 及其关联数据。
 * @param ipcMain Electron 主进程 IPC 注册端口。
 * @param paths 启动阶段已初始化的 Provider 数据库路径。
 * @throws Error 当 channel 重复注册、请求无效或 Provider 数据库操作失败时抛出。
 */
export function registerModelIpcHandlers(
  ipcMain: Electron.IpcMain,
  paths: Pick<ConfigFilePaths, "providerDatabasePath">,
): void {
  const databasePath = paths.providerDatabasePath

  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.createProvider,
    (_event, name: unknown, apiKey: unknown, protocol: unknown, url: unknown, models: unknown): ProviderSummary => {
      const providerName = requireNonEmptyString(name, "供应商名称")
      if (!isNonEmptyString(apiKey)) throw new TypeError("API key 必须是非空字符串")
      if (!isProtocol(protocol)) throw new TypeError("协议错误")
      const baseURL = requireNonEmptyString(url, "URL")
      if (!isModels(models)) throw new TypeError("模型列表错误")

      const normalizedModels = models.map((model) => ({ ...model, name: model.name.trim(), modelId: randomUUID() }))
      const providerId = randomUUID()
      let providerSaved = false
      try {
        saveProvider(databasePath, { id: providerId, name: providerName, protocol, baseURL })
        providerSaved = true
        for (const model of normalizedModels) {
          const { modelId, name, ...fields } = model
          saveModel(databasePath, { modelId, name, providerId, ...fields })
        }
        setProviderApiKey(databasePath, providerId, apiKey)
      } catch (error) {
        if (providerSaved) {
          try {
            deleteProvider(databasePath, providerId)
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Provider 创建失败，且清理未完成。")
          }
        }
        throw error
      }

      const defaultModel = readDefaultModel(databasePath)
      let defaultIncluded = false
      return {
        providerId,
        name: providerName,
        protocol,
        models: normalizedModels.map((model) => {
          const isDefault = !defaultIncluded && model.modelId === defaultModel?.modelId &&
            providerId === defaultModel.providerId
          if (isDefault) defaultIncluded = true
          return modelSummary(model, isDefault)
        }),
      }
    },
  )

  ipcMain.handle(PROVIDER_IPC_CHANNELS.deleteProvider, (_event, providerId: unknown): void => {
    deleteProvider(databasePath, requireNonEmptyString(providerId, "Provider ID"))
  })

  ipcMain.handle(PROVIDER_IPC_CHANNELS.updateApiKey, (_event, providerId: unknown, apiKey: unknown): void => {
    const normalizedProviderId = requireNonEmptyString(providerId, "Provider ID")
    if (apiKey !== null && !isNonEmptyString(apiKey)) throw new TypeError("API key 必须是非空字符串或 null")
    setProviderApiKey(databasePath, normalizedProviderId, apiKey)
  })

  ipcMain.handle(PROVIDER_IPC_CHANNELS.createModel, (_event, providerId: unknown, model: unknown): ModelAppend => {
    const normalizedProviderId = requireNonEmptyString(providerId, "Provider ID")
    if (!isModelInput(model)) throw new TypeError("模型配置错误")
    const { name: inputName, ...fields } = model
    const modelId = randomUUID()
    const name = inputName.trim()
    saveModel(databasePath, { modelId, name, providerId: normalizedProviderId, ...fields })
    return { providerId: normalizedProviderId, modelId, name, contextWindow: model.contextWindow }
  })

  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.updateModel,
    (_event, reference: unknown, update: unknown): void => {
      if (!isProviderModelReference(reference)) throw new TypeError("模型引用错误")
      if (!isModelUpdate(update)) throw new TypeError("模型更新内容错误")
      const normalizedUpdate = update.name === undefined || update.name === null
        ? update
        : { ...update, name: update.name.trim() }
      updateProviderModel(databasePath, normalizeReference(reference), normalizedUpdate)
    },
  )

  ipcMain.handle(PROVIDER_IPC_CHANNELS.deleteModel, (_event, reference: unknown): void => {
    if (!isProviderModelReference(reference)) throw new TypeError("模型引用错误")
    const normalized = normalizeReference(reference)
    deleteModel(databasePath, normalized.providerId, normalized.modelId)
  })

  ipcMain.handle(PROVIDER_IPC_CHANNELS.setDefaultModel, (_event, reference: unknown): void => {
    if (reference !== null && !isProviderModelReference(reference)) throw new TypeError("默认模型引用错误")
    setDefaultModel(
      databasePath,
      reference === null ? null : normalizeReference(reference),
    )
  })
}

/**
 * 生成与创建请求一致的模型摘要。
 * @param model 已校验的创建模型输入。
 * @param isDefault 是否为当前有效默认引用的第一条记录。
 * @returns 包含模型身份、名称、有效上下文窗口及默认状态的页面摘要。
 */
function modelSummary(model: {modelId: string, name: string, contextWindow: number}, isDefault: boolean): ModelSummary {
  return { modelId: model.modelId, name: model.name, contextWindow: model.contextWindow, isDefault }
}

/**
 * 检查正安全整数。
 * @param value 待检查的未知值。
 * @returns value 为正安全整数时为 true。
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/**
 * 检查可选正安全整数。
 * @param value 待检查的未知值。
 * @returns value 缺失或为正安全整数时为 true。
 */
function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || isPositiveInteger(value)
}

/**
 * 检查允许清除的正安全整数。
 * @param value 待检查的未知值。
 * @returns value 为 null 或正安全整数时为 true。
 */
function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value)
}

/**
 * 检查可选布尔值。
 * @param value 待检查的未知值。
 * @returns value 缺失或为布尔值时为 true。
 */
function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean"
}

/**
 * 检查允许清除的布尔值。
 * @param value 待检查的未知值。
 * @returns value 为 null 或布尔值时为 true。
 */
function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean"
}

/**
 * 检查非空字符串。
 * @param value 待检查的未知值。
 * @returns value 是去除首尾空格后仍非空的字符串时为 true。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * 验证并规范化必填字符串。
 * @param value 待检查的未知值。
 * @param field 字段的错误提示名称。
 * @returns 去除首尾空格后的字符串。
 * @throws TypeError 当 value 不是非空字符串时抛出。
 */
function requireNonEmptyString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) throw new TypeError(`${field}必须是非空字符串`)
  return value.trim()
}

/**
 * 规范化 Provider 与模型引用中的字符串。
 * @param reference 已验证的 Provider 与模型引用。
 * @returns 去除首尾空格后的引用对象。
 */
function normalizeReference(reference: ProviderModelReference): ProviderModelReference {
  return { providerId: reference.providerId.trim(), modelId: reference.modelId.trim() }
}

/**
 * 把未知值缩窄为非数组对象。
 * @param value 待检查的值。
 * @returns value 是普通对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
