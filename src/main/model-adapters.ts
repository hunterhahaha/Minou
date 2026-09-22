/**
 * 单个 Turn 的磁盘模型选择到 Protocol Adapter 的装配链。
 *
 * 本模块不保存配置、凭据、规格、SDK Client 或 Adapter。每次调用都重新读取两份
 * 持久化配置，只解析 `meta.json.currentModel` 指定的唯一模型，并创建新的 Adapter。
 */

import { CredentialStore } from "../../runtime/credential/src/index.ts"
import { createModelAdapter } from "../../runtime/model/src/adapter.ts"
import type { ProtocolClientOptions } from "../../runtime/model/src/adapter.ts"
import type {
  ModelAdapter,
  ModelConfig,
  ModelRef,
  Protocol,
} from "../../runtime/model/src/types.ts"
import {
  readModelAdapterConfigSnapshot,
} from "./config-files.ts"
import type {
  ConfigFilePaths,
  ValidatedProtocolConfig,
} from "./config-files.ts"

/** 创建单个 Turn Adapter 前已经解析完成的模型与协议客户端参数。 */
export interface TurnModelAdapterSpecification {
  /** 已补入所属 Provider 与唯一协议的运行时模型配置。 */
  modelConfig: ModelConfig
  /** 当前磁盘凭据与协议连接参数形成的客户端输入。 */
  clientOptions: ProtocolClientOptions
}

/**
 * 每次从磁盘重新加载配置，并解析一个 ModelRef 的 Adapter 构造规格。
 *
 * 配置结构检查保证所有 Provider 恰好包含一个协议；本函数仍在使用点断言该约束，
 * 并要求 Session Meta 中的协议与 Provider 的唯一协议一致。
 *
 * @param paths 启动时确定、每 Turn 重新读取的 config 与 credentials 路径。
 * @param model 本 Turn 已经从 Session `meta.json` 独立重读的模型引用。
 * @returns 只属于本次调用的模型配置与客户端参数。
 * @throws Error 当配置或凭据损坏、Provider/Model/协议不匹配或 API Key 缺失时抛出。
 * 错误包含相关文件路径和模型引用，但不会包含 API Key。
 */
export async function resolveTurnModelAdapterSpecification(
  paths: Pick<ConfigFilePaths, "configPath" | "credentialsPath">,
  model: ModelRef,
): Promise<TurnModelAdapterSpecification> {
  const snapshot = await readModelAdapterConfigSnapshot(paths)
  const reference = formatModelRef(model)
  const provider = snapshot.config.providers.find((entry) => entry.id === model.providerId)
  if (provider === undefined) {
    throw new Error(
      `无法为 ${reference} 创建 Adapter：${paths.configPath} 中不存在 Provider ${model.providerId}。`,
    )
  }

  const protocolEntries = Object.entries(provider.protocols) as Array<[
    Protocol,
    ValidatedProtocolConfig,
  ]>
  if (protocolEntries.length !== 1) {
    throw new Error(
      `无法为 ${reference} 创建 Adapter：${paths.configPath} 中 Provider ${provider.id} 必须恰好包含一个协议，当前为 ${protocolEntries.length} 个。`,
    )
  }
  const [protocol, protocolConfig] = protocolEntries[0]
  if (model.protocol !== protocol) {
    throw new Error(
      `无法为 ${reference} 创建 Adapter：Session 协议与 ${paths.configPath} 中 Provider ${provider.id} 的唯一协议 ${protocol} 不一致。`,
    )
  }

  const configuredModel = provider.models.find((entry) => entry.id === model.modelId)
  if (configuredModel === undefined) {
    throw new Error(
      `无法为 ${reference} 创建 Adapter：${paths.configPath} 中 Provider ${provider.id} 不包含模型 ${model.modelId}。`,
    )
  }

  const credentialStore = new CredentialStore(snapshot.credentials.providers ?? [])
  const apiKey = credentialStore.getApiKey(provider.id)
  if (apiKey === undefined) {
    throw new Error(
      `无法为 ${reference} 创建 Adapter：${paths.credentialsPath} 中缺少 Provider ${provider.id} 的凭据。`,
    )
  }

  return {
    modelConfig: {
      ...configuredModel,
      providerId: provider.id,
      protocol,
    },
    clientOptions: {
      apiKey,
      ...(protocolConfig.baseURL === undefined
        ? {}
        : { baseURL: protocolConfig.baseURL }),
      ...(protocolConfig.defaultHeaders === undefined
        ? {}
        : { defaultHeaders: { ...protocolConfig.defaultHeaders } }),
    },
  }
}

/**
 * 为一个 Turn 创建全新的模型 Adapter。
 *
 * @param paths 每次调用都重新读取的配置与凭据路径。
 * @param model 已从当前 Session Meta 重新读取的模型引用。
 * @returns 只供当前 Turn 全部 AgentLoop Step 共用的 Adapter。
 * @throws Error 当配置解析、凭据读取或协议 Adapter 构造失败时抛出；不返回半构建实例。
 */
export async function createTurnModelAdapter(
  paths: Pick<ConfigFilePaths, "configPath" | "credentialsPath">,
  model: ModelRef,
): Promise<ModelAdapter> {
  const specification = await resolveTurnModelAdapterSpecification(paths, model)
  try {
    return createModelAdapter(specification.modelConfig, specification.clientOptions)
  } catch {
    throw new Error(
      `无法为 ${formatModelRef(model)} 创建 Adapter；模型配置来自 ${paths.configPath}，凭据来自 ${paths.credentialsPath}。`,
    )
  }
}

/** @param model 用于不含凭据的错误定位的完整模型引用。 */
function formatModelRef(model: ModelRef): string {
  return `ModelRef(${model.providerId}/${model.protocol}/${model.modelId})`
}
