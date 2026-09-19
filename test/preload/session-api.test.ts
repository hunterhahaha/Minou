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

async function testCallsFixedChannels(): Promise<void> {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const ipcRenderer: IpcRendererInvokePort = {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args })
      return channel === SESSION_IPC_CHANNELS.startNewSession
        ? { sessionId: "new-session", turn: 1 }
        : { sessionId: "existing-session", turn: 4 }
    },
  }
  const api = createSessionApi(ipcRenderer)

  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(
    await api.startNewSession({ content: CONTENT, model: MODEL }),
    { sessionId: "new-session", turn: 1 },
  )
  assert.deepEqual(
    await api.continueSession("existing-session", { content: CONTENT }),
    { sessionId: "existing-session", turn: 4 },
  )
  assert.deepEqual(calls, [
    {
      channel: SESSION_IPC_CHANNELS.startNewSession,
      args: [{ content: CONTENT, model: MODEL }],
    },
    {
      channel: SESSION_IPC_CHANNELS.continueSession,
      args: ["existing-session", { content: CONTENT }],
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
    ["continueSession", "startNewSession"],
  )
}

async function testRejectsInvalidMainResponse(): Promise<void> {
  const api = createSessionApi({ invoke: async () => ({ sessionId: "", turn: 0 }) })
  await assert.rejects(
    api.startNewSession({ content: CONTENT, model: MODEL }),
    /无效的 Session 启动结果/,
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
