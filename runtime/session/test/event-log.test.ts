import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFileSessionEventLog } from "../src/event-log.ts"
import type { SessionEvent, SessionEventInput } from "../src/events.ts"

const CREATED_AT = "2026-09-19T00:00:00.000Z"

/** 创建一条已分配身份的测试事件。 */
function persistedEvent(
  sessionId: string,
  seq: number,
  input: SessionEventInput,
): SessionEvent {
  return {
    ...input,
    eventId: `event-${seq}`,
    sessionId,
    seq,
    createdAt: CREATED_AT,
  } as SessionEvent
}

/** 用一次写入建立合法的首个 Turn 批次。 */
async function writeInitialLog(directory: string, sessionId: string): Promise<SessionEvent[]> {
  const events = [
    persistedEvent(sessionId, 1, {
      type: "turn/start",
      turn: 1,
      model: { providerId: "provider-1", protocol: "responses", modelId: "model-1" },
    }),
    persistedEvent(sessionId, 2, {
      type: "user/message",
      turn: 1,
      message: { id: "message-1", role: "user", content: [{ type: "text", text: "你好" }] },
    }),
  ]
  await writeFile(join(directory, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8")
  return events
}

async function testReadAndAppend(root: string): Promise<void> {
  const sessionId = "session-normal"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  const initial = await writeInitialLog(sessionDirectory, sessionId)
  let nextId = 3
  const log = createFileSessionEventLog({
    sessionId,
    sessionDirectory,
    now: () => new Date(CREATED_AT),
    createEventId: () => `event-${nextId++}`,
  })

  assert.deepEqual(await log.readEvents(), initial)

  const written = await log.appendEvent({
    type: "turn/end",
    turn: 1,
    reason: "error",
  })
  assert.deepEqual(written, persistedEvent(sessionId, 3, {
    type: "turn/end",
    turn: 1,
    reason: "error",
  }))

  const content = await readFile(join(sessionDirectory, "events.jsonl"), "utf8")
  assert.equal(content.endsWith("\n"), true)
  assert.deepEqual(await log.readEvents(), [...initial, written])
}

async function testConcurrentAppend(root: string): Promise<void> {
  const sessionId = "session-concurrent"
  const sessionDirectory = join(root, sessionId)
  await mkdir(sessionDirectory)
  await writeInitialLog(sessionDirectory, sessionId)
  let nextId = 3
  const log = createFileSessionEventLog({
    sessionId,
    sessionDirectory,
    now: () => new Date(CREATED_AT),
    createEventId: () => `event-${nextId++}`,
  })

  const [stepEnd, turnEnd] = await Promise.all([
    log.appendEvent({ type: "step/end", turn: 1, step: 1, reason: "error" }),
    log.appendEvent({ type: "turn/end", turn: 1, reason: "error" }),
  ])

  assert.equal(stepEnd.seq, 3)
  assert.equal(turnEnd.seq, 4)
  const events = await log.readEvents() as SessionEvent[]
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4])
  assert.equal(new Set(events.map((event) => event.eventId)).size, 4)
}

