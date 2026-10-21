/**
 * 使用真实 Session 存储和工具执行器验证 Skill 对话流程。
 *
 * 覆盖首次载入、Queue、Continue、来源状态静默更新和已提交事件恢复。
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import type { ModelAdapter, ModelRef, UnifiedModelRequest } from "../../model/src/types.ts"
import type { SessionEvent } from "../../session/src/events.ts"
import type { FileSessionState, SessionMeta } from "../../session/src/session-state.ts"
import { readSessionMeta } from "../../session/src/meta-store.ts"
import { synchronizeSkillSource } from "../../skill/src/index.ts"
import { RenderRegistry, ToolRegistry } from "../../tools/src/index.ts"
import { SessionRuntime } from "../src/session-runtime.ts"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { insertProjectWorkspace } from "../../../src/main/workspace-store.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"

const PROJECT = "00000000-0000-4000-8000-000000000001"
const MODEL: ModelRef = { providerId: "offline", protocol: "responses", modelId: "offline", name: "Offline" }
const MESSAGE = [{ type: "text" as const, text: "使用 Skill" }]

/**
 * 创建 Skill 文件并同步来源 registry。
 *
 * @param source Global 或 Project Skill 来源目录。
 * @param name 要创建的 Skill 文件夹名。
 * @param description 写入 frontmatter 和正文的描述文本。
 * @returns 文件写入和 registry 同步完成后兑现的 Promise。
 * @throws 文件系统写入或 registry 同步失败时抛出。
 */
async function addSkill(source: string, name: string, description: string): Promise<void> {
  await mkdir(join(source, name), { recursive: true })
  await writeFile(join(source, name, "SKILL.md"), `---\nname: ignored\ndescription: ${JSON.stringify(description)}\n---\n${description} full body`)
  await synchronizeSkillSource(source, source.includes(PROJECT) ? "project" : "global")
}

/**
 * 执行真实 Turn、管理器启停保存、增量通知和故障恢复验证。
 *
 * @returns 全部 Session 与 Skill 验证完成后兑现的 Promise。
 * @throws AssertionError 记录、通知或恢复结果不符合契约时抛出；运行时和文件系统错误也会向上传递。
 */
