/** 真实 Session 存储、MemoryManager 和工具执行器的离线整链测试。 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { MemoryManager } from "../../memory/src/index.ts"
import type { ModelAdapter, ModelRef, UnifiedModelRequest } from "../../model/src/types.ts"
import type { SessionEvent } from "../../session/src/events.ts"
import { registerMemoryTools, RenderRegistry, ToolRegistry } from "../../tools/src/index.ts"
import type { ToolCallContext } from "../../tools/src/types.ts"
import { SessionRuntime } from "../src/session-runtime.ts"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import { insertProjectWorkspace } from "../../../src/main/workspace-store.ts"

const MODEL: ModelRef = { providerId: "offline", protocol: "responses", modelId: "offline", name: "Offline" }
const MESSAGE = [{ type: "text" as const, text: "测试记忆工具" }]
const PROJECT = "00000000-0000-4000-8000-000000000001"
const PRIOR = "仅保存在记忆文件中的跨对话偏好"

/**
 * 验证新对话、Queue 和重建实例后的 Continue，共用真实记忆与事件存储。
 * @param profile 测试用户目录。
 * @param projectId default 或真实 UUID 分组。
 * @returns 三条入口及工具事件验证完成。
 * @throws AssertionError 任何调用身份、提交结果或上下文行为偏离契约。
 */
async function scenario(profile: string, projectId: string): Promise<void> {
  const paths = await initializeConfigFiles(profile)
  if (projectId !== "default") {
    await mkdir(join(paths.rootDir, "sessions", projectId, "workspace"), { recursive: true })
    insertProjectWorkspace(paths.workspaceDatabasePath, { id: projectId, version: 1, name: "记忆测试", updatedAt: "2026-10-09T00:00:00Z", directories: [], sessions: [] })
  }
  const manager = new MemoryManager(paths.rootDir, () => new Date("2026-10-09T00:00:00.001Z"))
  await manager.write(projectId, [{ level1: "偏好", level2: "交流", content: PRIOR }])
  const tools = new ToolRegistry(), renders = new RenderRegistry()
  registerMemoryTools(tools, renders, manager)
  const global = new SessionRuntimeGlobal(paths, tools, renders)
  let release!: () => void
  const gate = new Promise<void>((done) => { release = done })
  let adapterCount = 0
  const requests: UnifiedModelRequest[] = []
  const contexts: ToolCallContext[] = []
  const execute = global.executeTool.bind(global)
  global.executeTool = async (name, args, context) => {
    assert.equal(context.projectId, projectId)
    contexts.push(context)
    return execute(name, args, context)
  }
  global.createTurnModelAdapter = async (): Promise<ModelAdapter> => {
    const turn = ++adapterCount
    let step = 0
    return { stream: async function* (request) {
      requests.push(structuredClone(request))
      step += 1
      const system = request.context.messages[0]
      assert.equal(system.role, "system")
      assert.equal(JSON.stringify(system).includes(PRIOR), false, "记忆正文不能默认注入 System Message")
      assert.ok(["memory_list", "memory_read", "memory_write"].every((name) => request.tools?.some((tool) => tool.name === name)))
      if (turn === 1 && step === 1) await gate
      if (step === 1) {
        const block = { type: "tool_call" as const, toolCallId: `turn-${turn}-write`, name: "memory_write", arguments: { memories: [{ level1: "偏好", level2: "交流", content: `第 ${turn} 轮纠正` }], callDescription: "保存纠正" } }
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block }
        yield { type: "stream_end", completion: "tool_calls" }
      } else if (step === 2) {
        const result = request.context.messages.find((message) => message.role === "tool" && message.toolCallId === `turn-${turn}-write`)
        assert.ok(result?.role === "tool" && !result.isError)
        assert.match(JSON.stringify(result.content), /成功写入 1 条/)
        const calls = [
          { name: "memory_list", arguments: { callDescription: "查看分类" } },
          { name: "memory_read", arguments: { sections: [{ level1: "偏好", level2: ["交流"] }] } },
        ]
        for (const [index, call] of calls.entries()) {
          yield { type: "block_start", index, blockType: "tool_call" }
          yield { type: "block_end", index, block: { type: "tool_call", toolCallId: `turn-${turn}-${call.name}`, ...call } }
        }
        yield { type: "stream_end", completion: "tool_calls" }
      } else {
        const list = request.context.messages.find((message) => message.role === "tool" && message.toolCallId === `turn-${turn}-memory_list`)
        const read = request.context.messages.find((message) => message.role === "tool" && message.toolCallId === `turn-${turn}-memory_read`)
        assert.ok(list?.role === "tool" && read?.role === "tool")
        assert.equal(JSON.stringify(list.content).includes(PRIOR), false)
        assert.ok(JSON.stringify(read.content).includes(PRIOR))
        assert.ok(JSON.stringify(read.content).includes(`第 ${turn} 轮纠正`))
        yield { type: "block_start", index: 0, blockType: "text" }
        yield { type: "block_delta", index: 0, delta: { type: "text", text: "已读取记忆" } }
        yield { type: "block_end", index: 0, block: { type: "text", text: "已读取记忆" } }
        yield { type: "stream_end", completion: "finished" }
      }
    } }
  }
  /** @returns 当前分组同一 Session 的真实 Runtime；构造不创建新记忆。 */
  const createRuntime = (): SessionRuntime => new SessionRuntime({
    projectGroupId: projectId, sessionId: "memory-session", sessionDirectory: join(paths.rootDir, "sessions", projectId, "memory-session"),
    databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "离线测试", global,
  })
  const initial = createRuntime()
  const started = await initial.startNewSession({ content: MESSAGE, model: MODEL, sandboxMode: "sandbox-read-only" })
  initial.enqueueSessionMessage({ content: MESSAGE })
  const processing = initial.processMessageQueue(started)
  release()
  await processing.completion
  assert.equal(adapterCount, 2, "首轮完成后自动消费 Queue")
  const resumed = createRuntime()
  try {
    const continued = await resumed.continueSession({ content: MESSAGE, model: MODEL })
    await continued.completion
    assert.equal(continued.turn, 3)
    assert.equal(adapterCount, 3)
    assert.equal(requests.length, 9)
    assert.equal(contexts.length, 9)
    const events = await resumed.readEvents() as readonly SessionEvent[]
    const results = events.filter((event) => event.type === "tool/result")
    assert.equal(results.length, 9)
    for (const result of results) {
      assert.equal(result.result.status, "success")
      const call = events.find((event) => event.eventId === result.toolCallEventId)
      assert.ok(call?.type === "assistant/block_end" && call.block.type === "tool_call")
      assert.equal(call.block.toolCallId, result.toolCallId)
      assert.equal(call.blockId, result.blockId)
    }
    assert.equal(events.some((event) => event.type === "approval/request" || event.type === "turn/file_changes"), false)
    assert.equal(events.filter((event) => event.type === "turn/end" && event.reason === "completed").length, 3)
    assert.equal((await new MemoryManager(paths.rootDir).read(projectId, [{ level1: "偏好", level2: ["交流"] }])).sections[0].memories.length, 4)
    if (projectId !== "default") assert.deepEqual(await manager.list("default"), { sections: [] })
  } finally { resumed.close() }
}

/** @returns default 与 Project 的完整调用链验证完成。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-memory-turn-"))
  try {
    await scenario(join(root, "default-profile"), "default")
    await scenario(join(root, "project-profile"), PROJECT)
    console.log("memory-turn.test.ts: 新对话、Queue、Continue 和记忆结果回填通过")
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
