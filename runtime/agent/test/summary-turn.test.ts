/**
 * 使用脚本模型响应和真实临时 SQLite、派生文件验证上下文压缩。
 *
 * 覆盖 Usage 同步、连续压缩、基线更新、队列与继续入口、压缩失败和取消，
 * 以及 Summary 配对、覆盖范围与中断后的恢复边界。
 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelAdapter, ModelRef, ModelStreamEvent, UnifiedModelRequest, UnifiedToolDefinition } from "../../model/src/types.ts"
import type { SessionEvent } from "../../session/src/events.ts"
import type { CurrentSessionBaseline, FileSessionState, SessionContextState, SessionMeta } from "../../session/src/session-state.ts"
import { initializeSessionMetaDatabase, readSessionMeta } from "../../session/src/meta-store.ts"
import { SessionRuntime, SessionLogCorruptedError } from "../src/session-runtime.ts"
import type { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import { COMPACT_PROMPT } from "../../context/src/compact-prompt.ts"

const MODEL: ModelRef = { providerId: "offline", modelId: "offline", name: "Offline", protocol: "responses", reasoningLevel: "medium" }
const MESSAGE = [{ type: "text" as const, text: "initial user" }]
const HIGH = 102400
const MCP: UnifiedToolDefinition = { name: "mcp_remote_read", description: "remote", inputSchema: { type: "object" } }
const LOADED = [{ name: MCP.name, serverId: "remote", originalToolName: "read", estimatedTokens: 37, lastCalledAt: 123 }]

/**
 * 构造完整文本或工具调用响应，并用普通输入与缓存桶组合指定的完整输入量。
 *
 * @param text 文本响应内容；工具场景中同时作为调用 ID 和路径。
 * @param tokens 普通输入与缓存读取、写入相加后的完整输入量；有效 Usage 场景应至少为 3。
 * @param tool 是否改为产生完整工具调用，而非普通文本块。
 * @returns 合法完整流。
 */
function response(text: string, tokens = 10, tool = false): ModelStreamEvent[] {
  return [
    { type: "block_start", index: 0, blockType: tool ? "tool_call" : "text" },
    { type: "block_end", index: 0, block: tool ? { type: "tool_call", toolCallId: text, name: "read", arguments: { path: text } } : { type: "text", text } },
    { type: "stream_end", completion: tool ? "tool_calls" : "finished", usage: { inputTokens: tokens - 3, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 4 } },
  ]
}

/**
 * 根据来源版本构造可提交的 AGENTS.md、Skill 及 MCP 测试基线。
 *
 * @param root 隔离目录。
 * @param version 决定 Skill 名称、来源组合和内容的测试版本。
 * @returns 可同步、提交的 AGENTS.md 与 Skill 基线。
 */
function baseline(root: string, version: string): CurrentSessionBaseline {
  const name = version === "v2" ? "beta" : "alpha"
  const entries: CurrentSessionBaseline["skills"]["entries"] = [{ name, path: join(root, "skills", name), scope: "global", enabled: true, estimatedTokens: 8 }]
  const descriptions: Record<string, string> = { [name]: `description-${version}` }
  if (version === "v3") { entries.push({ name: "gamma", path: join(root, "skills", "gamma"), scope: "project", enabled: true, estimatedTokens: 8 }); descriptions.gamma = "gamma" }
  return {
    agentsmd: { path: join(root, "AGENTS.md"), hash: version, content: `agents-${version}` },
    skills: { content: `skills-${version}`, entries, descriptions },
    mcp: [MCP], additionalMeta: { loadedMcpTools: LOADED },
  }
}

/**
 * 创建使用真实 SQLite 与派生文件的离线 Runtime。
 * @param root 测试根目录。
 * @param name 隔离的 Session 名。
 * @param respond 每次模型请求的脚本。
 * @param contextWindow 当前模型窗口；小窗口用于首步触发测试。
 * @returns Runtime、故障注入入口、快照读取器和当前来源控制器。
 * @throws Error 临时数据库初始化或 Runtime 构造失败时抛出，调用方负责清理测试目录。
 */
