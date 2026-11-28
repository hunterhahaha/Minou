/** 每 Turn 从 Provider 数据库重读配置与凭据并创建独立 Adapter 的测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initNetworkDispatcher } from "../../runtime/network/src/dispatcher.ts"
import type { ModelRef, UnifiedModelRequest } from "../../runtime/model/src/types.ts"
import { collect, sseData, startFakeProvider } from "../../runtime/model/test/helpers.ts"
import { initializeConfigFiles } from "../../src/main/config-files.ts"
import type { ConfigFilePaths } from "../../src/main/config-files.ts"
import {
  createTurnModelAdapter,
  resolveTurnModelAdapterSpecification,
} from "../../src/main/model-adapters.ts"
import { deleteProvider, saveModel, saveProvider, setProviderApiKey, updateModel } from "../../src/main/provider-store.ts"
import type { ProviderModelUpdate } from "../../src/main/provider-store.ts"

const MODEL: ModelRef = {
  providerId: "configured",
  protocol: "chat_completions",
  modelId: "model-a",
  name: "gpt-test",
  reasoningLevel: "medium",
}

/** 在隔离配置目录运行 Turn Adapter 断言。 */
async function withPaths(test: (paths: ConfigFilePaths) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "minou-turn-adapter-"))
  try {
    await test(await initializeConfigFiles(profile))
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

/** 验证连续 Turn 能取得更新后的模型、连接参数和密钥。 */
async function testResolvesCurrentDatabaseConfiguration(): Promise<void> {
  await withPaths(async (paths) => {
    const database = paths.providerDatabasePath
    saveProvider(database, {
      id: "configured", name: "Configured Provider", protocol: "chat_completions", type: "custom",
      baseURL: "https://api.example.com/v1", defaultHeaders: { "X-Test": "value" },
    })
    saveModel(database, { supportsReasoning: true,
      providerId: "configured", modelId: "model-a", name: "gpt-test", contextWindow: 128000,
      maxOutputTokens: 4096,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning_effort"] },
    })
    setProviderApiKey(database, "configured", "first-secret")
    const first = await resolveTurnModelAdapterSpecification(paths, MODEL)
    assert.equal(first.providerName, "Configured Provider")
    assert.deepEqual(first.modelConfig, { supportsReasoning: true,
      modelId: "model-a", name: "gpt-test", providerId: "configured", protocol: "chat_completions",
      contextWindow: 128000, maxOutputTokens: 4096,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning_effort"] },
    })
    assert.deepEqual(first.clientOptions, {
      apiKey: "first-secret", baseURL: "https://api.example.com/v1",
      defaultHeaders: { "X-Test": "value" },
    })
    await assert.rejects(resolveTurnModelAdapterSpecification(paths, { ...MODEL, reasoningLevel: "unsupported" }),
      /推理等级 unsupported 不在模型支持列表中/)
    updateModel(database, { providerId: "configured", modelId: "model-a" }, { supportsReasoning: true, reasoningLevels: ["high"] })
    await assert.rejects(resolveTurnModelAdapterSpecification(paths, MODEL), /推理等级 medium 不在模型支持列表中/)
    updateModel(database, { providerId: "configured", modelId: "model-a" }, { supportsReasoning: true, reasoningLevels: ["low", "medium", "high"] })

    assert.throws(() => updateModel(database, { providerId: "configured", modelId: "model-a" }, {
      maxOutputTokens: null,
    } as unknown as ProviderModelUpdate), /maxOutputTokens/)

    saveProvider(database, {
      id: "configured", name: "Updated Provider", protocol: "chat_completions", type: "custom",
      baseURL: "https://updated.example.com/v2", defaultHeaders: { "X-Updated": "yes" },
    })
    updateModel(database, { providerId: "configured", modelId: "model-a" }, {
      name: "gpt-updated",
      contextWindow: 64000,
    })
    setProviderApiKey(database, "configured", "second-secret")
    const second = await resolveTurnModelAdapterSpecification(paths, MODEL)
    assert.equal(second.providerName, "Updated Provider")
    assert.deepEqual(second.modelConfig, { supportsReasoning: true,
      modelId: "model-a", name: "gpt-updated", providerId: "configured", protocol: "chat_completions",
      contextWindow: 64000, maxOutputTokens: 4096,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning_effort"] },
    })
    assert.deepEqual(second.clientOptions, {
      apiKey: "second-secret", baseURL: "https://updated.example.com/v2",
      defaultHeaders: { "X-Updated": "yes" },
    })

    initNetworkDispatcher()
    const firstAdapter = await createTurnModelAdapter(paths, MODEL)
    assert.equal(firstAdapter.contextWindow, 64000)
    assert.equal(firstAdapter.maxOutputTokens, 4096)
    updateModel(database, { providerId: "configured", modelId: "model-a" }, { supportsReasoning: true, contextWindow: 96000, maxOutputTokens: 8192 })
    const secondAdapter = await createTurnModelAdapter(paths, MODEL)
    assert.notEqual(firstAdapter, secondAdapter)
    assert.equal(firstAdapter.contextWindow, 64000, "当前 Turn 的窗口快照不可变化")
    assert.equal(firstAdapter.maxOutputTokens, 4096)
    assert.equal(secondAdapter.contextWindow, 96000)
    assert.equal(secondAdapter.maxOutputTokens, 8192)
  })
}

/** 验证缺失与不匹配错误带数据库路径且不泄露密钥。 */
async function testRejectsInvalidBindingsWithoutSecrets(): Promise<void> {
  await withPaths(async (paths) => {
    const database = paths.providerDatabasePath
    saveProvider(database, { id: "configured", name: "Configured", protocol: "chat_completions", type: "custom" })
    saveModel(database, { supportsReasoning: true,
      providerId: "configured", modelId: "model-a", name: "gpt-test", contextWindow: 256000,
      maxOutputTokens: 32000,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning_effort"] },
    })
    setProviderApiKey(database, "configured", "must-not-leak")
    for (const model of [
      { ...MODEL, providerId: "missing-provider" },
      { ...MODEL, protocol: "responses" as const },
      { ...MODEL, modelId: "missing-model" },
    ]) {
      await assert.rejects(resolveTurnModelAdapterSpecification(paths, model), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(database))
        assert.equal(error.message.includes("must-not-leak"), false)
        return true
      })
    }
    setProviderApiKey(database, "configured", null)
    await assert.rejects(resolveTurnModelAdapterSpecification(paths, MODEL), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(database))
      assert.ok(error.message.includes("configured"))
      assert.equal(error.message.includes("must-not-leak"), false)
      return true
    })
    deleteProvider(database, "configured")
    await assert.rejects(resolveTurnModelAdapterSpecification(paths, MODEL), /Provider configured 不存在/)
  })
}

