/** wink 未随包提供声明；只声明 MCP 检索实际使用的接口。 */
declare module "wink-bm25-text-search" {
  /** 单字段内存 BM25 引擎。 */
  interface Engine {
    /** @param config 检索字段和权重。 */
    defineConfig(config: { fldWeights: { text: number } }): void
    /** @param tasks 文档和查询的统一分词流水线。 */
    definePrepTasks(tasks: Array<(text: string) => string[]>): void
    /** @param document 检索文本。 @param id Catalog 身份。 */
    addDoc(document: { text: string }, id: string): void
    /** 完成索引，之后不再追加文档。 */
    consolidate(): void
    /** @param query 查询。 @param limit 最多返回项。 @returns 相关性降序的身份和分值。 */
    search(query: string, limit: number): Array<[string, number]>
  }
  /** @returns 独立的空 BM25 引擎。 */
  export default function createBM25(): Engine
}
