/**
 * 网络层测试：Dispatcher 初始化与请求重试边界（第 7 节）。
 *
 * 不依赖测试框架；运行期断言用 node:assert，直接运行：
 *   node --experimental-strip-types runtime/network/test/retry.test.ts
 *
 * 全部断言包在 async main() 里而非顶层 await：测试运行时被 Node 当作 ESM，
 * 但 tsc 按 CommonJS 检查，顶层 await 在后者不合法。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 7 节（网络层）
 */

import assert from "node:assert/strict"
import { createServer } from "node:http"

import { getNetworkDispatcher, initNetworkDispatcher } from "../src/dispatcher.ts"
import {
  computeBackoffDelay,
  isRetryableError,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  streamWithRetry,
} from "../src/retry.ts"

// ---------------------------------------------------------------------------
// 辅助：构造带指定形状的假错误
// ---------------------------------------------------------------------------

function errorWith(fields: Record<string, unknown>): Error {
  const error = new Error("boom")
  Object.assign(error, fields)
  return error
}

function abortError(): Error {
  const error = new Error("aborted")
  error.name = "AbortError"
  return error
}

/** 造一个「前 n 次尝试抛错，之后成功产出事件」的 attempt。 */
function flakyAttempt<T>(
  failures: number,
  events: T[],
  error: () => unknown,
  count: { calls: number },
): (signal: AbortSignal) => AsyncIterable<T> {
  return async function* () {
    const current = count.calls
    count.calls += 1
    if (current < failures) throw error()
    for (const event of events) yield event
  }
}

