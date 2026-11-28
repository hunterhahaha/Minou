import assert from "node:assert/strict"
import type OpenAI from "openai"

import { CANCELLED } from "../../error/src/normalizer.ts"
import { createModelAdapter } from "../src/gateway/adapter.ts"
import { GeminiAdapter } from "../src/gateway/gemini-adapter.ts"
import type { AssistantContentBlock, BlockReplay, ModelConfig, ModelHistoryEvent, ModelStreamEvent, UnifiedModelRequest } from "../src/types.ts"
import { collect, collectError, sseData, sseEvent, startFakeProvider, streamOf } from "./helpers.ts"

const modelConfig: ModelConfig = {
  name: "gemini-test", modelId: "model-record", providerId: "proxy-record", protocol: "chat_completions",
  contextWindow: 8192, maxOutputTokens: 1024, supportsReasoning: true,
  reasoningLevels: ["medium"], reasoningField: { path: ["reasoning_effort"] },
}
const context = { modelConfig, providerName: "Local Proxy" }
const adapter = new GeminiAdapter()
const request: UnifiedModelRequest = {
  model: { name: modelConfig.name, modelId: modelConfig.modelId, providerId: modelConfig.providerId,
    protocol: modelConfig.protocol, reasoningLevel: "medium" },
  context: { messages: [{ role: "system", content: "System" }, { role: "user", content: "User" }] },
  tools: [{ name: "lookup", description: "Look up data", inputSchema: { type: "object" } }],
}

const source = { name: "Gemini", protocol: "chat_completions" } as const
const messageExtra = { google: { thought_signature: "  test-message+/=  ", detail: { enabled: true } }, another: [1, null] }
const toolExtra = { google: { thought_signature: "test-call+/=", attributes: ["keep"] }, extension: { value: 0 } }
const signedCall = { type: "function", id: "call_1", function: { name: "lookup", arguments: '{ "q": "a" }' }, extra_content: toolExtra }
const plainCall = { type: "function", id: "call_2", function: { name: "lookup", arguments: '{"q":"b"}' } }

/**
 * 构造一个可经 SDK 传输的 Gemini 流分片。
 * @param delta 当前 choice 的响应字段。
 * @param reason 当前 choice 的结束原因。
 * @returns 带 choice 和模型标识的测试 chunk。
 */
function chunk(delta: Record<string, unknown>, reason: OpenAI.ChatCompletionChunk.Choice["finish_reason"] = null): OpenAI.ChatCompletionChunk {
  return {
    id: "gemini-test-stream", created: 1, model: modelConfig.name, object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: reason }],
  }
}

/**
 * 按 Runtime 的块索引整理已交付的历史内容。
 * @param events 转换后的统一流事件。
 * @returns 可作为下一次请求历史的 assistant 内容。
 */
function endedBlocks(events: ModelStreamEvent[]): AssistantContentBlock[] {
  return events.filter((event) => event.type === "block_end")
    .sort((left, right) => left.index - right.index).map(({ block }) => block)
}

/**
 * 将历史内容交给 Gemini 请求转换器。
 * @param blocks 上一条 assistant 消息的内容。
 * @returns 包含历史内容的原生消息数组。
 */
function replayMessages(blocks: AssistantContentBlock[]): OpenAI.ChatCompletionMessageParam[] {
  const outbound = adapter.buildRequest({ ...request, context: { messages: [
    { role: "system", content: "System" }, { role: "assistant", content: blocks },
  ] } }, context)
  assert.equal(outbound.protocol, "chat_completions")
  return outbound.params.messages
}

