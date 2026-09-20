import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFileSessionRepairPorts, repairSession } from "../../agent/src/session-runtime.ts"
import type { ModelRef } from "../../model/src/types.ts"
import { createFileSessionEventLog } from "../src/event-log.ts"
import type { SessionEvent, SessionEventInput } from "../src/events.ts"
import { createFileSessionState } from "../src/session-state.ts"
import type { CurrentSessionBaseline, SessionContextState, SessionMeta } from "../src/session-state.ts"

const MODEL: ModelRef = { providerId: "provider-1", protocol: "responses", modelId: "model-1" }
const OTHER_MODEL: ModelRef = { providerId: "provider-1", protocol: "responses", modelId: "model-2" }
const CREATED_AT = "2026-09-19T00:00:00.000Z"

/** 创建一条已分配身份的测试事件。 */
function persistedEvent(sessionId: string, seq: number, input: SessionEventInput): SessionEvent {
  return {
    ...input,
    eventId: `event-${seq}`,
    sessionId,
    seq,
    createdAt: CREATED_AT,
  } as SessionEvent
}

/** 创建合法的首个 Turn 批次。 */
function initialEvents(sessionId: string): SessionEvent[] {
  return [
    persistedEvent(sessionId, 1, { type: "turn/start", turn: 1, model: MODEL }),
    persistedEvent(sessionId, 2, {
      type: "user/message",
      turn: 1,
      message: { id: "message-1", role: "user", content: [{ type: "text", text: "你好" }] },
    }),
  ]
}

