/** 共享 Session Meta 数据库与派生状态恢复测试。 */

import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { ModelRef } from "../../model/src/types.ts"
import type { SessionEvent } from "../src/events.ts"
import { createFileSessionEventLog, initializeSessionEventDatabase } from "../src/event-log.ts"
import {
  initializeSessionMetaDatabase, readSessionMeta, updateSessionMetaName,
} from "../src/meta-store.ts"
import { createFileSessionState, writeCurrentModel } from "../src/session-state.ts"
import type { CurrentSessionBaseline, SessionMeta } from "../src/session-state.ts"

const PROJECT_ID = "00000000-0000-4000-8000-000000000001"
const SECOND_PROJECT_ID = "00000000-0000-4000-8000-000000000002"
const MODEL: ModelRef = { providerId: "provider", protocol: "responses", modelId: "first", name: "First Model" }
const OTHER_MODEL: ModelRef = { ...MODEL, modelId: "second", name: "Second Model" }

/** 为一个 Session 提供当前 AGENTS.md、Skill 和 MCP 基线。 */
function baseline(root: string): CurrentSessionBaseline {
  return {
    agentsmd: { path: join(root, "AGENTS.md"), hash: "hash", content: "rules" },
    skills: {
      content: "skills",
      entries: [{ name: "alpha", scope: "global", enabled: true, estimatedTokens: 5 }],
      descriptions: { alpha: "alpha" },
    },
    mcp: [],
    additionalMeta: { loadedMcpTools: [{ name: "tool", estimatedTokens: 3 }] },
  }
}

/** 创建已经提交首批 Event Log 的 Session 与其派生状态访问器。 */
async function session(root: string, projectId: string, sessionId: string) {
  const sessionDirectory = join(root, ".nicode", "sessions", projectId, sessionId)
  await mkdir(sessionDirectory, { recursive: true })
  const databasePath = join(root, ".nicode", "events.sqlite")
  const metaDatabasePath = join(root, ".nicode", "meta.sqlite")
  const log = createFileSessionEventLog({ projectGroupId: projectId, sessionId, sessionDirectory, databasePath })
  await log.appendTurnStartAndUserMessage([
    { type: "turn/start", turn: 1, model: MODEL },
    { type: "user/message", turn: 1, message: {
      id: `message-${projectId}-${sessionId}`, role: "user", content: [{ type: "text", text: "hello" }],
    } },
  ])
  const state = createFileSessionState({
    projectId, sessionId, sessionDirectory, databasePath, metaDatabasePath,
    readEvents: log.readEvents,
    resolveCurrentBaseline: async () => baseline(root),
    estimateSkillTokens: (description) => description.length,
  })
  return { state, log, sessionDirectory, metaDatabasePath }
}

/** 验证初始字段、列分离、改名和修复对名称的保持。 */
async function testInitializationAndRename(root: string): Promise<void> {
  const item = await session(root, PROJECT_ID, "shared-session")
  await item.state.initializeSession()
  const meta = readSessionMeta(item.metaDatabasePath, PROJECT_ID, "shared-session") as SessionMeta
  assert.equal(meta.projectId, PROJECT_ID)
  assert.equal(meta.sessionId, "shared-session")
  assert.equal(meta.name, "新对话")
  assert.deepEqual(meta.currentModel, MODEL)
  assert.deepEqual(meta.skills.entries, baseline(root).skills.entries)
  assert.deepEqual(meta.loadedMcpTools, baseline(root).additionalMeta?.loadedMcpTools)
  assert.equal(existsSync(join(item.sessionDirectory, "meta.json")), false)
  assert.equal(await readFile(join(item.sessionDirectory, "agents_md.snapshot"), "utf8"), "rules")

  const db = new DatabaseSync(item.metaDatabasePath, { readOnly: true })
  try {
    const row = db.prepare("SELECT * FROM session_meta WHERE project_id = ? AND session_id = ?")
      .get(PROJECT_ID, "shared-session") as Record<string, unknown>
    assert.deepEqual(JSON.parse(row.current_model_json as string), MODEL)
    assert.deepEqual(JSON.parse(row.usage_json as string), meta.usage)
    assert.deepEqual(JSON.parse(row.skills_json as string), meta.skills)
    assert.deepEqual(JSON.parse(row.additional_meta_json as string), { loadedMcpTools: meta.loadedMcpTools })
    assert.equal(JSON.parse(row.sandbox_mode_json as string), meta.sandboxMode)
  } finally {
    db.close()
  }

  updateSessionMetaName(item.metaDatabasePath, PROJECT_ID, "shared-session", "讨论方案")
  await item.state.writeCurrentModel(OTHER_MODEL)
  await item.state.repairDerivedState(await item.log.readEvents() as SessionEvent[])
  await item.state.initializeSession()
  const renamed = readSessionMeta(item.metaDatabasePath, PROJECT_ID, "shared-session") as SessionMeta
  assert.equal(renamed.name, "讨论方案")
  assert.deepEqual(await item.state.readCurrentModel(), OTHER_MODEL)
  assert.equal(existsSync(join(item.sessionDirectory, "meta.json")), false)
}

