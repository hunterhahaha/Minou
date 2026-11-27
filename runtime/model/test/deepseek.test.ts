import assert from "node:assert/strict"

import { DEEPSEEK_PROVIDERS } from "../../../src/main/compatible-providers/deepseek.ts"
import { CANCELLED } from "../../error/src/normalizer.ts"
import { createModelAdapter } from "../src/gateway/adapter.ts"
import { MODEL_ADAPTER_REGISTRY, resolveModelConverter } from "../src/gateway/adapter-router.ts"
import { DeepSeekAdapter } from "../src/gateway/deepseek-adapter.ts"
import type { ModelConfig, ModelMessage, Protocol, UnifiedModelRequest } from "../src/types.ts"
import { collect, collectError, sseData, sseEvent, startFakeProvider } from "./helpers.ts"

const TOOL = { name: "lookup", inputSchema: { type: "object" } }
const THINKING = "查找日期。"
const TEXT = "我来查一下。"
const CALL_ID = "call_test"
const TOOL_INPUT = { city: "Singapore" }
const USAGE = { inputTokens: 6, cacheReadTokens: 4, outputTokens: 5, totalTokens: 15 }

/**
 * 构造与官方示例形状一致的思考、文本、工具调用和终态 SSE。
 * @param protocol 当前假端点的协议。
 * @returns 一份包含完整工具调用的响应脚本。
 */
function toolResponse(protocol: Protocol): (string | object)[] {
  switch (protocol) {
    case "chat_completions":
      return [
        { choices: [{ delta: { reasoning_content: THINKING }, finish_reason: null }], usage: null },
        { choices: [{ delta: { content: TEXT }, finish_reason: null }], usage: null },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: CALL_ID, type: "function", function: {
          name: TOOL.name, arguments: JSON.stringify(TOOL_INPUT),
        } }] }, finish_reason: null }], usage: null },
        {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 5, total_tokens: 15 },
        },
        sseData("[DONE]"),
      ]
    case "responses": {
      const thinking = { type: "reasoning", id: "reasoning_1" }
      const message = { type: "message", id: "message_1", role: "assistant" }
      const call = { type: "function_call", id: "function_1", call_id: CALL_ID, name: TOOL.name }
      const completedCall = { ...call, arguments: JSON.stringify(TOOL_INPUT), status: "completed" }
      return [
        { type: "response.output_item.added", item: thinking },
        { type: "response.output_item.done", item: { ...thinking, content: [{ type: "reasoning_text", text: THINKING }] } },
        { type: "response.output_item.added", item: message },
        { type: "response.output_text.delta", item_id: message.id, delta: TEXT },
        { type: "response.output_item.done", item: message },
        { type: "response.output_item.added", item: { ...call, arguments: "", status: "in_progress" } },
        { type: "response.function_call_arguments.delta", item_id: call.id, delta: completedCall.arguments },
        { type: "response.output_item.done", item: completedCall },
        { type: "response.completed", response: { status: "completed", output: [completedCall], usage: {
          input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 5, total_tokens: 15,
        } } },
      ].map((event, sequence_number) => sseEvent(event.type, { ...event, sequence_number }))
    }
    case "anthropic_messages":
      return [
        { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "deepseek-signature" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: TEXT } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: CALL_ID, name: TOOL.name, input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: JSON.stringify(TOOL_INPUT) } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {
          input_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, output_tokens: 5,
        } },
        { type: "message_stop" },
      ].map((event) => sseEvent(event.type, event))
  }
}

/**
 * 验证实际 SDK 请求和同一会话的历史回放，以及独立请求的禁用思考配置。
 * @param model 从供应商资料构造的运行时模型配置。
 * @returns 本协议的离线验证结束时完成。
 * @throws 断言、网络错误或清理失败时拒绝。
 */
