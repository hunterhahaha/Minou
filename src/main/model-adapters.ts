/**
 * 单个 Turn 的磁盘模型选择到 Protocol Adapter 的装配链。
 *
 * 本模块不保存配置、凭据、规格、SDK Client 或 Adapter。每次调用都重新读取
 * Provider 数据库中当前引用指定的唯一模型，并创建新的 Adapter。
 */

import { CredentialStore } from "../../runtime/credential/src/index.ts"
import { AdapterRoutingError } from "../../runtime/model/src/gateway/adapter-router.ts"
import { createModelAdapter } from "../../runtime/model/src/gateway/adapter.ts"
import type { ProtocolClientOptions } from "../../runtime/model/src/gateway/adapter.ts"
import type {
  ModelAdapter,
  ModelConfig,
  ModelRef,
} from "../../runtime/model/src/types.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { readTurnProviderSnapshot } from "./provider-store.ts"

/** 创建单个 Turn Adapter 前已经解析完成的模型与协议客户端参数。 */
export interface TurnModelAdapterSpecification {
  /** Provider 快照中的名称，用于选择厂商 Adapter。 */
  providerName: string
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
 * @param model 本 Turn 已选定的模型引用。
 * @param supportsReasoning 本次调用的思考能力覆盖值，省略时采用数据库配置。
 * @returns 只属于本次调用的模型配置与客户端参数。
 * @throws Error 当数据库损坏、Provider/Model/协议不匹配或 API Key 缺失时抛出。
 * 错误包含数据库路径和模型引用，但不会包含 API Key。
 */
export async function resolveTurnModelAdapterSpecification(
  paths: Pick<ConfigFilePaths, "providerDatabasePath">,
  model: ModelRef,
  supportsReasoning?: boolean,
): Promise<TurnModelAdapterSpecification> {
  const reference = formatModelRef(model)
  const snapshot = readTurnProviderSnapshot(paths.providerDatabasePath, model)
  const modelConfig = { ...snapshot.model, supportsReasoning: supportsReasoning ?? snapshot.model.supportsReasoning }
  if (modelConfig.supportsReasoning && !modelConfig.reasoningLevels.includes(model.reasoningLevel)) {
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
  return {
    providerName: snapshot.provider.name,
    modelConfig,
    clientOptions: {
      apiKey,
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
 * @param model 当前 Turn 选定的模型引用。
 * @param supportsReasoning 本次调用的思考能力覆盖值，省略时采用数据库配置。
 * @returns 当前 Turn 共用的 Adapter，附带同一配置快照的预算及思考能力。
 * @throws Error 当配置解析、凭据读取、Adapter 路由或 SDK 构造失败时抛出。
 */
export async function createTurnModelAdapter(
  paths: Pick<ConfigFilePaths, "providerDatabasePath">,
  model: ModelRef,
  supportsReasoning?: boolean,
): Promise<ModelAdapter> {
  const { providerName, modelConfig, clientOptions } = await resolveTurnModelAdapterSpecification(paths, model, supportsReasoning)
  try {
    return Object.assign(createModelAdapter(modelConfig, clientOptions, providerName), {
      contextWindow: modelConfig.contextWindow,
      maxOutputTokens: modelConfig.maxOutputTokens,
      ...(modelConfig.supportsReasoning
        ? { reasoningLevels: [...modelConfig.reasoningLevels] }
        : {}),
    })
  } catch (error) {
    if (error instanceof AdapterRoutingError) throw error
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
