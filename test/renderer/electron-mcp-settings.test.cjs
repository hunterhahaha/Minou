/** 使用真实 Electron、preload、React、配置文件和 MCPManager 验证设置页面。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { createServer } = require("node:http")
const { app, BrowserWindow, ipcMain } = require("electron")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { initializeConfigFiles, readConfigFile } = require("../../dist/src/main/config-files.js")
const { MCPManager } = require("../../dist/runtime/mcp/src/manager.js")
const { registerMcpIpcHandlers } = require("../../dist/src/main/mcp-ipc.js")
const { registerModelIpcHandlers } = require("../../dist/src/main/provider-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { listProviders } = require("../../dist/src/main/provider-store.js")
let window, profile, paths, http, releaseList, listGate
let starts = 0, lists = 0
const headers = [], rendererErrors = []
const manager = new MCPManager(() => 1)
app.disableHardwareAcceleration()

/** @param condition 异步观察条件。 @returns 十秒内满足条件。 @throws Error 观察超时。 */
async function until(condition) {
  const deadline = Date.now() + 10000
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("MCP 页面验证等待超时")
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}
/** @param script Renderer 主世界中的表达式。 @returns 页面返回值。 */
const evaluate = (script) => window.webContents.executeJavaScript(script)
/** @param selector 元素选择器。 @param value 输入值。 @returns React 输入处理完成。 */
async function input(selector, value) {
  await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) throw new Error('missing input: ' + ${JSON.stringify(selector)})
    const proto = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)})
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })()`)
}
/** @param label aria-label。 @param value 输入内容。 @returns 已提交输入事件。 */
const type = (label, value) => input(`[aria-label="${label}"]`, value)
/** @param selector 按钮选择器。 @returns 已点击可用按钮。 */
async function click(selector) {
  await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node || node.matches(':disabled')) throw new Error('unavailable button: ' + ${JSON.stringify(selector)})
    node.click()
  })()`)
}
/** @param text 按钮完整文本。 @returns 已点击匹配的可用按钮。 */
async function clickText(text) {
  await evaluate(`(() => {
    const node = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})
    if (!node || node.matches(':disabled')) throw new Error('unavailable text button: ' + ${JSON.stringify(text)})
    node.click()
  })()`)
}
/** @returns MCP 页面请求完成。 */
const idle = () => until(() => evaluate(`document.querySelector('.mcp-settings')?.getAttribute('aria-busy') === 'false'`))
/** @returns 保存操作已结束。 */
async function save() { await click('[aria-label="保存 MCP"]'); await idle() }
/** @returns 已打开 MCP 设置并读取列表。 */
async function openMcp() {
  await click('.sidebar-settings')
  await until(() => evaluate(`Boolean(document.querySelector('.settings-dialog'))`))
  await clickText("MCP")
  await idle()
}