/** 用一次写入建立 events.jsonl。 */
async function writeEvents(sessionDirectory: string, events: readonly SessionEvent[]): Promise<void> {
  await writeFile(
    join(sessionDirectory, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  )
}

/** 读取测试中的 JSON 文件。 */
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

/** 返回包含当前 AGENTS.md / Skill / MCP 状态的初始化基线。 */
function baseline(suffix: string): CurrentSessionBaseline {
  return {
    agentsmd: { hash: `hash-${suffix}`, content: `agents-${suffix}` },
    skills: {
      content: `skills-${suffix}`,
      entries: [{ name: "alpha", scope: "global", enabled: true, estimatedTokens: 5 }],
    },
    mcp: [{ name: "mcp_read", description: "read", inputSchema: { type: "object" } }],
    additionalMeta: {
      loadedMcpTools: [{
        name: "mcp_read",
        serverId: "server-1",
        originalToolName: "read",
        estimatedTokens: 8,
        lastCalledAt: 0,
      }],
    },
  }
}

async function testInitialization(root: string): Promise<void> {
  const sessionId = "session-initialize"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  await writeEvents(sessionDirectory, initialEvents(sessionId))
  const log = createFileSessionEventLog({ sessionId, sessionDirectory })
  let currentBaseline = baseline("initial")
  let baselineReads = 0
  const state = createFileSessionState({
    sessionId,
    sessionDirectory,
    readEvents: log.readEvents,
    resolveCurrentBaseline: async () => {
      baselineReads += 1
      return currentBaseline
    },
    estimateSkillTokens: (description) => description.length,
  })

  await state.initializeSession()
  const metaPath = join(sessionDirectory, "meta.json")
  const contextPath = join(sessionDirectory, "contextstate.json")
  const snapshotPath = join(sessionDirectory, "agents_md.snapshot")
  const meta = await readJson<SessionMeta>(metaPath)
  assert.deepEqual(meta.currentModel, MODEL)
  assert.deepEqual(meta.usage, { inputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, cacheHitRate: 0 })
  assert.deepEqual(meta.skills, { id: null, entries: currentBaseline.skills.entries })
  assert.deepEqual(meta.loadedMcpTools, currentBaseline.additionalMeta?.loadedMcpTools)
  assert.deepEqual(await readJson<SessionContextState>(contextPath), {
    agentsmd: currentBaseline.agentsmd,
    skills: { id: "initial", content: currentBaseline.skills.content },
    mcp: currentBaseline.mcp,
  })
  assert.equal(await readFile(snapshotPath, "utf8"), currentBaseline.agentsmd.content)
  assert.equal((await lstat(join(sessionDirectory, "tool_output"))).isDirectory(), true)

  currentBaseline = baseline("changed-after-initialization")
  await state.initializeSession()
  assert.equal(baselineReads, 1, "有效的既有派生文件不得按当前状态覆盖")
  assert.equal(await readFile(snapshotPath, "utf8"), "agents-initial")
}

async function testDerivedStateRepair(root: string): Promise<void> {
  const sessionId = "session-derived-repair"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  const events = initialEvents(sessionId)
  await writeEvents(sessionDirectory, events)
  const log = createFileSessionEventLog({ sessionId, sessionDirectory })
  const state = createFileSessionState({
    sessionId,
    sessionDirectory,
    readEvents: log.readEvents,
    resolveCurrentBaseline: async () => baseline("initial"),
    estimateSkillTokens: (description) => description.length,
  })
  await state.initializeSession()

  const metaPath = join(sessionDirectory, "meta.json")
  const meta = await readJson<SessionMeta>(metaPath)
  meta.currentModel = OTHER_MODEL
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8")

  events.push(
    persistedEvent(sessionId, 3, {
      type: "context_update",
      turn: 2,
      source: {
        type: "agents_md",
        path: "G:/code/NiCode/AGENTS.md",
        hash: "hash-event",
        fullContent: "agents-event",
      },
      content: "<agents_md_update>event</agents_md_update>",
    }),
    persistedEvent(sessionId, 4, {
      type: "context_update",
      turn: 2,
      source: {
        type: "skill",
        changes: [
          { type: "new", name: "beta", scope: "project", description: "beta skill" },
          { type: "disabled", name: "alpha" },
        ],
      },
      content: "<skills_update>event</skills_update>",
    }),
    persistedEvent(sessionId, 5, {
      type: "assistant/message",
      turn: 2,
      step: 1,
      message: { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "a" }] },
      model: MODEL,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 2 },
    }),
    persistedEvent(sessionId, 6, {
      type: "assistant/message",
      turn: 2,
      step: 2,
      message: { id: "assistant-2", role: "assistant", content: [{ type: "text", text: "b" }] },
      model: MODEL,
      usage: { inputTokens: 20, outputTokens: 4 },
    }),
  )

  assert.deepEqual(await state.repairDerivedState(events), { currentModel: OTHER_MODEL })
  const repairedMeta = await readJson<SessionMeta>(metaPath)
  assert.deepEqual(repairedMeta.usage, {
    inputTokens: 20,
    cacheHitTokens: 5,
    cacheMissTokens: 30,
    cacheHitRate: 1 / 7,
  })
  assert.deepEqual(repairedMeta.skills, {
    id: "event-4",
    entries: [
      { name: "alpha", scope: "global", enabled: false, estimatedTokens: 5 },
      { name: "beta", scope: "project", enabled: true, estimatedTokens: 10 },
    ],
  })
  const context = await readJson<SessionContextState>(join(sessionDirectory, "contextstate.json"))
  assert.deepEqual(context.agentsmd, { hash: "hash-event", content: "agents-event" })
  assert.equal(await readFile(join(sessionDirectory, "agents_md.snapshot"), "utf8"), "agents-event")

  const before = await Promise.all([
    readFile(metaPath, "utf8"),
    readFile(join(sessionDirectory, "contextstate.json"), "utf8"),
    readFile(join(sessionDirectory, "agents_md.snapshot"), "utf8"),
  ])
  await state.repairDerivedState(events)
  const after = await Promise.all([
    readFile(metaPath, "utf8"),
    readFile(join(sessionDirectory, "contextstate.json"), "utf8"),
    readFile(join(sessionDirectory, "agents_md.snapshot"), "utf8"),
  ])
  assert.deepEqual(after, before, "重复派生状态恢复必须幂等")
}

async function testRecoveryUsesCurrentBaseline(root: string): Promise<void> {
  const sessionId = "session-current-baseline"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  const events = initialEvents(sessionId)
  await writeEvents(sessionDirectory, events)
  const log = createFileSessionEventLog({ sessionId, sessionDirectory })
  let current = baseline("before-damage")
  const state = createFileSessionState({
    sessionId,
    sessionDirectory,
    readEvents: log.readEvents,
    resolveCurrentBaseline: async () => current,
    estimateSkillTokens: (description) => description.length,
  })

  await state.initializeSession()
  await writeFile(join(sessionDirectory, "meta.json"), "not-json\n", "utf8")
  await writeFile(join(sessionDirectory, "contextstate.json"), "{}\n", "utf8")
  await rm(join(sessionDirectory, "agents_md.snapshot"))
  current = baseline("recovery-current")
  await state.initializeSession()
  await state.repairDerivedState(events)
  const meta = await readJson<SessionMeta>(join(sessionDirectory, "meta.json"))
  const context = await readJson<SessionContextState>(join(sessionDirectory, "contextstate.json"))
  assert.equal(meta.skills.id, null)
  assert.deepEqual(meta.skills.entries, current.skills.entries)
  assert.deepEqual(context.agentsmd, current.agentsmd)
  assert.equal(await readFile(join(sessionDirectory, "agents_md.snapshot"), "utf8"), current.agentsmd.content)
}

