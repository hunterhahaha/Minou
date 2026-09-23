import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createFileSessionRepairPorts, repairSession } from "../../agent/src/session-runtime.ts"
import type { ModelRef } from "../../model/src/types.ts"
import { createFileSessionEventLog as createSqliteSessionEventLog } from "../src/event-log.ts"
import type { FileSessionEventLogOptions } from "../src/event-log.ts"
import type { SessionEvent, SessionEventInput } from "../src/events.ts"
import {
  DEFAULT_SESSION_SANDBOX_MODE,
  SESSION_META_VERSION,
  createFileSessionState as createSqliteSessionState,
  writeCurrentModel,
} from "../src/session-state.ts"
import type { CurrentSessionBaseline, SessionContextState, SessionMeta } from "../src/session-state.ts"
import type { FileSessionStateOptions } from "../src/session-state.ts"

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

/** 为现有测试建立共享 SQLite 日志。 */
async function writeEvents(sessionDirectory: string, events: readonly SessionEvent[]): Promise<void> {
  const db = new DatabaseSync(join(dirname(sessionDirectory), "events.sqlite"))
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_events (
      project_group_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      event_id TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY (project_group_id, session_id, seq),
      UNIQUE (project_group_id, session_id, event_id)
    ) STRICT`)
    const insert = db.prepare(`INSERT INTO session_events
      (project_group_id, session_id, seq, event_id, type, created_at, event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const event of events) {
      insert.run("0", event.sessionId, event.seq, event.eventId, event.type, event.createdAt, JSON.stringify(event))
    }
  } finally {
    db.close()
  }
}

/** 保持原测试调用形状，并指定 SQLite 的分组与路径。 */
function createFileSessionEventLog(options: Omit<FileSessionEventLogOptions, "projectGroupId" | "databasePath">) {
  return createSqliteSessionEventLog({
    ...options, projectGroupId: "0", databasePath: join(dirname(options.sessionDirectory), "events.sqlite"),
  })
}

/** 为派生状态测试提供同一个数据库路径。 */
function createFileSessionState(options: Omit<FileSessionStateOptions, "databasePath">) {
  return createSqliteSessionState({
    ...options, databasePath: join(dirname(options.sessionDirectory), "events.sqlite"),
  })
}

/** 读取测试中的 JSON 文件。 */
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