/** @returns 真实页面的配置、状态同步、恢复和回归场景完成。 */
async function main() {
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  profile = await mkdtemp(join(tmpdir(), "nicode-electron-mcp-"))
  app.setPath("userData", join(profile, "electron-user-data"))
  paths = await initializeConfigFiles(profile)
  await manager.initialize([])
  /** 仅本机 JSON-RPC 夹具；无会话和 SSE，不持有任何真实凭据。 */
  http = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") { response.writeHead(405); response.end(); return }
      const chunks = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const message = JSON.parse(Buffer.concat(chunks).toString())
      headers.push({ ...request.headers })
      if (message.id === undefined) { response.writeHead(202); response.end(); return }
      let result = {}
      if (message.method === "initialize") { starts++; result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ui-fixture", version: "1" } } }
      if (message.method === "tools/list") {
        lists++
        await listGate
        result = { tools: [{ name: "sample", description: "UI fixture", inputSchema: { type: "object", properties: {} } }] }
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${http.address().port}/mcp`
  await app.whenReady()
  registerMcpIpcHandlers(ipcMain, paths, manager)
  registerStartupDataIpcHandlers(ipcMain, paths)
  registerModelIpcHandlers(ipcMain, paths)
  window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: {
    preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } })
  window.webContents.on("console-message", (details) => { if (details.level === "error") rendererErrors.push(details.message) })
  await window.loadFile(join(process.cwd(), "dist/src/renderer/index.html"))
  await until(() => evaluate(`Boolean(document.querySelector('.sidebar-settings'))`))
  await openMcp()
  await type("MCP 名称", "local")
  await type("MCP 启动命令", "node")
  await type("MCP 工作目录", profile)
  for (const value of ["--experimental-strip-types", resolve("runtime/mcp/test/stdio-server.ts"), " a b ", ""]) {
    await clickText("添加参数")
    const count = await evaluate(`document.querySelectorAll('.mcp-value-row').length`)
    await type(`启动参数 ${count}`, value)
  }
  for (const [index, [key, value]] of [["MCP_EXPLICIT", " value "], ["EMPTY", ""]].entries()) {
    await clickText("添加环境变量")
    await type(`环境变量 ${index + 1} 名称`, key); await type(`环境变量 ${index + 1} 值`, value)
  }
  await click('[aria-label="启用 MCP"]')
  await save()
  let config = (await readConfigFile(paths.configPath)).mcpServers[0]
  assert.deepEqual(config.args.slice(-2), [" a b ", ""])
  assert.deepEqual(config.env, { MCP_EXPLICIT: " value ", EMPTY: "" })
  await click('[aria-label="关闭设置"]')
  await openMcp()
  assert.equal(await evaluate(`document.querySelector('[aria-label="启动参数 3"]').value`), " a b ")
  await type("MCP 名称", "local-renamed")
  await click('[aria-label="启用 MCP"]')
  await save()
  assert.equal(manager.getConnectionStates().find((state) => state.name === "local-renamed").status, "connected")
  assert.equal(manager.getConnectionStates().some((state) => state.name === "local"), false)

  await click('[aria-label="新增 MCP"]')
  await type("MCP 名称", "remote")
  await type("MCP 传输类型", "streamable-http")
  await type("MCP URL", url)
  await type("MCP 启动超时", "1")
  for (const [index, key] of ["X-One", "X-Two"].entries()) {
    await clickText("添加请求头"); await type(`请求头 ${index + 1} 名称`, key); await type(`请求头 ${index + 1} 值`, `value-${index}`)
  }
  await save()
  assert.equal(manager.getConnectionStates().find((state) => state.name === "remote").status, "connected")
  assert.ok(headers.some((entry) => entry["x-one"] === "value-0" && entry["x-two"] === "value-1"))
  await type("MCP 名称", "local-renamed")
  assert.equal(await evaluate(`document.querySelector('[aria-label="保存 MCP"]').disabled`), true)
  await type("MCP 名称", "remote")
  await clickText("添加请求头"); await type("请求头 3 名称", "x-one")
  assert.equal(await evaluate(`document.querySelector('[aria-label="保存 MCP"]').disabled`), true)
  await type("请求头 3 名称", "Authorization")
  await type("MCP Bearer 环境变量名", "NOT_A_REAL_TOKEN")
  assert.equal(await evaluate(`document.querySelector('[aria-label="保存 MCP"]').disabled`), true)
  await click('[aria-label="删除请求头 3"]'); await type("MCP Bearer 环境变量名", "")
  await type("MCP 工具超时", "0")
  assert.equal(await evaluate(`document.querySelector('[aria-label="保存 MCP"]').disabled`), true)
  await type("MCP 工具超时", "2")

  const beforeLists = lists
  listGate = new Promise((resolve) => { releaseList = resolve })
  await click('[aria-label="保存 MCP"]')
  await until(() => lists > beforeLists)
  assert.deepEqual(await evaluate(`({ close: document.querySelector('[aria-label="关闭设置"]').disabled,
    refresh: document.querySelector('[aria-label="刷新 MCP"]').disabled,
    nav: [...document.querySelectorAll('.settings-dialog-nav button')].every(node => node.disabled),
    save: document.querySelector('[aria-label="保存 MCP"]').matches(':disabled') })`), { close: true, refresh: true, nav: true, save: true })
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.settings-dialog'))`), true)
  releaseList(); listGate = undefined
  await idle()
  const beforeRefresh = starts
  await click('[aria-label="刷新 MCP"]'); await idle()
  assert.equal(starts, beforeRefresh + 1)
  await type("MCP URL", "http://127.0.0.1:1/mcp")
  await save()
  assert.equal((await readConfigFile(paths.configPath)).mcpServers.find((entry) => entry.name === "remote").url, "http://127.0.0.1:1/mcp")
  assert.equal(await evaluate(`document.querySelector('.mcp-connection-state').textContent.includes('配置已保存')`), true)
  await type("MCP URL", url); await save()
  assert.equal(manager.getConnectionStates().find((state) => state.name === "remote").status, "connected")

  const validFile = await readFile(paths.configPath, "utf8")
  await writeFile(paths.configPath, "{broken")
  await type("MCP 名称", "unsaved-name"); await save()
  assert.equal(await evaluate(`document.querySelector('[aria-label="MCP 名称"]').value`), "unsaved-name")
  assert.equal(await readFile(paths.configPath, "utf8"), "{broken")
  await writeFile(paths.configPath, validFile)
  await clickText("取消修改")
  assert.equal(await evaluate(`document.querySelector('[aria-label="MCP 名称"]').value`), "remote")

  await click('[aria-label="删除请求头 2"]'); await click('[aria-label="删除请求头 1"]')
  await type("MCP 工具超时", ""); await type("MCP 启动超时", ""); await save()
  config = (await readConfigFile(paths.configPath)).mcpServers.find((entry) => entry.name === "remote")
  assert.equal(config.http_headers, undefined); assert.equal(config.tool_timeout_sec, undefined)
  await type("MCP 传输类型", "stdio"); await type("MCP 启动命令", "node")
  await click('[aria-label="启用 MCP"]'); await save()
  config = (await readConfigFile(paths.configPath)).mcpServers.find((entry) => entry.name === "remote")
  assert.equal(config.transport, "stdio"); assert.equal(config.url, undefined)
  await type("MCP 传输类型", "streamable-http"); await type("MCP URL", url)
  await click('[aria-label="启用 MCP"]'); await save()
  await clickText("添加请求头"); await type("请求头 1 名称", "X-Preview"); await type("请求头 1 值", "example")
  await save()
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await writeFile(join(process.cwd(), "dist/electron-mcp-settings-preview.png"), (await window.webContents.capturePage()).toPNG())
  window.setSize(640, 800)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.equal(await evaluate(`document.querySelector('.settings-dialog').scrollWidth <= document.querySelector('.settings-dialog').clientWidth`), true)
  await writeFile(join(process.cwd(), "dist/electron-mcp-settings-narrow-preview.png"), (await window.webContents.capturePage()).toPNG())
  window.setSize(1200, 900)

  await clickText("模型")
  await until(() => evaluate(`Boolean(document.querySelector('.provider-create-form'))`))
  await input('.provider-create-form input[placeholder="例如：OpenAI"]', "本机模型设置回归")
  await input('.provider-create-form select:not([aria-label=\"供应商类型\"])', "responses")
  await input('.provider-create-form input[type="url"]', "http://127.0.0.1/v1")
  await input('.provider-create-form input[type="password"]', "fixture-only")
  if (!await evaluate(`Boolean(document.querySelector('.create-model-row'))`)) await clickText("添加模型")
  await input('.create-model-row input[placeholder="例如：gpt-4.1"]', "offline-model")
  await type("推理等级", "eco, max")
  await type("推理字段路径", "custom.effort")
  assert.equal(await evaluate("document.querySelector('.create-model-row .reasoning-preview').textContent.includes('custom')"), true)
  await click('.provider-create-form button[type="submit"]')
  await until(() => evaluate(`document.querySelector('.provider-detail h3')?.textContent === '本机模型设置回归'`))
  assert.equal(listProviders(paths.providerDatabasePath).length, 1)
  assert.deepEqual(listProviders(paths.providerDatabasePath)[0].models[0].reasoningLevels, ["eco", "max"])
  assert.deepEqual(listProviders(paths.providerDatabasePath)[0].models[0].reasoningField, { path: ["custom", "effort"] })
  await type("编辑推理等级", "low, medium, high")
  await type("编辑推理字段路径", "reasoning.effort")
  await clickText("保存推理配置")
  await until(() => listProviders(paths.providerDatabasePath)[0].models[0].reasoningLevels.includes("medium"))
  assert.deepEqual(listProviders(paths.providerDatabasePath)[0].models[0].reasoningField, { path: ["reasoning", "effort"] })
  await clickText("MCP"); await idle()
  await evaluate(`(() => { [...document.querySelectorAll('.mcp-sidebar button')].find(node => node.querySelector('.provider-list-name')?.textContent === 'remote').click() })()`)
  await click('[aria-label="删除 MCP"]'); await idle()
  assert.equal(manager.getConnectionStates().some((state) => state.name === "remote"), false)
  await click('[aria-label="删除 MCP"]'); await idle()
  assert.deepEqual((await readConfigFile(paths.configPath)).mcpServers, [])
  assert.deepEqual(manager.listTools(), [])
  assert.equal(await evaluate(`typeof require === 'undefined' && typeof window.nicode.reloadMcpServers === 'function'`), true)
  assert.deepEqual(rendererErrors, [])
  console.log("electron-mcp-settings.test.cjs: 双传输、多值、持久化、启用/改名/删除、刷新、失败恢复、忙碌保护、窄窗口及模型设置回归通过")
}

void main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  releaseList?.()
  if (window && !window.isDestroyed()) window.destroy()
  await manager.dispose()
  if (http) { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)) }
  if (profile) {
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true })
  }
  app.exit(process.exitCode ?? 0)
})
