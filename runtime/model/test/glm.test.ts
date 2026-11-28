import assert from "node:assert/strict"

import { BIGMODEL_CODING_PLAN_PROVIDERS } from "../../../src/main/compatible-providers/bigmodel.ts"
import { ZAI_CODING_PLAN_PROVIDERS } from "../../../src/main/compatible-providers/zai.ts"
import { normalizeModelError } from "../../error/src/normalizer.ts"
import { createModelAdapter } from "../src/gateway/adapter.ts"
import type { ProtocolResponseStream } from "../src/gateway/adapter.ts"
import { GLMAdapter } from "../src/gateway/glm-adapter.ts"
import type { AssistantContentBlock, ModelConfig, ModelStreamEvent, Protocol, UnifiedModelRequest } from "../src/types.ts"
import { collect, collectError, sseData, sseEvent, startFakeProvider, streamOf } from "./helpers.ts"
import type { FakeResponse } from "./helpers.ts"

const TOOL = { name: "lookup", inputSchema: { type: "object" } }
const CALL_ID = "call_lookup"
const THINKING = "  原始思考\n 下一段  "
const HISTORY_THINKING = "\n 历史块的明文  "
const MALFORMED_PAYLOAD_THINKING = "\n 带无效载荷的明文 "
const TEXT = "开始查询。"
const ARGUMENTS = { city: "Singapore" }
const TERMINAL = { chat_completions: "tool_calls", responses: "completed", anthropic_messages: "tool_use" }
const PATH = { chat_completions: "/chat/completions", responses: "/responses", anthropic_messages: "/v1/messages" }

/**
 * 生成覆盖正文、思考和工具续接的三协议 SSE 样本。
 * @param protocol 本地 SDK 所用协议。
 * @param bigmodel 是否模拟 BigModel 报告的 Chat 推理统计。
 * @returns 假 Provider 按顺序发送的 SSE 事件。
 */
function sample(protocol: Protocol, bigmodel: boolean): (string | object)[] {
  const args = JSON.stringify(ARGUMENTS)
  switch (protocol) {
    case "chat_completions":
      return [
        { choices: [{ delta: { reasoning_content: THINKING.slice(0, 6) }, finish_reason: null }],
          usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 } },
        { choices: [{ delta: { reasoning_content: THINKING.slice(6) }, finish_reason: null }] },
        { choices: [{ delta: { content: TEXT }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, ...(bigmodel ? { id: CALL_ID } : {}),
          function: { name: TOOL.name, arguments: args.slice(0, 7) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, ...(!bigmodel ? { id: CALL_ID } : {}),
          function: { arguments: args.slice(7) } }] } }] },
        { choices: [{ delta: {}, finish_reason: TERMINAL[protocol] }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 },
          ...(bigmodel ? { completion_tokens_details: { reasoning_tokens: 2 } } : {}) } },
        { choices: [], usage: {} },
        sseData("[DONE]"),
      ]
    case "responses": {
      const thought = { type: "reasoning", id: "reasoning_item" }
      const answer = { type: "message", id: "message_item", role: "assistant" }
      const call = { type: "function_call", id: "tool_item", call_id: CALL_ID, name: TOOL.name }
      const finished = { ...call, status: "completed", arguments: args }
      return [
        { type: "response.output_item.added", output_index: 0, item: thought },
        { type: "response.output_item.added", output_index: 1, item: answer },
        { type: "response.reasoning_text.delta", output_index: 0, item_id: thought.id, delta: THINKING.slice(0, 6) },
        { type: "response.output_text.delta", output_index: 1, content_index: 0, item_id: answer.id, delta: TEXT },
        { type: "response.reasoning_text.done", output_index: 0, item_id: thought.id, text: THINKING },
        { type: "response.output_item.done", output_index: 0, item: { ...thought, status: "completed" } },
        { type: "response.output_item.done", output_index: 1, item: { ...answer, status: "completed" } },
        { type: "response.output_item.added", output_index: 2, item: { ...call, status: "in_progress", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 2, item_id: call.id, delta: args.slice(0, 7) },
        { type: "response.function_call_arguments.done", output_index: 2, item_id: call.id, name: TOOL.name, arguments: args },
        { type: "response.output_item.done", output_index: 2, item: finished },
        { type: "response.completed", response: { status: "completed", output: [], usage: {
          input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15,
        } } },
      ].map((event, sequence_number) => sseEvent(event.type, { ...event, sequence_number }))
    }
    case "anthropic_messages":
      return [
        { type: "message_start", message: { usage: { input_tokens: 6, output_tokens: 0,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 4 } } },
        { type: "content_block_start", index: 4, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 4, delta: { type: "thinking_delta", thinking: THINKING } },
        { type: "content_block_delta", index: 4, delta: { type: "signature_delta", signature: "signed-" } },
        { type: "content_block_delta", index: 4, delta: { type: "signature_delta", signature: "thought" } },
        { type: "content_block_stop", index: 4 },
        { type: "content_block_start", index: 5, content_block: { type: "redacted_thinking", data: "redacted-data" } },
        { type: "content_block_stop", index: 5 },
        { type: "content_block_start", index: 6, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 6, delta: { type: "text_delta", text: TEXT } },
        { type: "content_block_stop", index: 6 },
        { type: "content_block_start", index: 9, content_block: { type: "tool_use", id: CALL_ID, name: TOOL.name, input: {} } },
        { type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: args.slice(0, 7) } },
        { type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: args.slice(7) } },
        { type: "content_block_stop", index: 9 },
        { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 2 } },
        { type: "message_delta", delta: { stop_reason: TERMINAL[protocol] }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ].map((event) => sseEvent(event.type, event))
  }
}

