import assert from "node:assert/strict"

import type { ModelRef } from "../../runtime/model/src/types.ts"
import {
  createSessionApi,
  exposeSessionApi,
  NICODE_PRELOAD_GLOBAL,
  SESSION_IPC_CHANNELS,
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
}
const CONTENT = [{ type: "text" as const, text: "你好" }]
const PROJECT_ID = 17

async function testCallsFixedChannels(): Promise<void> {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const ipcRenderer: IpcRendererInvokePort = {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args })
      if (channel === SESSION_IPC_CHANNELS.startNewSession) {
        return { sessionId: "new-session", turn: 1 }
      }
      if (channel === SESSION_IPC_CHANNELS.continueSession) {
        return { sessionId: "existing-session", turn: 4 }
      }
      return { sessionId: "existing-session", content: CONTENT }
    },
  }
  const api = createSessionApi(ipcRenderer)

  assert.equal(Object.isFrozen(api), true)
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
    { sessionId: "existing-session", content: CONTENT },
  )
  assert.deepEqual(calls, [
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
    ["continueSession", "enqueueSessionMessage", "startNewSession"],
  )
}

async function testRejectsInvalidMainResponse(): Promise<void> {
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
