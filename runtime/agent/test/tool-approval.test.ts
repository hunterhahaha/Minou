import assert from "node:assert/strict"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { createModelAdapter } from "../../model/src/adapter.ts"
import type { ModelAdapter, ModelRef, ModelStreamEvent } from "../../model/src/types.ts"
import { requestMessages } from "../../model/test/helpers.ts"
import { reviewToolCall } from "../src/tool-approval.ts"

const MODEL: ModelRef = { providerId: "p", protocol: "responses", modelId: "m", name: "Model", reasoningLevel: "high" }
const CONTEXT = { turn: 2, toolCallEventId: "candidate", signal: new AbortController().signal }
const CANDIDATE = { toolName: "read", arguments: { path: "note.txt" }, reason: "文件路径需要授权" }
const APPROVE = '{"riskLevel":"medium","approved":true,"reason":"明确授权"}'
const DENY = '{"riskLevel":"high","approved":false}'

/** @param text 模型输出。 @returns 带思考块及完整文本的事件序列。 */
function* response(text: string): Generator<ModelStreamEvent> {
  yield { type: "block_start", index: 0, blockType: "thinking" }
  yield { type: "block_end", index: 0, block: { type: "thinking", text: "ignored" } }
  yield { type: "block_start", index: 1, blockType: "text" }
  yield { type: "block_end", index: 1, block: { type: "text", text } }
  yield { type: "stream_end", completion: "finished" }
}

/** 验证审核输入、严格校验、重试次数及快照复用。 */
async function testDecisions(): Promise<void> {
  const requests: Parameters<ModelAdapter["stream"]>[] = []
  const outputs: string[] = []
  let snapshots = 0
  const adapter: ModelAdapter = {
    reasoningLevels: ["low", "OFF", "minimal"],
    stream: async function* (...args) {
      requests.push(args)
      const output = outputs.shift()
      assert.ok(output !== undefined)
      if (output === "transport-error") throw new Error("transport failed")
      if (output === "unexpected-tool") yield { type: "block_start", index: 0, blockType: "tool_call" }
      else if (output === "unfinished") yield { type: "stream_end", completion: "incomplete" }
      else yield* response(output)
    },
  }
  const review = () => reviewToolCall(adapter, MODEL, CONTEXT, CANDIDATE, async () => { snapshots++; return [] })
  outputs.push("unexpected-tool", "unfinished", APPROVE)
  assert.equal(await review(), "approved")
  assert.equal(snapshots, 1)
  assert.equal(requests.length, 3)
  const [request, signal, options] = requests[0]
  assert.deepEqual(request.model, { ...MODEL, reasoningLevel: "OFF" })
  assert.equal(MODEL.reasoningLevel, "high")
  assert.notEqual(signal, CONTEXT.signal)
  assert.deepEqual(request.tools, [])
  assert.equal(request.toolChoice, "none")
  assert.equal(options?.retry, false)
  assert.ok(options.timeoutMs! > 0 && options.timeoutMs! <= 30_000)
  assert.ok(requests.every(([current, currentSignal]) => current === request && currentSignal === signal))
  const [system, user] = requestMessages(request)
  assert.match(String(system.content), /先前工具调用的成功或批准不能授权本次调用/)
  assert.match(String(system.content), /明确授权了具体目标及关键副作用/)
  assert.deepEqual(JSON.parse(String(user.content)), { turnContext: [], candidate: CANDIDATE })

  requests.length = 0
  outputs.push(DENY)
  assert.equal(await review(), "denied")
  assert.equal(requests.length, 1)
  const reviewMember = () => reviewToolCall(adapter, MODEL, CONTEXT, CANDIDATE, async () => [], true)
  for (const riskLevel of ["low", "medium", "high"]) {
    requests.length = 0
    outputs.push(JSON.stringify({ riskLevel, approved: true }))
    assert.equal(await reviewMember(), riskLevel === "low" ? "approved" : "denied")
    assert.equal(requests.length, 1)
  }
  requests.length = 0
  outputs.push("invalid", "invalid", "invalid")
  assert.equal(await reviewMember(), "denied")
  assert.equal(requests.length, 3)
  for (const invalid of [
    "invalid json", `\`\`\`json\n${APPROVE}\n\`\`\``, APPROVE + "extra",
    '{"riskLevel":"high","approved":true}', '{"riskLevel":"low","approved":"true"}',
    '{"riskLevel":"unknown","approved":true}', '{"approved":true}', '{"riskLevel":"low"}',
    '{"riskLevel":"low","approved":true,"reason":" "}', '{"riskLevel":"low","approved":true,"reason":null}',
    '{"riskLevel":"low","approved":true,"extra":"x"}', "[]", "null",
  ]) {
    requests.length = 0
    outputs.push(invalid, invalid, invalid)
    assert.equal(await review(), "denied", invalid)
    assert.equal(requests.length, 3, invalid)
  }
  requests.length = 0
  outputs.push("transport-error")
  assert.equal(await review(), "denied")
  assert.equal(requests.length, 1)
}

