/** 已兼容供应商的创建资料；当前目录为空，后续逐项填入真实供应商。 */

import type { Protocol, ReasoningField } from "../../runtime/model/src/types.ts"
import type { CompatibleProviderOption } from "../preload/session-api.ts"

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
export const COMPATIBLE_PROVIDERS: readonly CompatibleProviderDefinition[] = [
  {
    name: "DeepSeek",
    protocol: "chat_completions",
    url: "https://api.deepseek.com",
    models: [
      {
        name: "deepseek-flash",
        contextWindow: 1048576,
        maxOutputTokens: 393216,
        reasoningLevels: ["low", "high", "max"],
        reasoningField: { path: ["reasoning_effort"] },
      },
      {
        name: "deepseek-v4-pro",
        contextWindow: 1048576,
        maxOutputTokens: 393216,
        reasoningLevels: ["low", "high", "max"],
        reasoningField: { path: ["reasoning_effort"] },
      },
    ],
  },
  {
    name: "DeepSeek",
    protocol: "responses",
    url: "https://api.deepseek.com",
    models: [
      {
        name: "deepseek-flash",
        contextWindow: 1048576,
        maxOutputTokens: 393216,
        reasoningLevels: ["low", "high", "max"],
        reasoningField: { path: ["reasoning", "effort"] },
      },
      {
        name: "deepseek-v4-pro",
        contextWindow: 1048576,
        maxOutputTokens: 393216,
        reasoningLevels: ["low", "high", "max"],
        reasoningField: { path: ["reasoning", "effort"] },
      },
    ],
  },
  {
    name: "DeepSeek",
    protocol: "anthropic_messages",
    url: "https://api.deepseek.com/anthropic",
    models: [
      {
        name: "deepseek-flash",
        contextWindow: 1048576,
        maxOutputTokens: 393216,
        reasoningLevels: ["low", "high", "max"],
        reasoningField: { path: ["output_config", "effort"] },
      },
      {
        name: "deepseek-v4-pro",
        contextWindow: 1048576,
        maxOutputTokens: 393216,
        reasoningLevels: ["low", "high", "max"],
        reasoningField: { path: ["output_config", "effort"] },
      },
    ],
  },
]

/**
 * 按名称汇总已兼容供应商，将同名资料的协议合并为去重数组。
 * @param definitions 已确认的供应商资料，测试可传入样例目录。
 * @returns 每个名称一项的目录摘要，名称及协议均保留首次出现顺序。
 */
export function listCompatibleProviders(definitions: readonly CompatibleProviderDefinition[] = COMPATIBLE_PROVIDERS): CompatibleProviderOption[] {
  const options: CompatibleProviderOption[] = []
  for (const { name, protocol } of definitions) {
    const option = options.find((entry) => entry.name === name)
    if (option === undefined) {
      options.push({ name, protocol: [protocol] })
    } else if (!option.protocol.includes(protocol)) {
      option.protocol.push(protocol)
    }
  }
  return options
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
