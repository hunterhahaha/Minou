import assert from "node:assert/strict"
import type OpenAI from "openai"

import { createModelAdapter } from "../src/gateway/adapter.ts"
import { AdapterRoutingError, MODEL_ADAPTER_REGISTRY, resolveModelConverter } from "../src/gateway/adapter-router.ts"
import { KimiAdapter } from "../src/gateway/kimi-adapter.ts"
import type {
  AssistantContentBlock, ModelConfig, ModelMessage, ModelStreamEvent, UnifiedModelRequest, UnifiedToolDefinition,
} from "../src/types.ts"
import { collect, sseData, sseEvent, startFakeProvider, streamOf } from "./helpers.ts"
import type { FakeResponse } from "./helpers.ts"
import {
  KIMI_CN_API_PROVIDERS, KIMI_CN_CODING_PLAN_PROVIDERS, KIMI_INTERNATIONAL_API_PROVIDERS,
  KIMI_INTERNATIONAL_CODING_PLAN_PROVIDERS,
} from "../../../src/main/compatible-providers/kimi.ts"

/** 四个预设名称与其生产创建资料。 */
const PRESETS = [
  ["Kimi 国内 API", KIMI_CN_API_PROVIDERS],
  ["Kimi 国内 Coding Plan", KIMI_CN_CODING_PLAN_PROVIDERS],
  ["Kimi 国际 API", KIMI_INTERNATIONAL_API_PROVIDERS],
  ["Kimi 国际 Coding Plan", KIMI_INTERNATIONAL_CODING_PLAN_PROVIDERS],
] as const

/** 真实 SDK 测试中由假 Provider 请求的工具。 */
const TOOL: UnifiedToolDefinition = {
  name: "look_up", description: "Look up a city", inputSchema: { type: "object" },
}

const SIGNAL = new AbortController().signal
const THINKING = " 原始\n推理  "
const DONE = sseData("[DONE]")

/**
 * 模拟 Kimi 的单选择 SSE 事件。
 * @param delta 厂商字段和内容分片。
 * @param finish_reason 结束原因，生成中为 null。
 * @returns 可直接交给假 Provider 的原始 JSON。
 */
function chunk(delta: object = {}, finish_reason: string | number | null = null): object {
  return { choices: [{ index: 0, delta, finish_reason }] }
}

/** 含交错工具分片和 Usage 流尾的开放平台响应。 */
const TOOL_RESPONSE = [
  chunk({ role: "assistant", content: "", reasoning_content: "" }),
  chunk({ reasoning_content: " 原始\n" }), chunk({ reasoning_content: "推理  " }),
  chunk({ content: "正在" }), chunk({ content: "查询" }),
  chunk({ tool_calls: [{ index: 0, id: "call_", function: { name: "look_", arguments: '{"city":' } }] }),
  chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "look_up", arguments: '{"city":"B"}' } }] }),
  chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "up", arguments: '"A"}' } }] }),
  { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 50,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 7 } } },
  { choices: [], usage: { prompt_tokens: "100", cached_tokens: -1 } },
  DONE,
]

/**
 * 从预设取出要绑定的模型，允许按离线场景替换模型能力。
 * @param overrides 测试需要的原名或推理设置。
 * @param preset 四个入口中选定的模型预设。
 * @returns 完整的 Turn 模型配置。
 * @throws 测试预设缺少推理配置时断言失败。
 */
function modelConfig(overrides: Partial<ModelConfig> = {}, preset = KIMI_CN_API_PROVIDERS[0]!.models[0]!): ModelConfig {
  const { reasoningLevels, reasoningField } = preset
  assert.ok(reasoningLevels && reasoningField)
  return { ...preset, reasoningLevels, reasoningField, modelId: "model", providerId: "provider",
    protocol: "chat_completions", ...overrides }
}

/**
 * 为模型构造统一请求，默认使用已提交的会话历史。
 * @param model 与该请求绑定的模型。
 * @param reasoningLevel 本轮选择的推理档位。
 * @returns 带基线工具定义的会话请求。
 */
function requestFor(model: ModelConfig, reasoningLevel = "high"): UnifiedModelRequest {
  return { model: { protocol: model.protocol, modelId: model.modelId, providerId: model.providerId, name: model.name, reasoningLevel },
    tools: [], context: { history: { system: "system", mcpBaseline: [TOOL], events: [
      { type: "user/message", seq: 1, content: [{ type: "text", text: "城市信息" }] },
    ] } } }
}

/**
 * 从流中读取唯一终态，并核对终态位于所有块事件之后。
 * @param events 已收集的 Runtime 事件。
 * @returns 唯一的 stream_end 事件。
 * @throws 终态缺失、重复或位置无效时断言失败。
 */