/** 验证联合身份隔离及 default 分组。 */
async function testIsolation(root: string): Promise<void> {
  const first = await session(root, PROJECT_ID, "same-id")
  const second = await session(root, SECOND_PROJECT_ID, "same-id")
  const defaultSession = await session(root, "default", "same-id")
  await Promise.all([first.state.initializeSession(), second.state.initializeSession(), defaultSession.state.initializeSession()])
  updateSessionMetaName(first.metaDatabasePath, PROJECT_ID, "same-id", "Project 1")
  updateSessionMetaName(first.metaDatabasePath, "default", "same-id", "默认分组")
  assert.equal((readSessionMeta(first.metaDatabasePath, SECOND_PROJECT_ID, "same-id") as SessionMeta).name, "新对话")
  assert.equal((readSessionMeta(first.metaDatabasePath, "default", "same-id") as SessionMeta).name, "默认分组")
  assert.equal((readSessionMeta(first.metaDatabasePath, PROJECT_ID, "same-id") as SessionMeta).name, "Project 1")
}

/** 恢复权威 Usage、Skill 与 AGENTS.md 事件时保留 SQLite 中的名称和模型选择。 */
async function testDerivedRepair(root: string): Promise<void> {
  const item = await session(root, PROJECT_ID, "derived-repair")
  await item.state.initializeSession()
  updateSessionMetaName(item.metaDatabasePath, PROJECT_ID, "derived-repair", "已命名")
  await item.state.writeCurrentModel(OTHER_MODEL)
  const events = [...await item.log.readEvents()] as SessionEvent[]
  const additions = [
    {
      type: "context_update", turn: 2, source: {
        type: "agents_md", path: join(root, "AGENTS.md"), hash: "new-hash", fullContent: "new rules",
      }, content: "<agents_md_update>new rules</agents_md_update>",
    },
    {
      type: "context_update", turn: 2, source: { type: "skill", changes: [
        { type: "new", name: "beta", scope: "project", description: "beta skill" },
        { type: "disabled", name: "alpha" },
      ] }, content: "<skills_update>beta</skills_update>",
    },
    {
      type: "assistant/message", turn: 2, step: 1,
      message: { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "answer" }] },
      model: MODEL, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 2 },
    },
  ]
  additions.forEach((event, index) => events.push({
    ...event, eventId: `event-${index + 3}`, sessionId: "derived-repair",
    seq: index + 3, createdAt: "2026-09-24T00:00:00Z",
  } as SessionEvent))
  await item.state.repairDerivedState(events)
  await item.state.repairDerivedState(events)
  const meta = readSessionMeta(item.metaDatabasePath, PROJECT_ID, "derived-repair") as SessionMeta
  assert.equal(meta.name, "已命名")
  assert.deepEqual(meta.currentModel, OTHER_MODEL)
  assert.deepEqual(meta.usage, {
    inputTokens: 17, cacheHitTokens: 5, cacheMissTokens: 10, cacheHitRate: 1 / 3,
  })
  assert.deepEqual(meta.skills, { id: "event-4", entries: [
    { name: "alpha", scope: "global", enabled: false, estimatedTokens: 5 },
    { name: "beta", scope: "project", enabled: true, estimatedTokens: 10 },
  ] })
  assert.equal(await readFile(join(item.sessionDirectory, "agents_md.snapshot"), "utf8"), "new rules")
}

