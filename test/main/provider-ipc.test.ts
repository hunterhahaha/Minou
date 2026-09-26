/** Provider 管理 IPC 的模型身份生成与追加返回值测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initializeProviderDatabase, listProviders } from "../../src/main/provider-store.ts"
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
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    assert.match(provider.providerId, uuidV4)
    assert.match(original.modelId, uuidV4)
    assert.equal(original.name, "model-api-name")
    assert.equal(original.contextWindow, 256000)
    assert.equal(original.maxOutputTokens, 32000)
    assert.equal(original.isDefault, true)

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
  })
}

/**
 * Runs the Provider IPC regression assertion and reports failures through process exit status.
 * @returns Completion after the single test scenario.
 */
async function main(): Promise<void> {
  await testModelCreationReturnsGeneratedIdentity()
  console.log("provider-ipc.test.ts: Provider IPC 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
