/** Provider 管理 IPC 的模型身份生成与追加返回值测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { initializeProviderDatabase, listProviders, readDefaultModel } from "../../src/main/provider-store.ts"
import { registerModelIpcHandlers } from "../../src/main/provider-ipc.ts"
import type { ModelAppend, ProviderSummary } from "../../src/preload/session-api.ts"
import { PROVIDER_IPC_CHANNELS } from "../../src/preload/session-api.ts"
import type { CompatibleProviderDefinition } from "../../src/main/compatible-providers.ts"

const RESPONSE_REASONING = { reasoningLevels: ["low", "medium", "high"], reasoningField: { path: ["reasoning", "effort"] } }

/**
 * IPC handler signature accepted by Electron's invoke-shaped test helper.
 * @param event Fake IPC event passed to the handler.
 * @param args Values supplied by the simulated Renderer invocation.
 * @returns The handler's result.
 */
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

/** Stores registered handlers and invokes them without a running Electron process. */
class FakeIpcMain {
  /** Handlers registered during setup. */
  readonly handlers = new Map<string, IpcHandler>()

  /** @param channel Unique IPC channel name. @param listener Handler to register. */
  handle(channel: string, listener: IpcHandler): void {
    assert.equal(this.handlers.has(channel), false, `重复注册 IPC channel：${channel}`)
    this.handlers.set(channel, listener)
  }

  /** @param channel Channel to invoke. @param args Arguments passed to its handler. @returns The handler's result. */
  invoke(channel: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel)
    assert.ok(handler, `没有注册 IPC channel：${channel}`)
    return handler({}, ...args)
  }
}

/** @param test Assertions to run against a fresh Provider database. @returns Completion of the isolated database scenario. */
async function withDatabase(test: (path: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-provider-ipc-"))
  try {
    const path = join(directory, "providers.sqlite")
    initializeProviderDatabase(path)
    test(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Confirms both Provider creation and model append produce unique persisted model identities.
 * @returns Completion of the IPC persistence assertions.
 */
async function testModelCreationReturnsGeneratedIdentity(): Promise<void> {
  await withDatabase((providerDatabasePath) => {
    const ipc = new FakeIpcMain()
    registerModelIpcHandlers(ipc as unknown as Electron.IpcMain, { providerDatabasePath })
    const provider = ipc.invoke(
      PROVIDER_IPC_CHANNELS.createCustomProvider,
      { type: "custom", name: "Provider", apiKey: "api-key", protocol: "responses", url: "https://example.com/v1",
        models: [{ name: "  model-api-name  ", contextWindow: null, maxOutputTokens: null }] },
    ) as ProviderSummary
    const original = provider.models[0]
    assert.ok(original)
    assert.equal(provider.baseURL, "https://example.com/v1")
    assert.equal(provider.type, "custom")
    assert.deepEqual({ reasoningLevels: original.reasoningLevels, reasoningField: original.reasoningField }, RESPONSE_REASONING)
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    assert.match(provider.providerId, uuidV4)
    assert.match(original.modelId, uuidV4)
    assert.equal(original.name, "model-api-name")
    assert.equal(original.contextWindow, 256000)
    assert.equal(original.maxOutputTokens, 32000)
    assert.equal(original.isDefault, true)

    ipc.invoke(PROVIDER_IPC_CHANNELS.updateProvider, provider.providerId, "  Renamed Provider  ", "")
    const updatedProvider = listProviders(providerDatabasePath)[0]
    assert.ok(updatedProvider)
    assert.equal(updatedProvider.name, "Renamed Provider")
    assert.equal(updatedProvider.protocol, "responses")
    assert.equal(updatedProvider.baseURL, undefined)
    assert.deepEqual(updatedProvider.models.map(({ modelId }) => modelId), [original.modelId])

    const appended = ipc.invoke(
      PROVIDER_IPC_CHANNELS.createModel,
      provider.providerId,
      { name: "  second-model  ", contextWindow: 64000 },
    ) as ModelAppend
    assert.match(appended.modelId, uuidV4)
    assert.deepEqual(appended, {
      providerId: provider.providerId,
      modelId: appended.modelId,
      name: "second-model",
      contextWindow: 64000,
      maxOutputTokens: 32000,
      ...RESPONSE_REASONING,
    })
    assert.notEqual(appended.modelId, original.modelId)
    assert.deepEqual(listProviders(providerDatabasePath)[0]?.models.map(({ modelId, name }) => ({ modelId, name })), [
      { modelId: original.modelId, name: "model-api-name" },
      { modelId: appended.modelId, name: "second-model" },
    ])
    assert.deepEqual(listProviders(providerDatabasePath)[0]?.models.map(({ contextWindow, maxOutputTokens }) => ({
      contextWindow,
      maxOutputTokens,
    })), [
      { contextWindow: 256000, maxOutputTokens: 32000 },
      { contextWindow: 64000, maxOutputTokens: 32000 },
    ])

    const defaulted = ipc.invoke(
      PROVIDER_IPC_CHANNELS.createModel,
      provider.providerId,
      { name: "  defaulted-model  " },
    ) as ModelAppend
    assert.equal(defaulted.contextWindow, 256000)
    assert.equal(defaulted.maxOutputTokens, 32000)
    assert.deepEqual(listProviders(providerDatabasePath)[0]?.models[2], {
      modelId: defaulted.modelId,
      name: "defaulted-model",
      providerId: provider.providerId,
      contextWindow: 256000,
      maxOutputTokens: 32000,
      ...RESPONSE_REASONING,
    })

    ipc.invoke(
      PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: provider.providerId, modelId: original.modelId },
      { name: "  renamed-model  ", maxOutputTokens: 8192 },
    )
    assert.deepEqual(listProviders(providerDatabasePath)[0]?.models[0], {
      modelId: original.modelId, name: "renamed-model", providerId: provider.providerId,
      contextWindow: 256000, maxOutputTokens: 8192,
      ...RESPONSE_REASONING,
    })
    assert.throws(() => ipc.invoke(
      PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: provider.providerId, modelId: original.modelId },
      { name: "  " },
    ), /模型更新内容错误/)
    assert.throws(() => ipc.invoke(
      PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: provider.providerId, modelId: original.modelId },
      { maxOutputTokens: null },
    ), /模型更新内容错误/)
    assert.throws(() => ipc.invoke(
      PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: provider.providerId, modelId: original.modelId },
      { extra: true },
    ), /模型更新内容错误/)

    assert.throws(() => ipc.invoke(
      PROVIDER_IPC_CHANNELS.createModel,
      provider.providerId,
      { name: " ", contextWindow: 32000 },
    ), /模型配置错误/)
    assert.throws(() => ipc.invoke(
      PROVIDER_IPC_CHANNELS.createModel,
      provider.providerId,
      { name: "invalid-context-window", contextWindow: 0 },
    ), /模型配置错误/)
    assert.throws(() => ipc.invoke(
      PROVIDER_IPC_CHANNELS.createModel,
      provider.providerId,
      { name: "invalid-output-limit", maxOutputTokens: 0 },
    ), /模型配置错误/)
    assert.throws(() => ipc.invoke(
      PROVIDER_IPC_CHANNELS.createModel,
      provider.providerId,
      { name: "unknown-field", extra: true },
    ), /模型配置错误/)
    assert.throws(() => ipc.invoke(
      PROVIDER_IPC_CHANNELS.updateProvider,
      "missing-provider",
      "Name",
      "https://example.com/v1",
    ), /Provider 不存在/)
  })
}

