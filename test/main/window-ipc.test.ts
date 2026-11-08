/** 窗口 IPC 只操作当前可信窗口，并校验关闭偏好。 */
import assert from "node:assert/strict"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { registerWindowIpcHandlers } from "../../src/main/window-ipc.ts"
import { WINDOW_IPC_CHANNELS } from "../../src/preload/window-api.ts"

const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { handlers.set(channel, listener) } }
const first = { minimized: 0, closed: 0, maximized: false, destroyed: false,
  isDestroyed() { return this.destroyed }, minimize() { this.minimized++ },
  close() { this.closed++ },
  isMaximized() { return this.maximized }, maximize() { this.maximized = true }, unmaximize() { this.maximized = false },
}
const second = { ...first }
const frame = {}
const sender = { mainFrame: frame, isDestroyed: () => false }
const otherSender = { mainFrame: {}, isDestroyed: () => false }
const windows = new Map<object, typeof first>([[sender, first], [otherSender, second]])
registerWindowIpcHandlers(ipc, { fromWebContents: (content) => (windows.get(content) ?? null) as unknown as BrowserWindow | null }, {
  getCloseSettings: () => ({ behavior: "tray", backgroundAction: "hide" }),
  setCloseBehavior: async (behavior) => ({ behavior, backgroundAction: "hide" }),
})
const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
assert.deepEqual(handlers.get(WINDOW_IPC_CHANNELS.getState)!(event), { maximized: false })
handlers.get(WINDOW_IPC_CHANNELS.minimize)!(event)
assert.equal(first.minimized, 1)
assert.equal(second.minimized, 0, "不操作其他窗口")
handlers.get(WINDOW_IPC_CHANNELS.close)!(event)
assert.equal(first.closed, 1)
assert.equal(second.closed, 0)
assert.deepEqual(handlers.get(WINDOW_IPC_CHANNELS.getCloseSettings)!(event), { behavior: "tray", backgroundAction: "hide" })
assert.throws(() => handlers.get(WINDOW_IPC_CHANNELS.setCloseBehavior)!(event, "invalid"), /关闭偏好无效/)
assert.deepEqual(handlers.get(WINDOW_IPC_CHANNELS.toggleMaximize)!(event), { maximized: true })
assert.deepEqual(handlers.get(WINDOW_IPC_CHANNELS.toggleMaximize)!(event), { maximized: false })
const subframe = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent
assert.throws(() => handlers.get(WINDOW_IPC_CHANNELS.minimize)!(subframe), /来源无效/)
assert.throws(() => handlers.get(WINDOW_IPC_CHANNELS.close)!(subframe), /来源无效/)
assert.throws(() => handlers.get(WINDOW_IPC_CHANNELS.getCloseSettings)!(subframe), /来源无效/)
assert.throws(() => handlers.get(WINDOW_IPC_CHANNELS.setCloseBehavior)!(subframe, "quit"), /来源无效/)
first.destroyed = true
assert.throws(() => handlers.get(WINDOW_IPC_CHANNELS.minimize)!(event), /来源无效/)
const missingWindow = { sender: { isDestroyed: () => true } } as unknown as IpcMainInvokeEvent
assert.throws(() => handlers.get(WINDOW_IPC_CHANNELS.getState)!(missingWindow), /来源无效/)
assert.equal(handlers.size, 6, "只注册窗口窄接口")
console.log("window-ipc.test.ts: 当前窗口隔离、最大化/还原、最小化、失效窗口与子 frame 拒绝均通过")
