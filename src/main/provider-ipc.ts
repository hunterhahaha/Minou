/** Provider 管理 IPC 与 Provider SQLite 写入之间的主进程边界。 */

import { randomUUID } from "node:crypto"

import type { ConfigFilePaths } from "./config-files.ts"
import { listCompatibleProviders, resolveCompatibleProvider } from "./compatible-providers.ts"
import type { CompatibleProviderDefinition } from "./compatible-providers.ts"
import {
  deleteModel,
  deleteProvider,
  listProviders,
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
  CompatibleProviderCreateInput,
  CompatibleProviderOption,
  CustomProviderCreateInput,
  ProviderModelInput,
  ProviderModelReference,
  ProviderModelUpdate,
  ProviderSummary,
} from "../preload/session-api.ts"
import type { Protocol } from "../../runtime/model/src/types.ts"
import { defaultReasoningConfig, isReasoningField, isReasoningLevels } from "../../runtime/model/src/reasoning.ts"

/**
 * 创建 Provider 时随请求提供的模型配置数组。
 */
type Models = ProviderModelInput[]

/** 新建模型未提供上下文窗口时使用的 Token 数。 */
const DEFAULT_MODEL_CONTEXT_WINDOW = 256_000

/** 新建模型未提供最大输出 Token 数时使用的 Token 数。 */
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 32_000

/** 已补齐创建默认值、可写入 Provider 数据库的模型配置。 */
type PersistableModelInput = Omit<ProviderModelInput, "contextWindow" | "maxOutputTokens" | "reasoningLevels" | "reasoningField"> & {
  contextWindow: number
  maxOutputTokens: number
  reasoningLevels: string[]
  reasoningField: { path: string[] }
}

/**
 * 验证模型协议是否属于 Runtime 支持的协议。
 * @param value Renderer 传入的未知协议值。
 * @returns value 是受支持协议时为 true。
 */
function isProtocol(value: unknown): value is Protocol {
  return value === "anthropic_messages" || value === "chat_completions" || value === "responses"
}

/**
 * 检查模型创建输入、可选数值字段的范围及允许的字段集合。
 * @param value Renderer 传入的未知模型对象。
 * @param protocol 模型所属 Provider 的协议，用于校验字段路径。
 * @returns value 符合创建输入约束、可在写库前补入默认值时为 true。
 */
function isModelInput(value: unknown, protocol: Protocol): value is ProviderModelInput {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim() === "") return false
  if (!isOptionalPositiveInteger(value.contextWindow) || !isOptionalPositiveInteger(value.maxOutputTokens)) return false
  if (value.reasoningLevels !== undefined && value.reasoningLevels !== null && !isReasoningLevels(value.reasoningLevels)) return false
  if (value.reasoningField !== undefined && value.reasoningField !== null && !isReasoningField(value.reasoningField, protocol)) return false
  return Object.keys(value).every((key) => ["name", "contextWindow", "maxOutputTokens", "reasoningLevels", "reasoningField"].includes(key))
}

/**
 * 在模型写入数据库前为缺失的限制字段补入创建默认值。
 * @param model 已通过 IPC 校验的模型创建配置。
 * @param protocol 模型所属 Provider 的协议，用于补入默认推理路径。
 * @returns 包含限制值和推理配置的完整模型配置。
 */
function completeModelInput(model: ProviderModelInput, protocol: Protocol): PersistableModelInput {
  const defaults = defaultReasoningConfig(protocol)
  return {
    name: model.name,
    contextWindow: model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    reasoningLevels: model.reasoningLevels ?? defaults.reasoningLevels,
    reasoningField: model.reasoningField ?? defaults.reasoningField,
  }
}

/**
 * 检查新 Provider 提交的模型列表。
 * @param value Renderer 传入的未知模型列表。
 * @param protocol Provider 的协议，用于校验每个模型的字段路径。
 * @returns 每条记录都符合模型创建契约时为 true。
 */
function isModels(value: unknown, protocol: Protocol): value is Models {
  return Array.isArray(value) && value.every((model) => isModelInput(model, protocol))
}

/**
 * 检查模型补丁；省略名称时保持原值，数值限制必须为正整数。
 * @param value Renderer 传入的未知补丁。
 * @param protocol 模型所属 Provider 的协议，用于校验字段路径。
 * @returns 补丁字段合法且至少有一个可更新字段时为 true。
 */
