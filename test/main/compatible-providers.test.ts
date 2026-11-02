/** 兼容供应商字典查询、协议汇总及内置资料拆分的回归测试。 */

import assert from "node:assert/strict"

import { COMPATIBLE_PROVIDERS, listCompatibleProviders, resolveCompatibleProvider } from "../../src/main/compatible-providers.ts"
import type { CompatibleProviderCatalog } from "../../src/main/compatible-providers.ts"
import type { Protocol } from "../../runtime/model/src/types.ts"

/**
 * 验证字典查询边界、顺序和 DeepSeek 三种协议的完整模型资料。
 * @returns 所有同步目录断言完成。
 */
function main(): void {
  assert.deepEqual(listCompatibleProviders({}), [])
  assert.equal(resolveCompatibleProvider("DeepSeek", "responses", {}), undefined)
  assert.deepEqual(Object.keys(COMPATIBLE_PROVIDERS), ["DeepSeek"])
  assert.deepEqual(listCompatibleProviders(), [{
    name: "DeepSeek", protocol: ["chat_completions", "responses", "anthropic_messages"],
  }])

  const expectedProtocols: Array<{ protocol: Protocol; url: string; path: string[] }> = [
    { protocol: "chat_completions", url: "https://api.deepseek.com", path: ["reasoning_effort"] },
    { protocol: "responses", url: "https://api.deepseek.com", path: ["reasoning", "effort"] },
    { protocol: "anthropic_messages", url: "https://api.deepseek.com/anthropic", path: ["output_config", "effort"] },
  ]
  for (const { protocol, url, path } of expectedProtocols) {
    const definition = resolveCompatibleProvider("DeepSeek", protocol)
    assert.deepEqual(definition, {
      protocol,
      url,
      models: ["deepseek-flash", "deepseek-v4-pro"].map((name) => ({ supportsReasoning: true,
        name, contextWindow: 1048576, maxOutputTokens: 393216,
        reasoningLevels: ["low", "high", "max"], reasoningField: { path },
      })),
    })
  }

  const responses = resolveCompatibleProvider("DeepSeek", "responses")!
  const chat = resolveCompatibleProvider("DeepSeek", "chat_completions")!
  const definitions: CompatibleProviderCatalog = {
    Second: [responses, chat, { ...responses, url: "https://duplicate.example" }],
    First: [chat],
    Empty: [],
  }
  assert.deepEqual(listCompatibleProviders(definitions), [
    { name: "Second", protocol: ["responses", "chat_completions"] },
    { name: "First", protocol: ["chat_completions"] },
    { name: "Empty", protocol: [] },
  ])
  assert.equal(resolveCompatibleProvider("Second", "responses", definitions), responses)
  assert.equal(resolveCompatibleProvider("Second", "anthropic_messages", definitions), undefined)
  assert.equal(resolveCompatibleProvider("Empty", "responses", definitions), undefined)
  for (const name of ["Unknown", "deepseek", "toString", "constructor", "__proto__"]) {
    assert.equal(resolveCompatibleProvider(name, "responses"), undefined)
  }
  const inherited = Object.create({ Inherited: [responses] }) as CompatibleProviderCatalog
  assert.deepEqual(listCompatibleProviders(inherited), [])
  assert.equal(resolveCompatibleProvider("Inherited", "responses", inherited), undefined)
  console.log("compatible-providers.test.ts: 兼容供应商目录断言通过")
}

main()
