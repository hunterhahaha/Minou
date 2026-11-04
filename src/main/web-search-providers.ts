/** 显式汇总随项目发布的搜索服务商定义。 */
import { TAVILY_PROVIDER } from "./web-search-providers/tavily.ts"
import { DEEPSEEK_PROVIDER } from "./web-search-providers/deepseek.ts"
import { EXA_PROVIDER } from "./web-search-providers/exa.ts"
import { BOCHA_PROVIDER } from "./web-search-providers/bocha.ts"
import type { WebSearchProviderDefinition } from "../../runtime/tools/src/web-search/types.ts"

/** 创建资料目录；不会自动覆盖数据库中的配置。 */
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProviderDefinition[] = [TAVILY_PROVIDER, DEEPSEEK_PROVIDER, EXA_PROVIDER, BOCHA_PROVIDER]

/**
 * 返回与内置目录隔离的定义，供 IPC 返回。
 * @returns 按目录顺序排列的独立定义副本。
 */
export function listWebSearchProviderDefinitions(): WebSearchProviderDefinition[] {
  return structuredClone([...WEB_SEARCH_PROVIDERS])
}
