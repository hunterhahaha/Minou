/**
 * 使用脚本模型流、内存事件收集器和假工具验证 AgentLoop。
 *
 * 覆盖 Step 事件与块身份、完整消息及 Usage、工具调度与结果回填、取消收尾和错误传播。
 * 脚本 Adapter 不访问模型服务，假工具不执行真实业务；main 按顺序调用各断言场景。
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

/**
 * 辅助
 */

/** 本测试使用的模型引用；假 Adapter 不做一致性校验，与真实 Adapter 无关。 */
const MODEL: ModelRef = { providerId: "provider-1", protocol: "anthropic_messages", modelId: "model-1", name: "claude-test", reasoningLevel: "medium" }

const SESSION_ID = "session-1"

/**
 * 创建内存事件收集器，按写入顺序补充事件身份并保存待写入事件。
 * @returns 事件记录数组及补充身份的异步事件追加函数。
 */
function collector(): { events: SessionEventInput[]; appendEvent: AppendSessionEvent } {
  const events: SessionEventInput[] = []
  /**
   * 收集待写入事件并补充确定性的身份字段，不访问磁盘。
   * @param event Loop 交出的事件输入。
   * @returns 带顺序事件 ID、序号和固定时间的完整事件。
   */
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

/**
 * 创建按脚本依次返回结果的假工具入口，并记录每次调用的名称、参数及身份。
 * @param script 按调用顺序消耗的工具结果数组，调用会移除队首结果。
 * @returns 调用记录数组与按脚本返回结果的工具执行函数。
 */
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

/**
 * 将注入的统一事件流函数包装为假模型 Adapter，不创建网络客户端。
 * @param stream 接收模型请求与取消信号并产出统一流事件的脚本函数。
 * @returns 仅使用注入 stream 函数的模型 Adapter。
 */
function adapterFrom(
  stream: (request: UnifiedModelRequest, signal: AbortSignal) => AsyncIterable<ModelStreamEvent>,
): ModelAdapter {
  return { stream }
}

/**
 * 按请求顺序消费响应脚本，并记录请求引用及当时的消息角色快照。
 * @param scripts 按模型请求顺序消耗的事件脚本数组。
 * @param seen 接收请求引用与消息角色快照的可变记录数组。
 * @returns 每次请求消费一个脚本的模型 Adapter。
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

/**
 * 按事件原顺序提取类型，供事件生命周期顺序断言使用。
 * @param events 待提取或筛选的 Session 事件数组。
 * @returns 与输入顺序一致的事件类型数组。
 */
function eventTypes(events: SessionEventInput[]): string[] {
  return events.map((event) => event.type)
}

/**
 * 提取块起始、增量和结束事件的 blockId，保留事件顺序和重复身份。
 * @param events 待提取或筛选的 Session 事件数组。
 * @returns 仅包含块事件身份的数组。
 */
function blockIds(events: SessionEventInput[]): string[] {
  return events.flatMap((event) =>
    event.type === "assistant/block_start" ||
    event.type === "assistant/block_delta" ||
    event.type === "assistant/block_end"
      ? [event.blockId]
      : [],
  )
}

/**
 * 构造指定索引与类型的模型块起始事件。
 * @param index 当前模型响应中的块索引。
 * @param blockType 要开始的模型内容块类型。
 * @returns 块起始事件。
 */
function blockStart(index: number, blockType: BlockType): ModelStreamEvent {
  return { type: "block_start", index, blockType }
}

/**
 * 构造指定块的思考文本增量事件。
 * @param index 当前模型响应中的块索引。
 * @param text 写入事件或工具结果的文本。
 * @returns 思考文本增量事件。
 */
function thinkingDelta(index: number, text: string): ModelStreamEvent {
  return { type: "block_delta", index, delta: { type: "thinking", text } }
}

/**
 * 构造指定块的普通文本增量事件。
 * @param index 当前模型响应中的块索引。
 * @param text 写入事件或工具结果的文本。
 * @returns 普通文本增量事件。
 */
function textDelta(index: number, text: string): ModelStreamEvent {
  return { type: "block_delta", index, delta: { type: "text", text } }
}

/**
 * 构造工具调用增量事件；未提供的名称及参数增量保持缺失。
 * @param index 当前模型响应中的块索引。
 * @param toolCallId 用于关联工具结果的调用 ID。
 * @param nameDelta 可选的工具名称增量。
 * @param argumentsDelta 可选的工具参数字符串增量。
 * @returns 带调用 ID 及已提供增量的工具调用事件。
 */
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

/**
 * 构造携带完整块内容的模型块结束事件。
 * @param index 当前模型响应中的块索引。
 * @param block 模型已完整返回的内容块。
 * @returns 携带完整内容的块结束事件。
 */
function blockEnd(index: number, block: AssistantContentBlock): ModelStreamEvent {
  return { type: "block_end", index, block }
}

/**
 * 构造模型流结束事件；未提供的 Usage 与协议结束原因保持缺失。
 * @param completion 本次模型流的统一完成状态。
 * @param usage 可选的权威 Usage。
 * @param finishReason 可选的协议原始结束原因。
 * @returns 携带完成状态和已提供统计的流结束事件。
 */
function streamEnd(completion: ModelCompletion, usage?: Usage, finishReason?: string): ModelStreamEvent {
  return {
    type: "stream_end",
    completion,
    ...(usage === undefined ? {} : { usage }),
    ...(finishReason === undefined ? {} : { finishReason }),
  }
}

/**
 * 构造仅包含一个文本块的成功工具结果。
 * @param text 写入事件或工具结果的文本。
 * @returns 成功的文本工具结果。
 */
function textResult(text: string): ToolResult {
  return { status: "success", content: [{ type: "text", text }] }
}

/**
 * 构造携带原始 AppError 与模型可见文本的失败工具结果。
 * @param error 随失败结果保留的结构化错误。
 * @param text 写入事件或工具结果的文本。
 * @returns 失败的文本工具结果。
 */
function errorResult(error: AppError, text: string): ToolResult {
  return { status: "error", content: [{ type: "text", text }], error }
}

/** block_end 事件，其 block 已收窄为 tool_call。 */
type ToolCallBlockEndEvent = AssistantBlockEndEventInput & {
  block: Extract<AssistantContentBlock, { type: "tool_call" }>
}

/**
 * 筛选完整工具调用的块结束事件，并将结果类型收窄为工具调用块。
 * @param events 待提取或筛选的 Session 事件数组。
 * @returns 按日志顺序排列的完整工具调用块结束事件。
 */
function toolCallBlockEnds(events: SessionEventInput[]): ToolCallBlockEndEvent[] {
  return events.filter(
    (event): event is ToolCallBlockEndEvent =>
      event.type === "assistant/block_end" && event.block.type === "tool_call",
  )
}

/**
 * 取得唯一一条指定类型的事件，匹配数量不为一时断言失败。
 * @param events 待提取或筛选的 Session 事件数组。
 * @param type 期望唯一出现的事件类型。
 * @returns 类型已收窄的唯一匹配事件。
 * @throws AssertionError 匹配事件数量不为一时抛出。
 */
function only<T extends SessionEventInput["type"]>(
  events: SessionEventInput[],
  type: T,
): Extract<SessionEventInput, { type: T }> {
  const matched = events.filter((event) => event.type === type)
  assert.equal(matched.length, 1, `期望恰好一条 ${type}，实际 ${matched.length} 条`)
  return matched[0] as Extract<SessionEventInput, { type: T }>
}

/**
 * 1. 正常完成
 */

/**
 * 验证正常响应的事件顺序、块身份、消息内容、Usage 以及内存上下文追加。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
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

  /**
   * 请求构建：content / tools / model 原样交给 Adapter
   */
  assert.equal(seen?.context.messages, content)
  assert.equal(seen?.tools, tools)
  assert.deepEqual(seen?.model, MODEL)

  /**
   * Step 身份：Turn 由调用方决定，Step 从 1 起
   */
  const stepStart = events[0] as StepStartEventInput
  assert.equal(stepStart.turn, 2)
  assert.equal(stepStart.step, 1)
  const stepEnd = events[events.length - 1] as StepEndEventInput
  assert.equal(stepEnd.turn, 2)
  assert.equal(stepEnd.step, 1)
  assert.equal(stepEnd.reason, "completed")

  /**
   * 同一个块的 Start / Delta / End 使用同一个 blockId，块之间的 blockId 不同
   */
  const ids = blockIds(events)
  assert.equal(ids.length, 7)
  assert.equal(new Set(ids.slice(0, 3)).size, 1)
  assert.equal(new Set(ids.slice(3, 7)).size, 1)
  assert.notEqual(ids[0], ids[3])

  /**
   * 块顺序由 index 决定；block_start / block_end 带 index
   */
  const starts = events.filter((event) => event.type === "assistant/block_start")
  assert.deepEqual(starts.map((event) => event.index), [0, 1])

  /**
   * assistant/message：只收录已结束的块，按 index 排序，携带权威 Usage 与结束原因
   */
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

  /**
   * content 原地更新
   */
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

/**
 * 2. Tool Call 小轮：一个成功、一个失败，随后进入下一 Step
 */

/**
 * 验证成功与失败工具结果的事件关联、文本回填和后续 Step 请求。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
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

  /**
   * 事件顺序：Step 1 的两个调用逐个写 tool/result，小轮结束后才写 step/end
   */
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

  /**
   * 工具执行：调用身份来自 tool_call 块，按模型给出的顺序逐个执行
   */
  assert.deepEqual(calls, [
    { name: "read_file", args: { path: "a.ts" }, turn: 1, step: 1, blockId: "b-1-1-1", toolCallId: "call-1" },
    { name: "read_file", args: { path: "b.ts" }, turn: 1, step: 1, blockId: "b-1-1-2", toolCallId: "call-2" },
  ])

  /**
   * tool/result 关联 toolCallEventId（指向该块 block_end 的 eventId）/ toolCallId / blockId
   * collector 把第 N 条事件命名为 `event-N`，所以 eventId 的编号就是事件下标 + 1。
   */
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

  /**
   * 工具结果进入 content：只保留 text 内容块，isError 取 status
   */
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

  /**
   * 第二次请求带上了工具结果（工具结果必须交还模型）
   */
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0]?.roles, ["system", "user"])
  assert.deepEqual(requests[1]?.roles, ["system", "user", "assistant", "tool", "tool"])
  assert.equal(requests[1]?.request.context.messages, content)

  assert.equal(result.steps, 2)
  assert.equal(result.completion, "finished")
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 12 })
  assert.equal(result.stopped, false)
}

