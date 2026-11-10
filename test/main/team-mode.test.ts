import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { createAbortError } from "../../runtime/error/src/abort.ts"
import type { ModelAdapter, ModelRef } from "../../runtime/model/src/types.ts"
import { createFileSessionEventLog } from "../../runtime/session/src/event-log.ts"
import { requestMessages } from "../../runtime/model/test/helpers.ts"
import { sessionTransaction, SessionMessageQueue, withSessionDatabase } from "../../runtime/session/src/message-queue.ts"
import { insertTeamWorkspace, TeamStore } from "../../runtime/session/src/team-store.ts"
import { RenderRegistry, ToolRegistry, registerTool } from "../../runtime/tools/src/tool-registry.ts"
import { initializeConfigFilesSnapshot, readConfigFile } from "../../src/main/config-files.ts"
import { loadFileAccessState } from "../../src/main/file-access.ts"
import { startElectronApp, type ElectronAppLifecycleEvent } from "../../src/main/index.ts"
import type { SessionCompletionFailure } from "../../src/main/session-ipc.ts"
import { SessionRuntimeGlobal } from "../../src/main/session-runtime-global.ts"
import { TeamMode } from "../../src/main/team-mode.ts"
import { readDefaultWorkspace } from "../../src/main/workspace-store.ts"
import { SESSION_IPC_CHANNELS, START_TEAM_SESSION_CHANNEL, TEAM_SESSION_CHANNELS, TEAM_WAKEUP_CHANNELS, type SessionData, type SessionUpdate } from "../../src/preload/session-api.ts"

const MODEL: ModelRef = { providerId: "offline", protocol: "responses", modelId: "script", name: "Fake model", reasoningLevel: "medium" }
const message = (text: string) => ({ content: [{ type: "text" as const, text }] })

/**
 * 等待测试宿主收到后台事件，超时明确失败。
 * @param condition 返回已观察到的对象或成功标记。
 * @returns 第一次观察到的值。
 */
async function until<T>(condition: () => T | undefined | false): Promise<T> {
  const end = Date.now() + 8_000
  while (Date.now() < end) {
    const value = condition()
    if (value) return value
    await sleep(10)
  }
  throw new Error("未收到预期的主进程事件")
}

/**
 * 记录实际轮询定时任务，通过手动触发回调验证配置变化和恢复。
 * @param profile 隔离的用户目录。
 */
async function testPolling(profile: string): Promise<void> {
  const { paths, config } = await initializeConfigFilesSnapshot(profile)
  const path = join(paths.rootDir, "events.sqlite")
  const mode = new TeamMode(path, paths.configPath, config.teamWakeup, ({ error }) => { throw error })
  let resumed: TeamMode | undefined
  const originalTimeout = globalThis.setTimeout
  const timers: { delay: number; run: () => void; handle: NodeJS.Timeout }[] = []
  const kicks: string[] = []
  const dispatch = {
    kick: (_projectId: string, id: string) => { kicks.push(id) },
    cancelMember: () => {},
    restore: () => {},
    shutdown: async () => {},
  }
  globalThis.setTimeout = ((run: () => void, delay: number) => {
    const handle = originalTimeout(() => {}, 2 ** 31 - 1)
    timers.push({ delay, run, handle })
    return handle
  }) as typeof setTimeout
  try {
    mode.connect(dispatch)
    const router = mode.router("default", "poll-router", "sandbox-full-access")
    withSessionDatabase(path, (db) => sessionTransaction(db, () => insertTeamWorkspace(db, router)))
    const settings = { currentModel: MODEL, sandboxMode: router.sandboxMode }
    const authorId = mode.store.createMember(router, settings, "work")
    const targetId = mode.store.createMember(router, settings)
    mode.restore()
    assert.deepEqual(timers.map(({ delay }) => delay), [60_000])
    await mode.updateConfig({ ...mode.readConfig(), pollingInterval: 30 })
    assert.deepEqual(timers.map(({ delay }) => delay), [60_000, 30_000])
    const author = mode.store.identity("default", authorId)!
    mode.store.publish(author, { name: "progress", description: "summary", body: "body", mentions: [] })
    timers[0].run()
    assert.deepEqual(kicks, [], "旧轮询任务失效")
    timers[1].run()
    assert.deepEqual(kicks, [targetId], "重排后的轮询检查未读")
    mode.shutdown()
    const reloaded = await initializeConfigFilesSnapshot(profile)
    resumed = new TeamMode(path, paths.configPath, reloaded.config.teamWakeup, ({ error }) => { throw error })
    resumed.connect(dispatch)
    resumed.restore()
    assert.equal(new SessionMessageQueue(path, "default", targetId).read()[0].origin, "blackboard")
    assert.deepEqual(kicks, [targetId], "重启不重复唤醒已入队的成员")
    const idleId = resumed.store.createMember(router, settings)
    resumed.restore()
    assert.equal(timers.at(-1)?.delay, 30_000, "恢复使用已持久化的间隔")
    assert.equal(resumed.store.status(resumed.store.identity("default", idleId)!), "idle")
  } finally {
    mode.shutdown()
    resumed?.shutdown()
    for (const { handle } of timers) clearTimeout(handle)
    globalThis.setTimeout = originalTimeout
  }
}

