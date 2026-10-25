/** 新增 Session IPC 的传输校验、监听清理及 Electron 对象隔离。 */
import assert from "node:assert/strict"
import { createSessionApi, SESSION_IPC_CHANNELS } from "../../src/preload/session-api.ts"
import type { SessionControl, SessionData, SessionUpdate } from "../../src/preload/session-api.ts"
import type { SummaryEndEvent } from "../../runtime/session/src/events.ts"
const control: SessionControl = { revision: 1, throughSeq: 0, currentModel: { providerId: "p", protocol: "responses", modelId: "m", name: "test", reasoningLevel: "medium" },
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
  const summary: SummaryEndEvent = {
    type: "summary/end", summaryId: "compression-1", eventId: "summary-1", sessionId: "s", seq: 4, createdAt: "2026-10-21T00:00:00.000Z",
    turn: 1, fromEventSeq: 2, throughEventSeq: 2, summary: "compressed",
    baseline: { agentsmd: { path: "G:/AGENTS.md", hash: "hash", content: "rules" }, skills: { content: "", entries: [], descriptions: {} } },
  }
  const started: SessionUpdate = { kind: "event", projectId: "default", sessionId: "s", event: {
    type: "summary/start", summaryId: summary.summaryId, turn: 1, fromEventSeq: 2, throughEventSeq: 2,
    eventId: "start-1", seq: 3, sessionId: "s", createdAt: summary.createdAt,
  } }
  for (const handler of handlers) handler({}, started)
  assert.deepEqual(updates.at(-1), started, "Summary 开始可通过推送事件白名单")
  const summaryUpdate: SessionUpdate = { kind: "event", projectId: "default", sessionId: "s", event: summary }
  for (const handler of handlers) handler({}, summaryUpdate)
  assert.deepEqual(updates.at(-1), summaryUpdate, "Summary 完成可通过推送事件白名单")
  const withSummary: SessionData = { ...history, events: [
    { type: "turn/start", turn: 1, model: control.currentModel, eventId: "turn-1", sessionId: "s", seq: 1, createdAt: summary.createdAt },
    { type: "user/message", turn: 1, message: { id: "user-1", role: "user", content: [{ type: "text", text: "user" }] }, eventId: "user-1", sessionId: "s", seq: 2, createdAt: summary.createdAt },
    started.event, summary,
  ], latestSeq: 4, control: { ...control, throughSeq: 4 } }
  const querySummary = createSessionApi({ invoke: async () => withSummary })
  assert.deepEqual(await querySummary.getSessionData("default", "s"), withSummary)
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
