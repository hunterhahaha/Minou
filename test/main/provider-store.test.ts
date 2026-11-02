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
  updateModel,
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
    saveProvider(path, { id: "first", name: "First", protocol: "responses", type: "custom" })
    saveProvider(path, {
      id: "second", name: "Second", protocol: "chat_completions", type: "custom",
      baseURL: "https://example.com/v1", defaultHeaders: { "X-Mode": "test" },
    })
    saveModel(path, { supportsReasoning: true,
      modelId: "model-b", name: "Model B", providerId: "first", contextWindow: 256000,
      maxOutputTokens: 32000,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning", "effort"] },
    })
    saveModel(path, { supportsReasoning: true,
      modelId: "model-a", name: "Model A", providerId: "first", contextWindow: 128000, maxOutputTokens: 32000,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning", "effort"] },
    })
    saveModel(path, { supportsReasoning: true,
      modelId: "model-c", name: "Model C", providerId: "second", contextWindow: 256000, maxOutputTokens: 32000,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning_effort"] },
    })
    setProviderApiKey(path, "first", "hidden-secret")
    assert.deepEqual(listProviders(path), [
      {
        id: "first", name: "First", protocol: "responses", type: "custom",
        models: [
          { supportsReasoning: true,
            modelId: "model-b", name: "Model B", providerId: "first", contextWindow: 256000,
            maxOutputTokens: 32000,
                      reasoningLevels: ["low", "medium", "high"],
            reasoningField: { path: ["reasoning", "effort"] },
          },
          { supportsReasoning: true,
            modelId: "model-a", name: "Model A", providerId: "first", contextWindow: 128000,
            maxOutputTokens: 32000,
                      reasoningLevels: ["low", "medium", "high"],
            reasoningField: { path: ["reasoning", "effort"] },
          },
        ],
      },
      {
        id: "second", name: "Second", protocol: "chat_completions", type: "custom",
        baseURL: "https://example.com/v1", defaultHeaders: { "X-Mode": "test" },
        models: [{ supportsReasoning: true,
          modelId: "model-c", name: "Model C", providerId: "second", contextWindow: 256000, maxOutputTokens: 32000,
                  reasoningLevels: ["low", "medium", "high"],
          reasoningField: { path: ["reasoning_effort"] },
        }],
      },
    ])
    assert.equal(JSON.stringify(listProviders(path)).includes("hidden-secret"), false)
    assert.deepEqual(readDefaultModel(path), { providerId: "first", modelId: "model-b" })
    setDefaultModel(path, { providerId: "second", modelId: "model-c" })
    assert.deepEqual(readDefaultModel(path), { providerId: "second", modelId: "model-c" })
    initializeProviderDatabase(path)
    assert.deepEqual(readDefaultModel(path), { providerId: "second", modelId: "model-c" })
    saveProvider(path, { id: "first", name: "Renamed", protocol: "responses", type: "custom" })
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
      const columns = db.prepare("PRAGMA table_info(models)").all() as Array<{ name: string; notnull: number }>
      assert.deepEqual(columns.map(({ name }) => name), [
        "id", "name", "provider_id", "position", "context_window", "max_output_tokens",
        "supports_reasoning", "reasoning_levels_json", "reasoning_field_json",
      ])
      assert.equal(columns.find(({ name }) => name === "context_window")?.notnull, 1)
      assert.equal(columns.find(({ name }) => name === "max_output_tokens")?.notnull, 1)
      assert.equal(columns.find(({ name }) => name === "reasoning_levels_json")?.notnull, 1)
      assert.equal(columns.find(({ name }) => name === "reasoning_field_json")?.notnull, 1)
      const providerColumns = db.prepare("PRAGMA table_info(providers)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
      assert.equal(providerColumns.find(({ name }) => name === "type")?.notnull, 1)
      assert.equal(providerColumns.find(({ name }) => name === "type")?.dflt_value, null)
      assert.throws(() => db.prepare("INSERT INTO providers (id, position, name, protocol) VALUES ('missing-type', 10, 'Missing', 'responses')").run(), /NOT NULL constraint failed/)
      assert.throws(() => db.prepare("INSERT INTO providers (id, position, name, type, protocol) VALUES ('bad-type', 10, 'Bad', 'other', 'responses')").run(), /CHECK constraint failed/)
      const insertModel = db.prepare(`INSERT INTO models
        (id, name, provider_id, position, context_window, max_output_tokens)
        VALUES (?, ?, ?, 99, ?, ?)`)
      assert.throws(() => insertModel.run("null-context", "Null context", "second", null, 32000), /NOT NULL constraint failed/)
      assert.throws(() => insertModel.run("null-output", "Null output", "second", 256000, null), /NOT NULL constraint failed/)
    } finally {
      db.close()
    }
    const nullableSchemaPath = `${path}.nullable-schema`
    const nullableSchemaDb = new DatabaseSync(nullableSchemaPath)
    try {
      nullableSchemaDb.exec(`CREATE TABLE models (context_window INTEGER, max_output_tokens INTEGER);
        PRAGMA user_version = 1`)
    } finally {
      nullableSchemaDb.close()
    }
    assert.throws(() => initializeProviderDatabase(nullableSchemaPath), /不支持 Provider 数据库版本 1/)
    const oldDb = new DatabaseSync(nullableSchemaPath, { readOnly: true })
    try { assert.equal((oldDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1) }
    finally { oldDb.close() }
    setDefaultModel(path, null)
  })
}

