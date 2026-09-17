/**
 * AgentLoop 最小循环测试（TODOList 阶段 6.1）。
 *
 * 用「按脚本产出统一流事件的假 Adapter」验证 AgentLoop 的事件创建与 Step 边界，
 * 不碰网络、不依赖测试框架。运行：
 *   node --experimental-strip-types runtime/agent/test/loop.test.ts
 *
 * 断言包在 async main() 里而非顶层 await：测试被 Node 当作 ESM 运行，
 * 但 tsc 按 CommonJS 检查，顶层 await 在后者不合法。
 *
 * 覆盖：正常完成、Tool Call（工具小轮未实现）、未结束的 tool_call 不进入消息、
 *       用户取消、Adapter 抛错、请求构建（content / tools / model 原样透传）。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 8.4 / 8.5 / 8.9 节、第 11.4 节、
 *          第 13.3 节、第 14 节
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
  AssistantMessageEventInput,
  SessionEventInput,
  StepEndEventInput,
  StepStartEventInput,
} from "../../session/src/events.ts"
import { runAgentLoop } from "../src/loop.ts"

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 本测试使用的模型引用；假 Adapter 不做一致性校验，与真实 Adapter 无关。 */
const MODEL: ModelRef = { providerId: "provider-1", protocol: "anthropic_messages", modelId: "model-1" }

/** 收集 AgentLoop 写出的待写入事件。 */
function collector(): { events: SessionEventInput[]; appendEvent: AppendSessionEvent } {
  const events: SessionEventInput[] = []
  return {
    events,
    appendEvent: async (event) => {
      events.push(event)
    },
  }
}

/** 按脚本产出统一流事件的假 Adapter。 */
function adapterFrom(
  stream: (request: UnifiedModelRequest, signal: AbortSignal) => AsyncIterable<ModelStreamEvent>,
): ModelAdapter {
  return { stream }
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
// 正常完成
// ---------------------------------------------------------------------------

async function testCompletedStep(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "打个招呼" },
  ]
  const tools: UnifiedToolDefinition[] = []
  const usage: Usage = { inputTokens: 120, outputTokens: 8, totalTokens: 128 }
  const { events, appendEvent } = collector()
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

  // 同一个块的 Start / Delta / End 使用同一个 blockId，block 之间的 blockId 不同（第 8.4 节）
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
  assert.equal(result.toolCalls.length, 0)
}

// ---------------------------------------------------------------------------
// Tool Call：工具小轮未实现，一个 Turn 只有一个 Step
// ---------------------------------------------------------------------------

async function testToolCallsWithoutToolRound(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "读一下 a.ts" },
  ]
  const { events, appendEvent } = collector()

  const adapter = adapterFrom(async function* (): AsyncGenerator<ModelStreamEvent> {
    yield blockStart(0, "text")
    yield textDelta(0, "我来读")
    yield blockEnd(0, { type: "text", text: "我来读" })
    yield blockStart(1, "tool_call")
    yield toolCallDelta(1, "call-1", "read_file")
    yield toolCallDelta(1, "call-1", undefined, '{"path":"a.ts"}')
    yield blockEnd(1, {
      type: "tool_call",
      toolCallId: "call-1",
      name: "read_file",
      arguments: { path: "a.ts" },
    })
    yield streamEnd("tool_calls", undefined, "tool_use")
  })

  const result = await runAgentLoop({
    turn: 1,
    model: MODEL,
    adapter,
    content,
    tools: [],
    signal: new AbortController().signal,
    appendEvent,
  })

  // 工具小轮（TODOList 6.4）未实现：不进入第二个 Step，也不写 tool/result
  assert.equal(eventTypes(events).filter((type) => type === "step/start").length, 1)
  assert.equal(eventTypes(events).filter((type) => type === "step/end").length, 1)
  assert.equal(only(events, "step/end").reason, "completed")

  assert.equal(result.completion, "tool_calls")
  assert.equal(result.toolCalls.length, 1)
  const toolCall = result.toolCalls[0]
  assert.equal(toolCall?.turn, 1)
  assert.equal(toolCall?.step, 1)
  assert.equal(typeof toolCall?.blockId, "string")
  assert.deepEqual(toolCall?.block, {
    type: "tool_call",
    toolCallId: "call-1",
    name: "read_file",
    arguments: { path: "a.ts" },
  })

  // blockId 与该 tool_call 块的 block_end 事件一致
  const toolCallBlockEnd = events.filter(
    (event) => event.type === "assistant/block_end" && event.index === 1,
  )
  assert.equal(toolCallBlockEnd.length, 1)
  assert.equal(toolCall?.blockId, (toolCallBlockEnd[0] as { blockId: string }).blockId)
  assert.deepEqual(
    (toolCallBlockEnd[0] as { block: AssistantContentBlock }).block,
    toolCall?.block,
  )
}

// ---------------------------------------------------------------------------
// 未结束的 tool_call 不进入 assistant/message
// ---------------------------------------------------------------------------

async function testUnfinishedToolCall(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "读一下 a.ts" },
  ]
  const { events, appendEvent } = collector()

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
    signal: new AbortController().signal,
    appendEvent,
  })

  // 没有 block_end 的块不进消息，也不被当作待执行工具调用（第 8.5 节）
  assert.deepEqual(only(events, "assistant/message").message.content, [])
  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.completion, "unknown")

  // 空内容的消息不追加到 content
  assert.equal(content.length, 2)
}

// ---------------------------------------------------------------------------
// 用户取消
// ---------------------------------------------------------------------------

async function testUserStop(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "讲个长故事" },
  ]
  const { events, appendEvent } = collector()
  const controller = new AbortController()

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

  // 未完成的消息不进入 content
  assert.equal(content.length, 2)
}

// ---------------------------------------------------------------------------
// Adapter 抛错
// ---------------------------------------------------------------------------

async function testModelError(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "你好" },
  ]
  const { events, appendEvent } = collector()
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
  assert.equal(content.length, 2)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testCompletedStep()
  await testToolCallsWithoutToolRound()
  await testUnfinishedToolCall()
  await testUserStop()
  await testModelError()
  console.log("loop.test.ts: AgentLoop 断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
