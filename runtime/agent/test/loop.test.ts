/**
 * AgentLoop 循环测试（TODOList 阶段 6.1 正常模型请求 + 6.4 Tool Call 小轮接线）。
 *
 * 用「按脚本产出统一流事件的假 Adapter」与「按脚本返回 ToolResult 的假工具入口」驱动
 * `runAgentLoop`，不碰网络、不依赖测试框架，也不实现任何真实工具。运行：
 *   node --experimental-strip-types runtime/agent/test/loop.test.ts
 *
 * 断言包在 async main() 里而非顶层 await：测试被 Node 当作 ESM 运行，
 * 但 tsc 按 CommonJS 检查，顶层 await 在后者不合法。
 *
 * 覆盖：
 *   1. 正常完成：事件顺序、blockId 一致性、assistant/message 内容与 Usage、content 原地更新
 *   2. Tool Call 小轮：两个调用（一个成功、一个失败）的执行、tool/result 关联、工具结果消息、进入下一 Step
 *   3. 未结束的 tool_call 不进消息、不执行工具
 *   4. 用户取消：模型流取消、工具小轮期间取消
 *   5. Adapter 抛错
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 8.4 / 8.5 / 8.6 / 8.9 节、第 11.3 / 11.4 节、
 *          第 13.3 节、第 14 节、第 16.4 / 16.5 节
 */

import assert from "node:assert/strict"

import { createAbortError } from "../../error/src/abort.ts"
import type { AppError } from "../../error/src/types.ts"
import type {
  AssistantContentBlock,
  BlockType,
  ModelAdapter,
  ModelCompletion,
  ModelMessage,
  ModelRef,
  ModelStreamEvent,
  UnifiedModelRequest,
  UnifiedToolDefinition,
  Usage,
} from "../../model/src/types.ts"
import type {
  AppendSessionEvent,
  AssistantBlockEndEventInput,
  AssistantMessageEventInput,
  SessionEventInput,
  StepEndEventInput,
  StepStartEventInput,
} from "../../session/src/events.ts"
import type { ToolResult } from "../../tools/src/types.ts"
import { runAgentLoop } from "../src/loop.ts"
import type { ExecuteToolCall } from "../src/loop.ts"

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 本测试使用的模型引用；假 Adapter 不做一致性校验，与真实 Adapter 无关。 */
const MODEL: ModelRef = { providerId: "provider-1", protocol: "anthropic_messages", modelId: "model-1", name: "claude-test" }

const SESSION_ID = "session-1"

/**
 * 收集 AgentLoop 写出的待写入事件，并像 SessionEventLog 一样补上身份字段后返回。
 *
 * eventId 用 `event-N` 顺序编号，便于断言 `tool/result.toolCallEventId` 指向哪条 block_end。
 */
function collector(): { events: SessionEventInput[]; appendEvent: AppendSessionEvent } {
  const events: SessionEventInput[] = []
  const appendEvent: AppendSessionEvent = async (event) => {
    events.push(event)
    return {
      eventId: `event-${events.length}`,
      sessionId: SESSION_ID,
      seq: events.length,
      createdAt: "2026-09-17T00:00:00.000Z",
      ...event,
    }
  }
  return { events, appendEvent }
}

/** 记录收到的工具调用并返回脚本结果的假工具入口。 */
function toolSpy(script: ToolResult[]): {
  calls: { name: string; args: unknown; turn: number; step: number; blockId: string; toolCallId: string }[]
  executeTool: ExecuteToolCall
} {
  const calls: { name: string; args: unknown; turn: number; step: number; blockId: string; toolCallId: string }[] = []
  return {
    calls,
    executeTool: async (name, args, context) => {
      calls.push({
        name,
        args,
        turn: context.turn,
        step: context.step,
        blockId: context.blockId,
        toolCallId: context.toolCallId,
      })
      const result = script.shift()
      assert.ok(result !== undefined, "假工具入口收到了超出脚本数量的调用")
      return result
    },
  }
}

/** 按脚本产出统一流事件的假 Adapter。 */
function adapterFrom(
  stream: (request: UnifiedModelRequest, signal: AbortSignal) => AsyncIterable<ModelStreamEvent>,
): ModelAdapter {
  return { stream }
}

/**
 * 按请求顺序消费多个脚本的假 Adapter；调用次数超出脚本数时断言失败。
 *
 * `seen` 记录每次请求本身与**当时**的消息角色快照 —— content 是被 Loop 原地修改的同一个数组，
 * 快照才能反映「这次请求实际带上了什么」。
 */
