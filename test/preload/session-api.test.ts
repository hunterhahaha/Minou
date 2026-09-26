import assert from "node:assert/strict"

import type { ModelRef } from "../../runtime/model/src/types.ts"
import {
  createSessionApi,
  exposeSessionApi,
  NICODE_PRELOAD_GLOBAL,
  SESSION_IPC_CHANNELS,
  STARTUP_DATA_IPC_CHANNELS,
  PROJECT_IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
} from "../../src/preload/session-api.ts"
import type {
  ContextBridgePort,
  IpcRendererInvokePort,
  NiCodePreloadApi,
} from "../../src/preload/session-api.ts"

const MODEL: ModelRef = {
  providerId: "provider-1",
  protocol: "anthropic_messages",
  modelId: "model-1",
  name: "claude-test",
}
const CONTENT = [{ type: "text" as const, text: "你好" }]
const PROJECT_ID = "00000000-0000-4000-8000-000000000017"
const PROVIDER_MODEL = { name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, supportsTools: true }
const PROVIDER_REFERENCE = { providerId: "provider-1", modelId: "model-1" }
const MODEL_APPEND = {
  providerId: "provider-1", modelId: "model-2", name: "new-model", contextWindow: 128000, maxOutputTokens: 4096,
}

async function testCallsFixedChannels(): Promise<void> {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const ipcRenderer: IpcRendererInvokePort = {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args })
      if (channel === STARTUP_DATA_IPC_CHANNELS.listProjects) {
        return [{ projectId: PROJECT_ID, name: "Project", updatedAt: "2026-09-04T00:00:00Z",
          directories: ["G:\\code\\NiCode"], sessions: [] }]
      }
      if (channel === STARTUP_DATA_IPC_CHANNELS.listDefaultSessions) {
        return [{ sessionId: "default-1", name: "Default", updatedAt: "2026-09-03T00:00:00Z" }]
      }
      if (channel === STARTUP_DATA_IPC_CHANNELS.listProviders) {
        return [{
          providerId: "provider-1", name: "Provider", protocol: "responses",
          models: [{
            modelId: "model-1", name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, isDefault: true,
          }],
        }]
      }
      if (channel === PROVIDER_IPC_CHANNELS.createProvider) {
        return {
          providerId: "created-provider", name: "Created", protocol: "responses",
          models: [{
            modelId: "model-1", name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, isDefault: false,
          }],
        }
      }
      if (channel === PROVIDER_IPC_CHANNELS.createModel) return MODEL_APPEND
      if (channel === PROJECT_IPC_CHANNELS.selectDirectory) return { path: "C:\\Work", name: "Work" }
      if (channel === PROJECT_IPC_CHANNELS.createProject) {
        return { projectId: PROJECT_ID, name: "Project", updatedAt: "2026-09-04T00:00:00Z",
          directories: [], sessions: [] }
      }
      if (channel === PROJECT_IPC_CHANNELS.addProjectDirectory) return { success: true }
      if (channel === PROJECT_IPC_CHANNELS.removeProjectDirectory) return { success: false, error: "不存在" }
      if (channel === SESSION_IPC_CHANNELS.startNewSession) {
        return { sessionId: "new-session", turn: 1 }
      }
      if (channel === SESSION_IPC_CHANNELS.continueSession) {
        return { sessionId: "existing-session", turn: 4 }
      }
      if (channel === SESSION_IPC_CHANNELS.stopSession) {
        return { sessionId: "existing-session" }
      }
      return { sessionId: "existing-session", content: CONTENT }
    },
  }
  const api = createSessionApi(ipcRenderer)

  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(await api.selectDirectory(), { path: "C:\\Work", name: "Work" })
  assert.deepEqual(await api.createProject("Project"), {
    projectId: PROJECT_ID, name: "Project", updatedAt: "2026-09-04T00:00:00Z",
    directories: [], sessions: [],
  })
  assert.deepEqual(await api.addProjectDirectory(PROJECT_ID, "C:\\Work"), { success: true })
  assert.deepEqual(await api.removeProjectDirectory(PROJECT_ID, "C:\\Work"), {
    success: false, error: "不存在",
  })
  assert.deepEqual(await api.listProjects(), [{
    projectId: PROJECT_ID, name: "Project", updatedAt: "2026-09-04T00:00:00Z",
    directories: ["G:\\code\\NiCode"], sessions: [],
  }])
  assert.deepEqual(await api.listDefaultSessions(), [
    { sessionId: "default-1", name: "Default", updatedAt: "2026-09-03T00:00:00Z" },
  ])
  assert.deepEqual(await api.listProviders(), [{
    providerId: "provider-1", name: "Provider", protocol: "responses", models: [{
      modelId: "model-1", name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, isDefault: true,
    }],
  }])
  assert.deepEqual(await api.createProvider("Created", "api-key", "responses", "https://example.com", [PROVIDER_MODEL]), {
    providerId: "created-provider", name: "Created", protocol: "responses",
    models: [{
      modelId: "model-1", name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, isDefault: false,
    }],
  })
  await api.deleteProvider("provider-1")
  await api.updateApiKey("provider-1", null)
  assert.deepEqual(await api.createModel("provider-1", PROVIDER_MODEL), MODEL_APPEND)
  await api.updateModel(PROVIDER_REFERENCE, { name: "renamed-model" })
  await api.updateModel(PROVIDER_REFERENCE, { contextWindow: 128000, supportsTools: null })
  await api.deleteModel(PROVIDER_REFERENCE)
  await api.setDefaultModel(PROVIDER_REFERENCE)
  await api.setDefaultModel(null)
  assert.deepEqual(
    await api.startNewSession(PROJECT_ID, { content: CONTENT, model: MODEL }),
    { sessionId: "new-session", turn: 1 },
  )
  assert.deepEqual(
    await api.continueSession(PROJECT_ID, "existing-session", { content: CONTENT, model: MODEL }),
    { sessionId: "existing-session", turn: 4 },
  )
  assert.deepEqual(
    await api.enqueueSessionMessage(PROJECT_ID, "existing-session", { content: CONTENT }),
    { sessionId: "existing-session", content: CONTENT },
  )
  assert.deepEqual(
    await api.stopSession(PROJECT_ID, "existing-session"),
    { sessionId: "existing-session" },
  )
  assert.deepEqual(calls, [
    { channel: PROJECT_IPC_CHANNELS.selectDirectory, args: [] },
    { channel: PROJECT_IPC_CHANNELS.createProject, args: ["Project", undefined] },
    { channel: PROJECT_IPC_CHANNELS.addProjectDirectory, args: [PROJECT_ID, "C:\\Work"] },
    { channel: PROJECT_IPC_CHANNELS.removeProjectDirectory, args: [PROJECT_ID, "C:\\Work"] },
    { channel: STARTUP_DATA_IPC_CHANNELS.listProjects, args: [] },
    { channel: STARTUP_DATA_IPC_CHANNELS.listDefaultSessions, args: [] },
    { channel: STARTUP_DATA_IPC_CHANNELS.listProviders, args: [] },
    {
      channel: PROVIDER_IPC_CHANNELS.createProvider,
      args: ["Created", "api-key", "responses", "https://example.com", [PROVIDER_MODEL]],
    },
    { channel: PROVIDER_IPC_CHANNELS.deleteProvider, args: ["provider-1"] },
    { channel: PROVIDER_IPC_CHANNELS.updateApiKey, args: ["provider-1", null] },
    { channel: PROVIDER_IPC_CHANNELS.createModel, args: ["provider-1", PROVIDER_MODEL] },
    { channel: PROVIDER_IPC_CHANNELS.updateModel, args: [PROVIDER_REFERENCE, { name: "renamed-model" }] },
    { channel: PROVIDER_IPC_CHANNELS.updateModel, args: [PROVIDER_REFERENCE, { contextWindow: 128000, supportsTools: null }] },
    { channel: PROVIDER_IPC_CHANNELS.deleteModel, args: [PROVIDER_REFERENCE] },
    { channel: PROVIDER_IPC_CHANNELS.setDefaultModel, args: [PROVIDER_REFERENCE] },
    { channel: PROVIDER_IPC_CHANNELS.setDefaultModel, args: [null] },
    {
      channel: SESSION_IPC_CHANNELS.startNewSession,
      args: [PROJECT_ID, { content: CONTENT, model: MODEL }],
    },
    {
      channel: SESSION_IPC_CHANNELS.continueSession,
      args: [PROJECT_ID, "existing-session", { content: CONTENT, model: MODEL }],
    },
    {
      channel: SESSION_IPC_CHANNELS.enqueueSessionMessage,
      args: [PROJECT_ID, "existing-session", { content: CONTENT }],
    },
    {
      channel: SESSION_IPC_CHANNELS.stopSession,
      args: [PROJECT_ID, "existing-session"],
    },
  ])
}

