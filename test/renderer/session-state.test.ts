/** 无框架断言覆盖工作区缓存与流式投影；不需要 React 或浏览器。 */
import assert from "node:assert/strict"
import { WorkspaceSessionState, mergeSessionEvents, projectSessionEvents, sessionKey, throughSeq } from "../../src/renderer/session-state.ts"
import type { SessionControl, SessionData } from "../../src/preload/session-api.ts"
import type { SessionEvent, SessionEventInput } from "../../runtime/session/src/events.ts"
import type { ModelRef } from "../../runtime/model/src/types.ts"
const model: ModelRef = { providerId: "p", protocol: "responses", modelId: "m", name: "test" }
/**
 * @param seq 事件序号。
 * @param input 内容。
 * @param sessionId 对话。
 * @returns 测试事件。
 */
function event(seq: number, input: SessionEventInput, sessionId = "s"): SessionEvent {
  return { ...input, seq, eventId: sessionId + seq, sessionId, createdAt: "2026-09-30T00:00:00.000Z" } as SessionEvent
}
const first = event(1, { type: "turn/start", turn: 1, model })
const second = event(2, { type: "user/message", turn: 1, message: { id: "u", role: "user", content: [{ type: "text", text: "hello" }] } })
const third = event(3, { type: "turn/end", turn: 1, reason: "completed" })
/**
 * @param revision 版本。
 * @param throughSeq 已取得水位。
 * @returns 控制测试值。
 */
function control(revision = 1, throughSeq = 3): SessionControl {
  return { revision, throughSeq, currentModel: model, sandboxMode: "sandbox-full-access", phase: "idle", pendingMessages: [], discardedMessages: [] }
}
/**
 * @param events 查询历史。
 * @param revision 控制版本。
 * @param sessionId 对话。
 * @returns 完整查询测试值。
 */
function data(events = [first, second, third], revision = 1, sessionId = "s"): SessionData {
  return { projectId: "default", sessionId, events, latestSeq: events.at(-1)?.seq ?? 0,
    summary: { sessionId, name: "test", updatedAt: first.createdAt }, control: control(revision, events.at(-1)?.seq ?? 0) }
}
/**
 * @returns 缓存命中、首载合并、路由竞态、缺口和重试断言完成。
 */
