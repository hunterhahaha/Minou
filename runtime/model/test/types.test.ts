/**
 * 阶段 1 验收：统一模型格式的类型契约。
 *
 * 本文件由两部分组成：
 *   1. 纯类型断言（编译期，由 tsconfig.test.json + tsc 检查）；
 *   2. 少量运行期断言（node:assert，验证 resolveContextWindow 与 Usage 派生量的实际行为）。
 *
 * 两种方式都不依赖测试框架，因此不需要新增依赖。
 * 运行：node --experimental-strip-types runtime/model/test/types.test.ts
 *
 * 架构依据：
 *   - .git/技术文档/开发备忘录1.0.17.md 第 6 节、第 8.4 节
 *   - .git/技术文档/NiCode_Usage统一设计.md（Usage 部分以此为准）
 */

import assert from "node:assert/strict"

import {
  accumulateUsage,
  cacheHitRate,
  DEFAULT_CONTEXT_WINDOW,
  promptTokens,
  PROTOCOLS,
  resolveContextWindow,
  resolveTotalTokens,
} from "../src/types.ts"
import type {
  AssistantContentBlock,
  ModelAdapter,
  ModelConfig,
  ModelMessage,
  ModelCompletion,
  ModelStreamEvent,
  ModelRef,
  Protocol,
  UnifiedModelRequest,
  UnifiedToolDefinition,
  Usage,
} from "../src/types.ts"

// ---------------------------------------------------------------------------
// 类型断言工具
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type Expect<T extends true> = T

// ---------------------------------------------------------------------------
// 1. 编译期断言
// ---------------------------------------------------------------------------

// Protocol 只接受三个已知协议值。
type _ProtocolValues = Expect<Equals<Protocol, "anthropic_messages" | "chat_completions" | "responses">>

// 模型引用与配置的必备字段（第 6 节）。
type _ModelRefShape = Expect<Equals<keyof ModelRef, "providerId" | "protocol" | "modelId">>
type _ModelConfigRequired = Expect<Equals<ModelConfig["id"] | ModelConfig["providerId"], string>>
type _ModelConfigContextWindowRequired = Expect<Equals<ModelConfig["contextWindow"], number>>
// @ts-expect-error 运行时模型配置必须提供已经解析的上下文窗口。
const _missingContextWindow: ModelConfig = { id: "model", providerId: "provider", protocol: "responses" }
void _missingContextWindow

// 内容块三种形态（第 8.4 节）。
type _BlockTypes = Expect<Equals<AssistantContentBlock["type"], "thinking" | "text" | "tool_call">>

// Usage 字段构成（Usage 统一设计第 1 节）：三个必备 + 三个可选。
type _UsageShape = Expect<
  Equals<
    keyof Usage,
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "reasoningTokens"
  >
>
// 可选字段允许 undefined，即「未报告」与 0 是两种不同的状态。
type _UsageCacheFieldsOptional = Expect<
  Equals<
    Usage["cacheReadTokens"] | Usage["cacheWriteTokens"] | Usage["reasoningTokens"],
    number | undefined
  >
>

// 流事件的判别字段取自内容块类型，且 Runtime 身份字段不出现在 Adapter 输出里。
type _StreamEventTypes = Expect<
  Equals<ModelStreamEvent["type"], "block_start" | "block_delta" | "block_end" | "stream_end">
>
type _StreamEventHasNoRuntimeIdentity = Expect<
  Equals<Extract<keyof ModelStreamEvent, "seq" | "sessionId" | "eventId" | "blockId">, never>
>
type _CompletionValues = Expect<Equals<ModelCompletion, "finished" | "tool_calls" | "incomplete" | "unknown">>

// Message role 覆盖第 11.1 / 11.3 节出现的四种角色。
type _MessageRoles = Expect<Equals<ModelMessage["role"], "system" | "user" | "assistant" | "tool">>

// 回放消息的 role 约束内容与配对字段，防止把工具调用和结果串错。
const _systemMessage: ModelMessage = { role: "system", content: "You are a coding agent." }
const _userMessage: ModelMessage = { role: "user", content: [{ type: "text", text: "读取 config.ts" }] }
const _summaryMessage: ModelMessage = { role: "user", content: "Summary" }
const _assistantMessage: ModelMessage = {
  role: "assistant",
  content: [{ type: "tool_call", toolCallId: "call_01", name: "read_file", arguments: { path: "config.ts" } }],
}
const _toolMessage: ModelMessage = {
  role: "tool",
  toolCallId: "call_01",
  content: [{ type: "text", text: "PORT=3000" }],
  isError: false,
}
// @ts-expect-error 工具结果必须提供配对 ID。
const _missingToolCallId: ModelMessage = { role: "tool", content: [{ type: "text", text: "PORT=3000" }], isError: false }
// @ts-expect-error 工具错误状态来自 ToolResult.status，不能省略。
const _missingToolStatus: ModelMessage = { role: "tool", toolCallId: "call_01", content: [] }
// @ts-expect-error user 消息不能包含 assistant 的工具调用块。
const _toolCallAsUser: ModelMessage = { role: "user", content: [{ type: "tool_call", toolCallId: "call_01", name: "read_file", arguments: {} }] }
void [_systemMessage, _userMessage, _summaryMessage, _assistantMessage, _toolMessage, _missingToolCallId, _missingToolStatus, _toolCallAsUser]