/** 通过本地 SSE 和共享 SDK 验证两级签名、普通内容、参数、Usage 和工具结果的往返。 */
async function testSdkRoundTrip(): Promise<void> {
  const opening = [
    chunk({ content: "先" }),
    chunk({ content: "查询", tool_calls: [
      { index: 0, id: signedCall.id, type: "function", function: { name: "lookup", arguments: '{ "q": ' } },
      { index: 1, id: plainCall.id, type: "function", function: { name: "lookup", arguments: '{"q":' } },
    ] }),
    chunk({ tool_calls: [
      { index: 1, function: { arguments: '"b"}' } },
      { index: 0, function: { arguments: '"a" }' } },
    ] }),
    chunk({ content: "", extra_content: messageExtra, tool_calls: [{ id: signedCall.id, extra_content: toolExtra }] }, "tool_calls"),
    { ...chunk({}), choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
    sseData("[DONE]"),
  ]
  const fake = await startFakeProvider((_incoming, attempt) => ({ events: attempt === 0 ? opening : attempt === 1 ? [
    chunk({ content: "完成" }), chunk({}, "stop"), sseData("[DONE]"),
  ] : [sseEvent("error", { message: messageExtra.google.thought_signature, code: toolExtra.google.thought_signature })] }))
  const oldLogLevel = process.env.OPENAI_LOG
  const debug = console.debug
  const diagnostics: unknown[][] = []
  process.env.OPENAI_LOG = "debug"
  console.debug = (...args: unknown[]) => { diagnostics.push(args) }
  try {
    const bound = createModelAdapter(modelConfig, {
      apiKey: "local-test-key", baseURL: `${fake.origin}/v1beta/openai/`, defaultHeaders: { "x-test-provider": "local" },
    }, context.providerName)
    const events = await collect(bound.stream(request, new AbortController().signal))
    assert.deepEqual(events.at(-1), {
      type: "stream_end", completion: "tool_calls", finishReason: "tool_calls",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    })
    assert.ok(events.filter((event) => event.type === "block_delta").every((event) => !JSON.stringify(event).includes("thought_signature")))
    const blocks = endedBlocks(events)
    const nativeMessage = { role: "assistant", content: "先查询", extra_content: messageExtra, tool_calls: [signedCall, plainCall] }
    assert.deepEqual(blocks.map(({ replay, ...block }) => ({
      ...block, ...(replay ? { replay: { ...replay, payloadJson: JSON.parse(replay.payloadJson) } } : {}),
    })), [
      { type: "text", text: "先查询", replay: { ...source, payloadJson: nativeMessage } },
      { type: "tool_call", toolCallId: "call_1", name: "lookup", arguments: { q: "a" }, replay: { ...source, payloadJson: signedCall } },
      { type: "tool_call", toolCallId: "call_2", name: "lookup", arguments: { q: "b" } },
    ])
    const history: ModelHistoryEvent[] = [
      { seq: 1, type: "user/message", content: [{ type: "text", text: "User" }] },
      { seq: 2, type: "assistant/message", content: blocks },
    ]
    for (const [index, toolCallId] of ["call_1", "call_2"].entries()) {
      history.push({ seq: index + 3, type: "tool/result", turn: 1, step: 1, toolCallEventId: `event-${index}`,
        toolCallId, content: [{ type: "text", text: `result-${index}` }], isError: false })
    }
    history.push({ seq: 5, type: "assistant/message", content: [{ type: "text", text: "普通历史正文" }] })
    const followUp = { ...request, context: { history: { system: "System", mcpBaseline: [], events: history } } }
    const followUpEvents = await collect(bound.stream(followUp, new AbortController().signal))
    assert.deepEqual(endedBlocks(followUpEvents), [{ type: "text", text: "完成" }])

    assert.equal(fake.requests.length, 2)
    const sent = fake.requests[1]
    assert.equal(sent.path, "/v1beta/openai/chat/completions")
    assert.equal(sent.headers.authorization, "Bearer local-test-key")
    assert.equal(sent.headers["x-test-provider"], "local")
    assert.equal(sent.body.reasoning_effort, "medium")
    assert.equal(sent.body.max_completion_tokens, modelConfig.maxOutputTokens)
    assert.deepEqual(sent.body.stream_options, { include_usage: true })
    assert.deepEqual(sent.body.tools, [{ type: "function", function: { name: "lookup", description: "Look up data", parameters: { type: "object" } } }])
    assert.deepEqual(sent.body.messages, [
      { role: "system", content: "System" }, { role: "user", content: "User" }, nativeMessage,
      { role: "tool", tool_call_id: "call_1", content: "result-0" },
      { role: "tool", tool_call_id: "call_2", content: "result-1" },
      { role: "assistant", content: "普通历史正文" },
    ])
    const error = await collectError(bound.stream(followUp, new AbortController().signal, { retry: false }))
    assert.match(JSON.stringify(error), /Gemini Chat Completions 请求失败/)
    assert.doesNotMatch(JSON.stringify(error), /test-message|test-call/)
    assert.deepEqual(diagnostics, [])
  } finally {
    console.debug = debug
    if (oldLogLevel === undefined) delete process.env.OPENAI_LOG
    else process.env.OPENAI_LOG = oldLogLevel
    await fake.close()
  }
}

/** 验证没有正文的结束分片可单独保存消息级签名，其他 choice 不会覆盖它。 */
async function testSignatureOnlyMessage(): Promise<void> {
  const terminal = chunk({ extra_content: messageExtra }, "stop")
  terminal.choices.unshift({ index: 1, delta: { content: "another choice" }, finish_reason: "stop" })
  const events = await collect(adapter.mapResponseStream({ protocol: "chat_completions", events: streamOf([terminal]) }, request, context))
  const blocks = endedBlocks(events)
  assert.deepEqual(events.map(({ type }) => type), ["block_start", "block_end", "stream_end"])
  const native = { role: "assistant", content: "", extra_content: messageExtra }
  assert.equal(blocks.length, 1)
  const [{ replay, ...block }] = blocks
  assert.deepEqual(block, { type: "thinking", text: "" })
  assert.ok(replay)
  const { payloadJson, ...replaySource } = replay
  assert.deepEqual(replaySource, source)
  assert.deepEqual(JSON.parse(payloadJson), native)
  assert.deepEqual(replayMessages(blocks).at(-1), native)
}

/** 验证坏回放安全退回普通内容，且消息中的调用数组按历史块重建。 */
function testReplayValidation(): void {
  const validMessage = { role: "assistant", content: "native text", extra_content: messageExtra, name: "saved-assistant",
    tool_calls: [plainCall, signedCall] }
  const validReplay = { ...source, payloadJson: JSON.stringify(validMessage) }
  const toolBlock = { type: "tool_call", toolCallId: "call_1", name: "lookup", arguments: { fallback: true } } as const
  const textBlock = { type: "text", text: "fallback text" } as const
  const invalidReplays: BlockReplay[] = [
    { ...validReplay, name: "gemini" },
    { ...validReplay, protocol: "responses" },
    { ...source, payloadJson: "{" },
    { ...source, payloadJson: JSON.stringify({ ...validMessage, role: "user" }) },
    { ...source, payloadJson: JSON.stringify({ ...validMessage, content: 42 }) },
    { ...source, payloadJson: JSON.stringify({ ...validMessage, extra_content: { google: { thought_signature: "" } } }) },
  ]
  for (const replay of invalidReplays) {
    assert.deepEqual(replayMessages([{ ...textBlock, replay }, { ...toolBlock, replay }, { type: "thinking", text: "", replay }]).at(-1), {
      role: "assistant", content: textBlock.text,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"fallback":true}' } }],
    })
  }
  for (const invalidCall of [{ ...signedCall, id: "other" }, { ...signedCall, function: { name: "lookup", arguments: {} } }]) {
    assert.deepEqual(replayMessages([{ ...toolBlock, replay: { ...source, payloadJson: JSON.stringify(invalidCall) } }]).at(-1), {
      role: "assistant", content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"fallback":true}' } }],
    })
  }
  assert.deepEqual(replayMessages([
    { ...textBlock, replay: validReplay },
    { ...toolBlock, replay: { ...source, payloadJson: JSON.stringify({ ...signedCall, index: 0 }) } },
    { ...toolBlock, toolCallId: "call_2", arguments: { q: "b" } },
  ]).at(-1), { ...validMessage, tool_calls: [signedCall, plainCall] })
}

