/** 新聊天模型选择通过真实 preload、IPC 和 SQLite 持久化的回归测试。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { saveProvider, saveModel, readDefaultModel, listProviders } = require("../../dist/src/main/provider-store.js")
const { registerModelIpcHandlers } = require("../../dist/src/main/provider-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { PROVIDER_IPC_CHANNELS, SESSION_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")

const first = { providerId: "first-provider", protocol: "responses", modelId: "first-model", name: "First model", reasoningLevel: "medium" }
const second = { providerId: "second-provider", protocol: "responses", modelId: "second-model", name: "Second model", reasoningLevel: "medium" }
const reasoning = { supportsReasoning: true, reasoningLevels: ["low", "medium", "high"], reasoningField: { path: ["reasoning", "effort"] } }
let window, profile, releaseSave
let failNextModelUpdate = false
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
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  await until(() => evaluate("Boolean(document.querySelector('.model-menu'))"))
  await evaluate(`Array.from(document.querySelectorAll('.model-menu button')).find(node => node.querySelector('strong').textContent === ${JSON.stringify(name)}).click()`)
}

/** @param name 预期默认模型名称。 @returns 页面完成保存并显示该模型。 */
async function selected(name) {
  await until(() => evaluate(`document.querySelector('.composer-model-name')?.textContent === ${JSON.stringify(name)} && !document.querySelector('.model-trigger').disabled`))
}

