/** CredentialStore 的只读查找、输入复制与错误边界测试。 */

import assert from "node:assert/strict"

import { CredentialStore } from "../src/index.ts"
import type { ProviderCredential } from "../src/index.ts"

/** 验证空 Store 与按 Provider 查找。 */
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

/** 验证构造后修改原始条目或数组不会改变 Store。 */
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

/** 验证空字段与重复 Provider 被拒绝，且错误不包含 API Key。 */
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

/** 依次运行 CredentialStore 的全部断言。 */
function main(): void {
  testLookup()
  testCopiesInput()
  testRejectsInvalidCredentialsWithoutLeakingSecrets()
  console.log("credential-store.test.ts: CredentialStore 断言通过")
}

main()
