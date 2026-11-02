/** Kimi 按地区与接入方式提供的 Chat Completions 创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 用于生成各接入入口的 Kimi Chat Completions 模型资料。 */
const KIMI_CHAT_TEMPLATE: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://api.moonshot.cn/v1",
        models: [
            {
                supportsReasoning: true,
                name: "kimi-k3.1-pro",
                contextWindow: 1048576,
                maxOutputTokens: 131072,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "kimi-k3.1-pro-highspeed",
                contextWindow: 1048576,
                maxOutputTokens: 131072,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "kimi-k3",
                contextWindow: 1048576,
                maxOutputTokens: 1048576,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "kimi-k2.7-code",
                contextWindow: 262144,
                maxOutputTokens: 32768,
                reasoningLevels: ["enabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "kimi-k2.7-code-highspeed",
                contextWindow: 262144,
                maxOutputTokens: 32768,
                reasoningLevels: ["enabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "kimi-k2.6",
                contextWindow: 262144,
                maxOutputTokens: 32768,
                reasoningLevels: ["disabled", "enabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
        ],
    },
]

/** KIMI CN_API 入口；独立复制模型配置，避免入口间共享可变对象。 */
export const KIMI_CN_API_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {...structuredClone(KIMI_CHAT_TEMPLATE[0]!), url: "https://api.moonshot.cn/v1"},
]

/** KIMI CN_CODING_PLAN 入口；独立复制模型配置，避免入口间共享可变对象。 */
export const KIMI_CN_CODING_PLAN_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {...structuredClone(KIMI_CHAT_TEMPLATE[0]!), url: "https://api.kimi.com/coding/v1"},
]

/** KIMI INTERNATIONAL_API 入口；独立复制模型配置，避免入口间共享可变对象。 */
export const KIMI_INTERNATIONAL_API_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {...structuredClone(KIMI_CHAT_TEMPLATE[0]!), url: "https://api.moonshot.ai/v1"},
]

/** KIMI INTERNATIONAL_CODING_PLAN 入口；独立复制模型配置，避免入口间共享可变对象。 */
export const KIMI_INTERNATIONAL_CODING_PLAN_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {...structuredClone(KIMI_CHAT_TEMPLATE[0]!), url: "https://api.kimi.ai/coding/v1"},
]
