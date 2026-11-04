/** 搜索工具的公开入口及成对登记；配置仅由可信宿主传入。 */
import { renderWebSearch } from "../render/web-search.ts"
import { isPlainRecord, registerTool } from "../tool-registry.ts"
import type { RenderRegistry, ToolArgumentValidation, ToolRegistry } from "../tool-registry.ts"
import { executeWebSearch } from "./search.ts"
import type { WebSearchInput } from "./types.ts"

export * from "./types.ts"
export * from "./store.ts"
export { executeWebSearch, WEB_SEARCH_TIMEOUT_MS } from "./search.ts"

/**
 * 登记只接收 query 的内置搜索工具及其结果整理器，不读取数据库或发起请求。
 * @param tools 宿主共享工具注册表。
 * @param renders 同名结果整理器注册表。
 * @param databasePath 用户 .nicode 下的搜索配置数据库绝对路径。
 * @throws Error 名称冲突或工具定义登记失败。
 */
export function registerWebSearchTool(tools: ToolRegistry, renders: RenderRegistry, databasePath: string): void {
  registerTool(tools, renders, {
    kind: "builtin",
    definition: {
      name: "web_search",
      description: "Search the web using the configured search provider. Returns result titles, URLs, snippets, and publication dates when available.",
      inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
    },
    validateArguments: validateInput,
    execute: (input, context) => executeWebSearch(databasePath, input, context.signal),
    render: renderWebSearch,
  })
}

/**
 * 检查模型参数只有非空白 query，不改写查询原文。
 * @param input 模型提供的未知参数。
 * @returns 复制的业务输入或参数错误。
 */
function validateInput(input: unknown): ToolArgumentValidation<WebSearchInput> {
  if (!isPlainRecord(input) || Object.keys(input).some((key) => key !== "query") || typeof input.query !== "string" || input.query.trim() === "") {
    return { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message: "web_search 只接受非空白字符串 query。" } }
  }
  return { success: true, data: { query: input.query } }
}
