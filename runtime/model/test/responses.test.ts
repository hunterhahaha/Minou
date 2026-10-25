/**
 * Responses Adapter 测试（第 6、7、8.4、8.5、11、16.2、25 节）。
 *
 * 不依赖测试框架；直接运行：
 *   node --experimental-strip-types runtime/model/test/responses.test.ts
 *
 * 四类覆盖（对齐 TODOList 阶段 5 的验证要求）：
 *   1. 请求转换：统一上下文 → instructions + input（function_call / function_call_output；
 *      一条 assistant 消息会展开成 message + 若干 function_call item）；
 *   2. 正常流：reasoning / text 增量 → 统一事件，status 与完成状态；
 *   3. 工具调用流：由 `output_item.done` 决定调用完整性，参数以 done 事件为准；
 *   4. 取消：请求挂起时 abort → CANCELLED，且不重试；另附 Usage 转换与错误归一化。
 */

import assert from "node:assert/strict"

import type OpenAI from "openai"

import { createModelAdapter } from "../src/adapter.ts"
import {
  buildResponsesRequest,
  createResponsesAdapter,
  mapResponsesStream as mapResponsesStreamOf,
  toResponsesInput,
} from "../src/responses.ts"
import { CANCELLED, MODEL_REQUEST_FAILED } from "../../error/src/normalizer.ts"
import type { ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../src/types.ts"

import { collect, collectError, sseData, startFakeProvider, streamOf } from "./helpers.ts"

type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent

const MODEL: ModelConfig = {
  modelId: "model-record-3",
  name: "gpt-responses-test",
  providerId: "openai",
  protocol: "responses",
  contextWindow: 256000,
  maxOutputTokens: 32000,
  reasoningLevels: ["low", "medium", "high"],
  reasoningField: { path: ["reasoning", "effort"] },
}

/** 离线转换入口：协议事件数组 → 统一事件流。 */
function mapResponsesStream(events: ResponseStreamEvent[]): AsyncGenerator<ModelStreamEvent> {
  return mapResponsesStreamOf(streamOf(events))
}

/** 构造协议事件；只填被测字段。 */
function event(value: Record<string, unknown>): ResponseStreamEvent {
  return value as unknown as ResponseStreamEvent
}

function textMessageItem(id = "item_1"): Record<string, unknown> {
  return { id, type: "message", role: "assistant", status: "in_progress", content: [] }
}

function functionCallItem(id: string, callId: string, name: string): Record<string, unknown> {
  return { id, type: "function_call", call_id: callId, name, arguments: "", status: "in_progress" }
}

/** response.completed / .incomplete 的结束事件；`output` 用于判断是否含函数调用。 */
function terminalEvent(
  type: "response.completed" | "response.incomplete",
  options: {
    output?: unknown[]
    status?: string
    reason?: string
    usage?: Record<string, unknown>
  } = {},
): Record<string, unknown> {
  return {
    type,
    sequence_number: 99,
    response: {
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt-responses-test",
      output: options.output ?? [],
      status: options.status ?? (type === "response.completed" ? "completed" : "incomplete"),
      incomplete_details: options.reason === undefined ? null : { reason: options.reason },
      error: null,
      usage: options.usage ?? null,
    },
  }
}

/** 一条含工具调用与工具结果的统一上下文（对照协议示例文档第 3 节）。 */
function agentRequest(): UnifiedModelRequest {
  return {
    model: { providerId: "openai", protocol: "responses", modelId: "model-record-3", name: "gpt-responses-test", reasoningLevel: "medium" },
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
            { type: "text", text: "我先看一下。" },
            {
              type: "tool_call",
              toolCallId: "call_01",
              name: "read_file",
              arguments: { path: "/p/config.ts" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_01",
          content: [{ type: "text", text: "PORT=3000" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "当前端口是 3000。" }] },
        { role: "user", content: "改成 8080" },
      ],
    },
  }
}

