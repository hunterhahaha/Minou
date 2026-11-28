import assert from "node:assert/strict"

import { createModelAdapter } from "../src/gateway/adapter.ts"
import type { ProtocolRequest } from "../src/gateway/adapter.ts"
import { AdapterRoutingError, MODEL_ADAPTER_REGISTRY, resolveModelConverter } from "../src/gateway/adapter-router.ts"
import { MiniMaxAdapter } from "../src/gateway/minimax-adapter.ts"
import type {
  AssistantContentBlock, BlockReplay, ModelConfig, ModelStreamEvent, UnifiedModelRequest,
} from "../src/types.ts"
import { collect, collectError, sseData, sseEvent, startFakeProvider } from "./helpers.ts"

const PROTOCOLS = ["responses", "chat_completions"] as const
const TOOL = { name: "look_up", description: "Look up a city", inputSchema: { type: "object" } }
const SIGNAL = new AbortController().signal
const HISTORY_CALL = { type: "tool_call", toolCallId: "history-call", name: TOOL.name, arguments: { city: "A" } } as const

/** 流式样本覆盖完整增量、仅完成项、部分增量和空思考项。 */
const THINKING_FIRST = {
  type: "reasoning", id: "reason-first", summary: [],
  content: [{ type: "reasoning_text", text: "first" }],
}
const MESSAGE = { type: "message", role: "assistant", id: "message", content: [{ type: "output_text", text: "answer" }] }
const THINKING_SECOND = {
  type: "reasoning", id: "reason-second", summary: [],
  content: [{ type: "reasoning_text", text: "next" }, { type: "reasoning_text", text: " step" }],
}
const THINKING_EMPTY = { type: "reasoning", id: "reason-empty", summary: [], content: [] }
const RESPONSE_CALL = {
  type: "function_call", id: "response-tool-item", call_id: "response-call", name: TOOL.name, arguments: '{"city":"B"}',
}
const THINKING_LAST = {
  type: "reasoning", id: "reason-last", summary: [], content: [{ type: "reasoning_text", text: "last step" }],
}

/** 模拟 Responses 的 SSE event 行及与之对应的 JSON。 */
const RESPONSES = [
  { type: "response.output_item.added", output_index: 0, item: { ...THINKING_FIRST, content: [] } },
  { type: "response.reasoning_text.delta", output_index: 0, item_id: THINKING_FIRST.id, delta: "fir" },
  { type: "response.output_text.delta", output_index: 1, item_id: MESSAGE.id, delta: "answer" },
  { type: "response.reasoning_text.delta", output_index: 0, item_id: THINKING_FIRST.id, delta: "st" },
  { type: "response.output_item.done", output_index: 0, item: THINKING_FIRST },
  { type: "response.output_item.done", output_index: 1, item: MESSAGE },
  { type: "response.output_item.done", output_index: 2, item: THINKING_SECOND },
  { type: "response.output_item.added", output_index: 3, item: THINKING_EMPTY },
  { type: "response.reasoning_text.delta", output_index: 3, item_id: THINKING_EMPTY.id, delta: "" },
  { type: "response.output_item.done", output_index: 3, item: THINKING_EMPTY },
  { type: "response.output_item.added", output_index: 4, item: { ...RESPONSE_CALL, arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 4, item_id: RESPONSE_CALL.id, delta: '{"city":' },
  { type: "response.function_call_arguments.delta", output_index: 4, item_id: RESPONSE_CALL.id, delta: '"B"}' },
  { type: "response.output_item.done", output_index: 4, item: RESPONSE_CALL },
  { type: "response.reasoning_text.delta", output_index: 5, item_id: THINKING_LAST.id, delta: "last" },
  { type: "response.output_item.done", output_index: 5, item: THINKING_LAST },
  { type: "response.completed", response: {
    status: "completed",
    output: [THINKING_FIRST, MESSAGE, THINKING_SECOND, THINKING_EMPTY, RESPONSE_CALL, THINKING_LAST],
    usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40,
      input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 3 } },
  } },
].map((event, sequence_number) => sseEvent(event.type, { ...event, sequence_number }))

/**
 * 构造 MiniMax Chat Completions 的单 choice 分片。
 * @param delta 思考、正文或工具调用的分片。
 * @param finish_reason 上游给出的结束原因，生成中为 null。
 * @returns 假 Provider 可发送的 JSON。
 */
function chunk(delta: object, finish_reason: string | null = null): object {
  return { choices: [{ index: 0, delta, finish_reason }] }
}

