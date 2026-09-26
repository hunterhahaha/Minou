/**
 * Chat Completions Adapter 测试（第 6、7、8.4、8.5、11、16.2、25 节）。
 *
 * 不依赖测试框架；直接运行：
 *   node --experimental-strip-types runtime/model/test/chat-completions.test.ts
 *
 * 四类覆盖（对齐 TODOList 阶段 4 的验证要求）：
 *   1. 请求转换：统一上下文 → system + messages（tool_calls 与 role:tool 配对）；
 *   2. 正常流：thinking（厂商扩展字段）/ text 增量 → 统一事件，finishReason 与完成状态；
 *   3. 工具调用流：按调用序号拼装出完整 toolCallId / name / arguments；
 *   4. 取消：请求挂起时 abort → CANCELLED，且不重试；另附 Usage 转换与错误归一化。
 */

import assert from "node:assert/strict"

import type OpenAI from "openai"

import { createModelAdapter } from "../src/adapter.ts"
import {
  buildChatCompletionsRequest,
  createChatCompletionsAdapter,
  mapChatCompletionsStream as mapChatCompletionsStreamOf,
  toChatCompletionsMessages,
} from "../src/chat-completions.ts"
import { CANCELLED, MODEL_REQUEST_FAILED } from "../../error/src/normalizer.ts"
import type { ModelConfig, ModelStreamEvent, UnifiedModelRequest } from "../src/types.ts"

import { collect, collectError, sseData, startFakeProvider, streamOf } from "./helpers.ts"

type ChatCompletionChunk = OpenAI.ChatCompletionChunk

const MODEL: ModelConfig = {
  modelId: "model-record-2",
  name: "gpt-test",
  providerId: "openai",
  protocol: "chat_completions",
  contextWindow: 256000,
}

/** 离线转换入口：协议 chunk 数组 → 统一事件流。 */
function mapChatCompletionsStream(
  chunks: ChatCompletionChunk[],
): AsyncGenerator<ModelStreamEvent> {
  return mapChatCompletionsStreamOf(streamOf(chunks))
}

/** 构造一个 chunk；只填被测字段。 */
function chunk(choice: {
  delta?: Record<string, unknown>
  finish_reason?: string | null
}): ChatCompletionChunk {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices:
      choice.delta === undefined && choice.finish_reason === undefined
        ? []
        : [{ index: 0, delta: choice.delta ?? {}, finish_reason: choice.finish_reason ?? null }],
  } as unknown as ChatCompletionChunk
}

/** 末尾的 Usage chunk：choices 为空。 */
function usageChunk(usage: Record<string, unknown>): ChatCompletionChunk {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [],
    usage,
  } as unknown as ChatCompletionChunk
}

/** 一条含工具调用与工具结果的统一上下文（对照协议示例文档第 2 节）。 */
function agentRequest(): UnifiedModelRequest {
  return {
    model: { providerId: "openai", protocol: "chat_completions", modelId: "model-record-2", name: "gpt-test" },
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

function normalChunks(): ChatCompletionChunk[] {
  return [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { content: "端口是 " } }),
    chunk({ delta: { content: "3000。" } }),
    chunk({ delta: {}, finish_reason: "stop" }),
    usageChunk({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 64 },
    }),
  ]
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
      return `end:${item.index}:${item.block.text}`
    }
    return `stream_end:${item.completion}`
  })
}

/** 文本块的最终内容。 */
function endedText(events: ModelStreamEvent[]): string {
  const ended = events.find((item) => item.type === "block_end")
  return ended?.type === "block_end" && ended.block.type === "text" ? ended.block.text : ""
}

/** 工具调用块的最终内容。 */
function endedToolCall(events: ModelStreamEvent[]): {
  toolCallId: string
  name: string
  arguments: unknown
} | undefined {
  const ended = events.find((item) => item.type === "block_end" && item.block.type === "tool_call")
  return ended?.type === "block_end" && ended.block.type === "tool_call" ? ended.block : undefined
}