async function testInitializationFailures(root: string): Promise<void> {
  const missingSessionId = "missing"
  const missingSessionDirectory = join(root, missingSessionId)
  const missingLog = createFileSessionEventLog({
    sessionId: missingSessionId,
    sessionDirectory: missingSessionDirectory,
  })
  const missingState = createFileSessionState({
    sessionId: missingSessionId,
    sessionDirectory: missingSessionDirectory,
    readEvents: missingLog.readEvents,
    resolveCurrentBaseline: async () => baseline("failure"),
    estimateSkillTokens: (description) => description.length,
  })

  await assert.rejects(missingState.initializeSession(), /Session 目录不存在或不是目录/)
  assert.throws(
    () => createFileSessionState({
      sessionId: "nested/session",
      sessionDirectory: root,
      readEvents: async () => [],
      resolveCurrentBaseline: async () => baseline("invalid-id"),
      estimateSkillTokens: (description) => description.length,
    }),
    /Session ID 必须/,
  )

  const sessionId = "session-tool-output-file"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  await writeEvents(sessionDirectory, initialEvents(sessionId))
  await writeFile(join(sessionDirectory, "tool_output"), "not-a-directory", "utf8")
  const log = createFileSessionEventLog({ sessionId, sessionDirectory })
  const state = createFileSessionState({
    sessionId,
    sessionDirectory,
    readEvents: log.readEvents,
    resolveCurrentBaseline: async () => baseline("failure"),
    estimateSkillTokens: (description) => description.length,
  })
  await assert.rejects(state.initializeSession(), /Session Tool Output 目录不是目录/)
}

async function testCompleteRepairPorts(root: string): Promise<void> {
  const sessionId = "session-complete-ports"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  const events = initialEvents(sessionId)
  events.push(
    persistedEvent(sessionId, 3, { type: "step/start", turn: 1, step: 1 }),
    persistedEvent(sessionId, 4, {
      type: "assistant/block_start",
      turn: 1,
      step: 1,
      blockId: "1:1:0",
      index: 0,
      blockType: "text",
    }),
    persistedEvent(sessionId, 5, {
      type: "assistant/block_delta",
      turn: 1,
      step: 1,
      blockId: "1:1:0",
      delta: { type: "text", text: "interrupted" },
    }),
  )
  await writeEvents(sessionDirectory, events)
  let nextId = 6
  const ports = createFileSessionRepairPorts({
    sessionId,
    sessionDirectory,
    resolveCurrentBaseline: async () => baseline("complete"),
    estimateSkillTokens: (description) => description.length,
    now: () => new Date(CREATED_AT),
    createEventId: () => `event-${nextId++}`,
  })

  assert.deepEqual(await repairSession(sessionId, ports), { lastTurn: 1, currentModel: MODEL })
  const repaired = await ports.readEvents(sessionId) as SessionEvent[]
  assert.deepEqual(repaired.slice(5).map((event) => event.type), [
    "assistant/block_end",
    "assistant/message",
    "step/end",
    "turn/end",
  ])
  const count = repaired.length
  await repairSession(sessionId, ports)
  assert.equal((await ports.readEvents(sessionId)).length, count)
  await assert.rejects(
    ports.readEvents("another-session"),
    /已绑定 session-complete-ports，不能访问其它 Session：another-session/,
  )
}

async function main(): Promise<void> {
  assert.throws(
    () => createFileSessionState({
      sessionId: "session-relative",
      sessionDirectory: "relative/path",
      readEvents: async () => [],
      resolveCurrentBaseline: async () => baseline("relative"),
      estimateSkillTokens: (description) => description.length,
    }),
    /Session 目录必须是绝对路径/,
  )

  const root = await mkdtemp(join(tmpdir(), "nicode-session-state-"))
  try {
    await testInitialization(root)
    await testDerivedStateRepair(root)
    await testRecoveryUsesCurrentBaseline(root)
    await testInitializationFailures(root)
    await testCompleteRepairPorts(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  console.log("session-state.test.ts: Session 派生状态与完整恢复端口断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
