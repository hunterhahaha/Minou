/**
 * 单个 Turn 的磁盘模型选择到 Protocol Adapter 的装配链。
 *
 * 本模块不保存配置、凭据、规格、SDK Client 或 Adapter。每次调用都重新读取
 * Provider 数据库中 Session Meta 的 currentModel 指定的唯一模型，并创建新的 Adapter。
 */

import { CredentialStore } from "../../runtime/credential/src/index.ts"
import { createModelAdapter } from "../../runtime/model/src/adapter.ts"
import type { ProtocolClientOptions } from "../../runtime/model/src/adapter.ts"
import type {
  ModelAdapter,
  ModelConfig,
  ModelRef,
} from "../../runtime/model/src/types.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { COMPATIBLE_PROVIDERS } from "./compatible-providers.ts"
import { readTurnProviderSnapshot } from "./provider-store.ts"

/** 创建单个 Turn Adapter 前已经解析完成的模型与协议客户端参数。 */
export interface TurnModelAdapterSpecification {
  /** 已补入所属 Provider 与唯一协议的运行时模型配置。 */
  modelConfig: ModelConfig
  /** 当前数据库凭据与协议连接参数形成的客户端输入。 */
  clientOptions: ProtocolClientOptions
}

/**
 * 每次从 Provider 数据库重新加载配置，并解析一个 ModelRef 的 Adapter 构造规格。
 *
 * 数据库结构保证所有 Provider 恰好包含一个协议，读取时核对 Session Meta 中的协议。
 *
 * @param paths 启动时确定、每 Turn 重新读取的 Provider 数据库路径。
 * @param model 本 Turn 已经从 Session Meta 独立重读的模型引用。
 * @returns 只属于本次调用的模型配置与客户端参数。
 * @throws Error 当数据库损坏、Provider/Model/协议不匹配或 API Key 缺失时抛出。
 * 错误包含数据库路径和模型引用，但不会包含 API Key。
 */
export async function resolveTurnModelAdapterSpecification(
  paths: Pick<ConfigFilePaths, "providerDatabasePath">,
  model: ModelRef,
): Promise<TurnModelAdapterSpecification> {
  const reference = formatModelRef(model)
  const snapshot = readTurnProviderSnapshot(paths.providerDatabasePath, model)
  if (snapshot.model.supportsReasoning && !snapshot.model.reasoningLevels.includes(model.reasoningLevel)) {
    throw new Error(`无法为 ${reference} 创建 Adapter：推理等级 ${model.reasoningLevel} 不在模型支持列表中。`)
  }
  const credentialStore = new CredentialStore(snapshot.credential === undefined ? [] : [snapshot.credential])
  const apiKey = credentialStore.getApiKey(snapshot.provider.id)
  if (apiKey === undefined) {
    throw new Error(
      `无法为 ${reference} 创建 Adapter：${paths.providerDatabasePath} 中缺少 Provider ${snapshot.provider.id} 的凭据。`,
    )
  }

  const baseURL = snapshot.provider.baseURL
  const nativeHistory = baseURL === undefined ? undefined : Object.values(COMPATIBLE_PROVIDERS).flat().find((definition) =>
    definition.nativeHistory !== undefined && definition.protocol === model.protocol &&
    normalizeServiceURL(definition.url) === normalizeServiceURL(baseURL) &&
    definition.models.some(({ name }) => name === snapshot.model.name),
  )?.nativeHistory
  return {
    modelConfig: snapshot.model,
    clientOptions: {
      apiKey,
      ...(nativeHistory === undefined ? {} : { nativeHistory }),
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(snapshot.provider.defaultHeaders === undefined
        ? {}
        : { defaultHeaders: { ...snapshot.provider.defaultHeaders } }),
    },
  }
}

/**
 * 为一个 Turn 创建全新的模型 Adapter。
 *
 * @param paths 每次调用都重新读取的 Provider 数据库路径。
 * @param model 已从当前 Session Meta 重新读取的模型引用。
 * @returns 当前 Turn 共用的 Adapter，附带同一配置快照的预算及思考能力。
 * @throws Error 当配置解析、凭据读取或协议 Adapter 构造失败时抛出；不返回半构建实例。
 */
export async function createTurnModelAdapter(
  paths: Pick<ConfigFilePaths, "providerDatabasePath">,
  model: ModelRef,
): Promise<ModelAdapter> {
  const specification = await resolveTurnModelAdapterSpecification(paths, model)
  try {
    return Object.assign(createModelAdapter(specification.modelConfig, specification.clientOptions), {
      contextWindow: specification.modelConfig.contextWindow,
      maxOutputTokens: specification.modelConfig.maxOutputTokens,
      ...(specification.modelConfig.supportsReasoning
        ? { reasoningLevels: [...specification.modelConfig.reasoningLevels] }
        : {}),
    })
  } catch {
    throw new Error(
      `无法为 ${formatModelRef(model)} 创建 Adapter；模型配置与凭据来自 ${paths.providerDatabasePath}。`,
    )
  }
}

/**
 * 将完整模型引用格式化为不包含凭据的诊断文本。
 *
 * @param model 用于不含凭据的错误定位的完整模型引用。
 * @returns 包含 Provider、协议、模型身份、名称及推理等级的定位文本。
 */
function formatModelRef(model: ModelRef): string {
  return `ModelRef(${model.providerId}/${model.protocol}/${model.modelId}/${model.name})`
}

/**
 * 规范化兼容规则比较用的服务 URL，保留服务路径、凭据、查询与片段。
 * @param value 待比较的服务地址。
 * @returns 规范化地址，无效地址返回原值。
 */
function normalizeServiceURL(value: string): string {
  try {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url.href
  } catch {
    return value
  }
}