async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "nicode-skill-turn-"))
  try {
    const paths = await initializeConfigFiles(profile)
    await mkdir(join(paths.rootDir, "sessions", PROJECT, "workspace"), { recursive: true })
    insertProjectWorkspace(paths.workspaceDatabasePath, { id: PROJECT, version: 1, name: "Skills", updatedAt: "2026-10-18T00:00:00Z", directories: [], sessions: [] })
    const globalDirectory = join(paths.rootDir, "skills"), localDirectory = join(paths.rootDir, "sessions", PROJECT, "skills")
    await addSkill(globalDirectory, "review", "global-description")
    const global = new SessionRuntimeGlobal(paths, new ToolRegistry(), new RenderRegistry())
    const requests: UnifiedModelRequest[] = []
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    let entered!: () => void
    const modelEntered = new Promise<void>((done) => { entered = done })
    let adapters = 0
    global.createTurnModelAdapter = async (): Promise<ModelAdapter> => {
      const turn = ++adapters
      let step = 0
      return { contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (request) {
        requests.push(structuredClone(request))
        assert.ok(request.tools?.some((tool) => tool.name === "skill_load"))
        if (++step === 1) {
          if (turn === 1) { entered(); await gate }
          yield { type: "block_start", index: 0, blockType: "tool_call" }
          yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: `skill-${turn}`, name: "skill_load", arguments: { name: "review" } } }
          yield { type: "stream_end", completion: "tool_calls" }
        } else {
          const result = request.context.messages.find((message) => message.role === "tool" && message.toolCallId === `skill-${turn}`)
          assert.ok(result)
          yield { type: "block_start", index: 0, blockType: "text" }
          yield { type: "block_end", index: 0, block: { type: "text", text: "done" } }
          yield { type: "stream_end", completion: "finished" }
        }
      } }
    }
    const directory = join(paths.rootDir, "sessions", PROJECT, "session")
    const createRuntime = () => new SessionRuntime({ projectGroupId: PROJECT, sessionId: "session", sessionDirectory: directory, databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "system", global })
    let runtime = createRuntime()
    /**
     * 读取当前测试对话的持久化 Meta。
     *
     * @returns 当前 Session 的 Meta 快照。
     */
    const meta = () => readSessionMeta(paths.metaDatabasePath, PROJECT, "session") as SessionMeta
    /**
     * 从当前 Session 事件中筛选 Skill 增量通知。
     *
     * @returns 已持久化的 Skill context_update 事件。
     */
    const notifications = async () => (await runtime.readEvents() as readonly SessionEvent[]).filter((event) => event.type === "context_update" && event.source.type === "skill")
    /**
     * 继续当前 Session 并等待下一 Turn 完成。
     *
     * @returns Turn 完成后兑现的 Promise。
     * @throws SessionRuntime 的继续或 Turn 执行失败时抛出。
     */
    const next = async () => { const turn = await runtime.continueSession({ model: MODEL, content: MESSAGE }); await turn.completion }
    try {
      const started = await runtime.startNewSession({ model: MODEL, content: MESSAGE })
      runtime.enqueueSessionMessage({ content: MESSAGE })
      const processing = runtime.processMessageQueue(started)
      await modelEntered
      await addSkill(localDirectory, "review", "project-description")
      release()
      await processing.completion
      runtime = createRuntime()
      assert.equal(adapters, 2)
      assert.equal((await notifications()).length, 1)
      assert.equal(meta().skills.entries.length, 2)
      assert.deepEqual(meta().skills.entries.map((item) => [item.scope, item.enabled]), [["global", false], ["project", true]])
      const secondTurn = requests[2].context.messages
      assert.match(JSON.stringify(secondTurn[0]), /global-description/)
      assert.equal(JSON.stringify(secondTurn[0]).includes("project-description"), false, "新增内容只通过一次增量注入")
      assert.equal(secondTurn.filter((message) => message.role === "user" && JSON.stringify(message).includes("project-description")).length, 1)
      await rm(join(localDirectory, "review"), { recursive: true })
      await next()
      assert.equal((await notifications()).length, 1, "切回载入过的 Global 来源静默")
      assert.deepEqual(meta().skills.entries.map((item) => item.enabled), [true, false])
      await global.skillManager.setSkillEnabled({ scope: "global" }, "review", false)
      await next()
      assert.equal((await notifications()).length, 1)
      assert.ok(meta().skills.entries.every((item) => !item.enabled))
      const results = (await runtime.readEvents() as readonly SessionEvent[]).filter((event) => event.type === "tool/result")
      assert.equal(results.at(-1)!.result.status, "error")
      await global.skillManager.setSkillEnabled({ scope: "global" }, "review", true)
      await next()
      assert.equal((await notifications()).length, 1, "重新启用已有来源静默")
      await addSkill(globalDirectory, "review", "edited-description")
      await next()
      assert.equal((await notifications()).length, 1)
      assert.equal(JSON.stringify(requests.at(-2)!.context.messages[0]).includes("edited-description"), false)

      await addSkill(globalDirectory, "pending", "pending-description")
      const append = runtime.appendEvent.bind(runtime)
      runtime.appendEvent = async (event) => { if (event.type === "context_update") throw new Error("injected append failure"); return append(event) }
      await assert.rejects(next(), /injected append/)
      assert.equal(meta().skills.entries.some((item) => item.name === "pending"), false)
      runtime.appendEvent = append
      const state = (runtime as unknown as { sessionState: FileSessionState }).sessionState
      const repair = state.repairDerivedState
      let fail = true
      state.repairDerivedState = async (events) => {
        if (fail && events.some((event) => event.type === "context_update" && event.source.type === "skill" && event.source.changes.some((change) => change.name === "pending"))) { fail = false; throw new Error("injected state failure") }
        return repair(events)
      }
      await assert.rejects(next(), /injected state/)
      assert.equal((await notifications()).length, 2)
      assert.equal(meta().skills.entries.some((item) => item.name === "pending"), false)
      state.repairDerivedState = repair
      await addSkill(globalDirectory, "pending", "changed-after-event")
      await next()
      assert.equal((await notifications()).length, 2, "恢复已提交事件不会再次追加")
      assert.equal(meta().skills.entries.filter((item) => item.name === "pending").length, 1)
      assert.match(JSON.stringify((await notifications()).at(-1)), /pending-description/)
      await runtime.repairSession()
      assert.equal(meta().skills.entries.filter((item) => item.name === "pending").length, 1)

      const events = await runtime.readEvents() as readonly SessionEvent[]
      for (const event of events.filter((item) => item.type === "tool/result")) {
        const call = events.find((item) => item.eventId === event.toolCallEventId)
        assert.ok(call?.type === "assistant/block_end" && call.block.type === "tool_call")
        assert.equal(call.block.toolCallId, event.toolCallId)
      }
      const reloaded = await runtime.reloadSkills()
      assert.match(reloaded.content, /edited-description/)
      assert.match(reloaded.content, /changed-after-event/)
      assert.equal(meta().skills.entries.some((item) => item.scope === "project"), false, "完整重载重建当前来源基线")
      const other = new SessionRuntime({ projectGroupId: PROJECT, sessionId: "other", sessionDirectory: join(paths.rootDir, "sessions", PROJECT, "other"), databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "system", global })
      const another = await other.startNewSession({ model: MODEL, content: MESSAGE }); await another.completion
      assert.equal((await other.readEvents() as readonly SessionEvent[]).some((item) => item.type === "context_update"), false)
      other.close()
      console.log("skill-turn.test.ts: 同名来源并存、Queue/Continue、静默状态和提交恢复通过")
    } finally { runtime.close() }
  } finally {
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
