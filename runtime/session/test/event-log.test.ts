import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createFileSessionEventLog } from "../src/event-log.ts"
import type { FileSessionEventLogOptions } from "../src/event-log.ts"
import type { SessionEvent, TurnStartEventInput, UserMessageEventInput } from "../src/events.ts"

const CREATED_AT = "2026-09-19T00:00:00.000Z"
const MODEL = { providerId: "provider-1", protocol: "responses" as const, modelId: "model-1" }

/** 为每个测试 Session 建立目录并指向同一个测试数据库。 */
async function fixture(root: string, sessionId: string, group = "0", overrides = {}): Promise<FileSessionEventLogOptions> {
  const sessionDirectory = join(root, group, sessionId)
  await mkdir(sessionDirectory, { recursive: true })
  return {
    sessionId, projectGroupId: group, sessionDirectory, databasePath: join(root, "events.sqlite"),
    now: () => new Date(CREATED_AT), ...overrides,
  }
}

/** 新 Turn 的两个待持久化事件。 */
function turnBatch(
  turn: number, messageId = `message-${turn}`,
): [TurnStartEventInput, UserMessageEventInput] {
  return [
    { type: "turn/start" as const, turn, model: MODEL },
    {
      type: "user/message" as const, turn,
      message: { id: messageId, role: "user" as const, content: [{ type: "text" as const, text: "你好" }] },
    },
  ]
}

/** 验证首次事务提交、顺序读取和单条追加。 */
async function testCreateReadAppend(root: string): Promise<void> {
  let nextId = 1
  const options = await fixture(root, "normal", "0", { createEventId: () => `event-${nextId++}` })
  const log = createFileSessionEventLog(options)
  await assert.rejects(log.readEvents(), /数据库不存在/)
  const first = await log.appendTurnStartAndUserMessage(turnBatch(1))
  assert.deepEqual(first.map((event) => event.seq), [1, 2])
  assert.deepEqual(await log.readEvents(), first)
  const end = await log.appendEvent({ type: "turn/end", turn: 1, reason: "completed" })
  assert.equal(end.seq, 3)
  assert.equal(end.eventId, "event-3")
  assert.deepEqual(await log.readEvents(), [...first, end])
  assert.equal((await lstat(options.databasePath)).isFile(), true)
}

/** 验证同一 Session 跨访问器并发写入仍按调用顺序分配 seq。 */
async function testConcurrentAppend(root: string): Promise<void> {
  const options = await fixture(root, "concurrent")
  const log = createFileSessionEventLog(options)
  await log.appendTurnStartAndUserMessage(turnBatch(1))
  const other = createFileSessionEventLog(options)
  const [step, end] = await Promise.all([
    log.appendEvent({ type: "step/end", turn: 1, step: 1, reason: "error" }),
    other.appendEvent({ type: "turn/end", turn: 1, reason: "error" }),
  ])
  assert.deepEqual([step.seq, end.seq], [3, 4])
  assert.deepEqual((await log.readEvents() as SessionEvent[]).map((event) => event.seq), [1, 2, 3, 4])
}

/** 验证一个数据库内同名 Session 在不同分组中隔离。 */
async function testIsolation(root: string): Promise<void> {
  const left = createFileSessionEventLog(await fixture(root, "same-id", "0"))
  const right = createFileSessionEventLog(await fixture(root, "same-id", "7"))
  const sibling = createFileSessionEventLog(await fixture(root, "another-id", "0"))
  await left.appendTurnStartAndUserMessage(turnBatch(1, "left"))
  await right.appendTurnStartAndUserMessage(turnBatch(1, "right"))
  await sibling.appendTurnStartAndUserMessage(turnBatch(1, "sibling"))
  assert.equal((await left.readEvents() as SessionEvent[])[1].type, "user/message")
  assert.equal((await right.readEvents() as SessionEvent[])[1].type, "user/message")
  assert.notDeepEqual(await left.readEvents(), await right.readEvents())
  assert.notDeepEqual(await left.readEvents(), await sibling.readEvents())
}

/** 验证下一 Turn 编号和首批事件的事务原子性。 */
async function testTurnBatch(root: string): Promise<void> {
  const options = await fixture(root, "batch")
  const log = createFileSessionEventLog(options)
  await assert.rejects(log.appendTurnStartAndUserMessage(turnBatch(2)), /首个 Turn 必须为 1/)
  await assert.rejects(log.readEvents(), /不存在或无法访问/)
  await log.appendTurnStartAndUserMessage(turnBatch(1))
  await assert.rejects(log.appendTurnStartAndUserMessage(turnBatch(2)), /尚未完整结束/)
  await log.appendEvent({ type: "turn/end", turn: 1, reason: "completed" })
  await assert.rejects(log.appendTurnStartAndUserMessage(turnBatch(3)), /编号不连续/)
  const second = await log.appendTurnStartAndUserMessage(turnBatch(2))
  assert.deepEqual(second.map((event) => event.seq), [4, 5])

  const duplicate = createFileSessionEventLog(await fixture(root, "duplicate-id", "0", {
    createEventId: () => "same-id",
  }))
  await assert.rejects(duplicate.appendTurnStartAndUserMessage(turnBatch(1)), /无法追加/)
  await assert.rejects(duplicate.readEvents(), /不存在或无法访问/)
}

