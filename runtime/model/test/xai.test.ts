import assert from "node:assert/strict"

import { createModelAdapter } from "../src/gateway/adapter.ts"
import type { AssistantContentBlock, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../src/types.ts"
import { collect, collectError, sseData, sseEvent, startFakeProvider } from "./helpers.ts"

const RESPONSES_MODEL: ModelConfig = {
  modelId: "fixture-xai", name: "GROK-fixture", providerId: "custom", protocol: "responses",
  supportsReasoning: true, reasoningLevels: ["high"], reasoningField: { path: ["reasoning", "effort"] },
  contextWindow: 128000, maxOutputTokens: 4096,
}
const REQUEST: UnifiedModelRequest = {
  model: {
    modelId: RESPONSES_MODEL.modelId, providerId: RESPONSES_MODEL.providerId, protocol: RESPONSES_MODEL.protocol,
    name: RESPONSES_MODEL.name, reasoningLevel: "high",
  },
  tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }],
  context: { messages: [{ role: "system", content: "Instructions" }, { role: "user", content: "Look up the answer" }] },
}
const SOURCE = { name: "Xai", protocol: "responses" } as const
const FIRST = {
  id: "rs_first", type: "reasoning", summary: [{ type: "summary_text", text: "First summary" }],
  encrypted_content: "  fixture-first_+==  ", status: "completed", native_metadata: { preserve: [1, true] },
} as const
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] }
const CALL = { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"id":1}', status: "completed" }
const SNAPSHOT_ONLY = {
  id: "rs_snapshot_only", type: "reasoning", summary: [], encrypted_content: "fixture-snapshot-only/+=", extra: 7,
}
const SNAPSHOT_FALLBACK = {
  id: "rs_fallback", type: "reasoning", summary: [{ type: "summary_text", text: "Another summary" }],
  encrypted_content: "fixture-snapshot_+/=", status: "completed",
}
const SUMMARY_ONLY = { id: "rs_summary", type: "reasoning", summary: [{ type: "summary_text", text: "Plain summary" }] }
const CIPHER_ONLY = { id: "rs_cipher", type: "reasoning", summary: [], encrypted_content: "fixture-cipher/+=" }
const ADDED_FIRST = { ...FIRST, status: "in_progress", summary: [], encrypted_content: "fixture-unfinished" }
const COMPLETED = { type: "response.completed", response: { status: "completed", output: [] } }

/**
 * 模拟 Runtime 按统一索引组装已完成的 Assistant 内容。
 * @param events 一次协议流产生的统一事件。
 * @returns 依序的已完成内容块。
 */
function completedBlocks(events: ModelStreamEvent[]): AssistantContentBlock[] {
  return events.filter((event) => event.type === "block_end").sort((a, b) => a.index - b.index).map((event) => event.block)
}