function streamEnd(events: ModelStreamEvent[]): Extract<ModelStreamEvent, { type: "stream_end" }> {
  const end = events.at(-1)
  assert.ok(end?.type === "stream_end")
  assert.equal(events.filter((event) => event.type === "stream_end").length, 1)
  return end
}

/**
 * 校验名称与模型规则路径、共享实例及协议回退。
 * @throws 任一解析结果偏离注册规则时断言失败。
 */
function verifyRouting(): void {
  const model = modelConfig({ name: "custom-model" })
  const resolve = (name: string, provider = "relay", protocol: ModelConfig["protocol"] = "chat_completions") =>
    resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name, protocol }, provider)
  const vendor = resolve(model.name, "Kimi")
  assert.ok(vendor instanceof KimiAdapter)
  for (const name of ["Kimi", ...PRESETS.map(([name]) => name)]) {
    for (const alias of [name, name.toUpperCase(), ` ${name.toLowerCase()} `]) {
      assert.equal(resolve(model.name, alias), vendor)
      for (const protocol of ["responses", "anthropic_messages"] as const) {
        assert.throws(() => resolve(model.name, alias, protocol), AdapterRoutingError)
      }
    }
  }
  for (const name of ["kimi-k3", "KIMI-k3", "kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k", "k3.1-pro", "k3.1-pro-highspeed"]) {
    assert.equal(resolve(name), vendor)
    assert.equal(resolve(name, "relay", "responses"), MODEL_ADAPTER_REGISTRY.genericByProtocol.responses)
  }
  for (const name of ["Kimi-k3", "K3", "k3-512k", "k3.1-pro-future", "unrelated"]) {
    assert.equal(resolve(name), MODEL_ADAPTER_REGISTRY.genericByProtocol.chat_completions)
  }
}

/**
 * 通过真实 SDK 核对四条地址路径、凭据、工具结果及下一次请求的原样回放。
 * @returns 所有本地请求完成并关闭服务器后解析。
 * @throws 断言、网络或清理失败时拒绝。
 */
async function verifySdkRequests(): Promise<void> {
  const provider = await startFakeProvider((_request, attempt) => attempt === 0 ? { events: TOOL_RESPONSE } : { events: [
    chunk({ content: "结果" }, "stop"), { choices: [], usage: {
      prompt_tokens: 40, completion_tokens: 5, cached_tokens: 10, prompt_cache_hit_tokens: 30,
    } }, DONE,
  ] })
  try {
    for (const [index, [name, definitions]] of PRESETS.entries()) {
      const preset = definitions[0]!
      const presetModel = preset.models[0]!
      const model = modelConfig(index === 3 ? { name: "k3.1-pro-highspeed" } : {}, presetModel)
      const basePath = `/preset-${index}${new URL(preset.url).pathname}`
      const adapter = createModelAdapter(model, {
        apiKey: `key-${index}`, baseURL: `${provider.origin}${basePath}`, defaultHeaders: { "X-Test-Provider": String(index) },
      }, name.toUpperCase())
      const request = requestFor(model)
      const events = await collect(adapter.stream(request, SIGNAL))
      const end = streamEnd(events)
      assert.deepEqual(end, { type: "stream_end", finishReason: "tool_calls", completion: "tool_calls", usage: {
        inputTokens: 70, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 30, reasoningTokens: 7,
      } })
      assert.deepEqual(events.filter((event) => event.type === "block_start").map((event) => event.index), [0, 1, 2, 3])
      const blocks = events.flatMap((event) => event.type === "block_end" ? [event.block] : [])
      assert.deepEqual(blocks, [
        { type: "thinking", text: THINKING, replay: { name: "Kimi", protocol: "chat_completions",
          payloadJson: JSON.stringify({ reasoning_content: THINKING }) } },
        { type: "text", text: "正在查询" },
        { type: "tool_call", toolCallId: "call_a", name: "look_up", arguments: { city: "A" } },
        { type: "tool_call", toolCallId: "call_b", name: "look_up", arguments: { city: "B" } },
      ])

      assert.ok(request.context.history)
      request.context.history.events.push({ type: "assistant/message", seq: 2, content: blocks })
      for (const [offset, id] of ["call_b", "call_a"].entries()) {
        request.context.history.events.push({ type: "tool/result", seq: 3 + offset, turn: 1, step: 1,
          toolCallEventId: `event-${id}`, toolCallId: id, content: [{ type: "text", text: id }], isError: false })
      }
      const second = streamEnd(await collect(adapter.stream(request, SIGNAL)))
      assert.deepEqual(second, { type: "stream_end", finishReason: "stop", completion: "finished",
        usage: { inputTokens: 30, outputTokens: 5, totalTokens: 45, cacheReadTokens: 10 } })

      const [initial, continued] = provider.requests.slice(-2)
      for (const captured of [initial!, continued!]) {
        assert.equal(captured.path, `${basePath}/chat/completions`)
        assert.equal(captured.headers.authorization, `Bearer key-${index}`)
        assert.equal(captured.headers["x-test-provider"], String(index))
        assert.equal(captured.body.model, model.name)
        assert.equal(captured.body.reasoning_effort, "high")
        assert.equal(captured.body.thinking, undefined)
        assert.equal(captured.body.stream, true)
        assert.deepEqual(captured.body.stream_options, { include_usage: true })
        assert.deepEqual(captured.body.tools, [{ type: "function", function: {
          name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema,
        } }])
      }
      assert.deepEqual(continued!.body.messages, [
        { role: "system", content: "system" }, { role: "user", content: "城市信息" },
        { role: "assistant", content: "正在查询", reasoning_content: THINKING, tool_calls: [
          { id: "call_a", type: "function", function: { name: "look_up", arguments: '{"city":"A"}' } },
          { id: "call_b", type: "function", function: { name: "look_up", arguments: '{"city":"B"}' } },
        ] },
        { role: "tool", tool_call_id: "call_b", content: "call_b" },
        { role: "tool", tool_call_id: "call_a", content: "call_a" },
      ])
    }
  } finally {
    await provider.close()
  }
}

