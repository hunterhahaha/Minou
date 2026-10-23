/** 真实 Electron/preload/React 页面：按需缓存、持久化、错误恢复、忙碌保护及布局。 */
const assert = require("node:assert/strict")
const { mkdtemp, mkdir, rm, writeFile, readFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { SkillManager } = require("../../dist/runtime/skill/src/index.js")
const { registerSkillIpcHandlers } = require("../../dist/src/main/skill-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { saveProjectWorkspace } = require("../../dist/src/main/workspace-store.js")
const { SKILL_IPC_CHANNELS, STARTUP_DATA_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")

const PROJECT = "00000000-0000-4000-8000-000000000001"
const EMPTY = "00000000-0000-4000-8000-000000000002"
const localKey = `project:${PROJECT}`, emptyKey = `project:${EMPTY}`
const reads = {}, saves = [], rendererErrors = []
let profile, paths, window, manager, releaseList, listGate, releaseSave, saveGate
let failList = false, failSave = false, failProjects = true
app.disableHardwareAcceleration()

/** @param condition 异步观察条件。 @returns 十秒内条件满足。 @throws Error 条件超时。 */
async function until(condition) {
  const deadline = Date.now() + 10000
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("技能页面验证等待超时")
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}
/** @param script 主世界表达式。 @returns 页面结果。 */
const evaluate = (script) => window.webContents.executeJavaScript(script)
/** @param selector 元素选择器。 @returns 点击结束。 @throws Error 元素不存在或禁用。 */
async function click(selector) {
  await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.matches(':disabled')) throw new Error('按钮不可用 ' + ${JSON.stringify(selector)}); node.click() })()`)
}
/** @param text 按钮完整文本。 @returns 点击结束。 */
async function clickText(text) {
  await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)}); if (!node || node.disabled) throw new Error('按钮不可用 ' + ${JSON.stringify(text)}); node.click() })()`)
}
/** @returns 当前技能请求完成，加载提示消失。 */
const idle = () => until(() => evaluate(`document.querySelector('.skill-settings')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.skill-settings')?.textContent.includes('正在加载技能')`))
/** @returns 设置已打开并查看全局技能。 */
async function openSkills() {
  await click(".sidebar-settings")
  await until(() => evaluate(`Boolean(document.querySelector('.settings-dialog'))`))
  await clickText("技能")
  await idle()
}
/** @param key 来源字典键。 @returns 作用域切换及其按需请求完成。 */
async function choose(key) {
  await evaluate(`(() => { const node = document.querySelector('[aria-label="技能作用域"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(node, ${JSON.stringify(key)}); node.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await until(() => evaluate(`document.querySelector('[aria-label="技能作用域"]').value === ${JSON.stringify(key)}`))
  await idle()
}
/** @param name 文件夹名。 @returns 开关的 CSS 选择器。 */
const toggle = (name) => `[aria-label="启用技能 ${name}"]`
/** @param name 文件夹名。 @returns 当前受控开关状态。 */
const enabled = (name) => evaluate(`document.querySelector(${JSON.stringify(toggle(name))}).checked`)
/** @param source 来源目录。 @param name 文件夹名。 @param description 描述。 @returns 夹具写入完成。 */
async function add(source, name, description) {
  await mkdir(join(source, name), { recursive: true })
  await writeFile(join(source, name, "SKILL.md"), `---\ndescription: ${JSON.stringify(description)}\n---\n正文`)
}
/** @returns 挂起请求期间导航、关闭和重复提交受到保护。 */
async function assertProtected() {
  assert.equal(await evaluate(`document.querySelector('[aria-label="关闭设置"]').disabled && document.querySelector('[aria-label="技能作用域"]').disabled && [...document.querySelectorAll('.settings-nav-option')].every(node => node.disabled)`), true)
  await evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.settings-dialog-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.querySelector('[aria-label="关闭设置"]').click() })()`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.settings-dialog'))`), true)
}

/** @returns 所有真实页面场景及截图完成。 @throws AssertionError 页面行为不符。 */
async function main() {
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  profile = await mkdtemp(join(tmpdir(), "nicode-electron-skill-"))
  app.setPath("userData", join(profile, "electron-user-data"))
  paths = await initializeConfigFiles(profile)
  for (const [id, name] of [[PROJECT, "测试项目"], [EMPTY, "空技能项目"]]) {
    saveProjectWorkspace(paths.workspaceDatabasePath, { version: 1, id, name, updatedAt: new Date().toISOString(), directories: [], sessions: [] })
    await mkdir(join(paths.rootDir, "sessions", id, "workspace"), { recursive: true })
  }
  const global = join(paths.rootDir, "skills")
  await add(global, "review", "全局完整描述".repeat(500))
  await add(global, "long-name-".repeat(10), "长路径和名称应当在较窄窗口中换行。")
  await mkdir(join(global, "broken"))
  await add(join(paths.rootDir, "sessions", PROJECT, "skills"), "review", "项目自己的描述")
  manager = new SkillManager(paths.rootDir, () => 1)
  /** 只在测试中统计和挂起真实 handler，仍使用真实文件持久化。 */
  const trackedIpc = { handle(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (channel === STARTUP_DATA_IPC_CHANNELS.listProjects && failProjects) { failProjects = false; throw new Error("注入项目加载失败") }
      if (channel === SKILL_IPC_CHANNELS.listSkills) {
        const target = args[0], key = target.scope === "global" ? "global" : `project:${target.projectId}`
        reads[key] = (reads[key] ?? 0) + 1
        await listGate
        if (failList) { failList = false; throw new Error("注入列表加载失败") }
      }
      if (channel === SKILL_IPC_CHANNELS.setSkillEnabled) {
        saves.push(args)
        await saveGate
        if (failSave) { failSave = false; throw new Error("注入保存失败") }
      }
      return handler(event, ...args)
    })
  } }
  registerStartupDataIpcHandlers(trackedIpc, paths)
  registerSkillIpcHandlers(trackedIpc, paths, manager)
  await app.whenReady()
  window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: {
    preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } })
  window.webContents.on("console-message", (details) => { if (details.level === "error") rendererErrors.push(details.message) })
  await window.loadFile(join(process.cwd(), "dist/src/renderer/index.html"))
  await until(() => evaluate(`Boolean(document.querySelector('.sidebar-settings'))`))
  assert.deepEqual(reads, {}, "启动不请求技能")
  await click(".sidebar-settings")
  await until(() => evaluate(`Boolean(document.querySelector('.settings-dialog'))`))
  assert.deepEqual(reads, {}, "打开模型设置不请求技能")
  await clickText("技能"); await idle()
  assert.deepEqual(reads, { global: 1 })
  assert.equal(await evaluate(`document.querySelectorAll('.skill-entry').length`), 3)
  assert.equal(await evaluate(`document.querySelector('.skill-settings').textContent.includes('项目列表加载失败')`), true)
  assert.equal(await evaluate(`[...document.querySelectorAll('.skill-description')].some(node => node.textContent === ${JSON.stringify("全局完整描述".repeat(500))})`), true)
  await clickText("重试项目列表")
  await until(() => evaluate(`document.querySelectorAll('[aria-label="技能作用域"] option').length === 3`))
  assert.deepEqual(reads, { global: 1 }, "重试项目摘要不读取技能")

  await click(toggle("broken")); await idle()
  assert.equal(await enabled("broken"), false, "损坏描述仍允许禁用")
  listGate = new Promise((resolve) => { releaseList = resolve })
  await click('[aria-label="刷新技能"]')
  await until(() => reads.global === 2)
  await assertProtected()
  releaseList(); listGate = undefined; await idle()

  saveGate = new Promise((resolve) => { releaseSave = resolve })
  const beforeSave = saves.length
  await click(toggle("review"))
  await until(() => saves.length === beforeSave + 1)
  await assertProtected()
  assert.equal(await enabled("review"), true, "保存确认前不改变开关")
  await evaluate(`document.querySelector(${JSON.stringify(toggle("review"))}).click()`)
  assert.equal(saves.length, beforeSave + 1, "挂起期间重复点击不会提交")
  releaseSave(); saveGate = undefined; await idle()
  assert.equal(await enabled("review"), false)
  await assert.rejects(manager.loadSkill("default", "review"), { code: "SKILL_DISABLED" })
  const persisted = JSON.parse(await readFile(join(global, "registry.json"), "utf8"))
  assert.equal(persisted.skills.find((entry) => entry.name === "review").enabled, false)
  failSave = true
  await click(toggle("review")); await idle()
  assert.equal(await enabled("review"), false)
  assert.equal(await evaluate(`document.querySelector('.skill-settings').textContent.includes('注入保存失败')`), true)
  await click(toggle("review")); await idle()
  assert.equal(await enabled("review"), true)

  await choose(localKey)
  assert.equal(reads[localKey], 1)
  assert.equal(await evaluate(`document.querySelectorAll('.skill-entry').length`), 1, "项目页不混入全局来源")
  assert.equal(await evaluate(`document.querySelector('.skill-description').textContent`), "项目自己的描述")
  await evaluate(`document.querySelector(${JSON.stringify(toggle("review"))}).focus()`)
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" })
  await until(() => saves.at(-1)?.[0].scope === "project")
  await idle()
  assert.equal(await enabled("review"), false, "键盘可以操作启停")
  assert.equal((await manager.loadSkill("default", "review")).scope, "global")
  await assert.rejects(manager.loadSkill(PROJECT, "review"), { code: "SKILL_DISABLED" })
  await choose(emptyKey)
  assert.equal(reads[emptyKey], 1)
  assert.equal(await evaluate(`document.querySelectorAll('.skill-entry').length`), 0)
  await choose(localKey); await choose(emptyKey)
  assert.deepEqual(reads, { global: 2, [localKey]: 1, [emptyKey]: 1 }, "包括空列表在内的缓存命中不查询")

  await click('[aria-label="关闭设置"]')
  await evaluate(`location.hash = '#/projects/${PROJECT}/new-chat'`)
  await openSkills()
  assert.equal(reads.global, 2, "关闭重开及路由变化保留缓存")
  await choose(localKey)
  assert.equal(await enabled("review"), false)
  await choose("global")
  failList = true
  await click('[aria-label="刷新技能"]'); await idle()
  assert.equal(reads.global, 3)
  assert.equal(await evaluate(`document.querySelectorAll('.skill-entry').length`), 3, "刷新失败保留旧列表")
  await click('[aria-label="关闭设置"]'); await openSkills()
  assert.equal(reads.global, 3, "失败不自动重试")
  await click('[aria-label="重试加载技能"]'); await idle()
  assert.equal(reads.global, 4)
  assert.equal(reads[localKey], 1, "刷新全局不请求项目")
  await add(global, "new-folder", "手动刷新才会出现")
  assert.equal(await evaluate(`document.querySelectorAll('.skill-entry').length`), 3)
  await click('[aria-label="刷新技能"]'); await idle()
  assert.equal(await evaluate(`document.querySelectorAll('.skill-entry').length`), 4)
  assert.equal(reads.global, 5)

  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await writeFile(join(process.cwd(), "dist/skill-settings-wide.png"), (await window.webContents.capturePage()).toPNG())
  window.setContentSize(420, 680)
  await until(() => evaluate(`innerWidth === 420`))
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.equal(await evaluate(`(() => { const panel = document.querySelector('[aria-label="技能设置"]'); return panel.scrollWidth <= panel.clientWidth + 1 && [...document.querySelectorAll('.skill-entry')].every(node => node.scrollWidth <= node.clientWidth + 1) })()`), true, "窄窗口内容不横向溢出")
  await writeFile(join(process.cwd(), "dist/skill-settings-narrow.png"), (await window.webContents.capturePage()).toPNG())
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await until(() => evaluate(`!document.querySelector('.settings-dialog')`))
  assert.equal(await evaluate(`typeof require === 'undefined' && typeof window.nicode.listSkills === 'function'`), true)
  assert.ok(rendererErrors.every((message) => message.includes("加载项目列表失败")), JSON.stringify(rendererErrors))
  console.log("electron-skill-settings: 按需请求计数、持久缓存、作用域隔离、启停确认、错误重试、忙碌保护、键盘及窄窗口通过")
}

void main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  releaseList?.(); releaseSave?.()
  if (window && !window.isDestroyed()) window.destroy()
  if (profile) {
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true })
  }
  app.exit(process.exitCode ?? 0)
})
