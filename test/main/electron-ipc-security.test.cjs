/** 真实 Electron 的主窗口导航与 IPC 信任边界；只访问本地 HTTP 和临时配置。 */
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { createElectronWindowManager, createTrustedIpcMain } = require('../../dist/src/main/electron-windows.js')
const { TagManager } = require('../../dist/src/main/tag-manager.js')
const { registerMcpIpcHandlers } = require('../../dist/src/main/mcp-ipc.js')
const { MCPManager } = require('../../dist/runtime/mcp/src/manager.js')

/** @returns 外部导航被拦截，绕过导航的外部文档也无法启动 MCP。 */
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'nicode-ipc-security-'))
  app.setPath('userData', root)
  await app.whenReady()
  const configPath = join(root, 'config.json')
  const initial = JSON.stringify({ version: 2, runtime: { userMessageMode: 'queue' }, mcpServers: [] })
  await writeFile(configPath, initial)
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<title>Untrusted document</title>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const external = `http://127.0.0.1:${server.address().port}/external`
  const html = join(root, 'index.html')
  await writeFile(html, `<a id="external" href="${external}">External link</a>`)
  const manager = new MCPManager(() => 1)
  await manager.initialize([])
  let windows
  const guarded = createTrustedIpcMain(ipcMain, event => windows?.isTrustedSender(event) ?? false)
  const opened = []
  windows = createElectronWindowManager(BrowserWindow, {
    browserTags: new TagManager(guarded), preloadPath: join(__dirname, '../../dist/src/preload/index.js'),
    rendererHtmlPath: html, openExternal: url => opened.push(url), onWindowLoadFailure: error => { throw error },
  })
  registerMcpIpcHandlers(guarded, { configPath }, manager)
  try {
    windows.createMainWindow()
    const window = BrowserWindow.getAllWindows()[0]
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve))
    assert.deepEqual(await window.webContents.executeJavaScript('window.nicode.listMcpServers()'), [])
    const initialUrl = window.webContents.getURL()
    await window.webContents.executeJavaScript("document.getElementById('external').click()")
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(window.webContents.getURL(), initialUrl)
    assert.deepEqual(opened, [external])
    await window.webContents.executeJavaScript(`window.open(${JSON.stringify(external)})`)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    // Main-process loadURL is outside will-navigate: IPC must reject the new document independently.
    await window.loadURL(external)
    const config = { name: 'must-not-start', enabled: true, transport: 'stdio', command: process.execPath, args: ['--version'] }
    await assert.rejects(window.webContents.executeJavaScript(`window.nicode.createMcpServer(${JSON.stringify(config)})`), /IPC 请求来源无效/)
    assert.equal(await readFile(configPath, 'utf8'), initial)
    assert.deepEqual(manager.getConnectionStates(), [])
    window.destroy()
    console.log('electron-ipc-security.test.cjs: navigation and privileged IPC checks passed')
  } finally {
    await manager.dispose()
    await new Promise(resolve => server.close(resolve))
    // Chromium may retain files in userData until app.exit; they are temporary test data.
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

const timeout = setTimeout(() => { console.error('IPC security test timed out'); app.exit(1) }, 15000)
main().then(() => { clearTimeout(timeout); app.exit(0) }, error => { console.error(error); clearTimeout(timeout); app.exit(1) })