async function testReadFailures(root: string): Promise<void> {
  const missingLog = createFileSessionEventLog({
    sessionId: "missing",
    sessionDirectory: join(root, "missing"),
  })
  await assert.rejects(missingLog.readEvents(), /Session 目录不存在或无法访问/)
  for (const invalidId of ["", ".", "..", "nested/session", "nested\\session"]) {
    assert.throws(
      () => createFileSessionEventLog({ sessionId: invalidId, sessionDirectory: root }),
      /Session ID 必须/,
    )
  }

  const missingLogDirectory = join(root, "session-without-log")
  await mkdir(missingLogDirectory)
  await assert.rejects(
    createFileSessionEventLog({
      sessionId: "session-without-log",
      sessionDirectory: missingLogDirectory,
    }).readEvents(),
    /Session Event Log不存在或无法访问/,
  )

  const invalidJsonDirectory = join(root, "session-invalid-json")
  await mkdir(invalidJsonDirectory)
  await writeFile(join(invalidJsonDirectory, "events.jsonl"), "{\"seq\":1}\nnot-json\n", "utf8")
  await assert.rejects(
    createFileSessionEventLog({
      sessionId: "session-invalid-json",
      sessionDirectory: invalidJsonDirectory,
    }).readEvents(),
    /第 2 行不是有效 JSON/,
  )

  const blankLineDirectory = join(root, "session-blank-line")
  await mkdir(blankLineDirectory)
  await writeFile(join(blankLineDirectory, "events.jsonl"), "{\"seq\":1}\n\n{\"seq\":2}\n", "utf8")
  await assert.rejects(
    createFileSessionEventLog({
      sessionId: "session-blank-line",
      sessionDirectory: blankLineDirectory,
    }).readEvents(),
    /第 2 行为空/,
  )

  const logAsDirectory = join(root, "session-log-directory")
  await mkdir(join(logAsDirectory, "events.jsonl"), { recursive: true })
  await assert.rejects(
    createFileSessionEventLog({
      sessionId: "session-log-directory",
      sessionDirectory: logAsDirectory,
    }).readEvents(),
    /Session Event Log不是普通文件/,
  )
}

async function testAppendFailures(root: string): Promise<void> {
  const emptyDirectory = join(root, "session-empty")
  await mkdir(emptyDirectory)
  await writeFile(join(emptyDirectory, "events.jsonl"), "", "utf8")
  const emptyLog = createFileSessionEventLog({
    sessionId: "session-empty",
    sessionDirectory: emptyDirectory,
  })
  await assert.rejects(
    emptyLog.appendEvent({ type: "turn/end", turn: 1, reason: "error" }),
    /末尾事件缺少有效 seq/,
  )

  const invalidSeqDirectory = join(root, "session-invalid-seq")
  await mkdir(invalidSeqDirectory)
  await writeFile(join(invalidSeqDirectory, "events.jsonl"), "{\"seq\":0}\n", "utf8")
  const invalidSeqLog = createFileSessionEventLog({
    sessionId: "session-invalid-seq",
    sessionDirectory: invalidSeqDirectory,
  })
  await assert.rejects(
    invalidSeqLog.appendEvent({ type: "turn/end", turn: 1, reason: "error" }),
    /末尾事件缺少有效 seq/,
  )

  const exhaustedSeqDirectory = join(root, "session-exhausted-seq")
  await mkdir(exhaustedSeqDirectory)
  await writeFile(
    join(exhaustedSeqDirectory, "events.jsonl"),
    `${JSON.stringify({ seq: Number.MAX_SAFE_INTEGER })}\n`,
    "utf8",
  )
  const exhaustedSeqLog = createFileSessionEventLog({
    sessionId: "session-exhausted-seq",
    sessionDirectory: exhaustedSeqDirectory,
  })
  await assert.rejects(
    exhaustedSeqLog.appendEvent({ type: "turn/end", turn: 1, reason: "error" }),
    /seq 已达到安全整数上限/,
  )

  const emptyIdSession = "session-empty-id"
  const emptyIdDirectory = join(root, emptyIdSession)
  await mkdir(emptyIdDirectory)
  await writeInitialLog(emptyIdDirectory, emptyIdSession)
  const emptyIdLog = createFileSessionEventLog({
    sessionId: emptyIdSession,
    sessionDirectory: emptyIdDirectory,
    createEventId: () => "",
  })
  await assert.rejects(
    emptyIdLog.appendEvent({ type: "turn/end", turn: 1, reason: "error" }),
    /事件 ID 不能为空/,
  )
}

async function main(): Promise<void> {
  assert.throws(
    () => createFileSessionEventLog({ sessionId: "session-relative", sessionDirectory: "relative/path" }),
    /Session 目录必须是绝对路径/,
  )

  const root = await mkdtemp(join(tmpdir(), "nicode-session-event-log-"))
  try {
    await testReadAndAppend(root)
    await testConcurrentAppend(root)
    await testReadFailures(root)
    await testAppendFailures(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  console.log("event-log.test.ts: Session Event Log 文件读写断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
