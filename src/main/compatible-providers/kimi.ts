/** Kimi 各协议的内置连接地址和完整模型创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 按目录展示顺序保存的 Kimi 协议资料。 */
export const KIMI_PROVIDERS: readonly CompatibleProviderDefinition[] = [
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
    {
        protocol: "responses",
        url: "https://api.moonshot.cn/v1",
        models: [
            {
                supportsReasoning: true,
                name: "kimi-k3",
                contextWindow: 1048576,
                maxOutputTokens: 1048576,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://api.moonshot.cn/anthropic",
        models: [
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