/** 工具参数交错到达，最新的 Usage 来自空 choices。 */
const CHAT = [
  chunk({ reasoning_content: "" }),
  chunk({ reasoning_content: "first" }),
  chunk({ reasoning_content: " thought", content: "ans" }),
  chunk({ content: "wer" }),
  chunk({ tool_calls: [{ index: 0, id: "call-b", function: { name: "look_", arguments: '{"city":' } }] }),
  chunk({ tool_calls: [{ index: 1, id: "call-c", function: { name: TOOL.name, arguments: '{"city":"C"}' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { name: "up", arguments: '"B"}' } }] }),
  { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 1, completion_tokens: 1 } },
  { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40,
    prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 3 } } },
  sseData("[DONE]"),
]

/**
 * 构造本轮配置和事件历史，思考块可携带任意回放夹具。
 * @param protocol 本轮测试协议。
 * @param replay 添加到非空和空 thinking 块上的原生回放。
 * @returns 与请求匹配的完整模型配置和带工具历史的统一请求。
 */
function fixture(protocol: typeof PROTOCOLS[number], replay?: BlockReplay): {
  config: ModelConfig; request: UnifiedModelRequest
} {
  const config: ModelConfig = {
    protocol, modelId: "model", providerId: "provider", name: "MiniMax-M3.1-Flash",
    contextWindow: 1_000_000, maxOutputTokens: 4096, supportsReasoning: true,
    reasoningLevels: ["high"], reasoningField: { path: ["fixture_effort"] },
  }
  const thinking = (text: string): AssistantContentBlock => ({ type: "thinking", text, ...(replay ? { replay } : {}) })
  const request: UnifiedModelRequest = {
    model: { ...config, reasoningLevel: "high" }, tools: [],
    context: { history: { system: "system", mcpBaseline: [TOOL], events: [
      { type: "user/message", seq: 1, content: [{ type: "text", text: "query" }] },
      { type: "assistant/message", seq: 2, content: [
        thinking("first"), { type: "text", text: "answer" }, thinking(""), HISTORY_CALL, thinking(" \n"), thinking("next"),
      ] },
      { type: "tool/result", seq: 3, turn: 1, step: 1, toolCallId: HISTORY_CALL.toolCallId, toolCallEventId: "call-event",
        content: [{ type: "text", text: "result" }], isError: false },
      { type: "assistant/message", seq: 4, content: [thinking("")] },
    ] } },
  }
  return { config, request }
}

/** 验证两个协议的名称优先匹配、模型名规则和推理配置。 */
function verifyRoutingAndRequests(): void {
  const vendor = resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "unrelated", protocol: "responses" }, "MiniMax")
  assert.ok(vendor instanceof MiniMaxAdapter)
  for (const protocol of PROTOCOLS) {
    for (const providerName of ["MiniMax 国内", "MiniMax 国际", " MINIMAX 国内 ", " minimax 国际 ", "miNIMax"]) {
      assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "unrelated", protocol }, providerName), vendor)
    }
    for (const name of ["MiniMax-relay", "minimax-relay", "MINIMAX-relay"]) {
      assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name, protocol }, "relay"), vendor)
    }
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "MiniMAX-relay", protocol }, "relay"),
      MODEL_ADAPTER_REGISTRY.genericByProtocol[protocol])
    assert.throws(() => resolveModelConverter(MODEL_ADAPTER_REGISTRY,
      { name: "unrelated", protocol: "anthropic_messages" }, "MiniMax 国内"), AdapterRoutingError)

    const { config, request } = fixture(protocol)
    const expected = vendor.buildRequest(request, { modelConfig: config })
    for (const replay of [
      { name: "MiniMax", protocol, payloadJson: '{"text":"different"}' },
      { name: "OpenAI", protocol: "responses", payloadJson: '{"text":"foreign"}' },
      { name: "Anthropic", protocol: "anthropic_messages", payloadJson: "invalid JSON" },
      { name: "MiniMax", protocol, payloadJson: "invalid JSON" },
    ] as const) {
      assert.deepEqual(vendor.buildRequest(fixture(protocol, replay).request, { modelConfig: config }), expected)
    }
    const disabled: ProtocolRequest["params"] = vendor.buildRequest(request, {
      modelConfig: { ...config, supportsReasoning: false },
    }).params
    assert.equal("reasoning" in disabled || "reasoning_effort" in disabled || "thinking" in disabled, false)
    assert.equal("tools" in vendor.buildRequest({ ...request, toolChoice: "none" }, { modelConfig: config }).params, false)

    const name = "MiniMax-M3"
    for (const level of (protocol === "responses" ? ["none", "low"] : ["disabled", "adaptive"])) {
      const params: ProtocolRequest["params"] = vendor.buildRequest(
        { ...request, model: { ...request.model, name, reasoningLevel: level } },
        { modelConfig: { ...config, name, reasoningLevels: [level] } },
      ).params
      if (protocol === "responses") assert.deepEqual(params, { ...expected.params, model: name, reasoning: { effort: level } })
      else {
        assert.ok("thinking" in params)
        assert.deepEqual(params.thinking, { type: level })
        assert.equal("reasoning_effort" in params, false)
      }
    }
  }
}