/**
 * 用实际 SDK 请求本地 Coding Plan 替身，核对请求地址、工具续接和明文思考。
 * @param model 对应 Coding Plan 目录的运行时模型配置。
 * @param providerName 本轮对应的平台 Provider 名称。
 * @param pathname 目录所配置的 baseURL 路径前缀。
 * @returns SDK 往返、摘要请求和断流断言完成后返回。
 * @throws 本地 I/O 或断言失败时拒绝。
 */
async function verifyProtocol(model: ModelConfig, providerName: string, pathname: string): Promise<void> {
  const { protocol } = model
  const bigmodel = providerName.startsWith("BigModel")
  const events = sample(protocol, bigmodel)
  const provider = await startFakeProvider((_request, attempt) => {
    if (attempt === 0) return { status: 500 }
    if (attempt === 4) return { events: events.slice(0, protocol === "chat_completions" ? 2 : 3) }
    return { events }
  })
  try {
    const adapter = createModelAdapter(model, { apiKey: "glm-test-key", baseURL: `${provider.origin}${pathname}`,
      defaultHeaders: { "x-minou-glm-test": "configured" } }, providerName)
    const request: UnifiedModelRequest = {
      model: { providerId: model.providerId, modelId: model.modelId, name: model.name, protocol, reasoningLevel: "high" },
      tools: [],
      context: { history: { system: "系统提示。", mcpBaseline: [TOOL], events: [
        { seq: 1, type: "user/message", content: [{ type: "text", text: "查询日期。" }] },
      ] } },
    }
    const signal = new AbortController().signal
    const first = await collect(adapter.stream(request, signal))
    const end = first.at(-1)
    assert.ok(end?.type === "stream_end")
    assert.equal(first.filter((event) => event.type === "stream_end").length, 1)
    assert.equal(end.completion, "tool_calls")
    assert.equal(end.finishReason, TERMINAL[protocol])
    assert.deepEqual(end.usage, {
      inputTokens: protocol === "chat_completions" ? 10 : 6, outputTokens: 5, totalTokens: 15,
      cacheReadTokens: protocol === "chat_completions" ? 0 : 4,
      ...(protocol === "anthropic_messages" ? { cacheWriteTokens: 0 } : {}),
      ...(protocol === "responses" ? { reasoningTokens: 0 } : protocol === "chat_completions" && bigmodel ? { reasoningTokens: 2 } : {}),
    })
    assert.deepEqual(first.flatMap((event) => event.type === "block_start" ? [event.index] : []), [0, 1, 2])
    assert.deepEqual(first.flatMap((event) => event.type === "block_end" ? [event.index] : []), [0, 1, 2])
    assert.ok(first.every((event) => event.type !== "block_delta" || event.delta.type !== "tool_call" || event.delta.toolCallId === CALL_ID))
    const blocks = first.flatMap((event) => event.type === "block_end" ? [event.block] : [])
    assert.deepEqual(blocks, [
      { type: "thinking", text: THINKING }, { type: "text", text: TEXT },
      { type: "tool_call", toolCallId: CALL_ID, name: TOOL.name, arguments: ARGUMENTS },
    ])

    const metadata = { name: "Other", protocol: "anthropic_messages", payloadJson: '{"type":"thinking","thinking":"载荷文本","signature":"签名"}' } as const
    const followingBlocks: AssistantContentBlock[] = [
      { ...blocks[1], replay: metadata },
      { type: "thinking", text: HISTORY_THINKING, replay: metadata },
      { type: "thinking", text: "", replay: { ...metadata, protocol: "responses", name: "GLM",
        payloadJson: '{"type":"reasoning","content":{"type":"reasoning_text","text":"空思考的载荷文本"}}' } },
      blocks[0],
      { type: "thinking", text: MALFORMED_PAYLOAD_THINKING, replay: { name: "GLM", protocol, payloadJson: "invalid json" } },
      { ...blocks[2], replay: metadata },
    ]
    const outcome = { type: "text" as const, text: "查询结果。" }
    assert.ok(request.context.history)
    request.context.history.events.push(
      { seq: 2, type: "assistant/message", content: followingBlocks, finishReason: end.finishReason },
      { seq: 3, type: "tool/result", turn: 1, step: 1, toolCallEventId: "event-id", toolCallId: CALL_ID, content: [outcome], isError: false },
    )
    await collect(adapter.stream(request, signal, { retry: false }))
    const [failed, initial, continued] = provider.requests
    assert.deepEqual(failed.body, initial.body)
    assert.equal(continued.path, pathname + PATH[protocol])
    assert.equal(continued.headers["x-minou-glm-test"], "configured")
    assert.equal(continued.headers[protocol === "anthropic_messages" ? "x-api-key" : "authorization"],
      protocol === "anthropic_messages" ? "glm-test-key" : "Bearer glm-test-key")
    const { body } = continued
    assert.equal(body.model, model.name)
    assert.equal(body.stream, true)
    assert.equal(body[protocol === "responses" ? "max_output_tokens" : "max_tokens"], model.maxOutputTokens)

    switch (protocol) {
      case "chat_completions":
        assert.deepEqual(body.thinking, { clear_thinking: false })
        assert.equal(body.reasoning_effort, "high")
        assert.equal(body.stream_options, undefined)
        assert.deepEqual((body.messages as unknown[]).slice(-2), [
          { role: "assistant", content: TEXT, reasoning_content: HISTORY_THINKING + THINKING + MALFORMED_PAYLOAD_THINKING, tool_calls: [{ id: CALL_ID, type: "function",
            function: { name: TOOL.name, arguments: JSON.stringify(ARGUMENTS) } }] },
          { role: "tool", tool_call_id: CALL_ID, content: outcome.text },
        ])
        break
      case "responses":
        assert.equal(body.store, false)
        assert.equal(body.previous_response_id, undefined)
        assert.deepEqual(body.reasoning, { effort: "high" })
        assert.deepEqual(body.input, [
          { type: "message", role: "user", content: "查询日期。" },
          { type: "message", role: "assistant", content: TEXT },
          { type: "reasoning", content: { type: "reasoning_text", text: HISTORY_THINKING } },
          { type: "reasoning", content: { type: "reasoning_text", text: THINKING } },
          { type: "reasoning", content: { type: "reasoning_text", text: MALFORMED_PAYLOAD_THINKING } },
          { type: "function_call", call_id: CALL_ID, name: TOOL.name, arguments: JSON.stringify(ARGUMENTS) },
          { type: "function_call_output", call_id: CALL_ID, output: outcome.text },
        ])
        break
      case "anthropic_messages":
        assert.deepEqual(body.output_config, { effort: "high" })
        assert.deepEqual((body.messages as unknown[]).slice(-2), [
          { role: "assistant", content: [{ type: "text", text: TEXT }, { type: "tool_use", id: CALL_ID, name: TOOL.name, input: ARGUMENTS }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: CALL_ID, content: outcome.text }] },
        ])
        break
    }
    assert.equal((body.tools as unknown[]).length, 1)

    const summary = await collect(adapter.stream({ ...request, context: { purpose: "summary", messages: [
      { role: "system", content: "总结对话。" }, { role: "assistant", content: followingBlocks.slice(0, -1) },
    ] } }, signal, { retry: false }))
    assert.ok(summary.every((event) => event.type !== "block_end" || event.block.replay === undefined))
    const summaryBody = JSON.stringify(provider.requests[3].body)
    for (const text of [HISTORY_THINKING, THINKING, MALFORMED_PAYLOAD_THINKING]) {
      assert.ok(!summaryBody.includes(JSON.stringify(text).slice(1, -1)))
    }

    const interrupted: ModelStreamEvent[] = []
    await assert.rejects(async () => {
      for await (const event of adapter.stream(request, signal, { retry: false })) interrupted.push(event)
    }, { code: "REQUEST_FAILED", message: /结束事件前中断/ })
    assert.ok(interrupted.every((event) => event.type !== "stream_end" && (event.type !== "block_end" || event.block.replay === undefined)))
  } finally {
    await provider.close()
  }
}