/** 验证提前结束、SDK 抛错和真实传输取消都不会交付带回放的未完成块。 */
async function testUnfinishedStreams(): Promise<void> {
  const partial = chunk({ content: "partial", extra_content: messageExtra, tool_calls: [{ ...signedCall, index: 0 }] })
  const failure = new Error("planned stream failure")
  /** @yields 部分内容与最后一个 choice 分片。 @throws 模拟尚在读取 SDK 流时的失败。 */
  async function* brokenStream(): AsyncGenerator<OpenAI.ChatCompletionChunk> {
    yield partial
    yield chunk({}, "tool_calls")
    throw failure
  }
  for (const [events, error] of [[streamOf([partial]), /中断/], [brokenStream(), failure]] as const) {
    const received: ModelStreamEvent[] = []
    await assert.rejects(async () => {
      for await (const event of adapter.mapResponseStream({ protocol: "chat_completions", events }, request, context)) received.push(event)
    }, error)
    assert.ok(received.some(({ type }) => type === "block_delta"))
    assert.ok(received.every(({ type }) => type !== "block_end" && type !== "stream_end"))
  }

  const fake = await startFakeProvider({ events: [partial], hang: true })
  const controller = new AbortController()
  try {
    const bound = createModelAdapter(modelConfig, { apiKey: "local-test-key", baseURL: fake.baseURL("chat_completions") }, "Gemini")
    const received: ModelStreamEvent[] = []
    await assert.rejects(async () => {
      for await (const event of bound.stream(request, controller.signal, { timeoutMs: 2000 })) {
        received.push(event)
        if (event.type === "block_delta" && event.delta.type === "tool_call") controller.abort()
      }
    }, { code: CANCELLED })
    assert.ok(received.some(({ type }) => type === "block_delta"))
    assert.ok(received.every(({ type }) => type !== "block_end" && type !== "stream_end"))
  } finally {
    controller.abort()
    await fake.close()
  }
}

/** 执行 Gemini 请求、流和回放回归测试。 */
async function main(): Promise<void> {
  await testSignatureOnlyMessage()
  testReplayValidation()
  await testSdkRoundTrip()
  await testUnfinishedStreams()
  console.log("gemini.test.ts: Gemini Chat Completions 流与签名回放断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
