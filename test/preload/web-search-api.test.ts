/** 搜索管理固定通道和不可信返回值校验。 */
import assert from "node:assert/strict"
import { createSessionApi } from "../../src/preload/session-api.ts"
import { listWebSearchProviderDefinitions } from "../../src/main/web-search-providers.ts"

/** @returns 返回值边界验证完成。 @throws Error 断言失败。 */
async function main(): Promise<void> {
  let value: unknown
  const api = createSessionApi({ async invoke() { return value } })
  for (value of [null, {}, [{ id: "x", name: "Tavily", enabled: 1 }], [{ id: "x", name: "Tavily", enabled: true, requestJson: "secret" }],
    [{ id: "x", name: "Tavily", enabled: true }, { id: "y", name: "Tavily", enabled: true }]]) await assert.rejects(api.listWebSearchProviders())
  for (value of [null, {}, [{ name: "Tavily", parameters: [] }]]) await assert.rejects(api.listWebSearchProviderDefinitions())
  value = listWebSearchProviderDefinitions()
  assert.equal((await api.listWebSearchProviderDefinitions())[0]?.parameters[1]?.defaultValue, 5)
  assert.equal((await api.listWebSearchProviderDefinitions())[0]?.parameters[0]?.target.prefix, "Bearer ")
  for (const prefix of [123, null, {}]) {
    const invalid = listWebSearchProviderDefinitions()
    Object.assign(invalid[0]!.parameters[0]!.target, { prefix })
    value = invalid
    await assert.rejects(api.listWebSearchProviderDefinitions())
  }
  value = { id: "x", name: "Tavily", enabled: false, requestJson: "not-json", responseJmespath: "results" }
  await assert.rejects(api.getWebSearchProvider("x"))
  value = { success: true }
  await assert.rejects(api.deleteWebSearchProvider("x"))
  await assert.rejects(api.setActiveWebSearchProvider(null))
  value = undefined
  await api.deleteWebSearchProvider("x")
  console.log("web-search-api: 无效目录、摘要泄密、详情和写入确认校验通过")
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
