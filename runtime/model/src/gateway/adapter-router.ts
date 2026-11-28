import type { ModelConverter } from "./adapter.ts"
import { AnthropicAdapter } from "./anthropic-adapter.ts"
import { AnthropicMessagesAdapter } from "./anthropic-messages-adapter.ts"
import { ChatCompletionsAdapter } from "./openai-chat-completions-adapter.ts"
import { DeepSeekAdapter } from "./deepseek-adapter.ts"
import { OpenAIAdapter } from "./openai-adapter.ts"
import { ResponsesAdapter } from "./openai-responses-adapter.ts"
import { OpenRouterAdapter } from "./openrouter-adapter.ts"
import type { ModelConfig, Protocol } from "../types.ts"

/** 在指定协议下匹配 API 模型原名的规则。 */
export interface AdapterModelRule {
  /** 精确名称，或以星号结尾的大小写敏感前缀。 */
  readonly modelPattern: string
  /** 规则适用的协议。 */
  readonly protocol: Protocol
}

/** 厂商 Adapter 的进程级注册定义。 */
export interface VendorAdapterEntry {
  /** 用于路由错误诊断的条目名称。 */
  readonly name: string
  /** 配置中用于优先匹配的 Provider 名称和别名。 */
  readonly providerNames: readonly string[]
  /** Adapter 在请求构造和响应流转换中均支持的协议。 */
  readonly supportedProtocols: readonly Protocol[]
  /** Provider 名称未知时尝试的模型规则。 */
  readonly modelRules: readonly AdapterModelRule[]
  /** 跨 Turn 复用的转换器，单次流的状态由响应流转换器持有。 */
  readonly adapter: ModelConverter
}

/** 模型网关使用的厂商和通用 Adapter 定义。 */
export interface AdapterRegistry {
  /** 按名称和模型规则查找的专用条目。 */
  readonly vendors: readonly VendorAdapterEntry[]
  /** 每种协议必有一个通用 Adapter。 */
  readonly genericByProtocol: Readonly<Record<Protocol, ModelConverter>>
}

/** 仅包含可安全展示的路由信息，由 Turn 工厂原样传递。 */
export class AdapterRoutingError extends Error {}

/** 本进程使用的厂商转换器及三种协议的通用兜底。 */
export const MODEL_ADAPTER_REGISTRY: AdapterRegistry = Object.freeze({
  vendors: Object.freeze([{
    name: "DeepSeek",
    providerNames: ["DeepSeek", "deepseek", "Deepseek"],
    supportedProtocols: ["chat_completions", "responses", "anthropic_messages"],
    modelRules: [
      { modelPattern: "deepseek-*", protocol: "chat_completions" },
      { modelPattern: "deepseek-*", protocol: "responses" },
      { modelPattern: "deepseek-*", protocol: "anthropic_messages" },
    ],
    adapter: new DeepSeekAdapter(),
  } satisfies VendorAdapterEntry, {
    name: "OpenAI",
    providerNames: ["OpenAI"],
    supportedProtocols: ["responses", "chat_completions"],
    modelRules: [
      { modelPattern: "gpt*", protocol: "responses" },
      { modelPattern: "gpt*", protocol: "chat_completions" },
      { modelPattern: "GPT*", protocol: "responses" },
      { modelPattern: "GPT*", protocol: "chat_completions" },
    ],
    adapter: new OpenAIAdapter(),
  } satisfies VendorAdapterEntry, {
    name: "Anthropic",
    providerNames: ["Anthropic", "anthropic"],
    supportedProtocols: ["anthropic_messages"],
    modelRules: [{ modelPattern: "claude-*", protocol: "anthropic_messages" }],
    adapter: new AnthropicAdapter(),
  } satisfies VendorAdapterEntry, {
    name: "OpenRouter",
    providerNames: ["OpenRouter", "Openrouter", "openRouter", "openrouter", "Open Router"],
    supportedProtocols: ["chat_completions"],
    modelRules: [],
    adapter: new OpenRouterAdapter(),
  } satisfies VendorAdapterEntry]),
  genericByProtocol: Object.freeze({
    anthropic_messages: new AnthropicMessagesAdapter(),
    chat_completions: new ChatCompletionsAdapter(),
    responses: new ResponsesAdapter(),
  } satisfies Record<Protocol, ModelConverter>),
})

/**
 * 按 Provider 名称、模型规则、通用协议的顺序选择一个转换器。
 * @param registry 可用于本次查找的只读定义。
 * @param model 快照中的 API 模型名与选定协议。
 * @param providerName 快照中的 Provider 名称，未提供时从模型规则开始查找。
 * @returns 由该 Turn 复用的转换器。
 * @throws AdapterRoutingError 当厂商名称冲突、命中厂商不支持选定协议，或多个转换器命中模型规则时抛出。
 */
export function resolveModelConverter(
  registry: AdapterRegistry,
  model: Pick<ModelConfig, "name" | "protocol">,
  providerName?: string,
): ModelConverter {
  const { name, protocol } = model
  const normalizedName = providerName?.trim().toLowerCase()
  if (normalizedName) {
    const named = registry.vendors.filter((entry) => entry.providerNames.some(
      (alias) => alias.trim().toLowerCase() === normalizedName,
    ))
    if (named.length > 1) {
      throw new AdapterRoutingError(`Provider「${providerName}」匹配多个 Adapter：${named.map((entry) => entry.name).join("、")}。`)
    }
    const [entry] = named
    if (entry) {
      if (!entry.supportedProtocols.includes(protocol)) {
        throw new AdapterRoutingError(`Provider「${providerName}」匹配的 Adapter「${entry.name}」不支持协议 ${protocol}。`)
      }
      return entry.adapter
    }
  }

  const modeled = registry.vendors.filter((entry) => entry.supportedProtocols.includes(protocol) &&
    entry.modelRules.some(({ modelPattern, protocol: ruleProtocol }) =>
      ruleProtocol === protocol && (modelPattern.endsWith("*") ? name.startsWith(modelPattern.slice(0, -1)) : name === modelPattern),
    ))
  if (new Set(modeled.map((entry) => entry.adapter)).size > 1) {
    throw new AdapterRoutingError(`模型「${name}」与协议 ${protocol} 匹配多个 Adapter：${modeled.map((entry) => entry.name).join("、")}。`)
  }
  return modeled[0]?.adapter ?? registry.genericByProtocol[protocol]
}
