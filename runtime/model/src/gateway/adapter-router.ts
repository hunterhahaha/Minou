import type { ModelConverter } from "./adapter.ts"
import { AnthropicAdapter } from "./anthropic-adapter.ts"
import { AnthropicMessagesAdapter } from "./anthropic-messages-adapter.ts"
import { ChatCompletionsAdapter } from "./openai-chat-completions-adapter.ts"
import { DeepSeekAdapter } from "./deepseek-adapter.ts"
import { GeminiAdapter } from "./gemini-adapter.ts"
import { GLMAdapter } from "./glm-adapter.ts"
import { BIGMODEL_NAMES, ZAI_NAMES } from "./glm/provider.ts"
import { KimiAdapter } from "./kimi-adapter.ts"
import { MiniMaxAdapter } from "./minimax-adapter.ts"
import { NvidiaAdapter } from "./nvidia-adapter.ts"
import { OpenAIAdapter } from "./openai-adapter.ts"
import { ResponsesAdapter } from "./openai-responses-adapter.ts"
import { OpenRouterAdapter } from "./openrouter-adapter.ts"
import { XaiAdapter } from "./xai-adapter.ts"
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
    name: "GLM",
    providerNames: [...BIGMODEL_NAMES, ...ZAI_NAMES],
    supportedProtocols: ["chat_completions", "responses", "anthropic_messages"],
    modelRules: [
      { modelPattern: "glm-*", protocol: "chat_completions" },
      { modelPattern: "GLM-*", protocol: "chat_completions" },
      { modelPattern: "glm-*", protocol: "responses" },
      { modelPattern: "GLM-*", protocol: "responses" },
      { modelPattern: "glm-*", protocol: "anthropic_messages" },
      { modelPattern: "GLM-*", protocol: "anthropic_messages" },
    ],
    adapter: new GLMAdapter(),
  } satisfies VendorAdapterEntry, {
    name: "Gemini",
    providerNames: ["Gemini"],
    supportedProtocols: ["chat_completions"],
    modelRules: [
      { modelPattern: "gemini-*", protocol: "chat_completions" },
      { modelPattern: "GEMINI-*", protocol: "chat_completions" },
    ],
    adapter: new GeminiAdapter(),
  } satisfies VendorAdapterEntry, {
    name: "Kimi",
    providerNames: ["Kimi", "Kimi 国内 API", "Kimi 国内 Coding Plan", "Kimi 国际 API", "Kimi 国际 Coding Plan"],
    supportedProtocols: ["chat_completions"],
    modelRules: [
      { modelPattern: "kimi-*", protocol: "chat_completions" },
      { modelPattern: "KIMI-*", protocol: "chat_completions" },
      { modelPattern: "k3", protocol: "chat_completions" },
      { modelPattern: "k3-256k", protocol: "chat_completions" },
      { modelPattern: "k3.1-pro", protocol: "chat_completions" },
      { modelPattern: "k3.1-pro-highspeed", protocol: "chat_completions" },
    ],
    adapter: new KimiAdapter(),
  } satisfies VendorAdapterEntry, {
    name: "MiniMax",
    providerNames: ["MiniMax", "MiniMax 国内", "MiniMax 国际"],
    supportedProtocols: ["responses", "chat_completions"],
    modelRules: [
      { modelPattern: "MiniMax-*", protocol: "responses" },
      { modelPattern: "MiniMax-*", protocol: "chat_completions" },
      { modelPattern: "minimax-*", protocol: "responses" },
      { modelPattern: "minimax-*", protocol: "chat_completions" },
      { modelPattern: "MINIMAX-*", protocol: "responses" },
      { modelPattern: "MINIMAX-*", protocol: "chat_completions" },
    ],
    adapter: new MiniMaxAdapter(),
  } satisfies VendorAdapterEntry, {
    name: "NVIDIA",
    providerNames: ["NVIDIA"],
    supportedProtocols: ["chat_completions"],
    modelRules: [],
    adapter: new NvidiaAdapter(),
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
  } satisfies VendorAdapterEntry, {
    name: "Xai",
    providerNames: ["xAI"],
    supportedProtocols: ["responses", "chat_completions"],
    modelRules: [
      { modelPattern: "grok*", protocol: "responses" },
      { modelPattern: "grok*", protocol: "chat_completions" },
      { modelPattern: "GROK*", protocol: "responses" },
      { modelPattern: "GROK*", protocol: "chat_completions" },
    ],
    adapter: new XaiAdapter(),
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