/** 验证真实主进程装配、SQLite 和 AgentLoop，模型与 Electron 宿主使用离线夹具。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-team-ipc-"))
  const listeners = new Map<ElectronAppLifecycleEvent, (event?: { preventDefault(): void }) => void>()
  let quit = false
  try {
    const { paths, config: startupConfig } = await initializeConfigFilesSnapshot(root)
    await testPolling(join(root, "polling"))
    const databasePath = join(paths.rootDir, "events.sqlite")
    const store = new TeamStore(databasePath)
    const interruptedId = "interrupted"
    const sessionDirectory = join(paths.rootDir, "sessions", "default", interruptedId)
    await mkdir(sessionDirectory)
    const interrupted = createFileSessionEventLog({ databasePath, projectGroupId: "default", sessionId: interruptedId, sessionDirectory })
    await interrupted.appendTurnStartAndUserMessage([
      { type: "turn/start", turn: 1, model: MODEL },
      { type: "user/message", turn: 1, message: { role: "user", id: "already-started", ...message("must not rerun") } },
    ])
    const recoveredId = new SessionMessageQueue(databasePath, "default", interruptedId).enqueue(message("after restart"))
    const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
    const updates: SessionUpdate[] = []
    const deliveries: number[][] = []
    const failures: SessionCompletionFailure[] = []
    const modelInputs: string[] = []
    let memberId = ""
    let callNumber = 0
    const approvalRisks: string[] = []
    let releaseFailure!: () => void
    const failureGate = new Promise<void>((release) => { releaseFailure = release })
    const tools = new ToolRegistry()
    const renders = new RenderRegistry()
    registerTool(tools, renders, {
      kind: "builtin",
      definition: { name: "write", inputSchema: { type: "object" } },
      validateArguments: () => ({ success: true, data: {} }),
      execute: async (_input, context) => {
        assert.equal(loadFileAccessState(paths, "default", context.fileRuntime!.sessionId).sandboxMode, "sandbox-read-only")
        return { decision: await context.fileRuntime!.requestApproval("write", "test.txt", context) }
      },
      render: (result) => ({ status: "success", content: [{ type: "text", text: JSON.stringify(result) }] }),
    })
    const global = new SessionRuntimeGlobal(paths, tools, renders)
    const adapter: ModelAdapter = {
      contextWindow: 128_000, maxOutputTokens: 4_096,
      async *stream(request, signal) {
        const history = request.context.history
        if (history === undefined) {
          if (request.toolChoice === "none" && String(requestMessages(request)[0]?.content).includes("team_context")) {
            const material = JSON.parse(String(requestMessages(request)[1].content))
            assert.equal(material.turnContext[0].role, "team_context")
            assert.ok(material.turnContext.every(({ role }: { role: string }) => role !== "user"))
            const riskLevel = JSON.stringify(material).includes("first assignment") ? "medium" : "low"
            approvalRisks.push(riskLevel)
            yield { type: "block_start", index: 0, blockType: "text" }
            yield { type: "block_end", index: 0, block: { type: "text", text: JSON.stringify({ riskLevel, approved: true }) } }
          }
          yield { type: "stream_end", completion: "finished" }
          return
        }
        const user = history.events.filter((event) => event.type === "user/message").at(-1)
        assert.ok(user)
        const text = user.content.map((block) => block.text).join("\n")
        const results = history.events.filter((event) => event.type === "tool/result").filter((event) => event.seq > user.seq)
        const role = history.system.includes("You are the Team Router") ? "router"
          : history.system.includes("You are a Team Session") ? "member" : "ordinary"
        const names = request.tools.map(({ name }) => name)
        if (role === "router") {
          assert.ok(names.includes("communication"))
          assert.ok(!names.some((name) => /^(blackboard|shell|terminal_|mcp_|tool_search)/.test(name)))
        } else if (role === "member" && !results.some(({ content }) => content.some((block) => /"status":"(waiting|finished)"/.test(block.text)))) {
          assert.ok(names.includes("blackboard"))
          assert.ok(names.includes("communication"))
          assert.ok(!names.some((name) => name.startsWith("memory_")))
        } else if (role === "ordinary") {
          assert.ok(!names.includes("communication") && !names.includes("blackboard"))
        } else {
          assert.deepEqual(names, [])
        }
        if (results.length === 0) modelInputs.push(text)
        if (text === "hold until stopped") {
          if (!signal.aborted) await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }))
          throw createAbortError()
        }
        if (text === "fail after queue") {
          await Promise.race([failureGate,
            new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true })),
          ])
          if (signal.aborted) throw createAbortError()
          throw new Error("expected offline model failure")
        }
        let call: { name: string; arguments: object } | undefined
        if (text === "start a team") {
          if (results.length === 0) call = { name: "communication", arguments: { event: "create_session", session_info: "first assignment" } }
          else {
            const output = JSON.parse(results[0].content[0].text) as { session_id: string }
            assert.ok(output.session_id)
            memberId = output.session_id
          }
        } else if (text.includes("请求授权") && results.length === 0) {
          call = { name: "communication", arguments: { event: "send_message", session_id: memberId, message: "approved assignment" } }
        } else if (text.includes("报告完成") && results.length === 0) {
          call = { name: "communication", arguments: { event: "close_session", session_id: memberId } }
        } else if (text === "first assignment") {
          if (!results.length) call = { name: "write", arguments: {} }
          else if (results.length === 1) {
            assert.match(results[0].content[0].text, /denied/)
            call = { name: "blackboard", arguments: { mode: "publish", name: "progress", description: "summary", body: "details", mentions: [] } }
          } else if (results.length === 2) {
            assert.match(results[1].content[0].text, /#1/)
            call = { name: "communication", arguments: { event: "request_authorization", message: "continue?" } }
          }
        } else if (text === "approved assignment") {
          if (results.length === 0) call = { name: "write", arguments: {} }
          else if (results.length === 1) {
            assert.match(results[0].content[0].text, /approved/)
            call = { name: "communication", arguments: { event: "report_completion", message: "done" } }
          }
        } else if (text === "role boundary") {
          if (!results.length) call = { name: "blackboard", arguments: { mode: "unread" } }
          else if (results.length === 1) call = { name: "communication", arguments: { event: "report_completion", message: "invalid" } }
          else assert.ok(results.every((result) => result.isError))
        }
        if (call) {
          yield { type: "block_start", index: 0, blockType: "tool_call" }
          yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: "call-" + ++callNumber, ...call } }
          yield { type: "stream_end", completion: "tool_calls" }
        } else yield { type: "stream_end", completion: "finished" }
      },
    }
    global.createTurnModelAdapter = async () => adapter

    /** 通过已登记的主进程入口调用 IPC。 */
    async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const handler = handlers.get(channel)
      assert.ok(handler, channel)
      return await handler({}, ...args) as T
    }
    await startElectronApp({
      app: { whenReady: async () => {}, on: (event, listener) => { listeners.set(event, listener) }, quit: () => { quit = true } },
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } },
      windows: { createMainWindow: () => {}, hasOpenWindows: () => true },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      configPaths: paths, teamWakeup: startupConfig.teamWakeup, sessionRuntime: { systemPrompt: "Offline", global },
      onSessionCompletionFailure: (failure) => { failures.push(failure) },
      sessionEventForwarding: { sendSessionUpdateToRenderer: (update, recipients) => {
        updates.push(update)
        if (update.sessionId === memberId && recipients) deliveries.push([...recipients])
      } },
    })

    const ended = (id: string, turn: number) => updates.some((update) => update.sessionId === id &&
      update.kind === "event" && update.event.type === "turn/end" && update.event.turn === turn)
    const idle = (id: string) => updates.filter((update) => update.kind === "state")
      .filter((update) => update.sessionId === id).at(-1)?.control.phase === "idle"
    await until(() => ended(interruptedId, 2) && idle(interruptedId))
    assert.ok(!modelInputs.includes("must not rerun"))
    assert.equal(modelInputs.filter((text) => text === "after restart").length, 1)
    assert.ok((await interrupted.readEvents()).some((event) => JSON.stringify(event).includes(recoveredId)))

    const team = await invoke<{ sessionId: string; workspaceId: string; turn: number }>(
      START_TEAM_SESSION_CHANNEL, "default", { ...message("start a team"), model: MODEL, sandboxMode: "sandbox-read-only" },
    )
    assert.equal(team.turn, 1)
    assert.equal(store.identity("default", team.sessionId)?.workspaceId, team.workspaceId)
    const identity = await until(() => memberId ? store.identity("default", memberId) : undefined)
    await until(() => store.status(identity) === "closed" && ended(team.sessionId, 3))
    assert.deepEqual(approvalRisks, ["medium", "low"])
    assert.ok(updates.some((update) => update.sessionId === team.sessionId && update.kind === "event" &&
      update.event.seq === 1 && update.sessionKind === "router"))
    assert.ok(!updates.some((update) => update.sessionId === memberId), "未订阅成员不发送更新")
    assert.ok(readDefaultWorkspace(paths.workspaceDatabasePath).sessions.some(({ id }) => id === team.sessionId))
    assert.ok(!readDefaultWorkspace(paths.workspaceDatabasePath).sessions.some(({ id }) => id === memberId))
    assert.deepEqual(withSessionDatabase(paths.metaDatabasePath, (db) =>
      db.prepare("SELECT kind FROM session_meta WHERE session_id = ?").get(team.sessionId)?.kind), "router")
    const memberData = await invoke<SessionData>(SESSION_IPC_CHANNELS.getSessionData, "default", memberId)
    assert.equal(memberData.kind, "member")
    assert.equal(memberData.events.filter(({ type }) => type === "turn/end").length, 2)
    assert.ok(!memberData.events.some(({ type }) => type.startsWith("approval/")))
    assert.equal((await invoke<SessionData>(SESSION_IPC_CHANNELS.getSessionData, "default", team.sessionId)).kind, "router")
    assert.equal(memberData.events.filter(({ type }) => type === "user/message").length, 2)
    await assert.rejects(invoke(SESSION_IPC_CHANNELS.continueSession, "default", memberId, message("invalid")), /Router/)
    assert.deepEqual(await invoke(TEAM_SESSION_CHANNELS.list, "default", team.sessionId), [memberId])
    await assert.rejects(invoke(TEAM_SESSION_CHANNELS.list, "default", memberId), /Router/)
    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false })
    const otherSender = Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false })
    const subscribe = handlers.get(TEAM_SESSION_CHANNELS.subscribe)!
    const unsubscribe = handlers.get(TEAM_SESSION_CHANNELS.unsubscribe)!
    assert.throws(() => subscribe({ sender }, "default", team.sessionId, interruptedId), /不属于/)
    subscribe({ sender }, "default", team.sessionId, memberId)
    subscribe({ sender: otherSender }, "default", team.sessionId, memberId)
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
    const publishMemberState = () => invoke(SESSION_IPC_CHANNELS.updateSessionSettings, "default", memberId, { sandboxMode: "sandbox-read-only" })
    await publishMemberState()
    assert.deepEqual(deliveries.at(-1), [1, 2])
    unsubscribe({ sender }, "default", team.sessionId, memberId)
    await publishMemberState()
    assert.deepEqual(deliveries.at(-1), [2])
    otherSender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    const deliveredBeforeReload = deliveries.length
    await publishMemberState()
    assert.equal(deliveries.length, deliveredBeforeReload, "主文档导航清空订阅")
    await until(() => idle(team.sessionId))
    await invoke(SESSION_IPC_CHANNELS.continueSession, "default", team.sessionId, message("role boundary"))
    await until(() => ended(team.sessionId, 4) && idle(team.sessionId))

    const regular = await invoke<{ sessionId: string }>(
      SESSION_IPC_CHANNELS.startNewSession, "default", { ...message("hold until stopped"), model: MODEL },
    )
    await until(() => modelInputs.includes("hold until stopped"))
    const old = await invoke<{ messageId: string }>(SESSION_IPC_CHANNELS.enqueueSessionMessage, "default", regular.sessionId, message("queued before stop"))
    await invoke(SESSION_IPC_CHANNELS.stopSession, "default", regular.sessionId)
    await until(() => ended(regular.sessionId, 1) && idle(regular.sessionId))
    const queue = new SessionMessageQueue(databasePath, "default", regular.sessionId)
    assert.deepEqual(queue.read(true), [])
    assert.equal(queue.read()[0].messageId, old.messageId)
    await invoke(SESSION_IPC_CHANNELS.continueSession, "default", regular.sessionId, message("after explicit resume"))
    await until(() => ended(regular.sessionId, 3))
    assert.deepEqual(modelInputs.slice(-2), ["queued before stop", "after explicit resume"])
    assert.deepEqual(queue.read(), [])
    assert.equal(failures.length, 0, failures.map(({ error }) => String(error)).join("\n"))

    const failed = await invoke<{ sessionId: string }>(
      SESSION_IPC_CHANNELS.startNewSession, "default", { ...message("fail after queue"), model: MODEL },
    )
    await until(() => modelInputs.includes("fail after queue"))
    const preserved = await invoke<{ messageId: string }>(
      SESSION_IPC_CHANNELS.enqueueSessionMessage, "default", failed.sessionId, message("queued before failure"),
    )
    releaseFailure()
    await until(() => ended(failed.sessionId, 1) && idle(failed.sessionId))
    assert.equal(failures.length, 1)
    assert.match(String(failures[0].error), /expected offline model failure/)
    const failedQueue = new SessionMessageQueue(databasePath, "default", failed.sessionId)
    assert.deepEqual(failedQueue.read(true), [])
    assert.equal(failedQueue.read()[0].messageId, preserved.messageId)

    const config = await invoke<Record<string, number>>(TEAM_WAKEUP_CHANNELS.read)
    assert.equal(config.pollingInterval, 60)
    await assert.rejects(invoke(TEAM_WAKEUP_CHANNELS.update, { ...config, pollingInterval: 29 }), /配置/)
    await invoke(TEAM_WAKEUP_CHANNELS.update, { ...config, pollingInterval: 30 })
    assert.equal((await readConfigFile(paths.configPath)).teamWakeup.pollingInterval, 30)
  } finally {
    const shutdown = listeners.get("before-quit")
    if (shutdown && !quit) {
      shutdown({ preventDefault: () => {} })
      await until(() => quit)
    }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
