/** MiniMax 按地区与接入方式提供的 Chat Completions 创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 用于生成各接入入口的 MiniMax Chat Completions 模型资料。 */
const MINIMAX_CHAT_TEMPLATE: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://api.minimax.com/v1",
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
]

/** MINIMAX CN 入口；独立复制模型配置，避免入口间共享可变对象。 */
export const MINIMAX_CN_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {...structuredClone(MINIMAX_CHAT_TEMPLATE[0]!), url: "https://api.minimax.com/v1"},
]

/** MINIMAX INTERNATIONAL 入口；独立复制模型配置，避免入口间共享可变对象。 */
export const MINIMAX_INTERNATIONAL_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {...structuredClone(MINIMAX_CHAT_TEMPLATE[0]!), url: "https://api.minimax.io/v1"},
]
