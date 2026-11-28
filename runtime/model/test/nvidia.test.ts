import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NVIDIA_PROVIDERS } from "../../../src/main/compatible-providers/nvidia.ts"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { createTurnModelAdapter } from "../../../src/main/model-adapters.ts"
import { saveModel, saveProvider, setProviderApiKey } from "../../../src/main/provider-store.ts"
import { createModelAdapter } from "../src/gateway/adapter.ts"
import { NvidiaAdapter } from "../src/gateway/nvidia-adapter.ts"
import { completeReasoningConfig } from "../src/reasoning.ts"
import type { BlockReplay, ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../src/types.ts"
import { collect, sseData, startFakeProvider } from "./helpers.ts"

const PRESET = NVIDIA_PROVIDERS[0]!
const GPT_OSS = PRESET.models[0]!
const CONFIG: ModelConfig = {
  ...GPT_OSS, ...completeReasoningConfig(GPT_OSS, PRESET.protocol),
  protocol: PRESET.protocol, providerId: "nvidia-first", modelId: "gpt-oss",
}

/**
 * 构造带本地事件历史的统一请求。
 * @param replay 附给思考块的可选回放样本，不改变历史明文。
 * @returns 包含过去一次工具调用与结果的统一请求。
 */
function historyRequest(replay?: BlockReplay): UnifiedModelRequest {
  return {
    model: { ...CONFIG, reasoningLevel: "high" },
    tools: [{ name: "lookup", description: "Find an item", inputSchema: { type: "object" } }],
    context: { history: { system: "Instructions", mcpBaseline: [], events: [
      { seq: 1, type: "user/message", content: [{ type: "text", text: "Look up an item" }] },
      { seq: 2, type: "assistant/message", content: [
        { type: "thinking", text: "", replay },
        { type: "thinking", text: " Plan", replay },
        { type: "text", text: "Checking." },
        { type: "thinking", text: "\t", replay },
        { type: "thinking", text: "then act \n", replay },
        { type: "tool_call", toolCallId: "old-call", name: "lookup", arguments: '{ "id": 7 }' },
      ] },
      { seq: 3, type: "tool/result", turn: 1, step: 1, toolCallEventId: "event-old-call", toolCallId: "old-call",
        content: [{ type: "text", text: "Found" }, { type: "text", text: " it" }], isError: false },
      { seq: 4, type: "assistant/message", content: [{ type: "thinking", text: "", replay }] },
    ] } },
  }
}

const EXPECTED_BODY = {
  model: GPT_OSS.name,
  messages: [
    { role: "system", content: "Instructions" },
    { role: "user", content: "Look up an item" },
    { role: "assistant", content: "Checking.", reasoning_content: " Plan\tthen act \n",
      tool_calls: [{ type: "function", id: "old-call", function: { name: "lookup", arguments: '{ "id": 7 }' } }] },
    { role: "tool", tool_call_id: "old-call", content: "Found it" },
  ],
  tools: [{ type: "function", function: { name: "lookup", description: "Find an item", parameters: { type: "object" } } }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 4096,
  reasoning_effort: "high",
}

/**
 * 核对历史内容只读取明文，并让其他模型采用自己的推理字段路径。
 * @throws 请求与预期的协议参数不一致时抛出。
 */
function testRequest(): void {
  const converter = new NvidiaAdapter()
  const replays: (BlockReplay | undefined)[] = [
    undefined,
    { name: "NVIDIA", protocol: "chat_completions", payloadJson: '{"reasoning_content":"do not copy"}' },
    { name: "Other", protocol: "chat_completions", payloadJson: '{"reasoning_content":"do not copy"}' },
    { name: "Other", protocol: "responses", payloadJson: '{"type":"reasoning"}' },
    { name: "Anthropic", protocol: "anthropic_messages", payloadJson: "{invalid" },
  ]
  for (const replay of replays) {
    assert.deepEqual(converter.buildRequest(historyRequest(replay), { modelConfig: CONFIG }),
      { protocol: "chat_completions", params: EXPECTED_BODY })
  }
  const request = historyRequest()
  const noTools = { ...request, tools: [], toolChoice: "none" as const }
  const custom = converter.buildRequest(noTools, {
    modelConfig: { ...CONFIG, maxOutputTokens: 7000, reasoningField: { path: ["model_options", "effort"] } },
  })
  const { tools: _tools, reasoning_effort: _effort, ...expected } = EXPECTED_BODY
  assert.deepEqual(custom.params, { ...expected, max_tokens: 7000, model_options: { effort: "high" }, tool_choice: "none" })
}

/**
 * 构造假 Provider 的默认 choice 分片。
 * @param delta 当前 SSE 的文本或工具增量。
 * @param finishReason 上游结束原因，省略时表示生成继续。
 * @returns 可由假服务直接发送的 chunk。
 */
function chunk(delta: object, finishReason: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] }
}