// @ts-expect-error 每个正常收尾事件都必须给出统一完成状态。
const _missingCompletion: ModelStreamEvent = { type: "stream_end", finishReason: "stop" }
void _missingCompletion

/**
 * 一份三个输入桶齐备的 Usage（Anthropic 形态，Usage 统一设计第 2 节）：
 * inputTokens 只含未缓存输入，缓存读取与写入单列。
 */
const cacheUsage: Usage = {
  inputTokens: 200,
  outputTokens: 50,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
  reasoningTokens: 20,
  totalTokens: 1150,
}

// Adapter 接口（第 6 节）：用一个具体实现赋值来验证签名，比类型恒等断言更稳固，
// 同时兼作 `ModelStreamEvent` 判别联合的可用性验证。
const _adapterImpl: ModelAdapter = {
  async *stream(request: UnifiedModelRequest, signal: AbortSignal) {
    void request
    void signal
    yield { type: "block_start", index: 0, blockType: "text" }
    yield { type: "block_delta", index: 0, delta: { type: "text", text: "hi" } }
    yield { type: "block_end", index: 0, block: { type: "text", text: "hi" } }
    yield { type: "stream_end", completion: "finished", finishReason: "end_turn", usage: cacheUsage }
  },
}

type _RequestShape = Expect<
  Equals<keyof UnifiedModelRequest, "context" | "tools" | "model">
>
type _ToolDefinitionHasSchema = Expect<Equals<UnifiedToolDefinition["inputSchema"], Record<string, unknown>>>

// ---------------------------------------------------------------------------
// 2. 运行期断言
// ---------------------------------------------------------------------------

// 从允许缺省上下文窗口的记录中解析有效窗口；运行时 ModelConfig 本身要求该值。
assert.equal(PROTOCOLS.length, 3)
assert.equal(DEFAULT_CONTEXT_WINDOW, 256000)
assert.equal(resolveContextWindow({}), 256000)
assert.equal(resolveContextWindow({ contextWindow: 200000 }), 200000)
// 显式 0 不应回落到默认值（?? 而非 ||）。
assert.equal(resolveContextWindow({ contextWindow: 0 }), 0)

// Usage 派生量（Usage 统一设计第 6 节）。以下期望值按该文档逐条手算：
//   Prompt = input + cacheRead + cacheWrite = 200 + 800 + 100 = 1100
//   Total  = Prompt + output = 1100 + 50 = 1150（与协议返回的 totalTokens 一致）
// 命中率不在此处断言：它只有累计口径，见下方第 5 节。
assert.equal(promptTokens(cacheUsage), 1100)
assert.equal(resolveTotalTokens(cacheUsage), 1150)

// 三个输入桶齐备时，优先按桶相加，而不是用 totalTokens - outputTokens。
assert.equal(
  promptTokens({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, totalTokens: 9999 }),
  1100,
)

// 「未报告」不等于 0（第 1、9 节）：缓存写入缺失时不能当作 0 参与相加，
// 但此时仍可由可信的 totalTokens 反推完整 Prompt。
const noCacheWrite: Usage = { inputTokens: 300, outputTokens: 50, cacheReadTokens: 700, totalTokens: 1050 }
assert.equal(promptTokens(noCacheWrite), 1000)
assert.equal(resolveTotalTokens(noCacheWrite), 1050)

// 缓存字段与 totalTokens 双双缺失时，完整 Prompt 无法确定，不得猜成 inputTokens。
assert.equal(promptTokens({ inputTokens: 300, outputTokens: 50 }), undefined)
assert.equal(resolveTotalTokens({ inputTokens: 300, outputTokens: 50 }), undefined)

// 边界：三者全 0 但字段齐备时，Prompt 与 Total 都是 0，而不是 undefined。
assert.equal(promptTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0)
assert.equal(resolveTotalTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0)

// reasoningTokens 已含在 outputTokens 内，不进 Total（第 1、6.3 节）：
// 同一份 Usage 加不加 reasoning 字段，Total 都是 1150。
assert.equal(resolveTotalTokens({ ...cacheUsage, reasoningTokens: undefined }), 1150)
assert.equal(resolveTotalTokens({ ...cacheUsage, reasoningTokens: 9999 }), 1150)

// ---------------------------------------------------------------------------
// 3. Usage 累计（第 7.2、7.4 节）
// ---------------------------------------------------------------------------

// 首个请求：直接作为累计初值。
{
  const first = accumulateUsage(undefined, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 })
  assert.deepEqual(first, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 })
}