/**
 * 验证 Turn 工厂使用数据库中的 Provider 名称选择 OpenRouter 回放转换器。
 * @returns 真实 SDK 流上的正例与回退断言通过后完成。
 * @throws 当流不符合 Provider 名称对应的原生回放行为时拒绝。
 */
async function testOpenRouterReplayUsesProviderSnapshot(): Promise<void> {
  const encrypted = { type: "reasoning.encrypted", data: "fixture-cipher" }
  const provider = await startFakeProvider({ events: [
    { choices: [{ index: 0, delta: { reasoning_details: [encrypted] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    sseData("[DONE]"),
  ] })
  try {
    await withPaths(async (paths) => {
      const database = paths.providerDatabasePath
      const record = {
        id: MODEL.providerId, protocol: MODEL.protocol, type: "custom" as const,
        baseURL: provider.baseURL("chat_completions"),
      }
      saveProvider(database, { ...record, name: "openRouter" })
      saveModel(database, { ...MODEL, supportsReasoning: false, contextWindow: 128000, maxOutputTokens: 4096 })
      setProviderApiKey(database, record.id, "fixture-key")

      const request: UnifiedModelRequest = {
        model: MODEL, tools: [],
        context: { messages: [{ role: "system", content: "fixture" }, { role: "user", content: "run" }] },
      }
      const named = await createTurnModelAdapter(paths, MODEL)
      const events = await collect(named.stream(request, new AbortController().signal))
      const block = events.find((item) => item.type === "block_end")
      assert.deepEqual(block?.block.replay, {
        name: "OpenRouter", protocol: "chat_completions", payloadJson: JSON.stringify({ reasoning_details: [encrypted] }),
      })

      saveProvider(database, { ...record, name: "Other" })
      const generic = await createTurnModelAdapter(paths, MODEL)
      assert.deepEqual(await collect(generic.stream(request, new AbortController().signal)), [
        { type: "stream_end", completion: "finished", finishReason: "stop" },
      ])
    })
  } finally {
    await provider.close()
  }
}

/** 验证 MiniMax 地区别名共用转换行为，SDK 连接信息来自各自的 Provider 快照。 */
async function testMiniMaxRegionalProviderSnapshots(): Promise<void> {
  const domestic = await startFakeProvider({ events: [
    { choices: [{ index: 0, delta: { reasoning_content: "domestic" }, finish_reason: "stop" }] },
    sseData("[DONE]"),
  ] })
  try {
    const international = await startFakeProvider({ events: [
      { type: "response.output_item.done", output_index: 0, item: {
        id: "reason", type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "international" }],
      } },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ] })
    try {
      await withPaths(async (paths) => {
        const database = paths.providerDatabasePath
        for (const [providerId, name, protocol, server] of [
          ["domestic", "MiniMax 国内", "chat_completions", domestic],
          ["international", "MiniMax 国际", "responses", international],
        ] as const) {
          const model = { ...MODEL, modelId: `model-${providerId}`, providerId, protocol, name: "no-model-rule" }
          const record = {
            id: providerId, name, protocol, type: "custom" as const,
            baseURL: `${server.origin}/${providerId}/v1`, defaultHeaders: { "X-Provider-Fixture": providerId },
          }
          saveProvider(database, record)
          saveModel(database, { ...model, supportsReasoning: false, contextWindow: 128000, maxOutputTokens: 4096 })
          setProviderApiKey(database, providerId, `${providerId}-fixture-key`)
          const request: UnifiedModelRequest = {
            model, tools: [], context: { messages: [{ role: "system", content: "fixture" }, { role: "user", content: "run" }] },
          }
          for (const providerName of [name, ` ${name.toUpperCase()} `]) {
            if (providerName !== name) saveProvider(database, { ...record, name: providerName })
            const adapter = await createTurnModelAdapter(paths, model)
            const events = await collect(adapter.stream(request, new AbortController().signal))
            const block = events.find((event) => event.type === "block_end")
            assert.deepEqual(block?.block, { type: "thinking", text: providerId })
            const captured = server.requests.at(-1)
            assert.equal(captured?.path, `/${providerId}/v1/${protocol === "responses" ? "responses" : "chat/completions"}`)
            assert.equal(captured?.headers.authorization, `Bearer ${providerId}-fixture-key`)
            assert.equal(captured?.headers["x-provider-fixture"], providerId)
            assert.equal(captured?.body[protocol === "responses" ? "max_output_tokens" : "reasoning_split"],
              protocol === "responses" ? 4096 : true)
          }
          assert.equal(server.requests.length, 2)
        }
      })
    } finally {
      await international.close()
    }
  } finally {
    await domestic.close()
  }
}

/** 运行 Turn Adapter 的全部断言。 */
async function main(): Promise<void> {
  await testResolvesCurrentDatabaseConfiguration()
  await testOpenRouterReplayUsesProviderSnapshot()
  await testMiniMaxRegionalProviderSnapshots()
  await testRejectsInvalidBindingsWithoutSecrets()
  console.log("model-adapters.test.ts: Provider 数据库与 Adapter 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