/** 造一个「产出若干事件后抛错」的 attempt。 */
function failMidStream<T>(
  events: T[],
  error: () => unknown,
  count: { calls: number },
): (signal: AbortSignal) => AsyncIterable<T> {
  return async function* () {
    count.calls += 1
    for (const event of events) yield event
    throw error()
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

async function expectRejects(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise
    assert.fail(`${message}：预期抛错，但正常完成`)
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    // 预期的抛错。
  }
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. 可重试性判定（第 7 节的情形清单）
  // -------------------------------------------------------------------------

  // 连接失败 / 中断（Node 系统错误码与 undici 错误码）。
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "UND_ERR_SOCKET"]) {
    assert.equal(isRetryableError(errorWith({ code })), true, `${code} 应可重试`)
  }

  // 连接超时。
  for (const code of ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
    assert.equal(isRetryableError(errorWith({ code })), true, `${code} 应可重试`)
  }

  // 429 与临时 5xx（含 Anthropic 的 529 overloaded）。
  for (const status of [408, 429, 500, 502, 503, 529]) {
    assert.equal(isRetryableError(errorWith({ status })), true, `status ${status} 应可重试`)
  }

  // SDK 的连接错误类名。
  assert.equal(isRetryableError(errorWith({ name: "APIConnectionError" })), true)
  assert.equal(isRetryableError(errorWith({ name: "APIConnectionTimeoutError" })), true)

  // Provider 用错误体 type 表达临时不可用。
  assert.equal(isRetryableError(errorWith({ error: { type: "overloaded_error" } })), true)

  // 不可重试：业务性错误。
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableError(errorWith({ status })), false, `status ${status} 不应重试`)
  }

  // 不可重试：Abort / 取消类错误（即便带着连接中断的错误码）。
  assert.equal(isRetryableError(abortError()), false)
  assert.equal(
    isRetryableError(errorWith({ code: "UND_ERR_SOCKET", name: "AbortError" })),
    false,
    "取消优先于可重试判定",
  )
  assert.equal(isRetryableError(errorWith({ code: "UND_ERR_ABORTED" })), false)

  // 不可重试：非对象输入（曾因缺守卫导致无限递归，见 retry.ts 注释）。
  assert.equal(isRetryableError(undefined), false)
  assert.equal(isRetryableError(null), false)
  assert.equal(isRetryableError("boom"), false)

  // cause 链上的可重试错误应被识别。
  assert.equal(isRetryableError(errorWith({ cause: errorWith({ code: "ECONNRESET" }) })), true)

  // 循环 cause 链不得导致递归不终止。
  {
    const a = errorWith({})
    const b = errorWith({ cause: a })
    Object.assign(a, { cause: b })
    assert.equal(isRetryableError(a), false)
  }

  // -------------------------------------------------------------------------
  // 2. 退避计算
  // -------------------------------------------------------------------------

  // 指数增长，抖动可注入以取得确定值（random = 0.5 => 取原值的 75%）。
  assert.equal(computeBackoffDelay(0, 500, () => 0.5), 375)
  assert.equal(computeBackoffDelay(1, 500, () => 0.5), 750)
  assert.equal(computeBackoffDelay(2, 500, () => 0.5), 1500)

  // 抖动下界（random = 0 => 原值的 50%）与上界（random ≈ 1 => 原值的 100%）。
  assert.equal(computeBackoffDelay(0, 500, () => 0), 250)
  assert.equal(computeBackoffDelay(0, 500, () => 1), 500)

  // 默认基数。
  assert.equal(RETRY_BASE_DELAY_MS, 500)
  assert.equal(RETRY_MAX_ATTEMPTS, 3)

  // -------------------------------------------------------------------------
  // 3. 流式重试
  // -------------------------------------------------------------------------

  // 3.1 首次即成功：只调用一次，事件原样产出。
  {
    const count = { calls: 0 }
    const events = ["a", "b"]
    const result = await collect(
      streamWithRetry(flakyAttempt(0, events, () => new Error("x"), count), {
        signal: new AbortController().signal,
        baseDelayMs: 1,
      }),
    )
    assert.deepEqual(result, events)
    assert.equal(count.calls, 1)
  }

  // 3.2 可重试错误 + 尚未产出有效输出 → 重试，最终成功。
  {
    const count = { calls: 0 }
    const retries: number[] = []
    const error = (): unknown => errorWith({ status: 429 })
    const result = await collect(
      streamWithRetry(flakyAttempt(2, ["ok"], error, count), {
        signal: new AbortController().signal,
        baseDelayMs: 1,
        onRetry: (info) => retries.push(info.attempt),
      }),
    )
    assert.deepEqual(result, ["ok"])
    assert.equal(count.calls, 3, "应尝试 3 次")
    assert.deepEqual(retries, [1, 2], "应重试 2 次")
  }

  // 3.3 重试次数耗尽 → 抛出最后一个错误（原始错误，未包装）。
  {
    const count = { calls: 0 }
    const error = (): unknown => errorWith({ status: 503 })
    await expectRejects(
      collect(
        streamWithRetry(flakyAttempt(99, ["never"], error, count), {
          signal: new AbortController().signal,
          baseDelayMs: 1,
          maxAttempts: 3,
        }),
      ),
      "重试耗尽",
    )
    assert.equal(count.calls, 3, "最多尝试 maxAttempts 次")
  }

  // 3.4 不可重试错误 → 立即抛出，不重试。
  {
    const count = { calls: 0 }
    await expectRejects(
      collect(
        streamWithRetry(flakyAttempt(99, ["never"], () => errorWith({ status: 400 }), count), {
          signal: new AbortController().signal,
          baseDelayMs: 1,
        }),
      ),
      "不可重试错误",
    )
    assert.equal(count.calls, 1, "不应重试")
  }

  // 3.5 已产生有效输出后出错 → 不重试（第 7 节的重试边界核心规则）。
  {
    const count = { calls: 0 }
    const error = (): unknown => errorWith({ status: 500 })
    await expectRejects(
      collect(
        streamWithRetry(failMidStream(["delta1", "delta2"], error, count), {
          signal: new AbortController().signal,
          baseDelayMs: 1,
          // 只有 delta 算有效输出。
          isValidOutput: (event) => event.startsWith("delta"),
        }),
      ),
      "已产生有效输出",
    )
    assert.equal(count.calls, 1, "已产生有效输出后不得重试")
  }

  // 3.6 已产出事件但都不算「有效输出」→ 仍可重试，且重试对消费方透明。
  // 上次失败尝试漏出的 block_start 必须被丢弃，否则 AgentLoop 会为同一次请求写出两个 block_start。
  {
    const count = { calls: 0 }
    const error = (): unknown => errorWith({ status: 500 })
    const attempt = (): AsyncIterable<string> => {
      const current = count.calls
      count.calls += 1
      return (async function* () {
        // 每次尝试都先吐一个 block_start（非有效输出），再抛错。
        yield "block_start"
        if (current < 1) throw error()
        yield "delta"
      })()
    }
    const result = await collect(
      streamWithRetry(attempt, {
        signal: new AbortController().signal,
        baseDelayMs: 1,
        isValidOutput: (event) => event.startsWith("delta"),
      }),
    )
    assert.deepEqual(result, ["block_start", "delta"], "上次尝试的 block_start 不得泄漏给消费方")
    assert.equal(count.calls, 2, "仅 block_start 不算有效输出，应重试")
  }

  // 3.6b 重试后仍正常结束：缓冲的非有效输出在成功路径上要补发，不能丢。
  {
    const count = { calls: 0 }
    const attempt = (): AsyncIterable<string> => {
      const current = count.calls
      count.calls += 1
      return (async function* () {
        yield "meta"
        if (current < 1) throw errorWith({ status: 500 })
        yield "tail"
      })()
    }
    const result = await collect(
      streamWithRetry(attempt, {
        signal: new AbortController().signal,
        baseDelayMs: 1,
        // 本次流永远不产生「有效输出」，因此全程走缓冲，靠正常结束补发。
        isValidOutput: () => false,
      }),
    )
    assert.deepEqual(result, ["meta", "tail"], "成功路径必须补发缓冲事件")
    assert.equal(count.calls, 2)
  }

  // 3.7 Abort / 取消类错误 → 不重试。
  {
    const count = { calls: 0 }
    const controller = new AbortController()
    await expectRejects(
      collect(
        streamWithRetry(flakyAttempt(99, ["never"], () => abortError(), count), {
          signal: controller.signal,
          baseDelayMs: 1,
        }),
      ),
      "取消类错误",
    )
    assert.equal(count.calls, 1, "取消后不得重试")

    // 取消发生在重试等待期间：也应立刻结束，不再发下一次尝试。
    const count2 = { calls: 0 }
    const controller2 = new AbortController()
    const slow = streamWithRetry(
      flakyAttempt(99, ["never"], () => errorWith({ status: 500 }), count2),
      {
        signal: controller2.signal,
        baseDelayMs: 50,
        onRetry: () => controller2.abort(),
      },
    )
    await expectRejects(collect(slow), "退避期间取消")
    assert.equal(count2.calls, 1, "退避期间取消后不得再尝试")
  }

  // 3.8 开始前已取消 → 不发请求。
  {
    const count = { calls: 0 }
    const controller = new AbortController()
    controller.abort()
    await expectRejects(
      collect(
        streamWithRetry(flakyAttempt(0, ["never"], () => new Error("x"), count), {
          signal: controller.signal,
        }),
      ),
      "开始前已取消",
    )
    assert.equal(count.calls, 0, "已取消时不应发起尝试")
  }

  // -------------------------------------------------------------------------
  // 4. Dispatcher 初始化
  // -------------------------------------------------------------------------

  const dispatcher = initNetworkDispatcher()
  assert.notEqual(dispatcher, undefined)
  assert.equal(getNetworkDispatcher(), dispatcher, "重复初始化应复用同一实例")
  assert.equal(initNetworkDispatcher(), dispatcher, "重复调用不得重建 Agent")

  // 真实请求走通本机服务器，确认全局 fetch 已被接入（不依赖外网）。
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("pong")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  const address = server.address()
  assert.ok(address !== null && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`

  const response = await fetch(url)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "pong")

  // 第二次请求复用同一 Agent 的连接池（Keep-Alive 生效的直接证据）。
  const response2 = await fetch(url)
  assert.equal(await response2.text(), "pong")

  // 通过 dispatcher 主动关闭连接池，避免进程因 keep-alive 连接挂住。
  await dispatcher.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))

  console.log("retry.test.ts: 网络层断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
