/** GLM 四个入口的 IPC、SQLite、Turn 与实际协议请求构建验证；不调用远端服务。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerModelIpcHandlers } from "../../src/main/provider-ipc.ts"
import { initializeProviderDatabase, listProviders } from "../../src/main/provider-store.ts"
import { resolveTurnModelAdapterSpecification } from "../../src/main/model-adapters.ts"
import { resolveCompatibleProvider } from "../../src/main/compatible-providers.ts"
import { PROVIDER_IPC_CHANNELS as channels } from "../../src/preload/session-api.ts"
import type { ProviderSummary } from "../../src/preload/session-api.ts"
import { buildChatCompletionsRequest } from "../../runtime/model/src/chat-completions.ts"
import { buildAnthropicRequest } from "../../runtime/model/src/anthropic.ts"
import { buildResponsesRequest } from "../../runtime/model/src/responses.ts"
import type { UnifiedModelRequest } from "../../runtime/model/src/types.ts"

/**
 * 验证入口隔离、协议白名单、持久化恢复、合法/非法等级与 GLM 工具回填。
 * @returns 所有断言完成，临时数据库始终清理。
 * @throws Error 当创建、恢复或请求构建与官方接入契约不符时传播测试失败。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "minou-glm-"))
  try {
    const database = join(directory, "providers.sqlite")
    initializeProviderDatabase(database)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerModelIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } }, { providerDatabasePath: database })
    assert.equal(resolveCompatibleProvider("BigModel", "chat_completions"), undefined)
    assert.throws(() => handlers.get(channels.createCompatibleProvider)!({}, {
      type: "compatible", name: "BigModel", protocol: "chat_completions", apiKey: "test",
    }), /不在已兼容目录/)
    for (const [platform, host] of [["BigModel", "open.bigmodel.cn"], ["Z.AI", "api.z.ai"]]) {
      for (const mode of ["API", "Coding Plan"]) {
        const name = platform + " " + mode
        const protocols = mode === "API" ? ["chat_completions"] as const
          : ["chat_completions", "anthropic_messages", "responses"] as const
        if (mode === "API") {
          assert.equal(resolveCompatibleProvider(name, "anthropic_messages"), undefined)
          assert.equal(resolveCompatibleProvider(name, "responses"), undefined)
        }
        for (const protocol of protocols) {
          const definition = resolveCompatibleProvider(name, protocol)!
          const endpoint = protocol === "responses" ? "v1" : protocol === "anthropic_messages" ? "anthropic"
            : mode === "API" ? "paas/v4" : "coding/paas/v4"
          assert.equal(definition.url, "https://" + host + "/api/" + endpoint)
          assert.equal(new Set(definition.models.map((model) => model.name)).size, definition.models.length)
          assert.ok(definition.models.every((model) => model.name.startsWith("glm-") && !model.name.includes("legal")))
          if (mode === "Coding Plan") {
            assert.ok(definition.models.every((model) => !model.name.includes("flashx")))
            assert.deepEqual(definition.models.map((model) => model.name), protocol === "chat_completions"
              ? ["glm-5.3", "glm-5.3-flash", "glm-5.2"]
              : protocol === "anthropic_messages" ? ["glm-5.3", "glm-5.3-flash"] : ["glm-5.3"])
          }
          const apiKey = "test-only-" + name + "-" + protocol
          const created = handlers.get(channels.createCompatibleProvider)!({}, {
            type: "compatible", name, protocol, apiKey,
          }) as ProviderSummary
          initializeProviderDatabase(database)
          const reopened = listProviders(database).find((provider) => provider.id === created.providerId)!
          assert.equal(reopened.baseURL, definition.url)
          assert.deepEqual(reopened.models.map((model) => model.name), definition.models.map((model) => model.name))
          for (const model of reopened.models) {
            const reference = { providerId: created.providerId, modelId: model.modelId, protocol, name: model.name, reasoningLevel: model.reasoningLevels[0] }
            const spec = await resolveTurnModelAdapterSpecification({ providerDatabasePath: database }, reference)
            assert.equal(spec.clientOptions.apiKey, apiKey)
            assert.equal(spec.clientOptions.baseURL, definition.url)
            if (model.name.startsWith("glm-5.3")) {
              assert.equal(spec.modelConfig.contextWindow, 1000000)
              assert.deepEqual(model.reasoningLevels, protocol === "responses" ? ["high", "max"] : ["low", "high", "max"])
            }
            assert.equal(spec.modelConfig.maxOutputTokens, 131072)
            for (const level of model.reasoningLevels) {
              const request: UnifiedModelRequest = {
                model: { ...reference, reasoningLevel: level }, tools: [],
                context: { messages: [
                  { role: "system", content: "test" },
                  { role: "user", content: "read" },
                  { role: "assistant", content: [
                    { type: "thinking", text: "first\n" },
                    { type: "thinking", text: "second" },
                    { type: "tool_call", toolCallId: "call-1", name: "read", arguments: {} },
                  ] },
                  { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "ok" }], isError: false },
                ] },
              }
              const body = (protocol === "chat_completions" ? buildChatCompletionsRequest(request, spec.modelConfig)
                : protocol === "anthropic_messages" ? buildAnthropicRequest(request, spec.modelConfig)
                : buildResponsesRequest(request, spec.modelConfig)) as unknown as Record<string, unknown>
              let value: unknown = body
              for (const part of model.reasoningField.path) value = (value as Record<string, unknown>)[part]
              assert.equal(value, level)
              if (protocol === "chat_completions") {
                const assistant = (body.messages as Array<Record<string, unknown>>).find((message) => message.role === "assistant")!
                assert.equal(assistant.reasoning_content, "first\nsecond")
                assert.equal(assistant.content, null)
                assert.equal((assistant.tool_calls as Array<{id: string}>)[0].id, "call-1")
                const other = buildChatCompletionsRequest(request, { ...spec.modelConfig, name: "other-model" })
                assert.ok(other.messages.every((message) => !("reasoning_content" in message)))
              }
            }
            await assert.rejects(resolveTurnModelAdapterSpecification({ providerDatabasePath: database }, {
              ...reference, reasoningLevel: "unsupported-test-level",
            }), /推理等级/)
          }
        }
      }
    }
    assert.equal(listProviders(database).length, 8)
    console.log("glm-providers.test.ts: 八种入口/协议、SQLite 恢复、凭据隔离、推理参数与工具思考回填通过")
  } finally { await rm(directory, { recursive: true, force: true }) }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
