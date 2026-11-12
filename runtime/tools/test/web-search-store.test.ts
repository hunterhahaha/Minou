/** 搜索数据库的约束、配置语法、事务和重开恢复测试。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  deleteWebSearchProvider, initializeWebSearchDatabase, listWebSearchProviders,
  readActiveWebSearchProvider, saveWebSearchProvider, setActiveWebSearchProvider,
} from "../src/web-search/store.ts"
import type { WebSearchProviderInput } from "../src/web-search/types.ts"

/**
 * 在临时数据库验证增改查删、唯一启用约束和失败回滚，并清理资源。
 * @returns 所有存储断言完成。
 * @throws Error 数据库或断言失败。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "minou-web-store-"))
  const path = join(directory, "web-search.sqlite")
  const input: WebSearchProviderInput = {
    id: "first", name: "Test", requestJson: '{ "url": "https://example.com", "body": "${query}" }', responseJmespath: "items",
  }
  try {
    assert.throws(() => listWebSearchProviders(path))
    assert.throws(() => initializeWebSearchDatabase("relative.sqlite"))
    initializeWebSearchDatabase(path)
    initializeWebSearchDatabase(path)
    assert.deepEqual(listWebSearchProviders(path), [])
    assert.equal(readActiveWebSearchProvider(path), undefined)
    saveWebSearchProvider(path, input)
    saveWebSearchProvider(path, { ...input, id: "second" })
    assert.deepEqual(listWebSearchProviders(path)[0], { ...input, enabled: false })
    setActiveWebSearchProvider(path, "first")
    saveWebSearchProvider(path, { ...input, responseJmespath: "results" })
    assert.equal(readActiveWebSearchProvider(path)?.enabled, true)
    assert.equal(readActiveWebSearchProvider(path)?.responseJmespath, "results")
    assert.equal(readActiveWebSearchProvider(path)?.requestJson, input.requestJson)
    initializeWebSearchDatabase(path)
    assert.equal(readActiveWebSearchProvider(path)?.id, "first")
    assert.throws(() => setActiveWebSearchProvider(path, "missing"))
    assert.equal(readActiveWebSearchProvider(path)?.id, "first")

    const db = new DatabaseSync(path)
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1)
      assert.throws(() => db.prepare("UPDATE web_search_providers SET enabled = 1 WHERE id = 'second'").run())
      assert.throws(() => db.prepare("UPDATE web_search_providers SET enabled = 2 WHERE id = 'second'").run())
      assert.throws(() => db.prepare("UPDATE web_search_providers SET request_json = 'invalid'").run())
      assert.throws(() => db.prepare("UPDATE web_search_providers SET name = ' '").run())
      db.exec(`CREATE TRIGGER fail_activation BEFORE UPDATE OF enabled ON web_search_providers
        WHEN NEW.id = 'second' AND NEW.enabled = 1 BEGIN SELECT RAISE(ABORT, 'test rollback'); END`)
      assert.throws(() => setActiveWebSearchProvider(path, "second"))
      assert.equal(readActiveWebSearchProvider(path)?.id, "first", "禁用旧项后启用新项失败也必须回滚")
      db.exec("DROP TRIGGER fail_activation")
    } finally { db.close() }

    for (const invalid of [
      { ...input, id: " " }, { ...input, name: " " }, { ...input, requestJson: "not-json-secret" },
      { ...input, responseJmespath: "[" }, { ...input, responseJmespath: " " },
    ]) assert.throws(() => saveWebSearchProvider(path, invalid))
    assert.equal(listWebSearchProviders(path).length, 2)
    setActiveWebSearchProvider(path, "second")
    assert.equal(listWebSearchProviders(path).filter((entry) => entry.enabled).length, 1)
    setActiveWebSearchProvider(path, null)
    assert.equal(readActiveWebSearchProvider(path), undefined)
    setActiveWebSearchProvider(path, "first")
    deleteWebSearchProvider(path, "first")
    assert.equal(readActiveWebSearchProvider(path), undefined)
    deleteWebSearchProvider(path, "missing")
    assert.equal(listWebSearchProviders(path).length, 1)

    const corrupted = new DatabaseSync(path)
    try { corrupted.exec("UPDATE web_search_providers SET response_jmespath = '['") }
    finally { corrupted.close() }
    assert.throws(() => listWebSearchProviders(path))
    assert.throws(() => setActiveWebSearchProvider(path, "second"))
    const wrongVersion = new DatabaseSync(path)
    try { wrongVersion.exec("PRAGMA user_version = 99") }
    finally { wrongVersion.close() }
    assert.throws(() => initializeWebSearchDatabase(path))
    const verify = new DatabaseSync(path)
    try { assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 99) }
    finally { verify.close() }
    console.log("web-search-store.test.ts: 存储、约束、事务回滚与恢复通过")
  } finally { await rm(directory, { recursive: true, force: true }) }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
