/** MiniMax 各协议的内置连接地址和完整模型创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 按目录展示顺序保存的 MiniMax 协议资料。 */
export const MINIMAX_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://api.minimaxi.com/v1",
        models: [
            {
                supportsReasoning: true,
                name: "MiniMax-M3.1-Flash",
                contextWindow: 1000000,
                maxOutputTokens: 524288,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "MiniMax-M3",
                contextWindow: 1000000,
                maxOutputTokens: 524288,
                reasoningLevels: ["disabled", "adaptive"],
                reasoningField: {path: ["thinking", "type"]},
            },
        ],
    },
    {
        protocol: "responses",
        url: "https://api.minimaxi.com/v1",
        models: [
            {
                supportsReasoning: true,
                name: "MiniMax-M3.1-Flash",
                contextWindow: 1000000,
                maxOutputTokens: 524288,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "MiniMax-M3",
                contextWindow: 1000000,
                maxOutputTokens: 524288,
                reasoningLevels: ["none", "minimal", "low", "medium", "high"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://api.minimaxi.com/anthropic",
        models: [
            {
                supportsReasoning: true,
                name: "MiniMax-M3.1-Flash",
                contextWindow: 1000000,
                maxOutputTokens: 524288,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["output_config", "effort"]},
            },
            {
                supportsReasoning: true,
                name: "MiniMax-M3",
                contextWindow: 1000000,
                maxOutputTokens: 524288,
                reasoningLevels: ["disabled", "adaptive"],
                reasoningField: {path: ["thinking", "type"]},
            },
        ],
    },
]