const TOOL_STREAM = [
  { choices: [
    { index: 1, delta: { content: "Other choice" }, finish_reason: "stop" },
    { index: 0, delta: { reasoning_content: "We " }, finish_reason: null },
  ], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
  chunk({ reasoning_content: "can", content: "Checking ", reasoning_details: [{ data: "opaque" }] }),
  chunk({ reasoning_content: "", content: "now." }),
  chunk({ tool_calls: [
    { index: 0, id: "call-one", function: { name: "look", arguments: '{"id":' } },
    { index: 1, id: "call-two", function: { name: "f", arguments: '{"ids":[' } },
  ] }),
  chunk({ tool_calls: [
    { index: 1, function: { name: "ind", arguments: "2," } },
    { index: 0, function: { name: "up", arguments: "7}" } },
  ] }),
  chunk({ tool_calls: [{ index: 1, function: { arguments: "3]}" } }] }, "tool_calls"),
  { choices: [], usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24, prompt_tokens_details: { cached_tokens: 4 } } },
  { choices: [], usage: {} },
  { choices: [], usage: { prompt_tokens: -1 } },
  sseData("[DONE]"),
]

/**
 * 通过两份真实 Provider 快照、共享网关和 SDK 核对连接参数与流式转换。
 * @returns 两组连接和事件断言通过、临时资源释放后完成。
 * @throws 测试资源创建失败、请求失败或断言不符时拒绝。
 */
async function testProviderConnections(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "minou-nvidia-"))
  try {
    const paths = await initializeConfigFiles(profile)
    for (const [id, name, preset, events] of [
      [CONFIG.providerId, "NVIDIA", GPT_OSS, TOOL_STREAM],
      ["nvidia-second", "Nvidia", PRESET.models[1]!, [chunk({ content: "Done." }, "stop"), sseData("[DONE]")]],
    ] as const) {
      const provider = await startFakeProvider({ events: [...events] })
      try {
        const database = paths.providerDatabasePath
        saveProvider(database, {
          id, name, type: "compatible", protocol: CONFIG.protocol,
          baseURL: provider.baseURL("chat_completions"), defaultHeaders: { "X-Fixture-Provider": id },
        })
        const model = { providerId: id, modelId: preset.name, protocol: CONFIG.protocol, name: preset.name, reasoningLevel: "high" }
        saveModel(database, { ...preset, providerId: id, modelId: model.modelId })
        setProviderApiKey(database, id, id + "-key")

        const adapter = await createTurnModelAdapter(paths, model)
        const request = { ...historyRequest({ name: "Other", protocol: "responses", payloadJson: "{invalid" }), model }
        const received = await collect(adapter.stream(request, new AbortController().signal, { retry: false }))
        assert.equal(provider.requests.length, 1)
        const sent = provider.requests[0]!
        assert.equal(sent.path, "/v1/chat/completions")
        assert.equal(sent.headers.host, new URL(provider.origin).host)
        assert.equal(sent.headers.authorization, "Bearer " + id + "-key")
        assert.equal(sent.headers["x-fixture-provider"], id)
        if (preset === GPT_OSS) {
          assert.deepEqual(sent.body, EXPECTED_BODY)
          assert.deepEqual(received, [
            { type: "block_start", index: 0, blockType: "thinking" },
            { type: "block_delta", index: 0, delta: { type: "thinking", text: "We " } },
            { type: "block_delta", index: 0, delta: { type: "thinking", text: "can" } },
            { type: "block_end", index: 0, block: { type: "thinking", text: "We can" } },
            { type: "block_start", index: 1, blockType: "text" },
            { type: "block_delta", index: 1, delta: { type: "text", text: "Checking " } },
            { type: "block_delta", index: 1, delta: { type: "text", text: "now." } },
            { type: "block_end", index: 1, block: { type: "text", text: "Checking now." } },
            { type: "block_start", index: 2, blockType: "tool_call" },
            { type: "block_delta", index: 2, delta: { type: "tool_call", toolCallId: "call-one", nameDelta: "look", argumentsDelta: '{"id":' } },
            { type: "block_start", index: 3, blockType: "tool_call" },
            { type: "block_delta", index: 3, delta: { type: "tool_call", toolCallId: "call-two", nameDelta: "f", argumentsDelta: '{"ids":[' } },
            { type: "block_delta", index: 3, delta: { type: "tool_call", toolCallId: "call-two", nameDelta: "ind", argumentsDelta: "2," } },
            { type: "block_delta", index: 2, delta: { type: "tool_call", toolCallId: "call-one", nameDelta: "up", argumentsDelta: "7}" } },
            { type: "block_delta", index: 3, delta: { type: "tool_call", toolCallId: "call-two", argumentsDelta: "3]}" } },
            { type: "block_end", index: 2, block: { type: "tool_call", toolCallId: "call-one", name: "lookup", arguments: { id: 7 } } },
            { type: "block_end", index: 3, block: { type: "tool_call", toolCallId: "call-two", name: "find", arguments: { ids: [2, 3] } } },
            { type: "stream_end", completion: "tool_calls", finishReason: "tool_calls",
              usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 4, totalTokens: 24 } },
          ])
        } else {
          const { reasoning_effort: _effort, ...expected } = EXPECTED_BODY
          assert.deepEqual(sent.body, { ...expected, model: preset.name })
          assert.deepEqual(received, [
            { type: "block_start", index: 0, blockType: "text" },
            { type: "block_delta", index: 0, delta: { type: "text", text: "Done." } },
            { type: "block_end", index: 0, block: { type: "text", text: "Done." } },
            { type: "stream_end", completion: "finished", finishReason: "stop" },
          ])
        }
      } finally {
        await provider.close()
      }
    }
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