function adapterFromScripts(
  scripts: ModelStreamEvent[][],
  seen: { request: UnifiedModelRequest; roles: string[] }[],
): ModelAdapter {
  return adapterFrom(async function* (request): AsyncGenerator<ModelStreamEvent> {
    seen.push({ request, roles: request.context.messages.map((message) => message.role) })
    const script = scripts.shift()
    assert.ok(script !== undefined, "假 Adapter 收到了超出脚本数量的请求")
    for (const event of script) yield event
  })
}

function eventTypes(events: SessionEventInput[]): string[] {
  return events.map((event) => event.type)
}

/** 只保留块事件的 blockId，便于断言同一个块的 blockId 一致。 */
function blockIds(events: SessionEventInput[]): string[] {
  return events.flatMap((event) =>
    event.type === "assistant/block_start" ||
    event.type === "assistant/block_delta" ||
    event.type === "assistant/block_end"
      ? [event.blockId]
      : [],
  )
}

function blockStart(index: number, blockType: BlockType): ModelStreamEvent {
  return { type: "block_start", index, blockType }
}

function thinkingDelta(index: number, text: string): ModelStreamEvent {
  return { type: "block_delta", index, delta: { type: "thinking", text } }
}

function textDelta(index: number, text: string): ModelStreamEvent {
  return { type: "block_delta", index, delta: { type: "text", text } }
}

function toolCallDelta(
  index: number,
  toolCallId: string,
  nameDelta?: string,
  argumentsDelta?: string,
): ModelStreamEvent {
  return {
    type: "block_delta",
    index,
    delta: {
      type: "tool_call",
      toolCallId,
      ...(nameDelta === undefined ? {} : { nameDelta }),
      ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
    },
  }
}

function blockEnd(index: number, block: AssistantContentBlock): ModelStreamEvent {
  return { type: "block_end", index, block }
}

function streamEnd(completion: ModelCompletion, usage?: Usage, finishReason?: string): ModelStreamEvent {
  return {
    type: "stream_end",
    completion,
    ...(usage === undefined ? {} : { usage }),
    ...(finishReason === undefined ? {} : { finishReason }),
  }
}

function textResult(text: string): ToolResult {
  return { status: "success", content: [{ type: "text", text }] }
}

function errorResult(error: AppError, text: string): ToolResult {
  return { status: "error", content: [{ type: "text", text }], error }
}

/** block_end 事件，其 block 已收窄为 tool_call。 */
type ToolCallBlockEndEvent = AssistantBlockEndEventInput & {
  block: Extract<AssistantContentBlock, { type: "tool_call" }>
}

/** 取所有 tool_call 块的 block_end 事件（type 谓词，便于按 toolCallId 查找）。 */
function toolCallBlockEnds(events: SessionEventInput[]): ToolCallBlockEndEvent[] {
  return events.filter(
    (event): event is ToolCallBlockEndEvent =>
      event.type === "assistant/block_end" && event.block.type === "tool_call",
  )
}

/** 取唯一一条指定类型的事件，顺带断言它确实存在。 */
function only<T extends SessionEventInput["type"]>(
  events: SessionEventInput[],
  type: T,
): Extract<SessionEventInput, { type: T }> {
  const matched = events.filter((event) => event.type === type)
  assert.equal(matched.length, 1, `期望恰好一条 ${type}，实际 ${matched.length} 条`)
  return matched[0] as Extract<SessionEventInput, { type: T }>
}

// ---------------------------------------------------------------------------
// 1. 正常完成
// ---------------------------------------------------------------------------