/** 事件序列的紧凑摘要，便于整体比对块结构。 */
function summarize(events: ModelStreamEvent[]): string[] {
  return events.map((item) => {
    if (item.type === "block_start") return `start:${item.index}:${item.blockType}`
    if (item.type === "block_delta") {
      if (item.delta.type === "tool_call") return `delta:${item.index}:tool_call`
      return `delta:${item.index}:${item.delta.text}`
    }
    if (item.type === "block_end") {
      if (item.block.type === "tool_call") return `end:${item.index}:tool_call`
      return `end:${item.index}:${item.block.type}=${item.block.text}`
    }
    return `stream_end:${item.completion}`
  })
}

/** stream_end 的完成状态。 */
function completionOf(events: ModelStreamEvent[]): string | undefined {
  const last = events[events.length - 1]
  return last?.type === "stream_end" ? last.completion : undefined
}

/** 某个块的最终内容。 */
function endedBlock(
  events: ModelStreamEvent[],
  blockType: "text" | "thinking" | "tool_call",
): Record<string, unknown> | undefined {
  const ended = events.find(
    (item) => item.type === "block_end" && item.block.type === blockType,
  )
  return ended?.type === "block_end"
    ? (ended.block as unknown as Record<string, unknown>)
    : undefined
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. 请求转换（第 11.1、11.3、16.2 节）
  // -------------------------------------------------------------------------

  {
    const params = buildResponsesRequest(agentRequest(), MODEL)
    const compact = buildResponsesRequest({ ...agentRequest(), toolChoice: "none" }, MODEL)
    assert.equal(compact.tool_choice, "none")
    assert.deepEqual(compact.tools, params.tools)
    assert.deepEqual(compact.input, params.input)
    assert.equal(params.tool_choice, undefined)

    assert.equal(params.model, "gpt-responses-test")
    assert.deepEqual(params.reasoning, { effort: "medium" })
    const nested = buildResponsesRequest(agentRequest(), { ...MODEL, reasoningField: { path: ["vendor", "effort"] } })
    assert.deepEqual((nested as unknown as Record<string, unknown>).vendor, { effort: "medium" })
    assert.throws(() => buildResponsesRequest(agentRequest(), { ...MODEL, reasoningField: { path: ["model"] } }),
      (error: unknown) => typeof error === "object" && error !== null && "message" in error && error.message === "模型的推理等级请求字段无效")
    assert.throws(() => buildResponsesRequest({ ...agentRequest(), model: { ...agentRequest().model, reasoningLevel: "unsupported" } }, MODEL),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "INVALID_MODEL_REQUEST")
    assert.equal(params.stream, true)
    // 自己维护 Session 与上下文，不依赖服务端保存。
    assert.equal(params.store, false)
    // 不使用 previous_response_id：每次完整传入上下文（示例文档明确的方式）。
    assert.equal((params as unknown as Record<string, unknown>).previous_response_id, undefined)

    // messages[0] 对应 instructions。
    assert.equal(params.instructions, "You are a coding agent.")

    const input = params.input as unknown as Array<Record<string, unknown>>
    assert.deepEqual(input[0], { role: "user", content: "读取 config.ts" })
    // assistant 消息展开成 message + 若干 function_call item（协议要求两者同级）。
    assert.deepEqual(input[1], { role: "assistant", content: "我先看一下。" })
    assert.deepEqual(input[2], {
      type: "function_call",
      call_id: "call_01",
      name: "read_file",
      arguments: '{"path":"/p/config.ts"}',
    })
    assert.deepEqual(input[3], {
      type: "function_call_output",
      call_id: "call_01",
      output: "PORT=3000",
    })
    assert.deepEqual(input[4], { role: "assistant", content: "当前端口是 3000。" })
    assert.deepEqual(input[5], { role: "user", content: "改成 8080" })

    // 工具定义：该协议的 parameters 直接是 JSON Schema。
    assert.deepEqual(params.tools, [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: false,
      },
    ])
  }

  // 空 tools 不发送该字段。
  {
    const bare = agentRequest()
    bare.tools = []
    assert.equal(buildResponsesRequest(bare, MODEL).tools, undefined)
  }

  // 多块文本拼接；thinking 不回放；工具结果只取 text。
  {
    const input = toResponsesInput([
      { role: "user", content: [{ type: "text", text: "PORT=" }, { type: "text", text: "3000" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "推理不回放" },
          { type: "tool_call", toolCallId: "c1", name: "t", arguments: {} },
        ],
      },
      { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: true },
    ])
    assert.deepEqual(input, [
      { role: "user", content: "PORT=3000" },
      { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ])
  }

  // 带 isError 的工具结果仍按文本传出（该协议没有 is_error 位置，第 16.2 节）。
  {
    const input = toResponsesInput([
      { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "失败原因" }], isError: true },
    ])
    assert.deepEqual(input, [{ type: "function_call_output", call_id: "c1", output: "失败原因" }])
  }

  // 空文本消息不发送。
  assert.deepEqual(toResponsesInput([{ role: "user", content: "" }]), [])

  // -------------------------------------------------------------------------
  // 2. 正常流（第 8.4、8.5 节）
  // -------------------------------------------------------------------------

  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.created",
          sequence_number: 0,
          response: { id: "r", status: "in_progress" },
        }),
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: { id: "rs_1", type: "reasoning", summary: [] },
        }),
        event({
          type: "response.reasoning_summary_text.delta",
          sequence_number: 2,
          item_id: "rs_1",
          output_index: 0,
          summary_index: 0,
          delta: "先想",
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: { id: "rs_1", type: "reasoning", summary: [] },
        }),
        event({
          type: "response.output_item.added",
          sequence_number: 4,
          output_index: 1,
          item: textMessageItem("msg_1"),
        }),
        event({
          type: "response.output_text.delta",
          sequence_number: 5,
          item_id: "msg_1",
          output_index: 1,
          content_index: 0,
          delta: "端口是 ",
        }),
        event({
          type: "response.output_text.delta",
          sequence_number: 6,
          item_id: "msg_1",
          output_index: 1,
          content_index: 0,
          delta: "3000。",
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 7,
          output_index: 1,
          item: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [],
          },
        }),
        event(terminalEvent("response.completed")),
      ]),
    )

    assert.deepEqual(summarize(events), [
      "start:0:thinking",
      "delta:0:先想",
      "end:0:thinking=先想",
      "start:1:text",
      "delta:1:端口是 ",
      "delta:1:3000。",
      "end:1:text=端口是 3000。",
      "stream_end:finished",
    ])
  }

  // reasoning 原文通道（非摘要）也能产出 thinking 增量。
  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: { id: "rs_1", type: "reasoning", summary: [] },
        }),
        event({
          type: "response.reasoning_text.delta",
          sequence_number: 2,
          item_id: "rs_1",
          output_index: 0,
          content_index: 0,
          delta: "原始推理",
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: { id: "rs_1", type: "reasoning", summary: [] },
        }),
        event(terminalEvent("response.completed")),
      ]),
    )
    assert.equal(endedBlock(events, "thinking")?.text, "原始推理")
  }

  // 摘要模式下没有 delta：summary 只在 output_item.done 出现，也要补一条增量。
  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: { id: "rs_1", type: "reasoning", summary: [] },
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 0,
          item: {
            id: "rs_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "摘要内容" }],
          },
        }),
        event(terminalEvent("response.completed")),
      ]),
    )
    assert.deepEqual(
      events.map((item) => item.type),
      ["block_start", "block_delta", "block_end", "stream_end"],
    )
    assert.equal(endedBlock(events, "thinking")?.text, "摘要内容")
  }

  // Usage 与完成状态：status=completed 且没有函数调用 → finished。
  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: textMessageItem(),
        }),
        event({
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "item_1",
          output_index: 0,
          content_index: 0,
          delta: "ok",
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: { id: "item_1", type: "message", role: "assistant", status: "completed", content: [] },
        }),
        event(
          terminalEvent("response.completed", {
            usage: {
              input_tokens: 900,
              output_tokens: 150,
              total_tokens: 1050,
              input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
              output_tokens_details: { reasoning_tokens: 50 },
            },
          }),
        ),
      ]),
    )

    const last = events[events.length - 1]
    if (last?.type !== "stream_end") throw new Error("缺少 stream_end")
    assert.equal(last.completion, "finished")
    assert.equal(last.finishReason, "completed")
    assert.equal(last.usage?.inputTokens, 100, "900 - 700 - 100")
    assert.equal(last.usage?.outputTokens, 150)
    assert.equal(last.usage?.cacheReadTokens, 700)
    assert.equal(last.usage?.cacheWriteTokens, 100)
    assert.equal(last.usage?.reasoningTokens, 50)
    assert.equal(last.usage?.totalTokens, 1050)
  }

  // status=incomplete → incomplete，finishReason 取 incomplete_details.reason。
  {
    const events = await collect(
      mapResponsesStream([
        event(terminalEvent("response.incomplete", { reason: "max_output_tokens" })),
      ]),
    )
    const last = events[events.length - 1]
    assert.equal(last?.type === "stream_end" ? last.completion : undefined, "incomplete")
    assert.equal(last?.type === "stream_end" ? last.finishReason : undefined, "max_output_tokens")
  }

  // 没有 Usage → stream_end 不带 usage。
  {
    const events = await collect(
      mapResponsesStream([event(terminalEvent("response.completed"))]),
    )
    const last = events[events.length - 1]
    assert.equal(last?.type === "stream_end" ? last.usage : "missing", undefined)
  }

  // status=failed 与 error 事件 → 抛错，不产出 stream_end（第 8.5 节）。
  {
    const error = await collectError(
      mapResponsesStream([
        event({
          type: "response.failed",
          sequence_number: 1,
          response: { id: "r", error: { code: "server_error", message: "upstream exploded" } },
        }),
      ]),
    )
    assert.match(String((error as Error).message), /server_error/)
  }
  {
    const error = await collectError(
      mapResponsesStream([
        event({ type: "error", sequence_number: 1, code: "bad", message: "流内错误", param: null }),
      ]),
    )
    assert.match(String((error as Error).message), /流内错误/)
  }

  // 没有结束事件就断流 → 抛中断错误。
  {
    const error = await collectError(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: textMessageItem(),
        }),
      ]),
    )
    assert.match(String((error as Error).message), /中断/)
  }

  // 非文本 / 非函数调用的 item（如 web_search_call）被忽略。
  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: { id: "ws_1", type: "web_search_call", status: "completed" },
        }),
        event(terminalEvent("response.completed")),
      ]),
    )
    assert.equal(events.filter((item) => item.type === "block_start").length, 0)
  }

  // -------------------------------------------------------------------------
  // 3. 工具调用流：完整性由 output_item.done 决定（第 8.4、8.5 节）
  // -------------------------------------------------------------------------

  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: functionCallItem("fc_1", "call_9", "read_file"),
        }),
        event({
          type: "response.function_call_arguments.delta",
          sequence_number: 2,
          item_id: "fc_1",
          output_index: 0,
          delta: '{"path":',
        }),
        event({
          type: "response.function_call_arguments.delta",
          sequence_number: 3,
          item_id: "fc_1",
          output_index: 0,
          delta: '"/a.ts"}',
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 4,
          output_index: 0,
          item: {
            ...functionCallItem("fc_1", "call_9", "read_file"),
            arguments: '{"path":"/a.ts"}',
            status: "completed",
          },
        }),
        event(
          terminalEvent("response.completed", {
            output: [
              {
                id: "fc_1",
                type: "function_call",
                call_id: "call_9",
                name: "read_file",
                arguments: '{"path":"/a.ts"}',
              },
            ],
          }),
        ),
      ]),
    )

    // id 与 name 在块开始时就以增量给出。
    const firstDelta = events.find((item) => item.type === "block_delta")
    assert.deepEqual(firstDelta, {
      type: "block_delta",
      index: 0,
      delta: { type: "tool_call", toolCallId: "call_9", nameDelta: "read_file" },
    })

    assert.deepEqual(endedBlock(events, "tool_call"), {
      type: "tool_call",
      toolCallId: "call_9",
      name: "read_file",
      arguments: { path: "/a.ts" },
    })
    assert.equal(completionOf(events), "tool_calls")

    const last = events[events.length - 1]
    assert.equal(last?.type === "stream_end" ? last.finishReason : undefined, "completed")
  }

  // function_call_arguments.done 带最终完整参数：以它为准（增量丢包也不影响）。
  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: functionCallItem("fc_1", "c", "f"),
        }),
        event({
          type: "response.function_call_arguments.delta",
          sequence_number: 2,
          item_id: "fc_1",
          output_index: 0,
          delta: '{"a"',
        }),
        event({
          type: "response.function_call_arguments.done",
          sequence_number: 3,
          item_id: "fc_1",
          output_index: 0,
          arguments: '{"a":1}',
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 4,
          output_index: 0,
          item: { ...functionCallItem("fc_1", "c", "f"), arguments: '{"a":1}', status: "completed" },
        }),
        event(terminalEvent("response.completed", { output: [{ type: "function_call" }] })),
      ]),
    )
    assert.deepEqual(endedBlock(events, "tool_call"), {
      type: "tool_call",
      toolCallId: "c",
      name: "f",
      arguments: { a: 1 },
    })
  }

  // 没有 output_item.done 的调用 → 不产出 block_end，完成状态不是 tool_calls。
  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: functionCallItem("fc_1", "c", "f"),
        }),
        event({
          type: "response.function_call_arguments.delta",
          sequence_number: 2,
          item_id: "fc_1",
          output_index: 0,
          delta: '{"a":',
        }),
        // 被截断：status=incomplete，没有 output_item.done。
        event(terminalEvent("response.incomplete", { reason: "max_output_tokens" })),
      ]),
    )
    assert.equal(
      events.filter((item) => item.type === "block_end").length,
      0,
      "未完成的调用不得当成完整调用",
    )
    assert.equal(completionOf(events), "incomplete")
  }

  // 并行工具调用：两个 item 各自独立成块。
  {
    const events = await collect(
      mapResponsesStream([
        event({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: functionCallItem("fc_1", "c0", "a"),
        }),
        event({
          type: "response.output_item.added",
          sequence_number: 2,
          output_index: 1,
          item: functionCallItem("fc_2", "c1", "b"),
        }),
        event({
          type: "response.function_call_arguments.delta",
          sequence_number: 3,
          item_id: "fc_1",
          output_index: 0,
          delta: "{}",
        }),
        event({
          type: "response.function_call_arguments.delta",
          sequence_number: 4,
          item_id: "fc_2",
          output_index: 1,
          delta: "{}",
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 5,
          output_index: 0,
          item: { ...functionCallItem("fc_1", "c0", "a"), arguments: "{}", status: "completed" },
        }),
        event({
          type: "response.output_item.done",
          sequence_number: 6,
          output_index: 1,
          item: { ...functionCallItem("fc_2", "c1", "b"), arguments: "{}", status: "completed" },
        }),
        event(
          terminalEvent("response.completed", {
            output: [{ type: "function_call" }, { type: "function_call" }],
          }),
        ),
      ]),
    )

    const ids = events
      .filter((item) => item.type === "block_end")
      .map((item) =>
        item.type === "block_end" && item.block.type === "tool_call" ? item.block.toolCallId : "",
      )
    assert.deepEqual(ids, ["c0", "c1"])
    assert.equal(completionOf(events), "tool_calls")
  }

  // status=completed 但没有任何函数调用 → finished（不凭"有工具定义"推断）。
  {
    const events = await collect(
      mapResponsesStream([event(terminalEvent("response.completed"))]),
    )
    assert.equal(completionOf(events), "finished")
  }

  // -------------------------------------------------------------------------
  // 4. 端到端：真实 SDK + HTTP + SSE
  // -------------------------------------------------------------------------

  const provider = await startFakeProvider((request) => {
    if (request.headers["x-test-scenario"] === "cancel") return { events: [], hang: true }
    return {
      events: [
        sseData({
          type: "response.created",
          sequence_number: 0,
          response: {
            id: "resp_1",
            object: "response",
            created_at: 1,
            model: "m",
            output: [],
            status: "in_progress",
          },
        }),
        sseData({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: textMessageItem("msg_1"),
        }),
        sseData({
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "pong",
          logprobs: [],
        }),
        sseData({
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [],
          },
        }),
        sseData(
          terminalEvent("response.completed", {
            usage: {
              input_tokens: 40,
              output_tokens: 5,
              total_tokens: 45,
              input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          }),
        ),
        sseData("[DONE]"),
      ],
    }
  })

  try {
    const adapter = createModelAdapter(MODEL, {
      apiKey: "test-key",
      baseURL: provider.baseURL("responses"),
    })
    const events = await collect(adapter.stream(agentRequest(), new AbortController().signal))

    const sent = provider.requests[0]
    assert.equal(sent?.path, "/v1/responses")
    assert.equal(sent?.headers.authorization as string | undefined, "Bearer test-key")
    assert.equal(sent?.body.instructions, "You are a coding agent.")
    assert.equal(sent?.body.store, false)
    assert.equal(sent?.body.stream, true)
    const sentInput = sent?.body.input as unknown as Array<Record<string, unknown>>
    assert.deepEqual(sentInput[0], { role: "user", content: "读取 config.ts" })
    assert.deepEqual(sentInput[2], {
      type: "function_call",
      call_id: "call_01",
      name: "read_file",
      arguments: '{"path":"/p/config.ts"}',
    })
    assert.deepEqual(sentInput[3], {
      type: "function_call_output",
      call_id: "call_01",
      output: "PORT=3000",
    })

    const last = events[events.length - 1]
    if (last?.type !== "stream_end") throw new Error("缺少 stream_end")
    assert.equal(last.completion, "finished")
    assert.equal(last.usage?.inputTokens, 30, "40 - 10 - 0")
    assert.equal(last.usage?.cacheWriteTokens, 0, "厂商明确给出 0 时保留为 0")
    assert.equal(last.usage?.outputTokens, 5)
    assert.equal(last.usage?.totalTokens, 45)

    // 取消：不重试，归一化为 CANCELLED。
    const controller = new AbortController()
    const cancelling = createResponsesAdapter(MODEL, {
      apiKey: "k",
      baseURL: provider.baseURL("responses"),
      defaultHeaders: { "x-test-scenario": "cancel" },
    })
    const errorPromise = collectError(cancelling.stream(agentRequest(), controller.signal))
    setTimeout(() => controller.abort(), 30)
    const cancelError = await errorPromise
    assert.equal((cancelError as { code?: string }).code, CANCELLED)
    assert.equal(
      provider.requests.filter((item) => item.headers["x-test-scenario"] === "cancel").length,
      1,
      "取消不得触发重试",
    )
  } finally {
    await provider.close()
  }

  // 400 → 不可重试，包装为 REQUEST_FAILED。
  {
    const provider = await startFakeProvider({ status: 400, events: [] })
    try {
      const adapter = createModelAdapter(MODEL, {
        apiKey: "k",
        baseURL: provider.baseURL("responses"),
      })
      const error = await collectError(adapter.stream(agentRequest(), new AbortController().signal))
      assert.equal((error as { code?: string }).code, MODEL_REQUEST_FAILED)
      assert.equal((error as { details?: { status?: number } }).details?.status, 400)
      assert.equal(provider.requests.length, 1)
    } finally {
      await provider.close()
    }
  }

  console.log("responses.test.ts: Responses Adapter 断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
