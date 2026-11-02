/** 已兼容供应商目录与按名称、协议查询创建资料的入口。 */

import type {Protocol, ReasoningField} from "../../runtime/model/src/types.ts"
import type {CompatibleProviderOption} from "../preload/session-api.ts"
import {DEEPSEEK_PROVIDERS} from "./compatible-providers/deepseek.ts"
import {KIMI_PROVIDERS} from "./compatible-providers/kimi.ts"
import {BIGMODEL_PROVIDERS} from "./compatible-providers/bigmodel.ts"
import {MINIMAX_PROVIDERS} from "./compatible-providers/minimax.ts";
import {OPENAI_PROVIDERS} from "./compatible-providers/openai.ts"

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
    DeepSeek: DEEPSEEK_PROVIDERS,
    Kimi: KIMI_PROVIDERS,
    BigModel: BIGMODEL_PROVIDERS,
    MiniMax: MINIMAX_PROVIDERS,
    OpenAI: OPENAI_PROVIDERS,
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
