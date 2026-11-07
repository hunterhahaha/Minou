/**
 * 使用内存事件日志和假工具验证文件变化、审批及 Turn 收尾顺序。
 *
 * 各场景驱动真实 SessionRuntime 与 Loop，向文件追踪器记录缓冲区差异，
 * 断言正常、停止、失败和审批取消时的事件，不写入被追踪的示例文件。
 */
import assert from "node:assert/strict"
import type { ModelAdapter, ModelRef } from "../../model/src/types.ts"
import type { SessionEvent, SessionEventInput } from "../../session/src/events.ts"
import type { ToolExecutionContext, ToolResult } from "../../tools/src/types.ts"
import { SessionRuntime } from "../src/session-runtime.ts"
import type { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import { join } from "node:path"
import { tmpdir } from "node:os"

const MODEL: ModelRef = { providerId: "p", protocol: "responses", modelId: "m", name: "Model", reasoningLevel: "medium" }
const MESSAGE = [{ type: "text" as const, text: "test" }]
const FILE = "C:\\project\\change.txt"
/** 文件变化与审批测试使用的正常、停止、失败和审批分支。 */
type Scenario = "normal" | "stopped" | "error" | "approval" | "approval_stop"

/**
 * 装配脚本模型和假文件工具，执行指定收尾路径并收集真实 Runtime 写出的事件。
 * @param scenario 要执行的收尾路径。
 * @returns 已提交的事件序列。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function run(scenario: Scenario): Promise<SessionEvent[]> {
  const sessionId = `file-turn-${scenario}`
  const events: SessionEvent[] = []
  let requestCount = 0
  let ports!: SessionRuntime
  /**
   * 向内存日志追加带身份的事件，并在审批请求发布后安排通过或停止操作。
   * @param input 待记录的 Session 事件。
   * @returns 已追加到内存数组的完整事件。
   */
  const append = async (input: SessionEventInput): Promise<SessionEvent> => {
    const event = { ...input, sessionId, eventId: `event-${events.length + 1}`, seq: events.length + 1, createdAt: "2026-09-24T00:00:00Z" } as SessionEvent
    events.push(event)
    if ((scenario === "approval" || scenario === "approval_stop") && event.type === "approval/request") {
      queueMicrotask(() => {
        if (scenario === "approval_stop") ports.stop()
        else ports.decideApproval(event.approvalId, "approved")
      })
    }
    return event
  }
  const adapter: ModelAdapter = {
    contextWindow: 128000, maxOutputTokens: 4096, stream: async function* () {
      requestCount += 1
      if (requestCount > 1) {
        yield { type: "stream_end", completion: "finished" }
        return
      }
      const names = [scenario.startsWith("approval") ? "read" : "write"]
      for (const [index, name] of names.entries()) {
        yield { type: "block_start", index, blockType: "tool_call" }
        yield { type: "block_end", index, block: { type: "tool_call", toolCallId: `call-${index}`, name, arguments: { path: FILE } } }
      }
      yield { type: "stream_end", completion: "tool_calls" }
    },
  }
  const fake = {
    projectGroupId: "default",
    repairPorts: { appendEvent: append, initializeSession: async () => {}, readEvents: async () => events, repairDerivedState: async () => {} },
    createSessionDirectory: async () => {},
    appendTurnStartAndUserMessage: async (pair: readonly [SessionEventInput, SessionEventInput]) => [await append(pair[0]), await append(pair[1])],
    writeCurrentModel: async () => {},
    readCurrentModel: async () => MODEL,
    buildHistory: async () => ({ system: "test", mcpBaseline: [], events: [] }),
    createLoopOptions: async () => ({
      adapter, tools: [],
      executeTool: async (name: string, _args: unknown, context: ToolExecutionContext): Promise<ToolResult> => {
        const runtime = context.fileRuntime
        assert.ok(runtime)
        if (name === "read") {
          const validatedArguments = { path: FILE }
          const decision = await runtime.requestApproval(name, FILE, { ...context, validatedArguments })
          assert.equal(decision, scenario === "approval_stop" ? "cancelled" : "approved")
        } else {
          runtime.tracker.record(FILE, Buffer.from("old\n"), Buffer.from("new\n"))
          if (scenario === "stopped") ports.stop()
          if (scenario === "error") throw new Error("tool failed")
        }
        return { status: "success", content: [{ type: "text", text: "ok" }] }
      },
    }),
  }
  const resources = await fake.createLoopOptions()
  ports = new SessionRuntime({
    sessionId,
    sessionDirectory: join(tmpdir(), sessionId),
    projectGroupId: "default",
    databasePath: join(tmpdir(), "unused-events.sqlite"),
    metaDatabasePath: join(tmpdir(), "unused-meta.sqlite"),
    systemPrompt: "test",
    global: {
      resolveProjectContext: () => ({
        workspaceInfo: "test",
        resolveCurrentBaseline: async () => { throw new Error("unexpected baseline") },
      }),
      estimateSkillTokens: () => 0,
      createTurnModelAdapter: async () => adapter,
      listToolDefinitions: () => [],
      interruptTerminals: () => [],
      disposeProcessTools: async () => {},
      executeTool: resources.executeTool,
    } as unknown as SessionRuntimeGlobal,
  })
  Object.assign(ports, {
    eventLog: {
      readEvents: fake.repairPorts.readEvents,
      appendEvent: fake.repairPorts.appendEvent,
      appendTurnStartAndUserMessage: fake.appendTurnStartAndUserMessage,
    },
    sessionState: {
      readAgentInputTokens: async () => 0,
      synchronizeUsage: async () => {},
      readLoadedMCPTools: async () => [],
      writeLoadedMCPTools: async () => {},
      initializeSession: fake.repairPorts.initializeSession,
      repairDerivedState: fake.repairPorts.repairDerivedState,
    },
    createSessionDirectory: fake.createSessionDirectory,
    writeCurrentModel: fake.writeCurrentModel,
    readCurrentModel: fake.readCurrentModel,
    buildHistory: fake.buildHistory,
  })
  const started = await ports.startNewSession({ content: MESSAGE, model: MODEL })
  if (scenario === "error") await assert.rejects(started.completion, /tool failed/)
  else await started.completion
  return events
}

