/** 使用真实 SQLite 和真实 preload 验证搜索管理边界。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerWebSearchIpcHandlers } from "../../src/main/web-search-ipc.ts"
import { createSessionApi, WEB_SEARCH_IPC_CHANNELS } from "../../src/preload/session-api.ts"
import { initializeWebSearchDatabase, readActiveWebSearchProvider, WEB_SEARCH_DATABASE_FILE } from "../../runtime/tools/src/web-search/store.ts"
import { buildWebSearchProviderInput } from "../../runtime/tools/src/web-search/provider-template.ts"

/** @returns 管理接口与持久化验证完成。 @throws Error 任一断言失败。 */
async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "minou-web-ipc-"))
  try {
    const database = join(rootDir, WEB_SEARCH_DATABASE_FILE)
    initializeWebSearchDatabase(database)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerWebSearchIpcHandlers({ handle(channel, handler) { assert.ok(!handlers.has(channel)); handlers.set(channel, handler) } }, { rootDir })
    const calls: string[] = []
    const api = createSessionApi({ async invoke(channel, ...args) {
      calls.push(channel)
      const handler = handlers.get(channel)
      assert.ok(handler)
      return handler({}, ...args)
    } })
    assert.equal(handlers.size, 7)
    const definition = (await api.listWebSearchProviderDefinitions())[0]!
    const input = buildWebSearchProviderInput(definition, { APIKEY: 'secret"key' })
    assert.deepEqual(await api.listWebSearchProviders(), [])
    const first = await api.createWebSearchProvider(input)
    const second = await api.createWebSearchProvider(input)
    assert.match(first.id, /^[\da-f-]{36}$/)
    assert.notEqual(first.id, second.id)
    assert.equal(first.name, second.name)
    assert.equal(first.enabled, false)
    assert.deepEqual(Object.keys(first).sort(), ["enabled", "id", "name"])
    assert.deepEqual(await api.getWebSearchProvider(first.id), { ...input, ...first })
    await api.setActiveWebSearchProvider(first.id)
    const updated = buildWebSearchProviderInput(definition, { APIKEY: "updated", max_results: 8 })
    await api.updateWebSearchProvider(first.id, updated)
    assert.equal((await api.getWebSearchProvider(first.id)).enabled, true)
    assert.equal(readActiveWebSearchProvider(database)?.requestJson, updated.requestJson)
    await api.setActiveWebSearchProvider(second.id)
    assert.deepEqual((await api.listWebSearchProviders()).filter((entry) => entry.enabled).map((entry) => entry.id), [second.id])
    assert.ok(!(JSON.stringify(await api.listWebSearchProviders())).includes("secret"))
    await assert.rejects(api.setActiveWebSearchProvider("missing"))
    assert.equal(readActiveWebSearchProvider(database)?.id, second.id)
    await api.setActiveWebSearchProvider(null)
    assert.equal(readActiveWebSearchProvider(database), undefined)
    await api.setActiveWebSearchProvider(first.id)
    await api.deleteWebSearchProvider(first.id)
    assert.equal(readActiveWebSearchProvider(database), undefined)
    for (const action of [api.getWebSearchProvider(first.id), api.updateWebSearchProvider(first.id, input), api.deleteWebSearchProvider(first.id)]) await assert.rejects(action)
    for (const bad of [{ ...input, name: "Unknown" }, { ...input, enabled: true }, { ...input, requestJson: "secret-not-json" },
      { ...input, responseJmespath: "[" }, { ...input, requestJson: JSON.stringify({ headers: { Authorization: "" }, body: '{"max_results":9}' }) }]) {
      await assert.rejects(api.createWebSearchProvider(bad), (error: Error) => !error.message.includes("secret-not-json"))
    }
    initializeWebSearchDatabase(database)
    assert.equal((await api.listWebSearchProviders()).length, 1)
    assert.deepEqual(new Set(calls), new Set(Object.values(WEB_SEARCH_IPC_CHANNELS)))
    console.log("web-search-ipc: 七个真实 preload/IPC 接口、持久化、同名、启停及错误边界通过")
  } finally { await rm(rootDir, { recursive: true, force: true }) }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
