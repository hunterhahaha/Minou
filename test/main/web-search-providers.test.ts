/** 验证新增服务商的请求、参数边界、持久化执行和真实 JMESPath 映射；不请求远端。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listWebSearchProviderDefinitions } from "../../src/main/web-search-providers.ts"
import { buildWebSearchProviderInput, readWebSearchProviderParameters } from "../../runtime/tools/src/web-search/provider-template.ts"
import { initializeWebSearchDatabase, saveWebSearchProvider, setActiveWebSearchProvider } from "../../runtime/tools/src/web-search/store.ts"
import { executeWebSearch } from "../../runtime/tools/src/web-search/search.ts"

/**
 * 用服务商响应样本验证从目录到搜索结果的完整数据流，并恢复全局 fetch。
 * @returns 所有新增服务商的模板、执行和映射验证完成。
 * @throws Error 任一请求、边界或结果断言失败。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "minou-search-providers-"))
  const originalFetch = globalThis.fetch
  try {
    const database = join(root, "search.sqlite")
    initializeWebSearchDatabase(database)
    const title = "搜索结果", url = "https://example.com/result", date = "2026-11-01T00:00:00Z"
    const cases = [
      { name: "DeepSeek Search", endpoint: "https://api.deepseek.com/v1/tools/search", header: "Authorization", key: "Bearer test-key", count: "count", max: 50,
        fixed: { need_content: false },
        response: { results: [{ title, url, summary: "长摘要", snippet: "短摘要", date }, { title, url, summary: "", snippet: "回退摘要", date: null }] },
        expected: [{ title, url, snippet: "长摘要", publishedAt: date }, { title, url, snippet: "回退摘要", publishedAt: null }], empty: { results: [] } },
      { name: "Exa", endpoint: "https://api.exa.ai/search", header: "x-api-key", key: "test-key", count: "numResults", max: 100,
        fixed: { type: "auto", contents: { highlights: true } },
        response: { results: [{ title, url, highlights: ["摘录一", "摘录二"], publishedDate: date }, { title, url }] },
        expected: [{ title, url, snippet: "摘录一\n摘录二", publishedAt: date }, { title, url, snippet: "", publishedAt: null }], empty: { results: [] } },
      { name: "Bocha", endpoint: "https://api.bocha.cn/v1/web-search", header: "Authorization", key: "Bearer test-key", count: "count", max: 50,
        fixed: { freshness: "noLimit", summary: true },
        response: { code: 200, data: { webPages: { value: [{ name: title, url, summary: "长摘要", snippet: "短摘要", datePublished: date }, { name: title, url, snippet: "回退摘要" }] } } },
        expected: [{ title, url, snippet: "长摘要", publishedAt: date }, { title, url, snippet: "回退摘要", publishedAt: null }], empty: { code: 200, data: { webPages: { value: [] } } } },
    ]
    const definitions = listWebSearchProviderDefinitions()
    assert.deepEqual(definitions.map((entry) => entry.name), ["Tavily", ...cases.map((entry) => entry.name)])
    const query = '中文 "quoted" \\ path\n${query} & # + ?'
    for (const sample of cases) {
      const definition = definitions.find((entry) => entry.name === sample.name)!
      const key = "test-key"
      const input = buildWebSearchProviderInput(definition, { APIKEY: key })
      const parameters = readWebSearchProviderParameters(definition, input.requestJson)
      assert.deepEqual(parameters, { APIKEY: key, [sample.count]: 5 })
      assert.deepEqual(buildWebSearchProviderInput(definition, parameters), input)
      if (sample.header === "Authorization") {
        for (const authorization of [key, "Bearer "]) {
          const invalid = JSON.parse(input.requestJson)
          invalid.headers.Authorization = authorization
          assert.throws(() => readWebSearchProviderParameters(definition, JSON.stringify(invalid)))
        }
      }
      const escapedKey = 'key"\\\n特殊${query}'
      assert.equal(readWebSearchProviderParameters(definition, buildWebSearchProviderInput(definition, { APIKEY: escapedKey }).requestJson).APIKEY, escapedKey)
      assert.throws(() => buildWebSearchProviderInput(definition, { APIKEY: " " }))
      for (const count of [1, sample.max, String(sample.max)]) {
        const saved = buildWebSearchProviderInput(definition, { APIKEY: sample.key, [sample.count]: count })
        assert.equal(JSON.parse(JSON.parse(saved.requestJson).body)[sample.count], Number(count))
      }
      for (const count of [0, -1, sample.max + 1, 1.5, "invalid"]) {
        assert.throws(() => buildWebSearchProviderInput(definition, { APIKEY: sample.key, [sample.count]: count }))
      }
      saveWebSearchProvider(database, { ...input, id: sample.name })
      setActiveWebSearchProvider(database, sample.name)
      let response: unknown = sample.response
      let status = 200
      let calls = 0
      globalThis.fetch = async (requestUrl, options) => {
        calls++
        assert.equal(requestUrl, sample.endpoint)
        assert.equal(options?.method, "POST")
        const headers = new Headers(options?.headers)
        assert.equal(headers.get(sample.header), sample.key)
        assert.equal(headers.get("Content-Type"), "application/json")
        assert.deepEqual(JSON.parse(options?.body as string), { query, [sample.count]: 5, ...sample.fixed })
        return Response.json(response, { status })
      }
      assert.deepEqual(await executeWebSearch(database, { query }, new AbortController().signal, (text) => text.length), { results: sample.expected })
      response = sample.empty
      assert.deepEqual(await executeWebSearch(database, { query }, new AbortController().signal, (text) => text.length), { results: [] })
      status = 401
      assert.deepEqual(await executeWebSearch(database, { query }, new AbortController().signal, (text) => text.length),
        { source: "tool", code: "WEB_SEARCH_HTTP_ERROR", message: "搜索服务返回 HTTP 401。" })
      assert.equal(calls, 3)
    }
    console.log("web-search-providers: 三个服务商的请求、边界、编辑往返、持久化执行、响应映射、空结果和 HTTP 错误通过")
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