function isModelUpdate(value: unknown, protocol: Protocol): value is ProviderModelUpdate {
  if (!isRecord(value)) return false
  const fields = ["name", "contextWindow", "maxOutputTokens", "reasoningLevels", "reasoningField"] as const
  if (Object.keys(value).length === 0 || !Object.keys(value).every((key) => fields.includes(key as typeof fields[number]))) {
    return false
  }
  if ("name" in value) {
    const name = value.name
    if (typeof name !== "string" || name.trim() === "") return false
  }
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    if (field in value && !isPositiveInteger(value[field])) return false
  }
  if ("reasoningLevels" in value && !isReasoningLevels(value.reasoningLevels)) return false
  if ("reasoningField" in value && !isReasoningField(value.reasoningField, protocol)) return false
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
 * 注册 Provider 管理 IPC，校验 Renderer 输入后调用 Provider Store。
 * 创建 Provider 由多笔 Store 写入组成；中途失败时删除已创建的 Provider 及其关联数据。
 * @param ipcMain Electron 主进程 IPC 注册端口。
 * @param paths 启动阶段已初始化的 Provider 数据库路径。
 * @param compatibleProviders 已确认的内置供应商资料；测试可传入样例目录。
 * @throws Error 当 channel 重复注册、请求无效或 Provider 数据库操作失败时抛出。
 */