/**
 * 检查推理字段、来源过滤、K2.6 跨轮边界和独立请求投影。
 * @throws 请求中的推理字段或消息序列不符时断言失败。
 */
function verifyRequestReplay(): void {
  const native = { name: "Kimi", protocol: "chat_completions" } as const
  const thinking = (payloadJson: string): AssistantContentBlock => ({ type: "thinking", text: "display only",
    replay: { ...native, payloadJson } })
  const valid = thinking(JSON.stringify({ reasoning_content: " 一\n" }))
  const oldAssistant: AssistantContentBlock[] = [valid,
    { type: "thinking", text: "wrong source", replay: { ...valid.replay!, name: "Other" } },
    { type: "thinking", text: "wrong casing", replay: { ...valid.replay!, name: "kimi" } },
    { type: "thinking", text: "wrong protocol", replay: { ...valid.replay!, protocol: "responses" } },
    { type: "thinking", text: "no replay" }, thinking("{"), thinking("null"), thinking("{}"),
    thinking('{"reasoning_content":2}'), thinking('{"reasoning_content":""}'),
    { type: "text", text: "历史答案", replay: valid.replay }, thinking('{"reasoning_content":"二  "}'),
  ]
  const messages: ModelMessage[] = [
    { role: "system", content: "system" }, { role: "user", content: "旧轮" },
    { role: "assistant", content: oldAssistant }, { role: "user", content: "新轮" },
    { role: "assistant", content: [thinking('{"reasoning_content":"工具推理"}'),
      { type: "tool_call", toolCallId: "id", name: TOOL.name, arguments: {} }] },
    { role: "tool", toolCallId: "id", content: [{ type: "text", text: "工具结果" }], isError: false },
  ]
  const adapter = resolveModelConverter(MODEL_ADAPTER_REGISTRY, modelConfig(), "relay")
  const build = (model: ModelConfig, level: string, summary = false, input = messages) => {
    const request = { ...requestFor(model, level), context: { messages: input, ...(summary ? { purpose: "summary" as const } : {}) } }
    const result = adapter.buildRequest(request, { modelConfig: model, providerName: "relay" })
    assert.ok(result.protocol === "chat_completions")
    return result.params as typeof result.params & { thinking?: object; messages: Record<string, unknown>[] }
  }

  const k3 = modelConfig({ name: "k3" })
  assert.equal(build(k3, "max").reasoning_effort, "max")
  assert.equal(build(k3, "low").messages[2]?.reasoning_content, " 一\n二  ")
  assert.throws(() => build(k3, "medium"), { code: "INVALID_MODEL_REQUEST" })
  const summary = build(k3, "low", true)
  assert.ok(summary.messages.every((message) => !("reasoning_content" in message)))
  assert.deepEqual(build(k3, "low", false, messages.slice(0, 2)).messages, messages.slice(0, 2))
  assert.equal(build(modelConfig({ name: "k3-256k", supportsReasoning: false }), "none").reasoning_effort, undefined)
  assert.equal(build(modelConfig({ name: "kimi-for-coding-highspeed", supportsReasoning: false }), "none").thinking, undefined)

  const k27 = modelConfig({ name: "kimi-k2.7-code", reasoningLevels: ["enabled"], reasoningField: { path: ["thinking", "type"] } })
  assert.deepEqual(build(k27, "enabled").thinking, { type: "enabled" })
  assert.equal(build(k27, "enabled").messages[2]?.reasoning_content, " 一\n二  ")
  const k26 = { ...k27, name: "kimi-k2.6", reasoningLevels: ["enabled", "disabled"] }
  const currentTurn = build(k26, "enabled")
  assert.equal(currentTurn.messages[2]?.reasoning_content, undefined)
  assert.equal(currentTurn.messages[4]?.reasoning_content, "工具推理")
  const disabled = build(k26, "disabled")
  assert.deepEqual(disabled.thinking, { type: "disabled" })
  assert.ok(disabled.messages.every((message) => !("reasoning_content" in message)))
  const preserved = build({ ...k26, reasoningLevels: ["all"], reasoningField: { path: ["thinking", "keep"] } }, "all")
  assert.deepEqual(preserved.thinking, { keep: "all" })
  assert.equal(preserved.messages[2]?.reasoning_content, " 一\n二  ")
  assert.equal(preserved.messages[4]?.reasoning_content, "工具推理")
}