/** 用真实 SDK 验证原生项顺序、终态补取、历史回放、错误清理与 SDK 日志。 */
async function testResponsesReplay(): Promise<void> {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: ADDED_FIRST },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: FIRST.id, summary_index: 0, delta: "First " },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "another-item", summary_index: 0, delta: "wrong item" },
    { type: "response.output_item.added", output_index: 1, item: { ...MESSAGE, content: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: FIRST.id, summary_index: 0, delta: "summary" },
    { type: "response.output_text.delta", output_index: 1, item_id: MESSAGE.id, content_index: 0, delta: "Checking." },
    { type: "response.output_item.done", output_index: 1, item: MESSAGE },
    { type: "response.output_item.added", output_index: 2, item: { ...CALL, status: "in_progress", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: CALL.id, delta: '{"id":' },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: CALL.id, delta: "1}" },
    { type: "response.output_item.done", output_index: 2, item: { ...CALL, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: FIRST },
    { type: "response.reasoning_summary_text.delta", output_index: 4, item_id: SNAPSHOT_FALLBACK.id, summary_index: 0, delta: "Another summary" },
    { type: "response.output_item.done", output_index: 4, item: { ...SNAPSHOT_FALLBACK, encrypted_content: "" } },
    { type: "response.output_item.done", output_index: 5, item: SUMMARY_ONLY },
    { type: "response.output_item.done", output_index: 6, item: CIPHER_ONLY },
    { type: "response.completed", response: {
      status: "completed", output: [
        { ...FIRST, encrypted_content: "fixture-snapshot-duplicate" }, MESSAGE, CALL,
        SNAPSHOT_ONLY, SNAPSHOT_FALLBACK, SUMMARY_ONLY, CIPHER_ONLY,
      ],
      usage: {
        input_tokens: 1270, input_tokens_details: { cached_tokens: 1152 }, output_tokens: 294,
        output_tokens_details: { reasoning_tokens: 252 }, total_tokens: 1564,
      },
    } },
  ]
  const provider = await startFakeProvider((_request, attempt) => ({ events: attempt === 0
    ? events.map((event) => sseEvent(event.type, event))
    : attempt === 1 ? [sseEvent(COMPLETED.type, COMPLETED)]
      : [sseEvent("error", { message: FIRST.encrypted_content, code: SNAPSHOT_FALLBACK.encrypted_content })],
  }))
  const oldLogLevel = process.env.OPENAI_LOG
  const { debug, error, info, warn } = console
  const diagnostics: unknown[][] = []
  process.env.OPENAI_LOG = "debug"
  console.debug = console.error = console.info = console.warn = (...args: unknown[]) => { diagnostics.push(args) }
  try {
    const adapter = createModelAdapter(RESPONSES_MODEL, {
      apiKey: "fixture", baseURL: provider.baseURL("responses"), defaultHeaders: { "x-fixture": "configured" },
    }, "Custom Relay")
    const signal = new AbortController().signal
    const received = await collect(adapter.stream(REQUEST, signal))
    const blocks = completedBlocks(received)
    assert.deepEqual(blocks, [
      { type: "thinking", text: "First summary", replay: { ...SOURCE, payloadJson: JSON.stringify(FIRST) } },
      { type: "text", text: "Checking." },
      { type: "tool_call", toolCallId: CALL.call_id, name: CALL.name, arguments: { id: 1 } },
      { type: "thinking", text: "", replay: { ...SOURCE, payloadJson: JSON.stringify(SNAPSHOT_ONLY) } },
      { type: "thinking", text: "Another summary", replay: { ...SOURCE, payloadJson: JSON.stringify(SNAPSHOT_FALLBACK) } },
      { type: "thinking", text: "Plain summary" },
      { type: "thinking", text: "", replay: { ...SOURCE, payloadJson: JSON.stringify(CIPHER_ONLY) } },
    ])
    assert.deepEqual(received.filter((event) => event.type === "block_start").map((event) => event.index), [0, 1, 2, 3, 4, 5, 6])
    assert.deepEqual(received.filter((event) => event.type === "block_delta" && event.delta.type === "thinking"), [
      { type: "block_delta", index: 0, delta: { type: "thinking", text: "First " } },
      { type: "block_delta", index: 0, delta: { type: "thinking", text: "summary" } },
      { type: "block_delta", index: 4, delta: { type: "thinking", text: "Another summary" } },
      { type: "block_delta", index: 5, delta: { type: "thinking", text: "Plain summary" } },
    ])
    assert.deepEqual(received.at(-1), {
      type: "stream_end", completion: "tool_calls", finishReason: "completed",
      usage: { inputTokens: 118, outputTokens: 294, cacheReadTokens: 1152, reasoningTokens: 252, totalTokens: 1564 },
    })

    const invalid: AssistantContentBlock[] = [
      { type: "thinking", text: "no replay" },
      { type: "thinking", text: "invalid JSON", replay: { ...SOURCE, payloadJson: "{" } },
      { type: "thinking", text: "empty cipher", replay: { ...SOURCE, payloadJson: JSON.stringify({ ...FIRST, encrypted_content: "" }) } },
      { type: "thinking", text: "wrong item type", replay: { ...SOURCE, payloadJson: JSON.stringify({ ...FIRST, type: "message" }) } },
      { type: "thinking", text: "wrong name case", replay: { ...SOURCE, name: "xAI", payloadJson: JSON.stringify(FIRST) } },
      { type: "thinking", text: "wrong vendor", replay: { ...SOURCE, name: "OpenAI", payloadJson: JSON.stringify(FIRST) } },
      { type: "thinking", text: "wrong protocol", replay: { ...SOURCE, protocol: "chat_completions", payloadJson: JSON.stringify(FIRST) } },
    ]
    const followUp: UnifiedModelRequest = { ...REQUEST, context: { history: { system: "Instructions", mcpBaseline: [], events: [
      { seq: 1, type: "user/message", content: [{ type: "text", text: "Look up the answer" }] },
      { seq: 2, type: "assistant/message", content: [{ type: "text", text: "Before" }, ...invalid, ...blocks] },
      { seq: 3, type: "tool/result", turn: 1, step: 1, toolCallEventId: "event-1", toolCallId: CALL.call_id,
        content: [{ type: "text", text: "Found" }], isError: false },
    ] } } }
    await collect(adapter.stream(followUp, signal))
    const sent = provider.requests[1]!
    assert.equal(sent.path, "/v1/responses")
    assert.equal(sent.headers.authorization, "Bearer fixture")
    assert.equal(sent.headers["x-fixture"], "configured")
    assert.equal(sent.body.stream, true)
    assert.equal(sent.body.store, false)
    assert.equal("include" in sent.body, false)
    assert.equal("previous_response_id" in sent.body, false)
    assert.equal(sent.body.max_output_tokens, RESPONSES_MODEL.maxOutputTokens)
    assert.deepEqual(sent.body.reasoning, { effort: "high" })
    assert.deepEqual(sent.body.tools, [{ type: "function", name: "lookup", description: "Look up a value", parameters: { type: "object" }, strict: false }])
    assert.deepEqual(sent.body.input, [
      { role: "system", content: "Instructions" }, { role: "user", content: "Look up the answer" },
      { role: "assistant", content: "Before" }, FIRST, { role: "assistant", content: "Checking." },
      { type: "function_call", call_id: CALL.call_id, name: CALL.name, arguments: CALL.arguments },
      SNAPSHOT_ONLY, SNAPSHOT_FALLBACK, CIPHER_ONLY,
      { type: "function_call_output", call_id: CALL.call_id, output: "Found" },
    ])
    const failure = await collectError(adapter.stream(followUp, signal, { retry: false }))
    assert.match(JSON.stringify(failure), /xAI 请求失败/)
    assert.doesNotMatch(JSON.stringify(failure), /fixture-first|fixture-snapshot/)
    assert.deepEqual(diagnostics, [])
  } finally {
    console.debug = debug
    console.error = error
    console.info = info
    console.warn = warn
    if (oldLogLevel === undefined) delete process.env.OPENAI_LOG
    else process.env.OPENAI_LOG = oldLogLevel
    await provider.close()
  }
}

