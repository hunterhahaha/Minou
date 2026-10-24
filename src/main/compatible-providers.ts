/** 已兼容供应商的创建资料；当前目录为空，后续逐项填入真实供应商。 */

import type { Protocol, ReasoningField } from "../../runtime/model/src/types.ts"

/** 一个已兼容供应商在指定协议下的完整创建资料。 */
export interface CompatibleProviderDefinition {
  /** 内置目录中供用户选择的确切名称。 */
  name: string
  /** 该资料适用的唯一请求协议。 */
  protocol: Protocol
  /** 协议客户端的服务地址。 */
  url: string
  /** 按创建顺序保存的完整模型规格。 */
  models: Array<{
    name: string
    contextWindow: number
    maxOutputTokens: number
    reasoningLevels: string[]
    reasoningField: ReasoningField
  }>
}

/** 正式发布的内置目录；本次不填入尚未确认的供应商资料。 */
export const COMPATIBLE_PROVIDERS: readonly CompatibleProviderDefinition[] = []

/**
 * 从目录生成用户可选择的去重名称列表。
 * @param definitions 已确认的供应商资料，测试可传入样例目录。
 * @returns 按首次出现顺序排列的名称。
 */
export function listCompatibleProviderNames(definitions: readonly CompatibleProviderDefinition[] = COMPATIBLE_PROVIDERS): string[] {
  return [...new Set(definitions.map((definition) => definition.name))]
}

/**
 * 按名称和协议取得内置供应商创建资料。
 * @param name 用户选择的确切名称。
 * @param protocol 用户选择的协议。
 * @param definitions 已确认的供应商资料，测试可传入样例目录。
 * @returns 对应资料；目录不包含该组合时为 undefined。
 */
export function resolveCompatibleProvider(
  name: string,
  protocol: Protocol,
  definitions: readonly CompatibleProviderDefinition[] = COMPATIBLE_PROVIDERS,
): CompatibleProviderDefinition | undefined {
  return definitions.find((definition) => definition.name === name && definition.protocol === protocol)
}
