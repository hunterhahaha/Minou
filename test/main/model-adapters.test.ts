/** 每 Turn 从磁盘重读配置、凭据并创建唯一 Protocol Adapter 的测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initNetworkDispatcher } from "../../runtime/network/src/dispatcher.ts"
import type { ModelRef } from "../../runtime/model/src/types.ts"
import { initializeConfigFiles } from "../../src/main/config-files.ts"
import type { ConfigFilePaths } from "../../src/main/config-files.ts"
import {
  createTurnModelAdapter,
  resolveTurnModelAdapterSpecification,
} from "../../src/main/model-adapters.ts"

const MODEL: ModelRef = {
  providerId: "configured",
  protocol: "chat_completions",
  modelId: "model-a",
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    providers: [{
      id: "configured",
      name: "Configured Provider",
      protocols: {
        chat_completions: {
          baseURL: "https://api.example.com/v1",
          defaultHeaders: { "X-Test": "value" },
        },
      },
      models: [{
        id: "model-a",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsReasoning: true,
        supportsTools: true,
        supportsParallelTools: true,
        supportsResponseId: true,
      }],
    }],
    mcpServers: [],
    runtime: { userMessageMode: "queue" },
    ...overrides,
  }
}

async function writeConfig(paths: ConfigFilePaths, value: unknown): Promise<void> {
  await writeFile(paths.configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function writeCredentials(paths: ConfigFilePaths, apiKey: string): Promise<void> {
  await writeFile(paths.credentialsPath, `${JSON.stringify({
    providers: [{ providerId: "configured", apiKey }],
  }, null, 2)}\n`, "utf8")
}

async function withPaths(test: (paths: ConfigFilePaths) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "nicode-turn-adapter-"))
  try {
    await test(await initializeConfigFiles(profile))
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

async function testResolvesCurrentDiskConfiguration(): Promise<void> {
  await withPaths(async (paths) => {
    await writeConfig(paths, config())
    await writeCredentials(paths, "first-secret")
    const first = await resolveTurnModelAdapterSpecification(paths, MODEL)
    assert.deepEqual(first.modelConfig, {
      id: "model-a",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      supportsReasoning: true,
      supportsTools: true,
      supportsParallelTools: true,
      supportsResponseId: true,
      providerId: "configured",
      protocol: "chat_completions",
    })
    assert.deepEqual(first.clientOptions, {
      apiKey: "first-secret",
      baseURL: "https://api.example.com/v1",
      defaultHeaders: { "X-Test": "value" },
    })

    await writeConfig(paths, config({
      providers: [{
        id: "configured",
        name: "Updated Provider",
        protocols: {
          chat_completions: {
            baseURL: "https://updated.example.com/v2",
            defaultHeaders: { "X-Updated": "yes" },
          },
        },
        models: [{ id: "model-a", contextWindow: 64000, supportsTools: false }],
      }],
    }))
    await writeCredentials(paths, "second-secret")
    const second = await resolveTurnModelAdapterSpecification(paths, MODEL)
    assert.deepEqual(second.modelConfig, {
      id: "model-a",
      contextWindow: 64000,
      supportsTools: false,
      providerId: "configured",
      protocol: "chat_completions",
    })
    assert.deepEqual(second.clientOptions, {
      apiKey: "second-secret",
      baseURL: "https://updated.example.com/v2",
      defaultHeaders: { "X-Updated": "yes" },
    })

    initNetworkDispatcher()
    const firstAdapter = await createTurnModelAdapter(paths, MODEL)
    const secondAdapter = await createTurnModelAdapter(paths, MODEL)
    assert.notEqual(firstAdapter, secondAdapter, "相同 ModelRef 的连续 Turn 也不得复用 Adapter")
  })
}

async function testRejectsInvalidBindingsWithoutSecrets(): Promise<void> {
  await withPaths(async (paths) => {
    await writeConfig(paths, config())
    await writeCredentials(paths, "must-not-leak")
    for (const model of [
      { ...MODEL, providerId: "missing-provider" },
      { ...MODEL, protocol: "responses" as const },
      { ...MODEL, modelId: "missing-model" },
    ]) {
      await assert.rejects(
        resolveTurnModelAdapterSpecification(paths, model),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(error.message.includes(paths.configPath))
          assert.equal(error.message.includes("must-not-leak"), false)
          return true
        },
      )
    }

    await writeFile(paths.credentialsPath, "{}\n", "utf8")
    await assert.rejects(
      resolveTurnModelAdapterSpecification(paths, MODEL),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(paths.credentialsPath))
        assert.ok(error.message.includes("configured"))
        assert.equal(error.message.includes("must-not-leak"), false)
        return true
      },
    )
  })
}

async function testRejectsProviderProtocolCardinalityAndDamagedFiles(): Promise<void> {
  await withPaths(async (paths) => {
    for (const protocols of [
      {},
      { anthropic_messages: {}, responses: {} },
    ]) {
      await writeConfig(paths, config({
        providers: [{
          id: "configured",
          name: "Configured Provider",
          protocols,
          models: [],
        }],
      }))
      await writeCredentials(paths, "secret")
      await assert.rejects(
        resolveTurnModelAdapterSpecification(paths, MODEL),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(error.message.includes(paths.configPath))
          assert.ok(error.message.includes("configured"))
          assert.match(error.message, /恰好包含一个协议/)
          assert.equal(error.message.includes("secret"), false)
          return true
        },
      )
    }

    await writeFile(paths.configPath, "not-json\n", "utf8")
    await assert.rejects(
      resolveTurnModelAdapterSpecification(paths, MODEL),
      (error: unknown) => error instanceof Error && error.message.includes(paths.configPath),
    )

    await writeConfig(paths, config())
    await writeFile(paths.credentialsPath, "not-json\n", "utf8")
    await assert.rejects(
      resolveTurnModelAdapterSpecification(paths, MODEL),
      (error: unknown) => error instanceof Error && error.message.includes(paths.credentialsPath),
    )
  })
}

async function main(): Promise<void> {
  await testResolvesCurrentDiskConfiguration()
  await testRejectsInvalidBindingsWithoutSecrets()
  await testRejectsProviderProtocolCardinalityAndDamagedFiles()
  console.log("model-adapters.test.ts: 每 Turn 磁盘配置与 Adapter 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