/**
 * 2b. 整批交给调度器：共享只读调用真正并发，谁先完成谁先落盘
 */

/**
 * 通过一慢一快的共享只读工具，验证调度并发及按完成顺序提交结果。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
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

  /**
   * 两个调用都是共享只读工具：第一个故意慢，用来观察并发与「完成即落盘」
   */
  const trace: string[] = []
  const delays: Record<string, number> = { "call-1": 30, "call-2": 5 }
  const executeTool: ExecuteToolCall = async (_name, _args, context) => {
    trace.push(`start ${context.toolCallId}`)
    await new Promise<void>((resolve) => setTimeout(resolve, delays[context.toolCallId]))
    trace.push(`end ${context.toolCallId}`)
    return textResult(`${context.toolCallId} 的内容`)
  }

  /**
   * 记录工具结果落盘的观测顺序，再委托内存收集器追加事件。
   * @param event 当前要记录的 Loop 事件。
   * @returns 收集器补充身份后的事件。
   */
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

  /**
   * 两个共享只读调用都在对方结束前启动（调度确实发生在 runToolCalls 里，不是 AgentLoop 逐个 await），
   * 且每个调用一结束就写下了它的 tool/result —— 不必等慢的 call-1 结束
   */
  assert.deepEqual(trace, [
    "start call-1",
    "start call-2",
    "end call-2",
    "wrote call-2",
    "end call-1",
    "wrote call-1",
  ])

  /**
   * content 里工具结果消息同样按完成顺序追加，且与 toolCallId 正确配对
   */
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

