/** 思考能力从 IPC、持久化到 Turn 与 CLI 解析的完整数据流。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { registerModelIpcHandlers } from "../../src/main/provider-ipc.ts"
import { initializeProviderDatabase, listProviders, saveModel, updateModel } from "../../src/main/provider-store.ts"
import { resolveTurnModelAdapterSpecification } from "../../src/main/model-adapters.ts"
import { resolveModel } from "../../src/cli/main.ts"
import { PROVIDER_IPC_CHANNELS as channels } from "../../src/preload/session-api.ts"
import type { ProviderSummary, ModelAppend } from "../../src/preload/session-api.ts"
import { COMPATIBLE_PROVIDERS } from "../../src/main/compatible-providers.ts"

/** 在临时数据库验证能力必填、默认补齐、更新、恢复和无思考请求的解析。
 * @returns 完整数据流断言完成；临时目录始终清理。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-reasoning-"))
  try {
    const database = join(directory, "providers.sqlite")
    initializeProviderDatabase(database)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerModelIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } }, { providerDatabasePath: database })
    const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({}, ...args)
    const provider = invoke(channels.createCustomProvider, { type: "custom", name: "test", protocol: "responses", url: "https://example.com/v1", apiKey: "test-key", models: [] }) as ProviderSummary
    for (const capability of [undefined, null, 0, "true"]) {
      assert.throws(() => invoke(channels.createModel, provider.providerId, { name: "missing", supportsReasoning: capability }), /模型配置错误/)
    }
    const disabled = invoke(channels.createModel, provider.providerId, { name: "plain", supportsReasoning: false, reasoningLevels: [], reasoningField: { path: [] } }) as ModelAppend
    assert.equal(disabled.supportsReasoning, false)
    assert.deepEqual(disabled.reasoningLevels, ["low", "medium", "high"])
    assert.deepEqual(disabled.reasoningField, { path: ["reasoning", "effort"] })
    const reference = { providerId: provider.providerId, modelId: disabled.modelId }
    const stale = { ...reference, protocol: "responses" as const, name: "plain", reasoningLevel: "obsolete" }
    assert.equal((await resolveTurnModelAdapterSpecification({ providerDatabasePath: database }, stale)).modelConfig.supportsReasoning, false)
    assert.equal(resolveModel(database, { modelId: disabled.modelId, reasoningLevel: "obsolete" }).reasoningLevel, "obsolete")
    invoke(channels.updateModel, reference, { supportsReasoning: true })
    await assert.rejects(resolveTurnModelAdapterSpecification({ providerDatabasePath: database }, stale), /推理等级/)
    assert.throws(() => resolveModel(database, { modelId: disabled.modelId, reasoningLevel: "obsolete" }), /推理等级/)
    invoke(channels.updateModel, reference, { reasoningLevels: ["deep"], reasoningField: { path: ["custom", "effort"] } })
    invoke(channels.updateModel, reference, { supportsReasoning: false })
    let model = listProviders(database)[0].models[0]
    assert.deepEqual(model.reasoningLevels, ["deep"], "关闭能力保留已保存配置")
    invoke(channels.updateModel, reference, { reasoningLevels: null })
    model = listProviders(database)[0].models[0]
    assert.deepEqual(model.reasoningLevels, ["low", "medium", "high"])
    assert.deepEqual(model.reasoningField, { path: ["custom", "effort"] }, "省略路径保持原值")
    invoke(channels.updateModel, reference, { reasoningField: { path: [] } })
    const before = listProviders(database)
    for (const update of [{ supportsReasoning: null }, { reasoningLevels: ["high", "high"] }, { reasoningField: { path: ["constructor"] } }]) {
      assert.throws(() => invoke(channels.updateModel, reference, update), /模型更新内容错误/)
      assert.deepEqual(listProviders(database), before)
    }
    saveModel(database, { modelId: "direct", providerId: provider.providerId, name: "direct", contextWindow: 256000, maxOutputTokens: 32000, supportsReasoning: true })
    updateModel(database, { providerId: provider.providerId, modelId: "direct" }, { reasoningLevels: [], reasoningField: null })
    assert.deepEqual(listProviders(database)[0].models[1].reasoningField, { path: ["reasoning", "effort"] })
    initializeProviderDatabase(database)
    assert.deepEqual(listProviders(database)[0].models[0], before[0].models[0])
    const db = new DatabaseSync(database)
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 3)
      assert.throws(() => db.exec("UPDATE models SET supports_reasoning = 2"), /CHECK constraint/)
      assert.throws(() => db.exec("UPDATE models SET supports_reasoning = NULL"), /NOT NULL/)
      db.exec("PRAGMA user_version = 2")
    } finally { db.close() }
    assert.throws(() => initializeProviderDatabase(database), /不支持 Provider 数据库版本 2/)
    for (const definitions of Object.values(COMPATIBLE_PROVIDERS)) for (const definition of definitions) {
      assert.ok(definition.models.every((entry) => typeof entry.supportsReasoning === "boolean"))
    }
    console.log("reasoning-capability.test.ts: IPC、写库默认、重开恢复、Turn/CLI 和内置能力通过")
  } finally { await rm(directory, { recursive: true, force: true }) }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
