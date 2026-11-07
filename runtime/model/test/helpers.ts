import { splitSystemMessage } from "../src/shared.ts"
import type { ModelMessage, UnifiedModelRequest } from "../src/types.ts"

/**
 * 三种 Adapter 测试共用的本地 HTTP 与 SSE 假 Provider 及流收集辅助函数。
 *
 * 服务器记录请求，按响应计划返回事件、错误、挂起或断开连接；
 * 测试可经真实 SDK 访问本地服务，也可用数组脚本直接驱动离线转换。
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
   * 写完事件后掐断连接。
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

/**
 * 把对象序列化为一行 SSE `data:`。
 * @param payload 要作为 SSE data 输出的对象或原始字符串。
 * @returns 带 data 前缀及事件分隔换行的 SSE 文本。
 * @throws Error 数据读取、序列化或异步场景执行失败时传播，调用方负责处理并清理资源。
 */
export function sseData(payload: object | string): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  return `data: ${text}\n\n`
}

/**
 * 把对象序列化为 Anthropic 的 `event:` + `data:` 两行。
 * @param type 要构造的 SSE 事件名或响应终态事件类型。
 * @param payload 要作为 SSE data 输出的对象或原始字符串。
 * @returns 包含 event 名称和 JSON data 的 SSE 文本。
 * @throws Error 数据读取、序列化或异步场景执行失败时传播，调用方负责处理并清理资源。
 */
export function sseEvent(type: string, payload: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * 顺序读取 HTTP 请求体并将全部缓冲区合并为 UTF-8 字符串。
 * @param request 当前 HTTP 请求或统一模型请求。
 * @returns 完整请求体的 UTF-8 文本。
 * @throws Error 数据读取、序列化或异步场景执行失败时传播，调用方负责处理并清理资源。
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * 启动一个假 Provider。
 *
 * 每次请求都会记录路径与请求体，然后按 `plan` 写出 SSE。`plan` 返回的状态码非 200 时
 * 返回 JSON 错误体，用于验证可重试 / 不可重试的错误路径。
 * @param plan 静态响应或根据捕获请求及同路径零基请求次数决定响应的函数。
 * @returns 服务地址、已捕获请求和关闭函数；调用方须在场景结束后关闭服务。
 * @throws Error 数据读取、序列化或异步场景执行失败时传播，调用方负责处理并清理资源。
 */
export async function startFakeProvider(plan: ResponsePlan): Promise<FakeProvider> {
  const requests: CapturedRequest[] = []

  /**
   * 记录请求路径、JSON 请求体与请求头，按响应计划返回错误或 SSE，并模拟挂起或断开。
   * @param request 当前 HTTP 请求或统一模型请求。
   * @param response 当前请求对应的 HTTP 响应，可被写入或主动断开。
   * @returns 当前场景的转换结果。
   * @throws Error 数据读取、序列化或异步场景执行失败时传播，调用方负责处理并清理资源。
   */
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

    if (planned.hang === true) return /** 保持连接打开，等待客户端取消。 */
    if (planned.destroy === true) {
      if (planned.destroyAfterMs === undefined) {
        response.destroy() /** 立刻掐断：客户端可能一个事件都收不到。 */
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
    /** Anthropic 使用 origin，OpenAI 使用 origin/v1，分别匹配 SDK 的路径拼接。 */
    baseURL: (protocol) => (protocol === "anthropic_messages" ? origin : `${origin}/v1`),
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * 收集一个异步迭代器到数组。
 * @param source 按原顺序消费的异步事件源。
 * @returns 按产出顺序收集的数组。
 * @throws Error 数据读取、序列化或异步场景执行失败时传播，调用方负责处理并清理资源。
 */
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
 * @param items 要逐项产出的事件数组。
 * @returns 依次产出输入数组元素的异步迭代器。
 */
export function streamOf<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item
  })()
}

/**
 * 断言一段异步迭代以抛错结束，并返回该错误。
 * @param source 按原顺序消费的异步事件源。
 * @returns 异步消费期间捕获的原始异常值。
 * @throws Error 预期错误没有发生时抛出，当前测试应失败。
 */
export async function collectError<T>(source: AsyncIterable<T>): Promise<unknown> {
  try {
    await collect(source)
  } catch (error) {
    return error
  }
  throw new Error("预期抛出错误，但正常完成")
}


/** 实测确认的线上格式（对应上面三个协议的事件序列） */


/** baseURL 约定（见 `FakeProvider.baseURL` 的说明）：Anthropic 用 origin（自己拼 /v1）， */
/** OpenAI 用 origin + /v1。同一个字符串不能同时满足两个 SDK。 */

/** Anthropic `/v1/messages`：事件名与 `data.type` 必须一致，SDK 按事件名过滤； */
/** 结束序列为 message_start → content_block_* → message_delta(stop_reason) → message_stop。 */
/** Chat Completions `/v1/chat/completions`：只需 `data:`；Usage 在 choices 为空的最后一个 */
/** chunk 上（`stream_options.include_usage`）；必须以 `data: [DONE]` 结束。 */
/** Responses `/v1/responses`：只需 `data:`；结束事件是 response.completed / .incomplete / .failed。 */

/** 取消：三个 SDK 在流中途被 abort 时**不一定抛错**，可能直接结束流 */
/** （见 `src/shared.ts` 的 `runModelStream`，取消以调用方信号为准做兜底）。 */

/**
 * 对齐使用平铺消息和使用事件历史的测试请求。
 * @param request 脚本 Adapter 收到的请求。
 * @returns 可断言的通用消息。
 */
export function requestMessages(request: UnifiedModelRequest): ModelMessage[] {
  const { system, rest } = splitSystemMessage(request)
  return [{ role: "system", content: system }, ...rest]
}