/**
 * 3. 未结束的 tool_call 不进入消息，也不执行
 */

/**
 * 验证未收到块结束事件的工具调用不会进入完整消息或触发执行。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
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

  /**
   * 没有 block_end 的块不进 assistant/message，也不被当作待执行调用
   */
  assert.deepEqual(only(events, "assistant/message").message.content, [])
  assert.equal(eventTypes(events).includes("tool/result"), false)
  assert.equal(calls.length, 0)
  assert.equal(result.completion, "unknown")
  assert.equal(result.steps, 1)

  /**
   * 空内容的消息不追加到 content
   */
  assert.equal(content.length, 2)
}

/**
 * 4. 用户取消
 */

/**
 * 验证模型流取消时关闭已开始的 Step，并向调用方返回停止状态。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function testUserStopDuringModelStream(): Promise<void> {
  const content: ModelMessage[] = [
    { role: "system", content: "系统设定" },
    { role: "user", content: "讲个长故事" },
  ]
  const { events, appendEvent } = collector()
  const controller = new AbortController()
  const { calls, executeTool } = toolSpy([])

  /**
   * 真实 Adapter 在取消时抛出的就是取消类错误（经 runModelStream 归一化）。
   */
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

  /** 先收尾已提交文本和消息，再以 stopped 关闭 Step；取消不伪造 Usage。 */
  assert.deepEqual(eventTypes(events), [
    "step/start",
    "assistant/block_start",
    "assistant/block_delta",
    "assistant/block_end",
    "assistant/message",
    "step/end",
  ])
  assert.deepEqual(only(events, "assistant/block_end").block, { type: "text", text: "很久" })
  assert.deepEqual(only(events, "assistant/message").message.content, [{ type: "text", text: "很久" }])
  assert.equal(only(events, "assistant/message").usage, undefined)
  assert.equal(only(events, "assistant/message").finishReason, undefined)
  assert.equal(only(events, "step/end").reason, "stopped")
  assert.equal(result.stopped, true)
  assert.equal(result.steps, 1)
  assert.equal(result.completion, undefined)
  assert.equal(calls.length, 0)

  /**
   * 未完成的消息不进入 content
   */
  assert.equal(content.length, 2)
}