/**
 * 构造错误、取消及回退测试共用的最小会话。
 * @param protocol 本轮协议。
 * @param name 可触发大小写匹配的 API 模型名。
 * @returns 一致的模型配置与请求。
 */
function fixture(protocol: Protocol, name = "GLM-5.3"): { config: ModelConfig; request: UnifiedModelRequest } {
  const model = { providerId: "provider-test", modelId: "model-test", name, protocol }
  return {
    config: { ...model, contextWindow: 10000, maxOutputTokens: 1000, supportsReasoning: false,
      reasoningLevels: ["none"], reasoningField: { path: ["reasoning_effort"] } },
    request: { model: { ...model, reasoningLevel: "none" }, tools: [], context: { messages: [
      { role: "system", content: "系统提示。" }, { role: "user", content: "问候。" },
    ] } },
  }
}

/**
 * 检查协议错误在已解包和原始形态下均交给共享网关归一化。
 * @returns HTTP 与 SSE 错误场景执行完毕。
 * @throws 错误码、状态码、请求 ID 或消息不符时拒绝。
 */
async function verifyErrors(): Promise<void> {
  const bigCode = { error: { code: "1210", message: "BigModel 参数错误" } }
  const zaiCode = { error: { code: 1302, message: "Z.AI 限流" } }
  const responseFailure = { type: "response.failed", response: { status: "failed", request_id: "failed-request",
    error: { code: "invalid_prompt", message: "Responses 失败" } } }
  const standalone = { type: "error", code: "server_error", message: "Responses 独立错误" }
  const messagesError = { type: "error", error: { type: "overloaded_error", message: "Messages 过载" } }
  const cases: { protocol: Protocol; provider: string; plan: FakeResponse; message: string; details: object }[] = [
    { protocol: "chat_completions", provider: " BigModel API ", plan: { status: 422, errorBody: bigCode,
      headers: { "x-request-id": "big-request" } }, message: bigCode.error.message,
      details: { status: 422, providerCode: "1210", requestId: "big-request" } },
    { protocol: "chat_completions", provider: "  Zai ", plan: { status: 429, errorBody: zaiCode,
      headers: { "x-request-id": "zai-request" } }, message: zaiCode.error.message,
      details: { status: 429, providerCode: "1302", requestId: "zai-request" } },
    { protocol: "chat_completions", provider: "Z.AI API", plan: { events: [{ error: { code: "1211", message: "模型不可用" } }] },
      message: "模型不可用", details: { providerCode: "1211" } },
    { protocol: "chat_completions", provider: "Z.AI Coding Plan", plan: { events: [zaiCode] },
      message: zaiCode.error.message, details: { providerCode: "1302" } },
    { protocol: "chat_completions", provider: "Custom Relay", plan: { status: 422, errorBody: zaiCode,
      headers: { "x-request-id": "relay-request" } }, message: zaiCode.error.message,
      details: { status: 422, requestId: "relay-request" } },
    { protocol: "responses", provider: "BigModel Coding Plan", plan: { events: [sseEvent(responseFailure.type, responseFailure)] },
      message: responseFailure.response.error.message, details: { providerCode: "invalid_prompt", requestId: "failed-request" } },
    { protocol: "responses", provider: "Z.AI Coding Plan", plan: { events: [sseEvent(standalone.type, standalone)],
      headers: { "x-request-id": "sse-request" } }, message: standalone.message,
      details: { providerCode: "server_error", requestId: "sse-request" } },
    { protocol: "anthropic_messages", provider: "Z.AI Coding Plan", plan: { events: [sseEvent(messagesError.type, messagesError)],
      headers: { "request-id": "messages-request" } }, message: messagesError.error.message,
      details: { providerCode: "overloaded_error", requestId: "messages-request" } },
  ]
  for (const provider of ["BigModel", "Z.AI"]) {
    cases.push({ protocol: "chat_completions", provider, plan: { events: [
      { choices: [{ delta: {}, finish_reason: "network_error" }], request_id: "network-request" }, sseData("[DONE]"),
    ] }, message: "GLM Chat Completions 流以 network_error 结束", details: { providerCode: "network_error", requestId: "network-request" } })
  }
  for (const scenario of cases) {
    const server = await startFakeProvider(scenario.plan)
    try {
      const { config, request } = fixture(scenario.protocol)
      const adapter = createModelAdapter(config, { apiKey: "test", baseURL: server.baseURL(scenario.protocol) }, scenario.provider)
      assert.deepEqual(await collectError(adapter.stream(request, new AbortController().signal, { retry: false })), {
        source: "model", code: "REQUEST_FAILED", message: scenario.message, details: scenario.details,
      })
    } finally {
      await server.close()
    }
  }

  for (const providerName of ["BigModel", "Z.AI"]) {
    const { config, request } = fixture("chat_completions")
    const raw = { protocol: config.protocol, events: streamOf([providerName === "BigModel" ? bigCode : zaiCode]) } as ProtocolResponseStream
    const error = await collectError(new GLMAdapter().mapResponseStream(raw, request, { modelConfig: config, providerName }))
    assert.equal(normalizeModelError(error).details?.providerCode, providerName === "BigModel" ? "1210" : "1302")
  }
}