/**
 * 验证 Provider 创建与更新只接受 HTTP(S) 绝对地址，拒绝时不写入数据库。
 * @returns URL 校验、地址清空和持久化保持原值的断言完成。
 */
async function testProviderURLValidation(): Promise<void> {
  await withDatabase((providerDatabasePath) => {
    const ipc = new FakeIpcMain()
    registerModelIpcHandlers(ipc as unknown as Electron.IpcMain, { providerDatabasePath })
    const invalidURLs = ["not-a-url", "/v1", "https:example.com", "http://", "ftp://example.com/v1"]
    for (const url of invalidURLs) {
      assert.throws(() => ipc.invoke(
        PROVIDER_IPC_CHANNELS.createCustomProvider,
        { type: "custom", name: "Invalid Provider", apiKey: "test-key", protocol: "responses", url, models: [] },
      ), /URL/)
      assert.deepEqual(listProviders(providerDatabasePath), [])
    }

    const provider = ipc.invoke(
      PROVIDER_IPC_CHANNELS.createCustomProvider,
      { type: "custom", name: "Provider", apiKey: "test-key", protocol: "responses", url: "  https://example.com/v1  ", models: [{ name: "model" }] },
    ) as ProviderSummary
    assert.equal(provider.baseURL, "https://example.com/v1")
    const baseline = listProviders(providerDatabasePath)
    for (const url of invalidURLs) {
      assert.throws(() => ipc.invoke(
        PROVIDER_IPC_CHANNELS.updateProvider, provider.providerId, "Must not be saved", url,
      ), /URL/)
      assert.deepEqual(listProviders(providerDatabasePath), baseline)
    }
    ipc.invoke(PROVIDER_IPC_CHANNELS.updateProvider, provider.providerId, "Local Provider", "  http://127.0.0.1:8080/v1  ")
    assert.equal(listProviders(providerDatabasePath)[0]?.baseURL, "http://127.0.0.1:8080/v1")
    ipc.invoke(PROVIDER_IPC_CHANNELS.updateProvider, provider.providerId, "Local Provider", "  ")
    assert.equal(listProviders(providerDatabasePath)[0]?.baseURL, undefined)
  })
}

