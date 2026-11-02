/** Anthropic / OpenRouter 模板协议、模型规格及请求推理字段的回归断言。 */

import assert from "node:assert/strict"
import {listCompatibleProviders, resolveCompatibleProvider} from "../../src/main/compatible-providers.ts"
import {completeReasoningConfig, renderReasoningField} from "../../runtime/model/src/reasoning.ts"

for (const [name, protocol, url, modelNames] of [
    ["Anthropic", "anthropic_messages", "https://api.anthropic.com",
        ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]],
    ["OpenRouter", "chat_completions", "https://openrouter.ai/api/v1",
        ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "openai/gpt-6.1-sol", "google/gemini-4-argon", "moonshotai/kimi-k3.1-pro"]],
] as const) {
    assert.deepEqual(listCompatibleProviders().find((entry) => entry.name === name), {name, protocol: [protocol]})
    const definition = resolveCompatibleProvider(name, protocol)!
    assert.equal(definition.url, url)
    assert.deepEqual(definition.models.map((model) => model.name), modelNames)
    assert.equal(resolveCompatibleProvider(name, "responses"), undefined)
    assert.equal(resolveCompatibleProvider(name, protocol === "chat_completions" ? "anthropic_messages" : "chat_completions"), undefined)
    for (const model of definition.models) {
        assert.equal(model.supportsReasoning, true)
        assert.ok(model.contextWindow >= 1000000)
        /** Summary 的上下文阈值需保留至少一半窗口，不沿用路由平台接近窗口大小的输出上限。 */
        assert.ok(model.maxOutputTokens * 2 + 10000 < model.contextWindow / 2)
        const config = completeReasoningConfig(model, protocol)
        for (const level of config.reasoningLevels) {
            assert.deepEqual(renderReasoningField(config.reasoningField, level, protocol),
                name === "Anthropic" ? {output_config: {effort: level}} : {reasoning: {effort: level}})
        }
        assert.equal(config.reasoningLevels.includes("none"), model.name === "moonshotai/kimi-k3.1-pro")
    }
}

console.log("anthropic-openrouter-providers.test.ts: 模板协议、规格、推理字段与上下文余量通过")
