/**
 * ToolScheduler 切轮与调度测试（TODOList 阶段 6.4、第 17 节）。
 *
 * 用「带耗时的假执行函数」观察调度行为，不实现任何工具、不碰网络。运行：
 *   node --experimental-strip-types runtime/tools/test/tool-scheduler.test.ts
 *
 * 断言包在 async main() 里而非顶层 await：测试被 Node 当作 ESM 运行，
 * 但 tsc 按 CommonJS 检查，顶层 await 在后者不合法。
 *
 * 两层断言：
 *   - 切轮：`planToolRounds` 是纯函数，直接比对切分结果；
 *   - 执行：把执行轨迹（`start` / `end`）与消费轨迹（`got`）写进同一条数组，
 *     于是「谁先完成、谁先被交出、下一轮何时开始」都能直接从轨迹读出来，不依赖墙钟时间。
 *
 * 覆盖：切轮规则、共享只读并发且完成即交出、独占单独一轮、轮与轮严格串行、空批次、
 *       异常传播、分组名单。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 16.5 节（完成后即可记录）、
 *          第 17 节（Tool Scheduler）
 */

import assert from "node:assert/strict"

import {
  planToolRounds,
  runToolCalls,
  SHARED_READ_ONLY_TOOLS,
  toolScheduleGroup,
} from "../src/tool-scheduler.ts"
import type { ToolResult } from "../src/types.ts"

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

