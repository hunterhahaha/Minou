import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { createFileSessionEventLog, initializeSessionEventDatabase } from "../src/event-log.ts"
import { listRunnableQueues, SessionMessageQueue, sessionTransaction, withSessionDatabase } from "../src/message-queue.ts"
import { insertTeamWorkspace, TeamStore, type TeamIdentity } from "../src/team-store.ts"
import { DEFAULT_TEAM_WAKEUP_CONFIG as config } from "../src/team-wakeup-config.ts"
import type { UserMessageContent } from "../src/events.ts"

const MODEL = { providerId: "p", protocol: "responses", modelId: "m", name: "Offline", reasoningLevel: "medium" } as const
const SETTINGS = { currentModel: MODEL, sandboxMode: "sandbox-read-only" } as const
const MESSAGE: UserMessageContent = { content: [{ type: "text", text: "queued" }] }

/** 验证真实 SQLite 的队列原子性、协作状态、黑板隔离和唤醒时间边界。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-team-store-"))
  try {
    const path = join(root, "events.sqlite")
    await initializeSessionEventDatabase(path, true)
    let now = 0
    const store = new TeamStore(path, () => now)
    const router: TeamIdentity = { role: "router", projectId: "default", workspaceId: "work-1",
      routerId: "router-1", sessionId: "router-1", sandboxMode: SETTINGS.sandboxMode }
    const otherRouter: TeamIdentity = { ...router, workspaceId: "work-2", routerId: "router-2", sessionId: "router-2" }
    withSessionDatabase(path, (db) => sessionTransaction(db, () => {
      insertTeamWorkspace(db, router)
      insertTeamWorkspace(db, otherRouter)
    }))
    const member = (parent: TeamIdentity, initial?: string) => store.identity(parent.projectId, store.createMember(parent, SETTINGS, initial))!
    const author = member(router, "publish"), target = member(router), outsider = member(otherRouter)
    const targetQueue = new SessionMessageQueue(path, target.projectId, target.sessionId)
    const logDirectory = join(root, target.sessionId)
    await mkdir(logDirectory)
    const log = createFileSessionEventLog({
      databasePath: path, projectGroupId: target.projectId, sessionDirectory: logDirectory, sessionId: target.sessionId, team: true,
    })
    let turn = 0
    /** 提交队首并模拟成员正常收尾。 */
    async function consume(): Promise<void> {
      const next = targetQueue.read(true)[0]
      assert.ok(next)
      ++turn
      await log.appendTurnStartAndUserMessage([
        { type: "turn/start", turn, model: MODEL },
        { type: "user/message", turn, message: { id: next.messageId, role: "user", ...next } },
      ], next.messageId)
      await log.appendEvent({ type: "turn/end", turn, reason: "completed" })
      assert.equal(store.settle(target), "idle")
    }

    const post = { name: "接口", description: "摘要", body: "正文" }
    assert.throws(() => store.publish(author, { ...post, mentions: [outsider.sessionId] }), /Workspace/)
    assert.throws(() => store.publish(author, { ...post, mentions: [author.sessionId] }), /Mention/)
    assert.throws(() => store.assignOrClose(otherRouter, target.sessionId, "cross workspace"), /Workspace/)
    assert.equal(store.publish(author, { ...post, mentions: [target.sessionId] }).id, "#1")
    assert.throws(() => store.read(target, 1), /unread/)
    const wakes = await Promise.all([Promise.resolve().then(() => store.wake(target, "publish", config, true)),
      Promise.resolve().then(() => store.wake(target, "poll", config))])
    assert.deepEqual(wakes, [true, false])
    assert.equal(targetQueue.read().length, 1)
    await consume()
    assert.equal(store.wake(target, "idle", config), true, "第二次未消费 Mention 仍跳过冷却")
    await consume()
    now = 59_999
    assert.equal(store.wake(target, "poll", config), false)
    now = 60_000
    assert.equal(store.wake(target, "poll", config), true)
    assert.match(targetQueue.read()[0].content[0].text, /unread/)
    await consume()
    assert.deepEqual(store.unread(target), { mentioned: [{ id: "#1", name: post.name, description: post.description }], unread: [] })
    assert.deepEqual(store.read(target, 1), { id: "#1", name: post.name, body: post.body })
    withSessionDatabase(path, (db) => db.prepare("UPDATE team_members SET unconsumed = 2 WHERE session_id = ?").run(target.sessionId))
    assert.deepEqual(store.unread(target), { mentioned: [], unread: [] })
    assert.equal(withSessionDatabase(path, (db) =>
      db.prepare("SELECT unconsumed FROM team_members WHERE session_id = ?").get(target.sessionId)?.unconsumed), 0)
    assert.deepEqual(store.unread(author), { mentioned: [], unread: [] })
    assert.deepEqual(store.unread(outsider), { mentioned: [], unread: [] })
    assert.equal(store.publish(outsider, { ...post, mentions: [] }).id, "#1")
    assert.equal(store.publish(author, { ...post, mentions: [target.sessionId] }).id, "#2")
    assert.equal(store.wake(target, "publish", config, true), true, "unread 已清零连续未消费次数")
    await consume()
    store.unread(target)
    now += 60_000
    for (let i = 0; i < 3; i++) store.publish(author, { ...post, mentions: [] })
    assert.equal(store.wake(target, "publish", config), false, "严格大于阈值才发布唤醒")
    assert.equal(store.wake(target, "poll", config), true, "轮询有一条未读即可检查冷却")
    await consume()
    store.unread(target)
    now += 60_000
    for (let i = 0; i < 4; i++) store.publish(author, { ...post, mentions: [] })
    assert.equal(store.wake(target, "idle", config), true)
    await consume()

    store.report(author, "waiting", "请确认")
    assert.equal(store.settle(author), "waiting")
    const routerQueue = new SessionMessageQueue(path, router.projectId, router.sessionId)
    routerQueue.pause()
    assert.equal(routerQueue.read()[0].origin, "authorization")
    assert.deepEqual(routerQueue.read(true), [])
    assert.equal(store.assignOrClose(router, author.sessionId, "批准").status, "running")
    store.report(author, "finished", "完成")
    assert.equal(store.settle(author), "finished")
    assert.equal(store.assignOrClose(router, author.sessionId).status, "closed")
    assert.equal(store.assignOrClose(router, author.sessionId).status, "closed")
    assert.throws(() => store.assignOrClose(router, author.sessionId, "再次运行"), /关闭/)
    assert.equal(new SessionMessageQueue(path, author.projectId, author.sessionId).read().length, 0)

    const ordinaryDirectory = join(root, "ordinary")
    await mkdir(ordinaryDirectory)
    const queue = new SessionMessageQueue(path, "default", "ordinary")
    const filename = join(root, "reference.txt")
    const referenced: UserMessageContent = {
      content: [{ type: "text", text: filename }],
      fileReferences: [{ projectId: "default", directoryPath: root, relativePath: "reference.txt", absolutePath: filename, name: "reference.txt", offset: 0 }],
    }
    const firstId = queue.enqueue(referenced)
    queue.pause()
    const secondId = queue.enqueue(MESSAGE, true)
    const reopened = new SessionMessageQueue(path, "default", "ordinary")
    assert.deepEqual(reopened.read().map((message) => message.messageId), [firstId, secondId])
    assert.deepEqual(reopened.read()[0].fileReferences, referenced.fileReferences)
    assert.ok(listRunnableQueues(path).some(({ sessionId }) => sessionId === "ordinary"))
    const ordinaryLog = createFileSessionEventLog({
      databasePath: path, projectGroupId: "default", sessionDirectory: ordinaryDirectory, sessionId: "ordinary",
    })
    const batch = [
      { type: "turn/start", turn: 1, model: MODEL },
      { type: "user/message", turn: 1, message: { id: firstId, role: "user", ...referenced } },
    ] as const
    await assert.rejects(ordinaryLog.appendTurnStartAndUserMessage(batch, firstId, () => { throw new Error("rollback") }), /rollback/)
    assert.deepEqual(reopened.read().map((message) => message.messageId), [firstId, secondId])
    await assert.rejects(ordinaryLog.readEvents(), /不存在/)
    await ordinaryLog.appendTurnStartAndUserMessage(batch, firstId)
    assert.deepEqual(reopened.read().map((message) => message.messageId), [secondId])
    assert.equal((await ordinaryLog.readEvents()).length, 2)
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
