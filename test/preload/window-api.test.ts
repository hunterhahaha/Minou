/** 独立窗口桥的参数、状态校验和监听器隔离。 */
import assert from "node:assert/strict"
import type { IpcRenderer, IpcRendererEvent } from "electron"
import { createWindowApi, exposeWindowApi, WINDOW_IPC_CHANNELS } from "../../src/preload/window-api.ts"
/** @returns 窗口桥异步调用与订阅断言完成。 */
async function main(): Promise<void> {
  const calls: unknown[][] = []
  const listeners = new Set<(event: IpcRendererEvent, value: unknown) => void>()
  let response: unknown = { maximized: false }
  const ipc = {
    async invoke(...args: unknown[]) { calls.push(args); return response },
    on(channel: string, listener: (event: IpcRendererEvent, value: unknown) => void) { assert.equal(channel, WINDOW_IPC_CHANNELS.stateChanged); listeners.add(listener); return ipc },
    removeListener(_channel: string, listener: (event: IpcRendererEvent, value: unknown) => void) { listeners.delete(listener); return ipc },
  } as unknown as Pick<IpcRenderer, "invoke" | "on" | "removeListener">
  const api = createWindowApi(ipc)
  assert.equal(Object.isFrozen(api), true)
  await api.minimize()
  await api.close()
  assert.deepEqual(await api.toggleMaximize(), { maximized: false })
  assert.deepEqual(await api.getState(), { maximized: false })
  assert.deepEqual(calls, [[WINDOW_IPC_CHANNELS.minimize], [WINDOW_IPC_CHANNELS.close], [WINDOW_IPC_CHANNELS.toggleMaximize], [WINDOW_IPC_CHANNELS.getState]])
  response = { behavior: "quit", backgroundAction: "hide", extra: true }
  assert.deepEqual(await api.getCloseSettings(), { behavior: "quit", backgroundAction: "hide" })
  assert.deepEqual(await api.setCloseBehavior("quit"), { behavior: "quit", backgroundAction: "hide" })
  assert.deepEqual(calls.slice(-2), [[WINDOW_IPC_CHANNELS.getCloseSettings], [WINDOW_IPC_CHANNELS.setCloseBehavior, "quit"]])
  await assert.rejects(api.setCloseBehavior("invalid" as "quit"), /窗口关闭偏好无效/)
  response = { behavior: "quit", backgroundAction: "invalid" }
  await assert.rejects(api.getCloseSettings(), /窗口关闭设置无效/)
  response = { maximized: "invalid" }
  await assert.rejects(api.getState(), /窗口状态无效/)
  const received: unknown[][] = []
  const unsubscribe = api.onStateChanged((...args) => received.push(args))
  const keep = api.onStateChanged(() => {})
  for (const listener of listeners) listener({} as IpcRendererEvent, { maximized: true, ignored: "discarded" })
  assert.deepEqual(received, [[{ maximized: true }]], "不暴露原始 Electron 事件或额外字段")
  unsubscribe()
  assert.equal(listeners.size, 1)
  keep()
  assert.equal(listeners.size, 0)
  let exposed: unknown
  exposeWindowApi({ exposeInMainWorld(name, value) { assert.equal(name, "nicodeWindow"); exposed = value } }, ipc)
  assert.equal(Object.isFrozen(exposed), true)
  console.log("window-api.test.ts: 固定通道、状态校验、独立监听、取消订阅与隔离桥均通过")
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
