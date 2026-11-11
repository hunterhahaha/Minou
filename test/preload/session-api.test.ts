import assert from "node:assert/strict"

import type { ModelRef } from "../../runtime/model/src/types.ts"
import { DEFAULT_TEAM_WAKEUP_CONFIG } from "../../runtime/session/src/team-wakeup-config.ts"
import {
  createSessionApi,
  exposeSessionApi,
  NICODE_PRELOAD_GLOBAL,
  SESSION_IPC_CHANNELS,
  START_TEAM_SESSION_CHANNEL,
  TEAM_WAKEUP_CHANNELS,
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
  reasoningLevel: "medium",
}
const CONTENT = [{ type: "text" as const, text: "你好" }]
const PROJECT_ID = "00000000-0000-4000-8000-000000000017"
const PROVIDER_MODEL = { supportsReasoning: true, name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096 }
const REASONING = { supportsReasoning: true, reasoningLevels: ["low", "medium", "high"], reasoningField: { path: ["reasoning", "effort"] } }
const PROVIDER_REFERENCE = { providerId: "provider-1", modelId: "model-1" }
const COMPATIBLE_OPTIONS = [
  { name: "Sample", protocol: ["responses", "chat_completions"] },
  { name: "Other", protocol: ["anthropic_messages"] },
]
const MODEL_APPEND = {
  providerId: "provider-1", modelId: "model-2", name: "new-model", contextWindow: 128000, maxOutputTokens: 4096,
  ...REASONING,
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
          providerId: "provider-1", name: "Provider", type: "custom", protocol: "responses",
          models: [{
            modelId: "model-1", name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, isDefault: true,
            ...REASONING,
          }],
        }]
      }
      if (channel === PROVIDER_IPC_CHANNELS.listCompatibleProviders) return COMPATIBLE_OPTIONS
      if (channel === PROVIDER_IPC_CHANNELS.createCustomProvider || channel === PROVIDER_IPC_CHANNELS.createCompatibleProvider) {
        return {
          providerId: "created-provider", name: "Created", type: channel === PROVIDER_IPC_CHANNELS.createCustomProvider ? "custom" : "compatible", protocol: "responses",
          models: [{
            modelId: "model-1", name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, isDefault: false,
            ...REASONING,
          }],
        }
      }
      if (channel === PROVIDER_IPC_CHANNELS.createModel) return MODEL_APPEND
      if (channel === PROJECT_IPC_CHANNELS.selectDirectory) return { path: "C:\\Work", name: "Work" }
      if (channel === PROJECT_IPC_CHANNELS.createProject) {
        return { projectId: PROJECT_ID, name: "Project", updatedAt: "2026-09-04T00:00:00Z",
          directories: [], sessions: [] }
      }
      if (channel === PROJECT_IPC_CHANNELS.renameProject) {
        return { projectId: PROJECT_ID, name: args[1], updatedAt: "2026-09-04T00:00:00Z", directories: [], sessions: [] }
      }
      if (channel === PROJECT_IPC_CHANNELS.addProjectDirectory) return { success: true }
      if (channel === PROJECT_IPC_CHANNELS.removeProjectDirectory) return { success: false, error: "不存在" }
      if (channel === PROJECT_IPC_CHANNELS.listProjectGitBranches) {
        return { isGitRepo: true, currentBranch: "main", branches: ["dev", "main"] }
      }
      if (channel === PROJECT_IPC_CHANNELS.switchProjectGitBranch) {
        return args[1] === "dev"
          ? { success: true, branchState: { isGitRepo: true, currentBranch: "dev", branches: ["dev", "main"] } }
          : { success: false, error: "存在未提交修改" }
      }
      if (channel === SESSION_IPC_CHANNELS.startNewSession) {
        return { sessionId: "new-session", turn: 1 }
      }
      if (channel === SESSION_IPC_CHANNELS.continueSession) {
        return { sessionId: "existing-session", turn: 4 }
      }
      if (channel === SESSION_IPC_CHANNELS.stopSession) {
        return { sessionId: "existing-session" }
      }
      return { sessionId: "existing-session", messageId: "queued-1", content: CONTENT }
    },
  }
  const api = createSessionApi(ipcRenderer)

  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(await api.selectDirectory(), { path: "C:\\Work", name: "Work" })
  assert.deepEqual(await api.createProject("Project"), {
    projectId: PROJECT_ID, name: "Project", updatedAt: "2026-09-04T00:00:00Z",
    directories: [], sessions: [],
  })
  assert.equal((await api.renameProject(PROJECT_ID, "Renamed")).name, "Renamed")
  await assert.rejects(api.renameProject("00000000-0000-4000-8000-000000000018", "Renamed"), /身份无效/)
  assert.deepEqual(await api.addProjectDirectory(PROJECT_ID, "C:\\Work"), { success: true })
  assert.deepEqual(await api.removeProjectDirectory(PROJECT_ID, "C:\\Work"), {
    success: false, error: "不存在",
  })
  assert.deepEqual(await api.listProjectGitBranches(PROJECT_ID), {
    isGitRepo: true, currentBranch: "main", branches: ["dev", "main"],
  })
  assert.deepEqual(await api.switchProjectGitBranch(PROJECT_ID, "dev"), {
    success: true,
    branchState: { isGitRepo: true, currentBranch: "dev", branches: ["dev", "main"] },
  })
  assert.deepEqual(await api.switchProjectGitBranch(PROJECT_ID, "dirty"), {
    success: false, error: "存在未提交修改",
  })
  assert.deepEqual(await api.listProjects(), [{
    projectId: PROJECT_ID, name: "Project", updatedAt: "2026-09-04T00:00:00Z",
    directories: ["G:\\code\\NiCode"], sessions: [],
  }])
  assert.deepEqual(await api.listDefaultSessions(), [
    { sessionId: "default-1", name: "Default", updatedAt: "2026-09-03T00:00:00Z" },
  ])
  assert.deepEqual(await api.listProviders(), [{
    providerId: "provider-1", name: "Provider", type: "custom", protocol: "responses", models: [{
      modelId: "model-1", name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, isDefault: true,
      ...REASONING,
    }],
  }])
  assert.deepEqual(await api.listCompatibleProviders(), COMPATIBLE_OPTIONS)
  const customInput = { type: "custom" as const, name: "Created", apiKey: "api-key", protocol: "responses" as const, url: "https://example.com", models: [PROVIDER_MODEL] }
  assert.deepEqual(await api.createCustomProvider(customInput), {
    providerId: "created-provider", name: "Created", type: "custom", protocol: "responses",
    models: [{
      modelId: "model-1", name: "claude-test", contextWindow: 256000, maxOutputTokens: 4096, isDefault: false,
      ...REASONING,
    }],
  })
  const compatibleInput = { type: "compatible" as const, name: "Sample", apiKey: "api-key", protocol: "responses" as const }
  assert.equal((await api.createCompatibleProvider(compatibleInput)).type, "compatible")
  await api.deleteProvider("provider-1")
  await api.updateApiKey("provider-1", null)
  assert.deepEqual(await api.createModel("provider-1", PROVIDER_MODEL), MODEL_APPEND)
  await api.updateModel(PROVIDER_REFERENCE, { name: "renamed-model" })
  await api.updateModel(PROVIDER_REFERENCE, { contextWindow: 128000 })
  await api.deleteModel(PROVIDER_REFERENCE)
  await api.setDefaultModel(PROVIDER_REFERENCE)
  await api.setDefaultModel(null)
  assert.deepEqual(
    await api.startNewSession(PROJECT_ID, { content: CONTENT, model: MODEL }),
    { sessionId: "new-session", turn: 1 },
  )
  assert.deepEqual(
    await api.continueSession(PROJECT_ID, "existing-session", { content: CONTENT }),
    { sessionId: "existing-session", turn: 4 },
  )
  assert.deepEqual(
    await api.enqueueSessionMessage(PROJECT_ID, "existing-session", { content: CONTENT }),
    { sessionId: "existing-session", messageId: "queued-1", content: CONTENT },
  )
  assert.deepEqual(
    await api.stopSession(PROJECT_ID, "existing-session"),
    { sessionId: "existing-session" },
  )
  assert.deepEqual(calls, [
    { channel: PROJECT_IPC_CHANNELS.selectDirectory, args: [] },
    { channel: PROJECT_IPC_CHANNELS.createProject, args: ["Project", undefined] },
    { channel: PROJECT_IPC_CHANNELS.renameProject, args: [PROJECT_ID, "Renamed"] },
    { channel: PROJECT_IPC_CHANNELS.renameProject, args: ["00000000-0000-4000-8000-000000000018", "Renamed"] },
    { channel: PROJECT_IPC_CHANNELS.addProjectDirectory, args: [PROJECT_ID, "C:\\Work"] },
    { channel: PROJECT_IPC_CHANNELS.removeProjectDirectory, args: [PROJECT_ID, "C:\\Work"] },
    { channel: PROJECT_IPC_CHANNELS.listProjectGitBranches, args: [PROJECT_ID] },
    { channel: PROJECT_IPC_CHANNELS.switchProjectGitBranch, args: [PROJECT_ID, "dev"] },
    { channel: PROJECT_IPC_CHANNELS.switchProjectGitBranch, args: [PROJECT_ID, "dirty"] },
    { channel: STARTUP_DATA_IPC_CHANNELS.listProjects, args: [] },
    { channel: STARTUP_DATA_IPC_CHANNELS.listDefaultSessions, args: [] },
    { channel: STARTUP_DATA_IPC_CHANNELS.listProviders, args: [] },
    { channel: PROVIDER_IPC_CHANNELS.listCompatibleProviders, args: [] },
    {
      channel: PROVIDER_IPC_CHANNELS.createCustomProvider,
      args: [customInput],
    },
    { channel: PROVIDER_IPC_CHANNELS.createCompatibleProvider, args: [compatibleInput] },
    { channel: PROVIDER_IPC_CHANNELS.deleteProvider, args: ["provider-1"] },
    { channel: PROVIDER_IPC_CHANNELS.updateApiKey, args: ["provider-1", null] },
    { channel: PROVIDER_IPC_CHANNELS.createModel, args: ["provider-1", PROVIDER_MODEL] },
    { channel: PROVIDER_IPC_CHANNELS.updateModel, args: [PROVIDER_REFERENCE, { name: "renamed-model" }] },
    { channel: PROVIDER_IPC_CHANNELS.updateModel, args: [PROVIDER_REFERENCE, { contextWindow: 128000 }] },
    { channel: PROVIDER_IPC_CHANNELS.deleteModel, args: [PROVIDER_REFERENCE] },
    { channel: PROVIDER_IPC_CHANNELS.setDefaultModel, args: [PROVIDER_REFERENCE] },
    { channel: PROVIDER_IPC_CHANNELS.setDefaultModel, args: [null] },
    {
      channel: SESSION_IPC_CHANNELS.startNewSession,
      args: [PROJECT_ID, { content: CONTENT, model: MODEL }],
    },
    {
      channel: SESSION_IPC_CHANNELS.continueSession,
      args: [PROJECT_ID, "existing-session", { content: CONTENT }],
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
    ["getSessionData", "onSessionUpdate", "renameProject", "renameSession", "exportSessionMarkdown", "updateSessionSettings", "decideSessionApproval", "addProjectDirectory", "continueSession", "createModel", "createProject", "createCompatibleProvider", "createCustomProvider", "listCompatibleProviders", "deleteModel", "deleteProvider", "enqueueSessionMessage", "listDefaultSessions", "listProjects", "listProviders", "removeProjectDirectory", "selectDirectory", "setDefaultModel", "startNewSession", "stopSession", "updateApiKey", "updateModel", "updateProvider",
      "listMcpServers", "createMcpServer", "updateMcpServer", "deleteMcpServer", "reloadMcpServers", "listSkills", "setSkillEnabled",
      "listProjectGitBranches", "switchProjectGitBranch",
      "listWebSearchProviderDefinitions", "listWebSearchProviders", "getWebSearchProvider", "createWebSearchProvider",
      "updateWebSearchProvider", "deleteWebSearchProvider", "setActiveWebSearchProvider",
      "startTeamSession", "getTeamWakeupConfig", "setTeamWakeupConfig"].sort(),
  )
}

/** 校验 Team 首发和唤醒配置只走指定通道，拒绝无效输入和返回值。 */
async function testTeamApi(): Promise<void> {
  const calls: unknown[][] = []
  const started = { sessionId: "00000000-0000-4000-8000-000000000020", turn: 1, workspaceId: "00000000-0000-4000-8000-000000000021" }
  const config = { ...DEFAULT_TEAM_WAKEUP_CONFIG, pollingInterval: 31 }
  const api = createSessionApi({ invoke: async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === START_TEAM_SESSION_CHANNEL) return started
    return channel === TEAM_WAKEUP_CHANNELS.read ? DEFAULT_TEAM_WAKEUP_CONFIG : args[0]
  } })
  const input = { content: CONTENT, model: MODEL }
  assert.deepEqual(await api.startTeamSession(PROJECT_ID, input), started)
  assert.deepEqual(await api.getTeamWakeupConfig(), DEFAULT_TEAM_WAKEUP_CONFIG)
  assert.deepEqual(await api.setTeamWakeupConfig(config), config)
  await assert.rejects(api.setTeamWakeupConfig({ ...config, pollingInterval: 29 }), /配置无效/)
  assert.deepEqual(calls, [[START_TEAM_SESSION_CHANNEL, PROJECT_ID, input], [TEAM_WAKEUP_CHANNELS.read], [TEAM_WAKEUP_CHANNELS.update, config]])
  const invalid = createSessionApi({ invoke: async () => ({ ...started, workspaceId: "default" }) })
  await assert.rejects(invalid.startTeamSession(PROJECT_ID, input), /Workspace/)
  await assert.rejects(invalid.getTeamWakeupConfig(), /唤醒配置/)
}

