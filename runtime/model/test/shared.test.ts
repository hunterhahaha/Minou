/**
 * 跨协议公共层测试：请求校验、文本与参数序列化、重试边界与错误归一化。
 *
 * 不依赖测试框架；直接运行：
 *   node --experimental-strip-types runtime/model/test/shared.test.ts
 *
 * 这里的断言对三个 Adapter 同时成立，因此放在一处验证（第 6、7、25 节）。
 */

import assert from "node:assert/strict"

import { CANCELLED, MODEL_REQUEST_FAILED } from "../../error/src/normalizer.ts"
import {
  INVALID_MODEL_REQUEST,
  assertRequestMatchesModel,
  isAppError,
  joinTextBlocks,
  parseToolCallArguments,
  resolveToolCallInput,
  runModelStream,
  serializeToolCallArguments,
  splitSystemMessage,
} from "../src/shared.ts"
import type {
  ModelConfig,
  ModelStreamEvent,
  UnifiedModelRequest,
  Usage,
} from "../src/types.ts"

import { collect, collectError } from "./helpers.ts"

const MODEL: ModelConfig = {
  modelId: "model-record-1",
  name: "test-model",
  providerId: "test-provider",
  protocol: "anthropic_messages",
  contextWindow: 256000,
  maxOutputTokens: 32000,
}

function requestWith(
  messages: UnifiedModelRequest["context"]["messages"],
): UnifiedModelRequest {
  return {
    context: { messages },
    tools: [],
    model: { providerId: "test-provider", protocol: "anthropic_messages", modelId: "model-record-1", name: "test-model" },
  }
}

function eventWith(fields: { type: "block_start" | "block_delta" | "text" }): ModelStreamEvent {
  if (fields.type === "block_start") return { type: "block_start", index: 0, blockType: "text" }
  if (fields.type === "block_delta") {
    return { type: "block_delta", index: 0, delta: { type: "text", text: "hi" } }
  }
  return { type: "stream_end", completion: "finished" }
}

function errorWith(fields: Record<string, unknown>): Error {
  const error = new Error("boom")
  Object.assign(error, fields)
  return error
}

/**
 * 捕获同步调用抛出的值并返回它。
 *
 * 不用 `assert.throws`：Adapter 抛出的统一错误是普通对象（`AppError`）而不是 `Error`，
 * 断言里的 message 匹配拿不到它的 message 字段。
 */
