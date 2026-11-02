/** DeepSeek 各协议的内置连接地址和完整模型创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 按目录展示顺序保存的 DeepSeek 协议资料。 */
export const DEEPSEEK_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://api.deepseek.com",
        models: [
            {
                supportsReasoning: true,
                name: "deepseek-flash",
                contextWindow: 1048576,
                maxOutputTokens: 393216,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "deepseek-v4-pro",
                contextWindow: 1048576,
                maxOutputTokens: 393216,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
        ],
    },
    {
        protocol: "responses",
        url: "https://api.deepseek.com",
        models: [
            {
                supportsReasoning: true,
                name: "deepseek-flash",
                contextWindow: 1048576,
                maxOutputTokens: 393216,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "deepseek-v4-pro",
                contextWindow: 1048576,
                maxOutputTokens: 393216,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://api.deepseek.com/anthropic",
        models: [
            {
                supportsReasoning: true,
                name: "deepseek-flash",
                contextWindow: 1048576,
                maxOutputTokens: 393216,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["output_config", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "deepseek-v4-pro",
                contextWindow: 1048576,
                maxOutputTokens: 393216,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["output_config", "effort"]},
            },
        ],
    },
]
