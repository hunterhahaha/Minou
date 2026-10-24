/** 新聊天模型选择通过真实 preload、IPC 和 SQLite 持久化的回归测试。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { saveProvider, saveModel, readDefaultModel } = require("../../dist/src/main/provider-store.js")
const { registerModelIpcHandlers } = require("../../dist/src/main/provider-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { PROVIDER_IPC_CHANNELS, SESSION_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")

const first = { providerId: "first-provider", protocol: "responses", modelId: "first-model", name: "First model" }
const second = { providerId: "second-provider", protocol: "responses", modelId: "second-model", name: "Second model" }
let window, profile, releaseSave
let pauseNextSave = false, failNextSave = false, saveCalls = 0
const startedModels = [], rendererErrors = []
app.on("window-all-closed", () => {})
registerWindowIpcHandlers(ipcMain, BrowserWindow)

/** @param script Renderer 中执行的脚本。 @returns 脚本结果。 */
const evaluate = (script) => window.webContents.executeJavaScript(script)

/** @param predicate 需要等到的页面或持久化条件。 @returns 条件满足；十秒超时则抛出。 */
async function until(predicate) {
  const deadline = Date.now() + 10000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("默认模型页面验证等待超时")
    await new Promise((done) => setTimeout(done, 20))
  }
}

/** @param name 需要点击的模型名称。 @returns 真实页面的模型选择事件已触发。 */
async function selectModel(name) {
  await evaluate("document.querySelector('.model-trigger').click()")
  await until(() => evaluate("Boolean(document.querySelector('.model-menu'))"))
  await evaluate(`Array.from(document.querySelectorAll('.model-menu button')).find(node => node.querySelector('strong').textContent === ${JSON.stringify(name)}).click()`)
}

/** @param name 预期默认模型名称。 @returns 页面完成保存并显示该模型。 */
async function selected(name) {
  await until(() => evaluate(`document.querySelector('.model-trigger')?.textContent === ${JSON.stringify(name)} && !document.querySelector('.model-trigger').disabled`))
}

/** @returns 页面切换、保存保护、失败重试、重载和首条消息模型传递断言完成。 */
async function main() {
  profile = await mkdtemp(join(tmpdir(), "nicode-default-model-"))
  app.setPath("userData", join(profile, "electron"))
  const paths = await initializeConfigFiles(profile)
  for (const model of [first, second]) {
    saveProvider(paths.providerDatabasePath, { id: model.providerId, name: model.providerId, protocol: model.protocol })
    saveModel(paths.providerDatabasePath, { ...model, contextWindow: 256000, maxOutputTokens: 32000 })
  }
  const port = { handle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (channel === PROVIDER_IPC_CHANNELS.setDefaultModel) {
        saveCalls++
        if (pauseNextSave) {
          pauseNextSave = false
          await new Promise((done) => { releaseSave = done })
        }
        if (failNextSave) {
          failNextSave = false
          throw new Error("注入默认模型保存失败")
        }
      }
      return listener(event, ...args)
    })
  } }
  registerStartupDataIpcHandlers(port, paths)
  registerModelIpcHandlers(port, paths)
  ipcMain.handle(SESSION_IPC_CHANNELS.startNewSession, (_event, _projectId, input) => {
    startedModels.push(input.model)
    throw new Error("首条消息模型已经捕获")
  })
  await app.whenReady()
  window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
    preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true,
    nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } })
  window.webContents.on("console-message", (details) => { if (details.level === "error") rendererErrors.push(details.message) })
  const rendererPath = join(process.cwd(), "dist/src/renderer/index.html")
  await window.loadFile(rendererPath)
  await selected(first.name)
  await evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="任务描述"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '验证默认模型')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(() => evaluate("!document.querySelector('[aria-label=\"发送消息\"]').disabled"))

  pauseNextSave = true
  await selectModel(second.name)
  await until(() => saveCalls === 1 && evaluate("document.querySelector('.model-trigger').disabled"))
  assert.equal(await evaluate("document.querySelector('[aria-label=\"发送消息\"]').disabled"), true, "保存期间禁止发送")
  await evaluate(`document.querySelector('.model-trigger').click(); document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  assert.equal(saveCalls, 1, "保存期间不能再次打开模型菜单发起重复保存")
  assert.deepEqual(startedModels, [], "保存期间的 Enter 不得用旧模型创建对话")
  assert.deepEqual(readDefaultModel(paths.providerDatabasePath), { providerId: first.providerId, modelId: first.modelId })
  releaseSave()
  releaseSave = undefined
  await selected(second.name)
  assert.deepEqual(readDefaultModel(paths.providerDatabasePath), { providerId: second.providerId, modelId: second.modelId })
  assert.equal(await evaluate("document.querySelectorAll('.chat-error').length"), 0)

  await window.loadFile(rendererPath)
  await selected(second.name)
  assert.equal(saveCalls, 1, "重载只读默认值，不再次写入")
  failNextSave = true
  await selectModel(first.name)
  await selected(second.name)
  await until(() => evaluate("document.querySelector('[role=\"alert\"]')?.textContent.includes('默认模型保存失败')"))
  assert.deepEqual(readDefaultModel(paths.providerDatabasePath), { providerId: second.providerId, modelId: second.modelId }, "失败保留已保存的默认模型")
  await selectModel(first.name)
  await selected(first.name)
  assert.equal(saveCalls, 3, "失败后可重新选择并保存")
  assert.equal(await evaluate("document.querySelectorAll('.chat-error').length"), 0, "重试成功清除错误")
  assert.deepEqual(await evaluate("window.nicode.listProviders().then(providers => providers.flatMap(provider => provider.models.filter(model => model.isDefault).map(model => ({ providerId: provider.providerId, modelId: model.modelId }))))"), [
    { providerId: first.providerId, modelId: first.modelId },
  ], "Provider 列表返回唯一已保存的默认模型")
  await evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="任务描述"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '首条消息')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(() => evaluate("!document.querySelector('[aria-label=\"发送消息\"]').disabled"))
  await evaluate("document.querySelector('[aria-label=\"发送消息\"]').click()")
  await until(() => startedModels.length === 1)
  assert.deepEqual(startedModels, [first], "首条消息使用成功保存的模型")
  assert.deepEqual(rendererErrors, [])
  console.log("electron-default-model: 真实 IPC 落盘、忙碌保护、失败保留与重试、重载恢复、首条消息模型通过")
}

void main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  releaseSave?.()
  try {
    if (window && !window.isDestroyed()) window.destroy()
    if (profile) {
      assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  } catch (error) {
    if (process.platform === "win32" && ["EBUSY", "EPERM"].includes(error.code)) {
      console.warn("Chromium 临时目录仍占用，Electron 退出后可清理：" + profile)
    } else {
      console.error(error)
      process.exitCode = 1
    }
  } finally {
    app.exit(process.exitCode ?? 0)
  }
})
