/// <reference path="./wink-bm25-text-search.d.ts" />
import createBM25 from "wink-bm25-text-search"
import type { MCPCatalogTool } from "./types.ts"

/**
 * 文档和查询共用的通用分词，不对任何语言引入专用模型。
 * @param text Server 名称、工具名称、描述或查询。
 * @returns 小写词元；下划线、标点和 camelCase 边界被拆开。
 */
export function tokenizeMCPText(text: string): string[] {
  return text.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** 每次 Catalog 完整更新后替换的内存 BM25 索引。 */
export class MCPToolSearch {
  private engine: ReturnType<typeof createBM25> | undefined

  /**
   * 用完整 Catalog 创建新索引，失败时不替换旧索引。
   * @param tools 当前可用的具体工具，不读取其 Schema。
   * @throws Error BM25 建索引失败，调用方不得发布半份目录。
   */
  rebuild(tools: readonly MCPCatalogTool[]): void {
    if (tools.length === 0) { this.engine = undefined; return }
    const engine = createBM25()
    engine.defineConfig({ fldWeights: { text: 1 } })
    engine.definePrepTasks([tokenizeMCPText])
    for (const tool of tools) {
      engine.addDoc({ text: [tool.serverId, tool.originalToolName, tool.definition.description ?? ""].join("\n") }, tool.name)
    }
    // wink 要求至少三个文档；空占位不含词元，无法成为检索结果。
    for (let index = tools.length; index < 3; index++) engine.addDoc({ text: "" }, `empty_${index}`)
    engine.consolidate()
    this.engine = engine
  }

  /**
   * 检索至多八个实际匹配项。
   * @param query 非空白查询；空词元和空目录均返回空数组。
   * @returns 按 BM25 顺序排列的 Catalog 身份。
   */
  search(query: string): string[] {
    if (!this.engine || tokenizeMCPText(query).length === 0) return []
    return this.engine.search(query, 8).filter(([, score]) => score > 0).map(([id]) => id)
  }
}