/**
 * 收集完整块并断言每个开始的块在唯一终态之前闭合。
 * @param events 已收集的统一事件。
 * @returns 按统一索引排列的完整块。
 */
function closedBlocks(events: ModelStreamEvent[]): AssistantContentBlock[] {
  const started = new Map<number, string>()
  const closed = new Map<number, AssistantContentBlock>()
  for (const event of events) {
    switch (event.type) {
      case "block_start":
        assert.equal(event.index, started.size)
        started.set(event.index, event.blockType)
        break
      case "block_delta":
        assert.equal(started.get(event.index), event.delta.type)
        assert.equal(closed.has(event.index), false)
        break
      case "block_end":
        assert.equal(started.get(event.index), event.block.type)
        assert.equal(closed.has(event.index), false)
        closed.set(event.index, event.block)
        break
      case "stream_end":
        assert.equal(event, events.at(-1))
        assert.equal(started.size, closed.size)
        break
    }
  }
  assert.equal(events.filter((event) => event.type === "stream_end").length, 1)
  return [...started.keys()].map((index) => closed.get(index)!)
}

/** 用真实 SDK 验证两个协议的线上请求形状、增量和最终事件。 */
async function verifySdk(): Promise<void> {
  for (const protocol of PROTOCOLS) {
    const server = await startFakeProvider({ events: protocol === "responses" ? RESPONSES : CHAT })
    try {
      const { config, request } = fixture(protocol, { name: "OpenAI", protocol: "responses", payloadJson: "invalid JSON" })
      config.name = "MINIMAX-M3.1-Flash"
      request.model.name = config.name
      const adapter = createModelAdapter(config, { apiKey: "fake", baseURL: server.baseURL(protocol) }, "relay")
      const events = await collect(adapter.stream(request, SIGNAL))
      const thinkingDeltas = events.flatMap((event) => event.type === "block_delta" && event.delta.type === "thinking"
        ? [event.delta.text] : [])
      const blocks = closedBlocks(events)
      assert.equal(server.requests.length, 1)
      const { path, body } = server.requests[0]!
      assert.equal(body.model, config.name)
      assert.equal(body.stream, true)
      assert.deepEqual(events.at(-1), { type: "stream_end", completion: "tool_calls",
        finishReason: protocol === "responses" ? "completed" : "tool_calls",
        usage: { inputTokens: 18, cacheReadTokens: 12, outputTokens: 10, reasoningTokens: 3, totalTokens: 40 },
      })
      if (protocol === "responses") {
        assert.equal(path, "/v1/responses")
        assert.equal(body.instructions, "system")
        assert.equal(body.max_output_tokens, 4096)
        assert.deepEqual(body.reasoning, { effort: "high" })
        assert.deepEqual(body.tools, [{
          type: "function", name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema, strict: false,
        }])
        assert.equal("previous_response_id" in body || "conversation" in body || "fixture_effort" in body, false)
        assert.deepEqual(body.input, [
          { role: "user", content: "query" },
          { type: "reasoning", summary: [{ type: "summary_text", text: "first" }] },
          { role: "assistant", content: "answer" },
          { type: "function_call", call_id: HISTORY_CALL.toolCallId, name: TOOL.name, arguments: '{"city":"A"}' },
          { type: "reasoning", summary: [{ type: "summary_text", text: " \n" }] },
          { type: "reasoning", summary: [{ type: "summary_text", text: "next" }] },
          { type: "function_call_output", call_id: HISTORY_CALL.toolCallId, output: "result" },
        ])
        assert.deepEqual(thinkingDeltas, ["fir", "st", "next step", "last", " step"])
        assert.deepEqual(blocks, [
          { type: "thinking", text: "first" }, { type: "text", text: "answer" }, { type: "thinking", text: "next step" },
          { type: "tool_call", toolCallId: RESPONSE_CALL.call_id, name: TOOL.name, arguments: { city: "B" } },
          { type: "thinking", text: "last step" },
        ])
      } else {
        assert.equal(path, "/v1/chat/completions")
        assert.equal(body.max_completion_tokens, 4096)
        assert.equal(body.reasoning_effort, "high")
        assert.equal(body.reasoning_split, true)
        assert.deepEqual(body.stream_options, { include_usage: true })
        assert.deepEqual(body.tools, [{
          type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema },
        }])
        assert.equal("max_tokens" in body || "thinking" in body || "fixture_effort" in body, false)
        assert.deepEqual(body.messages, [
          { role: "system", content: "system" },
          { role: "user", content: "query" },
          { role: "assistant", content: "answer", reasoning_content: "first \nnext",
            tool_calls: [{ type: "function", id: HISTORY_CALL.toolCallId, function: { name: TOOL.name, arguments: '{"city":"A"}' } }] },
          { role: "tool", tool_call_id: HISTORY_CALL.toolCallId, content: "result" },
        ])
        assert.deepEqual(thinkingDeltas, ["first", " thought"])
        assert.deepEqual(blocks, [
          { type: "thinking", text: "first thought" }, { type: "text", text: "answer" },
          { type: "tool_call", toolCallId: "call-b", name: TOOL.name, arguments: { city: "B" } },
          { type: "tool_call", toolCallId: "call-c", name: TOOL.name, arguments: { city: "C" } },
        ])
      }
    } finally {
      await server.close()
    }
  }
}

