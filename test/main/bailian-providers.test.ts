/** 百炼真实预设经 IPC 创建、SQLite 重开及 Turn 解析的数据流验证；不调用远端 API。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerModelIpcHandlers } from "../../src/main/provider-ipc.ts"
import { initializeProviderDatabase, listProviders } from "../../src/main/provider-store.ts"
import { resolveTurnModelAdapterSpecification } from "../../src/main/model-adapters.ts"
import { resolveCompatibleProvider } from "../../src/main/compatible-providers.ts"
import { PROVIDER_IPC_CHANNELS as channels } from "../../src/preload/session-api.ts"
import type { ProviderSummary } from "../../src/preload/session-api.ts"

/**
 * 创建全部地域和协议组合，核对模型规格、推理配置及地域凭据不会串用。
 * @returns 所有持久化与 Turn 配置断言完成；始终删除隔离的临时目录。
 * @throws Error 当 IPC 创建、重开或配置断言失败时向入口传播测试失败。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "minou-bailian-"))
  try {
    const database = join(directory, "providers.sqlite")
    initializeProviderDatabase(database)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerModelIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } }, { providerDatabasePath: database })
    for (const region of ["北京", "新加坡", "弗吉尼亚", "中国香港"]) {
      for (const protocol of ["chat_completions", "anthropic_messages"] as const) {
        const name = `阿里云百炼（${region}）`
        const apiKey = `test-only-${region}-${protocol}`
        const created = handlers.get(channels.createCompatibleProvider)!({}, {
          type: "compatible", name, protocol, apiKey,
        }) as ProviderSummary
        const definition = resolveCompatibleProvider(name, protocol)!
        initializeProviderDatabase(database)
        const reopened = listProviders(database).find((provider) => provider.id === created.providerId)!
        assert.equal(reopened.baseURL, definition.url)
        assert.deepEqual(reopened.models.map((model) => model.name), definition.models.map((model) => model.name))
        for (const model of reopened.models) {
          const template = definition.models.find((entry) => entry.name === model.name)!
          const reference = { providerId: created.providerId, modelId: model.modelId, protocol, name: model.name, reasoningLevel: model.reasoningLevels[0] }
          const spec = await resolveTurnModelAdapterSpecification({ providerDatabasePath: database }, reference)
          assert.equal(spec.clientOptions.apiKey, apiKey)
          assert.equal(spec.clientOptions.baseURL, definition.url)
          assert.equal(spec.modelConfig.contextWindow, template.contextWindow)
          assert.equal(spec.modelConfig.maxOutputTokens, template.maxOutputTokens)
          assert.equal(spec.modelConfig.supportsReasoning, template.supportsReasoning)
          if (template.supportsReasoning) {
            assert.deepEqual(spec.modelConfig.reasoningLevels, template.reasoningLevels)
            assert.deepEqual(spec.modelConfig.reasoningField, template.reasoningField)
            await assert.rejects(resolveTurnModelAdapterSpecification({ providerDatabasePath: database }, {
              ...reference, reasoningLevel: "unsupported-test-level",
            }), /推理等级/)
          }
        }
      }
    }
    assert.equal(listProviders(database).length, 8)
    console.log("bailian-providers.test.ts: 八种地域/协议创建、重开、Turn 规格及凭据隔离通过")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