/** 验证仅 added 断流、增量后的断流、取消、HTTP 重试和响应终态。 */
async function testResponsesStreamBoundaries(): Promise<void> {
  const added = { type: "response.output_item.added", output_index: 0, item: ADDED_FIRST }
  const delta = { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: FIRST.id, summary_index: 0, delta: "Partial" }
  const terminal = {
    type: "response.incomplete", response: {
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [CIPHER_ONLY],
    },
  }
  const provider = await startFakeProvider((_request, attempt) => {
    switch (attempt) {
      case 0: return { events: [added] }
      case 1: return { events: [added, delta] }
      case 2: return { events: [added, delta], hang: true }
      case 3: return { status: 429 }
      case 4: return { events: [terminal] }
      default: return { events: [{ type: "response.output_item.done", output_index: 0, item: CIPHER_ONLY }, COMPLETED] }
    }
  })
  try {
    const adapter = createModelAdapter(RESPONSES_MODEL, { apiKey: "fixture", baseURL: provider.baseURL("responses") }, "xAI")
    const signal = new AbortController().signal
    for (const expected of [[], ["block_start", "block_delta"]]) {
      const received: ModelStreamEvent[] = []
      await assert.rejects(async () => {
        for await (const event of adapter.stream(REQUEST, signal, { retry: false })) received.push(event)
      }, { code: "REQUEST_FAILED", message: /中断/ })
      assert.deepEqual(received.map((event) => event.type), expected)
      assert.doesNotMatch(JSON.stringify(received), /fixture-unfinished|payloadJson/)
    }

    const cancellation = new AbortController()
    await assert.rejects(async () => {
      for await (const event of adapter.stream(REQUEST, cancellation.signal)) {
        if (event.type === "block_delta") cancellation.abort()
      }
    }, { code: "CANCELLED" })

    const received = await collect(adapter.stream(REQUEST, signal))
    assert.equal(provider.requests.length, 5)
    assert.deepEqual(completedBlocks(received), [
      { type: "thinking", text: "", replay: { ...SOURCE, payloadJson: JSON.stringify(CIPHER_ONLY) } },
    ])
    assert.deepEqual(received.at(-1), { type: "stream_end", completion: "incomplete", finishReason: "max_output_tokens" })

    const doneOnly = await collect(adapter.stream(REQUEST, signal))
    assert.deepEqual(completedBlocks(doneOnly), completedBlocks(received))
    assert.deepEqual(doneOnly.at(-1), { type: "stream_end", completion: "finished", finishReason: "completed" })
  } finally {
    await provider.close()
  }
}

