/**
 * Protocol Adapter 的创建入口（第 6 节）。
 *
 * 三个 Adapter 实现同一个 `ModelAdapter` 接口，差异只在协议内部；本文件只负责按
 * `ModelConfig.protocol` 选择实现，让上层（SessionRuntime / AgentLoop）不需要 switch。
 * 当前宿主在每个 Turn 开始时调用该入口；本模块不缓存 SDK Client 或 Adapter。
 *
 * 架构依据：开发备忘录第 6 节（模型协议层：Provider → Protocol → Models）、
 *          第 3 节（CredentialStore 为 Adapter 提供凭据）、
 *          第 7 节（全局 Dispatcher 必须早于任一 Adapter 初始化）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 3 / 4 / 5
 */

import { createAnthropicAdapter } from "./anthropic.ts"
import { createChatCompletionsAdapter } from "./chat-completions.ts"
import { createResponsesAdapter } from "./responses.ts"
import type { ModelAdapter, ModelConfig, Protocol } from "./types.ts"

/**
 * 创建一个 Adapter 所需的协议侧连接参数。
 *
 * 凭据本身由 `CredentialStore` 按 providerId 提供（第 3 节），本接口只接收它的结果，
 * 因此这里没有 providerId 字段 —— Adapter 不查凭据，只被喂凭据。
 *
 * `baseURL` 与 `defaultHeaders` 是协议兼容厂商的必要出口（第 35.1 节的 Provider 配置尚未定义），
 * 先作为可选参数留在这里；等 `config.json` 的结构确定后由配置层填。
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
 * 也要从它有默认值。模型切换 = 换实例，与第 6 节"Provider 与 Model 可动态切换"一致。
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