function harness(root: string, name: string, respond: (request: UnifiedModelRequest, signal: AbortSignal) => AsyncIterable<ModelStreamEvent>, contextWindow = 128000) {
  const directory = join(root, name), databasePath = join(root, `${name}-events.sqlite`), metaDatabasePath = join(root, `${name}-meta.sqlite`)
  initializeSessionMetaDatabase(metaDatabasePath)
  let current = baseline(root, "v1"), factoryCalls = 0, executions = 0
  const requests: UnifiedModelRequest[] = []
  const global = {
    resolveProjectContext: () => ({ workspaceInfo: "workspace", resolveCurrentBaseline: async () => structuredClone(current) }),
    createTurnModelAdapter: async (model: ModelRef): Promise<ModelAdapter> => {
      factoryCalls++
      assert.deepEqual(model, MODEL)
      return { contextWindow, maxOutputTokens: 4096, async *stream(request, signal) {
        assert.deepEqual(request.model, MODEL)
        requests.push(structuredClone(request))
        yield* respond(request, signal)
      } }
    },
    listToolDefinitions: (mcp: UnifiedToolDefinition[] = []) => [{ name: "read", inputSchema: { type: "object" } }, ...mcp],
    mcpManager: { getDefinitions: () => structuredClone([MCP]) },
    executeTool: async () => { executions++; return { status: "success", content: [{ type: "text", text: "tool result" }] } },
    estimateSkillTokens: (value: string) => value.length,
    interruptTerminals: () => [],
  } as unknown as SessionRuntimeGlobal
  /**
   * 为同一持久化 Session 创建新的活动实例，模型脚本与全局能力由当前场景共用。
   * @returns 绑定测试 Session 目录和数据库的新 Runtime。
   * @throws Error Runtime 构造失败时抛出，调用方负责释放场景资源。
   */
  const create = () => new SessionRuntime({ sessionId: name, sessionDirectory: directory, projectGroupId: "default", databasePath, metaDatabasePath, systemPrompt: "original system", global })
  const runtime = create()
  return {
    runtime, create, requests, directory,
    /**
     * 切换夹具当前基线，下次来源解析时使用新版本。
     * @param version 下一次同步来源的版本。
     */
    setBaseline(version: string) { current = baseline(root, version) },
    /**
     * 读取当前 Session 的持久化元数据，不使用 Runtime 内存快照。
     * @returns 数据库中的当前 Session Meta。
     * @throws Error 元数据读取失败时抛出，由当前场景报告。
     */
    meta: () => readSessionMeta(metaDatabasePath, "default", name) as SessionMeta,
    /**
     * 读取并解析磁盘中的派生上下文状态。
     * @returns 已提交到 contextstate 文件的状态。
     * @throws Error 文件读取或 JSON 解析失败时拒绝，由当前场景报告。
     */
    context: async () => JSON.parse(await readFile(join(directory, "contextstate.json"), "utf8")) as SessionContextState,
    /**
     * 取得实例内部的真实状态访问器，供测试注入读写故障。
     * @param target 要注入状态故障的实例，省略时使用夹具初始实例。
     * @returns 该实例持有的 FileSessionState。
     */
    state: (target = runtime) => (target as unknown as { sessionState: FileSessionState }).sessionState,
    /**
     * 读取当前夹具累计的模型工厂与工具调用次数。
     * @returns 两种调用次数的独立对象快照。
     */
    counts: () => ({ factoryCalls, executions }),
  }
}

