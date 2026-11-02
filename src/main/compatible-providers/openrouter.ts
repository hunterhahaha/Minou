/** OpenRouter 的少量主流模型预设，使用平台统一的推理字段。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** Chat Completions 创建资料；大输出窗口模型保守限制单次输出为 65,536。 */
export const OPENROUTER_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://openrouter.ai/api/v1",
        models: [
            {
                name: "anthropic/claude-sonnet-5.5",
                contextWindow: 1000000,
                maxOutputTokens: 128000,
                supportsReasoning: true,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                name: "anthropic/claude-opus-5.5",
                contextWindow: 1000000,
                maxOutputTokens: 128000,
                supportsReasoning: true,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                name: "openai/gpt-6.1-sol",
                contextWindow: 1050000,
                maxOutputTokens: 128000,
                supportsReasoning: true,
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                name: "google/gemini-4-argon",
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["low", "medium", "high"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
            {
                name: "moonshotai/kimi-k3.1-pro",
                contextWindow: 1048576,
                maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["none", "low", "high", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
        ],
    },
]
