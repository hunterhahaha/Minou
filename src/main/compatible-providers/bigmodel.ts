/** BigModel 各协议的内置连接地址和完整模型创建资料。 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 按目录展示顺序保存的 BigModel 协议资料。 */
export const BIGMODEL_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://open.bigmodel.cn/api/paas/v4",
        models: [
            {
                supportsReasoning: true,
                name: "glm-5.2",
                contextWindow: 1048576,
                maxOutputTokens: 131072,
                reasoningLevels: [
                    "none", "minimal", "low", "medium",
                    "high", "xhigh", "max",
                ],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                supportsReasoning: true,
                name: "glm-5.1",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-5",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-5-turbo",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-4.7",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-4.7-flash",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-4.6",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://open.bigmodel.cn/api/anthropic",
        models: [
            {
                supportsReasoning: true,
                name: "glm-5.2",
                contextWindow: 1048576,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-5.1",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-5",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-5-turbo",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-4.7",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-4.7-flash",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                supportsReasoning: true,
                name: "glm-4.6",
                contextWindow: 204800,
                maxOutputTokens: 131072,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
        ],
    },
    // Responses 兼容性待实测
    {
        protocol: "responses",
        url: "https://open.bigmodel.cn/api/v1",
        models: [
            {
                supportsReasoning: true,
                name: "glm-5.2",
                contextWindow: 1048576,
                maxOutputTokens: 131072,
                reasoningLevels: ["none", "high", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
        ],
    },
]
