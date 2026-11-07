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
 * 验证原生能力由协议和实际模型名前缀决定。
 * @returns 匹配和回退均通过。
 */
async function testNativeHistoryPolicy(): Promise<void> {
  await withPaths(async (paths) => {
    const database = paths.providerDatabasePath
    const model: ModelRef = { ...MODEL, name: "claude-proxy-alias", protocol: "anthropic_messages" }
    const provider = { id: model.providerId, protocol: model.protocol, type: "custom" as const, name: "Editable name" }
    saveProvider(database, { ...provider, baseURL: "https://API.ANTHROPIC.COM:443/" })
    saveModel(database, { ...model, supportsReasoning: false, contextWindow: 1000000, maxOutputTokens: 4096 })
    setProviderApiKey(database, model.providerId, "fixture-key")
    const expected = {
      name: "anthropic", protocol: "anthropic_messages", inlineToolChanges: true,
    }
    for (const baseURL of ["https://api.anthropic.com", "https://proxy.example.com", undefined]) {
      saveProvider(database, { ...provider, baseURL })
      const { clientOptions } = await resolveTurnModelAdapterSpecification(paths, model)
      assert.deepEqual(clientOptions.nativeHistory, expected)
      assert.equal(clientOptions.baseURL, baseURL)
    }
    const identity = { providerId: model.providerId, modelId: model.modelId }
    updateModel(database, identity, { name: "proxy-claude" })
    assert.equal((await resolveTurnModelAdapterSpecification(paths, { ...model, name: "proxy-claude" })).clientOptions.nativeHistory, undefined)
    updateModel(database, identity, { name: model.name })
    saveProvider(database, { ...provider, protocol: "chat_completions" })
    assert.equal((await resolveTurnModelAdapterSpecification(paths, { ...model, protocol: "chat_completions" })).clientOptions.nativeHistory, undefined)
  })
}

/**
 * 验证 OpenRouter 按 Provider 名称和协议启用回放，与 URL 和模型名无关。
 * @returns 正例和隔离断言通过后解析。
 * @throws Error 当数据库快照选出错误的策略时抛出。
 */
async function testOpenRouterHistoryPolicy(): Promise<void> {
  await withPaths(async (paths) => {
    const database = paths.providerDatabasePath
    const provider = {
      id: MODEL.providerId, protocol: MODEL.protocol, type: "custom" as const, baseURL: "https://proxy.example.com",
    }
    saveProvider(database, { ...provider, name: "OpenRouter" })
    saveModel(database, { ...MODEL, supportsReasoning: false, contextWindow: 128000, maxOutputTokens: 4096 })
    setProviderApiKey(database, provider.id, "fixture-key")
    const expected = { name: "openrouter", protocol: "chat_completions", inlineToolChanges: false }
    for (const name of ["OpenRouter", "open router", "OPEN ROUTER"]) {
      saveProvider(database, { ...provider, name })
      assert.deepEqual((await resolveTurnModelAdapterSpecification(paths, MODEL)).clientOptions.nativeHistory, expected)
    }
    saveProvider(database, { ...provider, name: "Other", baseURL: "https://openrouter.ai/api/v1" })
    assert.equal((await resolveTurnModelAdapterSpecification(paths, MODEL)).clientOptions.nativeHistory, undefined)
    saveProvider(database, { ...provider, name: "OpenRouter", protocol: "responses" })
    assert.equal((await resolveTurnModelAdapterSpecification(paths, { ...MODEL, protocol: "responses" })).clientOptions.nativeHistory, undefined)
  })
}

/** 运行 Turn Adapter 的全部断言。 */
async function main(): Promise<void> {
  await testResolvesCurrentDatabaseConfiguration()
  await testNativeHistoryPolicy()
  await testOpenRouterHistoryPolicy()
  await testRejectsInvalidBindingsWithoutSecrets()
  console.log("model-adapters.test.ts: Provider 数据库与 Adapter 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