async function testCache(): Promise<void> {
  let calls = 0, changed = 0
  let resolveLoad!: (data: SessionData) => void
  const state = new WorkspaceSessionState({ getSessionData: async () => {
    calls++; return new Promise<SessionData>((resolve) => { resolveLoad = resolve })
  } }, () => changed++)
  const key = sessionKey("default", "s")
  state.receive({ kind: "event", projectId: "default", sessionId: "s", event: third })
  assert.equal(state.has(key), false, "历史增量不能提前建立正式缓存")
  const loading = state.load("default", "s")
  assert.equal(state.load("default", "s"), loading, "首载请求应复用同一 Promise")
  assert.equal(state.has(key), false, "加载期间没有空条目")
  await Promise.resolve()
  state.receive({ kind: "event", projectId: "default", sessionId: "s", event: second })
  state.receive({ kind: "state", projectId: "default", sessionId: "s", control: control(3) })
  resolveLoad(data([first, second], 2))
  await loading
  assert.deepEqual(state.sessionEventsByKey[key], [first, second, third])
  assert.equal(state.pendingEventsRef.has(key), false)
  assert.equal(state.view(key).control?.revision, 3, "旧查询不能覆盖较新推送")
  await state.load("default", "s"); await state.load("default", "s")
  assert.equal(calls, 1, "切换回缓存对话不查询历史")
  state.setDraft(key, "未发送"); state.setDraft(sessionKey("project", "$new-chat"), "新任务")
  assert.equal(state.draftsByKey[key], "未发送")
  assert.equal(state.view(key).loading, false)
  assert.ok(changed > 0)
  const newer = new WorkspaceSessionState({ getSessionData: async () => { throw new Error("unexpected query") } }, () => {})
  newer.receive({ kind: "event", projectId: "default", sessionId: "s", event: first })
  await newer.load("default", "s")
  assert.equal(newer.has(key), true, "新对话从首条事件直接建缓存")

  let attempts = 0
  const retry = new WorkspaceSessionState({ getSessionData: async () => {
    if (++attempts === 1) throw new Error("offline")
    return data()
  } }, () => {})
  await assert.rejects(retry.load("default", "s"), /offline/)
  assert.equal(retry.has(key), false, "加载失败不建立条目")
  assert.equal(retry.sessionLoadsRef.size, 0)
  await retry.load("default", "s")
  assert.equal(retry.has(key), true)

  let repairCalls = 0
  const gaps = new WorkspaceSessionState({ getSessionData: async () => { repairCalls++; return data() } }, () => {})
  gaps.receive({ kind: "event", projectId: "default", sessionId: "s", event: first })
  gaps.receive({ kind: "state", projectId: "default", sessionId: "s", control: control(7) })
  assert.equal(gaps.view(key).control, undefined, "throughSeq 未补齐时不能应用控制")
  await gaps.load("default", "s", true)
  assert.equal(repairCalls, 1)
  assert.equal(gaps.view(key).control?.revision, 7)
  assert.equal(throughSeq(gaps.sessionEventsByKey[key]), 3)
  const cross = new WorkspaceSessionState({ getSessionData: async (_project, id) => data(id === "a" ? [] : [first], 1, id) }, () => {})
  await Promise.all([cross.load("default", "a"), cross.load("default", "b")])
  assert.deepEqual(cross.sessionEventsByKey[sessionKey("default", "a")], [])
  assert.equal(cross.sessionEventsByKey[sessionKey("default", "b")].length, 1)
  cross.receive({ kind: "error", projectId: "default", sessionId: "a", stage: "index", error: { source: "runtime", code: "INDEX", message: "索引失败" } })
  assert.equal(cross.view(sessionKey("default", "a")).operationError, "索引失败")
}
/** 流式索引排序、权威替换与身份冲突。 */
function testProjection(): void {
  const stream = [
    first, second,
    event(3, { type: "assistant/block_start", turn: 1, step: 1, blockId: "b1", index: 1, blockType: "text" }),
    event(4, { type: "assistant/block_start", turn: 1, step: 1, blockId: "b0", index: 0, blockType: "thinking" }),
    event(5, { type: "assistant/block_delta", turn: 1, step: 1, blockId: "b1", delta: { type: "text", text: "正文" } }),
    event(6, { type: "assistant/block_delta", turn: 1, step: 1, blockId: "b0", delta: { type: "thinking", text: "思考" } }),
  ]
  const projected = projectSessionEvents(stream).find((item) => item.kind === "assistant")
  assert.deepEqual(projected?.kind === "assistant" ? projected.blocks : [], [{ type: "thinking", text: "思考" }, { type: "text", text: "正文" }])
  const authoritative = event(7, { type: "assistant/message", turn: 1, step: 1, model, message: { id: "a", role: "assistant", content: [{ type: "text", text: "完整正文" }] } })
  const completed = projectSessionEvents([...stream, authoritative, event(8, { type: "assistant/block_delta", turn: 1, step: 1, blockId: "b1", delta: { type: "text", text: "迟到" } })])
  assert.deepEqual(completed.filter((item) => item.kind === "assistant").map((item) => item.blocks), [[{ type: "text", text: "完整正文" }]])
  assert.deepEqual(mergeSessionEvents([third, first], [second, third]), [first, second, third])
  assert.throws(() => mergeSessionEvents([first], [{ ...first, eventId: "other" }]), /身份冲突/)
}
/** 验证完成态分组、权威最终正文、终态边界以及历史与增量投影一致性。 */
function testCompletedTurns(): void {
  const history = [
    first,
    event(2, { type: "context_update", turn: 1, source: { type: "agents_md", path: "AGENTS.md", hash: "test", fullContent: "规则" }, content: "上下文" }),
    { ...second, seq: 3, eventId: "s3" },
    event(4, { type: "assistant/message", turn: 1, step: 1, model, message: { id: "a1", role: "assistant", content: [
      { type: "text", text: "早期正文" }, { type: "tool_call", toolCallId: "t1", name: "read", arguments: { path: "a.ts" } },
    ] } }),
    event(5, { type: "tool/result", turn: 1, step: 1, toolCallId: "t1", toolCallEventId: "call", blockId: "b1",
      result: { status: "success", content: [{ type: "text", text: "工具结果" }] } }),
    event(6, { type: "assistant/block_end", turn: 1, step: 2, blockId: "b2", index: 0, block: { type: "text", text: "流式旧正文" } }),
    event(7, { type: "assistant/message", turn: 1, step: 2, model, message: { id: "a2", role: "assistant", content: [
      { type: "thinking", text: "最终思考" }, { type: "text", text: "最终第一段" },
      { type: "tool_call", toolCallId: "t2", name: "present", arguments: {} }, { type: "text", text: "最终第二段" },
    ] } }),
    event(8, { type: "turn/file_changes", turn: 1, files: [] }),
    event(9, { type: "turn/end", turn: 1, reason: "completed" }),
  ]
  const snapshot = structuredClone(history)
  assert.equal(projectSessionEvents(history.slice(0, -1)).some((item) => item.kind === "completed-turn"), false)
  const projected = projectSessionEvents(history)
  assert.equal(projected.length, 2)
  assert.equal(projected[0]?.kind === "event" && projected[0].event.type, "user/message", "上下文事件早于用户消息也应收入用户消息之后的过程区域")
  const turn = projected.find((item) => item.kind === "completed-turn")
  assert.ok(turn?.kind === "completed-turn")
  assert.equal(turn.reason, "completed")
  assert.deepEqual(turn.finalAnswer, [{ type: "text", text: "最终第一段" }, { type: "text", text: "最终第二段" }])
  assert.deepEqual(turn.process.map((item) => item.kind === "event" ? item.event.type : [item.step, item.blocks.map((block) => block.type)]),
    ["context_update", [1, ["text", "tool_call"]], "tool/result", [2, ["thinking", "tool_call"]], "turn/file_changes", "turn/end"])
  assert.deepEqual(history, snapshot, "完成态投影不能改写原始事件")

  for (const reason of ["stopped", "error"] as const) {
    const ended = projectSessionEvents([...history.slice(0, -1), event(9, { type: "turn/end", turn: 1, reason })]).find((item) => item.kind === "completed-turn")
    assert.ok(ended?.kind === "completed-turn")
    assert.equal(ended.reason, reason)
    assert.deepEqual(ended.finalAnswer, [])
    assert.deepEqual(ended.process.filter((item) => item.kind === "assistant").map((item) => item.blocks),
      projectSessionEvents(history.slice(0, -1)).filter((item) => item.kind === "assistant").map((item) => item.blocks))
  }
  for (const content of [[{ type: "thinking" as const, text: "没有最终正文" }], []]) {
    const ended = projectSessionEvents([...history.slice(0, 7), event(8, { type: "assistant/message", turn: 1, step: 3, model,
      message: { id: "a3", role: "assistant", content } }), history[8]]).find((item) => item.kind === "completed-turn")
    assert.ok(ended?.kind === "completed-turn")
    assert.deepEqual(ended.finalAnswer, [], "最后消息无正文时不能向前寻找回答")
    assert.ok(ended.process.some((item) => item.kind === "assistant" && item.step === 2 && item.blocks.some((block) => block.type === "text")))
  }
  for (const inputs of [[first, second, third], [first, second,
    event(3, { type: "assistant/block_end", turn: 1, step: 1, blockId: "b", index: 0, block: { type: "text", text: "只有流式" } }),
    event(4, { type: "turn/end", turn: 1, reason: "completed" })]]) {
    const ended = projectSessionEvents(inputs).find((item) => item.kind === "completed-turn")
    assert.ok(ended?.kind === "completed-turn")
    assert.deepEqual(ended.finalAnswer, [], "没有权威消息不能认定最终回答")
    if (inputs.length === 4) assert.ok(ended.process.some((item) => item.kind === "assistant"))
  }

  const mixed = [...history,
    event(10, { type: "app/error", error: { source: "runtime", code: "TEST", message: "独立错误" } }),
    event(11, { type: "turn/start", turn: 2, model }),
    event(12, { type: "user/message", turn: 2, message: { id: "u2", role: "user", content: [{ type: "text", text: "第二轮" }] } }),
    event(13, { type: "assistant/block_end", turn: 2, step: 1, blockId: "b3", index: 0, block: { type: "text", text: "进行中" } }),
  ]
  const mixedView = projectSessionEvents(mixed)
  assert.deepEqual(mixedView.map((item) => item.kind), ["event", "completed-turn", "event", "event", "assistant"])
  const twoEnded = projectSessionEvents([...mixed, event(14, { type: "turn/end", turn: 2, reason: "completed" })])
  assert.deepEqual(twoEnded.filter((item) => item.kind === "completed-turn").map((item) => item.turn), [1, 2])
  assert.deepEqual(twoEnded[1], projected[1], "结束其它 Turn 不改变既有 Turn 的内容或身份")

  const incremental = new WorkspaceSessionState({ getSessionData: async () => { throw new Error("unexpected query") } }, () => {})
  const loaded = new WorkspaceSessionState({ getSessionData: async () => { throw new Error("unexpected query") } }, () => {})
  loaded.applyData(data(history))
  for (const entry of history) incremental.receive({ kind: "event", projectId: "default", sessionId: "s", event: entry })
  incremental.receive({ kind: "event", projectId: "default", sessionId: "s", event: history[8] })
  const key = sessionKey("default", "s")
  assert.deepEqual(projectSessionEvents(incremental.sessionEventsByKey[key]), projectSessionEvents(loaded.sessionEventsByKey[key]), "历史、逐条推送及重复结束事件得到相同投影")
}
/**
 * @returns 当前缓存模块验证结束。
 */
async function main(): Promise<void> {
  await testCache()
  testProjection()
  testCompletedTurns()
  console.log("session-state.test.ts: Renderer 缓存、流式与 Turn 完成态投影断言通过")
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