/** 验证 SDK 缺终态、上游失败、取消、共享重试和截断工具调用。 */
async function verifyFailures(): Promise<void> {
  for (const protocol of PROTOCOLS) {
    const failedResponse = { type: "response.failed", response: { status: "failed", error: { message: "planned failure" } } }
    const failedChat = { choices: [], base_resp: { status_code: 1000, status_msg: "planned failure" } }
    const first = protocol === "responses" ? RESPONSES[1]! : chunk({ reasoning_content: "first" })
    const partialCall = { ...RESPONSE_CALL, status: "incomplete", arguments: '{"city":' }
    const server = await startFakeProvider((_, attempt) => {
      if (attempt === 0) return { events: [first] }
      if (attempt === 1) return { events: [
        protocol === "responses" ? sseEvent(failedResponse.type, failedResponse) : failedChat,
      ] }
      if (attempt === 2) return { events: protocol === "responses" ? [first] : [first, chunk({}, "stop")], hang: true }
      if (attempt === 3) return { status: 503 }
      if (attempt === 4) return { events: protocol === "responses" ? RESPONSES : CHAT }
      return { events: protocol === "responses" ? [
        { type: "response.output_item.added", output_index: 0, item: { ...partialCall, arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: partialCall },
        { type: "response.incomplete", response: {
          status: "incomplete", output: [partialCall], incomplete_details: { reason: "max_output_tokens" },
        } },
      ] : [
        chunk({ tool_calls: [{ index: 0, id: "partial", function: { name: TOOL.name, arguments: '{"city":' } }] }),
        chunk({}, "length"),
        sseData("[DONE]"),
      ] }
    })
    try {
      const { config, request } = fixture(protocol)
      const adapter = createModelAdapter(config, { apiKey: "fake", baseURL: server.baseURL(protocol) }, "MiniMax")
      for (const message of [/结束事件前中断/, /planned failure/]) {
        const error = await collectError(adapter.stream(request, SIGNAL, { retry: false }))
        assert.match((error as { message: string }).message, message)
      }
      const controller = new AbortController()
      /** 先消费一个增量，再由外部取消挂起的 SDK 请求。 */
      const stream = adapter.stream(request, controller.signal, { retry: false })[Symbol.asyncIterator]()
      try {
        assert.equal((await stream.next()).value?.type, "block_start")
        assert.equal((await stream.next()).value?.type, "block_delta")
        const pending = stream.next()
        setTimeout(() => controller.abort(), 25)
        await assert.rejects(pending, { code: "CANCELLED" })
      } finally {
        controller.abort()
        await stream.return?.()
      }
      assert.equal((await collect(adapter.stream(request, SIGNAL))).at(-1)?.type, "stream_end")
      assert.equal(server.requests.length, 5)
      const incomplete = await collect(adapter.stream(request, SIGNAL))
      assert.equal(incomplete.some((event) => event.type === "block_end" && event.block.type === "tool_call"), false)
      assert.deepEqual(incomplete.at(-1), {
        type: "stream_end", completion: "incomplete", finishReason: protocol === "responses" ? "max_output_tokens" : "length",
      })
    } finally {
      await server.close()
    }
  }
}

/** 运行 MiniMax 路由、请求和真实 SDK 流的定向断言。 */
async function main(): Promise<void> {
  verifyRoutingAndRequests()
  await verifySdk()
  await verifyFailures()
  console.log("minimax.test.ts: MiniMax 路由、请求及流转换断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