/**
 * 核对截断工具、流提前结束、尾部等待取消、SSE 失败及共享网关的 HTTP 重试。
 * @returns 断言通过且本地假 Provider 关闭后完成。
 * @throws 测试服务器创建失败、出现非预期请求失败或断言不符时拒绝。
 */
async function testStreamBoundaries(): Promise<void> {
  const partial = chunk({ tool_calls: [{ index: 0, id: "partial", function: { name: "lookup", arguments: "{" } }] }, "length")
  const provider = await startFakeProvider((_request, attempt) => {
    switch (attempt) {
      case 0: return { events: [chunk({ reasoning_content: "Partial" }), partial, sseData("[DONE]")] }
      case 1: return { events: [chunk({ content: "Interrupted." })] }
      case 2: return { events: [chunk({ content: "Waiting for usage." }, "stop")], hang: true }
      case 3: return { events: [chunk({ content: "Before error." }, "stop"), { error: { message: "SSE failure" } }] }
      case 4: return { status: 503 }
      case 5: return { status: 503 }
      default: return { events: [chunk({ content: "Retried." }, "stop"), sseData("[DONE]")] }
    }
  })
  try {
    const adapter = createModelAdapter(CONFIG, { apiKey: "fixture", baseURL: provider.baseURL("chat_completions") }, "NVIDIA")
    const request = historyRequest()
    const opts = { retry: false, timeoutMs: 5000 }
    const signal = new AbortController().signal
    assert.deepEqual(await collect(adapter.stream(request, signal, opts)), [
      { type: "block_start", index: 0, blockType: "thinking" },
      { type: "block_delta", index: 0, delta: { type: "thinking", text: "Partial" } },
      { type: "block_end", index: 0, block: { type: "thinking", text: "Partial" } },
      { type: "block_start", index: 1, blockType: "tool_call" },
      { type: "block_delta", index: 1, delta: { type: "tool_call", toolCallId: "partial", nameDelta: "lookup", argumentsDelta: "{" } },
      { type: "stream_end", completion: "incomplete", finishReason: "length" },
    ])

    const cancellation = new AbortController()
    for (const [expected, shouldCancel] of [
      [{ code: "REQUEST_FAILED", message: /结束事件前中断/ }, false],
      [{ code: "CANCELLED" }, true],
      [{ code: "REQUEST_FAILED", message: /SSE failure/ }, false],
    ] as const) {
      const received: ModelStreamEvent[] = []
      await assert.rejects(async () => {
        for await (const event of adapter.stream(request, shouldCancel ? cancellation.signal : signal, opts)) {
          received.push(event)
          if (shouldCancel && event.type === "block_delta") cancellation.abort()
        }
      }, expected)
      assert.deepEqual(received.map(({ type }) => type), ["block_start", "block_delta"])
    }
    await assert.rejects(collect(adapter.stream(request, signal, opts)), { code: "REQUEST_FAILED", details: { status: 503, providerCode: "test_error" } })
    const retried = await collect(adapter.stream(request, signal))
    assert.deepEqual(retried.at(-1), { type: "stream_end", completion: "finished", finishReason: "stop" })
    assert.equal(provider.requests.length, 7)
  } finally {
    await provider.close()
  }
}

/**
 * 执行 NVIDIA 请求转换和共享 SDK 流的定向断言。
 * @returns 全部定向测试通过后完成。
 * @throws 任一测试失败时拒绝。
 */
async function main(): Promise<void> {
  testRequest()
  await testProviderConnections()
  await testStreamBoundaries()
  console.log("nvidia.test.ts: 历史明文、Provider 连接、SDK 流和错误边界通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
