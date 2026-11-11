/** 新增 Session IPC 的传输校验、监听清理及 Electron 对象隔离。 */
import assert from "node:assert/strict"
import { createSessionApi, SESSION_IPC_CHANNELS, TEAM_SESSION_CHANNELS } from "../../src/preload/session-api.ts"
import type { SessionControl, SessionData, SessionUpdate } from "../../src/preload/session-api.ts"
import type { SummaryEndEvent } from "../../runtime/session/src/events.ts"
const control: SessionControl = { revision: 1, throughSeq: 0, currentModel: { providerId: "p", protocol: "responses", modelId: "m", name: "test", reasoningLevel: "medium" },
  phase: "idle", sandboxMode: "sandbox-full-access", pendingMessages: [], discardedMessages: [] }
const history: SessionData = { projectId: "default", sessionId: "s", kind: "router", events: [], streamEvents: [], latestSeq: 0, control,
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
      if (channel === SESSION_IPC_CHANNELS.renameSession) return history.summary
      if (channel === SESSION_IPC_CHANNELS.exportSessionMarkdown) return "## 用户\n\n**原文**"
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
  assert.deepEqual(await api.renameSession("default", "s", history.summary.name), history.summary)
  assert.equal(await api.exportSessionMarkdown("default", "s"), "## 用户\n\n**原文**")
  assert.deepEqual(calls.slice(-2), [
    { channel: SESSION_IPC_CHANNELS.renameSession, args: ["default", "s", history.summary.name] },
    { channel: SESSION_IPC_CHANNELS.exportSessionMarkdown, args: ["default", "s"] },
  ])
  await assert.rejects(api.renameSession("default", "other", "Name"), /身份无效/)
  const invalidExport = createSessionApi({ invoke: async () => ({ text: "markdown" }) })
  await assert.rejects(invalidExport.exportSessionMarkdown("default", "s"), /Markdown 无效/)
  const updates: SessionUpdate[] = []
  const cancel = api.onSessionUpdate((update) => updates.push(update))
  const update: SessionUpdate = { kind: "state", projectId: "default", sessionId: "s", control, summary: history.summary }
  for (const handler of handlers) handler({ secret: "electron event" }, update)
  assert.deepEqual(updates, [update])
  const summary: SummaryEndEvent = {
    type: "summary/end", summaryId: "compression-1", eventId: "summary-1", sessionId: "s", seq: 4, createdAt: "2026-10-21T00:00:00.000Z",
    turn: 1, fromEventSeq: 2, throughEventSeq: 2, summary: "compressed",
    baseline: { mcp: [], agentsmd: { path: "G:/AGENTS.md", hash: "hash", content: "rules" }, skills: { content: "", entries: [], descriptions: {} } },
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
  const firstUpdate: SessionUpdate = { kind: "event", projectId: "default", sessionId: "s", sessionKind: "router", event: withSummary.events[0] }
  for (const handler of handlers) {
    handler({}, firstUpdate)
    assert.throws(() => handler({}, { ...firstUpdate, sessionKind: "invalid" }), /角色无效/)
    assert.throws(() => handler({}, { ...started, sessionKind: "router" }), /角色无效/)
  }
  assert.deepEqual(updates.at(-1), firstUpdate)
  const streamUpdate = {
    kind: "stream", projectId: "default", sessionId: "s",
    event: { type: "assistant/block_start", eventId: "stream-1", sessionId: "s", createdAt: summary.createdAt,
      turn: 1, step: 1, blockId: "b", index: 0, blockType: "text", streamSeq: 1, afterSeq: 3 },
  } satisfies SessionUpdate
  for (const handler of handlers) {
    handler({}, streamUpdate)
    assert.throws(() => handler({}, { ...streamUpdate, event: { ...streamUpdate.event, streamSeq: 0 } }), /无效/)
    assert.throws(() => handler({}, { ...streamUpdate, event: { ...streamUpdate.event, sessionId: "other" } }), /无效/)
  }
  assert.deepEqual(updates.at(-1), streamUpdate)
  const activeHistory: SessionData = {
    ...withSummary,
    events: [...withSummary.events.slice(0, 2), { type: "step/start", eventId: "step-1", sessionId: "s",
      createdAt: summary.createdAt, turn: 1, step: 1, seq: 3 }],
    streamEvents: [streamUpdate.event], latestSeq: 3, control: { ...control, throughSeq: 3 },
  }
  assert.deepEqual(await createSessionApi({ invoke: async () => activeHistory }).getSessionData("default", "s"), activeHistory)
  const invalidAnchor = createSessionApi({ invoke: async () => ({
    ...activeHistory, streamEvents: [{ ...streamUpdate.event, afterSeq: 4 }],
  }) })
  await assert.rejects(invalidAnchor.getSessionData("default", "s"), /活动流片段/)
  cancel(); cancel()
  assert.equal(handlers.size, 0)
  const foreign = createSessionApi({ invoke: async () => ({ ...history, sessionId: "other", summary: { ...history.summary, sessionId: "other" } }) })
  await assert.rejects(foreign.getSessionData("default", "s"), /其他对话/)
  const malformed = createSessionApi({ invoke: async () => ({ ...history, latestSeq: 7 }) })
  await assert.rejects(malformed.getSessionData("default", "s"), /无效/)
  const unknownKind = createSessionApi({ invoke: async () => ({ ...history, kind: "unknown" }) })
  await assert.rejects(unknownKind.getSessionData("default", "s"), /无效/)
  const invalidState = createSessionApi({ invoke: async () => ({ ...control, revision: -1 }) })
  await assert.rejects(invalidState.updateSessionSettings("default", "s", { model: control.currentModel }), /无效/)
  const teamHandlers = new Map<string, (event: unknown, payload: unknown) => void>()
  const teamCalls: string[] = []
  const teamApi = createSessionApi({
    invoke: async (channel) => {
      teamCalls.push(channel)
      if (channel === TEAM_SESSION_CHANNELS.list) return ["member"]
    },
    on: (channel, handler) => { teamHandlers.set(channel, handler) },
    removeListener: (channel) => { teamHandlers.delete(channel) },
  })
  assert.deepEqual(await teamApi.listTeamMembers("default", "router"), ["member"])
  await teamApi.subscribeTeamSession("default", "router", "member")
  await teamApi.unsubscribeTeamSession("default", "router", "member")
  assert.deepEqual(teamCalls, [TEAM_SESSION_CHANNELS.list, TEAM_SESSION_CHANNELS.subscribe, TEAM_SESSION_CHANNELS.unsubscribe])
  const teamUpdates: SessionUpdate[] = []
  const cancelTeam = teamApi.onTeamSessionUpdate((value) => teamUpdates.push(value))
  teamHandlers.get(TEAM_SESSION_CHANNELS.update)?.({ private: true }, update)
  teamHandlers.get(TEAM_SESSION_CHANNELS.update)?.({ private: true }, streamUpdate)
  assert.deepEqual(teamUpdates, [update, streamUpdate])
  assert.equal(teamHandlers.has(SESSION_IPC_CHANNELS.update), false)
  cancelTeam()
  assert.equal(teamHandlers.size, 0)
  await assert.rejects(createSessionApi({ invoke: async () => [null] }).listTeamMembers("default", "router"), /无效/)
  console.log("session-updates.test.ts: Session 传输与订阅断言通过")
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
