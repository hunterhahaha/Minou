/** 每 Turn 从 Provider 数据库重读配置与凭据并创建独立 Adapter 的测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initNetworkDispatcher } from "../../runtime/network/src/dispatcher.ts"
import type { ModelRef } from "../../runtime/model/src/types.ts"
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
  const profile = await mkdtemp(join(tmpdir(), "nicode-turn-adapter-"))
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
 * 验证原生能力由协议、端点地址和目录模型决定。
 * @returns 匹配和回退均通过。
 */
async function testNativeHistoryPolicy(): Promise<void> {
  await withPaths(async (paths) => {
    const database = paths.providerDatabasePath
    const model: ModelRef = { ...MODEL, name: "claude-opus-5-5", protocol: "anthropic_messages" }
    const provider = { id: model.providerId, protocol: model.protocol, type: "custom" as const, name: "Editable name" }
    saveProvider(database, { ...provider, baseURL: "https://API.ANTHROPIC.COM:443/" })
    saveModel(database, { ...model, supportsReasoning: false, contextWindow: 1000000, maxOutputTokens: 4096 })
    setProviderApiKey(database, model.providerId, "fixture-key")
    assert.deepEqual((await resolveTurnModelAdapterSpecification(paths, model)).clientOptions.nativeHistory, {
      name: "anthropic", protocol: "anthropic_messages", inlineToolChanges: true,
    })
    saveProvider(database, { ...provider, name: "Anthropic", baseURL: "https://proxy.example.com" })
    assert.equal((await resolveTurnModelAdapterSpecification(paths, model)).clientOptions.nativeHistory, undefined)
    saveProvider(database, { ...provider, baseURL: "https://api.anthropic.com" })
    updateModel(database, { providerId: model.providerId, modelId: model.modelId }, { name: "custom-model" })
    assert.equal((await resolveTurnModelAdapterSpecification(paths, model)).clientOptions.nativeHistory, undefined)
  })
}

/** 运行 Turn Adapter 的全部断言。 */
async function main(): Promise<void> {
  await testResolvesCurrentDatabaseConfiguration()
  await testNativeHistoryPolicy()
  await testRejectsInvalidBindingsWithoutSecrets()
  console.log("model-adapters.test.ts: Provider 数据库与 Adapter 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
