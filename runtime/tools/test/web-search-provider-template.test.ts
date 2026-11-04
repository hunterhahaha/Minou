/** Tavily 模板、数字边界、转义和编辑往返验证，不请求远端。 */
import assert from "node:assert/strict"
import { buildWebSearchProviderInput, readWebSearchProviderParameters } from "../src/web-search/provider-template.ts"
import { listWebSearchProviderDefinitions } from "../../../src/main/web-search-providers.ts"

/** @returns 模板断言完成。 @throws Error 模板行为不符合契约。 */
async function main(): Promise<void> {
  const definition = listWebSearchProviderDefinitions()[0]!
  const key = 'api"key\\with\n特殊字符${max_results}'
  const input = buildWebSearchProviderInput(definition, { APIKEY: key })
  const request = JSON.parse(input.requestJson)
  assert.equal(request.url, "https://api.tavily.com/search")
  assert.equal(request.method, "POST")
  assert.equal(request.headers.Authorization, `Bearer ${key}`)
  assert.equal(request.headers["Content-Type"], "application/json")
  assert.deepEqual(JSON.parse(request.body), { query: "${query}", search_depth: "basic", max_results: 5,
    include_answer: false, include_raw_content: false, include_images: false })
  assert.equal(input.responseJmespath, definition.responseJmespath)
  assert.deepEqual(readWebSearchProviderParameters(definition, input.requestJson), { APIKEY: key, max_results: 5 })
  for (const value of [1, 8, "8"]) {
    const saved = buildWebSearchProviderInput(definition, { APIKEY: key, max_results: value })
    assert.equal(JSON.parse(JSON.parse(saved.requestJson).body).max_results, Number(value))
  }
  assert.equal(JSON.parse(JSON.parse(buildWebSearchProviderInput(definition, { APIKEY: key, max_results: " " }).requestJson).body).max_results, 5)
  for (const value of [0, -1, 9, 1.5, "invalid", Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.throws(() => buildWebSearchProviderInput(definition, { APIKEY: key, max_results: value }))
  }
  assert.throws(() => buildWebSearchProviderInput(definition, {}))
  for (const APIKEY of ["", "  "]) assert.throws(() => buildWebSearchProviderInput(definition, { APIKEY }))
  assert.throws(() => readWebSearchProviderParameters(definition, "secret-not-json"), (error: Error) => !error.message.includes("secret-not-json"))
  const bad = { ...request, body: JSON.stringify({ max_results: "5" }) }
  assert.throws(() => readWebSearchProviderParameters(definition, JSON.stringify(bad)))
  const copy = listWebSearchProviderDefinitions()
  copy[0]!.parameters[0]!.label = "changed"
  assert.equal(listWebSearchProviderDefinitions()[0]!.parameters[0]!.label, "APIKEY")
  console.log("web-search-provider-template: 模板、默认 5、上限 8、转义与往返通过")
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