async function testRejectsInvalidMainResponse(): Promise<void> {
  assert.deepEqual(await createSessionApi({ invoke: async () => [] }).listCompatibleProviders(), [])
  for (const result of [
    ["Sample"], [{ name: "Sample" }], [{ name: "Sample", protocol: "responses" }],
    [{ name: "Sample", protocol: [] }], [{ name: "Sample", protocol: ["invalid"] }],
    [{ name: "Sample", protocol: ["responses", "responses"] }],
    [{ name: " ", protocol: ["responses"] }],
    [{ name: "Sample", protocol: ["responses"] }, { name: "Sample", protocol: ["chat_completions"] }],
    [{ name: "Sample", protocol: ["responses"], apiKey: "must-not-be-returned" }],
  ]) {
    const invalidCatalog = createSessionApi({ invoke: async () => result })
    await assert.rejects(invalidCatalog.listCompatibleProviders(), /已兼容供应商/)
  }
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
  const missingReasoning = createSessionApi({ invoke: async () => [{
    providerId: "p", name: "P", type: "custom", protocol: "responses",
    models: [{ supportsReasoning: true, modelId: "m", name: "M", contextWindow: 256000, maxOutputTokens: 32000, isDefault: true }],
  }] })
  await assert.rejects(missingReasoning.listProviders(), /无效的 Provider 列表/)
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

  const invalidGitState = createSessionApi({ invoke: async () => ({ isGitRepo: false, currentBranch: "main", branches: [] }) })
  await assert.rejects(
    invalidGitState.listProjectGitBranches(PROJECT_ID),
    /非 Git 仓库不应包含分支状态/,
  )

  const invalidGitSwitch = createSessionApi({ invoke: async () => ({ success: false, error: "" }) })
  await assert.rejects(
    invalidGitSwitch.switchProjectGitBranch(PROJECT_ID, "main"),
    /无效的 Git 分支切换结果/,
  )
}

async function main(): Promise<void> {
  await testCallsFixedChannels()
  await testExposesOnlyNiCodeApi()
  await testTeamApi()
  await testRejectsInvalidMainResponse()
  console.log("session-api.test.ts: preload Session API 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