/**
 * 验证每个 Step 结束时 Meta Usage 已同步，重复同步不会重复累计。
 * @param root 隔离目录。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testImmediateUsage(root: string): Promise<void> {
  let normal = 0
  const h = harness(root, "immediate-usage", async function* (request) {
    if (request.toolChoice === "none") {
      assert.equal(h.meta().usage.inputTokens, HIGH, "下一步压缩前 Meta 已包含上一 Step 的完整输入")
      yield* response("summary usage must stay separate", 999999)
    } else yield* response(`usage-${++normal}`, normal === 1 ? HIGH : 10, normal === 1)
  })
  const append = h.runtime.appendEvent.bind(h.runtime)
  let ended = 0
  h.runtime.appendEvent = async (event) => {
    const written = await append(event)
    if (event.type === "step/end") {
      ended++
      assert.deepEqual(h.meta().usage, ended === 1
        ? { inputTokens: HIGH, cacheHitTokens: 2, cacheMissTokens: HIGH - 3, cacheHitRate: 2 / (HIGH - 1) }
        : { inputTokens: 10, cacheHitTokens: 4, cacheMissTokens: HIGH + 4, cacheHitRate: 4 / (HIGH + 8) })
    }
    return written
  }
  await (await h.runtime.startNewSession({ model: MODEL, content: MESSAGE })).completion
  assert.equal(ended, 2)
}

/**
 * 验证同 Turn 连续压缩、最新基线与 MCP 保留。
 * @param root 隔离目录。
 * @returns 同 Turn 连续压缩、最新基线与 MCP 保留验证完成。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testRepeatedCompression(root: string): Promise<void> {
  let normals = 0, summaries = 0
  const h = harness(root, "repeated", async function* (request) {
    if (request.toolChoice === "none") {
      summaries++
      assert.equal((await h.runtime.readEvents() as SessionEvent[]).at(-1)!.type, "summary/start")
      yield* response(`summary-${summaries}`, 999999)
    } else {
      normals++
      if (normals < 3) { h.setBaseline(`v${normals + 1}`); yield* response(`call-${normals}`, HIGH, true) }
      else yield* response("final")
    }
  })
  const turn = await h.runtime.startNewSession({ model: MODEL, content: MESSAGE })
  const result = await turn.completion
  assert.equal(result.steps, 3)
  const events = await h.runtime.readEvents() as SessionEvent[]
  const compressed = events.filter((event) => event.type === "summary/end")
  assert.equal(compressed.length, 2)
  const starts = events.filter((event) => event.type === "summary/start")
  assert.equal(starts.length, 2)
  assert.equal(new Set(starts.map((event) => event.summaryId)).size, 2)
  for (const [index, start] of starts.entries()) {
    assert.equal(start.summaryId, compressed[index].summaryId)
    assert.equal(start.fromEventSeq, compressed[index].fromEventSeq)
    assert.equal(start.throughEventSeq, compressed[index].throughEventSeq)
    assert.equal(events[events.indexOf(start) - 1].type, "step/end")
    assert.equal(start.throughEventSeq, events[events.indexOf(start) - 1].seq)
  }
  assert.equal(compressed[0].fromEventSeq, events.find((event) => event.type === "step/start")!.seq)
  assert.equal(compressed[1].fromEventSeq, compressed[0].fromEventSeq)
  assert.equal(compressed[0].baseline.agentsmd.content, "agents-v2")
  assert.equal(compressed[1].baseline.skills.content, "skills-v3")
  assert.deepEqual(compressed[0].baseline.skills.entries.map((entry) => [entry.name, entry.enabled]), [["beta", true], ["alpha", false]])
  assert.deepEqual(compressed[1].baseline.skills.entries.map((entry) => [entry.name, entry.enabled]), [["alpha", true], ["gamma", true], ["beta", false]])
  for (const event of compressed) {
    const position = events.indexOf(event)
    assert.equal(events[position + 1].type, "step/start")
    assert.equal(events.find((value) => value.seq === event.throughEventSeq)!.type, "step/end")
  }
  const compactRequests = h.requests.filter((request) => request.toolChoice === "none")
  assert.equal(compactRequests[0].context.messages[0].content, "original system\n\nworkspace\n\nagents-v2\n\nskills-v2")
  assert.ok(compactRequests[0].context.messages.some((message) => message.role === "tool"))
  assert.ok(compactRequests[1].context.messages.some((message) => message.content === "summary-1"))
  assert.deepEqual(h.requests[4].context.messages, [
    { role: "system", content: "original system\n\nworkspace\n\nagents-v3\n\nskills-v3" }, { role: "user", content: "summary-2" },
  ])
  for (let index = 0; index < h.requests.length; index++) {
    assert.deepEqual(h.requests[index].tools.map((tool) => tool.name), ["read", MCP.name])
    if (h.requests[index].toolChoice === "none") assert.deepEqual(h.requests[index].tools, h.requests[index + 1].tools)
  }
  assert.equal(events.filter((event) => event.type === "user/message").length, 1)
  assert.equal(events.filter((event) => event.type === "assistant/message").length, 3)
  assert.equal(events.some((event) => event.type === "user/message" && event.message.content.some((block) => block.text === COMPACT_PROMPT)), false)
  assert.deepEqual(h.meta().loadedMcpTools, LOADED)
  assert.deepEqual((await h.context()).mcp, [MCP])
  assert.equal((await h.context()).skills.id, compressed[1].eventId)
  assert.deepEqual(h.counts(), { factoryCalls: 1, executions: 2 })
  await h.runtime.repairSession()
  assert.equal(h.meta().usage.inputTokens, 10, "压缩 Usage 不得污染正常 Agent Usage")
}

/**
 * 验证首步覆盖用户消息、重新打开与截止点后增量恢复。
 * @param root 隔离目录。
 * @returns 首步覆盖用户消息、重新打开与截止点后增量恢复验证完成。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testNewTurnAndRecovery(root: string): Promise<void> {
  let normals = 0
  const h = harness(root, "reopen", async function* (request) {
    yield* response(request.toolChoice === "none" ? "new turn summary" : "answer", request.toolChoice === "none" ? 999999 : ++normals === 1 ? HIGH : 10)
  })
  await (await h.runtime.startNewSession({ model: MODEL, content: MESSAGE })).completion
  h.setBaseline("v2")
  const next = h.create()
  await (await next.continueSession({ content: [{ type: "text", text: "new user" }] })).completion
  const events = await next.readEvents() as SessionEvent[]
  const summary = events.find((event) => event.type === "summary/end")!
  assert.equal(events.find((event) => event.seq === summary.throughEventSeq)!.type, "user/message")
  assert.ok(h.requests[1].context.messages.some((message) => JSON.stringify(message).includes("new user")))
  assert.deepEqual(h.requests[2].context.messages.slice(1), [{ role: "user", content: "new turn summary" }])
  const before = JSON.stringify(events)
  await writeFile(join(h.directory, "contextstate.json"), "invalid state")
  await writeFile(join(h.directory, "agents_md.snapshot"), "stale")
  h.setBaseline("v3")
  const restored = h.create()
  await restored.repairSession()
  assert.equal((await h.context()).skills.content, "skills-v2")
  assert.equal(await readFile(join(h.directory, "agents_md.snapshot"), "utf8"), "agents-v2")
  assert.equal(JSON.stringify(await restored.readEvents()), before, "恢复不得改写原始历史")
  await restored.prepareExistingTurn()
  await restored.appendTurnStartAndUserMessage([
    { type: "turn/start", turn: 3, model: MODEL },
    { type: "user/message", turn: 3, message: { id: "tail", role: "user", content: [{ type: "text", text: "after cutoff" }] } },
  ])
  const content = await restored.buildContent(3)
  assert.equal(content.filter((message) => message.content === "new turn summary").length, 1)
  assert.ok(content.some((message) => JSON.stringify(message).includes("after cutoff")))
  assert.ok(content.some((message) => JSON.stringify(message).includes("agents-v3")))
  await restored.repairSession()
  assert.equal(await readFile(join(h.directory, "agents_md.snapshot"), "utf8"), "agents-v3")
  assert.ok(h.meta().skills.entries.some((entry) => entry.name === "gamma" && entry.enabled))
  assert.equal((await h.context()).skills.id, summary.eventId, "普通增量不改变固定基线版本")
  assert.notEqual(h.meta().skills.id, summary.eventId, "覆盖终点后的新 Skill 增量推进比较游标")
}

/**
 * 验证压缩期间排队的消息保留并在下一 Turn 正常处理。
 * @param root 隔离目录。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testQueueDuringCompression(root: string): Promise<void> {
  let summaries = 0
  const h = harness(root, "queue", async function* (request) {
    if (request.toolChoice === "none") {
      if (++summaries === 1) h.runtime.enqueueSessionMessage({ content: [{ type: "text", text: "queued during compression" }] })
      yield* response(`queued-summary-${summaries}`)
    } else yield* response("done")
  }, 10000)
  const turn = await h.runtime.startNewSession({ model: MODEL, content: MESSAGE })
  await h.runtime.processMessageQueue(turn).completion
  const events = (await h.runtime.readSnapshot()).events
  assert.equal(events.filter((event) => event.type === "turn/start").length, 2)
  const compressed = events.filter((event) => event.type === "summary/end")
  const users = events.filter((event) => event.type === "user/message")
  assert.equal(compressed[0].throughEventSeq, users[0].seq)
  assert.equal(compressed[1].throughEventSeq, users[1].seq)
  assert.ok(h.requests[2].context.messages.some((message) => JSON.stringify(message).includes("queued during compression")))
  assert.deepEqual(h.counts(), { factoryCalls: 2, executions: 0 })
}

/**
 * 验证压缩失败、取消与跨文件故障的提交边界。
 * @param root 隔离目录。
 * @returns 压缩失败、取消与跨文件故障的提交边界验证完成。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testFailures(root: string): Promise<void> {
  for (const mode of ["tool", "empty", "incomplete", "network", "cancel", "start", "persist", "derived", "spec"] as const) {
    const h = harness(root, mode, async function* (request) {
      assert.equal(request.toolChoice, "none", "非正阈值必须在首步触发")
      if (mode === "network") throw new Error("injected network failure")
      if (mode === "cancel") { h.runtime.stop(); return }
      if (mode === "tool") { yield* response("forbidden", 10, true); return }
      if (mode === "incomplete") { yield { type: "stream_end", completion: "incomplete" }; return }
      h.setBaseline("v2")
      yield* response(mode === "empty" ? " " : "committed summary")
    }, mode === "spec" ? NaN : 10000)
    const initialize = h.state().initializeSession
    h.state().initializeSession = async () => { await initialize(); h.setBaseline("v2") }
    const append = h.runtime.appendEvent.bind(h.runtime)
    if (mode === "start") h.runtime.appendEvent = async (event) => { if (event.type === "summary/start") throw new Error("injected start failure"); return append(event) }
    if (mode === "persist") h.runtime.appendEvent = async (event) => { if (event.type === "summary/end") throw new Error("injected persist failure"); return append(event) }
    const repair = h.state().repairDerivedState
    if (mode === "derived") h.state().repairDerivedState = async (events) => { if (events.some((event) => event.type === "summary/end")) throw new Error("injected derived failure"); return repair(events) }
    const turn = await h.runtime.startNewSession({ model: MODEL, content: MESSAGE })
    if (mode === "cancel") assert.equal((await turn.completion).stopped, true)
    else await assert.rejects(turn.completion)
    const events = await h.runtime.readEvents() as SessionEvent[]
    assert.equal(events.filter((event) => event.type === "summary/end").length, mode === "derived" ? 1 : 0)
    assert.equal(events.filter((event) => event.type === "summary/start").length, mode === "spec" || mode === "start" ? 0 : 1)
    assert.equal(events.some((event) => event.type === "step/start" || event.type === "step/end"), false)
    assert.equal(events.at(-1)!.type, "turn/end")
    assert.equal((await h.context()).agentsmd.content, "agents-v1")
    assert.equal(h.counts().executions, 0)
    if (mode === "derived") {
      await h.create().repairSession()
      assert.equal((await h.context()).agentsmd.content, "agents-v2")
      assert.equal((await h.context()).skills.id, events.find((event) => event.type === "summary/end")!.eventId)
    } else {
      const restored = h.create()
      await restored.repairSession()
      assert.equal((await h.context()).skills.content, "skills-v1", "未提交的 start 不应用准备中的新基线")
      await restored.prepareExistingTurn()
      await restored.appendTurnStartAndUserMessage([
        { type: "turn/start", turn: 2, model: MODEL },
        { type: "user/message", turn: 2, message: { id: "resume", role: "user", content: [{ type: "text", text: "resume" }] } },
      ])
      assert.ok((await restored.buildContent(2)).some((message) => message.role === "user" && JSON.stringify(message.content) === JSON.stringify(MESSAGE)), "未完成的压缩仍回放原始用户消息")
    }
  }
}

/**
 * 验证损坏覆盖端点和截断 Step 的日志在任何修复写入前被拒绝。
 * @param root 隔离目录。
 * @returns 损坏覆盖端点和截断 Step 的日志在任何修复写入前被拒绝。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testInvalidCoverage(root: string): Promise<void> {
  for (const [name, fromEventSeq, throughEventSeq] of [["missing", 2, 99], ["backward", 4, 2], ["partial", 3, 3]] as const) {
    const h = harness(root, name, async function* () { throw new Error("unexpected model") })
    await h.runtime.createSessionDirectory()
    await h.runtime.appendTurnStartAndUserMessage([
      { type: "turn/start", turn: 1, model: MODEL },
      { type: "user/message", turn: 1, message: { id: "user", role: "user", content: MESSAGE } },
    ])
    await h.runtime.initializeSession()
    await h.runtime.appendEvent({ type: "step/start", turn: 1, step: 1 })
    await h.runtime.appendEvent({ type: "step/end", turn: 1, step: 1, reason: "completed" })
    const value = baseline(root, "v1")
    await h.runtime.appendEvent({ type: "summary/start", summaryId: "invalid", turn: 1, fromEventSeq, throughEventSeq })
    await h.runtime.appendEvent({ type: "summary/end", summaryId: "invalid", turn: 1, summary: "invalid", fromEventSeq, throughEventSeq, baseline: { agentsmd: value.agentsmd, skills: value.skills } })
    const before = await h.runtime.readEvents()
    await assert.rejects(h.runtime.repairSession(), (error: unknown) => error instanceof SessionLogCorruptedError && /覆盖端点|截断/.test(error.message))
    assert.deepEqual(await h.runtime.readEvents(), before)
  }
}

/**
 * 验证缺失、重复及不匹配的 Summary 配对在修复前被拒绝。
 * @param root 隔离目录。
 * @returns 缺失、重复及不匹配的 Summary 配对在修复前被拒绝。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testInvalidPairing(root: string): Promise<void> {
  for (const mode of ["orphan", "duplicate-start", "duplicate-end", "mismatch"] as const) {
    const h = harness(root, `pair-${mode}`, async function* () { throw new Error("unexpected model") })
    await h.runtime.createSessionDirectory()
    await h.runtime.appendTurnStartAndUserMessage([
      { type: "turn/start", turn: 1, model: MODEL },
      { type: "user/message", turn: 1, message: { id: "user", role: "user", content: MESSAGE } },
    ])
    await h.runtime.initializeSession()
    const value = baseline(root, "v1")
    const start = { type: "summary/start" as const, summaryId: "pair", turn: 1, fromEventSeq: 2, throughEventSeq: 2 }
    const end = { ...start, type: "summary/end" as const, summary: "summary", baseline: { agentsmd: value.agentsmd, skills: value.skills } }
    if (mode !== "orphan") await h.runtime.appendEvent(start)
    if (mode === "duplicate-start") await h.runtime.appendEvent(start)
    else {
      await h.runtime.appendEvent(mode === "mismatch" ? { ...end, fromEventSeq: 1 } : end)
      if (mode === "duplicate-end") await h.runtime.appendEvent(end)
    }
    const before = await h.runtime.readEvents()
    await assert.rejects(h.runtime.repairSession(), (error: unknown) => error instanceof SessionLogCorruptedError && /start/.test(error.message))
    assert.deepEqual(await h.runtime.readEvents(), before)
  }
}

/**
 * 验证权威消息已提交但 Meta 同步失败时，从日志幂等恢复 Usage。
 * @param root 隔离目录。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testUsageFailureRecovery(root: string): Promise<void> {
  const h = harness(root, "usage-failure", async function* () { yield* response("answer", 20) })
  h.state().synchronizeUsage = async () => { throw new Error("injected usage failure") }
  await assert.rejects((await h.runtime.startNewSession({ model: MODEL, content: MESSAGE })).completion, /usage failure/)
  const events = await h.runtime.readEvents() as SessionEvent[]
  assert.equal(events.filter((event) => event.type === "assistant/message").length, 1)
  assert.equal(h.meta().usage.inputTokens, 0)
  const restored = h.create()
  await restored.repairSession()
  assert.equal(h.meta().usage.inputTokens, 20)
  const expected = structuredClone(h.meta().usage)
  await restored.repairSession()
  assert.deepEqual(h.meta().usage, expected)
}

/**
 * 验证后续未完成尝试保留最近完成 Summary 与未压缩的消息。
 * @param root 隔离目录。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testUnfinishedAttemptKeepsCommittedSummary(root: string): Promise<void> {
  let summaries = 0
  const h = harness(root, "unfinished-after-commit", async function* (request) {
    if (request.toolChoice === "none") {
      if (++summaries === 2) throw new Error("second compression failed")
      yield* response("last committed summary")
    } else yield* response("normal answer")
  }, 10000)
  await (await h.runtime.startNewSession({ model: MODEL, content: MESSAGE })).completion
  h.setBaseline("v2")
  const continued = h.create()
  await assert.rejects((await continued.continueSession({ content: [{ type: "text", text: "uncompressed second user" }] })).completion, /second compression failed/)
  const restored = h.create()
  await restored.repairSession()
  const events = await restored.readEvents() as SessionEvent[]
  assert.equal(events.filter((event) => event.type === "summary/start").length, 2)
  assert.equal(events.filter((event) => event.type === "summary/end").length, 1)
  assert.equal((await h.context()).skills.content, "skills-v1")
  await restored.prepareExistingTurn()
  await restored.appendTurnStartAndUserMessage([
    { type: "turn/start", turn: 3, model: MODEL },
    { type: "user/message", turn: 3, message: { id: "resume", role: "user", content: MESSAGE } },
  ])
  const content = await restored.buildContent(3)
  assert.equal(content.filter((message) => message.content === "last committed summary").length, 1)
  assert.ok(content.some((message) => JSON.stringify(message.content).includes("uncompressed second user")))
}

/**
 * 验证取消 Step 与未报告 Usage 的 Step 都保留正确的实时 Meta。
 * @param root 隔离目录。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testUsageAtOtherStepOutcomes(root: string): Promise<void> {
  const stopped = harness(root, "usage-stopped", async function* () {
    yield* response("complete text before cancellation", 30)
    stopped.runtime.stop()
  })
  assert.equal((await (await stopped.runtime.startNewSession({ model: MODEL, content: MESSAGE })).completion).stopped, true)
  assert.equal(stopped.meta().usage.inputTokens, 30)
  const last = (await stopped.runtime.readEvents() as SessionEvent[]).filter((event) => event.type === "step/end").at(-1)!
  assert.equal(last.reason, "stopped")
  let step = 0
  const missing = harness(root, "usage-unreported", async function* () {
    if (++step === 1) yield* response("read", 20, true)
    else {
      yield* response("no usage").slice(0, -1)
      yield { type: "stream_end", completion: "finished" }
    }
  })
  await (await missing.runtime.startNewSession({ model: MODEL, content: MESSAGE })).completion
  assert.equal(missing.meta().usage.inputTokens, 20)
  assert.equal(missing.meta().usage.cacheHitTokens, 2)
  assert.equal(missing.meta().usage.cacheMissTokens, 17)
}

/**
 * 依次执行真实持久化的 Usage、压缩、队列与恢复场景，完成后清理临时目录。
 *
 * @returns 所有真实持久化场景完成；临时目录在成功或失败后均清理。
 * @throws AssertionError 验证失败。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-summary-"))
  try {
    await testImmediateUsage(root)
    await testRepeatedCompression(root)
    await testNewTurnAndRecovery(root)
    await testFailures(root)
    await testInvalidCoverage(root)
    await testInvalidPairing(root)
    await testUsageFailureRecovery(root)
    await testUnfinishedAttemptKeepsCommittedSummary(root)
    await testUsageAtOtherStepOutcomes(root)
    await testQueueDuringCompression(root)
    console.log("summary-turn.test.ts: step ordering, repeated compression, baseline recovery, MCP and failures passed")
  } finally { await rm(root, { recursive: true, force: true }) }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
