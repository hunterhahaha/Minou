/**
 * 进程级 HTTP Dispatcher：Provider SDK / fetch → Global Dispatcher → HTTP Keep-Alive（第 7 节）。
 *
 * Provider 与 Model 可以动态切换，底层 HTTP 连接由这里统一复用。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 7 节（网络层）、第 4 节（启动初始化第 9 步）
 */

import * as undici from "undici"

/** 当前进程已安装的 Dispatcher；未初始化时保持未定义。 */
let dispatcher: undici.Dispatcher | undefined

/**
 * 初始化进程级 HTTP Dispatcher。应在创建任何 Provider SDK 客户端之前调用一次。
 *
 * 两个要点（均由实测确认，非文档记载）：
 *
 * 1. **必须在构造 SDK 客户端之前调用。** 两个官方 SDK 都在 `new` 时就把当时的 `fetch`
 *    捕获到实例上，之后再替换全局 `fetch` 不会影响已建好的客户端。
 *    这正是备忘录第 4 节把「配置全局 Network Dispatcher」（第 9 步）排在
 *    「初始化 Protocol Adapter」（第 11 步）之前的原因。
 *
 * 2. **副作用范围是替换全局。** `undici.install()` 的实现是把 `globalThis` 上的
 *    `fetch` / `Headers` / `Request` / `Response` / `FormData` / `WebSocket` 等整体替换为
 *    undici 的实现（它本身**不**设置 dispatcher）。`setGlobalDispatcher` 则通过
 *    `Symbol.for("undici.globalDispatcher.1")` 共享，因此 Node 原生 `globalThis.fetch`
 *    也会走这里设置的 Agent，SDK 无需额外配置即可复用 Keep-Alive。
 *    这是文档要求的做法，但属于全局改动，故集中在这一个函数里。
 *
 * 重复调用是安全的：已有实例时直接复用，不会重建 Agent、不会丢弃连接池。
 *
 * @returns 已安装并可供调用方复用的进程级 Dispatcher。
 * @throws 当 undici Agent 创建、全局 Dispatcher 设置或全局 API 安装失败时，向调用方抛出底层异常。
 */
export function initNetworkDispatcher(): undici.Dispatcher {
  if (dispatcher !== undefined) return dispatcher

  const agent = new undici.Agent()
  undici.setGlobalDispatcher(agent)
  undici.install()

  dispatcher = agent
  return dispatcher
}

/**
 * 取当前进程级 Dispatcher，不会触发初始化或产生新的连接池。
 *
 * @returns 已初始化的 Dispatcher；未调用 {@link initNetworkDispatcher} 时返回 `undefined`。
 */
export function getNetworkDispatcher(): undici.Dispatcher | undefined {
  return dispatcher
}
