/** 真实 Electron 页面、preload 与只读目录 IPC 的文件查看器回归。 */
const assert = require("node:assert/strict")
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain, nativeImage } = require("electron")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { insertProjectWorkspace } = require("../../dist/src/main/workspace-store.js")
const { createTrustedIpcMain } = require("../../dist/src/main/electron-windows.js")
const { registerFileExplorerIpc } = require("../../dist/src/main/file-explorer-ipc.js")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { TagManager } = require("../../dist/src/main/tag-manager.js")
const { FILE_EXPLORER_CHANNELS: channels } = require("../../dist/src/preload/browser-api.js")
const { SESSION_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")
app.on("window-all-closed", () => {})

/** @returns 自包含的两页 PDF，两页分别绘制红色和绿色矩形。 */
function fixturePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Resources << >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R /Resources << >> >>",
    ...["1 0 0 rg", "0 1 0 rg"].map((color) => {
      const content = color + "\n20 20 160 160 re f\n"
      return `<< /Length ${content.length} >>\nstream\n${content}endstream`
    }),
  ]
  let text = "%PDF-1.4\n"
  const offsets = objects.map((object, index) => {
    const offset = text.length
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = text.length
  return text + "xref\n0 7\n0000000000 65535 f \n" + offsets.map((offset) =>
    String(offset).padStart(10, "0") + " 00000 n \n").join("")
    + `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

/** 打开真实构建产物，用临时数据库配置项目关联目录。 */
async function main() {
  const profile = await mkdtemp(join(tmpdir(), "nicode-electron-explorer-"))
  const workspace = join(profile, "资源样例")
  const second = join(profile, "第二个目录")
  const projectId = "34a683aa-5222-4923-afaa-55e31d8182e9"
  const emptyProjectId = "601c30e6-fb47-4349-9b7d-b45b1bbc3aaf"
  const projectRoute = `#/projects/${projectId}/new-chat`
  const directory = join(workspace, "子目录")
  const html = join(process.cwd(), "dist/src/renderer/index.html")
  let window
  let releaseSlowFile = () => {}
  try {
    app.setPath("userData", join(profile, "electron"))
    const paths = await initializeConfigFiles(profile)
    await app.whenReady()
    insertProjectWorkspace(paths.workspaceDatabasePath, {
      version: 1, id: projectId, name: "预览项目", updatedAt: new Date().toISOString(), directories: [workspace, second], sessions: [],
    })
    insertProjectWorkspace(paths.workspaceDatabasePath, {
      version: 1, id: emptyProjectId, name: "空项目", updatedAt: new Date().toISOString(), directories: [], sessions: [],
    })
    await mkdir(join(directory, "空目录"), { recursive: true })
    await mkdir(second)
    await writeFile(join(second, "另一份.txt"), "另一个项目目录的文件")
    await Promise.all([
      writeFile(join(directory, "示例.ts"), "export const viewer = true\n"),
      writeFile(join(directory, "慢文件.txt"), "旧预览结果"),
      writeFile(join(workspace, "笔记.txt"), "NiCode 纯文本"),
      writeFile(join(workspace, "说明.md"), "# 本地 Markdown\n\n| 功能 | 状态 |\n| --- | --- |\n| 树 | **可用** |\n\n[链接](https://example.test/)\n"),
      writeFile(join(workspace, "文档.pdf"), fixturePdf()),
      writeFile(join(workspace, "损坏.pdf"), "invalid"),
      writeFile(join(workspace, "数据.bin"), Buffer.from([0, 255])),
      writeFile(join(workspace, "图片.png"), nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG()),
    ])

    const rendererErrors = []
    const requests = []
    let rejectBranch = true
    const slowFile = new Promise((resolve) => { releaseSlowFile = resolve })
    window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
      preload: join(process.cwd(), "dist/src/preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
    } })
    const wc = window.webContents
    const trusted = createTrustedIpcMain(ipcMain, (event) => event.sender === wc && event.senderFrame === wc.mainFrame)
    registerStartupDataIpcHandlers(trusted, paths)
    registerWindowIpcHandlers(trusted, BrowserWindow)
    trusted.handle(SESSION_IPC_CHANNELS.getSessionData, (_event, projectId, sessionId) => ({
      projectId, sessionId, kind: "ordinary", events: [], latestSeq: 0,
      summary: { sessionId, name: "另一个对话", updatedAt: new Date().toISOString() },
      control: { revision: 0, throughSeq: 0, sandboxMode: "sandbox-full-access", phase: "idle", currentTurn: 0, pendingMessages: [], discardedMessages: [] },
    }))
    new TagManager(trusted).register(window)
    registerFileExplorerIpc({
      handle(channel, listener) {
        trusted.handle(channel, async (event, ...args) => {
          requests.push([channel, ...args])
          if (channel === channels.list && args[1] === "子目录/" && rejectBranch) {
            rejectBranch = false
            throw new Error("注入分支读取失败")
          }
          const result = await listener(event, ...args)
          if (channel === channels.read && args[1] === "子目录/慢文件.txt") await slowFile
          return result
        })
      },
    }, paths.workspaceDatabasePath)
    wc.on("console-message", (details) => { if (details.level === "error") rendererErrors.push(details.message) })
    const remoteRequests = []
    wc.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, ({ url }, callback) => {
      remoteRequests.push(url)
      callback({ cancel: true })
    })
    await window.loadFile(html)

    const evaluate = async (script) => {
      try {
        return await wc.executeJavaScript(script)
      } catch (error) {
        throw new Error(`${script}\n${error.message}\n${rendererErrors.join("\n")}`, { cause: error })
      }
    }
    const visiblePage = ".chat-browser-explorer-page:not([hidden])"
    const tree = `document.querySelector('${visiblePage} .file-explorer-tree')?.shadowRoot`
    const row = (path) => `${tree}?.querySelector(${JSON.stringify(`[data-item-path="${path}"]`)})`
    const preview = `document.querySelector('${visiblePage} .file-explorer-preview')`
    const button = (label) => `document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)})`
    const click = (element) => evaluate(`${element}.click()`)
    const width = () => evaluate("Number(document.querySelector('.file-explorer-divider').getAttribute('aria-valuenow'))")
    const lists = () => requests.filter(([channel]) => channel === channels.list).map((request) => request[2])
    const reads = () => requests.filter(([channel]) => channel === channels.read).map((request) => request[2])

    /** 等待浏览器提交画面。 @param name 截图文件名。 */
    async function capture(name) {
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      await writeFile(join(process.cwd(), "dist", name), (await wc.capturePage()).toPNG())
    }

    /** 等待 React、IPC 或 Chromium 绘制完成。 @param label 断言说明。 @param check 条件。 */
    async function until(label, check) {
      const deadline = Date.now() + 7000
      while (Date.now() < deadline) {
        if (await check()) return
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      assert.fail(`${label}\n${await evaluate("document.querySelector('#chat-browser-pane')?.innerText")}\n${rendererErrors.join("\n")}`)
    }

    await until("浏览器入口", () => evaluate(`Boolean(${button("展开内置浏览器")})`))
    await click(button("展开内置浏览器"))
    assert.equal(await evaluate(`${button("打开项目文件")}.disabled`), true)
    await evaluate(`location.hash = '#/projects/${emptyProjectId}/new-chat'`)
    await until("项目没有关联目录时禁用", () => evaluate(`${button("打开项目文件")}.title === "项目需要先关联文件夹"`))
    await evaluate(`location.hash = ${JSON.stringify(projectRoute)}`)
    await until("项目关联目录可打开", () => evaluate(`!${button("打开项目文件")}.disabled`))
    await click(button("打开项目文件"))
    await until("根目录列表", () => evaluate(`Boolean(${row("说明.md")})`))
    assert.deepEqual(lists(), [""])
    assert.equal(await evaluate("document.querySelectorAll('.chat-browser-tab').length"), 2)
    assert.equal(await evaluate("Boolean(document.querySelector('.chat-browser-address'))"), false)

    await click(row("说明.md"))
    await until("Markdown 标题、GFM 表格和静态链接", () => evaluate(`(() => {
      const preview = ${preview};
      return preview.querySelector('h1')?.textContent === '本地 Markdown'
        && !!preview.querySelector('table strong') && !preview.querySelector('a[href]');
    })()`))
    await click(row("子目录/"))
    await until("目录读取失败可重试", () => evaluate(`Boolean(${button("重试读取 子目录/")})`))
    await click(button("重试读取 子目录/"))
    await until("加载子目录的直属条目", () => evaluate(`Boolean(${row("子目录/示例.ts")})`))
    assert.deepEqual(lists(), ["", "子目录/", "子目录/"])
    assert.deepEqual(reads(), ["说明.md"])
    await click(row("子目录/示例.ts"))
    await until("代码语法高亮", () => evaluate(`(() => {
      const code = ${preview}.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-code]');
      return code?.textContent.includes('export const viewer') && !!code.querySelector('span[style]');
    })()`))
    await click(row("子目录/慢文件.txt"))
    await until("慢读取已开始", () => reads().includes("子目录/慢文件.txt"))
    await click(row("笔记.txt"))
    await until("纯文本预览", () => evaluate(`${preview}.querySelector('pre')?.textContent === 'NiCode 纯文本'`))
    releaseSlowFile()
    await click(row("子目录/"))
    assert.equal(await evaluate(`Boolean(${row("子目录/示例.ts")})`), false)
    assert.equal(await evaluate(`${preview}.querySelector('pre')?.textContent`), "NiCode 纯文本")
    await click(row("子目录/"))
    await until("复用已加载分支", () => evaluate(`Boolean(${row("子目录/示例.ts")})`))
    assert.deepEqual(lists(), ["", "子目录/", "子目录/"])
    await click(row("子目录/空目录/"))
    await until("空目录仍可按需读取", () => lists().includes("子目录/空目录/"))

    await click(button("收起文件树"))
    assert.equal(await evaluate("document.querySelector('.file-explorer-sidebar').hidden"), true)
    assert.equal(await evaluate(`${preview}.querySelector('pre')?.textContent`), "NiCode 纯文本")
    await click(button("展开文件树"))
    await until("恢复树展开状态", () => evaluate(`Boolean(${row("子目录/示例.ts")})`))
    const divider = "document.querySelector('.file-explorer-divider')"
    await until("分栏测量已完成", () => evaluate(`Number(${divider}.getAttribute('aria-valuemax')) > Number(${divider}.getAttribute('aria-valuemin')) + 40`))
    const minimumWidth = await evaluate(`Number(${divider}.getAttribute('aria-valuemin'))`)
    await evaluate(`${divider}.focus()`)
    for (const type of ["keyDown", "keyUp"]) wc.sendInputEvent({ type, keyCode: "Home" })
    await until("键盘调至最小右栏宽度", async () => await width() === minimumWidth)
    for (const type of ["keyDown", "keyUp"]) wc.sendInputEvent({ type, keyCode: "Left" })
    await until("键盘加宽右栏", async () => await width() === minimumWidth + 16)
    const beforeDrag = await width()
    const point = await evaluate(`(() => {
      const rect = document.querySelector('.file-explorer-divider').getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 100) }
    })()`)
    wc.sendInputEvent({ type: "mouseMove", ...point })
    wc.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 })
    wc.sendInputEvent({ type: "mouseMove", x: point.x - 20, y: point.y, button: "left" })
    wc.sendInputEvent({ type: "mouseUp", x: point.x - 20, y: point.y, button: "left", clickCount: 1 })
    await until("拖动调宽右栏", async () => await width() > beforeDrag)

    await click(row("图片.png"))
    await until("图片解码", () => evaluate(`${preview}.querySelector('img')?.naturalWidth === 1`))
    await click(row("数据.bin"))
    await until("未知类型元数据", () => evaluate(`${preview}.innerText.includes('2 字节') && ${preview}.innerText.includes('无法预览')`))
    await click(row("损坏.pdf"))
    await until("损坏 PDF 提示", () => evaluate(`${preview}.innerText.includes('无法打开此 PDF')`))
    await click(row("文档.pdf"))
    const pixel = (channel) => `(() => {
      const canvas = ${preview}?.querySelector('canvas:not([hidden])');
      if (!canvas?.getClientRects().length) return false;
      const rgba = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return rgba[${channel}] === 255 && rgba[${1 - channel}] === 0 && rgba[2] === 0;
    })()`
    await until("PDF 第一页实际绘制", () => evaluate(pixel(0)))
    await evaluate(`[...${preview}.querySelectorAll('button')].find(button => button.textContent === '下一页').click()`)
    await until("PDF 第二页实际绘制", () => evaluate(pixel(1)))

    const explorerHandle = requests.find(([channel]) => channel === channels.list)[1]
    await click(button("新建网页"))
    await until("切到空白网页", () => evaluate("Boolean(document.querySelector('.chat-browser-address'))"))
    await click(`document.querySelector('button[title="项目文件"]')`)
    await until("标签切回保留 PDF 页码", () => evaluate(pixel(1)))
    await evaluate("location.hash = '#/sessions/default/1c49a914-f46e-45ab-9dc7-a9b203a40616'")
    await until("另一个对话隐藏原查看器", () => evaluate(`!document.querySelector('${visiblePage}')`))
    await evaluate(`location.hash = ${JSON.stringify(projectRoute)}`)
    await until("对话切回保留 PDF 页码", () => evaluate(pixel(1)))
    await click(button("收起内置浏览器"))
    assert.equal(await evaluate("document.querySelector('#chat-browser-pane').hidden"), true)
    await click(button("展开内置浏览器"))
    await until("展开浏览器保留 PDF", () => evaluate(pixel(1)))
    await capture("file-explorer-light.png")

    await click(button("切换深色外观"))
    window.setContentSize(800, 680)
    await until("窄窗深色布局", () => evaluate(`innerWidth === 800 && document.documentElement.dataset.theme === 'dark'
      && ${preview}.clientWidth > document.querySelector('.file-explorer-sidebar').clientWidth
      && document.querySelector('.file-explorer-sidebar').clientWidth > 100`))
    await click(row("说明.md"))
    await until("窄窗 Markdown 预览", () => evaluate(`${preview}.querySelector('h1')?.textContent === '本地 Markdown'`))
    await capture("file-explorer-dark.png")
    const switcher = `document.querySelector('select[aria-label="项目关联文件夹"]')`
    assert.deepEqual(await evaluate(`[...${switcher}.options].map(option => option.textContent.trim())`), ["资源样例", "第二个目录"])
    const beforeSwitch = await width()
    const count = await evaluate("document.querySelectorAll('.chat-browser-tab').length")
    await evaluate(`${switcher}.value = ${JSON.stringify(second)}; ${switcher}.dispatchEvent(new Event("change", { bubbles: true }))`)
    await until("切换到第二个项目目录", () => evaluate(`Boolean(${row("另一份.txt")})`))
    assert.equal(await width(), beforeSwitch)
    assert.equal(await evaluate("document.querySelectorAll('.chat-browser-tab').length"), count)
    assert.equal(await evaluate(`${preview}.innerText`), "从文件树选择要查看的文件")
    await until("切换目录释放旧句柄", () => requests.some(([channel, handle]) => channel === channels.close && handle === explorerHandle))
    await assert.rejects(evaluate(`window.nicodeBrowser.listExplorerDirectory(${JSON.stringify(explorerHandle)}, "")`), /目录访问已失效/)
    await click(row("另一份.txt"))
    await until("预览第二个项目目录的文件", () => evaluate(`${preview}.querySelector("pre")?.textContent === "另一个项目目录的文件"`))
    const secondHandle = requests.filter(([channel]) => channel === channels.list).at(-1)[1]
    await evaluate("location.hash = '#/default/new-chat'")
    await until("共享草稿标签也隔离项目文件", () => evaluate(`!document.querySelector('${visiblePage}') && !document.querySelector('button[title="项目文件"]')`))
    await evaluate(`location.hash = ${JSON.stringify(projectRoute)}`)
    await until("切回项目保留选中目录", () => evaluate(`${preview}?.querySelector("pre")?.textContent === "另一个项目目录的文件"`))
    await click(button("关闭 项目文件"))
    await until("关闭标签释放当前目录", () => requests.some(([channel, handle]) => channel === channels.close && handle === secondHandle))
    assert.deepEqual(remoteRequests, [])
    assert.deepEqual(rendererErrors, [])
    console.log("electron-file-explorer.test.cjs: lazy tree, preview formats, offline PDF, resizing and tab lifecycle passed")
  } finally {
    releaseSlowFile()
    if (window && !window.isDestroyed()) window.destroy()
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true }).catch((error) => {
      if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes(error.code)) throw error
    })
  }
}

const timeout = setTimeout(() => { console.error("File Explorer test timed out"); app.exit(1) }, 45000)
void main().then(() => { clearTimeout(timeout); app.exit(0) }, (error) => {
  console.error(error)
  clearTimeout(timeout)
  app.exit(1)
})
