/** OpenAI 各协议的内置连接地址和完整模型创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 按目录展示顺序保存的 OpenAI 协议资料。 */
export const OPENAI_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://api.openai.com/v1",
        models: [
            {
                supportsReasoning: true,
                name: "gpt-6-astra",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-6.1-sol",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-6.1-terra",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-6-luna",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-6-sol",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-5.6",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
        ],
    },
    {
        protocol: "responses",
        url: "https://api.openai.com/v1",
        models: [
            {
                supportsReasoning: true,
                name: "gpt-6-astra",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-6.1-sol",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-6.1-terra",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-6-luna",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-6-sol",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "gpt-5.6",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
        ],
    },
]
