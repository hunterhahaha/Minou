/**
 * 按 ModelConfig.protocol 选择协议工厂，每次创建绑定指定模型的新 Adapter。
 *
 * 连接参数由调用方提供，本入口不读取凭据或数据库，也不缓存 SDK Client 与 Adapter。
 */

import { createAnthropicAdapter } from "./anthropic.ts"
import { createChatCompletionsAdapter } from "./chat-completions.ts"
import { createResponsesAdapter } from "./responses.ts"
import type { ModelAdapter, ModelConfig, Protocol } from "./types.ts"

/**
 * 创建一个 Adapter 所需的协议侧连接参数。
 *
 * 凭据本身由 `CredentialStore` 按 providerId 提供，本接口只接收它的结果，
 * 因此这里没有 providerId 字段 —— Adapter 不查凭据，只被喂凭据。
 *
 * `baseURL` 与 `defaultHeaders` 由宿主从 Provider 配置快照提供；
 * 未传地址时使用 SDK 默认值。
 */
export interface ProtocolClientOptions {
  /** 由 CredentialStore 按 Provider 提供的 API Key。 */
  apiKey: string
  /** 协议客户端使用的 Provider 地址；缺失时使用 SDK 默认地址。 */
  baseURL?: string
  /** 传给协议客户端的额外请求头。 */
  defaultHeaders?: Record<string, string>
}

/**
 * 按协议的创建函数表。
 *
 * 用 Record 而不是 switch，是为了让"新增协议必须同时补上创建函数"由类型检查保证：
 * `Protocol` 增加取值时，这张表会立刻缺少对应键而编译失败。
 */
const ADAPTER_FACTORIES: Record<
  Protocol,
  (config: ModelConfig, options: ProtocolClientOptions) => ModelAdapter
> = {
  anthropic_messages: createAnthropicAdapter,
  chat_completions: createChatCompletionsAdapter,
  responses: createResponsesAdapter,
}

/**
 * 为某个模型创建其协议对应的 Adapter。
 *
 * 一个 Adapter 实例绑定一个模型：请求校验需要它，Anthropic 的必填 `max_tokens`
 * 也要从它有默认值。切换模型时由宿主创建新实例。
 *
 * @param config 要绑定的 Provider、协议和模型配置。
 * @param options 协议客户端所需的凭据、地址和额外请求头。
 * @returns 与 `config.protocol` 对应、已绑定该模型的 Adapter。
 * @throws 当配置的协议没有对应创建函数时由协议工厂访问失败。
 */
export function createModelAdapter(
  config: ModelConfig,
  options: ProtocolClientOptions,
): ModelAdapter {
  return ADAPTER_FACTORIES[config.protocol](config, options)
}
