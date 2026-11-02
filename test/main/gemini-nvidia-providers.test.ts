/** Gemini / NVIDIA 预设的目录边界与真实请求构造回归断言。 */

import assert from "node:assert/strict"
import {listCompatibleProviders, resolveCompatibleProvider} from "../../src/main/compatible-providers.ts"
import {buildChatCompletionsRequest} from "../../runtime/model/src/chat-completions.ts"
import {completeReasoningConfig} from "../../runtime/model/src/reasoning.ts"
import type {ModelConfig, UnifiedModelRequest} from "../../runtime/model/src/types.ts"

for (const [name, url, names] of [
    ["Gemini", "https://generativelanguage.googleapis.com/v1beta/openai/", ["gemini-4-argon", "gemini-3.8-flash"]],
    ["NVIDIA", "https://integrate.api.nvidia.com/v1", ["openai/gpt-oss-120b", "meta/llama-3.3-70b-instruct"]],
] as const) {
    assert.deepEqual(listCompatibleProviders().find((entry) => entry.name === name), {name, protocol: ["chat_completions"]})
    const definition = resolveCompatibleProvider(name, "chat_completions")!
    assert.equal(definition.url, url)
    assert.deepEqual(definition.models.map((model) => model.name), names)
    assert.equal(resolveCompatibleProvider(name, "responses"), undefined)
    assert.equal(resolveCompatibleProvider(name, "anthropic_messages"), undefined)
    for (const model of definition.models) {
        assert.equal(model.contextWindow, name === "Gemini" ? 1048576 : 131072)
        assert.equal(model.maxOutputTokens, name === "Gemini" ? 65536 : 4096)
        assert.equal(model.supportsReasoning, !model.name.startsWith("meta/"))
        const config: ModelConfig = {
            ...model, ...completeReasoningConfig(model, "chat_completions"),
            providerId: name, modelId: model.name, protocol: "chat_completions",
        }
        for (const level of config.reasoningLevels) {
            const request: UnifiedModelRequest = {
                model: {providerId: name, modelId: model.name, protocol: "chat_completions", name: model.name, reasoningLevel: level},
                context: {messages: [{role: "system", content: "You are a coding agent."}, {role: "user", content: "Hello"}]},
                tools: [{name: "read", description: "Read a file", inputSchema: {type: "object", properties: {}}}],
            }
            const body = buildChatCompletionsRequest(request, config)
            assert.equal(body.model, model.name)
            assert.equal(body.stream, true)
            assert.deepEqual(body.stream_options, {include_usage: true})
            assert.equal(body.tools?.[0]?.type, "function")
            assert.equal(body.reasoning_effort, model.supportsReasoning ? level : undefined)
        }
        if (model.supportsReasoning) {
            assert.deepEqual(config.reasoningLevels, ["low", "medium", "high"])
            const invalid: UnifiedModelRequest = {
                model: {providerId: name, modelId: model.name, protocol: "chat_completions", name: model.name, reasoningLevel: "none"},
                context: {messages: [{role: "system", content: "System"}, {role: "user", content: "Hello"}]}, tools: [],
            }
            assert.throws(() => buildChatCompletionsRequest(invalid, config))
        }
    }
}

console.log("gemini-nvidia-providers.test.ts: 目录、协议边界、规格、推理开关与请求构造通过")