async function testCompletedStep(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "打个招呼" },
  ]
  const tools: UnifiedToolDefinition[] = []
  const usage: Usage = { inputTokens: 120, outputTokens: 8, totalTokens: 128 }
  const { events, appendEvent } = collector()
  const { calls, executeTool } = toolSpy([])
  let seen: UnifiedModelRequest | undefined

  const adapter = adapterFrom(async function* (request): AsyncGenerator<ModelStreamEvent> {
    seen = request
    yield blockStart(0, "thinking")
    yield thinkingDelta(0, "想")
    yield blockEnd(0, { type: "thinking", text: "想" })
    yield blockStart(1, "text")
    yield textDelta(1, "你")
    yield textDelta(1, "好")
    yield blockEnd(1, { type: "text", text: "你好" })
    yield streamEnd("finished", usage, "end_turn")
  })

  const result = await runAgentLoop({
    turn: 2,
    model: MODEL,
    adapter,
    content,
    tools,
    executeTool,
    signal: new AbortController().signal,
    appendEvent,
  })

  assert.deepEqual(eventTypes(events), [
    "step/start",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/message",
    "step/end",
  ])

  // 请求构建：content / tools / model 原样交给 Adapter（第 11.4 节）
  assert.equal(seen?.context.messages, content)
  assert.equal(seen?.tools, tools)
  assert.deepEqual(seen?.model, MODEL)

  // Step 身份（第 8.2 节）：Turn 由调用方决定，Step 从 1 起
  const stepStart = events[0] as StepStartEventInput
  assert.equal(stepStart.turn, 2)
  assert.equal(stepStart.step, 1)
  const stepEnd = events[events.length - 1] as StepEndEventInput
  assert.equal(stepEnd.turn, 2)
  assert.equal(stepEnd.step, 1)
  assert.equal(stepEnd.reason, "completed")

  // 同一个块的 Start / Delta / End 使用同一个 blockId，块之间的 blockId 不同（第 8.4 节）
  const ids = blockIds(events)
  assert.equal(ids.length, 7)
  assert.equal(new Set(ids.slice(0, 3)).size, 1)
  assert.equal(new Set(ids.slice(3, 7)).size, 1)
  assert.notEqual(ids[0], ids[3])

  // 块顺序由 index 决定；block_start / block_end 带 index
  const starts = events.filter((event) => event.type === "assistant/block_start")
  assert.deepEqual(starts.map((event) => event.index), [0, 1])

  // assistant/message：只收录已结束的块，按 index 排序，携带权威 Usage 与结束原因（第 8.5 节）
  const message = only(events, "assistant/message") as AssistantMessageEventInput
  assert.equal(typeof message.message.id, "string")
  assert.equal(message.message.id.length > 0, true)
  assert.equal(message.message.role, "assistant")
  assert.deepEqual(message.message.content, [
    { type: "thinking", text: "想" },
    { type: "text", text: "你好" },
  ])
  assert.deepEqual(message.usage, usage)
  assert.equal(message.finishReason, "end_turn")
  assert.deepEqual(message.model, MODEL)

  // content 原地更新（第 13.3 节）
  assert.deepEqual(content[2], {
    role: "assistant",
    content: [
      { type: "thinking", text: "想" },
      { type: "text", text: "你好" },
    ],
  })

  assert.equal(result.stopped, false)
  assert.equal(result.steps, 1)
  assert.equal(result.completion, "finished")
  assert.deepEqual(result.usage, usage)
  assert.equal(result.finishReason, "end_turn")
  assert.equal(calls.length, 0)
}

// ---------------------------------------------------------------------------
// 2. Tool Call 小轮：一个成功、一个失败，随后进入下一 Step
// ---------------------------------------------------------------------------

