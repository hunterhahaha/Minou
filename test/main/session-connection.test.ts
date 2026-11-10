/** 真实 SQLite 和 Runtime 上验证 Session IPC 的整条数据流；模型与工具使用本机脚本。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionRuntime } from "../../runtime/agent/src/session-runtime.ts"
import { createAbortError } from "../../runtime/error/src/abort.ts"
import { readSessionMeta } from "../../runtime/session/src/meta-store.ts"
import type { SessionMeta } from "../../runtime/session/src/session-state.ts"
import type { ModelAdapter, ModelRef } from "../../runtime/model/src/types.ts"
import type { ToolCallContext } from "../../runtime/tools/src/types.ts"
import { initializeConfigFiles } from "../../src/main/config-files.ts"
import { registerSessionIpcHandlers } from "../../src/main/session-ipc.ts"
import type { IpcMainHandlePort, SessionCompletionFailure } from "../../src/main/session-ipc.ts"
import { registerStartupDataIpcHandlers } from "../../src/main/startup-data-ipc.ts"
import type { SessionRuntimeGlobal } from "../../src/main/session-runtime-global.ts"
import { SESSION_IPC_CHANNELS as channels, STARTUP_DATA_IPC_CHANNELS } from "../../src/preload/session-api.ts"
import type { SessionControl, SessionData, SessionSummary, SessionUpdate, StartedSessionResponse } from "../../src/preload/session-api.ts"
const model: ModelRef = { providerId: "p", protocol: "responses", modelId: "first", name: "First", reasoningLevel: "medium" }
const nextModel: ModelRef = { ...model, modelId: "second", name: "Second" }
const content = [{ type: "text" as const, text: "**相同内容**" }]
/** 无 Electron 依赖的真实 handler 调用入口。 */
class Ipc implements IpcMainHandlePort {
  readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  /**
   * @param channel 通道。
   * @param handler 参数处理器。
   */
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void { this.handlers.set(channel, handler) }
  /**
   * @param channel 通道。
   * @param args 参数。
   * @returns handler 结果。
   */
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> { return await this.handlers.get(channel)!({}, ...args) as T }
}
/**
 * @param condition 观察条件。
 * @returns 条件满足。
 * @throws Error 条件五秒内未满足。
 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Session 测试等待超时")
    await new Promise<void>((done) => setTimeout(done, 10))
  }
}
/**
 * @param profile 临时目录。
 * @param approval 是否需要工具审批。
 * @returns IPC、记录与首轮释放操作。
 */