/** 验证 Chat 请求、工具结果、普通与推理增量，以及官方示例和兼容端点的 Usage。 */
async function testChatCompletions(): Promise<void> {
  const modelConfig = { ...RESPONSES_MODEL, protocol: "chat_completions", reasoningField: { path: ["reasoning_effort"] } } satisfies ModelConfig
  const request: UnifiedModelRequest = { ...REQUEST, model: { ...REQUEST.model, protocol: modelConfig.protocol } }
  const official = {
    prompt_tokens: 32, completion_tokens: 9, total_tokens: 135,
    prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 94 },
  }
  const deferred = {
    prompt_tokens: 1259, completion_tokens: 55, total_tokens: 1479,
    prompt_tokens_details: { cached_tokens: 1152 }, completion_tokens_details: { reasoning_tokens: 165 },
  }
  const provider = await startFakeProvider((_request, attempt) => {
    if (attempt === 0) return { events: [
      { choices: [{ index: 0, delta: { reasoning_content: "Thinking " }, finish_reason: null }], usage: { prompt_tokens: 32, completion_tokens: 1, total_tokens: 33 } },
      { choices: [{ index: 0, delta: { reasoning_content: "out loud", content: "Checking." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: CALL.call_id, function: { name: CALL.name, arguments: '{"id":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: official }, sseData("[DONE]"),
    ] }
    if (attempt === 1) return { events: [
      { choices: [{ index: 0, delta: { content: "Found." }, finish_reason: "stop" }], usage: deferred }, sseData("[DONE]"),
    ] }
    if (attempt === 2) return { events: [
      { choices: [{ index: 0, delta: { content: "Partial." }, finish_reason: "length" }] }, sseData("[DONE]"),
    ] }
    return { events: [
      { choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }], usage: { ...official, completion_tokens: 103 } },
      sseData("[DONE]"),
    ] }
  })
  try {
    const adapter = createModelAdapter(modelConfig, { apiKey: "fixture", baseURL: provider.baseURL("chat_completions") }, "XAI")
    const signal = new AbortController().signal
    const first = await collect(adapter.stream(request, signal))
    const blocks = completedBlocks(first)
    assert.deepEqual(blocks, [
      { type: "thinking", text: "Thinking out loud" }, { type: "text", text: "Checking." },
      { type: "tool_call", toolCallId: CALL.call_id, name: CALL.name, arguments: { id: 1 } },
    ])
    assert.deepEqual(first.filter((event) => event.type === "block_delta" && event.delta.type === "thinking"), [
      { type: "block_delta", index: 0, delta: { type: "thinking", text: "Thinking " } },
      { type: "block_delta", index: 0, delta: { type: "thinking", text: "out loud" } },
    ])
    const officialUsage = { inputTokens: 26, outputTokens: 103, cacheReadTokens: 6, reasoningTokens: 94, totalTokens: 135 }
    assert.deepEqual(first.at(-1), { type: "stream_end", completion: "tool_calls", finishReason: "tool_calls", usage: officialUsage })

    const followUp: UnifiedModelRequest = { ...request, context: { messages: [
      { role: "system", content: "Instructions" }, { role: "user", content: "Look up the answer" },
      { role: "assistant", content: [
        { type: "thinking", text: "Old xAI Responses reasoning", replay: { ...SOURCE, payloadJson: JSON.stringify(FIRST) } },
        ...blocks,
      ] },
      { role: "tool", toolCallId: CALL.call_id, content: [{ type: "text", text: "Found" }], isError: false },
    ] } }
    const second = await collect(adapter.stream(followUp, signal))
    const sent = provider.requests[1]!
    assert.equal(sent.path, "/v1/chat/completions")
    assert.equal(sent.headers.authorization, "Bearer fixture")
    assert.equal(sent.body.stream, true)
    assert.equal(sent.body.max_tokens, modelConfig.maxOutputTokens)
    assert.equal(sent.body.reasoning_effort, "high")
    assert.equal("max_completion_tokens" in sent.body, false)
    assert.deepEqual(sent.body.tools, [{ type: "function", function: { name: "lookup", description: "Look up a value", parameters: { type: "object" } } }])
    assert.deepEqual(sent.body.messages, [
      { role: "system", content: "Instructions" }, { role: "user", content: "Look up the answer" },
      { role: "assistant", content: "Checking.", tool_calls: [{ type: "function", id: CALL.call_id, function: { name: CALL.name, arguments: CALL.arguments } }] },
      { role: "tool", tool_call_id: CALL.call_id, content: "Found" },
    ])
    assert.deepEqual(second.at(-1), {
      type: "stream_end", completion: "finished", finishReason: "stop",
      usage: { inputTokens: 107, outputTokens: 220, cacheReadTokens: 1152, reasoningTokens: 165, totalTokens: 1479 },
    })
    const third = await collect(adapter.stream(request, signal))
    assert.deepEqual(third.at(-1), { type: "stream_end", completion: "incomplete", finishReason: "length" })
    const fourth = await collect(adapter.stream(request, signal))
    assert.deepEqual(fourth.at(-1), { type: "stream_end", completion: "finished", finishReason: "stop", usage: officialUsage })
  } finally {
    await provider.close()
  }
}

/** 执行两个 xAI 协议的假 Provider SDK 测试。 */
async function main(): Promise<void> {
  await testResponsesReplay()
  await testResponsesStreamBoundaries()
  await testChatCompletions()
  console.log("xai.test.ts: Xai 双协议、密文回放与 Usage 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
