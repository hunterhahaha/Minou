import assert from "node:assert/strict"

import type OpenAI from "openai"

import { createModelAdapter } from "../src/gateway/adapter.ts"
import { OpenAIAdapter } from "../src/gateway/openai-adapter.ts"
import type { AssistantContentBlock, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../src/types.ts"
import { collect, collectError, sseData, sseEvent, startFakeProvider, streamOf } from "./helpers.ts"

const MODEL: ModelConfig = {
  modelId: "fixture-openai", name: "GPT-fixture", providerId: "custom", protocol: "responses",
  supportsReasoning: true, reasoningLevels: ["medium"], reasoningField: { path: ["reasoning", "effort"] },
  contextWindow: 128000, maxOutputTokens: 4096,
}
const REQUEST: UnifiedModelRequest = {
  model: { modelId: MODEL.modelId, providerId: MODEL.providerId, protocol: MODEL.protocol, name: MODEL.name, reasoningLevel: "medium" },
  tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }],
  context: { messages: [{ role: "system", content: "Instructions" }, { role: "user", content: "Look up the answer" }] },
}
const CONTEXT = { modelConfig: MODEL, providerName: "Unknown Proxy" }
const SOURCE = { name: "OpenAI", protocol: "responses" } as const
const FIRST = {
  id: "rs_first", type: "reasoning", status: "completed",
  encrypted_content: "  fixture-first_+==  ", summary: [{ type: "summary_text", text: "Readable summary" }],
  extra_field: { preserve: true },
} as const
const SECOND = { id: "rs_second", type: "reasoning", status: "completed", encrypted_content: "fixture-second/+=", summary: [] } as const
const CALL = { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"id":1}', status: "completed" }
const COMPLETED = { type: "response.completed", response: { status: "completed", output: [FIRST, CALL, SECOND] } }
const PENDING_FIRST = { ...FIRST, encrypted_content: "fixture-partial", summary: [], status: "in_progress" }

/**
 * 转换仅填入当前用例所需字段的 Responses 事件，便于检查断流前的增量。
 * @param events 测试中的协议事件，按接收顺序排列。
 * @returns OpenAIAdapter 输出的统一流。
 */
function mapResponses(events: object[]): AsyncIterable<ModelStreamEvent> {
  return new OpenAIAdapter().mapResponseStream({
    protocol: "responses", events: streamOf(events as OpenAI.Responses.ResponseStreamEvent[]),
  }, REQUEST, CONTEXT)
}

