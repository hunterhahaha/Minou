/** 真实 Electron 页面验证抓取工具的通用卡片与 Markdown 原文展示。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep, dirname } = require("node:path")
const { createServer } = require("node:http")
const { app, BrowserWindow, ipcMain } = require("electron")
const { initializeConfigFilesSnapshot } = require("../../dist/src/main/config-files.js")
const { SessionRuntimeGlobal } = require("../../dist/src/main/session-runtime-global.js")
const { SessionRuntime } = require("../../dist/runtime/agent/src/session-runtime.js")
const { registerWebFetchTool, ToolRegistry, RenderRegistry, WEB_FETCH_MAX_BYTES } = require("../../dist/runtime/tools/src/index.js")
const { registerSessionIpcHandlers } = require("../../dist/src/main/session-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { TagManager } = require("../../dist/src/main/tag-manager.js")
const { SESSION_IPC_CHANNELS: channels, STARTUP_DATA_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")
let window, profile, global, server, failed = false
const sessions = []
app.on("window-all-closed", () => {})
/** @param script 页面中执行的 DOM 操作。 @returns 页面执行结果。 */
const evaluate = (script) => window.webContents.executeJavaScript(script)
/** @param script 页面中的等待条件。 @returns 条件在十秒内成立。 */
async function until(script) {
  const deadline = Date.now() + 10000
  while (!(await evaluate(script))) {
    if (Date.now() > deadline) throw new Error("抓取工具页面验证等待超时: " + script + "\n" + await evaluate("document.body.innerText"))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
/** @returns 真实抓取、IPC 与页面断言完成，并保存截图供检查。 */
async function main() {
  profile = await mkdtemp(join(tmpdir(), "minou-fetch-ui-"))
  app.setPath("userData", join(profile, "electron"))
  const { paths } = await initializeConfigFilesSnapshot(profile)
  await app.whenReady()
  server = createServer((request, response) => {
    if (request.url === "/large") {
      response.writeHead(200, { "Content-Length": WEB_FETCH_MAX_BYTES + 1 })
      response.flushHeaders()
    } else if (request.url === "/truncated") {
      response.setHeader("Content-Type", "text/plain")
      response.end("Fetched **full** content\n".repeat(3000))
    } else {
      response.setHeader("Content-Type", "text/html")
      response.end("<p>Fetched <strong>Markdown</strong> content</p>")
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const tools = new ToolRegistry(), renders = new RenderRegistry()
  registerWebFetchTool(tools, renders)
  global = new SessionRuntimeGlobal(paths, tools, renders)
  global.createTurnModelAdapter = async () => {
    let step = 0
    return { contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (_request, _signal, options) {
      if (options?.timeoutMs !== undefined) return
      step++
      if (step <= 3) {
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: `fetch-${step}`, name: "web_fetch", arguments: { url: endpoint + (step === 1 ? "/page" : step === 2 ? "/large" : "/truncated") } } }
        yield { type: "stream_end", completion: "tool_calls" }
      } else {
        yield { type: "block_start", index: 0, blockType: "text" }
        yield { type: "block_end", index: 0, block: { type: "text", text: "抓取验证完成" } }
        yield { type: "stream_end", completion: "finished" }
      }
    } }
  }
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  registerStartupDataIpcHandlers(ipcMain, paths)
  ipcMain.removeHandler(STARTUP_DATA_IPC_CHANNELS.listProviders)
  ipcMain.handle(STARTUP_DATA_IPC_CHANNELS.listProviders, () => [{ providerId: "p", name: "测试", type: "custom", protocol: "chat_completions", models: [{ modelId: "m", name: "本地模型", isDefault: true, contextWindow: 128000, maxOutputTokens: 4096, supportsReasoning: false, reasoningLevels: ["low", "medium", "high"], reasoningField: { path: ["reasoning", "effort"] } }] }])
  registerSessionIpcHandlers(ipcMain, (projectId, sessionId, onStateChanged) => {
    const session = new SessionRuntime({ sessionId, projectGroupId: projectId, sessionDirectory: join(paths.rootDir, "sessions", projectId, sessionId), databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, global, systemPrompt: "test", onStateChanged })
    sessions.push(session)
    return session
  }, (error) => { throw new Error(JSON.stringify(error)) }, { sendSessionUpdateToRenderer: (update) => {
    if (window && !window.isDestroyed()) window.webContents.send(channels.update, update)
  } }, paths)
  window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
  new TagManager(ipcMain).register(window)
  await window.loadFile(join(process.cwd(), "dist/src/renderer/index.html"))
  await until('document.querySelector(\'.composer-editor[aria-label="任务描述"]\') !== null')
  await evaluate(`(() => {
    const node = document.querySelector('.composer-editor[aria-label="任务描述"]')
    node.focus()
    window.getSelection().selectAllChildren(node)
    document.execCommand('insertText', false, '抓取网页')
  })()`)
  await until('document.querySelector(\'[aria-label="发送消息"]\')?.disabled === false')
  await evaluate('document.querySelector(\'[aria-label="发送消息"]\').click()')
  await until("document.querySelectorAll('.tool-detail').length === 3 && document.body.textContent.includes('抓取验证完成')")
  await until("document.querySelector('.turn-process') !== null && document.querySelector('.session-phase')?.textContent === '准备就绪'")
  await evaluate("document.querySelectorAll('.turn-process, .tool-detail').forEach(node => { node.open = true })")
  const cards = await evaluate(`Array.from(document.querySelectorAll('.tool-detail'), node => ({ summary: node.querySelector('summary').textContent, text: node.querySelector('.tool-result-content').textContent, error: node.querySelector('.chat-error')?.textContent, rich: !!node.querySelector('.tool-result-content strong') }))`)
  assert.match(cards[0].summary, /web_fetch.*完成/)
  assert.equal(cards[0].text, "Fetched **Markdown** content")
  assert.equal(cards[0].rich, false)
  assert.match(cards[1].summary, /web_fetch.*失败/)
  assert.match(cards[1].error, /超过 5 MiB/)
  assert.match(cards[2].summary, /web_fetch.*完成/)
  assert.match(cards[2].text, /\n…\n\n\[Output truncated:/)
  assert.equal(cards[2].rich, false)
  const outputPath = /Full output saved to:\n([^\n]+)/.exec(cards[2].text)?.[1]
  assert.ok(outputPath)
  assert.equal(dirname(outputPath), join(paths.rootDir, "sessions", "default", sessions[0].sessionId, "tool_output"))
  assert.equal(await readFile(outputPath, "utf8"), "Fetched **full** content\n".repeat(3000))
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(process.cwd(), "dist/web-fetch-renderer.png"), (await window.webContents.capturePage()).toPNG())
  await evaluate("document.querySelectorAll('.tool-result-content')[2].scrollIntoView({ block: 'end' })")
  await evaluate("document.querySelectorAll('.tool-result-content')[2].scrollTop = document.querySelectorAll('.tool-result-content')[2].scrollHeight")
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  assert.equal(await evaluate("document.querySelector('.turn-process').open && document.querySelectorAll('.tool-detail')[2].open"), true)
  await writeFile(join(process.cwd(), "dist/web-fetch-truncated-renderer.png"), (await window.webContents.capturePage()).toPNG())
  console.log("electron-web-fetch: 实际抓取、普通/截断/失败工具卡片、末尾说明与全文路径展示通过")
}
void main().catch((error) => { console.error(error); failed = true }).finally(async () => {
  try {
    for (const session of sessions) session.close()
    await global?.disposeProcessTools()
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
    if (window && !window.isDestroyed()) window.destroy()
    if (profile) {
      assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
      await rm(profile, { recursive: true, force: true })
    }
  } catch (error) {
    if (["EBUSY", "EPERM"].includes(error.code)) console.warn("Electron 临时目录仍占用：" + profile)
    else { console.error(error); failed = true }
  } finally { app.exit(failed ? 1 : 0) }
})