/**
 * 验证默认模型 IPC 的持久化、引用校验、错误后保留原值，以及清空后的顺序回退。
 * @returns 默认模型的正常路径、错误边界和重新初始化后的恢复断言完成。
 */
async function testDefaultModelPersistence(): Promise<void> {
  await withDatabase((providerDatabasePath) => {
    const ipc = new FakeIpcMain()
    registerModelIpcHandlers(ipc as unknown as Electron.IpcMain, { providerDatabasePath })
    const first = ipc.invoke(PROVIDER_IPC_CHANNELS.createCustomProvider,
      { type: "custom", name: "First", apiKey: "test-key", protocol: "responses", url: "http://127.0.0.1:8080/v1", models: [{ name: "First model" }] }) as ProviderSummary
    const second = ipc.invoke(PROVIDER_IPC_CHANNELS.createCustomProvider,
      { type: "custom", name: "Second", apiKey: "test-key", protocol: "responses", url: "http://127.0.0.1:8080/v1", models: [{ name: "Second model" }] }) as ProviderSummary
    const reference = { providerId: second.providerId, modelId: second.models[0]!.modelId }
    ipc.invoke(PROVIDER_IPC_CHANNELS.setDefaultModel, reference)
    initializeProviderDatabase(providerDatabasePath)
    assert.deepEqual(readDefaultModel(providerDatabasePath), reference, "重新打开数据库后保留显式默认值")

    for (const invalid of [undefined, {}, { providerId: second.providerId }, { ...reference, modelId: " " }]) {
      assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.setDefaultModel, invalid), /默认模型引用错误/)
      assert.deepEqual(readDefaultModel(providerDatabasePath), reference)
    }
    for (const invalid of [
      { ...reference, providerId: first.providerId },
      { ...reference, modelId: "missing-model" },
    ]) {
      assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.setDefaultModel, invalid), /不存在/)
      assert.deepEqual(readDefaultModel(providerDatabasePath), reference, "不存在或不属于 Provider 的模型不得覆盖默认值")
    }
    ipc.invoke(PROVIDER_IPC_CHANNELS.setDefaultModel, null)
    assert.deepEqual(readDefaultModel(providerDatabasePath), {
      providerId: first.providerId, modelId: first.models[0]!.modelId,
    }, "清空显式选择后使用顺序中的第一个模型")
  })
}