/** @returns 页面切换、保存保护、失败重试、重载和首条消息模型传递断言完成。 */
async function main() {
  profile = await mkdtemp(join(tmpdir(), "minou-default-model-"))
  app.setPath("userData", join(profile, "electron"))
  const paths = await initializeConfigFiles(profile)
  for (const model of [first, second]) {
    saveProvider(paths.providerDatabasePath, { id: model.providerId, name: model.providerId, type: "custom", protocol: model.protocol })
    saveModel(paths.providerDatabasePath, { ...model, ...reasoning, reasoningLevels: model === second ? ["max"] : reasoning.reasoningLevels, contextWindow: 256000, maxOutputTokens: 32000 })
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
      if (channel === PROVIDER_IPC_CHANNELS.updateModel && failNextModelUpdate) {
        failNextModelUpdate = false
        throw new Error("注入模型能力保存失败")
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
    const input = document.querySelector('.composer-editor[aria-label="任务描述"]')
    input.focus()
    window.getSelection().selectAllChildren(input)
    document.execCommand('insertText', false, '验证默认模型')
  })()`)
  await until(() => evaluate("!document.querySelector('[aria-label=\"发送消息\"]').disabled"))

  pauseNextSave = true
  await selectModel(second.name)
  await until(() => saveCalls === 1 && evaluate("document.querySelector('.model-trigger').disabled"))
  assert.equal(await evaluate("document.querySelector('[aria-label=\"发送消息\"]').disabled"), true, "保存期间禁止发送")
  await evaluate(`document.querySelector('.model-trigger').click(); document.querySelector('.composer-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  assert.equal(saveCalls, 1, "保存期间不能再次打开模型菜单发起重复保存")
  assert.deepEqual(startedModels, [], "保存期间的 Enter 不得用旧模型创建对话")
  assert.deepEqual(readDefaultModel(paths.providerDatabasePath), { providerId: first.providerId, modelId: first.modelId })
  releaseSave()
  releaseSave = undefined
  await selected(second.name)
  assert.equal(await evaluate("document.querySelector('.composer-model-reasoning').textContent"), "max", "切换模型时回退到新模型有效等级")
  await evaluate("document.querySelector('.model-trigger').click()")
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  await evaluate("document.querySelector('.model-menu [aria-checked=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))")
  await until(() => evaluate("Boolean(document.querySelector('.model-level-flyout'))"))
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.model-level-flyout button')].map(node => [node.querySelector('span').textContent, node.getAttribute('aria-checked')])"), [["max", "true"]], "只有一个等级时展示唯一已选项")
  await evaluate("document.querySelector('.composer-model-panel').hidePopover()")
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
  assert.deepEqual(await evaluate("window.minou.listProviders().then(providers => providers.flatMap(provider => provider.models.filter(model => model.isDefault).map(model => ({ providerId: provider.providerId, modelId: model.modelId }))))"), [
    { providerId: first.providerId, modelId: first.modelId },
  ], "Provider 列表返回唯一已保存的默认模型")
  await evaluate("document.querySelector('.model-trigger').click()")
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  await evaluate("document.querySelector('.model-menu [aria-checked=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))")
  await until(() => evaluate("Boolean(document.querySelector('.model-level-flyout'))"))
  await evaluate("[...document.querySelectorAll('.model-level-flyout button')].find(node => node.querySelector('span').textContent === 'high').click()")
  assert.equal(await evaluate("document.querySelector('.composer-model-reasoning').textContent"), "high")
  await until(() => evaluate("!document.querySelector('.composer-model-panel:popover-open')"))
  await evaluate(`(() => {
    const input = document.querySelector('.composer-editor[aria-label="任务描述"]')
    input.focus()
    window.getSelection().selectAllChildren(input)
    document.execCommand('insertText', false, '首条消息')
  })()`)
  await until(() => evaluate("!document.querySelector('[aria-label=\"发送消息\"]').disabled"))
  await evaluate("document.querySelector('[aria-label=\"发送消息\"]').click()")
  await until(() => startedModels.length === 1)
  assert.deepEqual(startedModels, [{ ...first, reasoningLevel: "high" }], "首条消息使用成功保存的模型与页面选择的推理等级")
  // 使用真实设置页面创建非思考模型，再编辑能力与默认配置。
  await evaluate("document.querySelector('.sidebar-settings').click()")
  await until(() => evaluate("Boolean(document.querySelector('.provider-models-section'))"))
  await evaluate("[...document.querySelectorAll('.provider-list-item')].find(node => node.textContent.includes('first-provider')).click()")
  await until(() => evaluate("document.querySelector('.provider-detail-heading h3')?.textContent === 'first-provider'"))
  assert.equal(await evaluate(`(() => {
    const content = document.querySelector('.model-settings-page')
    const sidebar = content.querySelector('.provider-sidebar')
    const rows = [...sidebar.querySelectorAll('.provider-list-item')]
    const height = matchMedia('(pointer: coarse)').matches ? 44 : 30
    return Math.abs(sidebar.getBoundingClientRect().top - content.getBoundingClientRect().top) <= 1 &&
      rows.length === 2 && rows.every(row => {
        const name = row.querySelector('.provider-list-name').getBoundingClientRect()
        const count = row.querySelector('.provider-list-model-count')
        const countBounds = count.getBoundingClientRect()
        const rightInset = row.getBoundingClientRect().right - countBounds.right
        return row.offsetHeight === height && Number.isInteger(Number(count.textContent)) &&
          Math.abs((name.top + name.bottom) - (countBounds.top + countBounds.bottom)) <= 2 &&
          Math.abs(rightInset - parseFloat(getComputedStyle(row).paddingRight)) <= 1
      })
  })()`), true, "供应商选项为紧凑单行，模型数量在行内靠右")
  await evaluate("[...document.querySelectorAll('.provider-models-section button')].find(node => node.textContent.includes('新建模型')).click()")
  await until(() => evaluate("Boolean(document.querySelector('.new-model-form'))"))
  assert.equal(await evaluate("document.querySelector('.new-model-form [aria-label=支持思考]').checked"), false)
  assert.equal(await evaluate("Boolean(document.querySelector('.new-model-form .reasoning-level-list'))"), false)
  await evaluate(`(() => {
    const input = document.querySelector('.new-model-form input[type=text]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Plain model')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(() => evaluate("!document.querySelector('.new-model-form button[type=submit]').disabled"))
  await evaluate("document.querySelector('.new-model-form button[type=submit]').click()")
  await until(() => evaluate("!document.querySelector('.new-model-form')"))
  const plain = listProviders(paths.providerDatabasePath).find(provider => provider.id === first.providerId).models.find(model => model.name === 'Plain model')
  assert.equal(plain.supportsReasoning, false)
  assert.deepEqual(plain.reasoningLevels, ['low', 'medium', 'high'])
  await evaluate("[...document.querySelectorAll('.provider-model-editor summary')].find(node => node.textContent.includes('Plain model')).click()")
  const editor = "[...document.querySelectorAll('.provider-model-editor')].find(node => node.querySelector('summary').textContent.includes('Plain model'))"
  await until(() => evaluate(`Boolean(${editor}.querySelector('[aria-label="编辑支持思考"]'))`))
  await evaluate(`${editor}.querySelector('[aria-label="编辑支持思考"]').click()`)
  await until(() => evaluate(`Boolean(${editor}.querySelector('.reasoning-level-list'))`))
  failNextModelUpdate = true
  await evaluate(`[...${editor}.querySelectorAll('button')].find(node => node.textContent === '保存推理配置').click()`)
  await until(() => evaluate(`${editor}.querySelector('[role=alert]')?.textContent.includes('模型操作失败')`))
  assert.equal(listProviders(paths.providerDatabasePath).find(provider => provider.id === first.providerId).models.find(model => model.modelId === plain.modelId).supportsReasoning, false)
  const expectedErrors = rendererErrors.splice(0)
  assert.ok(expectedErrors.length > 0 && expectedErrors.every(message => /注入模型能力保存失败|更新模型推理配置失败/.test(message)))
  await evaluate(`[...${editor}.querySelectorAll('button')].find(node => node.textContent === '保存推理配置').click()`)
  await until(() => evaluate(`${editor}.querySelector('[role=status]')?.textContent === '已保存' || !${editor}.querySelector('.model-save-status')`))
  assert.equal(listProviders(paths.providerDatabasePath).find(provider => provider.id === first.providerId).models.find(model => model.modelId === plain.modelId).supportsReasoning, true)
  for (let remaining = 3; remaining > 0; remaining--) {
    await evaluate(`${editor}.querySelector('[aria-label^="移除推理等级"]').click()`)
    await until(() => evaluate(`${editor}.querySelectorAll('[aria-label^="移除推理等级"]').length === ${remaining - 1}`))
  }
  await evaluate(`(() => {
    const root = ${editor}
    const input = root.querySelector('[aria-label="编辑推理字段路径"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(() => evaluate(`Boolean([...${editor}.querySelectorAll('button')].find(node => node.textContent === '保存推理配置'))`))
  await evaluate(`[...${editor}.querySelectorAll('button')].find(node => node.textContent === '保存推理配置').click()`)
  await until(() => evaluate(`${editor}.querySelector('[aria-label="编辑推理字段路径"]').value === 'reasoning.effort'`))
  assert.deepEqual(listProviders(paths.providerDatabasePath).find(provider => provider.id === first.providerId).models.find(model => model.modelId === plain.modelId).reasoningLevels, ['low', 'medium', 'high'])
  await evaluate(`${editor}.querySelector('[aria-label="编辑支持思考"]').click()`)
  await until(() => evaluate(`!${editor}.querySelector('.reasoning-level-list')`))
  await evaluate(`[...${editor}.querySelectorAll('button')].find(node => node.textContent === '保存推理配置').click()`)
  await until(() => evaluate(`!${editor}.querySelector('.model-save-status')`))
  await evaluate("document.querySelector('[aria-label=关闭设置]').click()")
  await until(() => evaluate("!document.querySelector('.settings-dialog')"))
  await selectModel(plain.name)
  await selected(plain.name)
  assert.equal(await evaluate("Boolean(document.querySelector('.composer-model-reasoning'))"), false)
  await evaluate("document.querySelector('.model-trigger').click()")
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=设置推理等级]'))"), false)
  assert.equal(await evaluate("document.querySelector('.model-trigger').title"), plain.name)
  for (const [theme, width] of [['light', 1200], ['dark', 640]]) {
    window.setContentSize(width, 800)
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`)
    await until(() => evaluate(`innerWidth === ${width}`))
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true)
    await writeFile(join(process.cwd(), 'dist', 'reasoning-disabled-' + theme + '.png'), (await window.webContents.capturePage()).toPNG())
  }
  await evaluate("document.querySelector('.composer-model-panel').hidePopover()")
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
