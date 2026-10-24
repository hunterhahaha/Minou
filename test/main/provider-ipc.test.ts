/** Provider 管理 IPC 的模型身份生成与追加返回值测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initializeProviderDatabase, listProviders, readDefaultModel } from "../../src/main/provider-store.ts"
import { registerModelIpcHandlers } from "../../src/main/provider-ipc.ts"
import type { ModelAppend, ProviderSummary } from "../../src/preload/session-api.ts"
import { PROVIDER_IPC_CHANNELS } from "../../src/preload/session-api.ts"

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
      PROVIDER_IPC_CHANNELS.createProvider,
      "Provider", "api-key", "responses", "https://example.com/v1",
      [{ name: "  model-api-name  ", contextWindow: null, maxOutputTokens: null }],
    ) as ProviderSummary
    const original = provider.models[0]
    assert.ok(original)
    assert.equal(provider.baseURL, "https://example.com/v1")
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
    })

    ipc.invoke(
      PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: provider.providerId, modelId: original.modelId },
      { name: "  renamed-model  ", maxOutputTokens: 8192 },
    )
    assert.deepEqual(listProviders(providerDatabasePath)[0]?.models[0], {
      modelId: original.modelId, name: "renamed-model", providerId: provider.providerId,
      contextWindow: 256000, maxOutputTokens: 8192,
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
    ipc.invoke(
      PROVIDER_IPC_CHANNELS.updateModel,
      { providerId: provider.providerId, modelId: original.modelId },
      { supportsTools: false },
    )
    assert.equal(listProviders(providerDatabasePath)[0]?.models[0]?.name, "renamed-model")
    assert.equal(listProviders(providerDatabasePath)[0]?.models[0]?.supportsTools, false)

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
        PROVIDER_IPC_CHANNELS.createProvider,
        "Invalid Provider", "test-key", "responses", url, [],
      ), /URL/)
      assert.deepEqual(listProviders(providerDatabasePath), [])
    }

    const provider = ipc.invoke(
      PROVIDER_IPC_CHANNELS.createProvider,
      "Provider", "test-key", "responses", "  https://example.com/v1  ", [{ name: "model" }],
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
    const first = ipc.invoke(PROVIDER_IPC_CHANNELS.createProvider,
      "First", "test-key", "responses", "http://127.0.0.1:8080/v1", [{ name: "First model" }]) as ProviderSummary
    const second = ipc.invoke(PROVIDER_IPC_CHANNELS.createProvider,
      "Second", "test-key", "responses", "http://127.0.0.1:8080/v1", [{ name: "Second model" }]) as ProviderSummary
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

/**
 * Runs the Provider IPC regression assertions and reports failures through process exit status.
 * @returns Completion after the model, URL and default selection scenarios.
 */
async function main(): Promise<void> {
  await testModelCreationReturnsGeneratedIdentity()
  await testProviderURLValidation()
  await testDefaultModelPersistence()
  console.log("provider-ipc.test.ts: Provider IPC 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
