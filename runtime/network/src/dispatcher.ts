/**
 * 安装并缓存进程级 undici Dispatcher，供全局 fetch 与 SDK 共享 HTTP 连接池。
 */

import * as undici from "undici"

/** 当前进程已安装的 Dispatcher；未初始化时保持未定义。 */
let dispatcher: undici.Dispatcher | undefined

/**
 * 初始化全局 Dispatcher，应在创建 Provider SDK 客户端前执行。
 *
 * 先创建 Agent 并设置全局 Dispatcher，再安装 undici 全局网络 API；全部完成后缓存实例。
 * 重复调用返回缓存对象；外部关闭对象不会清除此缓存或恢复全局 API。
 * @returns 本进程缓存的 Dispatcher。
 * @throws Error 创建 Agent、设置 Dispatcher 或安装 API 失败时传播；已发生的全局副作用不自动回滚，调用方负责处理启动失败。
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