export function registerModelIpcHandlers(
  ipcMain: import("./session-ipc.ts").IpcMainHandlePort,
  paths: Pick<ConfigFilePaths, "providerDatabasePath">,
  compatibleProviders?: readonly CompatibleProviderDefinition[],
): void {
  const databasePath = paths.providerDatabasePath

  /**
   * 共同保存已校验的 Provider、模型和凭据，失败时清理已创建记录。
   * @param input 已确定类型、连接地址和完整模型来源的创建输入。
   * @returns 不含凭据的页面摘要。
   */
  function createProviderRecords(input: {
    type: "compatible" | "custom"; name: string; protocol: Protocol; apiKey: string; url: string; models: ProviderModelInput[]
  }): ProviderSummary {
    const normalizedModels = input.models.map((model) => ({
      ...completeModelInput(model, input.protocol),
      name: model.name.trim(),
      modelId: randomUUID(),
    }))
    const providerId = randomUUID()
    let providerSaved = false
    try {
      saveProvider(databasePath, { id: providerId, name: input.name, type: input.type, protocol: input.protocol, baseURL: input.url })
      providerSaved = true
      for (const model of normalizedModels) {
        const { modelId, name, ...fields } = model
        saveModel(databasePath, { modelId, name, providerId, ...fields })
      }
      setProviderApiKey(databasePath, providerId, input.apiKey)
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
      name: input.name,
      type: input.type,
      protocol: input.protocol,
      baseURL: input.url,
      models: normalizedModels.map((model) => {
        const isDefault = !defaultIncluded && model.modelId === defaultModel?.modelId &&
          providerId === defaultModel.providerId
        if (isDefault) defaultIncluded = true
        return modelSummary(model, isDefault)
      }),
    }
  }

  ipcMain.handle(PROVIDER_IPC_CHANNELS.listCompatibleProviders, (): CompatibleProviderOption[] =>
    listCompatibleProviders(compatibleProviders))

  ipcMain.handle(PROVIDER_IPC_CHANNELS.createCompatibleProvider, (_event, rawInput: unknown): ProviderSummary => {
    if (!isRecord(rawInput) || rawInput.type !== "compatible" || !isProtocol(rawInput.protocol) ||
        !isNonEmptyString(rawInput.name) || !isNonEmptyString(rawInput.apiKey) ||
        Object.keys(rawInput).length !== 4) throw new TypeError("已兼容供应商创建输入无效")
    const input = rawInput as unknown as CompatibleProviderCreateInput
    const name = input.name.trim()
    const definition = resolveCompatibleProvider(name, input.protocol, compatibleProviders)
    if (definition === undefined) throw new TypeError(`供应商 ${name} 不在已兼容目录中，或不支持 ${input.protocol} 协议。`)
    if (!isModels(definition.models, input.protocol)) throw new Error(`已兼容供应商 ${name} 的模型资料无效。`)
    return createProviderRecords({
      type: "compatible", name: definition.name, protocol: input.protocol, apiKey: input.apiKey,
      url: requireProviderURL(definition.url), models: definition.models,
    })
  })

  ipcMain.handle(PROVIDER_IPC_CHANNELS.createCustomProvider, (_event, rawInput: unknown): ProviderSummary => {
    if (!isRecord(rawInput) || rawInput.type !== "custom" || !isProtocol(rawInput.protocol) ||
        !isNonEmptyString(rawInput.name) || !isNonEmptyString(rawInput.apiKey) ||
        !isModels(rawInput.models, rawInput.protocol) || Object.keys(rawInput).length !== 6) {
      throw new TypeError("自定义供应商创建输入无效")
    }
    const input = rawInput as unknown as CustomProviderCreateInput
    return createProviderRecords({
      type: "custom", name: input.name.trim(), protocol: input.protocol, apiKey: input.apiKey,
      url: requireProviderURL(input.url), models: input.models,
    })
  })

  /**
   * 更新已有 Provider 的名称与可选 URL，并保留其协议、默认请求头、模型和凭据。
   */
  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.updateProvider,
    (_event, providerId: unknown, name: unknown, url: unknown): void => {
      const normalizedProviderId = requireNonEmptyString(providerId, "Provider ID")
      const providerName = requireNonEmptyString(name, "供应商名称")
      if (typeof url !== "string") throw new TypeError("URL 必须是字符串")
      const normalizedURL = url.trim() === "" ? "" : requireProviderURL(url)

      const existing = listProviders(databasePath).find((provider) => provider.id === normalizedProviderId)
      if (existing === undefined) throw new Error("Provider 不存在：" + normalizedProviderId)
      saveProvider(databasePath, {
        id: normalizedProviderId,
        name: providerName,
        type: existing.type,
        protocol: existing.protocol,
        ...(normalizedURL === "" ? {} : { baseURL: normalizedURL }),
        ...(existing.defaultHeaders === undefined ? {} : { defaultHeaders: existing.defaultHeaders }),
      })
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
    const provider = listProviders(databasePath).find((entry) => entry.id === normalizedProviderId)
    if (provider === undefined) throw new Error(`Provider ${normalizedProviderId} 不存在。`)
    if (!isModelInput(model, provider.protocol)) throw new TypeError("模型配置错误")
    const completedModel = completeModelInput(model, provider.protocol)
    const { name: inputName, ...fields } = completedModel
    const modelId = randomUUID()
    const name = inputName.trim()
    saveModel(databasePath, { modelId, name, providerId: normalizedProviderId, ...fields })
    return {
      providerId: normalizedProviderId,
      modelId,
      name,
      contextWindow: completedModel.contextWindow,
      maxOutputTokens: completedModel.maxOutputTokens,
      reasoningLevels: completedModel.reasoningLevels,
      reasoningField: completedModel.reasoningField,
    }
  })

  ipcMain.handle(
    PROVIDER_IPC_CHANNELS.updateModel,
    (_event, reference: unknown, update: unknown): void => {
      if (!isProviderModelReference(reference)) throw new TypeError("模型引用错误")
      const provider = listProviders(databasePath).find((entry) => entry.id === reference.providerId.trim())
      if (provider === undefined) throw new Error(`Provider ${reference.providerId} 不存在。`)
      if (!isModelUpdate(update, provider.protocol)) throw new TypeError("模型更新内容错误")
      const normalizedUpdate = update.name === undefined
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
 * 生成 Provider 模型摘要。
 * @param model Provider Store 返回的已保存模型记录。
 * @param isDefault 是否为当前有效默认引用的第一条记录。
 * @returns 包含模型身份、能力、推理配置及默认状态的页面摘要。
 */
function modelSummary(
  model: PersistableModelInput & { modelId: string },
  isDefault: boolean,
): ModelSummary {
  return {
    modelId: model.modelId,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    reasoningLevels: model.reasoningLevels,
    reasoningField: model.reasoningField,
    isDefault,
  }
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
 * 检查可省略或置空的正安全整数。
 * @param value 待检查的未知值。
 * @returns value 缺失、为 null 或为正安全整数时为 true。
 */
function isOptionalPositiveInteger(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || isPositiveInteger(value)
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
 * 校验 Provider 服务地址后返回去除首尾空格的输入，不重写路径或查询参数。
 * @param value Renderer 提交的必填服务地址。
 * @returns 可解析且包含主机的 HTTP 或 HTTPS 绝对地址。
 * @throws TypeError 当地址为空、格式无效或使用其他协议时抛出；IPC 将错误返回 Renderer。
 */
function requireProviderURL(value: unknown): string {
  const normalized = requireNonEmptyString(value, "URL")
  try {
    const parsed = new URL(normalized)
    if (/^https?:\/\//i.test(normalized) &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "") {
      return normalized
    }
  } catch {
    /** 地址解析失败统一交给下面的 IPC 输入错误。 */
  }
  throw new TypeError("URL 必须是有效的 HTTP 或 HTTPS 绝对地址")
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
