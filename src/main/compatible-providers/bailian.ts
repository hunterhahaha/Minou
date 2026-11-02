/**
 * 阿里云百炼按地域、协议独立维护的按量付费创建资料；API Key 必须属于所选地域。
 * 2026-11-02 核对官方模型详情、协议白名单、计费及下线公告。
 * 官方入口：https://help.aliyun.com/zh/model-studio/models。
 * Chat 的 supportsReasoning 表示当前字符串配置能否发送推理控制字段：
 * 仅接受布尔型 enable_thinking 的型号不发送该字段，沿用服务端默认行为；不表示模型没有原生思考能力。
 * 东京、法兰克福需要业务空间专属域名，未加入仅接收 API Key 的固定地址预设。
 */

import type {CompatibleProviderDefinition} from "../compatible-providers.ts"

/** 北京地域独立的协议与模型资料；按已核对地域收录，不共享可变模型对象。 */
export const BAILIAN_BEIJING_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [
            {
                name: "qwen3.8-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none","low","medium","xhigh"], reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none","low","medium","xhigh"], reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "qwen3.7-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.7-plus", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.7-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.6-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.6-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen-plus", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: false,
            },
            {
                name: "qwen-flash", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: false,
            },
            {
                name: "qwen-max", contextWindow: 32768, maxOutputTokens: 8192,
                supportsReasoning: false,
            },
            {
                name: "qwen3-coder-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-397b-a17b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-35b-a3b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://dashscope.aliyuncs.com/apps/anthropic",
        models: [
            {
                name: "qwen3.8-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-plus", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.6-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.6-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen-plus", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen-flash", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3-coder-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-397b-a17b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-35b-a3b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
        ],
    },
]

/** 新加坡地域独立的协议与模型资料；按已核对地域收录，不共享可变模型对象。 */
export const BAILIAN_SINGAPORE_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        models: [
            {
                name: "qwen3.8-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none","low","medium","xhigh"], reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none","low","medium","xhigh"], reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "qwen3.7-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.7-plus", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.7-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.6-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.6-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen-plus", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: false,
            },
            {
                name: "qwen-flash", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: false,
            },
            {
                name: "qwen-max", contextWindow: 32768, maxOutputTokens: 8192,
                supportsReasoning: false,
            },
            {
                name: "qwen3-coder-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-397b-a17b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-35b-a3b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
        models: [
            {
                name: "qwen3.8-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-plus", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.6-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.6-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen-plus", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen-flash", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3-coder-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-397b-a17b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-35b-a3b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
        ],
    },
]

/** 弗吉尼亚地域独立的协议与模型资料；按已核对地域收录，不共享可变模型对象。 */
export const BAILIAN_VIRGINIA_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
        models: [
            {
                name: "qwen3.8-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none","low","medium","xhigh"], reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none","low","medium","xhigh"], reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "qwen3.7-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.7-plus", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.7-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.6-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.6-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen-plus", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: false,
            },
            {
                name: "qwen-flash", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: false,
            },
            {
                name: "qwen3-coder-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-397b-a17b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-35b-a3b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://dashscope-us.aliyuncs.com/apps/anthropic",
        models: [
            {
                name: "qwen3.8-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-plus", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.6-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.6-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen-plus", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen-flash", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3-coder-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-397b-a17b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-35b-a3b", contextWindow: 262144, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
        ],
    },
]

/** 中国香港地域独立的协议与模型资料；按已核对地域收录，不共享可变模型对象。 */
export const BAILIAN_HONG_KONG_PROVIDERS: readonly CompatibleProviderDefinition[] = [
    {
        protocol: "chat_completions",
        url: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
        models: [
            {
                name: "qwen3.8-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none","low","medium","xhigh"], reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["none","low","medium","xhigh"], reasoningField: {path: ["reasoning_effort"]},
            },
            {
                name: "qwen3.7-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.7-plus", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.7-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: false,
            },
            {
                name: "qwen3.6-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.6-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen3.5-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: false,
            },
            {
                name: "qwen-plus", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: false,
            },
        ],
    },
    {
        protocol: "anthropic_messages",
        url: "https://cn-hongkong.dashscope.aliyuncs.com/apps/anthropic",
        models: [
            {
                name: "qwen3.8-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-max", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-plus", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.7-flash", contextWindow: 1000000, maxOutputTokens: 131072,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.6-plus", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.6-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen3.5-flash", contextWindow: 1000000, maxOutputTokens: 65536,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
            {
                name: "qwen-plus", contextWindow: 1000000, maxOutputTokens: 32768,
                supportsReasoning: true,
                reasoningLevels: ["enabled","disabled"], reasoningField: {path: ["thinking","type"]},
            },
        ],
    },
]