/** 验证空目录、注入的兼容目录、协议默认值及创建失败后的清理。 */
async function testCompatibleCatalogAndReasoning(): Promise<void> {
  await withDatabase((providerDatabasePath) => {
    const empty = new FakeIpcMain()
    registerModelIpcHandlers(empty as unknown as Electron.IpcMain, { providerDatabasePath })
    assert.deepEqual(empty.invoke(PROVIDER_IPC_CHANNELS.listCompatibleProviders), [])
    assert.throws(() => empty.invoke(PROVIDER_IPC_CHANNELS.createCompatibleProvider,
      { type: "compatible", name: "Sample", protocol: "responses", apiKey: "secret" }), /不在已兼容目录/)

    const definitions: CompatibleProviderDefinition[] = [{
      name: "Sample", protocol: "responses", url: "https://sample.example/v1",
      models: [{ name: "sample-model", contextWindow: 64000, maxOutputTokens: 8192,
        reasoningLevels: ["minimal", "medium"], reasoningField: { path: ["reasoning", "effort"] } }],
    }, {
      name: "Sample", protocol: "chat_completions", url: "https://sample.example/chat",
      models: [{ name: "sample-chat-model", contextWindow: 32000, maxOutputTokens: 4096,
        reasoningLevels: ["low", "high"], reasoningField: { path: ["reasoning_effort"] } }],
    }]
    definitions.push({ ...definitions[0]! })
    const ipc = new FakeIpcMain()
    registerModelIpcHandlers(ipc as unknown as Electron.IpcMain, { providerDatabasePath }, definitions)
    assert.deepEqual(ipc.invoke(PROVIDER_IPC_CHANNELS.listCompatibleProviders), [
      { name: "Sample", protocol: ["responses", "chat_completions"] },
    ])
    assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.createCompatibleProvider,
      { type: "compatible", name: "Unknown", protocol: "responses", apiKey: "secret" }), /不在已兼容目录/)
    assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.createCompatibleProvider,
      { type: "compatible", name: "Sample", protocol: "anthropic_messages", apiKey: "secret" }), /不在已兼容目录/)
    assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.createCompatibleProvider,
      { type: "custom", name: "Sample", protocol: "responses", apiKey: "secret" }), /创建输入无效/)
    const created = ipc.invoke(PROVIDER_IPC_CHANNELS.createCompatibleProvider,
      { type: "compatible", name: "Sample", protocol: "responses", apiKey: "secret" }) as ProviderSummary
    assert.equal(created.type, "compatible")
    assert.equal(created.baseURL, "https://sample.example/v1")
    assert.deepEqual(created.models[0]?.reasoningLevels, ["minimal", "medium"])
    assert.deepEqual(listProviders(providerDatabasePath)[0]?.models[0]?.reasoningField, { path: ["reasoning", "effort"] })
    ipc.invoke(PROVIDER_IPC_CHANNELS.updateProvider, created.providerId, "Renamed sample", "https://new.example/v1")
    ipc.invoke(PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: created.providerId, modelId: created.models[0]?.modelId }, { reasoningLevels: ["light", "strong"] })
    assert.equal(listProviders(providerDatabasePath)[0]?.type, "compatible")
    assert.deepEqual(listProviders(providerDatabasePath)[0]?.models[0]?.reasoningLevels, ["light", "strong"])
    const sampleChat = ipc.invoke(PROVIDER_IPC_CHANNELS.createCompatibleProvider,
      { type: "compatible", name: "Sample", protocol: "chat_completions", apiKey: "secret" }) as ProviderSummary
    assert.equal(sampleChat.baseURL, "https://sample.example/chat")
    assert.equal(sampleChat.models[0]?.name, "sample-chat-model")
    assert.deepEqual(sampleChat.models[0]?.reasoningField, { path: ["reasoning_effort"] })

    const anthropic = ipc.invoke(PROVIDER_IPC_CHANNELS.createCustomProvider,
      { type: "custom", name: "Anthropic", protocol: "anthropic_messages", apiKey: "secret",
        url: "https://anthropic.example", models: [{ name: "a" }] }) as ProviderSummary
    assert.deepEqual(anthropic.models[0]?.reasoningField, { path: ["output_config", "effort"] })
    const chat = ipc.invoke(PROVIDER_IPC_CHANNELS.createCustomProvider,
      { type: "custom", name: "Chat", protocol: "chat_completions", apiKey: "secret",
        url: "https://chat.example", models: [{ name: "c", reasoningLevels: ["economy", "deep"] }] }) as ProviderSummary
    assert.deepEqual(chat.models[0]?.reasoningLevels, ["economy", "deep"])
    assert.deepEqual(chat.models[0]?.reasoningField, { path: ["reasoning_effort"] })
    assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.createModel, chat.providerId,
      { name: "invalid", reasoningField: { path: ["model"] } }), /模型配置错误/)
    assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.createModel, chat.providerId,
      { name: "invalid", reasoningField: { path: ["__proto__"] } }), /模型配置错误/)
    assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: chat.providerId, modelId: chat.models[0]?.modelId }, { reasoningLevels: [] }), /模型更新内容错误/)
    ipc.invoke(PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: chat.providerId, modelId: chat.models[0]?.modelId },
      { reasoningLevels: ["fast", "deep"], reasoningField: { path: ["effort"] } })
    assert.deepEqual(listProviders(providerDatabasePath).find((entry) => entry.id === chat.providerId)?.models[0]?.reasoningLevels,
      ["fast", "deep"])

    const db = new DatabaseSync(providerDatabasePath)
    try { db.exec("CREATE TRIGGER fail_model BEFORE INSERT ON models BEGIN SELECT RAISE(ABORT, 'injected failure'); END") }
    finally { db.close() }
    const before = listProviders(providerDatabasePath)
    assert.throws(() => ipc.invoke(PROVIDER_IPC_CHANNELS.createCustomProvider,
      { type: "custom", name: "Fail", protocol: "responses", apiKey: "secret", url: "https://fail.example",
        models: [{ name: "f" }] }), /injected failure/)
    assert.deepEqual(listProviders(providerDatabasePath), before)
  })
}

/**
 * Runs the Provider IPC regression assertions and reports failures through process exit status.
 * @returns Completion after the model, URL and default selection scenarios.
 */
async function main(): Promise<void> {
  await testModelCreationReturnsGeneratedIdentity()
  await testProviderURLValidation()
  await testDefaultModelPersistence()
  await testCompatibleCatalogAndReasoning()
  console.log("provider-ipc.test.ts: Provider IPC 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