/** 验证名称和身份的错误边界以及缺失 Meta 的补建。 */
async function testErrorsAndRecovery(root: string): Promise<void> {
  const item = await session(root, PROJECT_ID, "recover")
  assert.throws(() => updateSessionMetaName(item.metaDatabasePath, PROJECT_ID, "recover", "name"), /不存在/)
  await item.state.initializeSession()
  assert.throws(() => updateSessionMetaName(item.metaDatabasePath, PROJECT_ID, "recover", "  "), /不能为空/)
  assert.throws(() => updateSessionMetaName(item.metaDatabasePath, "../bad", "recover", "name"), /projectId 无效/)
  assert.throws(() => updateSessionMetaName(item.metaDatabasePath, PROJECT_ID, "../bad", "name"), /sessionId 无效/)
  updateSessionMetaName(item.metaDatabasePath, PROJECT_ID, "recover", "保留名称")
  const db = new DatabaseSync(item.metaDatabasePath)
  try {
    db.prepare("UPDATE session_meta SET usage_json = ? WHERE project_id = ? AND session_id = ?")
      .run("not-json", PROJECT_ID, "recover")
  } finally {
    db.close()
  }
  await item.state.initializeSession()
  assert.equal((readSessionMeta(item.metaDatabasePath, PROJECT_ID, "recover") as SessionMeta).name, "保留名称")
  const deleteDb = new DatabaseSync(item.metaDatabasePath)
  try {
    deleteDb.prepare("DELETE FROM session_meta WHERE project_id = ? AND session_id = ?").run(PROJECT_ID, "recover")
  } finally {
    deleteDb.close()
  }
  await item.state.initializeSession()
  assert.equal((readSessionMeta(item.metaDatabasePath, PROJECT_ID, "recover") as SessionMeta).name, "新对话")

  const globalSession = await session(root, PROJECT_ID, "global-write")
  await globalSession.state.initializeSession()
  const previousProfile = process.env.USERPROFILE
  process.env.USERPROFILE = root
  try {
    await writeCurrentModel(PROJECT_ID, "global-write", OTHER_MODEL)
    assert.deepEqual(await globalSession.state.readCurrentModel(), OTHER_MODEL)
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-session-meta-"))
  try {
    const configRoot = join(root, ".nicode")
    await mkdir(configRoot)
    await initializeSessionEventDatabase(join(configRoot, "events.sqlite"))
    const metaDatabasePath = join(configRoot, "meta.sqlite")
    initializeSessionMetaDatabase(metaDatabasePath)
    initializeSessionMetaDatabase(metaDatabasePath)
    await testInitializationAndRename(root)
    await testIsolation(root)
    await testDerivedRepair(root)
    await testErrorsAndRecovery(root)
    await testSettings(root)
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(root, { recursive: true, force: true })
  }
  console.log("session-state.test.ts: SQLite Session Meta 断言通过")
}

/** @param root 临时用户目录。 @returns 设置串行写入、名称保留与重新读取验证。 */
async function testSettings(root: string): Promise<void> {
  const item = await session(root, PROJECT_ID, "settings")
  await item.state.initializeSession()
  updateSessionMetaName(item.metaDatabasePath, PROJECT_ID, "settings", "保留名称")
  const before = readSessionMeta(item.metaDatabasePath, PROJECT_ID, "settings") as SessionMeta
  await Promise.all([item.state.writeSettings({ sandboxMode: "sandbox-read-only" }), item.state.writeSettings({ model: OTHER_MODEL })])
  const current = await item.state.readSettings()
  assert.deepEqual(current, { name: "保留名称", currentModel: OTHER_MODEL, sandboxMode: "sandbox-read-only" })
  const after = readSessionMeta(item.metaDatabasePath, PROJECT_ID, "settings") as SessionMeta
  assert.deepEqual(after.usage, before.usage)
  assert.deepEqual(after.skills, before.skills)
  current.currentModel.name = "外部副本"
  assert.equal((await item.state.readSettings()).currentModel.name, OTHER_MODEL.name)
  await assert.rejects(item.state.writeSettings({}), /设置更新无效/)
  await assert.rejects(item.state.writeSettings({ sandboxMode: "invalid" as never }), /设置更新无效/)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
