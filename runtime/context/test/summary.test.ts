import { requestMessages } from "../../model/test/helpers.ts"
/** 独立压缩调用测试：无真实网络、工具执行器或 Session 持久化。 */
import assert from "node:assert/strict"
import { compressContext, summaryThreshold } from "../src/summary.ts"
import { COMPACT_PROMPT } from "../src/compact-prompt.ts"
import type { ModelAdapter, ModelMessage, ModelRef, ModelStreamEvent, UnifiedModelRequest, UnifiedToolDefinition } from "../../model/src/types.ts"

const MODEL: ModelRef = { providerId: "test", protocol: "responses", modelId: "test", name: "test", reasoningLevel: "medium" }
const CONTENT: ModelMessage[] = [
  { role: "system", content: "Original system, AGENTS.md and skills" },
  { role: "user", content: "Existing summary" },
  { role: "user", content: [{ type: "text", text: "Read file" }] },
  { role: "assistant", content: [{ type: "thinking", text: "reason" }, { type: "tool_call", toolCallId: "call", name: "read", arguments: { path: "a" } }] },
  { role: "tool", toolCallId: "call", content: [{ type: "text", text: "file" }], isError: false },
]
const TOOLS: UnifiedToolDefinition[] = [{ name: "read", description: "read file", inputSchema: { type: "object" } }]

/** @param text 最终正文。 @returns 合法的完整文本流。 */
function textStream(text = "summary"): ModelStreamEvent[] {
  return [
    { type: "block_start", index: 0, blockType: "thinking" },
    { type: "block_end", index: 0, block: { type: "thinking", text: "hidden" } },
    { type: "block_start", index: 1, blockType: "text" },
    { type: "block_delta", index: 1, delta: { type: "text", text } },
    { type: "block_end", index: 1, block: { type: "text", text } },
    { type: "stream_end", completion: "finished", usage: { inputTokens: 20, outputTokens: 4 } },
  ]
}

/** @param events 本次脚本事件。 @returns 只产出脚本的 Adapter。 */
function adapter(events: ModelStreamEvent[]): ModelAdapter {
  return { async *stream() { yield* events } }
}

/** @returns 阈值、输入保留、失败及取消的全部断言完成。 @throws AssertionError 行为不符合契约。 */
async function main(): Promise<void> {
  assert.equal(summaryThreshold(200000, 1000), 160000)
  assert.equal(summaryThreshold(128000, 32000), 54000)
  assert.equal(summaryThreshold(10000, 1000), -2000)
  assert.equal(summaryThreshold(12000, 1000), 0)
  for (const values of [[undefined, 1], [100, undefined], [NaN, 1], [100, 0], [1.5, 1]] as const) {
    assert.throws(() => summaryThreshold(values[0], values[1]), /Summary/)
  }
  const input = structuredClone(CONTENT), tools = structuredClone(TOOLS)
  let seen: UnifiedModelRequest | undefined
  const spy: ModelAdapter = { async *stream(request) { seen = structuredClone(request); yield* textStream() } }
  const options = { adapter: spy, model: MODEL, content: input, tools, signal: new AbortController().signal }
  assert.deepEqual(await compressContext(options), { summary: "summary", usage: { inputTokens: 20, outputTokens: 4 } })
  assert.deepEqual(seen!.model, MODEL)
  assert.equal(seen!.toolChoice, "none")
  assert.deepEqual(seen!.context.messages, [...CONTENT, { role: "user", content: COMPACT_PROMPT }])
  assert.deepEqual(seen!.tools, TOOLS)
  assert.deepEqual(input, CONTENT)
  assert.deepEqual(tools, TOOLS)
  assert.match(COMPACT_PROMPT, /checkpoint/i)
  const hostile: ModelAdapter = { async *stream(request) {
    requestMessages(request).length = 0; request.tools.length = 0
    yield* textStream()
  } }
  await compressContext({ ...options, adapter: hostile })
  assert.deepEqual(input, CONTENT)
  assert.deepEqual(tools, TOOLS)

  const bad: ModelStreamEvent[][] = [
    [], textStream("   "), textStream().slice(0, -1),
    [{ type: "block_start", index: 0, blockType: "text" }, { type: "stream_end", completion: "finished" }],
    [{ type: "block_end", index: 0, block: { type: "text", text: "orphan" } }, { type: "stream_end", completion: "finished" }],
    [{ type: "block_start", index: 0, blockType: "tool_call" }],
    [{ type: "block_delta", index: 0, delta: { type: "tool_call", toolCallId: "call" } }],
    [{ type: "block_end", index: 0, block: { type: "tool_call", toolCallId: "call", name: "read", arguments: {} } }],
    ...(["incomplete", "unknown", "tool_calls"] as const).map((completion): ModelStreamEvent[] => [...textStream().slice(0, -1), { type: "stream_end", completion }]),
    [...textStream(), { type: "stream_end", completion: "finished" }],
  ]
  for (const events of bad) await assert.rejects(compressContext({ ...options, adapter: adapter(events) }), /Summary/)
  const failure = new Error("network failed")
  await assert.rejects(compressContext({ ...options, adapter: { async *stream() { yield* textStream().slice(0, -1); throw failure } } }), (error) => error === failure)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(compressContext({ ...options, signal: controller.signal }), { name: "AbortError" })
  const during = new AbortController()
  await assert.rejects(compressContext({ ...options, signal: during.signal, adapter: { async *stream() {
    yield textStream()[0]; during.abort(); yield textStream()[1]
  } } }), { name: "AbortError" })
  console.log("summary.test.ts: threshold, complete input, stream validation, tool rejection and cancellation passed")
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