async function testExposesOnlyNiCodeApi(): Promise<void> {
  let exposedKey: string | undefined
  let exposedApi: unknown
  const contextBridge: ContextBridgePort = {
    exposeInMainWorld: (apiKey, api) => {
      exposedKey = apiKey
      exposedApi = api
    },
  }
  const ipcRenderer: IpcRendererInvokePort = {
    invoke: async () => ({ sessionId: "session-1", turn: 1 }),
  }

  const api = exposeSessionApi(contextBridge, ipcRenderer)
  assert.equal(exposedKey, NICODE_PRELOAD_GLOBAL)
  assert.equal(exposedApi, api)
  assert.deepEqual(
    Object.keys(exposedApi as NiCodePreloadApi).sort(),
    ["addProjectDirectory", "continueSession", "createModel", "createProject", "createProvider", "deleteModel", "deleteProvider", "enqueueSessionMessage", "listDefaultSessions", "listProjects", "listProviders", "removeProjectDirectory", "selectDirectory", "setDefaultModel", "startNewSession", "stopSession", "updateApiKey", "updateModel"],
  )
}

async function testRejectsInvalidMainResponse(): Promise<void> {
  const invalidDirectory = createSessionApi({ invoke: async () => ({ path: "" }) })
  await assert.rejects(invalidDirectory.selectDirectory(), /无效的目录选择结果/)
  const canceled = createSessionApi({ invoke: async () => null })
  assert.equal(await canceled.selectDirectory(), null)
  const invalidCreate = createSessionApi({ invoke: async () => ({ projectId: "7" }) })
  await assert.rejects(invalidCreate.createProject("Project"), /无效的项目列表/)
  const invalidChange = createSessionApi({ invoke: async () => ({ success: false }) })
  await assert.rejects(invalidChange.addProjectDirectory(PROJECT_ID, "C:\\Work"), /无效的项目目录操作结果/)
  const invalidProjects = createSessionApi({ invoke: async () => [{ projectId: "7", sessions: [] }] })
  await assert.rejects(invalidProjects.listProjects(), /无效的项目列表/)
  const invalidSessions = createSessionApi({ invoke: async () => [{ sessionId: "x", name: "X" }] })
  await assert.rejects(invalidSessions.listDefaultSessions(), /无效的对话列表/)
  const invalidProviders = createSessionApi({ invoke: async () => [{
    providerId: "p", name: "P", protocol: "responses",
    models: [{ modelId: "m", contextWindow: 256000, isDefault: false }],
  }] })
  await assert.rejects(invalidProviders.listProviders(), /无效的 Provider 列表/)
  const invalidModelAppend = createSessionApi({ invoke: async () => ({ providerId: "p", modelId: "m" }) })
  await assert.rejects(invalidModelAppend.createModel("p", PROVIDER_MODEL), /无效的新建模型/)
  const missingProtocol = createSessionApi({ invoke: async () => [{ providerId: "p", name: "P", models: [] }] })
  await assert.rejects(missingProtocol.listProviders(), /无效的 Provider 列表/)
  const invalidProtocol = createSessionApi({ invoke: async () => [{ providerId: "p", name: "P", protocol: "invalid", models: [] }] })
  await assert.rejects(invalidProtocol.listProviders(), /无效的 Provider 列表/)
  const missingDefaultMarker = createSessionApi({ invoke: async () => [{
    providerId: "p", name: "P", protocol: "responses",
    models: [{ modelId: "m", contextWindow: 256000 }],
  }] })
  await assert.rejects(missingDefaultMarker.listProviders(), /无效的 Provider 列表/)
  const api = createSessionApi({ invoke: async () => ({ sessionId: "", turn: 0 }) })
  await assert.rejects(
    api.startNewSession(PROJECT_ID, { content: CONTENT, model: MODEL }),
    /无效的 Session 启动结果/,
  )

  const invalidQueued = createSessionApi({ invoke: async () => ({ sessionId: "session-1", content: null }) })
  await assert.rejects(
    invalidQueued.enqueueSessionMessage(PROJECT_ID, "session-1", { content: CONTENT }),
    /无效的 Session 消息入队结果/,
  )

  const invalidStopped = createSessionApi({ invoke: async () => ({ sessionId: "" }) })
  await assert.rejects(
    invalidStopped.stopSession(PROJECT_ID, "session-1"),
    /无效的 Session 停止结果/,
  )
}

async function main(): Promise<void> {
  await testCallsFixedChannels()
  await testExposesOnlyNiCodeApi()
  await testRejectsInvalidMainResponse()
  console.log("session-api.test.ts: preload Session API 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
