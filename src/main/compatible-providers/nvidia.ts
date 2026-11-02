/** NVIDIA 托管 NIM API 的 OpenAI 兼容模型创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 少量支持工具调用的模型；输出规格依据托管端点而非模型权重上限。 */
export const NVIDIA_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://integrate.api.nvidia.com/v1",
        models: [
            {
                name: "openai/gpt-oss-120b",
                contextWindow: 131072,
                maxOutputTokens: 4096,
                supportsReasoning: true,
                reasoningLevels: ["low", "medium", "high"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "meta/llama-3.3-70b-instruct",
                contextWindow: 131072,
                maxOutputTokens: 4096,
                supportsReasoning: false,
            },
        ],
    },
]
