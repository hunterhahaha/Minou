/** 真实 Electron/preload/IPC/SQLite 的搜索配置管理与缓存恢复验证。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { registerModelIpcHandlers } = require("../../dist/src/main/provider-ipc.js")
const { registerWebSearchIpcHandlers } = require("../../dist/src/main/web-search-ipc.js")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { WEB_SEARCH_IPC_CHANNELS: channels } = require("../../dist/src/preload/session-api.js")
const { listWebSearchProviders, WEB_SEARCH_DATABASE_FILE } = require("../../dist/runtime/tools/src/web-search/store.js")
let profile, paths, window, gate, release
let failList = false, failWrite = false, creates = 0, reads = 0, detailReads = 0
app.disableHardwareAcceleration()
/** @param condition 异步条件。 @returns 条件满足。 @throws Error 十秒内未满足。 */
async function until(condition) {
  const end = Date.now() + 10000
  while (!await condition()) { if (Date.now() > end) throw new Error("搜索设置等待超时"); await new Promise(resolve => setTimeout(resolve, 20)) }
}
/** @param script 页面表达式。 @returns 执行结果。 */
const evaluate = script => window.webContents.executeJavaScript(script)
/** @param selector 目标元素。 @returns 点击完成。 */
async function click(selector) { await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) throw new Error('控件不可用 ' + ${JSON.stringify(selector)}); node.click() })()`) }
/** @param text 按钮文本。 @returns 点击完成。 */
async function clickText(text) { await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(n => n.textContent.trim() === ${JSON.stringify(text)}); if (!node || node.disabled) throw new Error('按钮不可用 ' + ${JSON.stringify(text)}); node.click() })()`) }
/** @param key 字段标签。 @param value 字段内容。 @returns 受控输入完成。 */
async function fill(key, value) { await evaluate(`(() => { const node = document.querySelector('[aria-label="${key}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })) })()`) }
/** @returns 已完成页面请求。 */
const idle = () => until(() => evaluate(`document.querySelector('.web-search-settings')?.getAttribute('aria-busy') === 'false'`))
/** @returns 已初始化数据的配置列表。 */
const saved = () => listWebSearchProviders(join(paths.rootDir, WEB_SEARCH_DATABASE_FILE))
/** @returns 页面没有可交互的旧缓存。 */
async function protectedPage() {
  assert.equal(await evaluate(`document.querySelector('[aria-label="关闭设置"]').disabled && [...document.querySelectorAll('.settings-nav-option')].every(n => n.disabled)`), true)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`)
  assert.equal(await evaluate(`!!document.querySelector('.settings-dialog')`), true)
}
/** @returns 全部真实页面行为、主题和尺寸检查完成。 @throws Error 任一断言失败。 */
async function main() {
  profile = await mkdtemp(join(tmpdir(), "nicode-web-settings-"))
  app.setPath("userData", join(profile, "electron-user-data"))
  paths = await initializeConfigFiles(profile, { skipSkills: true })
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  registerStartupDataIpcHandlers(ipcMain, paths)
  registerModelIpcHandlers(ipcMain, paths)
  registerWebSearchIpcHandlers({ handle(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (channel === channels.listWebSearchProviders) { reads++; if (failList) { failList = false; throw new Error("注入列表失败") } }
      if (channel === channels.getWebSearchProvider) detailReads++
      if (channel === channels.createWebSearchProvider) { creates++; await gate; if (failWrite) { failWrite = false; throw new Error("注入保存失败") } }
      return handler(event, ...args)
    })
  } }, paths)
  await app.whenReady()
  window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: {
    preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } })
  await window.loadFile(join(process.cwd(), "dist/src/renderer/index.html"))
  await until(() => evaluate(`!!document.querySelector('.sidebar-settings')`))
  assert.equal(reads, 0)
  await click(".sidebar-settings")
  await until(() => evaluate(`!!document.querySelector('.settings-dialog')`))
  failList = true
  await clickText("搜索服务"); await idle()
  assert.match(await evaluate(`document.querySelector('.web-search-settings').textContent`), /加载失败/)
  await clickText("重试刷新"); await idle()
  assert.equal(detailReads, 0)
  assert.equal(await evaluate(`document.querySelector('[aria-label="max_results"]').required`), false)
  assert.equal(await evaluate(`document.querySelector('[aria-label="max_results"]').placeholder`), "5")
  await fill("APIKEY", "first-key")
  await fill("max_results", "9")
  assert.equal(await evaluate(`document.querySelector('[aria-label="max_results"]').checkValidity()`), false)
  await fill("max_results", "")
  gate = new Promise(resolve => { release = resolve })
  await clickText("创建配置")
  await until(() => creates === 1)
  await protectedPage()
  release(); gate = undefined
  await idle()
  assert.equal(saved().length, 1)
  const first = saved()[0].id
  assert.equal(saved()[0].enabled, false)
  assert.equal(JSON.parse(JSON.parse(saved()[0].requestJson).body).max_results, 5)
  assert.equal(await evaluate(`document.querySelector('[aria-label="APIKEY"]').type`), "password")
  assert.equal(await evaluate(`document.querySelector('[aria-label="APIKEY"]').value`), "first-key")
  await fill("APIKEY", "edited-key"); await fill("max_results", "8")
  await clickText("保存配置"); await idle()
  assert.equal(JSON.parse(saved()[0].requestJson).headers.Authorization, "Bearer edited-key")
  assert.equal(await evaluate(`document.querySelector('[aria-label="APIKEY"]').value`), "edited-key")
  await clickText("启用"); await idle()
  assert.equal(saved()[0].enabled, true)
  await click('[aria-label="新增搜索服务商"]'); await idle()
  assert.equal(await evaluate(`document.querySelector('[aria-label="APIKEY"]').value`), "")
  await fill("APIKEY", "second-key")
  failWrite = true
  await clickText("创建配置"); await idle()
  assert.equal(saved().length, 1)
  assert.equal(await evaluate(`document.querySelector('[aria-label="APIKEY"]').value`), "second-key")
  failList = true
  await clickText("创建配置"); await idle()
  assert.equal(saved().length, 2)
  assert.match(await evaluate(`document.querySelector('.web-search-settings').textContent`), /操作已保存/)
  const createCount = creates
  await clickText("重试刷新"); await idle()
  assert.equal(creates, createCount, "刷新失败不能重复创建")
  const second = saved().find(item => item.id !== first).id
  await clickText("启用"); await idle()
  assert.equal(saved().find(item => item.id === first).enabled, false)
  assert.equal(saved().find(item => item.id === second).enabled, true)
  assert.equal(await evaluate(`[...document.querySelectorAll('[aria-label="搜索服务商列表"] .web-search-provider-status')].filter(n => n.textContent === '已启用').length`), 1)
  for (const provider of saved()) {
    assert.equal(await evaluate(`document.querySelector('[aria-label="搜索服务商列表"]').textContent.includes(${JSON.stringify(provider.id.slice(0, 8))})`), false)
  }
  await clickText("停用"); await idle()
  assert.equal(saved().some(item => item.enabled), false)
  await clickText("启用"); await idle()
  await clickText("删除配置"); await clickText("取消删除")
  assert.equal(saved().length, 2)
  await clickText("删除配置"); await clickText("确认删除"); await idle()
  assert.equal(saved().length, 1)
  assert.equal(saved()[0].enabled, false)
  await click(".web-search-settings .provider-list-item"); await idle()
  assert.equal(await evaluate(`document.querySelector('[aria-label="APIKEY"]').value`), "edited-key")
  for (const theme of ["light", "dark"]) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    for (const [width, height] of [[1200, 900], [420, 680]]) {
      window.setContentSize(width, height)
      for (const zoom of [1, 1.25, 1.5]) {
        window.webContents.setZoomFactor(zoom)
        await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
        assert.equal(await evaluate(`(() => { const node = document.querySelector('[aria-label="搜索服务设置"]'); return node.scrollWidth <= node.clientWidth + 1 })()`), true, `横向溢出 ${theme}/${width}/${zoom}`)
      }
      window.webContents.setZoomFactor(1)
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      await writeFile(join(process.cwd(), `dist/web-search-settings-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG())
    }
  }
  await evaluate(`document.querySelector('[aria-label="APIKEY"]').focus()`)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), "APIKEY")
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`)
  await until(() => evaluate(`!document.querySelector('.settings-dialog')`))
  window.setContentSize(1200, 900)
  await click(".sidebar-settings"); await clickText("搜索服务"); await idle()
  assert.equal(await evaluate(`document.querySelector('[aria-label="APIKEY"]').value`), "")
  await click(".web-search-settings .provider-list-item"); await idle()
  assert.equal(await evaluate(`document.querySelector('[aria-label="APIKEY"]').value`), "edited-key")
  assert.equal(await evaluate(`typeof require`), "undefined")
  console.log("electron-web-search-settings: 增改删、同名、默认值、唯一启停、全量缓存、读写失败、忙碌保护、重开恢复、主题及缩放通过")
}
void main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  release?.()
  if (window && !window.isDestroyed()) window.destroy()
  if (profile) { assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep)); await rm(profile, { recursive: true, force: true }) }
  app.exit(process.exitCode ?? 0)
})
