/**
 * BigModel 标准 API 与 Coding Plan 的独立创建资料，2026-11-02 核对官方文档。
 * 标准 API 使用标准 Key，Coding Plan 使用个人或团队套餐 Key；目录不判断账号权益。
 * 普通 API 仅收录已核对的 Chat Completions；套餐不包含尚未开放的 FlashX。
 * 来源及协议白名单见 docs/configuration-and-storage.md 的 GLM 接入说明。
 */
import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 标准 API：当前主流、官方仍列出的通用 GLM 模型；不收录专属法律或独立媒体模型。 */
export const BIGMODEL_API_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://open.bigmodel.cn/api/paas/v4",
        models: [
            {
                name: "glm-5.3",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "glm-5.3-flash",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "glm-5.3-flashx",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "glm-5.2",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "glm-5.1",
                contextWindow: 200000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                name: "glm-5",
                contextWindow: 200000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                name: "glm-5-turbo",
                contextWindow: 200000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                name: "glm-4.7",
                contextWindow: 200000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                name: "glm-4.7-flash",
                contextWindow: 200000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
            {
                name: "glm-4.6",
                contextWindow: 200000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled", "disabled"],
                reasoningField: {path: ["thinking", "type"]},
            },
        ],
    },
]

/** Coding Plan：按协议收录官方接入指南确认的型号，独立保存模型资料。 */
export const BIGMODEL_CODING_PLAN_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://open.bigmodel.cn/api/coding/paas/v4",
        models: [
            {
                name: "glm-5.3",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "glm-5.3-flash",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "glm-5.2",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none", "high", "max"],
                reasoningField: {path: ["reasoning_effort"]},
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://open.bigmodel.cn/api/anthropic",
        models: [
            {
                name: "glm-5.3",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["output_config", "effort"]},
            },
            {
                name: "glm-5.3-flash",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["low", "high", "max"],
                reasoningField: {path: ["output_config", "effort"]},
            },
        ],
    },
    {
        protocol: "responses",
        url: "https://open.bigmodel.cn/api/v1",
        models: [
            {
                name: "glm-5.3",
                contextWindow: 1000000,
                maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["high", "max"],
                reasoningField: {path: ["reasoning", "effort"]},
            },
        ],
    },
]