async function fixture(profile: string, approval = false) {
  const paths = await initializeConfigFiles(profile)
  const ipc = new Ipc(), updates: SessionUpdate[] = [], failures: SessionCompletionFailure[] = []
  const models: ModelRef[] = [], repairs: string[] = [], permissionAtStart: string[] = []
  const transport = { failNext: false }
  let release!: () => void
  const gate = new Promise<void>((done) => { release = done })
  let adapterCount = 0
  const global = {
    resolveProjectContext: () => ({
      workspaceInfo: "test workspace",
      resolveCurrentBaseline: async () => ({ agentsmd: { path: join(profile, "AGENTS.md"), hash: "test", content: "rules" },
        skills: { content: "", entries: [], descriptions: {} }, mcp: [] }),
    }),
    estimateSkillTokens: () => 0,
    listToolDefinitions: () => [],
    interruptTerminals: () => [],
    disposeProcessTools: async () => {},
    createTurnModelAdapter: async (reference: ModelRef): Promise<ModelAdapter> => {
      models.push(structuredClone(reference))
      const index = ++adapterCount
      let requestCount = 0
      return { contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (request, signal) {
        if (!request.context.history) {
          yield { type: "stream_end", completion: "finished" }
          return
        }
        if (!approval && index === 1) await Promise.race([gate, new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(createAbortError())
          if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true })
        })])
        if (approval && ++requestCount === 1) {
          yield { type: "block_start", index: 0, blockType: "tool_call" }
          yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: "call", name: "read", arguments: { path: join(profile, "outside.txt") } } }
          yield { type: "stream_end", completion: "tool_calls" }
        } else {
          yield { type: "block_start", index: 0, blockType: "text" }
          yield { type: "block_delta", index: 0, delta: { type: "text", text: reference.name } }
          yield { type: "block_end", index: 0, block: { type: "text", text: reference.name,
            replay: { name: "anthropic", protocol: "anthropic_messages", payloadJson: JSON.stringify({ type: "text", text: reference.name }) },
          } }
          yield { type: "stream_end", completion: "finished" }
        }
      } }
    },
    executeTool: async (name: string, args: unknown, context: ToolCallContext) => {
      assert.ok(context.fileRuntime)
      const decision = await context.fileRuntime.requestApproval(name, join(profile, "outside.txt"), { ...context, validatedArguments: args as object })
      return decision === "approved" ? { status: "success", content: [{ type: "text", text: "approved" }] }
        : { status: "error", content: [{ type: "text", text: decision }], error: { source: "tool", code: decision, message: decision } }
    },
  } as unknown as SessionRuntimeGlobal
  registerSessionIpcHandlers(ipc, (projectId, sessionId, onStateChanged) => {
    const runtime = new SessionRuntime({ sessionId, projectGroupId: projectId, sessionDirectory: join(paths.rootDir, "sessions", projectId, sessionId),
      databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "test", global, onStateChanged })
    const repair = runtime.repairSession.bind(runtime)
    runtime.repairSession = async () => { repairs.push(sessionId); return repair() }
    const adapter = runtime.createLoopOptions.bind(runtime)
    runtime.createLoopOptions = async (reference) => {
      const meta = readSessionMeta(paths.metaDatabasePath, projectId, sessionId) as SessionMeta
      permissionAtStart.push(meta.sandboxMode)
      return adapter(reference)
    }
    return runtime
  }, (failure) => failures.push(failure), { sendSessionUpdateToRenderer: (update) => {
    if (transport.failNext) { transport.failNext = false; throw new Error("transport failed") }
    updates.push(update)
  } }, paths)
  registerStartupDataIpcHandlers(ipc, paths)
  return { paths, ipc, updates, failures, models, repairs, release, permissionAtStart, transport }
}
/**
 * @param item 测试宿主。
 * @param id 对话。
 * @returns 最近的控制状态。
 */
function latest(item: Awaited<ReturnType<typeof fixture>>, id: string): SessionControl | undefined {
  const update = [...item.updates].reverse().find((update) => update.sessionId === id && update.kind === "state")
  return update?.kind === "state" ? update.control : undefined
}
/**
 * @param profile 临时用户目录。
 * @returns Query、Queue、设置与重启后历史验证。
 */
