/**
 * 错误模块测试：取消识别与 Error Normalizer（第 25 节）。
 *
 * 不依赖测试框架；直接运行：
 *   node --experimental-strip-types runtime/error/test/normalizer.test.ts
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 25 节、第 7 节、第 14 节
 */

import assert from "node:assert/strict"

import { createAbortError, isAbortError } from "../src/abort.ts"
import {
  CANCELLED,
  MODEL_REQUEST_FAILED,
  normalizeError,
  normalizeModelError,
} from "../src/normalizer.ts"

/** 造一个形状可控的假 SDK 错误。 */
function sdkError(fields: Record<string, unknown>): Error {
  const error = new Error(fields.message as string | undefined ?? "boom")
  Object.assign(error, fields)
  return error
}

// ---------------------------------------------------------------------------
// 1. 取消识别
// ---------------------------------------------------------------------------

// Web 标准取消。
const domLike = new Error("aborted")
domLike.name = "AbortError"
assert.equal(isAbortError(domLike), true)

// 官方 SDK 的取消类名（两个 SDK 都叫 APIUserAbortError）。
assert.equal(isAbortError(sdkError({ name: "APIUserAbortError" })), true)

// undici 的两种取消码：AbortError 与 RequestAbortedError。
assert.equal(isAbortError(sdkError({ code: "UND_ERR_ABORT" })), true)
assert.equal(isAbortError(sdkError({ code: "UND_ERR_ABORTED" })), true)

// 真 AbortController 产生的错误。
{
  const controller = new AbortController()
  controller.abort()
  assert.equal(isAbortError(controller.signal.reason), true)
}

// cause 链上的取消。
assert.equal(isAbortError(sdkError({ cause: domLike })), true)

// 非取消：普通错误、业务 4xx、非对象输入。
assert.equal(isAbortError(new Error("boom")), false)
assert.equal(isAbortError(sdkError({ status: 400 })), false)
assert.equal(isAbortError(undefined), false)
assert.equal(isAbortError(null), false)
assert.equal(isAbortError("boom"), false)

// createAbortError 产出的形状必须能被自己识别。
assert.equal(isAbortError(createAbortError()), true)

// ---------------------------------------------------------------------------
// 2. 通用归一化
// ---------------------------------------------------------------------------

assert.deepEqual(normalizeError(new Error("读取失败"), "storage", "READ_FAILED"), {
  source: "storage",
  code: "READ_FAILED",
  message: "读取失败",
})

// 非 Error 抛出物也能取到消息。
assert.equal(normalizeError("纯字符串", "system", "X").message, "纯字符串")
assert.equal(normalizeError({ message: "对象消息" }, "system", "X").message, "对象消息")

// ---------------------------------------------------------------------------
// 3. 模型错误归一化（第 25 节要求保留状态码 / Provider 错误码 / requestId）
// ---------------------------------------------------------------------------

// Abort / 取消类错误 → CANCELLED，不进入 REQUEST_FAILED。
{
  const normalized = normalizeModelError(domLike)
  assert.equal(normalized.source, "model")
  assert.equal(normalized.code, CANCELLED)
}

// 重试耗尽后的 Provider 报错：三项信息都应保留。
{
  const normalized = normalizeModelError(
    sdkError({
      status: 400,
      requestID: "req_abc123",
      message: "prompt is too long: 210053 tokens > 200000 maximum",
      error: { type: "invalid_request_error" },
    }),
  )
  assert.equal(normalized.source, "model")
  assert.equal(normalized.code, MODEL_REQUEST_FAILED)
  assert.equal(normalized.message, "prompt is too long: 210053 tokens > 200000 maximum")
  assert.deepEqual(normalized.details, {
    status: 400,
    requestId: "req_abc123",
    providerCode: "invalid_request_error",
  })
}

// OpenAI 风格：错误码放在错误体的 code 上，requestId 用 requestID。
{
  const normalized = normalizeModelError(
    sdkError({ status: 429, requestID: "req_openai", error: { code: "rate_limit_exceeded" } }),
  )
  assert.equal(normalized.details?.status, 429)
  assert.equal(normalized.details?.providerCode, "rate_limit_exceeded")
  assert.equal(normalized.details?.requestId, "req_openai")
}

// requestId 的兼容命名。
assert.equal(
  normalizeModelError(sdkError({ requestId: "req_camel" })).details?.requestId,
  "req_camel",
)
assert.equal(
  normalizeModelError(sdkError({ request_id: "req_snake" })).details?.requestId,
  "req_snake",
)

// 取不到任何附加信息时 details 为 undefined，不写空对象。
{
  const normalized = normalizeModelError(new Error("network down"))
  assert.equal(normalized.code, MODEL_REQUEST_FAILED)
  assert.equal(normalized.details, undefined)
}

// 顶层 code 也可作为 Provider 错误码兜底（如 undici 的 UND_ERR_*）。
assert.equal(
  normalizeModelError(sdkError({ code: "UND_ERR_SOCKET" })).details?.providerCode,
  "UND_ERR_SOCKET",
)

// ---------------------------------------------------------------------------
// 4. 标准形状验证：结果必须是可序列化的纯对象（AppError 会被写进 Event Log）
// ---------------------------------------------------------------------------

{
  const normalized = normalizeModelError(sdkError({ status: 503, error: { type: "overloaded_error" } }))
  assert.equal(typeof normalized.source, "string")
  assert.equal(typeof normalized.code, "string")
  assert.equal(typeof normalized.message, "string")
  // 能被 JSON 往返，且不携带 Error 实例。
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized)
}

console.log("normalizer.test.ts: 错误模块断言通过")