/** 验证凭据读写和错误路径不回写无效状态。 */
async function testReadAndRollback(): Promise<void> {
  await withDatabase((path) => {
    initializeProviderDatabase(path)
    saveProvider(path, { id: "configured", name: "Configured", protocol: "anthropic_messages", type: "custom" })
    saveModel(path, { supportsReasoning: true,
      modelId: "model-a", name: "claude-test", providerId: "configured", contextWindow: 256000,
      maxOutputTokens: 4096,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["output_config", "effort"] },
    })
    setProviderApiKey(path, "configured", "first-secret")
    const reference = { providerId: "configured", protocol: "anthropic_messages" as const, modelId: "model-a", name: "claude-test", reasoningLevel: "medium" }
    assert.deepEqual(readTurnProviderSnapshot(path, reference), {
      provider: { id: "configured", name: "Configured", protocol: "anthropic_messages", type: "custom" },
      model: { supportsReasoning: true,
        modelId: "model-a", name: "claude-test", providerId: "configured", protocol: "anthropic_messages",
        contextWindow: 256000, maxOutputTokens: 4096,
              reasoningLevels: ["low", "medium", "high"],
        reasoningField: { path: ["output_config", "effort"] },
      },
      credential: { providerId: "configured", apiKey: "first-secret" },
    })
    setProviderApiKey(path, "configured", "second-secret")
    assert.equal(readTurnProviderSnapshot(path, reference).credential?.apiKey, "second-secret")
    assert.throws(() => saveModel(path, { supportsReasoning: true,
      modelId: "model-missing", name: "Model", providerId: "missing", contextWindow: 256000, maxOutputTokens: 32000,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning", "effort"] },
    }), /Provider missing 不存在/)
    saveProvider(path, { id: "other", name: "Other", protocol: "responses", type: "custom" })
    assert.throws(() => saveModel(path, { supportsReasoning: true,
      modelId: "model-a", name: "Duplicate", providerId: "other", contextWindow: 256000, maxOutputTokens: 32000,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["reasoning", "effort"] },
    }), /UNIQUE constraint failed/)
    updateModel(path, { providerId: "configured", modelId: "model-a" }, {
      name: "updated-claude-test", maxOutputTokens: 2048,
    })
    assert.equal(listProviders(path)[0].models[0].name, "updated-claude-test")
    assert.equal(listProviders(path)[0].models[0].maxOutputTokens, 2048)
    assert.equal(readTurnProviderSnapshot(path, reference).model.name, "updated-claude-test")
    assert.throws(() => updateModel(path, { providerId: "configured", modelId: "model-a" }, { name: "  " }), /name must not be empty/)
    updateModel(path, { providerId: "configured", modelId: "model-a" }, { maxOutputTokens: 2048 })
    assert.equal(listProviders(path)[0].models[0].name, "updated-claude-test")
    assert.throws(() => saveModel(path, { supportsReasoning: true,
      modelId: "invalid-context", name: "Invalid", providerId: "configured", contextWindow: 0, maxOutputTokens: 32000,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["output_config", "effort"] },
    }), /contextWindow/)
    assert.throws(() => saveModel(path, { supportsReasoning: true,
      modelId: "invalid-output", name: "Invalid", providerId: "configured", contextWindow: 256000, maxOutputTokens: 0,
          reasoningLevels: ["low", "medium", "high"],
      reasoningField: { path: ["output_config", "effort"] },
    }), /maxOutputTokens/)
    assert.throws(() => setDefaultModel(path, { providerId: "other", modelId: "missing" }), /默认模型 missing 不存在/)
    assert.throws(() => setProviderApiKey(path, "missing", "secret-that-must-not-leak"), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes("secret-that-must-not-leak"), false)
      return true
    })
    assert.throws(() => saveProvider(path, {
      id: "invalid", name: "Invalid", protocol: "responses", type: "custom", defaultHeaders: { X: 1 } as unknown as Record<string, string>,
    }), /defaultHeaders/)
    assert.deepEqual(listProviders(path).map((entry) => entry.id), ["configured", "other"])
    assert.equal(readTurnProviderSnapshot(path, reference).credential?.apiKey, "second-secret")
    setProviderApiKey(path, "configured", null)
    assert.equal(readTurnProviderSnapshot(path, reference).credential, undefined)
    deleteProvider(path, "configured")
    assert.deepEqual(listProviders(path), [{ id: "other", name: "Other", protocol: "responses", type: "custom", models: [] }])
  })
}

/** 验证普通列表拒绝缺失数据库，启动初始化校验已有数据库的版本与结构。 */
async function testDatabaseErrors(): Promise<void> {
  await withDatabase(async (path) => {
    assert.throws(() => listProviders(path), (error: unknown) => error instanceof Error && error.message.includes(path))
    await writeFile(path, "not sqlite")
    assert.throws(() => initializeProviderDatabase(path), /not a database/)
  })
  await withDatabase((path) => {
    initializeProviderDatabase(path)
    const db = new DatabaseSync(path)
    try {
      db.exec("PRAGMA user_version = 9")
    } finally {
      db.close()
    }
    assert.throws(() => initializeProviderDatabase(path), /不支持 Provider 数据库版本 9/)
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