// 必备字段逐次相加。
{
  const total = accumulateUsage(
    { inputTokens: 10, outputTokens: 1 },
    { inputTokens: 20, outputTokens: 2 },
  )
  assert.equal(total.inputTokens, 30)
  assert.equal(total.outputTokens, 3)
}

// 可选字段：每次请求都报告才继续存在。
{
  const total = accumulateUsage(
    { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 1 },
    { inputTokens: 20, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 2 },
  )
  assert.equal(total.cacheReadTokens, 12)
  assert.equal(total.cacheWriteTokens, 5)
  assert.equal(total.reasoningTokens, 3)
}

// 关键规则：任一次请求未报告某缓存字段 → 累计值视为未知，不能把该次当 0（第 7.2 节）。
{
  const total = accumulateUsage(
    { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2 },
    { inputTokens: 20, outputTokens: 2, cacheReadTokens: 7 }, // 这一次没报告 cacheWriteTokens
  )
  assert.equal(total.cacheReadTokens, 12, "该字段两次都有，应继续累计")
  assert.equal(total.cacheWriteTokens, undefined, "有一次未报告即视为未知")
}

// 未报告一旦出现就保持未报告，后续请求无法补救。
{
  const step1 = accumulateUsage(
    { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 },
    { inputTokens: 20, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 3 },
  )
  assert.equal(step1.cacheWriteTokens, undefined)
}

// ---------------------------------------------------------------------------
// 4. 累计缓存命中率（第 8 节）—— 命中率唯一口径
// ---------------------------------------------------------------------------

// 单次请求的累计值：命中 800，未命中 = input 200 + write 100 = 300，Prompt = 1100。
assert.equal(cacheHitRate(cacheUsage), 800 / 1100)

// 多次请求：先累计 Token 再相除，而不是对单次命中率取平均。
{
  // 请求 A：input 100, read 0,   write 0   → 命中率 0
  // 请求 B：input 0,   read 900, write 0   → 命中率 1
  const a: Usage = { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const b: Usage = { inputTokens: 0, outputTokens: 1, cacheReadTokens: 900, cacheWriteTokens: 0 }
  const total = accumulateUsage(accumulateUsage(undefined, a), b)
  // 累计命中 900；累计未命中 = input 100 + write 0 = 100；命中率 = 900/1000
  assert.equal(cacheHitRate(total), 900 / 1000)
  // 若错误地对单次命中率取平均会得到 0.5，必须与之不同。
  assert.notEqual(cacheHitRate(total), (0 + 1) / 2)
}

// 未报告 cacheReadTokens → 未知，不计算。
assert.equal(cacheHitRate({ inputTokens: 300, outputTokens: 50, cacheWriteTokens: 10 }), undefined)

// 未报告 cacheWriteTokens → 未知：它属于分母，当作 0 会高估命中率。
assert.equal(cacheHitRate({ inputTokens: 300, outputTokens: 50, cacheReadTokens: 10 }), undefined)

// 命中率为 0 是合法值，与「无法计算」区分开（全部为未缓存输入）。
assert.equal(cacheHitRate({ inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0)

// 全命中为 1。
assert.equal(cacheHitRate({ inputTokens: 0, outputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: 0 }), 1)

// 边界：分母为 0 时不计算。
assert.equal(
  cacheHitRate({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  undefined,
)

// ---------------------------------------------------------------------------
// 5. Adapter 输出契约
// ---------------------------------------------------------------------------

// Adapter 输出的流事件序列可被正常消费，且不含任何 Runtime 身份字段。
// 包在 async 函数里而非顶层 await：测试运行时是 ESM，但 tsc 按 CommonJS 检查，顶层 await 在后者不合法。
async function checkAdapterStream(): Promise<void> {
  const collected: ModelStreamEvent[] = []
  for await (const event of _adapterImpl.stream(
    { context: { messages: [_systemMessage] }, tools: [], model: { providerId: "p", protocol: "anthropic_messages", modelId: "m" } },
    new AbortController().signal,
  )) {
    collected.push(event)
  }
  assert.deepEqual(
    collected.map((e) => e.type),
    ["block_start", "block_delta", "block_end", "stream_end"],
  )
  for (const event of collected) {
    for (const runtimeField of ["eventId", "sessionId", "seq", "createdAt", "turn", "step", "blockId"]) {
      assert.equal(runtimeField in event, false, `${runtimeField} 不应出现在 Adapter 输出中`)
    }
  }
  const last = collected[collected.length - 1]
  assert.equal(last.type === "stream_end" && last.finishReason, "end_turn")
  assert.equal(last.type === "stream_end" && last.completion, "finished")
}

// 不用顶层 await：测试运行时被 Node 当 ESM，但 tsc 按 CommonJS 检查，顶层 await 在后者不合法。
// 用 then 链同时满足两边，并让失败时以非 0 退出码结束。
checkAdapterStream().then(
  () => console.log("types.test.ts: 类型断言与运行期断言通过"),
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)
