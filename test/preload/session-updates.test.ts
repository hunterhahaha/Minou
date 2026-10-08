/** 新增 Session IPC 的传输校验、监听清理及 Electron 对象隔离。 */
import assert from "node:assert/strict"
import { createSessionApi, SESSION_IPC_CHANNELS } from "../../src/preload/session-api.ts"
import type { SessionControl, SessionData, SessionUpdate } from "../../src/preload/session-api.ts"
const control: SessionControl = { revision: 1, throughSeq: 0, currentModel: { providerId: "p", protocol: "responses", modelId: "m", name: "test" },
  phase: "idle", sandboxMode: "sandbox-full-access", pendingMessages: [], discardedMessages: [] }
const history: SessionData = { projectId: "default", sessionId: "s", events: [], latestSeq: 0, control,
  summary: { sessionId: "s", name: "新对话", updatedAt: "2026-09-30T00:00:00.000Z" } }
/**
 * @returns 查询、设置、审批、推送与取消监听断言完成。
 */
async function main(): Promise<void> {
  const handlers = new Set<(event: unknown, value: unknown) => void>()
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const api = createSessionApi({
    invoke: async (channel, ...args) => {
      calls.push({ channel, args })
      if (channel === SESSION_IPC_CHANNELS.getSessionData) return history
      if (channel === SESSION_IPC_CHANNELS.updateSessionSettings) return control
      return { accepted: false }
    },
    on: (channel, handler) => { assert.equal(channel, SESSION_IPC_CHANNELS.update); handlers.add(handler) },
    removeListener: (channel, handler) => { assert.equal(channel, SESSION_IPC_CHANNELS.update); handlers.delete(handler) },
  })
  assert.deepEqual(await api.getSessionData("default", "s"), history)
  assert.deepEqual(await api.updateSessionSettings("default", "s", { sandboxMode: "sandbox-read-only" }), control)
  assert.deepEqual(await api.decideSessionApproval("default", "s", "approval-1", "denied"), { accepted: false })
  assert.deepEqual(calls.map((call) => call.channel), [SESSION_IPC_CHANNELS.getSessionData, SESSION_IPC_CHANNELS.updateSessionSettings, SESSION_IPC_CHANNELS.decideSessionApproval])
  const updates: SessionUpdate[] = []
  const cancel = api.onSessionUpdate((update) => updates.push(update))
  const update: SessionUpdate = { kind: "state", projectId: "default", sessionId: "s", control }
  for (const handler of handlers) handler({ secret: "electron event" }, update)
  assert.deepEqual(updates, [update])
  cancel(); cancel()
  assert.equal(handlers.size, 0)
  const foreign = createSessionApi({ invoke: async () => ({ ...history, sessionId: "other", summary: { ...history.summary, sessionId: "other" } }) })
  await assert.rejects(foreign.getSessionData("default", "s"), /其他对话/)
  const malformed = createSessionApi({ invoke: async () => ({ ...history, latestSeq: 7 }) })
  await assert.rejects(malformed.getSessionData("default", "s"), /无效/)
  const invalidState = createSessionApi({ invoke: async () => ({ ...control, revision: -1 }) })
  await assert.rejects(invalidState.updateSessionSettings("default", "s", { model: control.currentModel }), /无效/)
  console.log("session-updates.test.ts: Session 传输与订阅断言通过")
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
