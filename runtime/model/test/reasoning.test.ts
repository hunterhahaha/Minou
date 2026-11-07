/** 思考能力对三个协议及压缩请求的控制，以及默认配置与非法输入边界。 */
import assert from "node:assert/strict"
import { buildAnthropicRequest } from "../src/anthropic.ts"
import { buildChatCompletionsRequest } from "../src/chat-completions.ts"
import { buildResponsesRequest } from "../src/responses.ts"
import { completeReasoningConfig, defaultReasoningConfig } from "../src/reasoning.ts"
import { assertRequestMatchesModel } from "../src/shared.ts"
import { PROTOCOLS } from "../src/types.ts"
import type { ModelConfig, UnifiedModelRequest } from "../src/types.ts"
import { compressContext } from "../../context/src/summary.ts"

/** 验证正常请求与压缩请求共用能力判断，且关闭时忽略失效等级和路径。
 * @returns 所有协议和配置边界断言完成。
 */
async function main(): Promise<void> {
  const builders = { anthropic_messages: buildAnthropicRequest, chat_completions: buildChatCompletionsRequest, responses: buildResponsesRequest }
  for (const protocol of PROTOCOLS) {
    const defaults = defaultReasoningConfig(protocol)
    for (const input of [{}, { reasoningLevels: null, reasoningField: null }, { reasoningLevels: [], reasoningField: { path: [] } }]) {
      assert.deepEqual(completeReasoningConfig(input, protocol), defaults)
    }
    assert.deepEqual(completeReasoningConfig({ reasoningLevels: ["deep"] }, protocol), { ...defaults, reasoningLevels: ["deep"] })
    assert.deepEqual(completeReasoningConfig({ reasoningField: { path: ["effort"] } }, protocol), { ...defaults, reasoningField: { path: ["effort"] } })
    for (const invalid of [{ reasoningLevels: ["high", "high"] }, { reasoningLevels: [" "] }, { reasoningField: {} }, { reasoningField: { path: ["__proto__"] } }, { reasoningField: { path: ["model"] } }]) {
      assert.throws(() => completeReasoningConfig(invalid, protocol), TypeError)
    }
    const config: ModelConfig = { modelId: "m", providerId: "p", name: "test", protocol, contextWindow: 256000, maxOutputTokens: 32000, supportsReasoning: true, ...defaults }
    const request: UnifiedModelRequest = { model: { modelId: "m", providerId: "p", name: "test", protocol, reasoningLevel: "medium" }, tools: [], context: { messages: [{ role: "system", content: "test" }, { role: "user", content: "hello" }] } }
    const build = builders[protocol]
    assertRequestMatchesModel(request, config)
    const enabled = build(request, config) as unknown as Record<string, unknown>
    let selected: unknown = enabled
    for (const key of defaults.reasoningField.path) selected = (selected as Record<string, unknown>)[key]
    assert.equal(selected, "medium")
    assert.deepEqual((build(request, { ...config, reasoningField: { path: ["custom", "effort"] } }) as unknown as Record<string, unknown>).custom, { effort: "medium" })
    const stale = { ...request, model: { ...request.model, reasoningLevel: "obsolete" } }
    assert.throws(() => assertRequestMatchesModel(stale, config))
    assert.throws(() => build(stale, config))
    const disabled = { ...config, supportsReasoning: false, reasoningLevels: [], reasoningField: { path: ["model"] } }
    assertRequestMatchesModel(stale, disabled)
    const body = build(stale, disabled) as unknown as Record<string, unknown>
    assert.equal(body.model, "test", "关闭时不会写入失效或危险的推理配置")
    assert.equal(Object.hasOwn(body, defaults.reasoningField.path[0]), false)
    for (const supportsReasoning of [false, true]) {
      const result = await compressContext({ model: request.model, content: request.context.messages!, tools: [], signal: new AbortController().signal,
        adapter: { stream: async function* (summaryRequest) {
          const summaryBody = build(summaryRequest, { ...config, supportsReasoning }) as unknown as Record<string, unknown>
          assert.equal(Object.hasOwn(summaryBody, defaults.reasoningField.path[0]), supportsReasoning)
          yield { type: "block_start", index: 0, blockType: "text" }
          yield { type: "block_end", index: 0, block: { type: "text", text: "summary" } }
          yield { type: "stream_end", completion: "finished" }
        } },
      })
      assert.equal(result.summary, "summary")
    }
  }
  console.log("reasoning.test.ts: 三协议思考能力、空值默认、错误边界及压缩请求通过")
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
