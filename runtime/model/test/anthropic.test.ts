/**
 * Anthropic Messages Adapter 测试（第 6、7、8.4、8.5、11、16.2、25 节）。
 *
 * 不依赖测试框架；直接运行：
 *   node --experimental-strip-types runtime/model/test/anthropic.test.ts
 *
 * 四类覆盖（对齐 TODOList 阶段 3 的验证要求）：
 *   1. 请求转换：统一上下文 → system + messages（含工具调用配对）；
 *   2. 正常流：thinking / text 增量 → 统一事件，finishReason 与完成状态；
 *   3. 工具调用流：增量拼装出完整 toolCallId / name / arguments；
 *   4. 取消：AbortSignal 终止请求且不重试；另附 Usage 转换与错误归一化。
 *
 * 事件构造用 `as` 断言：这里要测的是 Adapter 对协议事件的搬运规则，
 * 不需要为每个字段补齐 SDK 要求的全部属性。
 */

import assert from "node:assert/strict"

import type Anthropic from "@anthropic-ai/sdk"

import { createModelAdapter } from "../src/adapter.ts"
import {
  buildAnthropicRequest,
  createAnthropicAdapter,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  mapAnthropicStream as mapAnthropicStreamOf,
} from "../src/anthropic.ts"
import { CANCELLED, MODEL_REQUEST_FAILED } from "../../error/src/normalizer.ts"
import type { ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../src/types.ts"

import { collect, collectError, sseEvent, startFakeProvider, streamOf } from "./helpers.ts"

type RawMessageStreamEvent = Anthropic.Messages.RawMessageStreamEvent

const MODEL: ModelConfig = {
  id: "claude-test",
  providerId: "anthropic",
  protocol: "anthropic_messages",
  contextWindow: 256000,
}

/** 离线转换入口：协议事件数组 → 统一事件流（真实 SDK 的流本身就是异步可迭代的）。 */
function mapAnthropicStream(events: RawMessageStreamEvent[]): AsyncGenerator<ModelStreamEvent> {
  return mapAnthropicStreamOf(streamOf(events))
}

/** 构造协议事件；只填被测字段。 */
function event(value: Record<string, unknown>): RawMessageStreamEvent {
  return value as unknown as RawMessageStreamEvent
}

/** 一条含工具调用与工具结果的统一上下文（对照协议示例文档第 1 节）。 */
function agentRequest(): UnifiedModelRequest {
  return {
    model: { providerId: "anthropic", protocol: "anthropic_messages", modelId: "claude-test" },
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    context: {
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "读取 config.ts" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "需要读文件" },
            {
              type: "tool_call",
              toolCallId: "toolu_01",
              name: "read_file",
              arguments: { path: "/p/config.ts" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "toolu_01",
          content: [{ type: "text", text: "PORT=3000" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "当前端口是 3000。" }] },
        { role: "user", content: "改成 8080" },
      ],
    },
  }
}

/** 一个正常流：thinking + text，最终 end_turn。 */
function normalStream(): RawMessageStreamEvent[] {
  return [
    event({
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900 } },
    }),
    event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "先看看" },
    }),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "端口是 " } }),
    event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "3000。" } }),
    event({ type: "content_block_stop", index: 1 }),
    event({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 100, output_tokens: 42, cache_read_input_tokens: 900 },
    }),
    event({ type: "message_stop" }),
  ]
}

/** 事件序列的紧凑摘要，便于整体比对块结构。 */
function summarize(events: ModelStreamEvent[]): string[] {
  return events.map((item) => {
    if (item.type === "block_start") return `start:${item.index}:${item.blockType}`
    if (item.type === "block_delta") {
      if (item.delta.type === "tool_call") return `delta:${item.index}:tool_call`
      return `delta:${item.index}:${item.delta.type}=${item.delta.text}`
    }
    if (item.type === "block_end") {
      if (item.block.type === "tool_call") return `end:${item.index}:tool_call`
      return `end:${item.index}:${item.block.type}=${item.block.text}`
    }
    return `stream_end:${item.completion}`
  })
}

