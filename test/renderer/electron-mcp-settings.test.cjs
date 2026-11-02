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
const compatibleDefinitions = [
  { name: "Protocol fixture", protocol: "responses", url: "https://fixture.example/responses",
    models: [{ supportsReasoning: true, name: "responses-fixture", contextWindow: 64000, maxOutputTokens: 8192,
      reasoningLevels: ["medium"], reasoningField: { path: ["reasoning", "effort"] } }] },
  { name: "Protocol fixture", protocol: "chat_completions", url: "https://fixture.example/chat",
    models: [{ supportsReasoning: true, name: "chat-fixture", contextWindow: 32000, maxOutputTokens: 4096,
      reasoningLevels: ["medium"], reasoningField: { path: ["reasoning_effort"] } }] },
  { name: "Messages fixture", protocol: "anthropic_messages", url: "https://fixture.example/messages",
    models: [{ supportsReasoning: true, name: "messages-fixture", contextWindow: 64000, maxOutputTokens: 8192,
      reasoningLevels: ["medium"], reasoningField: { path: ["output_config", "effort"] } }] },
]
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
/**
 * 等待 React 提交后的两帧完成合成，再保存当前界面，避免截图保留上一页。
 * @param name dist 中的 PNG 文件名。
 * @returns 截图写入完成。
 */
