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
      id: "configured", name: "Configured Provider", protocol: "chat_completions",
      baseURL: "https://api.example.com/v1", defaultHeaders: { "X-Test": "value" },
    })
    saveModel(database, {
      providerId: "configured", modelId: "model-a", name: "gpt-test", contextWindow: 128000,
      maxOutputTokens: 4096, supportsReasoning: true, supportsTools: true,
      supportsParallelTools: true, supportsResponseId: true,
    })
    setProviderApiKey(database, "configured", "first-secret")
    const first = await resolveTurnModelAdapterSpecification(paths, MODEL)
    assert.deepEqual(first.modelConfig, {
      modelId: "model-a", name: "gpt-test", providerId: "configured", protocol: "chat_completions",
      contextWindow: 128000, maxOutputTokens: 4096, supportsReasoning: true,
      supportsTools: true, supportsParallelTools: true, supportsResponseId: true,
    })
    assert.deepEqual(first.clientOptions, {
      apiKey: "first-secret", baseURL: "https://api.example.com/v1",
      defaultHeaders: { "X-Test": "value" },
    })

    assert.throws(() => updateModel(database, { providerId: "configured", modelId: "model-a" }, {
      maxOutputTokens: null,
    } as unknown as ProviderModelUpdate), /maxOutputTokens/)

    saveProvider(database, {
      id: "configured", name: "Updated Provider", protocol: "chat_completions",
      baseURL: "https://updated.example.com/v2", defaultHeaders: { "X-Updated": "yes" },
    })
    updateModel(database, { providerId: "configured", modelId: "model-a" }, {
      name: "gpt-updated",
      contextWindow: 64000,
      supportsReasoning: null,
      supportsTools: false,
      supportsParallelTools: null,
      supportsResponseId: null,
    })
    setProviderApiKey(database, "configured", "second-secret")
    const second = await resolveTurnModelAdapterSpecification(paths, MODEL)
    assert.deepEqual(second.modelConfig, {
      modelId: "model-a", name: "gpt-updated", providerId: "configured", protocol: "chat_completions",
      contextWindow: 64000, maxOutputTokens: 4096, supportsTools: false,
    })
    assert.deepEqual(second.clientOptions, {
      apiKey: "second-secret", baseURL: "https://updated.example.com/v2",
      defaultHeaders: { "X-Updated": "yes" },
    })

    initNetworkDispatcher()
    const firstAdapter = await createTurnModelAdapter(paths, MODEL)
    assert.equal(firstAdapter.contextWindow, 64000)
    assert.equal(firstAdapter.maxOutputTokens, 4096)
    updateModel(database, { providerId: "configured", modelId: "model-a" }, { contextWindow: 96000, maxOutputTokens: 8192 })
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
    saveProvider(database, { id: "configured", name: "Configured", protocol: "chat_completions" })
    saveModel(database, {
      providerId: "configured", modelId: "model-a", name: "gpt-test", contextWindow: 256000,
      maxOutputTokens: 32000,
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

/** 运行 Turn Adapter 的全部断言。 */
async function main(): Promise<void> {
  await testResolvesCurrentDatabaseConfiguration()
  await testRejectsInvalidBindingsWithoutSecrets()
  console.log("model-adapters.test.ts: Provider 数据库与 Adapter 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