/**
 * 验证取消只收尾文本/思考，保留已结束块且按 index 组装消息；未结束工具参数不补猜。
 * @returns 抛出取消错误和取消后正常结束流的两种路径均验证完成后解析。
 * @throws AssertionError 当消息顺序、块身份、取消状态或工具调用边界不符合契约时抛出。
 */
async function testStopClosesOnlyTextBlocks(): Promise<void> {
  for (const throwOnAbort of [true, false]) {
    const { events, appendEvent } = collector()
    const controller = new AbortController()
    const { calls, executeTool } = toolSpy([])
    const result = await runAgentLoop({
      turn: 1, model: MODEL, content: [], tools: [], executeTool, signal: controller.signal, appendEvent,
      adapter: adapterFrom(async function* () {
        yield blockStart(2, "text")
        yield textDelta(2, "回答")
        yield blockStart(0, "thinking")
        yield { type: "block_delta", index: 0, delta: { type: "thinking", text: "思考" } }
        yield { type: "block_delta", index: 0, delta: { type: "thinking", text: "中" } }
        yield blockStart(1, "text")
        yield blockEnd(1, { type: "text", text: "已结束" })
        yield blockStart(3, "tool_call")
        yield toolCallDelta(3, "partial", "read", '{"path":')
        controller.abort()
        if (throwOnAbort) throw createAbortError()
      }),
    })
    const ends = events.filter((event) => event.type === "assistant/block_end")
    assert.deepEqual(ends.map((event) => event.index).sort(), [0, 1, 2])
    assert.ok(ends.every((event) => event.blockId === `b-1-1-${event.index}`))
    assert.deepEqual(only(events, "assistant/message").message.content, [
      { type: "thinking", text: "思考中" }, { type: "text", text: "已结束" }, { type: "text", text: "回答" },
    ])
    assert.deepEqual(eventTypes(events).slice(-2), ["assistant/message", "step/end"])
    assert.equal(only(events, "step/end").reason, "stopped")
    assert.equal(result.stopped, true)
    assert.equal(calls.length, 0)
  }
}

/**
 * 验证模型流取消前已经提交的工具调用得到 CANCELLED 结果，再关闭 Step。
 * @returns 工具结果关联与关闭顺序均验证完成后解析。
 * @throws AssertionError 当工具入口收到未取消信号或结果没有关联已提交 BlockEnd 时抛出。
 */