/**
 * 验证通用缓存回退、关闭的思考档位、未完成的思考和网关取消。
 * @returns 边界用例执行完毕。
 * @throws Usage、块生命周期或取消状态与预期不符时拒绝。
 */
async function verifyBoundaries(): Promise<void> {
  const { config, request } = fixture("chat_completions")
  const server = await startFakeProvider((_request, attempt) => {
    if (attempt === 0) return { events: [
      { choices: [{ delta: { reasoning_content: "未完成" }, finish_reason: "length" }] },
      { choices: [], usage: { prompt_tokens: 10, cached_tokens: 4, completion_tokens: 2 } },
      sseData("[DONE]"),
    ] }
    return { events: [{ choices: [{ delta: { content: "取消之前" }, finish_reason: null }] }], hang: true }
  })
  try {
    const adapter = createModelAdapter(config, { apiKey: "test", baseURL: server.origin }, "Custom Relay")
    const events = await collect(adapter.stream(request, new AbortController().signal, { retry: false }))
    assert.deepEqual(events.at(-1), { type: "stream_end", completion: "incomplete", finishReason: "length",
      usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12 } })
    assert.deepEqual(events.at(-2), { type: "block_end", index: 0, block: { type: "thinking", text: "未完成" } })

    const controller = new AbortController()
    await assert.rejects(async () => {
      for await (const event of adapter.stream(request, controller.signal)) {
        if (event.type === "block_delta") controller.abort()
      }
    }, { code: "CANCELLED" })
    assert.equal(server.requests.length, 2)
  } finally {
    await server.close()
  }

  const converter = new GLMAdapter()
  const disabled = converter.buildRequest({ ...request, model: { ...request.model, reasoningLevel: "disabled" }, context: { messages: [
    { role: "system", content: "系统提示。" }, { role: "assistant", content: [{ type: "thinking", text: THINKING, replay: {
      name: "GLM", protocol: "chat_completions", payloadJson: JSON.stringify({ reasoning_content: THINKING }),
    } }] },
  ] } }, { modelConfig: { ...config, supportsReasoning: true, reasoningLevels: ["disabled"], reasoningField: { path: ["thinking", "type"] } } })
  assert.ok(disabled.protocol === "chat_completions")
  assert.deepEqual(disabled.params.messages, [{ role: "system", content: "系统提示。" }])
  assert.deepEqual(Reflect.get(disabled.params, "thinking"), { type: "disabled" })

  const responses = fixture("responses")
  const raw = { protocol: "responses", events: streamOf([
    { type: "response.reasoning_text.delta", output_index: 0, delta: "部分思考" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: {} } },
  ]) } as ProtocolResponseStream
  const events = await collect(converter.mapResponseStream(raw, responses.request, { modelConfig: responses.config }))
  assert.deepEqual(events.slice(-2), [
    { type: "block_end", index: 0, block: { type: "thinking", text: "部分思考" } },
    { type: "stream_end", completion: "incomplete", finishReason: "max_output_tokens" },
  ])
}

/**
 * 使用现有 Node 测试入口验证 GLM 转换器和本地 SDK 集成。
 * @returns 全部断言通过后完成。
 * @throws 任一场景断言或本地服务失败时拒绝。
 */
async function main(): Promise<void> {
  for (const [name, platforms] of [["BigModel Coding Plan", BIGMODEL_CODING_PLAN_PROVIDERS],
    ["Z.AI Coding Plan", ZAI_CODING_PLAN_PROVIDERS]] as const) {
    assert.equal(platforms.length, 3)
    for (const { protocol, url, models } of platforms) {
      const model = models.find((candidate) => candidate.name === "glm-5.3")
      assert.ok(model?.reasoningLevels && model.reasoningField)
      await verifyProtocol({ ...model, protocol, modelId: "glm-test", providerId: name,
        reasoningLevels: model.reasoningLevels, reasoningField: model.reasoningField }, name, new URL(url).pathname)
    }
  }
  await verifyErrors()
  await verifyBoundaries()
  console.log("glm.test.ts: GLM 三协议本地 SDK 与明文思考断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