async function testToolRound(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "读一下 a.ts，再删掉 b.ts" },
  ]
  const { events, appendEvent } = collector()
  const notFound: AppError = { source: "tool", code: "FILE_NOT_FOUND", message: "文件不存在" }
  const { calls, executeTool } = toolSpy([
    textResult("a.ts 的内容"),
    errorResult(notFound, "读取 b.ts 失败：文件不存在"),
  ])
  const requests: { request: UnifiedModelRequest; roles: string[] }[] = []

  const adapter = adapterFromScripts(
    [
      [
        blockStart(0, "text"),
        textDelta(0, "我先看看这两个文件"),
        blockEnd(0, { type: "text", text: "我先看看这两个文件" }),
        blockStart(1, "tool_call"),
        toolCallDelta(1, "call-1", "read_file"),
        toolCallDelta(1, "call-1", undefined, '{"path":"a.ts"}'),
        blockEnd(1, { type: "tool_call", toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }),
        blockStart(2, "tool_call"),
        toolCallDelta(2, "call-2", "read_file"),
        toolCallDelta(2, "call-2", undefined, '{"path":"b.ts"}'),
        blockEnd(2, { type: "tool_call", toolCallId: "call-2", name: "read_file", arguments: { path: "b.ts" } }),
        streamEnd("tool_calls", undefined, "tool_use"),
      ],
      [
        blockStart(0, "text"),
        textDelta(0, "a.ts 可以读，b.ts 不存在"),
        blockEnd(0, { type: "text", text: "a.ts 可以读，b.ts 不存在" }),
        streamEnd("finished", { inputTokens: 200, outputTokens: 12 }, "end_turn"),
      ],
    ],
    requests,
  )

  const result = await runAgentLoop({
    turn: 1,
    model: MODEL,
    adapter,
    content,
    tools: [],
    executeTool,
    signal: new AbortController().signal,
    appendEvent,
  })

  // 事件顺序：Step 1 的两个调用逐个写 tool/result，小轮结束后才写 step/end（第 13.3 节）
  assert.deepEqual(eventTypes(events), [
    "step/start",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/message",
    "tool/result",
    "tool/result",
    "step/end",
    "step/start",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/message",
    "step/end",
  ])

  // 工具执行：调用身份来自 tool_call 块，按模型给出的顺序逐个执行
  assert.deepEqual(calls, [
    { name: "read_file", args: { path: "a.ts" }, turn: 1, step: 1, blockId: "b-1-1-1", toolCallId: "call-1" },
    { name: "read_file", args: { path: "b.ts" }, turn: 1, step: 1, blockId: "b-1-1-2", toolCallId: "call-2" },
  ])

  // tool/result 关联 toolCallEventId（指向该块 block_end 的 eventId）/ toolCallId / blockId（第 8.6 节）
  // collector 把第 N 条事件命名为 `event-N`，所以 eventId 的编号就是事件下标 + 1。
  const toolResults = events.filter((event) => event.type === "tool/result")
  assert.equal(toolResults.length, 2)
  assert.deepEqual(
    toolResults.map((event) => {
      const blockEnd = toolCallBlockEnds(events).find(
        (candidate) => candidate.block.toolCallId === event.toolCallId,
      )
      assert.ok(blockEnd !== undefined, `找不到 ${event.toolCallId} 的 block_end`)
      return {
        toolCallId: event.toolCallId,
        blockId: event.blockId,
        status: event.result.status,
        toolCallEventId: event.toolCallEventId,
        blockEndEventId: `event-${events.indexOf(blockEnd) + 1}`,
        blockEndBlockId: blockEnd.blockId,
      }
    }),
    [
      {
        toolCallId: "call-1",
        blockId: "b-1-1-1",
        status: "success",
        toolCallEventId: "event-8",
        blockEndEventId: "event-8",
        blockEndBlockId: "b-1-1-1",
      },
      {
        toolCallId: "call-2",
        blockId: "b-1-1-2",
        status: "error",
        toolCallEventId: "event-12",
        blockEndEventId: "event-12",
        blockEndBlockId: "b-1-1-2",
      },
    ],
  )

  // 工具结果进入 content：只保留 text 内容块，isError 取 status（第 11.3、16.2 节）
  assert.deepEqual(content.slice(3), [
    { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "a.ts 的内容" }], isError: false },
    {
      role: "tool",
      toolCallId: "call-2",
      content: [{ type: "text", text: "读取 b.ts 失败：文件不存在" }],
      isError: true,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "a.ts 可以读，b.ts 不存在" }],
    },
  ])

  // 第二次请求带上了工具结果（工具结果必须交还模型）
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0]?.roles, ["system", "user"])
  assert.deepEqual(requests[1]?.roles, ["system", "user", "assistant", "tool", "tool"])
  assert.equal(requests[1]?.request.context.messages, content)

  assert.equal(result.steps, 2)
  assert.equal(result.completion, "finished")
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 12 })
  assert.equal(result.stopped, false)
}

// ---------------------------------------------------------------------------
// 2b. 整批交给调度器：共享只读调用真正并发，谁先完成谁先落盘
// ---------------------------------------------------------------------------