/**
 * 验证未完成的思考、非法终止和 Usage 缺失的离线协议样本。
 * @returns 样本消费完毕后解析。
 * @throws 事件、错误或用量行为不符时拒绝。
 */
async function verifyStreamBoundaries(): Promise<void> {
  const adapter = new KimiAdapter()
  const model = modelConfig()
  const map = (events: object[]) => adapter.mapResponseStream({ protocol: "chat_completions",
    events: streamOf(events as OpenAI.ChatCompletionChunk[]) }, requestFor(model), { modelConfig: model })
  const seen: ModelStreamEvent[] = []
  await assert.rejects(async () => {
    for await (const event of map([chunk({ reasoning_content: THINKING }), chunk({}, ""), chunk({}, 1)])) seen.push(event)
  }, /结束事件前中断/)
  assert.deepEqual(seen.map((event) => event.type), ["block_start", "block_delta"])

  const limited = await collect(map([chunk({ reasoning_content: THINKING }), chunk({}, "length"), { choices: [], usage: {} }]))
  assert.deepEqual(limited.at(-2), { type: "block_end", index: 0, block: { type: "thinking", text: THINKING } })
  assert.deepEqual(streamEnd(limited), { type: "stream_end", finishReason: "length", completion: "incomplete" })
  const zero = streamEnd(await collect(map([chunk({}, "stop"), { choices: [], usage: {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cache_write_tokens: 0 },
  } }])))
  assert.deepEqual(zero.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheWriteTokens: 0 })
  const zeroRead = streamEnd(await collect(map([chunk({}, "stop"), { choices: [], usage: {
    prompt_tokens: 10, completion_tokens: 0, cached_tokens: 0, total_tokens: 99,
  } }])))
  assert.deepEqual(zeroRead.usage, { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 })
  await assert.rejects(collect(map([chunk({ tool_calls: [{ index: 0, function: { name: "missing_id" } }] }, "tool_calls")])), /缺少 ID 或名称/)
}

/**
 * 经真实 SDK 验证各类错误的请求次数、元数据和取消行为。
 * @returns 所有样本结束且本地服务器关闭后解析。
 * @throws 重试、错误或取消行为不符时拒绝。
 */