async function verifyProtocol(model: ModelConfig): Promise<void> {
  const { protocol } = model
  const path = { chat_completions: "/chat/completions", responses: "/responses", anthropic_messages: "/anthropic/v1/messages" }[protocol]
  const vendor = resolveModelConverter(MODEL_ADAPTER_REGISTRY, model, "relay")
  assert.ok(vendor instanceof DeepSeekAdapter)
  for (const name of ["DeepSeek", "deepseek", "Deepseek", "  dEePsEeK "]) {
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...model, name: "renamed-model" }, name), vendor)
  }
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...model, name: "DeepSeek-flash" }, "relay"),
    MODEL_ADAPTER_REGISTRY.genericByProtocol[protocol])

  const events = toolResponse(protocol)
  const provider = await startFakeProvider((_request, attempt) => {
    if (attempt === 1) return { status: 500 }
    if (attempt === 4) return { events: events.slice(0, 1) }
    if (attempt === 5) return { events: events.slice(0, 3), hang: true }
    if (attempt === 6 && protocol === "chat_completions") return { events: [
      ...events.slice(0, 3), { choices: [{ delta: {}, finish_reason: "insufficient_system_resource" }] }, sseData("[DONE]"),
    ] }
    return { events }
  })
  const signal = new AbortController().signal
  try {
    const adapter = createModelAdapter(model, {
      apiKey: "mock-key",
      baseURL: protocol === "anthropic_messages" ? `${provider.origin}/anthropic` : provider.origin,
    }, "relay")
    const request: UnifiedModelRequest = {
      model: { providerId: model.providerId, modelId: model.modelId, name: model.name, protocol, reasoningLevel: "high" },
      tools: [],
      context: { history: { system: "查找日期。", mcpBaseline: [TOOL], events: [
        { type: "user/message", seq: 1, content: [{ type: "text", text: "新加坡的日期？" }] },
      ] } },
    }
    const first = await collect(adapter.stream(request, signal))
    const end = first.at(-1)
    assert.ok(end?.type === "stream_end")
    assert.equal(end.completion, "tool_calls")
    assert.equal(end.finishReason, { chat_completions: "tool_calls", responses: "completed", anthropic_messages: "tool_use" }[protocol])
    assert.deepEqual(end.usage, protocol === "anthropic_messages" ? { ...USAGE, cacheWriteTokens: 0 } : USAGE)
    const blocks = first.flatMap((event) => event.type === "block_end" ? [event.block] : [])
    assert.deepEqual(blocks.map(({ replay: _replay, ...block }) => block), [
      { type: "thinking", text: THINKING },
      { type: "text", text: TEXT },
      { type: "tool_call", toolCallId: CALL_ID, name: TOOL.name, arguments: TOOL_INPUT },
    ])

    assert.ok(request.context.history)
    request.context.history.events.push(
      { type: "assistant/message", seq: 2, content: blocks, finishReason: end.finishReason },
      { type: "tool/result", seq: 3, turn: 1, step: 1, toolCallEventId: "block-test", toolCallId: CALL_ID,
        content: [{ type: "text", text: "11 月 27 日" }], isError: false },
      { type: "assistant/message", seq: 4, finishReason: "stop", content: [
        { type: "thinking", text: "已核对日期。" }, { type: "text", text: "结果已找到。" },
      ] },
      { type: "user/message", seq: 5, content: [{ type: "text", text: "请再确认。" }] },
    )
    await collect(adapter.stream(request, signal))
    const [initial, failed, retried] = provider.requests
    assert.equal(initial.path, path)
    assert.equal(initial.headers[protocol === "anthropic_messages" ? "x-api-key" : "authorization"],
      protocol === "anthropic_messages" ? "mock-key" : "Bearer mock-key")
    assert.deepEqual(failed.body, retried.body)
    const body = retried.body
    if (protocol === "chat_completions") {
      assert.deepEqual(body.thinking, { type: "enabled" })
      assert.equal(body.reasoning_effort, "high")
      assert.equal(body.max_tokens, model.maxOutputTokens)
      assert.deepEqual((body.messages as unknown[]).slice(-4), [
        { role: "assistant", content: TEXT, reasoning_content: THINKING, tool_calls: [{ id: CALL_ID, type: "function",
          function: { name: TOOL.name, arguments: JSON.stringify(TOOL_INPUT) } }] },
        { role: "tool", tool_call_id: CALL_ID, content: "11 月 27 日" },
        { role: "assistant", content: "结果已找到。", reasoning_content: "已核对日期。" },
        { role: "user", content: "请再确认。" },
      ])
    } else if (protocol === "responses") {
      assert.deepEqual(body.reasoning, { effort: "high" })
      assert.equal(body.store, undefined)
      assert.equal(body.max_output_tokens, model.maxOutputTokens)
      assert.deepEqual((body.input as unknown[]).slice(1, 5), [
        { type: "reasoning", content: [{ type: "reasoning_text", text: THINKING }] },
        { role: "assistant", content: TEXT },
        { type: "function_call", call_id: CALL_ID, name: TOOL.name, arguments: JSON.stringify(TOOL_INPUT) },
        { type: "function_call_output", call_id: CALL_ID, output: "11 月 27 日" },
      ])
    } else {
      assert.deepEqual(body.thinking, { type: "enabled" })
      assert.deepEqual(body.output_config, { effort: "high" })
      assert.deepEqual(body.tools, [{ name: TOOL.name, input_schema: TOOL.inputSchema }])
      assert.deepEqual((body.messages as unknown[]).slice(1, 3), [
        { role: "assistant", content: [
          { type: "thinking", thinking: THINKING, signature: "deepseek-signature" },
          { type: "text", text: TEXT },
          { type: "tool_use", id: CALL_ID, name: TOOL.name, input: TOOL_INPUT },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: CALL_ID, content: "11 月 27 日" }] },
      ])
      const history = request.context.history
      const foreignHistory = { ...history, events: history.events.map((event) => event.type === "assistant/message" ? {
        ...event, content: event.content.map((block) => block.replay ? {
          ...block, replay: { ...block.replay, name: "anthropic" },
        } : block),
      } : event) }
      const outbound = vendor.buildRequest({ ...request, context: { history: foreignHistory } }, { modelConfig: model })
      assert.ok(!JSON.stringify(outbound.params).includes("deepseek-signature"))
    }

    const messages: ModelMessage[] = [
      { role: "system", content: "摘要任务" },
      { role: "assistant", content: blocks },
      { role: "tool", toolCallId: CALL_ID, content: [{ type: "text", text: "11 月 27 日" }], isError: false },
      { role: "user", content: "请总结。" },
    ]
    const noTools: UnifiedModelRequest = { ...request, tools: [], context: { messages } }
    if (protocol === "chat_completions") {
      const outbound = vendor.buildRequest(noTools, { modelConfig: model })
      assert.ok(!JSON.stringify(outbound.params).includes(THINKING))
    }
    const summary: UnifiedModelRequest = {
      ...noTools, model: { ...noTools.model, reasoningLevel: "none" },
      context: { messages, purpose: "summary" },
    }
    await collect(adapter.stream(summary, signal))
    const summaryBody = provider.requests[3].body
    assert.ok(!JSON.stringify(summaryBody).includes(THINKING))
    if (protocol === "responses") assert.deepEqual(summaryBody.reasoning, { effort: "none" })
    else assert.deepEqual(summaryBody.thinking, { type: "disabled" })

    const disabled = vendor.buildRequest(request, { modelConfig: { ...model, supportsReasoning: false } })
    if (disabled.protocol === "responses") assert.equal(disabled.params.reasoning?.effort, "none")
    else assert.equal((disabled.params as { thinking?: { type: string } }).thinking?.type, "disabled")

    const interrupted = await collectError(adapter.stream(request, signal, { retry: false }))
    assert.match(String((interrupted as { message?: string }).message), /中断/)

    const controller = new AbortController()
    await assert.rejects(async () => {
      for await (const event of adapter.stream(request, controller.signal)) {
        if (event.type === "block_delta") controller.abort()
      }
    }, { code: CANCELLED })
    assert.equal(provider.requests.length, 6)
    if (protocol === "chat_completions") {
      const incomplete = await collect(adapter.stream(request, signal))
      assert.deepEqual(incomplete.at(-1), {
        type: "stream_end", completion: "incomplete", finishReason: "insufficient_system_resource",
      })
      assert.ok(!incomplete.some((event) => event.type === "block_end" && event.block.type === "tool_call"))
    }
  } finally {
    await provider.close()
  }
}

/** 逐个验证内置 DeepSeek 端点的适配器分支。 */
async function main(): Promise<void> {
  for (const provider of DEEPSEEK_PROVIDERS) {
    const model = provider.models[0]
    assert.ok(model.reasoningField && model.reasoningLevels)
    await verifyProtocol({
      ...model, protocol: provider.protocol, providerId: "relay", modelId: "test",
      reasoningField: model.reasoningField, reasoningLevels: [...model.reasoningLevels, "none"],
    })
  }
  console.log("DeepSeek Adapter 三种协议测试通过")
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