async function testToolRoundDelegatesToScheduler(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "读一下 a.ts 和 b.ts" },
  ]
  const { events, appendEvent } = collector()
  const requests: { request: UnifiedModelRequest; roles: string[] }[] = []

  const adapter = adapterFromScripts(
    [
      [
        blockStart(0, "tool_call"),
        toolCallDelta(0, "call-1", "read", '{"path":"a.ts"}'),
        blockEnd(0, { type: "tool_call", toolCallId: "call-1", name: "read", arguments: { path: "a.ts" } }),
        blockStart(1, "tool_call"),
        toolCallDelta(1, "call-2", "read", '{"path":"b.ts"}'),
        blockEnd(1, { type: "tool_call", toolCallId: "call-2", name: "read", arguments: { path: "b.ts" } }),
        streamEnd("tool_calls", undefined, "tool_use"),
      ],
      [
        blockStart(0, "text"),
        textDelta(0, "两个文件都读到了"),
        blockEnd(0, { type: "text", text: "两个文件都读到了" }),
        streamEnd("finished"),
      ],
    ],
    requests,
  )

  // 两个调用都是共享只读工具：第一个故意慢，用来观察并发与「完成即落盘」
  const trace: string[] = []
  const delays: Record<string, number> = { "call-1": 30, "call-2": 5 }
  const executeTool: ExecuteToolCall = async (_name, _args, context) => {
    trace.push(`start ${context.toolCallId}`)
    await new Promise<void>((resolve) => setTimeout(resolve, delays[context.toolCallId]))
    trace.push(`end ${context.toolCallId}`)
    return textResult(`${context.toolCallId} 的内容`)
  }

  // 每条 tool/result 写入时记一笔，和执行轨迹拼在一起看「完成即落盘」
  const loggingAppend: AppendSessionEvent = async (event) => {
    if (event.type === "tool/result") trace.push(`wrote ${event.toolCallId}`)
    return appendEvent(event)
  }

  await runAgentLoop({
    turn: 3,
    model: MODEL,
    adapter,
    content,
    tools: [],
    executeTool,
    signal: new AbortController().signal,
    appendEvent: loggingAppend,
  })

  // 两个共享只读调用都在对方结束前启动（调度确实发生在 runToolCalls 里，不是 AgentLoop 逐个 await），
  // 且每个调用一结束就写下了它的 tool/result —— 不必等慢的 call-1 结束（第 16.5 节）
  assert.deepEqual(trace, [
    "start call-1",
    "start call-2",
    "end call-2",
    "wrote call-2",
    "end call-1",
    "wrote call-1",
  ])

  // content 里工具结果消息同样按完成顺序追加，且与 toolCallId 正确配对（第 8.6、11.3 节）
  const toolResults = events.filter((event) => event.type === "tool/result")
  assert.deepEqual(toolResults.map((event) => event.toolCallId), ["call-2", "call-1"])
  assert.deepEqual(content.slice(2, 5), [
    { role: "assistant", content: [
      { type: "tool_call", toolCallId: "call-1", name: "read", arguments: { path: "a.ts" } },
      { type: "tool_call", toolCallId: "call-2", name: "read", arguments: { path: "b.ts" } },
    ] },
    { role: "tool", toolCallId: "call-2", content: [{ type: "text", text: "call-2 的内容" }], isError: false },
    { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "call-1 的内容" }], isError: false },
  ])
}

// ---------------------------------------------------------------------------
// 3. 未结束的 tool_call 不进入消息，也不执行
// ---------------------------------------------------------------------------

async function testUnfinishedToolCall(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "读一下 a.ts" },
  ]
  const { events, appendEvent } = collector()
  const { calls, executeTool } = toolSpy([])

  const adapter = adapterFrom(async function* (): AsyncGenerator<ModelStreamEvent> {
    yield blockStart(0, "tool_call")
    yield toolCallDelta(0, "call-1", "read_file", '{"path":')
    yield streamEnd("unknown")
  })

  const result = await runAgentLoop({
    turn: 1,
    model: MODEL,
    adapter,
    content,
    tools: [],
    executeTool,
    signal: new AbortController().signal,
    appendEvent,
  })

  // 没有 block_end 的块不进 assistant/message，也不被当作待执行调用（第 8.5 节）
  assert.deepEqual(only(events, "assistant/message").message.content, [])
  assert.equal(eventTypes(events).includes("tool/result"), false)
  assert.equal(calls.length, 0)
  assert.equal(result.completion, "unknown")
  assert.equal(result.steps, 1)

  // 空内容的消息不追加到 content
  assert.equal(content.length, 2)
}

// ---------------------------------------------------------------------------
// 4. 用户取消
// ---------------------------------------------------------------------------