async function testStopAfterCompletedToolBlock(): Promise<void> {
  const { events, appendEvent } = collector()
  const cancelled: AppError = { source: "tool", code: "CANCELLED", message: "已取消" }
  let cancelledCalls = 0
  const result = await runAgentLoop({
    turn: 1, model: MODEL, content: [], tools: [], signal: new AbortController().signal, appendEvent,
    executeTool: async (_name, _args, context) => {
      assert.equal(context.signal.aborted, true)
      cancelledCalls++
      return errorResult(cancelled, "未执行")
    },
    adapter: adapterFrom(async function* () {
      yield blockStart(0, "tool_call")
      yield blockEnd(0, { type: "tool_call", toolCallId: "call-1", name: "read", arguments: { path: "a.ts" } })
      throw createAbortError()
    }),
  })
  assert.equal(cancelledCalls, 1)
  assert.equal(result.stopped, true)
  assert.deepEqual(eventTypes(events).slice(-3), ["assistant/message", "tool/result", "step/end"])
  const toolResult = events.find((event) => event.type === "tool/result")
  assert.ok(toolResult?.type === "tool/result")
  assert.equal(toolResult.toolCallEventId, "event-3")
  assert.ok(toolResult.result.status === "error")
  assert.equal(toolResult.result.error.code, "CANCELLED")
}

/**
 * 验证尚无可提交内容时不创建空取消消息，且事件写入失败不会被当作模型流取消重新补写。
 * @returns 无输出、空文本块及取消时存储失败的边界验证完成后解析。
 * @throws AssertionError 当写入失败被重试或未提交 Delta 被纳入收尾时抛出。
 */
async function testStopBeforeContentAndDuringPersistenceFailure(): Promise<void> {
  for (const startBlock of [false, true]) {
    const { events, appendEvent } = collector()
    const result = await runAgentLoop({
      turn: 1, model: MODEL, content: [], tools: [], signal: new AbortController().signal, appendEvent,
      executeTool: async () => { throw new Error("unexpected tool") },
      adapter: adapterFrom(async function* () {
        if (startBlock) yield blockStart(0, "thinking")
        throw createAbortError()
      }),
    })
    assert.equal(result.stopped, true)
    assert.equal(events.filter((event) => event.type === "assistant/message").length, startBlock ? 1 : 0)
    if (startBlock) assert.deepEqual(only(events, "assistant/block_end").block, { type: "thinking", text: "" })
  }
  const { events, appendEvent } = collector()
  const controller = new AbortController()
  const writeError = new Error("delta write failed")
  await runAgentLoop({
    turn: 1, model: MODEL, content: [], tools: [], signal: controller.signal,
    executeTool: async () => { throw new Error("unexpected tool") },
    appendEvent: async (event) => {
      if (event.type === "assistant/block_delta") {
        controller.abort()
        throw writeError
      }
      return appendEvent(event)
    },
    adapter: adapterFrom(async function* () {
      yield blockStart(0, "text")
      yield textDelta(0, "尚未提交")
    }),
  })
  assert.deepEqual(eventTypes(events), ["step/start", "assistant/block_start", "step/end"])
}

/**
 * 验证工具小轮期间取消后，调用结果完成关联且不再发起下一 Step。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
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

  /**
   * 第一次调用发现已被取消，第二次调用尚未启动便返回 CANCELLED。
   */
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

  /**
   * 小轮仍然为每个调用写 tool/result，Step 以 stopped 关闭，且不再发起下一次模型请求
   */
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

/**
 * 5. Adapter 抛错
 */

/**
 * 验证模型非取消错误在 Step 错误收尾后向调用方传播。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
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

  /**
   * 错误原样抛出（Turn 的收尾与 app/error 由调用方负责），Step 以 error 关闭
   */
  assert.deepEqual(thrown, modelError)
  assert.deepEqual(eventTypes(events), ["step/start", "assistant/block_start", "step/end"])
  assert.equal(only(events, "step/end").reason, "error")
  assert.equal(calls.length, 0)
  assert.equal(content.length, 2)
}

/**
 * 入口
 */

/**
 * 依次执行模型流、工具调度、取消与错误传播的断言场景。
 * @returns 当前场景的断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function main(): Promise<void> {
  await testCompletedStep()
  await testToolRound()
  await testToolRoundDelegatesToScheduler()
  await testUnfinishedToolCall()
  await testUserStopDuringModelStream()
  await testStopClosesOnlyTextBlocks()
  await testStopAfterCompletedToolBlock()
  await testStopBeforeContentAndDuringPersistenceFailure()
  await testUserStopDuringToolRound()
  await testModelError()
  console.log("loop.test.ts: AgentLoop 断言通过")
}

/**
 * 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
 */
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
