/** 启动页面三个只读 IPC 的字段、顺序、即时读取与错误传播测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

import { registerStartupDataIpcHandlers } from "../../src/main/startup-data-ipc.ts"
import type { IpcMainHandlePort } from "../../src/main/session-ipc.ts"
import {
  initializeProviderDatabase, saveModel, saveProvider, setDefaultModel, setProviderApiKey,
} from "../../src/main/provider-store.ts"
import {
  initializeWorkspaceDatabase, saveDefaultWorkspace, saveProjectWorkspace,
} from "../../src/main/workspace-store.ts"
import { STARTUP_DATA_IPC_CHANNELS } from "../../src/preload/session-api.ts"

/** 保存 handler 并以 invoke 形态调用。 */
class FakeIpcMain implements IpcMainHandlePort {
  /** 当前 channel 对应的唯一 handler。 */
  readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

  /**
   * 保存一个 channel 的 handler。
   * @param channel 固定 channel。
   * @param listener 要保存的 handler。
   * @throws Error 当 channel 已存在时抛出。
   */
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`重复注册：${channel}`)
    this.handlers.set(channel, listener)
  }

  /**
   * 调用已保存的 handler。
   * @param channel 要调用的 channel。
   * @returns handler 返回的页面数据。
   * @throws Error 当 channel 未注册或 handler 查询失败时抛出。
   */
  invoke(channel: string): unknown {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`未注册：${channel}`)
    return handler({})
  }
}

/**
 * 使用临时数据库验证三个 IPC 的读取、映射与错误路径。
 * @returns 断言完成后的 Promise。
 * @throws Error 当任一断言失败时抛出。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-startup-data-ipc-"))
  try {
    const workspaceDatabasePath = join(directory, "workspace.sqlite")
    const providerDatabasePath = join(directory, "providers.sqlite")
    initializeWorkspaceDatabase(workspaceDatabasePath)
    initializeProviderDatabase(providerDatabasePath)
    const ipc = new FakeIpcMain()
    registerStartupDataIpcHandlers(ipc, { workspaceDatabasePath, providerDatabasePath })
    assert.deepEqual([...ipc.handlers.keys()], Object.values(STARTUP_DATA_IPC_CHANNELS))
    assert.deepEqual(ipc.invoke(STARTUP_DATA_IPC_CHANNELS.listProjects), [])
    assert.deepEqual(ipc.invoke(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions), [])
    assert.deepEqual(ipc.invoke(STARTUP_DATA_IPC_CHANNELS.listProviders), [])

    const firstSession = {
      id: "session-2", name: "Second", createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-03T00:00:00Z",
    }
    const secondSession = {
      id: "session-1", name: "First", createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
    }
    saveProjectWorkspace(workspaceDatabasePath, {
      version: 1, id: "00000000-0000-4000-8000-000000000007", name: "Project", updatedAt: "2026-09-04T00:00:00Z",
      directories: ["G:\\code\\NiCode", "D:\\other"], sessions: [firstSession, secondSession],
    })
    saveDefaultWorkspace(workspaceDatabasePath, { version: 1, sessions: [secondSession, firstSession] })
    saveProvider(providerDatabasePath, { id: "provider-1", name: "Provider", protocol: "responses" })
    saveModel(providerDatabasePath, { modelId: "model-b", name: "Model B", providerId: "provider-1" })
    saveModel(providerDatabasePath, { modelId: "model-a", name: "Model A", providerId: "provider-1" })
    setProviderApiKey(providerDatabasePath, "provider-1", "private-api-key")

    assert.deepEqual(ipc.invoke(STARTUP_DATA_IPC_CHANNELS.listProjects), [{
      projectId: "00000000-0000-4000-8000-000000000007", name: "Project", updatedAt: "2026-09-04T00:00:00Z",
      directories: ["G:\\code\\NiCode", "D:\\other"],
      sessions: [
        { sessionId: "session-2", name: "Second", updatedAt: "2026-09-03T00:00:00Z" },
        { sessionId: "session-1", name: "First", updatedAt: "2026-09-02T00:00:00Z" },
      ],
    }])
    assert.deepEqual(ipc.invoke(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions), [
      { sessionId: "session-1", name: "First", updatedAt: "2026-09-02T00:00:00Z" },
      { sessionId: "session-2", name: "Second", updatedAt: "2026-09-03T00:00:00Z" },
    ])
    const providers = ipc.invoke(STARTUP_DATA_IPC_CHANNELS.listProviders)
    assert.deepEqual(providers, [{
      providerId: "provider-1", name: "Provider", protocol: "responses",
      models: [
        { modelId: "model-b", name: "Model B", contextWindow: 256000, isDefault: true },
        { modelId: "model-a", name: "Model A", contextWindow: 256000, isDefault: false },
      ],
    }])
    assert.equal(JSON.stringify(providers).includes("private-api-key"), false)
    setDefaultModel(providerDatabasePath, { providerId: "provider-1", modelId: "model-a" })
    assert.deepEqual(ipc.invoke(STARTUP_DATA_IPC_CHANNELS.listProviders), [{
      providerId: "provider-1", name: "Provider", protocol: "responses",
      models: [
        { modelId: "model-b", name: "Model B", contextWindow: 256000, isDefault: false },
        { modelId: "model-a", name: "Model A", contextWindow: 256000, isDefault: true },
      ],
    }])
    assert.throws(() => registerStartupDataIpcHandlers(ipc, { workspaceDatabasePath, providerDatabasePath }), /重复注册/)

    const missing = new FakeIpcMain()
    registerStartupDataIpcHandlers(missing, {
      workspaceDatabasePath: join(directory, "missing-workspace.sqlite"),
      providerDatabasePath: join(directory, "missing-providers.sqlite"),
    })
    assert.throws(() => missing.invoke(STARTUP_DATA_IPC_CHANNELS.listProjects), /missing-workspace.sqlite/)
    assert.throws(() => missing.invoke(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions), /missing-workspace.sqlite/)
    assert.throws(() => missing.invoke(STARTUP_DATA_IPC_CHANNELS.listProviders), /missing-providers.sqlite/)
  } finally {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(directory, { recursive: true, force: true })
  }
  console.log("startup-data-ipc.test.ts: 启动页面 IPC 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