async function testUserStopDuringModelStream(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "讲个长故事" },
  ]
  const { events, appendEvent } = collector()
  const controller = new AbortController()
  const { calls, executeTool } = toolSpy([])

  // 真实 Adapter 在取消时抛出的就是取消类错误（经 runModelStream 归一化）。
  const adapter = adapterFrom(async function* (): AsyncGenerator<ModelStreamEvent> {
    yield blockStart(0, "text")
    yield textDelta(0, "很久")
    controller.abort()
    throw createAbortError()
  })

  const result = await runAgentLoop({
    turn: 4,
    model: MODEL,
    adapter,
    content,
    tools: [],
    executeTool,
    signal: controller.signal,
    appendEvent,
  })

  // 已开始的 Step 以 stopped 关闭（第 14 节）；取消不是错误，不写 assistant/message
  assert.deepEqual(eventTypes(events), [
    "step/start",
    "assistant/block_start",
    "assistant/block_delta",
    "step/end",
  ])
  assert.equal(only(events, "step/end").reason, "stopped")
  assert.equal(result.stopped, true)
  assert.equal(result.steps, 1)
  assert.equal(result.completion, undefined)
  assert.equal(calls.length, 0)

  // 未完成的消息不进入 content
  assert.equal(content.length, 2)
}

async function testUserStopDuringToolRound(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "跑一下两个命令" },
  ]
  const { events, appendEvent } = collector()
  const controller = new AbortController()
  const cancelled: AppError = { source: "tool", code: "CANCELLED", message: "工具调用已取消" }
  const requests: { request: UnifiedModelRequest; roles: string[] }[] = []

  const adapter = adapterFromScripts(
    [
      [
        blockStart(0, "tool_call"),
        toolCallDelta(0, "call-1", "shell", '{"command":"a"}'),
        blockEnd(0, { type: "tool_call", toolCallId: "call-1", name: "shell", arguments: { command: "a" } }),
        blockStart(1, "tool_call"),
        toolCallDelta(1, "call-2", "shell", '{"command":"b"}'),
        blockEnd(1, { type: "tool_call", toolCallId: "call-2", name: "shell", arguments: { command: "b" } }),
        streamEnd("tool_calls", undefined, "tool_use"),
      ],
    ],
    requests,
  )

  // 第一次调用发现已被取消，第二次调用尚未启动便返回 CANCELLED（第 14、16.4 节）。
  const executeTool: ExecuteToolCall = async (name, args, context) => {
    if (context.toolCallId === "call-1") controller.abort()
    return errorResult(cancelled, `工具 ${name} 未执行：已取消`)
  }

  const result = await runAgentLoop({
    turn: 7,
    model: MODEL,
    adapter,
    content,
    tools: [],
    executeTool,
    signal: controller.signal,
    appendEvent,
  })

  // 小轮仍然为每个调用写 tool/result，Step 以 stopped 关闭，且不再发起下一次模型请求
  assert.deepEqual(eventTypes(events), [
    "step/start",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/message",
    "tool/result",
    "tool/result",
    "step/end",
  ])
  assert.equal(only(events, "step/end").reason, "stopped")
  assert.equal(requests.length, 1)
  assert.equal(result.stopped, true)
  assert.equal(result.steps, 1)
  assert.equal(
    events.filter((event) => event.type === "tool/result").every((event) => event.result.status === "error"),
    true,
  )
}

// ---------------------------------------------------------------------------
// 5. Adapter 抛错
// ---------------------------------------------------------------------------

async function testModelError(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "你好" },
  ]
  const { events, appendEvent } = collector()
  const { calls, executeTool } = toolSpy([])
  const modelError: AppError = { source: "model", code: "REQUEST_FAILED", message: "boom" }

  const adapter = adapterFrom(async function* (): AsyncGenerator<ModelStreamEvent> {
    yield blockStart(0, "text")
    throw modelError
  })

  const thrown = await runAgentLoop({
    turn: 5,
    model: MODEL,
    adapter,
    content,
    tools: [],
    executeTool,
    signal: new AbortController().signal,
    appendEvent,
  }).then(
    () => undefined,
    (error: unknown) => error,
  )

  // 错误原样抛出（Turn 的收尾与 app/error 由调用方负责），Step 以 error 关闭
  assert.deepEqual(thrown, modelError)
  assert.deepEqual(eventTypes(events), ["step/start", "assistant/block_start", "step/end"])
  assert.equal(only(events, "step/end").reason, "error")
  assert.equal(calls.length, 0)
  assert.equal(content.length, 2)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testCompletedStep()
  await testToolRound()
  await testToolRoundDelegatesToScheduler()
  await testUnfinishedToolCall()
  await testUserStopDuringModelStream()
  await testUserStopDuringToolRound()
  await testModelError()
  console.log("loop.test.ts: AgentLoop 断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
