/** Provider SQLite 的读写顺序、默认模型、事务与启动文件存在性测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  deleteModel,
  deleteProvider,
  initializeProviderDatabase,
  listProviders,
  readDefaultModel,
  readTurnProviderSnapshot,
  saveModel,
  saveProvider,
  setDefaultModel,
  setProviderApiKey,
} from "../../src/main/provider-store.ts"

/** 在隔离目录运行数据库断言。 */
async function withDatabase(test: (path: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-provider-store-"))
  try {
    await test(join(directory, "providers.sqlite"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** 验证首次创建、重复初始化、列表排序与默认模型回退。 */
async function testCatalogAndDefaults(): Promise<void> {
  await withDatabase((path) => {
    initializeProviderDatabase(path)
    assert.deepEqual(listProviders(path), [])
    assert.equal(readDefaultModel(path), undefined)
    saveProvider(path, { id: "first", name: "First", protocol: "responses" })
    saveProvider(path, {
      id: "second", name: "Second", protocol: "chat_completions",
      baseURL: "https://example.com/v1", defaultHeaders: { "X-Mode": "test" },
    })
    saveModel(path, { id: "model-b", providerId: "first", supportsTools: false })
    saveModel(path, { id: "model-a", providerId: "first", contextWindow: 128000 })
    saveModel(path, { id: "model-c", providerId: "second" })
    setProviderApiKey(path, "first", "hidden-secret")
    assert.deepEqual(listProviders(path), [
      {
        id: "first", name: "First", protocol: "responses",
        models: [
          { id: "model-b", providerId: "first", supportsTools: false },
          { id: "model-a", providerId: "first", contextWindow: 128000 },
        ],
      },
      {
        id: "second", name: "Second", protocol: "chat_completions",
        baseURL: "https://example.com/v1", defaultHeaders: { "X-Mode": "test" },
        models: [{ id: "model-c", providerId: "second" }],
      },
    ])
    assert.equal(JSON.stringify(listProviders(path)).includes("hidden-secret"), false)
    assert.deepEqual(readDefaultModel(path), { providerId: "first", modelId: "model-b" })
    setDefaultModel(path, { providerId: "second", modelId: "model-c" })
    assert.deepEqual(readDefaultModel(path), { providerId: "second", modelId: "model-c" })
    initializeProviderDatabase(path)
    assert.deepEqual(readDefaultModel(path), { providerId: "second", modelId: "model-c" })
    saveProvider(path, { id: "first", name: "Renamed", protocol: "responses" })
    assert.equal(listProviders(path)[0].name, "Renamed")
    assert.deepEqual(readDefaultModel(path), { providerId: "second", modelId: "model-c" })
    deleteModel(path, "second", "model-c")
    assert.deepEqual(readDefaultModel(path), { providerId: "first", modelId: "model-b" })
    deleteProvider(path, "first")
    assert.equal(readDefaultModel(path), undefined)
    assert.deepEqual(listProviders(path).map((entry) => entry.id), ["second"])
    const db = new DatabaseSync(path)
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM models").get() as { count: number }).count, 0)
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM provider_credentials").get() as { count: number }).count, 0)
    } finally {
      db.close()
    }
    setDefaultModel(path, null)
  })
}

/** 验证凭据读写和错误路径不回写无效状态。 */
async function testReadAndRollback(): Promise<void> {
  await withDatabase((path) => {
    initializeProviderDatabase(path)
    saveProvider(path, { id: "configured", name: "Configured", protocol: "anthropic_messages" })
    saveModel(path, { id: "model-a", providerId: "configured", maxOutputTokens: 4096 })
    setProviderApiKey(path, "configured", "first-secret")
    const reference = { providerId: "configured", protocol: "anthropic_messages" as const, modelId: "model-a" }
    assert.deepEqual(readTurnProviderSnapshot(path, reference), {
      provider: { id: "configured", name: "Configured", protocol: "anthropic_messages" },
      model: {
        id: "model-a", providerId: "configured", protocol: "anthropic_messages",
        contextWindow: 256000, maxOutputTokens: 4096,
      },
      credential: { providerId: "configured", apiKey: "first-secret" },
    })
    setProviderApiKey(path, "configured", "second-secret")
    assert.equal(readTurnProviderSnapshot(path, reference).credential?.apiKey, "second-secret")
    assert.throws(() => saveModel(path, { id: "model-a", providerId: "missing" }), /Provider missing 不存在/)
    saveProvider(path, { id: "other", name: "Other", protocol: "responses" })
    assert.doesNotThrow(() => saveModel(path, { id: "model-a", providerId: "configured" }))
    assert.throws(() => saveModel(path, { id: "invalid", providerId: "configured", contextWindow: 0 }), /contextWindow/)
    assert.throws(() => setDefaultModel(path, { providerId: "other", modelId: "missing" }), /默认模型 missing 不存在/)
    assert.throws(() => setProviderApiKey(path, "missing", "secret-that-must-not-leak"), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes("secret-that-must-not-leak"), false)
      return true
    })
    assert.throws(() => saveProvider(path, {
      id: "invalid", name: "Invalid", protocol: "responses", defaultHeaders: { X: 1 } as unknown as Record<string, string>,
    }), /defaultHeaders/)
    assert.deepEqual(listProviders(path).map((entry) => entry.id), ["configured", "other"])
    assert.equal(readTurnProviderSnapshot(path, reference).credential?.apiKey, "second-secret")
    setProviderApiKey(path, "configured", null)
    assert.equal(readTurnProviderSnapshot(path, reference).credential, undefined)
    deleteProvider(path, "configured")
    assert.deepEqual(listProviders(path), [{ id: "other", name: "Other", protocol: "responses", models: [] }])
  })
}

/** 验证普通列表拒绝缺失数据库，启动初始化只要求已有文件存在。 */
async function testDatabaseErrors(): Promise<void> {
  await withDatabase(async (path) => {
    assert.throws(() => listProviders(path), (error: unknown) => error instanceof Error && error.message.includes(path))
    await writeFile(path, "not sqlite")
    assert.doesNotThrow(() => initializeProviderDatabase(path))
  })
  await withDatabase((path) => {
    initializeProviderDatabase(path)
    const db = new DatabaseSync(path)
    try {
      db.exec("PRAGMA user_version = 9")
    } finally {
      db.close()
    }
    assert.doesNotThrow(() => initializeProviderDatabase(path))
  })
}

/** 运行 Provider 存储的全部断言。 */
async function main(): Promise<void> {
  await testCatalogAndDefaults()
  await testReadAndRollback()
  await testDatabaseErrors()
  console.log("provider-store.test.ts: Provider SQLite 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