async function screenshot(name) {
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  await writeFile(join(process.cwd(), "dist", name), (await window.webContents.capturePage()).toPNG())
}
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
  registerModelIpcHandlers(ipcMain, paths, compatibleDefinitions)
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
  await type("供应商协议", "responses")
  await input('.provider-create-form input[type="url"]', "http://127.0.0.1/v1")
  await input('.provider-create-form input[type="password"]', "fixture-only")
  if (!await evaluate(`Boolean(document.querySelector('.create-model-row'))`)) await clickText("添加模型")
  await input('.create-model-row input[placeholder="例如：gpt-4.1"]', "offline-model")
  await type("推理等级 1", "eco")
  await type("推理等级 2", "max")
  await click('[aria-label="移除推理等级 3"]')
  await type("推理等级 2", "eco")
  assert.equal(await evaluate("document.querySelector('.provider-create-form button[type=\"submit\"]').disabled"), true, "逐项等级拒绝重复值")
  await type("推理等级 2", "")
  assert.equal(await evaluate("document.querySelector('.provider-create-form button[type=\"submit\"]').disabled"), true, "逐项等级拒绝空项")
  await type("推理等级 2", "max")
  await type("推理字段路径", "custom.effort")
  await click('.create-model-row .model-disclosure > summary')
  assert.equal(await evaluate("document.querySelector('.create-model-row details').open"), false)
  await click('.create-model-row .model-disclosure > summary')
  assert.equal(await evaluate("document.querySelector('[aria-label=\"推理等级 1\"]').value"), "eco", "折叠后草稿仍保留")
  window.webContents.focus()
  await evaluate("document.querySelector('[aria-label=\"推理等级说明\"]').focus()")
  await until(() => evaluate("Boolean(document.querySelector('.field-help-tooltip:popover-open'))"))
  assert.equal(await evaluate("document.querySelector('.field-help-tooltip:popover-open').textContent.includes('从低到高')"), true)
  await evaluate("document.querySelector('[aria-label=\"推理等级说明\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  assert.equal(await evaluate("document.querySelector('.field-help-tooltip').matches(':popover-open')"), false)
  assert.equal(await evaluate("Boolean(document.querySelector('.settings-dialog'))"), true, "Escape 先关闭字段帮助")
  await evaluate("document.activeElement.blur(); document.querySelector('[aria-label=\"推理等级说明\"]').scrollIntoView({ block: 'center' })")
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  window.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 })
  await evaluate("new Promise(done => requestAnimationFrame(done))")
  const helpPoint = await evaluate("(() => { const rect = document.querySelector('[aria-label=\"推理等级说明\"]').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  assert.equal(await evaluate(`Boolean(document.elementFromPoint(${helpPoint.x}, ${helpPoint.y})?.closest('.field-help-button'))`), true, "滚动后帮助图标可接收悬浮事件")
  window.webContents.sendInputEvent({ type: "mouseMove", ...helpPoint })
  await until(() => evaluate("Boolean(document.querySelector('.field-help-tooltip:popover-open'))"))
  await screenshot("provider-field-help.png")
  window.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 })
  await until(() => evaluate("!document.querySelector('.field-help-tooltip:popover-open')"))
  await evaluate("document.querySelector('.create-model-row .reasoning-preview').open = true")
  assert.equal(await evaluate("document.querySelector('.create-model-row .reasoning-preview').textContent.includes('custom')"), true)
  await screenshot("provider-form-wide.png")
  await click('.provider-create-form button[type="submit"]')
  await until(() => evaluate(`document.querySelector('.provider-detail h3')?.textContent === '本机模型设置回归'`))
  assert.equal(listProviders(paths.providerDatabasePath).length, 1)
  assert.deepEqual(listProviders(paths.providerDatabasePath)[0].models[0].reasoningLevels, ["eco", "max"])
  assert.deepEqual(listProviders(paths.providerDatabasePath)[0].models[0].reasoningField, { path: ["custom", "effort"] })
  assert.equal(await evaluate("document.querySelector('.provider-model-editor details').open"), false, "已保存模型详情默认收起")
  await click('.provider-model-editor .model-disclosure > summary')
  await type("推理等级 1", "low")
  await type("推理等级 2", "medium")
  await click('[aria-label="添加推理等级"]')
  await type("推理等级 3", "high")
  await type("编辑推理字段路径", "reasoning.effort")
  await clickText("保存推理配置")
  await until(() => listProviders(paths.providerDatabasePath)[0].models[0].reasoningLevels.includes("medium"))
  assert.deepEqual(listProviders(paths.providerDatabasePath)[0].models[0].reasoningField, { path: ["reasoning", "effort"] })
  await screenshot("provider-model-expanded.png")
  await clickText("新建模型")
  await until(() => evaluate("Boolean(document.querySelector('.new-model-dialog'))"))
  await input('.new-model-dialog input[placeholder="例如：gpt-4.1"]', "defaults-model")
  await click('.new-model-dialog [aria-label="移除推理等级 3"]')
  await click('.new-model-dialog [aria-label="移除推理等级 2"]')
  await click('.new-model-dialog [aria-label="移除推理等级 1"]')
  window.setSize(640, 800)
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  assert.equal(await evaluate("document.querySelector('.new-model-dialog').scrollWidth <= document.querySelector('.new-model-dialog').clientWidth"), true)
  await screenshot("provider-new-model-narrow.png")
  await click('.new-model-dialog button[type="submit"]')
  await until(() => listProviders(paths.providerDatabasePath)[0].models.length === 2)
  assert.deepEqual(listProviders(paths.providerDatabasePath)[0].models[1].reasoningLevels, ["low", "medium", "high"], "新建模型空列表由主进程补入默认等级")
  assert.deepEqual(listProviders(paths.providerDatabasePath)[0].models[1].reasoningField, { path: ["reasoning", "effort"] })
  window.setSize(1200, 900)
  await click('[aria-label="新增供应商"]')
  await until(() => evaluate("Boolean(document.querySelector('.provider-create-form'))"))
  assert.deepEqual(await evaluate("window.nicode.listCompatibleProviders()"), [
    { name: "Protocol fixture", protocol: ["responses", "chat_completions"] },
    { name: "Messages fixture", protocol: ["anthropic_messages"] },
  ], "列表中每个供应商名称只返回一项，协议使用数组")
  assert.deepEqual(await evaluate("[...document.querySelector('[aria-label=\"供应商\"]').options].map(option => option.textContent)"),
    ["自定义", "Protocol fixture", "Messages fixture"], "已兼容供应商与自定义直接显示在同一个列表")
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"已兼容供应商\"], [aria-label=\"供应商类型\"]').length"), 0)
  await type("供应商", "compatible:Protocol fixture")
  assert.deepEqual(await evaluate("[...document.querySelector('[aria-label=\"供应商协议\"]').options].map(option => option.value).filter(Boolean)"),
    ["responses", "chat_completions"], "只展示选定供应商兼容的协议")
  await type("供应商协议", "responses")
  await type("供应商", "compatible:Messages fixture")
  await until(() => evaluate("document.querySelector('[aria-label=\"供应商协议\"]').value === '' && document.querySelector('.provider-create-form button[type=\"submit\"]').disabled"))
  assert.deepEqual(await evaluate("[...document.querySelector('[aria-label=\"供应商协议\"]').options].map(option => option.value).filter(Boolean)"),
    ["anthropic_messages"], "切换供应商会清除不兼容的旧协议")
  await type("供应商协议", "anthropic_messages")
  await type("供应商", "custom")
  assert.equal(await evaluate("document.querySelector('[aria-label=\"供应商协议\"]').options.length"), 4, "自定义供应商保留三种协议")
  await type("供应商", "compatible:Messages fixture")
  assert.equal(await evaluate("document.querySelector('[aria-label=\"供应商协议\"]').value"), "anthropic_messages", "切换回来时保留仍受支持的协议")
  await type("供应商", "compatible:Protocol fixture")
  await type("供应商协议", "chat_completions")
  await input('.provider-create-form input[type="password"]', "fixture-only")
  await click('.provider-create-form button[type="submit"]')
  await until(() => evaluate("document.querySelector('.provider-detail h3')?.textContent === 'Protocol fixture'"))
  const compatible = listProviders(paths.providerDatabasePath).find(entry => entry.name === "Protocol fixture")
  assert.equal(compatible.type, "compatible")
  assert.equal(compatible.protocol, "chat_completions")
  assert.equal(compatible.baseURL, "https://fixture.example/chat")
  assert.equal(compatible.models[0].name, "chat-fixture")
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
