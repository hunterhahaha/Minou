/**
 * 三个 Adapter 测试共用的假 Provider 服务器。
 *
 * 只有本文件不与 `src/` 下的源码一一对应：它是三个协议测试共同的测试基础设施，
 * 用来验证"真实走一遍 SDK + HTTP + SSE"的路径（离线单元转换在各自的 test 里）。
 *
 * 三个协议的线上格式由实测确定（见文件末尾注释），要点：
 *   - 请求体是 JSON，`/v1/messages`、`/v1/chat/completions`、`/v1/responses` 三条路径；
 *   - 响应是 `text/event-stream`；
 *   - Anthropic 必须带 `event: <type>` 名，两个 OpenAI 协议只需要 `data:`，
 *     且 Chat Completions 必须以 `data: [DONE]` 结束。
 */

import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

/** 一次被捕获的请求：协议路径、解析后的请求体与请求头。 */
export interface CapturedRequest {
  path: string
  body: Record<string, unknown>
  headers: IncomingMessage["headers"]
}

/** 一次响应：SSE 文本行（已含 `event:`/`data:` 前缀）与状态码。 */
export interface FakeResponse {
  status?: number
  /** 按顺序写入的 SSE 文本块；字符串直接写入，对象会按 `data:` 行序列化。 */
  events?: (string | object)[]
  /** 是否在流末尾挂起不结束（用于取消测试）。 */
  hang?: boolean
  /**
   * 写完事件后掐断连接（用于「流中途断开」的重试测试，第 7 节）。
   *
   * 两个 SDK 都会抛出 `TypeError: terminated`，其 `cause` 是 undici 的
   * `SocketError`（`UND_ERR_SOCKET`），因此 `isRetryableError` 判定为可重试。
   */
  destroy?: boolean
  /**
   * 与 `destroy` 搭配的延迟毫秒数。
   *
   * 立即 destroy 有可能把刚写入的数据一起丢掉，客户端一个事件都收不到 ——
   * 那样测的是「尚无有效输出」而不是「已产生有效输出」。要验证后者必须让已写入的事件
   * 先真正到达客户端，因此留一段延迟再断开。
   */
  destroyAfterMs?: number
}

/** 一次请求对应的响应；可以是静态值，也可以按第几次请求动态给出（用于重试测试）。 */
export type ResponsePlan = FakeResponse | ((request: CapturedRequest, attempt: number) => FakeResponse)

/** 假服务器句柄。 */
export interface FakeProvider {
  /** 服务器 origin，不含任何路径段。 */
  origin: string
  /**
   * 按协议取 baseURL。
   *
   * 两个 SDK 对 baseURL 的约定不同（实测）：
   *   - Anthropic SDK：baseURL 是 origin，自己拼 `/v1/messages`（默认值 `https://api.anthropic.com`）；
   *   - OpenAI SDK：baseURL 是 origin + `/v1`，自己只拼 `/chat/completions`、`/responses`
   *     （默认值 `https://api.openai.com/v1`）。
   *
   * 这也是 `ProtocolClientOptions.baseURL` 必须按 Provider 配置给的原因：
   * 同一个字符串不能同时满足两个 SDK。
   */
  baseURL(protocol: "anthropic_messages" | "chat_completions" | "responses"): string
  /** 收到的全部请求，按顺序。 */
  requests: CapturedRequest[]
  close: () => Promise<void>
}

/** 把对象序列化为一行 SSE `data:`。 */
export function sseData(payload: object | string): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  return `data: ${text}\n\n`
}

/** 把对象序列化为 Anthropic 的 `event:` + `data:` 两行。 */
export function sseEvent(type: string, payload: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * 启动一个假 Provider。
 *
 * 每次请求都会记录路径与请求体，然后按 `plan` 写出 SSE。`plan` 返回的状态码非 200 时
 * 返回 JSON 错误体，用于验证可重试 / 不可重试的错误路径（第 7 节）。
 */
export async function startFakeProvider(plan: ResponsePlan): Promise<FakeProvider> {
  const requests: CapturedRequest[] = []

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request)
    const captured: CapturedRequest = {
      path: request.url ?? "",
      body: body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {},
      headers: request.headers,
    }
    const attempt = requests.filter((item) => item.path === captured.path).length
    requests.push(captured)

    const planned = typeof plan === "function" ? plan(captured, attempt) : plan
    const status = planned.status ?? 200

    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { type: "test_error", message: "planned failure" } }))
      return
    }

    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of planned.events ?? []) {
      response.write(typeof event === "string" ? event : sseData(event))
    }

    if (planned.hang === true) return // 保持连接打开，等待客户端取消。
    if (planned.destroy === true) {
      if (planned.destroyAfterMs === undefined) {
        response.destroy() // 立刻掐断：客户端可能一个事件都收不到。
      } else {
        setTimeout(() => response.destroy(), planned.destroyAfterMs)
      }
      return
    }
    response.end()
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("假服务器未取得端口")

  const origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    // 只给 origin：三个 SDK 都会自己拼上 `/v1/<path>`，多带一段会变成 `/v1/v1/...`。
    baseURL: (protocol) => (protocol === "anthropic_messages" ? origin : `${origin}/v1`),
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 收集一个异步迭代器到数组。 */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

/**
 * 把事件数组包成异步迭代器。
 *
 * 离线转换函数的入参是 `AsyncIterable`（真实 SDK 流就是异步可迭代的），
 * 数组虽然在运行期也能被 `for await` 消费，但类型上不满足，因此测试统一用这个包一层。
 */
export function streamOf<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item
  })()
}

/** 断言一段异步迭代以抛错结束，并返回该错误。 */
export async function collectError<T>(source: AsyncIterable<T>): Promise<unknown> {
  try {
    await collect(source)
  } catch (error) {
    return error
  }
  throw new Error("预期抛出错误，但正常完成")
}

// ---------------------------------------------------------------------------
// 实测确认的线上格式（对应上面三个协议的事件序列）
// ---------------------------------------------------------------------------
//
// baseURL 约定（见 `FakeProvider.baseURL` 的说明）：Anthropic 用 origin（自己拼 /v1），
//   OpenAI 用 origin + /v1。同一个字符串不能同时满足两个 SDK。
//
// Anthropic `/v1/messages`：事件名与 `data.type` 必须一致，SDK 按事件名过滤；
//   结束序列为 message_start → content_block_* → message_delta(stop_reason) → message_stop。
// Chat Completions `/v1/chat/completions`：只需 `data:`；Usage 在 choices 为空的最后一个
//   chunk 上（`stream_options.include_usage`）；必须以 `data: [DONE]` 结束。
// Responses `/v1/responses`：只需 `data:`；结束事件是 response.completed / .incomplete / .failed。
//
// 取消：三个 SDK 在流中途被 abort 时**不一定抛错**，可能直接结束流
//   （见 `src/shared.ts` 的 `runModelStream`，取消以调用方信号为准做兜底）。