function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error("预期抛出错误，但正常完成")
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. 上下文拆分与校验
  // -------------------------------------------------------------------------

  // 正常拆分：messages[0] 是 system，其余进入会话上下文。
  {
    const split = splitSystemMessage(
      requestWith([
        { role: "system", content: "you are a coding agent" },
        { role: "user", content: "hi" },
      ]),
    )
    assert.equal(split.system, "you are a coding agent")
    assert.equal(split.rest.length, 1)
    assert.equal(split.rest[0]?.role, "user")
  }

  // 首项不是 System Message → 请求不合法（runtime 侧错误）。
  {
    const error = caught(() => splitSystemMessage(requestWith([{ role: "user", content: "hi" }])))
    assert.ok(isAppError(error), "应抛出 AppError")
    assert.equal(error.source, "runtime", "统一格式违反属于 runtime 错误，不是 model 错误")
    assert.equal(error.code, INVALID_MODEL_REQUEST)
  }

  // 空上下文同样不合法。
  {
    const error = caught(() => splitSystemMessage(requestWith([])))
    assert.ok(isAppError(error) && /System Message/.test(error.message))
  }

  // 第二个 System Message → 不合法（三个协议都没有中途插入系统指令的位置）。
  {
    const error = caught(() =>
      splitSystemMessage(
        requestWith([
          { role: "system", content: "a" },
          { role: "user", content: "hi" },
          { role: "system", content: "b" },
        ]),
      ),
    )
    assert.ok(isAppError(error) && /只允许一个 System Message/.test(error.message))
  }

  // 请求模型与 Adapter 绑定的模型不一致 → 不合法。
  {
    const mismatch = requestWith([{ role: "system", content: "s" }])
    mismatch.model = { providerId: "other", protocol: "responses", modelId: "other-model", name: "other-model" }
    const error = caught(() => assertRequestMatchesModel(mismatch, MODEL))
    assert.ok(isAppError(error))
    assert.equal(error.code, INVALID_MODEL_REQUEST)
    assert.ok(error.details !== undefined, "不一致时要保留期望与实际两份模型引用")
  }

  // 模型身份相同但模型名称不同也不能绑定到同一 Adapter。
  {
    const mismatch = requestWith([{ role: "system", content: "s" }])
    mismatch.model.name = "renamed-model"
    const error = caught(() => assertRequestMatchesModel(mismatch, MODEL))
    assert.ok(isAppError(error) && error.code === INVALID_MODEL_REQUEST)
  }

  // 一致时不抛错。
  assertRequestMatchesModel(requestWith([{ role: "system", content: "s" }]), MODEL)

  // -------------------------------------------------------------------------
  // 2. 文本拼接与工具调用参数
  // -------------------------------------------------------------------------

  // 多块文本按顺序直接拼接，不添加分隔符。
  {
    const text = joinTextBlocks([
      { type: "text", text: "PORT=" },
      { type: "text", text: "3000" },
    ])
    assert.equal(text, "PORT=3000")
    assert.equal(joinTextBlocks([]), "")
  }

  // 序列化：对象 → JSON 字符串；已是字符串则原样传出。
  assert.equal(serializeToolCallArguments({ path: "/a.ts" }), '{"path":"/a.ts"}')
  assert.equal(serializeToolCallArguments('{"path":"/a.ts"}'), '{"path":"/a.ts"}')
  assert.equal(serializeToolCallArguments(undefined), "{}")
  assert.equal(serializeToolCallArguments(null), "{}")

  // 循环引用无法序列化 → 退化为空参数对象，不抛错。
  {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.equal(serializeToolCallArguments(circular), "{}")
  }

  // 解析：合法 JSON → 对象；空串 → 空对象；被截断 → 原样保留字符串。
  assert.deepEqual(parseToolCallArguments('{"path":"/a.ts"}'), { path: "/a.ts" })
  assert.deepEqual(parseToolCallArguments(""), {})
  assert.deepEqual(parseToolCallArguments("   "), {})
  assert.equal(parseToolCallArguments('{"path":"/a.t'), '{"path":"/a.t', "截断的参数不丢内容")

  // Anthropic 的 input 必须是对象：字符串能解析就用解析结果，否则空对象。
  assert.deepEqual(resolveToolCallInput('{"path":"/a.ts"}'), { path: "/a.ts" })
  assert.deepEqual(resolveToolCallInput('{"path":"/a.t'), {})
  assert.deepEqual(resolveToolCallInput({ path: "/a.ts" }), { path: "/a.ts" })
  assert.deepEqual(resolveToolCallInput(undefined), {})

  // -------------------------------------------------------------------------
  // 3. 流式重试边界（第 7 节）
  // -------------------------------------------------------------------------

  // 3.1 首个 block_delta 之前失败 → 允许重试，且消费方看不到失败尝试的痕迹。
  {
    let calls = 0
    const attempt = (): AsyncIterable<ModelStreamEvent> => {
      const current = calls
      calls += 1
      return (async function* () {
        yield eventWith({ type: "block_start" })
        if (current === 0) throw errorWith({ status: 429 })
        yield eventWith({ type: "block_delta" })
        yield eventWith({ type: "text" })
      })()
    }

    const events = await collect(runModelStream(attempt, new AbortController().signal))
    assert.equal(calls, 2, "仅 block_start 不算有效输出，应重试")
    assert.deepEqual(
      events.map((event) => event.type),
      ["block_start", "block_delta", "stream_end"],
      "上次失败尝试的 block_start 不得泄漏给消费方（重试对消费方透明）",
    )
  }

  // 3.2 已产出 block_delta 后失败 → 不重试，直接归一化抛错。
  {
    let calls = 0
    const attempt = (): AsyncIterable<ModelStreamEvent> => {
      calls += 1
      return (async function* () {
        yield eventWith({ type: "block_start" })
        yield eventWith({ type: "block_delta" })
        throw errorWith({ status: 500 })
      })()
    }

    const error = await collectError(runModelStream(attempt, new AbortController().signal))
    assert.equal(calls, 1, "已产生有效输出后不得重试")
    assert.ok(isAppError(error))
    assert.equal(error.source, "model")
    assert.equal(error.code, MODEL_REQUEST_FAILED)
  }

  // 3.3 不可重试错误（400）→ 只请求一次，包装为 model 错误并保留厂商信息。
  {
    let calls = 0
    const attempt = (): AsyncIterable<ModelStreamEvent> => {
      calls += 1
      return (async function* () {
        throw errorWith({ status: 400, error: { type: "invalid_request_error" }, requestID: "req_1" })
        // eslint-disable-next-line no-unreachable
        yield eventWith({ type: "text" })
      })()
    }

    const error = await collectError(runModelStream(attempt, new AbortController().signal))
    assert.equal(calls, 1)
    assert.ok(isAppError(error))
    assert.equal(error.code, MODEL_REQUEST_FAILED)
    assert.equal(error.details?.status, 400, "状态码要保留（第 25 节）")
    assert.equal(error.details?.providerCode, "invalid_request_error")
    assert.equal(error.details?.requestId, "req_1")
  }

  // 3.4 取消 → 不重试，归一化为 CANCELLED。
  {
    let calls = 0
    const controller = new AbortController()
    const attempt = (): AsyncIterable<ModelStreamEvent> => {
      calls += 1
      return (async function* () {
        controller.abort()
        const abortError = new Error("aborted")
        abortError.name = "AbortError"
        throw abortError
        // eslint-disable-next-line no-unreachable
        yield eventWith({ type: "text" })
      })()
    }

    const error = await collectError(runModelStream(attempt, controller.signal))
    assert.equal(calls, 1, "取消后不得重试（第 7、14 节）")
    assert.ok(isAppError(error))
    assert.equal(error.source, "model")
    assert.equal(error.code, CANCELLED)
  }

  // 3.5 抛出的已经是统一错误 → 原样传出，不被再次包装。
  {
    const appError = {
      source: "runtime" as const,
      code: INVALID_MODEL_REQUEST,
      message: "请求不合法",
    }
    const attempt = (): AsyncIterable<ModelStreamEvent> => {
      return (async function* () {
        throw appError
        // eslint-disable-next-line no-unreachable
        yield eventWith({ type: "text" })
      })()
    }

    const error = await collectError(runModelStream(attempt, new AbortController().signal))
    assert.equal(error, appError, "已归一化的错误不应被改写为 REQUEST_FAILED")
  }

  // 3.6 重试耗尽 → 抛出最后一次的归一化错误。
  {
    let calls = 0
    const attempt = (): AsyncIterable<ModelStreamEvent> => {
      calls += 1
      return (async function* () {
        throw errorWith({ status: 503 })
        // eslint-disable-next-line no-unreachable
        yield eventWith({ type: "text" })
      })()
    }

    const error = await collectError(runModelStream(attempt, new AbortController().signal))
    assert.equal(calls, 3, "默认最多尝试 3 次（首次 + 2 次重试）")
    assert.ok(isAppError(error))
    assert.equal(error.details?.status, 503)
  }

  // 3.7 Usage 类型在流末尾传递（stream_end.usage）供上层记账。
  {
    const usage: Usage = { inputTokens: 10, outputTokens: 2 }
    const attempt = (): AsyncIterable<ModelStreamEvent> => {
      return (async function* () {
        yield { type: "stream_end", completion: "finished", usage, finishReason: "stop" }
      })()
    }

    const events = await collect(runModelStream(attempt, new AbortController().signal))
    const last = events[events.length - 1]
    assert.equal(last?.type, "stream_end")
    assert.deepEqual(last?.type === "stream_end" ? last.usage : undefined, usage)
  }

  console.log("shared.test.ts: 公共层断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