/** stream_end 的完成状态。 */
function completionOf(events: ModelStreamEvent[]): string | undefined {
  const last = events[events.length - 1]
  return last?.type === "stream_end" ? last.completion : undefined
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. 请求转换（第 11.1、11.3、16.2 节）
  // -------------------------------------------------------------------------

  {
    const params = buildChatCompletionsRequest(agentRequest())

    assert.equal(params.model, "gpt-test")
    assert.equal(params.stream, true)
    // 不发送 max_tokens：不同 Provider 的字段名不兼容（见 chat-completions.ts 文件头）。
    assert.equal((params as unknown as Record<string, unknown>).max_tokens, undefined)
    // 必须带 include_usage，否则流里没有权威 Usage。
    assert.deepEqual(params.stream_options, { include_usage: true })

    assert.equal(params.messages.length, 6, "系统消息 + 5 条会话消息")
    assert.deepEqual(params.messages[0], { role: "system", content: "You are a coding agent." })
    assert.deepEqual(params.messages[1], { role: "user", content: "读取 config.ts" })

    // 有 tools 时 content 是文本，工具调用在 tool_calls 里，arguments 是 JSON 字符串。
    assert.deepEqual(params.messages[2], {
      role: "assistant",
      content: "我先看一下。",
      tool_calls: [
        {
          id: "call_01",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"/p/config.ts"}' },
        },
      ],
    })

    // 工具结果是独立的 role:tool 消息。
    assert.deepEqual(params.messages[3], {
      role: "tool",
      tool_call_id: "call_01",
      content: "PORT=3000",
    })

    assert.deepEqual(params.messages[5], { role: "user", content: "改成 8080" })

    // 工具定义映射到 tools[].function.parameters。
    assert.deepEqual(params.tools, [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ])
  }

  // 只有工具调用、没有文本时 content 为 null。
  {
    const messages = toChatCompletionsMessages([
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "c1", name: "t", arguments: {} }],
      },
    ])
    assert.deepEqual(messages, [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "t", arguments: "{}" } },
        ],
      },
    ])
  }

  // 多块文本按顺序拼接、不添加分隔符；thinking 不回放。
  {
    const messages = toChatCompletionsMessages([
      { role: "user", content: [{ type: "text", text: "PORT=" }, { type: "text", text: "3000" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "内部推理" },
          { type: "text", text: "回答" },
        ],
      },
    ])
    assert.deepEqual(messages, [
      { role: "user", content: "PORT=3000" },
      { role: "assistant", content: "回答" },
    ])
  }

  // 空消息不发送（该协议不接受空 content）。
  assert.deepEqual(toChatCompletionsMessages([{ role: "user", content: "" }]), [])
  assert.deepEqual(toChatCompletionsMessages([{ role: "assistant", content: [] }]), [])

  // 不带参数的工具调用序列化为 {}。
  {
    const messages = toChatCompletionsMessages([
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "c1", name: "t", arguments: undefined }],
      },
    ])
    const assistant = messages[0] as {
      tool_calls: Array<{ function: { arguments: string } }>
    }
    assert.equal(assistant.tool_calls[0]?.function.arguments, "{}")
  }

  // -------------------------------------------------------------------------
  // 2. 正常流（第 8.4、8.5 节）
  // -------------------------------------------------------------------------

  {
    const events = await collect(mapChatCompletionsStream(normalChunks()))
    assert.deepEqual(summarize(events), [
      "start:0:text",
      "delta:0:端口是 ",
      "delta:0:3000。",
      "end:0:端口是 3000。",
      "stream_end:finished",
    ])
  }

  // Usage：prompt_tokens 是完整输入，必须减去缓存读取；reasoning 是 output 的子集。
  {
    const events = await collect(mapChatCompletionsStream(normalChunks()))
    const last = events[events.length - 1]
    if (last?.type !== "stream_end") throw new Error("缺少 stream_end")

    assert.equal(last.finishReason, "stop")
    assert.equal(last.usage?.inputTokens, 200, "1000 - 800")
    assert.equal(last.usage?.outputTokens, 200)
    assert.equal(last.usage?.cacheReadTokens, 800)
    assert.equal(last.usage?.cacheWriteTokens, undefined, "厂商未提供则不推算")
    assert.equal(last.usage?.reasoningTokens, 64)
    assert.equal(last.usage?.totalTokens, 1200)
  }

  // 厂商扩展字段 reasoning_content → thinking 块，且与文本块分属不同 index。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({ delta: { reasoning_content: "先想" } }),
        chunk({ delta: { reasoning_content: "一下" } }),
        chunk({ delta: { content: "答案" } }),
        chunk({ delta: {}, finish_reason: "stop" }),
      ]),
    )

    assert.deepEqual(summarize(events), [
      "start:0:thinking",
      "delta:0:先想",
      "delta:0:一下",
      // 文本通道开始 → thinking 块先收尾，块顺序与内容顺序一致。
      "end:0:先想一下",
      "start:1:text",
      "delta:1:答案",
      "end:1:答案",
      "stream_end:finished",
    ])
  }

  // 兼容厂商把思考放在 reasoning 字段。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({ delta: { reasoning: "思考" } }),
        chunk({ delta: {}, finish_reason: "stop" }),
      ]),
    )
    assert.equal(
      events.filter((item) => item.type === "block_start" && item.blockType === "thinking").length,
      1,
    )
  }

  // 非字符串的 reasoning 字段（兼容厂商可能给数组）被忽略，不产生块。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({ delta: { reasoning: [{ type: "text", text: "x" }] } }),
        chunk({ delta: { content: "ok" } }),
        chunk({ delta: {}, finish_reason: "stop" }),
      ]),
    )
    assert.equal(
      events.filter((item) => item.type === "block_start" && item.blockType === "thinking").length,
      0,
    )
    assert.equal(
      events.filter((item) => item.type === "block_start" && item.blockType === "text").length,
      1,
    )
  }

  // refusal 作为文本发出，不丢内容。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({ delta: { refusal: "我不能帮助这个请求。" } }),
        chunk({ delta: {}, finish_reason: "stop" }),
      ]),
    )
    assert.equal(endedText(events), "我不能帮助这个请求。")
  }

  // finish_reason 与完成状态的对应（第 8.5 节）。
  const finishReasons: Array<[string | undefined, string]> = [
    ["stop", "finished"],
    ["length", "incomplete"],
    ["content_filter", "incomplete"],
    [undefined, "unknown"],
  ]
  for (const [finishReason, expected] of finishReasons) {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({ delta: { content: "x" } }),
        chunk({ delta: {}, finish_reason: finishReason ?? null }),
      ]),
    )
    assert.equal(completionOf(events), expected, `finish_reason=${finishReason}`)
  }

  // 被 length 截断的文本仍要收尾。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({ delta: { content: "partial" } }),
        chunk({ delta: {}, finish_reason: "length" }),
      ]),
    )
    assert.equal(events.filter((item) => item.type === "block_end").length, 1)
  }

  // 空流（一个 chunk 都没有）→ 抛中断错误，不产出 stream_end。
  {
    const error = await collectError(mapChatCompletionsStream([]))
    assert.match(String((error as Error).message), /中断/)
  }

  // 没有任何 finish_reason 就结束 → unknown，不凭文本推断 finished。
  {
    const events = await collect(mapChatCompletionsStream([chunk({ delta: { content: "x" } })]))
    assert.equal(completionOf(events), "unknown")
  }

  // 没有 Usage chunk → stream_end 不带 usage（未报告，不填 0）。
  {
    const events = await collect(
      mapChatCompletionsStream([chunk({ delta: {}, finish_reason: "stop" })]),
    )
    const last = events[events.length - 1]
    assert.equal(last?.type === "stream_end" ? last.usage : "missing", undefined)
  }

  // -------------------------------------------------------------------------
  // 3. 工具调用流：按调用序号拼装（第 8.4 节）
  // -------------------------------------------------------------------------

  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_9",
                type: "function",
                function: { name: "read_file", arguments: "" },
              },
            ],
          },
        }),
        chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }),
        chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: '"/a.ts"}' } }] } }),
        chunk({ delta: {}, finish_reason: "tool_calls" }),
      ]),
    )

    assert.deepEqual(endedToolCall(events), {
      type: "tool_call",
      toolCallId: "call_9",
      name: "read_file",
      arguments: { path: "/a.ts" },
    })
    assert.equal(completionOf(events), "tool_calls")
  }

  // 工具名分片到达时按分片累积。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "read_" } }] } }),
        chunk({ delta: { tool_calls: [{ index: 0, function: { name: "file" } }] } }),
        chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }),
        chunk({ delta: {}, finish_reason: "tool_calls" }),
      ]),
    )
    assert.equal(endedToolCall(events)?.name, "read_file")
  }

  // 并行工具调用：同一 chunk 里两个 index，各自独立成块。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({
          delta: {
            tool_calls: [
              { index: 0, id: "c0", function: { name: "a", arguments: "{}" } },
              { index: 1, id: "c1", function: { name: "b", arguments: "{}" } },
            ],
          },
        }),
        chunk({ delta: {}, finish_reason: "tool_calls" }),
      ]),
    )

    assert.deepEqual(
      events.filter((item) => item.type === "block_start").map((item) => item.index),
      [0, 1],
    )
    const ids = events
      .filter((item) => item.type === "block_end")
      .map((item) =>
        item.type === "block_end" && item.block.type === "tool_call" ? item.block.toolCallId : "",
      )
    assert.deepEqual(ids, ["c0", "c1"], "两个调用各自独立成块")
  }

  // 被 length 截断的工具调用不产出 block_end（参数可能只传了一半，第 8.5 节）。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({
          delta: {
            tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: '{"path":' } }],
          },
        }),
        chunk({ delta: {}, finish_reason: "length" }),
      ]),
    )
    assert.equal(
      events.filter((item) => item.type === "block_end").length,
      0,
      "截断的 tool_call 不得当成完整调用",
    )
    assert.equal(completionOf(events), "incomplete")
  }

  // 带 tool_calls 但没有完整调用（无 id）→ unknown（第 8.5 节的要求）。
  {
    const events = await collect(
      mapChatCompletionsStream([chunk({ delta: {}, finish_reason: "tool_calls" })]),
    )
    assert.equal(completionOf(events), "unknown")
  }

  // 已废弃的 function_call 字段不转换为 tool_call。
  {
    const events = await collect(
      mapChatCompletionsStream([
        chunk({ delta: { function_call: { name: "f", arguments: "{}" } } }),
        chunk({ delta: {}, finish_reason: "function_call" }),
      ]),
    )
    assert.equal(events.filter((item) => item.type === "block_start").length, 0)
    assert.equal(completionOf(events), "unknown")
  }

  // -------------------------------------------------------------------------
  // 4. 端到端：真实 SDK + HTTP + SSE
  // -------------------------------------------------------------------------

  const provider = await startFakeProvider((request) => {
    if (request.headers["x-test-scenario"] === "cancel") return { events: [], hang: true }
    return {
      events: [
        sseData(chunk({ delta: { content: "pong" } })),
        sseData(chunk({ delta: {}, finish_reason: "stop" })),
        sseData(
          usageChunk({
            prompt_tokens: 30,
            completion_tokens: 7,
            total_tokens: 37,
            prompt_tokens_details: { cached_tokens: 10 },
          }),
        ),
        sseData("[DONE]"),
      ],
    }
  })

  try {
    const adapter = createModelAdapter(MODEL, {
      apiKey: "test-key",
      baseURL: provider.baseURL("chat_completions"),
    })
    const events = await collect(adapter.stream(agentRequest(), new AbortController().signal))

    const sent = provider.requests[0]
    assert.equal(sent?.path, "/v1/chat/completions")
    assert.equal(sent?.headers.authorization as string | undefined, "Bearer test-key")
    assert.deepEqual(sent?.body.stream_options, { include_usage: true })
    const sentMessages = sent?.body.messages as Array<Record<string, unknown>>
    assert.deepEqual(sentMessages[0], { role: "system", content: "You are a coding agent." })
    assert.deepEqual(sentMessages[3], {
      role: "tool",
      tool_call_id: "call_01",
      content: "PORT=3000",
    })
    // tools[].function.parameters 是协议侧字段名。
    const sentTools = sent?.body.tools as Array<{ function: { parameters?: unknown } }>
    assert.ok(sentTools[0]?.function.parameters !== undefined)

    const last = events[events.length - 1]
    if (last?.type !== "stream_end") throw new Error("缺少 stream_end")
    assert.equal(last.completion, "finished")
    assert.equal(last.usage?.inputTokens, 20, "30 - 10")
    assert.equal(last.usage?.outputTokens, 7)
    assert.equal(last.usage?.cacheReadTokens, 10)
    assert.equal(last.usage?.totalTokens, 37)

    // 取消：不重试，归一化为 CANCELLED。
    const controller = new AbortController()
    const cancelling = createChatCompletionsAdapter(MODEL, {
      apiKey: "k",
      baseURL: provider.baseURL("chat_completions"),
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

  // 已产生内容增量后断流 → 不重试（第 7 节的重试边界另一半），错误归一化为 REQUEST_FAILED。
  {
    const provider = await startFakeProvider(() => ({
      events: [sseData(chunk({ delta: { content: "半截回答" } }))],
      // 留出时间让上面的内容增量真正到达客户端，否则测到的是「尚无有效输出」。
      destroy: true,
      destroyAfterMs: 60,
    }))

    try {
      const adapter = createModelAdapter(MODEL, {
        apiKey: "k",
        baseURL: provider.baseURL("chat_completions"),
      })
      const error = await collectError(adapter.stream(agentRequest(), new AbortController().signal))

      assert.equal(
        provider.requests.length,
        1,
        "已产生有效输出后不得重试（否则会重复输出）",
      )
      assert.equal((error as { source?: string }).source, "model")
      assert.equal((error as { code?: string }).code, MODEL_REQUEST_FAILED)
    } finally {
      await provider.close()
    }
  }

  // 400 → 不可重试，包装为 REQUEST_FAILED。
  {
    const provider = await startFakeProvider({ status: 400, events: [] })
    try {
      const adapter = createModelAdapter(MODEL, {
        apiKey: "k",
        baseURL: provider.baseURL("chat_completions"),
      })
      const error = await collectError(adapter.stream(agentRequest(), new AbortController().signal))
      assert.equal((error as { code?: string }).code, MODEL_REQUEST_FAILED)
      assert.equal((error as { details?: { status?: number } }).details?.status, 400)
      assert.equal(provider.requests.length, 1)
    } finally {
      await provider.close()
    }
  }

  console.log("chat-completions.test.ts: Chat Completions Adapter 断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