async function testHistoryQueueSettings(profile: string): Promise<void> {
  const item = await fixture(profile)
  const started = await item.ipc.invoke<StartedSessionResponse>(channels.startNewSession, "default", { content, model, sandboxMode: "sandbox-read-only" })
  await until(() => item.models.length === 1)
  assert.deepEqual(item.permissionAtStart, ["sandbox-read-only"], "首轮工具前保存权限")
  const snapshot = await item.ipc.invoke<SessionData>(channels.getSessionData, "default", started.sessionId)
  assert.equal(snapshot.control.phase, "running")
  assert.equal(item.repairs.length, 0, "活动查询不能执行恢复")
  assert.equal(snapshot.events.some((event) => event.type === "turn/end"), false)
  await item.ipc.invoke(channels.updateSessionSettings, "default", started.sessionId, { model: nextModel, sandboxMode: "full-access" })
  const renamed = await item.ipc.invoke<SessionSummary>(channels.renameSession, "default", started.sessionId, "  保留名称  ")
  assert.equal(renamed.name, "保留名称")
  assert.ok(item.updates.some((update) => update.kind === "state" && update.summary?.name === renamed.name))
  await assert.rejects(item.ipc.invoke(channels.renameSession, "default", started.sessionId, " "), /对话名称/)
  await assert.rejects(item.ipc.invoke(channels.renameSession, "default", "missing", "Missing"))
  await assert.rejects(item.ipc.invoke(channels.exportSessionMarkdown, "a0000000-0000-4000-8000-000000000001", started.sessionId))
  assert.equal(await item.ipc.invoke(channels.exportSessionMarkdown, "default", started.sessionId), "## 用户\n\n**相同内容**")
  const firstQueue = await item.ipc.invoke<{ messageId: string }>(channels.enqueueSessionMessage, "default", started.sessionId, { content })
  const secondQueue = await item.ipc.invoke<{ messageId: string }>(channels.enqueueSessionMessage, "default", started.sessionId, { content })
  assert.notEqual(firstQueue.messageId, secondQueue.messageId)
  assert.deepEqual(latest(item, started.sessionId)?.pendingMessages.map((message) => message.messageId), [firstQueue.messageId, secondQueue.messageId])
  item.release()
  await until(() => latest(item, started.sessionId)?.phase === "idle")
  assert.deepEqual(item.models, [model, nextModel, nextModel], "当前 Turn 固定，后续 Turn 重新读模型")
  const final = await item.ipc.invoke<SessionData>(channels.getSessionData, "default", started.sessionId)
  assert.equal(final.control.phase, "idle")
  assert.ok(item.repairs.length >= 1)
  assert.deepEqual(final.events.filter((event) => event.type === "user/message").map((event) => event.message.id).slice(1), [firstQueue.messageId, secondQueue.messageId])
  assert.deepEqual(final.events.filter((event) => event.type === "assistant/message").map((event) => event.message.content), [
    [{ type: "text", text: "First" }], [{ type: "text", text: "Second" }], [{ type: "text", text: "Second" }],
  ])
  const beforeExport = item.repairs.length
  assert.equal(await item.ipc.invoke(channels.exportSessionMarkdown, "default", started.sessionId),
    ["First", "Second", "Second"].map((text) => `## 用户\n\n**相同内容**\n\n## 助手\n\n${text}`).join("\n\n"))
  assert.equal(item.repairs.length, beforeExport, "导出历史不执行修复")
  const db = new DatabaseSync(item.paths.workspaceDatabasePath)
  try { db.prepare("DELETE FROM workspace_sessions WHERE session_id = ?").run(started.sessionId) } finally { db.close() }
  const sessions = await item.ipc.invoke<SessionSummary[]>(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions)
  assert.equal(sessions.find((session) => session.sessionId === started.sessionId)?.name, "保留名称", "摘要查询修复中断索引")
  const restarted = await fixture(profile)
  const recovered = await restarted.ipc.invoke<SessionData>(channels.getSessionData, "default", started.sessionId)
  assert.deepEqual(recovered.events, final.events)
  assert.doesNotMatch(JSON.stringify(final.events), /payloadJson/)
  assert.doesNotMatch(JSON.stringify(item.updates), /payloadJson/)
  assert.equal(recovered.summary.name, "保留名称")
  assert.equal(recovered.control.sandboxMode, "full-access")
  assert.deepEqual(item.failures, [])
}
/**
 * @param profile 临时目录。
 * @param decision 审批决定或 Stop。
 * @returns 正常、重复与取消审批验证。
 */
