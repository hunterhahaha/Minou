/** 使用真实桌面入口和独立 Electron 进程验证托盘、窗口与偏好。先运行 npm run build。 */
const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { setTimeout: delay } = require("node:timers/promises")

/** @returns Electron 子进程正常退出后完成的 Promise。 */
async function runChild(executable, mode, profile) {
  const child = spawn(executable, [__filename, mode, profile], { stdio: "inherit", timeout: 30_000 })
  await new Promise((done, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) done()
      else reject(new Error(`${mode} 进程退出：${code ?? signal}`))
    })
  })
}

/** @returns 当前 Electron 窗口或页面达到预期状态。 */
async function until(condition, description) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const value = await condition()
    if (value) return value
    await delay(35)
  }
  throw new Error(`等待超时：${description}`)
}

/** @returns 已完成各进程及隔离用户目录的清理。 */
async function main() {
  const profile = await mkdtemp(join(tmpdir(), "nicode-tray-test-"))
  try {
    const electron = require("electron")
    await runChild(electron, "primary", profile)
    await runChild(electron, "restart", profile)
    await writeFile(join(profile, ".nicode", "desktop-settings.json"), JSON.stringify({ closeBehavior: "tray" }))
    await runChild(electron, "fallback", profile)
    console.log("electron-tray.test.cjs: 托盘、单实例、窗口恢复、偏好保存及退出通过")
  } finally {
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

/** @returns 测试操作已触发正常应用退出，进程退出事件另行验证清理。 */
async function exercise(mode, profile) {
  const { app, BrowserWindow, Menu, Tray } = require("electron")
  process.env.USERPROFILE = profile
  delete process.env.NICODE_RENDERER_URL
  app.setPath("userData", profile)

  if (mode === "secondary") {
    // 同一份 userData 获取单实例锁，但配置应在锁失败时完全不读取。
    process.env.USERPROFILE = "invalid-profile"
    require("../../dist/src/main/electron-main.js")
    assert.equal(app.hasSingleInstanceLock(), false)
    return
  }

  const trays = []
  let menu
  const setToolTip = Tray.prototype.setToolTip
  Tray.prototype.setToolTip = function (label) {
    assert.equal(label, "NiCode")
    trays.push(this)
    if (mode === "fallback") throw new Error("注入托盘初始化失败")
    return setToolTip.call(this, label)
  }
  const buildMenu = Menu.buildFromTemplate
  Menu.buildFromTemplate = function (template) {
    const result = buildMenu.call(this, template)
    if (template[0]?.label === "显示 NiCode") menu = result
    return result
  }
  const { SessionRuntimeGlobal } = require("../../dist/src/main/session-runtime-global.js")
  const disposeProcessTools = SessionRuntimeGlobal.prototype.disposeProcessTools
  let cleanupCount = 0
  SessionRuntimeGlobal.prototype.disposeProcessTools = function () {
    cleanupCount++
    return disposeProcessTools.call(this)
  }
  let scenarioComplete = false
  app.once("quit", () => {
    assert.ok(scenarioComplete)
    assert.equal(cleanupCount, 1)
    assert.equal(trays.length, 1)
    assert.ok(trays[0].isDestroyed(), "托盘已随正常退出释放")
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    console.log(`electron-tray ${mode}: 退出与资源清理通过`)
  })
  require("../../dist/src/main/electron-main.js")
  const window = await until(() => BrowserWindow.getAllWindows().find(candidate => candidate.isVisible()), "首窗显示")
  const evaluate = (source) => window.webContents.executeJavaScript(source)
  await until(() => evaluate('Boolean(document.querySelector(".window-close"))'), "工作台渲染")
  const closeSettings = () => evaluate("window.nicodeWindow.getCloseSettings()")
  const tray = trays[0]
  assert.equal(trays.length, 1)
  const keepsTaskbar = mode === "fallback" || process.platform === "linux"
  assert.deepEqual(await closeSettings(), { behavior: mode === "restart" ? "quit" : "tray", backgroundAction: keepsTaskbar ? "minimize" : "hide" })
  if (mode === "restart") {
    scenarioComplete = true
    await evaluate('document.querySelector(".window-close").click()')
    return
  }
  if (mode === "fallback") {
    assert.ok(tray.isDestroyed())
    window.close()
    await until(() => window.isMinimized(), "托盘失败时最小化")
    assert.equal(window.isDestroyed(), false)
    scenarioComplete = true
    app.quit()
    return
  }

  assert.deepEqual(menu.items.map(item => item.label), ["显示 NiCode", "退出 NiCode"])
  assert.ok(!tray.isDestroyed())
  await evaluate(`(() => {
    const composer = document.querySelector('[aria-label="任务描述"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(composer, "保留这条草稿")
    composer.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  const draft = () => evaluate(`document.querySelector('[aria-label="任务描述"]').value`)
  const backgrounded = () => keepsTaskbar ? window.isMinimized() : !window.isVisible()
  const restored = () => window.isVisible() && !window.isMinimized()
  window.close()
  await until(backgrounded, "原生关闭转入后台")
  tray.emit("click")
  await until(restored, "托盘点击恢复")
  assert.equal(await draft(), "保留这条草稿")
  tray.emit("click")
  await until(backgrounded, "托盘点击转入后台")
  menu.items[0].click()
  await until(restored, "托盘菜单恢复")
  await evaluate('document.querySelector(".window-close").click()')
  await until(backgrounded, "自绘关闭转入后台")

  await runChild(process.execPath, "secondary", profile)
  await until(restored, "第二实例恢复首窗")
  assert.deepEqual(BrowserWindow.getAllWindows().map(candidate => candidate.id), [window.id])
  assert.equal(await draft(), "保留这条草稿")
  if (process.platform === "darwin") {
    window.close()
    app.emit("activate")
    await until(restored, "Dock 激活恢复窗口")
  }

  /** @returns 通用设置已载入并完成绘制。 */
  async function openGeneralSettings() {
    await evaluate('document.querySelector(".sidebar-settings").click()')
    await until(() => evaluate('Boolean(document.querySelector(".settings-nav-option"))'), "设置打开")
    await evaluate(`(() => {
      const section = Array.from(document.querySelectorAll(".settings-nav-option")).find(node => node.textContent === "通用")
      section.focus()
      section.click()
    })()`)
    await until(() => evaluate('Boolean(document.querySelector(".desktop-settings-form select"))'), "通用设置加载")
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))) )")
  }
  await openGeneralSettings()
  assert.equal(await evaluate('document.querySelector(".desktop-settings-form select").value'), "tray")
  await writeFile(join("dist", "tray-settings-light.png"), (await window.capturePage()).toPNG())
  await evaluate(`(() => {
    const select = document.querySelector(".desktop-settings-form select")
    select.value = "quit"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })()`)
  const preferencePath = join(profile, ".nicode", "desktop-settings.json")
  await mkdir(preferencePath)
  const save = () => evaluate('document.querySelector(".desktop-settings-form button[type=submit]").click()')
  await save()
  await until(() => evaluate('Boolean(document.querySelector(".desktop-settings-form [role=alert]"))'), "保存失败提示")
  assert.equal((await closeSettings()).behavior, "tray")
  assert.equal(await evaluate('document.querySelector(".desktop-settings-form select").value'), "quit")
  await rmdir(preferencePath)
  await save()
  await until(async () => (await closeSettings()).behavior === "quit", "保存重试生效")
  const results = await evaluate('Promise.all([window.nicodeWindow.setCloseBehavior("tray"), window.nicodeWindow.setCloseBehavior("quit")])')
  assert.deepEqual(results.map(result => result.behavior), ["tray", "quit"], "并发请求按顺序保存")
  assert.deepEqual(JSON.parse(await readFile(preferencePath, "utf8")), { closeBehavior: "quit" })
  await evaluate('document.querySelector(".settings-dialog-close").click()')
  await until(() => evaluate('!document.querySelector(".settings-dialog")'), "设置关闭")
  await evaluate('document.querySelector(".sidebar-theme").click()')
  window.setMinimumSize(480, 600)
  window.setSize(640, 760)
  await openGeneralSettings()
  assert.equal(await evaluate('document.querySelector(".desktop-settings-form select").value'), "quit")
  assert.ok(await evaluate(`(() => {
    const panel = document.querySelector('[aria-label="通用设置"]')
    return panel.scrollWidth <= panel.clientWidth
  })()`), "窄窗口没有横向溢出")
  await writeFile(join("dist", "tray-settings-dark-narrow.png"), (await window.capturePage()).toPNG())

  window.destroy()
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  menu.items[0].click()
  const replacement = await until(() => BrowserWindow.getAllWindows().find(candidate => candidate.isVisible()), "销毁后从托盘重建")
  assert.notEqual(replacement.id, window.id)
  assert.equal(trays.length, 1)
  scenarioComplete = true
  menu.items[1].click()
  app.quit()
}

if (process.versions.electron) {
  const app = require("electron").app
  void exercise(process.argv[2], process.argv[3]).catch((error) => { console.error(error); app.exit(1) })
} else {
  void main().catch((error) => { console.error(error); process.exitCode = 1 })
}
