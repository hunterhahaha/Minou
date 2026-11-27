/** 已兼容供应商目录与按名称、协议查询创建资料的入口。 */

import type {Protocol, ReasoningField} from "../../runtime/model/src/types.ts"
import type {CompatibleProviderOption} from "../preload/session-api.ts"
import {DEEPSEEK_PROVIDERS} from "./compatible-providers/deepseek.ts"
import {
    KIMI_CN_API_PROVIDERS,
    KIMI_CN_CODING_PLAN_PROVIDERS,
    KIMI_INTERNATIONAL_API_PROVIDERS,
    KIMI_INTERNATIONAL_CODING_PLAN_PROVIDERS
} from "./compatible-providers/kimi.ts"
import {BIGMODEL_API_PROVIDERS, BIGMODEL_CODING_PLAN_PROVIDERS} from "./compatible-providers/bigmodel.ts"
import {ZAI_API_PROVIDERS, ZAI_CODING_PLAN_PROVIDERS} from "./compatible-providers/zai.ts"
import {MINIMAX_CN_PROVIDERS, MINIMAX_INTERNATIONAL_PROVIDERS} from "./compatible-providers/minimax.ts";
import {OPENAI_PROVIDERS} from "./compatible-providers/openai.ts"
import {ANTHROPIC_PROVIDERS} from "./compatible-providers/anthropic.ts"
import {OPENROUTER_PROVIDERS} from "./compatible-providers/openrouter.ts"
import {GEMINI_PROVIDERS} from "./compatible-providers/gemini.ts"
import {NVIDIA_PROVIDERS} from "./compatible-providers/nvidia.ts"
import {
    BAILIAN_BEIJING_PROVIDERS,
    BAILIAN_SINGAPORE_PROVIDERS,
    BAILIAN_VIRGINIA_PROVIDERS,
    BAILIAN_HONG_KONG_PROVIDERS
} from "./compatible-providers/bailian.ts"

/** 一个已兼容供应商在指定协议下的完整创建资料。 */
export interface CompatibleProviderDefinition {
    /** 该资料适用的唯一请求协议。 */
    protocol: Protocol
    /** 协议客户端的服务地址。 */
    url: string
    /** 按创建顺序保存的完整模型规格。 */
    models: Array<{
        name: string
        contextWindow: number
        maxOutputTokens: number
        /** 是否支持发送思考模式配置。 */
        supportsReasoning: boolean
        reasoningLevels?: string[] | null
        reasoningField?: ReasoningField | null
    }>
}

/** 以供应商确切名称为键，按顺序保存各协议创建资料的目录。 */
export type CompatibleProviderCatalog = Readonly<Record<string, readonly CompatibleProviderDefinition[]>>

/** 汇总独立供应商文件的内置目录；供应商名称只保存在字典键中。 */
export const COMPATIBLE_PROVIDERS: CompatibleProviderCatalog = {
    "DeepSeek": DEEPSEEK_PROVIDERS,
    "Kimi 国内 API": KIMI_CN_API_PROVIDERS,
    "Kimi 国内 Coding Plan": KIMI_CN_CODING_PLAN_PROVIDERS,
    "Kimi 国际 API": KIMI_INTERNATIONAL_API_PROVIDERS,
    "Kimi 国际 Coding Plan": KIMI_INTERNATIONAL_CODING_PLAN_PROVIDERS,
    "BigModel API": BIGMODEL_API_PROVIDERS,
    "BigModel Coding Plan": BIGMODEL_CODING_PLAN_PROVIDERS,
    "Z.AI API": ZAI_API_PROVIDERS,
    "Z.AI Coding Plan": ZAI_CODING_PLAN_PROVIDERS,
    "MiniMax 国内": MINIMAX_CN_PROVIDERS,
    "MiniMax 国际": MINIMAX_INTERNATIONAL_PROVIDERS,
    "OpenAI": OPENAI_PROVIDERS,
    "Anthropic": ANTHROPIC_PROVIDERS,
    "OpenRouter": OPENROUTER_PROVIDERS,
    "Gemini": GEMINI_PROVIDERS,
    "NVIDIA": NVIDIA_PROVIDERS,
    "阿里云百炼（北京）": BAILIAN_BEIJING_PROVIDERS,
    "阿里云百炼（新加坡）": BAILIAN_SINGAPORE_PROVIDERS,
    "阿里云百炼（弗吉尼亚）": BAILIAN_VIRGINIA_PROVIDERS,
    "阿里云百炼（中国香港）": BAILIAN_HONG_KONG_PROVIDERS,
}

/**
 * 按目录键生成供应商摘要，并对每个供应商的协议去重。
 * @param definitions 按供应商名称索引的资料目录，测试可传入样例目录。
 * @returns 每个供应商一项的摘要，名称及协议均保留目录中的出现顺序。
 */
export function listCompatibleProviders(definitions: CompatibleProviderCatalog = COMPATIBLE_PROVIDERS): CompatibleProviderOption[] {
    return Object.entries(definitions).map(([name, entries]) => ({
        name,
        protocol: [...new Set(entries.map(({protocol}) => protocol))],
    }))
}

/**
 * 按名称定位供应商，再查找该供应商的协议创建资料。
 * @param name 用户选择的确切名称，仅匹配目录自身的键。
 * @param protocol 用户选择的协议。
 * @param definitions 按供应商名称索引的资料目录，测试可传入样例目录。
 * @returns 首条匹配协议的资料；名称或协议不存在时为 undefined。
 */
export function resolveCompatibleProvider(
    name: string,
    protocol: Protocol,
    definitions: CompatibleProviderCatalog = COMPATIBLE_PROVIDERS,
): CompatibleProviderDefinition | undefined {
    if (!Object.hasOwn(definitions, name)) return undefined
    return definitions[name]?.find((definition) => definition.protocol === protocol)
}