/** 返回包含当前 AGENTS.md / Skill / MCP 状态的初始化基线。 */
function baseline(suffix: string): CurrentSessionBaseline {
  return {
    agentsmd: {
      path: `G:/workspace-${suffix}/AGENTS.md`,
      hash: `hash-${suffix}`,
      content: `agents-${suffix}`,
    },
    skills: {
      content: `skills-${suffix}`,
      entries: [{ name: "alpha", scope: "global", enabled: true, estimatedTokens: 5 }],
      descriptions: { alpha: "alpha" },
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
  assert.equal(meta.version, SESSION_META_VERSION)
  assert.deepEqual(meta.currentModel, MODEL)
  assert.equal(meta.sandboxMode, DEFAULT_SESSION_SANDBOX_MODE)
  assert.deepEqual(meta.usage, { inputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, cacheHitRate: 0 })
  assert.deepEqual(meta.skills, { id: null, entries: currentBaseline.skills.entries })
  assert.deepEqual(meta.loadedMcpTools, currentBaseline.additionalMeta?.loadedMcpTools)
  assert.deepEqual(await readJson<SessionContextState>(contextPath), {
    agentsmd: {
      hash: currentBaseline.agentsmd.hash,
      content: currentBaseline.agentsmd.content,
    },
    skills: { id: "initial", content: currentBaseline.skills.content },
    mcp: currentBaseline.mcp,
  })
  assert.equal(await readFile(snapshotPath, "utf8"), currentBaseline.agentsmd.content)
  assert.deepEqual(await state.readContextComparisonState(), {
    agentsSnapshot: currentBaseline.agentsmd.content,
    skills: {
      id: null,
      entries: currentBaseline.skills.entries,
    },
  })
  assert.equal((await lstat(join(sessionDirectory, "tool_output"))).isDirectory(), true)

  meta.sandboxMode = "full-access"
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8")
  currentBaseline = baseline("changed-after-initialization")
  await state.initializeSession()
  assert.equal(baselineReads, 1, "有效的既有派生文件不得按当前状态覆盖")
  assert.equal(await readFile(snapshotPath, "utf8"), "agents-initial")
  assert.equal((await readJson<SessionMeta>(metaPath)).sandboxMode, "full-access")
}

/** 验证不支持的 meta 版本或沙盒模式会作为可修复派生状态重新创建。 */
async function testMetaVersionAndSandboxValidation(root: string): Promise<void> {
  const sessionId = "session-meta-version-and-sandbox"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  await writeEvents(sessionDirectory, initialEvents(sessionId))
  const log = createFileSessionEventLog({ sessionId, sessionDirectory })
  const state = createFileSessionState({
    sessionId,
    sessionDirectory,
    readEvents: log.readEvents,
    resolveCurrentBaseline: async () => baseline("version-and-sandbox"),
    estimateSkillTokens: (description) => description.length,
  })
  const metaPath = join(sessionDirectory, "meta.json")

  await state.initializeSession()
  const unsupportedVersion = await readJson<Record<string, unknown>>(metaPath)
  unsupportedVersion.version = 2
  await writeFile(metaPath, `${JSON.stringify(unsupportedVersion, null, 2)}\n`, "utf8")
  await state.initializeSession()
  assert.equal((await readJson<SessionMeta>(metaPath)).version, SESSION_META_VERSION)

  const unsupportedSandboxMode = await readJson<Record<string, unknown>>(metaPath)
  unsupportedSandboxMode.sandboxMode = "unsupported"
  await writeFile(metaPath, `${JSON.stringify(unsupportedSandboxMode, null, 2)}\n`, "utf8")
  await state.initializeSession()
  const repaired = await readJson<SessionMeta>(metaPath)
  assert.equal(repaired.version, SESSION_META_VERSION)
  assert.equal(repaired.sandboxMode, DEFAULT_SESSION_SANDBOX_MODE)
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

  assert.equal(await state.repairDerivedState(events), undefined)
  const repairedMeta = await readJson<SessionMeta>(metaPath)
  assert.deepEqual(repairedMeta.usage, {
    inputTokens: 20,
    cacheHitTokens: 5,
    cacheMissTokens: 30,
    cacheHitRate: 1 / 7,
  })
  assert.equal(repairedMeta.version, SESSION_META_VERSION)
  assert.equal(repairedMeta.sandboxMode, DEFAULT_SESSION_SANDBOX_MODE)
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
  assert.deepEqual(context.agentsmd, {
    hash: current.agentsmd.hash,
    content: current.agentsmd.content,
  })
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

async function testCurrentModelDiskOperations(root: string): Promise<void> {
  const sessionId = "session-current-model"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  await writeEvents(sessionDirectory, initialEvents(sessionId))
  const log = createFileSessionEventLog({ sessionId, sessionDirectory })
  const state = createFileSessionState({
    sessionId,
    sessionDirectory,
    readEvents: log.readEvents,
    resolveCurrentBaseline: async () => baseline("current-model"),
    estimateSkillTokens: (description) => description.length,
  })
  await state.initializeSession()

  const metaPath = join(sessionDirectory, "meta.json")
  const before = await readJson<SessionMeta>(metaPath)
  before.sandboxMode = "full-access"
  before.futureField = { keep: true }
  await writeFile(metaPath, `${JSON.stringify(before, null, 2)}\n`, "utf8")

  const selected = structuredClone(OTHER_MODEL)
  await state.writeCurrentModel(selected)
  selected.modelId = "mutated-after-write"
  const written = await readJson<SessionMeta>(metaPath)
  assert.deepEqual(written.currentModel, OTHER_MODEL)
  assert.equal(written.sandboxMode, "full-access")
  assert.deepEqual(written.futureField, { keep: true })
  assert.deepEqual(written.usage, before.usage)
  assert.deepEqual(written.skills, before.skills)

  written.currentModel = MODEL
  await writeFile(metaPath, `${JSON.stringify(written, null, 2)}\n`, "utf8")
  assert.deepEqual(await state.readCurrentModel(), MODEL, "读取不得复用上次写入的局部模型")

  await writeFile(metaPath, "not-json\n", "utf8")
  await assert.rejects(state.readCurrentModel(), (error: unknown) =>
    error instanceof Error && error.message.includes(metaPath))
  await rm(metaPath)
  await assert.rejects(state.readCurrentModel(), (error: unknown) =>
    error instanceof Error && error.message.includes(metaPath))

  const globalSessionId = "session-global-model-write"
  const globalSessionDirectory = join(root, ".nicode", "sessions", "7", globalSessionId)
  await mkdir(globalSessionDirectory, { recursive: true })
  await writeEvents(globalSessionDirectory, initialEvents(globalSessionId))
  const globalLog = createFileSessionEventLog({
    sessionId: globalSessionId,
    sessionDirectory: globalSessionDirectory,
  })
  const globalState = createFileSessionState({
    sessionId: globalSessionId,
    sessionDirectory: globalSessionDirectory,
    readEvents: globalLog.readEvents,
    resolveCurrentBaseline: async () => baseline("global-model-write"),
    estimateSkillTokens: (description) => description.length,
  })
  await globalState.initializeSession()
  const previousUserProfile = process.env.USERPROFILE
  process.env.USERPROFILE = root
  try {
    await writeCurrentModel(7, globalSessionId, OTHER_MODEL)
    assert.deepEqual(await globalState.readCurrentModel(), OTHER_MODEL)
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
  }
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
    projectGroupId: "0",
    databasePath: join(dirname(sessionDirectory), "events.sqlite"),
    resolveCurrentBaseline: async () => baseline("complete"),
    estimateSkillTokens: (description) => description.length,
    now: () => new Date(CREATED_AT),
    createEventId: () => `event-${nextId++}`,
  })

  assert.deepEqual(await repairSession(sessionId, ports), { lastTurn: 1 })
  const repaired = await ports.readEvents() as SessionEvent[]
  assert.deepEqual(repaired.slice(5).map((event) => event.type), [
    "assistant/block_end",
    "assistant/message",
    "step/end",
    "turn/end",
  ])
  const count = repaired.length
  await repairSession(sessionId, ports)
  assert.equal((await ports.readEvents()).length, count)
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
    await testMetaVersionAndSandboxValidation(root)
    await testDerivedStateRepair(root)
    await testRecoveryUsesCurrentBaseline(root)
    await testInitializationFailures(root)
    await testCurrentModelDiskOperations(root)
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