async function verifySdkErrors(): Promise<void> {
  const success = { events: [chunk({ content: "ok" }, "stop"), DONE] }
  const providerCode = (type: string, message = "do-not-expose raw-key") => ({ error: { type, message } })
  const capacity = providerCode("engine_overloaded_error")
  const responses: Record<string, FakeResponse> = {
    balance: { status: 429, errorBody: { error: { code: "quota-code", type: "exceeded_current_quota_error", message: "raw-key" } } },
    daily: { status: 429, errorBody: providerCode("rate_limit_reached_error", "Your organization reached its TPD limit") },
    hours: { status: 429, errorBody: { error: { message: "You've reached your 5-hour usage limit. raw-key" } } },
    weekly: { status: 429, errorBody: { error: { message: "You've reached your weekly (7-day) usage limit" } } },
    monthly: { status: 429, errorBody: { error: { message: "You've reached your monthly usage limit for this billing cycle" } } },
    credits: { status: 429, errorBody: { error: { message: "Your credit balance is insufficient" } } },
    extra: { status: 429, errorBody: { error: { message: "Your organization's Extra Usage balance has run out" } } },
    organization: { events: [{ error: { message: "You've reached the Extra Usage limit set for your account by your organization", status: 429 } }] },
    permission: { status: 403, errorBody: { error: { message: "Your current subscription does not have access to k3.1-pro" } } },
    rpm: { status: 429, errorBody: providerCode("rate_limit_reached_error", "Your organization reached its RPM limit") },
    burst: { events: [{ error: { message: "We're receiving too many requests at the moment. Please wait a moment and try again." } }] },
    capacity: { events: [sseEvent("error", capacity)] },
    capacityHttp: { status: 429, errorBody: capacity },
    fallback: { status: 500, errorBody: providerCode("unknown_exception") },
    partial: { events: [chunk({ reasoning_content: THINKING }), capacity] },
    cancelled: { events: [chunk({ content: "yes" }, "stop")], hang: true },
  }
  const provider = await startFakeProvider((request, attempt) => {
    const scenario = request.path.split("/")[1]!
    return attempt > 0 ? success : { ...responses[scenario]!, headers: { "x-request-id": `req-${scenario}` } }
  })
  try {
    const model = modelConfig({ name: "k3.1-pro" })
    const open = (scenario: string, signal = SIGNAL) => createModelAdapter(model, {
      apiKey: "mock", baseURL: `${provider.origin}/${scenario}/v1`,
    }, scenario === "daily" || scenario === "balance" ? "Kimi 国内 API" : "Kimi 国际 Coding Plan").stream(requestFor(model), signal)
    const count = (scenario: string) => provider.requests.filter((request) => request.path.startsWith(`/${scenario}/`)).length

    const noRetryMessages = {
      balance: "Kimi 账户余额或使用额度不足。",
      daily: "Kimi 开放平台的每日 Token 额度已用完。",
      hours: "Kimi Coding Plan 的 5 小时使用额度已用完。",
      weekly: "Kimi Coding Plan 的 7 天使用额度已用完。",
      monthly: "Kimi Coding Plan 的月度使用额度已用完。",
      credits: "Kimi Coding Plan 的账户余额不足。",
      extra: "Kimi Coding Plan 的组织 Extra Usage 余额已用完。",
      organization: "Kimi Coding Plan 已达到组织为本账号设置的 Extra Usage 上限。",
      permission: "Kimi 账户没有本次请求所需的权限。",
    }
    for (const [scenario, message] of Object.entries(noRetryMessages)) {
      await assert.rejects(collect(open(scenario)), (error: { code: string; message: string; details: object }) => {
        assert.equal(error.code, "REQUEST_FAILED")
        assert.equal(error.message, message)
        assert.deepEqual(error.details, { status: scenario === "permission" ? 403 : 429, requestId: `req-${scenario}`,
          ...(scenario === "balance" ? { providerCode: "quota-code" } : scenario === "daily" ? { providerCode: "rate_limit_reached_error" } : {}) })
        return true
      })
      assert.equal(count(scenario), 1)
    }

    for (const scenario of ["capacity", "capacityHttp", "rpm", "burst", "fallback"]) {
      const events = await collect(open(scenario))
      assert.equal(count(scenario), 2)
      assert.deepEqual(events.map((event) => event.type), ["block_start", "block_delta", "block_end", "stream_end"])
      assert.ok(events[0]?.type === "block_start" && events[0].index === 0)
    }
    const partial: ModelStreamEvent[] = []
    await assert.rejects(async () => {
      for await (const event of open("partial")) partial.push(event)
    }, { code: "REQUEST_FAILED", message: "Kimi 推理服务暂时过载。", details: {
      requestId: "req-partial", providerCode: "engine_overloaded_error",
    } })
    assert.equal(count("partial"), 1)
    assert.deepEqual(partial.map((event) => event.type), ["block_start", "block_delta"])

    const controller = new AbortController()
    await assert.rejects(async () => {
      for await (const event of open("cancelled", controller.signal)) {
        assert.notEqual(event.type, "stream_end")
        if (event.type === "block_delta") controller.abort()
      }
    }, { code: "CANCELLED" })
    assert.equal(count("cancelled"), 1)
  } finally {
    await provider.close()
  }
}

/**
 * 运行 Kimi 路由、协议与真实 SDK 的本地测试。
 * @returns 所有场景通过后解析。
 * @throws 断言或资源清理失败时拒绝。
 */
async function main(): Promise<void> {
  verifyRouting()
  verifyRequestReplay()
  await verifyStreamBoundaries()
  await verifySdkRequests()
  await verifySdkErrors()
  console.log("Kimi Adapter tests passed")
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