/** 验证数据库缺失、损坏和事件内容损坏会明确报错。 */
async function testReadFailures(root: string): Promise<void> {
  const missingDirectory = createFileSessionEventLog({
    sessionId: "missing", projectGroupId: "0",
    sessionDirectory: join(root, "missing"), databasePath: join(root, "events.sqlite"),
  })
  await assert.rejects(missingDirectory.readEvents(), /Session 目录不存在/)
  const otherDatabase = await fixture(root, "corrupt", "0", { databasePath: join(root, "corrupt.sqlite") })
  await writeFile(otherDatabase.databasePath, "not-a-sqlite-database")
  await assert.rejects(createFileSessionEventLog(otherDatabase).readEvents(), /无法读取 Session Event Log/)

  const db = new DatabaseSync(join(root, "events.sqlite"))
  try {
    db.prepare("UPDATE session_events SET event_json = ? WHERE project_group_id = ? AND session_id = ? AND seq = ?")
      .run("not-json", "0", "normal", 1)
  } finally {
    db.close()
  }
  const normal = createFileSessionEventLog(await fixture(root, "normal"))
  await assert.rejects(normal.readEvents(), /不是有效 JSON/)
}

/** 验证非法身份、序号边界和单事件写入失败不改变日志。 */
async function testAppendFailures(root: string): Promise<void> {
  for (const sessionId of ["", ".", "..", "nested/session", "nested\\session"]) {
    assert.throws(() => createFileSessionEventLog({
      sessionId, projectGroupId: "0", sessionDirectory: root, databasePath: join(root, "events.sqlite"),
    }), /Session ID 必须/)
  }
  assert.throws(() => createFileSessionEventLog({
    sessionId: "relative", projectGroupId: "0",
    sessionDirectory: "relative/path", databasePath: join(root, "events.sqlite"),
  }), /Session 目录必须是绝对路径/)
  const options = await fixture(root, "empty-id", "0", { createEventId: () => "" })
  const log = createFileSessionEventLog(options)
  await assert.rejects(log.appendTurnStartAndUserMessage(turnBatch(1)), /事件 ID 不能为空/)
  await assert.rejects(log.readEvents(), /不存在或无法访问/)

  const good = createFileSessionEventLog(await fixture(root, "empty-id"))
  await good.appendTurnStartAndUserMessage(turnBatch(1))
  const before = await good.readEvents()
  await assert.rejects(log.appendEvent({ type: "turn/end", turn: 1, reason: "error" }), /事件 ID 不能为空/)
  assert.deepEqual(await good.readEvents(), before)
}

/** 验证末尾 seq 无效或耗尽时不能继续追加。 */
async function testSequenceFailures(root: string): Promise<void> {
  for (const [sessionId, seq, expected] of [
    ["invalid-seq", 0, /末尾事件缺少有效 seq/],
    ["exhausted-seq", Number.MAX_SAFE_INTEGER, /seq 已达到安全整数上限/],
  ] as const) {
    const log = createFileSessionEventLog(await fixture(root, sessionId))
    await log.appendTurnStartAndUserMessage(turnBatch(1))
    const db = new DatabaseSync(join(root, "events.sqlite"))
    try {
      const event = (await log.readEvents() as SessionEvent[])[1]
      if (seq === 0) {
        db.prepare("DELETE FROM session_events WHERE project_group_id = ? AND session_id = ? AND seq = 1")
          .run("0", sessionId)
      }
      db.prepare(`UPDATE session_events SET seq = ?, event_json = ?
        WHERE project_group_id = ? AND session_id = ? AND seq = 2`)
        .run(seq, JSON.stringify({ ...event, seq }), "0", sessionId)
    } finally {
      db.close()
    }
    await assert.rejects(log.appendEvent({ type: "turn/end", turn: 1, reason: "error" }), expected)
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-session-event-log-"))
  try {
    await testCreateReadAppend(root)
    await testConcurrentAppend(root)
    await testIsolation(root)
    await testTurnBatch(root)
    await testReadFailures(root)
    await testAppendFailures(root)
    await testSequenceFailures(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  console.log("event-log.test.ts: Session Event Log SQLite 读写断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
