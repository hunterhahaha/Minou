/** Anthropic 官方 Messages 入口与当前三档 Claude 模型创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 官方模型规格与 effort 档位；不包含需要额外开通的专用模型。 */
export const ANTHROPIC_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "anthropic_messages",
        url: "https://api.anthropic.com",
        nativeHistory: {
            modelNamePrefix: "claude",
            policy: { name: "anthropic", protocol: "anthropic_messages", inlineToolChanges: true },
        },
        models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((name) => ({
            name,
            contextWindow: 1000000,
            maxOutputTokens: 128000,
            supportsReasoning: true,
            reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
            reasoningField: {path: ["output_config", "effort"]},
        })),
    },
]
