/** 兼容供应商字典查询、协议汇总及内置资料拆分的回归测试。 */

import assert from "node:assert/strict"

import { COMPATIBLE_PROVIDERS, listCompatibleProviders, resolveCompatibleProvider } from "../../src/main/compatible-providers.ts"
import type { CompatibleProviderCatalog } from "../../src/main/compatible-providers.ts"
import type { Protocol } from "../../runtime/model/src/types.ts"
import { completeReasoningConfig, renderReasoningField } from "../../runtime/model/src/reasoning.ts"

/**
 * 验证字典查询边界、地域与协议目录、推理字段，以及 DeepSeek 完整模型资料。
 * @returns 所有同步目录断言完成。
 */
function main(): void {
  assert.deepEqual(listCompatibleProviders({}), [])
  assert.equal(resolveCompatibleProvider("DeepSeek", "responses", {}), undefined)
  assert.deepEqual(Object.keys(COMPATIBLE_PROVIDERS), ["DeepSeek", "Kimi 国内 API", "Kimi 国内 Coding Plan", "Kimi 国际 API", "Kimi 国际 Coding Plan",
    "BigModel API", "BigModel Coding Plan", "Z.AI API", "Z.AI Coding Plan", "MiniMax 国内", "MiniMax 国际", "OpenAI", "Anthropic", "OpenRouter", "Gemini", "NVIDIA",
    "阿里云百炼（北京）", "阿里云百炼（新加坡）", "阿里云百炼（弗吉尼亚）", "阿里云百炼（中国香港）"])
  assert.deepEqual(listCompatibleProviders().filter(({ name }) => name === "DeepSeek"), [{
    name: "DeepSeek", protocol: ["chat_completions", "responses", "anthropic_messages"],
  }])

  const regionalEndpoints = [
    ["Kimi 国内 API", "https://api.moonshot.cn/v1", 6],
    ["Kimi 国内 Coding Plan", "https://api.kimi.com/coding/v1", 6],
    ["Kimi 国际 API", "https://api.moonshot.ai/v1", 6],
    ["Kimi 国际 Coding Plan", "https://api.kimi.ai/coding/v1", 6],
    ["MiniMax 国内", "https://api.minimax.com/v1", 2],
    ["MiniMax 国际", "https://api.minimax.io/v1", 2],
  ] as const
  for (const [name, url, count] of regionalEndpoints) {
    assert.deepEqual(listCompatibleProviders().find((entry) => entry.name === name), {
      name, protocol: ["chat_completions"],
    })
    const definition = resolveCompatibleProvider(name, "chat_completions")!
    assert.equal(definition.url, url)
    assert.equal(definition.models.length, count)
    assert.equal(resolveCompatibleProvider(name, "responses"), undefined)
    assert.equal(resolveCompatibleProvider(name, "anthropic_messages"), undefined)
    for (const [otherName] of regionalEndpoints) {
      if (name === otherName || name.split(" ")[0] !== otherName.split(" ")[0]) continue
      const other = resolveCompatibleProvider(otherName, "chat_completions")!
      assert.deepEqual(definition.models, other.models)
      assert.notEqual(definition.models, other.models)
      assert.notEqual(definition.models[0], other.models[0])
    }
  }
  for (const oldName of ["Kimi", "MiniMax"]) {
    assert.equal(resolveCompatibleProvider(oldName, "chat_completions"), undefined)
  }

  const regions = [
    ["北京", "dashscope.aliyuncs.com"],
    ["新加坡", "dashscope-intl.aliyuncs.com"],
    ["弗吉尼亚", "dashscope-us.aliyuncs.com"],
    ["中国香港", "cn-hongkong.dashscope.aliyuncs.com"],
  ] as const
  for (const [region, host] of regions) {
    const name = `阿里云百炼（${region}）`
    assert.deepEqual(listCompatibleProviders().find((entry) => entry.name === name), {
      name, protocol: ["chat_completions", "anthropic_messages"],
    })
    assert.equal(resolveCompatibleProvider(name, "responses"), undefined)
    for (const protocol of ["chat_completions", "anthropic_messages"] as const) {
      const definition = resolveCompatibleProvider(name, protocol)!
      assert.equal(definition.url, `https://${host}/${protocol === "chat_completions" ? "compatible-mode/v1" : "apps/anthropic"}`)
      assert.deepEqual(definition.models.slice(0, 2), ["qwen3.8-max", "qwen3.8-flash"].map((model) => ({
        name: model, contextWindow: 1000000, maxOutputTokens: 131072, supportsReasoning: true,
        reasoningLevels: protocol === "chat_completions" ? ["none", "low", "medium", "xhigh"] : ["enabled", "disabled"],
        reasoningField: { path: protocol === "chat_completions" ? ["reasoning_effort"] : ["thinking", "type"] },
      })))
      const expectedCounts = { 北京: [15, 14], 新加坡: [15, 14], 弗吉尼亚: [14, 14], 中国香港: [9, 9] }
      assert.equal(definition.models.length, expectedCounts[region][protocol === "chat_completions" ? 0 : 1])
      assert.equal(new Set(definition.models.map((model) => model.name)).size, definition.models.length)
      for (const model of definition.models) {
        assert.ok(model.name.startsWith("qwen"), "百炼预设仅收录 Qwen 系列")
        assert.ok(Number.isInteger(model.contextWindow) && model.contextWindow > 0)
        assert.ok(Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0)
        const reasoning = completeReasoningConfig(model, protocol)
        if (model.supportsReasoning) {
          assert.doesNotThrow(() => renderReasoningField(reasoning.reasoningField, reasoning.reasoningLevels[0], protocol))
        } else {
          assert.equal(model.reasoningField, undefined, "不能发送推理控制的预设不应伪造字段")
        }
      }
      for (const required of ["qwen3.7-plus", "qwen3.6-plus", "qwen3.5-flash"]) {
        assert.ok(definition.models.some((model) => model.name === required), `${name}/${protocol} 缺少 ${required}`)
      }
      assert.equal(definition.models.some((model) => model.name === "qwen-max"), protocol === "chat_completions" && (region === "北京" || region === "新加坡"))
      const plus = definition.models.find((model) => model.name === "qwen3.7-plus")!
      assert.equal(plus.supportsReasoning, protocol === "anthropic_messages")
      for (const retired of ["qwen3-max", "qwen3-coder-plus", "qwen2.5-72b-instruct"]) {
        assert.equal(definition.models.some((model) => model.name === retired), false)
      }
      for (const [otherRegion] of regions) {
        if (region === otherRegion) continue
        const other = resolveCompatibleProvider(`阿里云百炼（${otherRegion}）`, protocol)!
        assert.notEqual(definition.models, other.models)
        assert.notEqual(definition.models[0], other.models[0])
      }
    }
  }

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
