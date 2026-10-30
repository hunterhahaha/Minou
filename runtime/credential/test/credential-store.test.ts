/**
 * CredentialStore 的纯内存断言，不访问数据库、网络或真实 Provider 凭据。
 *
 * 覆盖空 Store、多 Provider 查找、未知 ID、构造后的输入修改，
 * 以及空白字段与重复 Provider 的拒绝行为和校验错误中的 API Key 隐藏。
 */

import assert from "node:assert/strict"

import { CredentialStore } from "../src/index.ts"
import type { ProviderCredential } from "../src/index.ts"

/**
 * 验证空 Store 和未知 Provider 返回 undefined，已装载的多个 Provider 分别返回对应凭据。
 * @throws AssertionError 任一查找结果与预期不一致时抛出，中断本文件后续场景。
 */
function testLookup(): void {
  const empty = new CredentialStore([])
  assert.equal(empty.getApiKey("missing"), undefined)

  const store = new CredentialStore([
    { providerId: "anthropic", apiKey: "anthropic-secret" },
    { providerId: "openai", apiKey: "openai-secret" },
  ])
  assert.equal(store.getApiKey("anthropic"), "anthropic-secret")
  assert.equal(store.getApiKey("openai"), "openai-secret")
  assert.equal(store.getApiKey("other"), undefined)
}

/**
 * 构造 Store 后修改原条目的身份与密钥并向原数组追加条目，验证内存快照不随之变化。
 * @throws AssertionError 原条目的修改或新增条目影响 Store 查找结果时抛出。
 */
function testCopiesInput(): void {
  const credential: ProviderCredential = {
    providerId: "provider-1",
    apiKey: "original-secret",
  }
  const credentials = [credential]
  const store = new CredentialStore(credentials)

  credential.providerId = "changed-provider"
  credential.apiKey = "changed-secret"
  credentials.push({ providerId: "provider-2", apiKey: "second-secret" })

  assert.equal(store.getApiKey("provider-1"), "original-secret")
  assert.equal(store.getApiKey("changed-provider"), undefined)
  assert.equal(store.getApiKey("provider-2"), undefined)
}

/**
 * 验证空白 Provider ID、空白 API Key 和重复 Provider ID 在构造时被拒绝。
 * 对携带非空测试密钥的拒绝场景，同时检查校验错误消息未输出这些密钥。
 * 预期构造错误由 assert.throws 捕获，不会作为测试失败直接传播。
 * @throws AssertionError 构造未拒绝输入、错误类型或消息不符、或错误消息泄露测试密钥时抛出。
 */
function testRejectsInvalidCredentialsWithoutLeakingSecrets(): void {
  assert.throws(
    () => new CredentialStore([{ providerId: " ", apiKey: "hidden-provider-secret" }]),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /providerId/)
      assert.equal(error.message.includes("hidden-provider-secret"), false)
      return true
    },
  )
  assert.throws(
    () => new CredentialStore([{ providerId: "provider-1", apiKey: " " }]),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /API Key/)
      return true
    },
  )
  assert.throws(
    () => new CredentialStore([
      { providerId: "provider-1", apiKey: "first-secret" },
      { providerId: "provider-1", apiKey: "second-secret" },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /重复/)
      assert.equal(error.message.includes("first-secret"), false)
      assert.equal(error.message.includes("second-secret"), false)
      return true
    },
  )
}

/**
 * 顺序执行查找、输入复制和非法凭据场景，仅在全部断言完成后打印成功消息。
 * @throws AssertionError 任一场景断言失败时向顶层传播，终止当前测试进程。
 */
function main(): void {
  testLookup()
  testCopiesInput()
  testRejectsInvalidCredentialsWithoutLeakingSecrets()
  console.log("credential-store.test.ts: CredentialStore 断言通过")
}

main()