/** 检查只有完整 done item 可以生成回放，并验证 SDK 下一次请求按历史原位置回传它。 */
async function testResponsesReplay(): Promise<void> {
  const responseEvents = [
    { type: "response.output_item.added", output_index: 0, item: PENDING_FIRST },
    { type: "response.reasoning_summary_text.delta", item_id: FIRST.id, delta: FIRST.summary[0].text },
    { type: "response.output_item.added", output_index: 1, item: { ...CALL, status: "in_progress", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: CALL.id, delta: '{"id":' },
    { type: "response.output_item.done", output_index: 1, item: CALL },
    { type: "response.output_item.done", output_index: 0, item: FIRST },
    { type: "response.output_item.added", output_index: 2, item: { ...SECOND, encrypted_content: null, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 2, item: SECOND },
    COMPLETED,
  ]
  const provider = await startFakeProvider((_request, attempt) => ({
    events: attempt === 0 ? [...responseEvents.map(sseData), sseData("[DONE]")]
      : attempt === 1 ? [sseData(COMPLETED), sseData("[DONE]")]
      : [sseEvent("error", { message: FIRST.encrypted_content, code: SECOND.encrypted_content })],
  }))
  const oldLogLevel = process.env.OPENAI_LOG
  const debug = console.debug
  const diagnostics: unknown[][] = []
  process.env.OPENAI_LOG = "debug"
  console.debug = (...args: unknown[]) => { diagnostics.push(args) }
  try {
    const adapter = createModelAdapter(MODEL, { apiKey: "fixture", baseURL: provider.baseURL("responses") }, CONTEXT.providerName)
    const signal = new AbortController().signal
    const events = await collect(adapter.stream(REQUEST, signal))
    const textEvents = events.filter((event) => event.type === "block_delta" && event.delta.type === "thinking")
    assert.deepEqual(textEvents, [{ type: "block_delta", index: 0, delta: { type: "thinking", text: FIRST.summary[0].text } }])
    const blocks = events.filter((event) => event.type === "block_end").sort((a, b) => a.index - b.index).map((event) => event.block)
    assert.deepEqual(blocks, [
      { type: "thinking", text: FIRST.summary[0].text, replay: { ...SOURCE, payloadJson: JSON.stringify(FIRST) } },
      { type: "tool_call", toolCallId: CALL.call_id, name: CALL.name, arguments: { id: 1 } },
      { type: "thinking", text: "", replay: { ...SOURCE, payloadJson: JSON.stringify(SECOND) } },
    ])
    assert.deepEqual(events.at(-1), { type: "stream_end", completion: "tool_calls", finishReason: "completed" })

    const invalid: AssistantContentBlock[] = [
      { type: "thinking", text: "without replay" },
      { type: "thinking", text: "wrong source", replay: { ...SOURCE, name: "openai", payloadJson: JSON.stringify(FIRST) } },
      { type: "thinking", text: "wrong protocol", replay: { ...SOURCE, protocol: "chat_completions", payloadJson: JSON.stringify(FIRST) } },
      { type: "thinking", text: "bad JSON", replay: { ...SOURCE, payloadJson: "{" } },
      { type: "thinking", text: "empty cipher", replay: { ...SOURCE, payloadJson: JSON.stringify({ ...FIRST, encrypted_content: "" }) } },
      { type: "thinking", text: "non-reasoning", replay: { ...SOURCE, payloadJson: JSON.stringify({ ...FIRST, type: "message" }) } },
    ]
    const followUp: UnifiedModelRequest = {
      ...REQUEST,
      context: { history: { system: "Instructions", mcpBaseline: [], events: [
        { seq: 1, type: "user/message", content: [{ type: "text", text: "Look up the answer" }] },
        { seq: 2, type: "assistant/message", content: [
          { type: "text", text: "Before" }, ...invalid, blocks[0]!,
          { type: "text", text: "Between" }, blocks[1]!, blocks[2]!, { type: "text", text: "After" },
        ] },
        { seq: 3, type: "tool/result", turn: 1, step: 1, toolCallEventId: "event-1", toolCallId: CALL.call_id,
          content: [{ type: "text", text: "found" }], isError: false },
      ] } },
    }
    await collect(adapter.stream(followUp, signal))
    const sent = provider.requests[1]
    assert.equal(sent?.path, "/v1/responses")
    assert.equal(sent?.body.store, false)
    assert.equal(sent?.body.max_output_tokens, MODEL.maxOutputTokens)
    assert.deepEqual(sent?.body.reasoning, { effort: "medium" })
    assert.deepEqual(sent?.body.input, [
      { role: "user", content: "Look up the answer" }, { role: "assistant", content: "Before" }, FIRST,
      { role: "assistant", content: "Between" }, { type: "function_call", call_id: CALL.call_id, name: CALL.name, arguments: CALL.arguments },
      SECOND, { role: "assistant", content: "After" }, { type: "function_call_output", call_id: CALL.call_id, output: "found" },
    ])
    const error = await collectError(adapter.stream(followUp, signal, { retry: false }))
    assert.match(JSON.stringify(error), /OpenAI Responses 请求失败/)
    assert.doesNotMatch(JSON.stringify(error), /fixture-first|fixture-second/)
    assert.deepEqual(diagnostics, [])
  } finally {
    console.debug = debug
    if (oldLogLevel === undefined) delete process.env.OPENAI_LOG
    else process.env.OPENAI_LOG = oldLogLevel
    await provider.close()
  }
}

/** 检查中断、终态回退和只有完成事件的推理项。 */
async function testResponsesBoundaries(): Promise<void> {
  const added = { type: "response.output_item.added", item: PENDING_FIRST }
  const delta = { type: "response.reasoning_summary_text.delta", item_id: FIRST.id, delta: FIRST.summary[0].text }
  const received: ModelStreamEvent[] = []
  await assert.rejects(async () => {
    for await (const event of mapResponses([added, delta])) received.push(event)
  }, /中断/)
  assert.deepEqual(received.map((event) => event.type), ["block_start", "block_delta"])
  assert.doesNotMatch(JSON.stringify(received), /fixture-partial|payloadJson/)

  const incomplete = { type: "response.incomplete", response: {
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [FIRST],
  } }
  const partial = await collect(mapResponses([added, delta, incomplete]))
  assert.deepEqual(partial.slice(-2), [
    { type: "block_end", index: 0, block: { type: "thinking", text: FIRST.summary[0].text } },
    { type: "stream_end", completion: "incomplete", finishReason: "max_output_tokens" },
  ])

  const finished = await collect(mapResponses([{ type: "response.output_item.done", item: SECOND }, COMPLETED]))
  assert.deepEqual(finished.slice(0, 2), [
    { type: "block_start", index: 0, blockType: "thinking" },
    { type: "block_end", index: 0, block: { type: "thinking", text: "", replay: { ...SOURCE, payloadJson: JSON.stringify(SECOND) } } },
  ])
  const withoutCipher = await collect(mapResponses([{ type: "response.output_item.done", item: { ...FIRST, encrypted_content: "" } }, COMPLETED]))
  assert.deepEqual(withoutCipher[2], { type: "block_end", index: 0, block: { type: "thinking", text: FIRST.summary[0].text } })
}

/** 检查 Chat Completions 的原生请求字段、函数分片、拒答正文和 Usage 尾块。 */
async function testChatCompletions(): Promise<void> {
  const modelConfig = { ...MODEL, protocol: "chat_completions", reasoningField: { path: ["reasoning_effort"] } } satisfies ModelConfig
  const request: UnifiedModelRequest = { ...REQUEST, model: { ...REQUEST.model, protocol: modelConfig.protocol } }
  const adapter = new OpenAIAdapter()
  const context = { modelConfig, providerName: "OpenAi" }
  const outbound = adapter.buildRequest(request, context)
  if (outbound.protocol !== "chat_completions") throw new Error("未构造 Chat Completions 请求")
  assert.deepEqual(outbound.params.messages[0], { role: "developer", content: "Instructions" })
  assert.deepEqual(outbound.params.stream_options, { include_usage: true })
  assert.equal(outbound.params.reasoning_effort, "medium")
  assert.equal(outbound.params.max_completion_tokens, MODEL.maxOutputTokens)

  const chunks = [
    { choices: [{ delta: { refusal: "Unavailable" }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"id":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 16, completion_tokens: 5, total_tokens: 21, prompt_tokens_details: { cached_tokens: 4 } } },
  ] as unknown as OpenAI.ChatCompletionChunk[]
  const events = await collect(adapter.mapResponseStream({ protocol: "chat_completions", events: streamOf(chunks) }, request, context))
  assert.deepEqual(events.filter((event) => event.type === "block_end").map((event) => event.block), [
    { type: "text", text: "Unavailable" }, { type: "tool_call", toolCallId: "call_1", name: "lookup", arguments: { id: 1 } },
  ])
  assert.deepEqual(events.at(-1), {
    type: "stream_end", completion: "tool_calls", finishReason: "tool_calls",
    usage: { inputTokens: 12, cacheReadTokens: 4, outputTokens: 5, totalTokens: 21 },
  })
}

/** 执行双协议回归，只有假 Provider 会绑定本机端口。 */
async function main(): Promise<void> {
  await testResponsesBoundaries()
  await testChatCompletions()
  await testResponsesReplay()
  console.log("openai.test.ts: OpenAI 双协议与原生推理回放断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