/** 验证共享期限、无视取消的流、迟到结果及停止的优先级。 */
async function testCancellation(): Promise<void> {
  const timeout = AbortSignal.timeout
  const shortened = mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 30_000)
    return timeout(20)
  })
  const signals: AbortSignal[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const stop = new AbortController()
  const adapter: ModelAdapter = {
    stream: async function* (_request, signal) {
      signals.push(signal)
      if (signals.length === 1) { yield* response("invalid"); return }
      await gate
      yield* response(APPROVE)
    },
  }
  const keepAlive = delay(30)
  try {
    assert.equal(await reviewToolCall(adapter, MODEL, CONTEXT, CANDIDATE, async () => []), "denied")
    assert.equal(signals.length, 2)
    assert.equal(signals[0], signals[1])
    assert.equal(signals[1].aborted, true)
    const pending = reviewToolCall(adapter, MODEL, { ...CONTEXT, signal: stop.signal }, CANDIDATE, async () => [])
    await Promise.resolve()
    stop.abort()
    assert.equal(await pending, "cancelled")
    assert.equal(signals.at(-1)?.aborted, true)
    assert.equal(shortened.mock.callCount(), 2)
    release()
    await keepAlive
    assert.equal(signals.length, 3, "迟到结果不能触发后续尝试")
  } finally {
    release()
    shortened.mock.restore()
  }
}

/** 验证真实 Adapter 向三种 SDK 禁用工具，并在可重试错误时只发一次请求。 */
async function testProtocols(): Promise<void> {
  for (const [protocol, resource] of [
    ["chat_completions", OpenAI.Chat.Completions.prototype],
    ["responses", OpenAI.Responses.prototype],
    ["anthropic_messages", Anthropic.Messages.prototype],
  ] as const) {
    const sdk = mock.method(resource as { create(body: unknown, options: unknown): unknown }, "create", () => {
      throw Object.assign(new Error("unavailable"), { status: 503 })
    })
    try {
      const model = { ...MODEL, protocol }
      const adapter = createModelAdapter({
        ...model, contextWindow: 100_000, maxOutputTokens: 2048, supportsReasoning: false,
        reasoningLevels: [], reasoningField: { path: ["reasoning"] },
      }, { apiKey: "test-key" })
      assert.equal(await reviewToolCall(adapter, model, CONTEXT, CANDIDATE, async () => []), "denied")
      assert.equal(sdk.mock.callCount(), 1, protocol)
      const body = sdk.mock.calls[0].arguments[0] as { tools?: unknown[]; tool_choice?: unknown }
      assert.equal(body.tools?.length ?? 0, 0)
      assert.deepEqual(body.tool_choice, protocol === "anthropic_messages" ? { type: "none" } : "none")
    } finally {
      sdk.mock.restore()
    }
  }
}

/** 依次运行独立审核请求的离线断言。 */
async function main(): Promise<void> {
  await testDecisions()
  await testCancellation()
  await testProtocols()
  console.log("tool-approval.test.ts: 审核协议、校验重试、超时和停止通过")
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