/**
 * 依次验证正常、停止、失败、审批通过和审批取消时的文件变化与 Turn 终态。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function main(): Promise<void> {
  const normal = await run("normal")
  assert.deepEqual(normal.slice(-2).map((event) => event.type), ["turn/file_changes", "turn/end"])
  const changes = normal.find((event) => event.type === "turn/file_changes")
  assert.ok(changes?.type === "turn/file_changes")
  assert.equal(changes.files[0].description, undefined)
  assert.equal(changes.files[0].changeType, "modified")
  assert.deepEqual(changes.files[0].stats, { additions: 1, deletions: 1 })
  const stopped = await run("stopped")
  assert.deepEqual(stopped.slice(-2).map((event) => event.type), ["turn/file_changes", "turn/end"])
  const stoppedEnd = stopped.at(-1)
  assert.equal(stoppedEnd?.type === "turn/end" && stoppedEnd.reason, "stopped")
  const failed = await run("error")
  assert.deepEqual(failed.slice(-2).map((event) => event.type), ["turn/file_changes", "turn/end"])
  const failedEnd = failed.at(-1)
  assert.equal(failedEnd?.type === "turn/end" && failedEnd.reason, "error")
  const approval = await run("approval")
  assert.deepEqual(approval.filter((event) => event.type.startsWith("approval/")).map((event) => event.type), ["approval/request", "approval/result"])
  assert.equal(approval.some((event) => event.type === "turn/file_changes"), false)
  const cancelled = await run("approval_stop")
  const approvalResult = cancelled.find((event) => event.type === "approval/result")
  assert.ok(approvalResult?.type === "approval/result")
  assert.equal(approvalResult.decision, "cancelled")
  const cancelledEnd = cancelled.at(-1)
  assert.equal(cancelledEnd?.type === "turn/end" && cancelledEnd.reason, "stopped")
  console.log("file-turn.test.ts: 审批与 Turn 收尾顺序断言通过")
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