async function testApproval(profile: string, decision: "approved" | "denied" | "cancelled"): Promise<void> {
  const item = await fixture(profile, true)
  const started = await item.ipc.invoke<StartedSessionResponse>(channels.startNewSession, "default", { content, model })
  await until(() => item.updates.some((update) => update.kind === "event" && update.event.type === "approval/request"))
    .catch((error: unknown) => { throw new Error("未收到审批请求 " + decision, { cause: item.failures[0]?.error ?? error }) })
  const request = item.updates.find((update) => update.kind === "event" && update.event.type === "approval/request")
  assert.ok(request?.kind === "event" && request.event.type === "approval/request")
  const id = request.event.approvalId
  if (decision === "cancelled") await item.ipc.invoke(channels.stopSession, "default", started.sessionId)
  else {
    assert.deepEqual(await item.ipc.invoke(channels.decideSessionApproval, "default", started.sessionId, id, decision), { accepted: true })
    assert.deepEqual(await item.ipc.invoke(channels.decideSessionApproval, "default", started.sessionId, id, decision), { accepted: false })
  }
  await until(() => latest(item, started.sessionId)?.phase === "idle")
  const history = await item.ipc.invoke<SessionData>(channels.getSessionData, "default", started.sessionId)
  assert.deepEqual(history.events.filter((event) => event.type === "approval/result").map((event) => event.decision), [decision])
  if (decision === "approved") {
    assert.ok(history.events.some((event) => event.type === "tool/result"))
    assert.equal(await item.ipc.invoke(channels.exportSessionMarkdown, "default", started.sessionId),
      "## 用户\n\n**相同内容**\n\n## 助手\n\nFirst")
  }
  assert.deepEqual(await item.ipc.invoke(channels.decideSessionApproval, "default", started.sessionId, "unknown", "approved"), { accepted: false })
  assert.deepEqual(item.failures, [])
}
/**
 * @returns 所有真实数据库接线验证完成。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-session-connection-"))
  try {
    await testHistoryQueueSettings(root)
    for (const decision of ["approved", "denied", "cancelled"] as const) await testApproval(join(root, decision), decision)
    await testStopAndFailures(join(root, "failures"))
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
  console.log("session-connection.test.ts: 真实 Runtime、历史、Queue、设置、索引与审批断言通过")
}

/**
 * @param profile 临时目录。
 * @returns Stop 保留 Queue、传输与索引错误不撤销已提交数据的验证。
 */
async function testStopAndFailures(profile: string): Promise<void> {
  const stopped = await fixture(join(profile, "stop"))
  const first = await stopped.ipc.invoke<StartedSessionResponse>(channels.startNewSession, "default", { content, model })
  await until(() => stopped.models.length === 1)
  const queued = await stopped.ipc.invoke<{ messageId: string }>(channels.enqueueSessionMessage, "default", first.sessionId, { content })
  await stopped.ipc.invoke(channels.stopSession, "default", first.sessionId)
  await until(() => latest(stopped, first.sessionId)?.phase === "idle")
  assert.deepEqual(latest(stopped, first.sessionId)?.pendingMessages.map((message) => message.messageId), [queued.messageId])
  const stoppedData = await stopped.ipc.invoke<SessionData>(channels.getSessionData, "default", first.sessionId)
  assert.equal(stoppedData.events.filter((event) => event.type === "user/message").length, 1)
  assert.deepEqual(stoppedData.control.pendingMessages.map((message) => message.messageId), [queued.messageId])
  assert.deepEqual(stoppedData.control.discardedMessages, [])

  const sending = await fixture(join(profile, "transport"))
  const second = await sending.ipc.invoke<StartedSessionResponse>(channels.startNewSession, "default", { content, model })
  await until(() => sending.models.length === 1)
  sending.transport.failNext = true
  sending.release()
  await until(() => latest(sending, second.sessionId)?.phase === "idle")
  assert.equal(sending.failures.length, 1)
  assert.match(String(sending.failures[0].error), /transport failed/)
  const intact = await sending.ipc.invoke<SessionData>(channels.getSessionData, "default", second.sessionId)
  assert.ok(intact.events.some((event) => event.type === "assistant/message"))
  assert.equal(intact.events.at(-1)?.type, "turn/end")

  const indexing = await fixture(join(profile, "index"))
  const workspacePath = indexing.paths.workspaceDatabasePath
  indexing.paths.workspaceDatabasePath = join(profile, "missing-workspace.sqlite")
  const third = await indexing.ipc.invoke<StartedSessionResponse>(channels.startNewSession, "default", { content, model })
  assert.ok(third.sessionId, "索引失败仍返回已提交对话")
  assert.ok(indexing.updates.some((update) => update.kind === "error" && update.stage === "index"))
  indexing.paths.workspaceDatabasePath = workspacePath
  indexing.release()
  await until(() => latest(indexing, third.sessionId)?.phase === "idle")
  const sessions = await indexing.ipc.invoke<SessionSummary[]>(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions)
  assert.equal(sessions.some((session) => session.sessionId === third.sessionId), true)
  assert.ok((await indexing.ipc.invoke<SessionData>(channels.getSessionData, "default", third.sessionId)).events.length > 0)
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