interface FakeCall {
  toolName: string
  toolCallId: string
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function textResult(text: string): ToolResult {
  return { status: "success", content: [{ type: "text", text }] }
}

function textOf(result: ToolResult): string {
  const first = result.content[0]
  return first?.type === "text" ? first.text : ""
}

interface Harness {
  /** 执行与消费交错的轨迹，元素形如 `start call-1` / `end call-1` / `got call-1`。 */
  trace: string[]
  /** 并发峰值：用来断言「确实并发」或「确实串行」。 */
  peakConcurrency: number
  /** 消费调度输出，返回交出的结果（顺序 = 完成顺序）。 */
  run: (calls: readonly FakeCall[]) => Promise<ToolResult[]>
}

/**
 * 假执行函数 + 消费循环。
 *
 * `delays` 按 toolCallId 给单次调用的耗时，用来制造「后发先至」的完成顺序；
 * `failures` 里的调用在执行完成后抛错，用来观察异常传播。
 */
function makeHarness(
  delays: Record<string, number> = {},
  failures: Record<string, unknown> = {},
): Harness {
  const trace: string[] = []
  const stats = { peakConcurrency: 0 }
  let concurrent = 0

  async function execute(call: FakeCall): Promise<ToolResult> {
    trace.push(`start ${call.toolCallId}`)
    concurrent += 1
    stats.peakConcurrency = Math.max(stats.peakConcurrency, concurrent)

    await delay(delays[call.toolCallId] ?? 0)

    concurrent -= 1
    trace.push(`end ${call.toolCallId}`)

    const failure = failures[call.toolCallId]
    if (failure !== undefined) throw failure
    return textResult(call.toolCallId)
  }

  async function run(calls: readonly FakeCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = []
    for await (const { call, result } of runToolCalls(calls, execute)) {
      trace.push(`got ${call.toolCallId}`)
      results.push(result)
    }
    return results
  }

  return {
    trace,
    get peakConcurrency() {
      return stats.peakConcurrency
    },
    run,
  }
}

// ---------------------------------------------------------------------------
// 0. 切轮规则
// ---------------------------------------------------------------------------

function testPlanToolRounds(): void {
  const call = (toolName: string, toolCallId: string): FakeCall => ({ toolName, toolCallId })
  const namesOf = (rounds: FakeCall[][]): string[][] =>
    rounds.map((round) => round.map((item) => item.toolCallId))

  // 连续的一段共享只读 → 同一轮
  assert.deepEqual(
    namesOf(planToolRounds([call("read", "c1"), call("grep", "c2"), call("glob", "c3")])),
    [["c1", "c2", "c3"]],
  )

  // 独占工具单独一轮，即便前后都是共享只读
  assert.deepEqual(
    namesOf(
      planToolRounds([
        call("read", "c1"),
        call("grep", "c2"),
        call("write", "c3"),
        call("read", "c4"),
        call("read", "c5"),
        call("shell", "c6"),
        call("glob", "c7"),
      ]),
    ),
    [["c1", "c2"], ["c3"], ["c4", "c5"], ["c6"], ["c7"]],
  )

  // 本轮第一个就是独占 → 本轮只有它一个
  assert.deepEqual(namesOf(planToolRounds([call("write", "c1"), call("edit", "c2")])), [
    ["c1"],
    ["c2"],
  ])

  // 独占之后的共享只读进入新的一轮
  assert.deepEqual(
    namesOf(planToolRounds([call("write", "c1"), call("read", "c2"), call("read", "c3")])),
    [["c1"], ["c2", "c3"]],
  )

  // 未登记的工具名按独占处理，因此也会单独占一轮
  assert.deepEqual(
    namesOf(planToolRounds([call("read", "c1"), call("mcp__srv__do", "c2"), call("read", "c3")])),
    [["c1"], ["c2"], ["c3"]],
  )

  // 空批次
  assert.deepEqual(planToolRounds([]), [])
}

// ---------------------------------------------------------------------------
// 1. 共享只读并发，且每完成一个就立刻交出
// ---------------------------------------------------------------------------

async function testSharedCallsStreamAsTheyFinish(): Promise<void> {
  const calls: FakeCall[] = [
    { toolName: "read", toolCallId: "call-1" },
    { toolName: "grep", toolCallId: "call-2" },
    { toolName: "glob", toolCallId: "call-3" },
  ]
  const harness = makeHarness({ "call-1": 30, "call-2": 10 })

  const results = await harness.run(calls)

  // 三个调用都先启动（真的并发）；最快的一结束就被交出，不必等最慢的 call-1
  assert.deepEqual(harness.trace, [
    "start call-1",
    "start call-2",
    "start call-3",
    "end call-3",
    "got call-3",
    "end call-2",
    "got call-2",
    "end call-1",
    "got call-1",
  ])
  assert.equal(harness.peakConcurrency, 3)

  // 交出顺序 = 完成顺序，与接收顺序不同
  assert.deepEqual(results.map(textOf), ["call-3", "call-2", "call-1"])
}

// ---------------------------------------------------------------------------
// 2. 独占串行
// ---------------------------------------------------------------------------

async function testExclusiveCallsRunSerially(): Promise<void> {
  const calls: FakeCall[] = [
    { toolName: "write", toolCallId: "call-1" },
    { toolName: "edit", toolCallId: "call-2" },
    { toolName: "shell", toolCallId: "call-3" },
  ]
  const harness = makeHarness({ "call-1": 20, "call-2": 5 })

  const results = await harness.run(calls)

  // 下一个独占工具要等上一个结束（连交出都发生在下一个启动之前）
  assert.deepEqual(harness.trace, [
    "start call-1",
    "end call-1",
    "got call-1",
    "start call-2",
    "end call-2",
    "got call-2",
    "start call-3",
    "end call-3",
    "got call-3",
  ])
  assert.equal(harness.peakConcurrency, 1)
  assert.deepEqual(results.map(textOf), ["call-1", "call-2", "call-3"])
}

// ---------------------------------------------------------------------------
// 3. 共享只读工具正在运行 → 独占工具等待
// ---------------------------------------------------------------------------

async function testExclusiveWaitsForRunningShared(): Promise<void> {
  const calls: FakeCall[] = [
    { toolName: "read", toolCallId: "call-1" },
    { toolName: "read", toolCallId: "call-2" },
    { toolName: "write", toolCallId: "call-3" },
  ]
  const harness = makeHarness({ "call-1": 30, "call-2": 20 })

  const results = await harness.run(calls)

  // 两个读并发，等待期间已完成的 call-2 照常交出；写必须等它们都结束
  assert.deepEqual(harness.trace, [
    "start call-1",
    "start call-2",
    "end call-2",
    "got call-2",
    "end call-1",
    "got call-1",
    "start call-3",
    "end call-3",
    "got call-3",
  ])
  assert.equal(harness.peakConcurrency, 2)
  assert.deepEqual(results.map(textOf), ["call-2", "call-1", "call-3"])
}

// ---------------------------------------------------------------------------
// 4. 任一独占工具正在运行 → 之后的共享只读工具等待
// ---------------------------------------------------------------------------

async function testSharedAfterExclusiveWaits(): Promise<void> {
  const calls: FakeCall[] = [
    { toolName: "write", toolCallId: "call-1" },
    { toolName: "read", toolCallId: "call-2" },
    { toolName: "read", toolCallId: "call-3" },
  ]
  const harness = makeHarness({ "call-1": 25, "call-2": 20 })

  const results = await harness.run(calls)

  // 独占期间没有任何并发；之后的两个读重新并发
  assert.deepEqual(harness.trace, [
    "start call-1",
    "end call-1",
    "got call-1",
    "start call-2",
    "start call-3",
    "end call-3",
    "got call-3",
    "end call-2",
    "got call-2",
  ])
  assert.equal(harness.peakConcurrency, 2)
  assert.deepEqual(results.map(textOf), ["call-1", "call-3", "call-2"])
}

// ---------------------------------------------------------------------------
// 5. 混合批次
// ---------------------------------------------------------------------------

async function testMixedBatch(): Promise<void> {
  const calls: FakeCall[] = [
    { toolName: "read", toolCallId: "call-1" },
    { toolName: "grep", toolCallId: "call-2" },
    { toolName: "edit", toolCallId: "call-3" },
  ]
  const harness = makeHarness({ "call-1": 30, "call-2": 5 })

  const results = await harness.run(calls)

  // call-2 先完成先交出；edit 要等 call-1 结束后才开始
  assert.deepEqual(harness.trace, [
    "start call-1",
    "start call-2",
    "end call-2",
    "got call-2",
    "end call-1",
    "got call-1",
    "start call-3",
    "end call-3",
    "got call-3",
  ])
  assert.deepEqual(results.map(textOf), ["call-2", "call-1", "call-3"])
}

// ---------------------------------------------------------------------------
// 6. 空批次
// ---------------------------------------------------------------------------

async function testEmptyBatch(): Promise<void> {
  const harness = makeHarness()

  const results = await harness.run([])

  assert.deepEqual(results, [])
  assert.deepEqual(harness.trace, [])
}

// ---------------------------------------------------------------------------
// 7. 异常传播
// ---------------------------------------------------------------------------

async function testErrorPropagatesAfterDeliveredResults(): Promise<void> {
  const boom = new Error("执行失败")
  const calls: FakeCall[] = [
    { toolName: "read", toolCallId: "call-1" },
    { toolName: "read", toolCallId: "call-2" },
  ]
  const harness = makeHarness({ "call-1": 30 }, { "call-1": boom })

  const thrown = await harness.run(calls).then(
    () => undefined,
    (error: unknown) => error,
  )

  // call-2 已经交出；call-1 失败后异常传播给调用方（工具失败的正常表达是 ToolResult，
  // 抛出属于 Turn 级失败）
  assert.equal(thrown, boom)
  assert.deepEqual(harness.trace, [
    "start call-1",
    "start call-2",
    "end call-2",
    "got call-2",
    "end call-1",
  ])
}

// ---------------------------------------------------------------------------
// 8. 分组名单
// ---------------------------------------------------------------------------

function testScheduleGroups(): void {
  // 第 17 节「共享只读组」的所有成员
  for (const toolName of SHARED_READ_ONLY_TOOLS) {
    assert.equal(toolScheduleGroup(toolName), "shared", `${toolName} 应为共享只读`)
  }

  // 第 17 节「独占执行组」
  for (const toolName of [
    "write",
    "edit",
    "present",
    "shell",
    "terminal_open",
    "terminal_input",
    "terminal_close",
    "memory_write",
    "mcp_load_tools",
    "tool_search",
  ]) {
    assert.equal(toolScheduleGroup(toolName), "exclusive", `${toolName} 应为独占执行`)
  }

  // 未登记的工具名（含动态载入的 MCP Tool）按独占处理
  assert.equal(toolScheduleGroup("mcp__some_server__some_tool"), "exclusive")
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testPlanToolRounds()
  testScheduleGroups()
  await testSharedCallsStreamAsTheyFinish()
  await testExclusiveCallsRunSerially()
  await testExclusiveWaitsForRunningShared()
  await testSharedAfterExclusiveWaits()
  await testMixedBatch()
  await testEmptyBatch()
  await testErrorPropagatesAfterDeliveredResults()
  console.log("tool-scheduler.test.ts: 调度断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
