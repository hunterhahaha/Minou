/** Gemini API 的 OpenAI 兼容入口与少量文本模型预设。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 当前稳定模型的规格与推理档位；工具签名回传仍受统一消息结构限制。 */
export const GEMINI_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://generativelanguage.googleapis.com/v1beta/openai/",
        models: ["gemini-4-argon", "gemini-3.8-flash"].map((name) => ({
            name,
            contextWindow: 1048576,
            maxOutputTokens: 65536,
            supportsReasoning: true,
            reasoningLevels: ["low", "medium", "high"],
            reasoningField: {path: ["reasoning_effort"]},
        })),
    },
]