/** 文本块的最终内容，便于断言拼接结果。 */
function endedText(events: ModelStreamEvent[]): string {
  const ended = events.find((item) => item.type === "block_end")
  return ended?.type === "block_end" && ended.block.type === "text" ? ended.block.text : ""
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. 请求转换（第 11.1、11.3、16.2 节）
  // -------------------------------------------------------------------------

  {
    const params = buildAnthropicRequest(agentRequest(), DEFAULT_ANTHROPIC_MAX_TOKENS)

    assert.equal(params.model, "claude-test")
    assert.equal(params.max_tokens, DEFAULT_ANTHROPIC_MAX_TOKENS)
    assert.equal(params.stream, true)
    // messages[0] 对应协议的 system 位置。
    assert.equal(params.system, "You are a coding agent.")
    assert.equal(params.messages.length, 5, "system 之外的 5 条消息各自成项")

    const [user, assistantWithCall, toolResult, assistantText, lastUser] = params.messages
    assert.deepEqual(user, { role: "user", content: [{ type: "text", text: "读取 config.ts" }] })

    // thinking 不回放（协议要求 thinking 块带 signature），tool_use 保留在 assistant content。
    assert.deepEqual(assistantWithCall, {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "/p/config.ts" } }],
    })

    // 工具结果进入 user content 的 tool_result，并用 tool_use_id 配对。
    assert.deepEqual(toolResult, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "PORT=3000" }],
    })

    assert.deepEqual(assistantText, {
      role: "assistant",
      content: [{ type: "text", text: "当前端口是 3000。" }],
    })
    assert.deepEqual(lastUser, { role: "user", content: [{ type: "text", text: "改成 8080" }] })

    // 工具定义映射到 input_schema。
    assert.deepEqual(params.tools, [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ])
  }

  // 空 tools 不发送该字段（协议不接受空数组）。
  {
    const bare = agentRequest()
    bare.tools = []
    assert.equal(buildAnthropicRequest(bare, 100).tools, undefined)
  }

  // 连续的工具结果合并进同一个 user 消息：该协议不允许 tool_result 单独成条。
  {
    const multi = agentRequest()
    multi.context.messages = [
      { role: "system", content: "s" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", toolCallId: "a", name: "t1", arguments: {} },
          { type: "tool_call", toolCallId: "b", name: "t2", arguments: {} },
        ],
      },
      { role: "tool", toolCallId: "a", content: [{ type: "text", text: "ra" }], isError: false },
      { role: "tool", toolCallId: "b", content: [{ type: "text", text: "rb" }], isError: true },
    ]

    const params = buildAnthropicRequest(multi, 100)
    assert.equal(params.messages.length, 2, "两条 tool 结果合并为一个 user 消息")
    assert.deepEqual(params.messages[1], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "ra" },
        { type: "tool_result", tool_use_id: "b", content: "rb", is_error: true },
      ],
    })
  }

  // 多块文本按顺序保留（该协议保留块，只过滤空块）。
  {
    const multi = agentRequest()
    multi.context.messages = [
      { role: "system", content: "s" },
      { role: "user", content: [{ type: "text", text: "PORT=" }, { type: "text", text: "3000" }] },
    ]
    const params = buildAnthropicRequest(multi, 100)
    assert.deepEqual(params.messages[0], {
      role: "user",
      content: [
        { type: "text", text: "PORT=" },
        { type: "text", text: "3000" },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 2. 正常流：thinking / text → 统一事件（第 8.4 节）
  // -------------------------------------------------------------------------

  {
    const events = await collect(mapAnthropicStream(normalStream()))
    assert.deepEqual(summarize(events), [
      "start:0:thinking",
      "delta:0:thinking=先看看",
      "end:0:thinking=先看看",
      "start:1:text",
      "delta:1:text=端口是 ",
      "delta:1:text=3000。",
      "end:1:text=端口是 3000。",
      "stream_end:finished",
    ])
  }

  // stream_end 带 Usage、finishReason；Anthropic 的 totalTokens 由派生得到。
  {
    const events = await collect(mapAnthropicStream(normalStream()))
    const last = events[events.length - 1]
    if (last?.type !== "stream_end") throw new Error("缺少 stream_end")

    assert.equal(last.completion, "finished")
    assert.equal(last.finishReason, "end_turn")
    assert.equal(last.usage?.inputTokens, 100)
    assert.equal(last.usage?.outputTokens, 42, "message_delta 的累计 output_tokens 生效")
    assert.equal(last.usage?.cacheReadTokens, 900, "message_start 的缓存字段被保留")
    assert.equal(last.usage?.cacheWriteTokens, undefined, "未报告的字段保持未报告")
  }

  // 块序号重编号：协议 index 不连续时统一流仍从 0 起连续。
  {
    const events = await collect(
      mapAnthropicStream([
        event({ type: "content_block_start", index: 7, content_block: { type: "text", text: "" } }),
        event({ type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "x" } }),
        event({ type: "content_block_stop", index: 7 }),
        event({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
        event({ type: "message_stop" }),
      ]),
    )
    assert.deepEqual(
      events.filter((item) => item.type === "block_start").map((item) => item.index),
      [0],
    )
    assert.deepEqual(
      events.filter((item) => item.type === "block_end").map((item) => item.index),
      [0],
    )
  }

  // 没有统一表达的块（如 redacted_thinking）被忽略，不影响后续块的序号。
  {
    const events = await collect(
      mapAnthropicStream([
        event({
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking", data: "opaque" },
        }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        }),
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
        event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } }),
        event({ type: "content_block_stop", index: 1 }),
        event({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
        event({ type: "message_stop" }),
      ]),
    )
    assert.deepEqual(
      events.filter((item) => item.type === "block_end").map((item) => item.index),
      [0],
      "被忽略的块不占用统一 index",
    )
  }

  // stop_reason 与完成状态的对应（第 8.5 节）。
  const stopReasons: Array<[string | undefined, string]> = [
    ["max_tokens", "incomplete"],
    ["model_context_window_exceeded", "incomplete"],
    ["stop_sequence", "finished"],
    ["refusal", "finished"],
    ["pause_turn", "unknown"],
    [undefined, "unknown"],
  ]
  for (const [stopReason, expected] of stopReasons) {
    const events = await collect(
      mapAnthropicStream([
        event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
        event({
          type: "message_delta",
          delta: { stop_reason: stopReason ?? null, stop_sequence: null },
          usage: { output_tokens: 3 },
        }),
        event({ type: "message_stop" }),
      ]),
    )
    const last = events[events.length - 1]
    assert.equal(
      last?.type === "stream_end" ? last.completion : undefined,
      expected,
      `stop_reason=${stopReason}`,
    )
  }

  // 被截断的文本仍要收尾（内容就是已收到的增量）。
  {
    const events = await collect(
      mapAnthropicStream([
        event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
        event({
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { output_tokens: 3 },
        }),
        event({ type: "message_stop" }),
      ]),
    )
    assert.equal(
      events.filter((item) => item.type === "block_end").length,
      1,
      "未收到 content_block_stop 的文本块仍应结束",
    )
  }

  // 没有 message_stop 就结束（连接被截断）→ 抛错，不产出 stream_end。
  {
    const error = await collectError(
      mapAnthropicStream([
        event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      ]),
    )
    assert.match(String((error as Error).message), /中断/)
  }

  // -------------------------------------------------------------------------
  // 3. 工具调用流：增量拼装（第 8.4 节）
  // -------------------------------------------------------------------------

  {
    const events = await collect(
      mapAnthropicStream([
        event({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_9", name: "read_file", input: {} },
        }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"/a.ts"}' },
        }),
        event({ type: "content_block_stop", index: 0 }),
        event({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 20 },
        }),
        event({ type: "message_stop" }),
      ]),
    )

    // id 与 name 在块开始时就以增量给出，不必等第一个参数分片。
    const firstDelta = events.find((item) => item.type === "block_delta")
    assert.deepEqual(firstDelta, {
      type: "block_delta",
      index: 0,
      delta: { type: "tool_call", toolCallId: "toolu_9", nameDelta: "read_file" },
    })

    const ended = events.find((item) => item.type === "block_end")
    assert.deepEqual(ended, {
      type: "block_end",
      index: 0,
      block: {
        type: "tool_call",
        toolCallId: "toolu_9",
        name: "read_file",
        arguments: { path: "/a.ts" },
      },
    })

    const last = events[events.length - 1]
    assert.equal(last?.type === "stream_end" ? last.completion : undefined, "tool_calls")
    assert.equal(last?.type === "stream_end" ? last.finishReason : undefined, "tool_use")
  }

  // tool_use 但没有 content_block_stop → 不产出 block_end，完成状态不是 tool_calls。
  {
    const events = await collect(
      mapAnthropicStream([
        event({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_x", name: "read_file", input: {} },
        }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        }),
        event({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 5 },
        }),
        event({ type: "message_stop" }),
      ]),
    )

    assert.equal(
      events.filter((item) => item.type === "block_end").length,
      0,
      "未结束的 tool_call 不产出 block_end（第 8.5 节）",
    )
    const last = events[events.length - 1]
    assert.equal(last?.type === "stream_end" ? last.completion : undefined, "unknown")
  }

  // 被截断的参数原样保留，便于上层判断而不是悄悄丢掉。
  {
    const events = await collect(
      mapAnthropicStream([
        event({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t", name: "f", input: {} },
        }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"/a.t' },
        }),
        event({ type: "content_block_stop", index: 0 }),
        event({
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { output_tokens: 5 },
        }),
        event({ type: "message_stop" }),
      ]),
    )
    const ended = events.find((item) => item.type === "block_end")
    assert.deepEqual(ended?.type === "block_end" ? ended.block : undefined, {
      type: "tool_call",
      toolCallId: "t",
      name: "f",
      arguments: '{"path":"/a.t',
    })
  }

  // content_block_start 已带文本时补一条增量，保证增量之和与 block_end 内容一致。
  {
    const events = await collect(
      mapAnthropicStream([
        event({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "开头" },
        }),
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "结尾" } }),
        event({ type: "content_block_stop", index: 0 }),
        event({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        }),
        event({ type: "message_stop" }),
      ]),
    )
    assert.equal(events.filter((item) => item.type === "block_delta").length, 2)
    assert.equal(endedText(events), "开头结尾")
  }

  // -------------------------------------------------------------------------
  // 4. 端到端：真实 SDK + HTTP + SSE（含 Usage、取消、错误归一化）
  // -------------------------------------------------------------------------

  const provider = await startFakeProvider((request) => {
    if (request.headers["x-test-scenario"] === "cancel") return { events: [], hang: true }
    return {
      events: [
        sseEvent("message_start", {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 50,
              output_tokens: 1,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5,
            },
          },
        }),
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "pong" },
        }),
        sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 12 },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ],
    }
  })

  try {
    const adapter = createModelAdapter(MODEL, {
      apiKey: "test-key",
      baseURL: provider.baseURL("anthropic_messages"),
    })
    const events = await collect(adapter.stream(agentRequest(), new AbortController().signal))

    // 请求确实按该协议发出：system 独立、tool_result 在 user content、工具定义用 input_schema。
    const sent = provider.requests[0]
    assert.equal(sent?.path, "/v1/messages")
    assert.equal(sent?.body.system, "You are a coding agent.")
    assert.equal(sent?.body.stream, true)
    assert.equal(sent?.body.max_tokens, DEFAULT_ANTHROPIC_MAX_TOKENS)
    assert.equal(sent?.headers["x-api-key"] as string | undefined, "test-key")
    const sentMessages = sent?.body.messages as Array<Record<string, unknown>>
    assert.equal(sentMessages.length, 5)
    assert.deepEqual((sentMessages[2]?.content as unknown[])[0], {
      type: "tool_result",
      tool_use_id: "toolu_01",
      content: "PORT=3000",
    })

    const last = events[events.length - 1]
    if (last?.type !== "stream_end") throw new Error("缺少 stream_end")
    assert.equal(last.completion, "finished")
    assert.equal(last.usage?.inputTokens, 50)
    assert.equal(last.usage?.outputTokens, 12)
    assert.equal(last.usage?.cacheReadTokens, 10)
    assert.equal(last.usage?.cacheWriteTokens, 5)

    // 取消：请求挂起时 abort → 抛 CANCELLED，且不重试（只发出一次请求）。
    const controller = new AbortController()
    const cancelling = createAnthropicAdapter(MODEL, {
      apiKey: "k",
      baseURL: provider.baseURL("anthropic_messages"),
      defaultHeaders: { "x-test-scenario": "cancel" },
    })
    const errorPromise = collectError(cancelling.stream(agentRequest(), controller.signal))
    setTimeout(() => controller.abort(), 30)
    const cancelError = await errorPromise
    assert.equal(
      (cancelError as { code?: string }).code,
      CANCELLED,
      "用户取消必须归一化为 CANCELLED（第 14、25 节）",
    )
    assert.equal(
      provider.requests.filter((item) => item.headers["x-test-scenario"] === "cancel").length,
      1,
      "取消不得触发重试",
    )
  } finally {
    await provider.close()
  }

  // 流中途断开（尚无有效输出）→ 自动重试，且失败尝试的 block_start 不得泄漏给消费方。
  // 这是第 7 节重试边界最容易出错的一条：重复的 block_start 会让 AgentLoop 写出两个块。
  {
    const provider = await startFakeProvider((_request, attempt) => {
      // 第 1 次：只发出块开始就断开连接；第 2 次：完整成功。
      if (attempt === 0) {
        return {
          events: [
            sseEvent("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            }),
          ],
          destroy: true,
        }
      }
      return {
        events: [
          sseEvent("message_start", {
            type: "message_start",
            message: {
              id: "msg_2",
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 1 },
            },
          }),
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "重试后成功" },
          }),
          sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
          sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 6 },
          }),
          sseEvent("message_stop", { type: "message_stop" }),
        ],
      }
    })

    try {
      const adapter = createModelAdapter(MODEL, {
        apiKey: "k",
        baseURL: provider.baseURL("anthropic_messages"),
      })
      const events = await collect(adapter.stream(agentRequest(), new AbortController().signal))

      assert.equal(provider.requests.length, 2, "首次失败应重试一次")
      assert.deepEqual(
        events.filter((item) => item.type === "block_start").map((item) => item.index),
        [0],
        "失败尝试的 block_start 不得泄漏，否则会出现两个块",
      )
      assert.equal(endedText(events), "重试后成功", "重试后的块内容连续")

      const last = events[events.length - 1]
      if (last?.type !== "stream_end") throw new Error("缺少 stream_end")
      assert.equal(last.completion, "finished")
      assert.equal(last.usage?.outputTokens, 6)
    } finally {
      await provider.close()
    }
  }

  // 4xx（不可重试）→ 只请求一次，包装为 REQUEST_FAILED 并保留状态码。
  {
    const provider = await startFakeProvider({ status: 400, events: [] })
    try {
      const adapter = createModelAdapter(MODEL, {
        apiKey: "k",
        baseURL: provider.baseURL("anthropic_messages"),
      })
      const error = await collectError(adapter.stream(agentRequest(), new AbortController().signal))
      assert.equal((error as { code?: string }).code, MODEL_REQUEST_FAILED)
      assert.equal((error as { source?: string }).source, "model")
      assert.equal((error as { details?: { status?: number } }).details?.status, 400)
      assert.equal(provider.requests.length, 1, "400 不可重试")
    } finally {
      await provider.close()
    }
  }

  // 5xx（可重试）→ 重试耗尽后归一化，共 3 次尝试。
  {
    const provider = await startFakeProvider({ status: 503, events: [] })
    try {
      const adapter = createModelAdapter(MODEL, {
        apiKey: "k",
        baseURL: provider.baseURL("anthropic_messages"),
      })
      const error = await collectError(adapter.stream(agentRequest(), new AbortController().signal))
      assert.equal((error as { code?: string }).code, MODEL_REQUEST_FAILED)
      assert.equal(provider.requests.length, 3, "503 属于可重试情形（第 7 节）")
    } finally {
      await provider.close()
    }
  }

  // 请求模型与 Adapter 绑定不一致 → runtime 侧错误，不发请求。
  {
    const provider = await startFakeProvider({ events: [] })
    try {
      const adapter = createModelAdapter(MODEL, {
        apiKey: "k",
        baseURL: provider.baseURL("anthropic_messages"),
      })
      const mismatched = agentRequest()
      mismatched.model = {
        providerId: "anthropic",
        protocol: "anthropic_messages",
        modelId: "别的模型",
      }
      const error = await collectError(adapter.stream(mismatched, new AbortController().signal))
      assert.equal((error as { code?: string }).code, "INVALID_MODEL_REQUEST")
      assert.equal(provider.requests.length, 0, "请求非法时不应发出网络请求")
    } finally {
      await provider.close()
    }
  }

  console.log("anthropic.test.ts: Anthropic Messages Adapter 断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
