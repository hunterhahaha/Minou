/** 以隐藏 Electron 窗口、真实 IPC 与离线模型验证 Team 桌面链路。 */
const assert = require("node:assert/strict")
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { initializeConfigFilesSnapshot } = require("../../dist/src/main/config-files.js")
const { createTrustedIpcMain } = require("../../dist/src/main/electron-windows.js")
const { startElectronApp } = require("../../dist/src/main/index.js")
const { saveModel, saveProvider } = require("../../dist/src/main/provider-store.js")
const { SessionRuntimeGlobal } = require("../../dist/src/main/session-runtime-global.js")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { START_TEAM_SESSION_CHANNEL } = require("../../dist/src/preload/session-api.js")
const { TeamStore } = require("../../dist/runtime/session/src/team-store.js")
const { ToolRegistry, RenderRegistry } = require("../../dist/runtime/tools/src/tool-registry.js")

let window, profile
let failed = false
app.on("window-all-closed", () => {})

/** 等待由 IPC、路由或流式模型驱动的真实状态。 */
async function until(label, predicate) {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("等待超时：" + label)
    await new Promise((done) => setTimeout(done, 20))
  }
}

const evaluate = (code) => window.webContents.executeJavaScript(code)
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const clickText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
  .find((node) => node.textContent.trim() === ${JSON.stringify(text)}).click()`)
const ORDINARY_MODE = "普通模式"
const TEAM_MODE = "团队模式"
const mode = (name) => evaluate(`[...document.querySelectorAll('.workspace-mode button')]
  .find((node) => node.textContent === ${JSON.stringify(name)})?.getAttribute('aria-pressed') === 'true'`)
const selectMode = async (name) => {
  await clickText(".workspace-mode button", name)
  await until(name, () => mode(name))
}
const editorText = () => evaluate("document.querySelector('.composer-editor')?.textContent")

/** 输入普通文本，经过真实 Composer 的编辑事件。 */
async function type(text) {
  await evaluate(`(() => {
    const editor = document.querySelector('.composer-editor')
    editor.focus()
    getSelection().selectAllChildren(editor)
    document.execCommand('insertText', false, ${JSON.stringify(text)})
  })()`)
}

/** 发送新会话并验证真实角色和复用的消息渲染。 */
async function send(projectId, kind) {
  await until("发送可用", () => evaluate("document.querySelector('.new-chat-composer .send-button')?.disabled === false"))
  await click(".new-chat-composer .send-button")
  await until("显示离线回复", () => evaluate("document.querySelector('.chat-page')?.textContent.includes('离线回复')"))
  const sessionId = await evaluate("document.querySelector('.chat-page').dataset.sessionId")
  const data = await evaluate(`window.nicode.getSessionData(${JSON.stringify(projectId)}, ${JSON.stringify(sessionId)})`)
  assert.equal(data.kind, kind)
  assert.ok(await mode(kind === "router" ? TEAM_MODE : ORDINARY_MODE))
  return sessionId
}

/** 确认切换框以聊天栏为基准居中，且与页头操作互不遮挡。 */
async function assertCenteredMode() {
  assert.ok(await evaluate(`(() => {
    const modeElement = document.querySelector('.workspace-mode')
    const mode = modeElement.getBoundingClientRect()
    const chat = document.querySelector('.chat-browser-chat').getBoundingClientRect()
    const controls = document.querySelectorAll('.panel-header-context, .panel-header-actions, .browser-toggle')
    const intersects = (rect) => rect.width > 0 && rect.height > 0 &&
      rect.left < mode.right && rect.right > mode.left && rect.top < mode.bottom && rect.bottom > mode.top
    return modeElement.closest('.panel-header') !== null && modeElement.closest('.titlebar') === null &&
      mode.width > 0 && Math.abs((mode.left + mode.right - chat.left - chat.right) / 2) < 2 &&
      [...controls].every((element) => !intersects(element.getBoundingClientRect()))
  })()`))
}

/** 保存通过页头布局断言的窗口截图。 */
async function capture(name) {
  await assertCenteredMode()
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  await writeFile(join(process.cwd(), "dist", name + ".png"), (await window.webContents.capturePage()).toPNG())
}

async function main() {
  profile = await mkdtemp(join(tmpdir(), "nicode-electron-team-"))
  app.setPath("userData", join(profile, "electron"))
  const { paths, config } = await initializeConfigFilesSnapshot(profile)
  saveProvider(paths.providerDatabasePath, { id: "offline", name: "离线", type: "custom", protocol: "responses" })
  saveModel(paths.providerDatabasePath, { providerId: "offline", modelId: "team-test", name: "离线模型",
    supportsReasoning: true, reasoningLevels: ["medium"], contextWindow: 128000, maxOutputTokens: 4096 })
  const failures = []
  const runtime = new SessionRuntimeGlobal(paths, new ToolRegistry(), new RenderRegistry())
  runtime.createTurnModelAdapter = async () => ({
    contextWindow: 128000,
    maxOutputTokens: 4096,
    async *stream(request) {
      const history = request.context.history
      const latestUser = history?.events.filter((event) => event.type === "user/message").at(-1)
      if (history?.system.includes("You are the Team Router") &&
          latestUser?.content[0]?.text.includes("创建成员") &&
          !history.events.some((event) => event.seq > latestUser.seq && event.type === "tool/result")) {
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block: { type: "tool_call", name: "communication",
          toolCallId: "member-create", arguments: { event: "create_session", session_info: "离线成员任务" } } }
        yield { type: "stream_end", completion: "tool_calls" }
        return
      }
      yield { type: "block_start", index: 0, blockType: "text" }
      yield { type: "block_end", index: 0, block: { type: "text", text: history ? "离线回复" : '{"title":"离线会话"}' } }
      yield { type: "stream_end", completion: "finished" }
    },
  })
  let rejectFirstTeamStart = true
  const trusted = createTrustedIpcMain(ipcMain, (event) => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame)
  registerWindowIpcHandlers(trusted, BrowserWindow)
  let loaded
  await startElectronApp({
    app,
    ipcMain: { handle(channel, handler) {
      trusted.handle(channel, (event, ...args) => {
        if (channel === START_TEAM_SESSION_CHANNEL && rejectFirstTeamStart) {
          rejectFirstTeamStart = false
          throw new Error("预期的首发失败")
        }
        return handler(event, ...args)
      })
    } },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    windows: {
      createMainWindow() {
        window = new BrowserWindow({ show: false, width: 1200, height: 820, webPreferences: {
          preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true,
          nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        } })
        loaded = window.loadFile(join(process.cwd(), "dist/src/renderer/index.html"))
      },
      hasOpenWindows: () => window && !window.isDestroyed(),
      sendSessionUpdate: (update) => window.webContents.send("nicode:session:update", update),
    },
    configPaths: paths, teamWakeup: config.teamWakeup, sessionRuntime: { global: runtime, systemPrompt: "离线夹具" },
    onSessionCompletionFailure: (failure) => failures.push(failure),
  })
  await loaded
  await until("默认普通模式", () => mode(ORDINARY_MODE))
  await assertCenteredMode()
  await type("独立普通会话")
  await selectMode(TEAM_MODE)
  assert.equal(await editorText(), "")
  await type("独立工作，创建成员")
  await selectMode(ORDINARY_MODE)
  assert.equal(await editorText(), "独立普通会话")
  const chat = await send("default", "ordinary")
  await selectMode(TEAM_MODE)
  assert.equal(await editorText(), "独立工作，创建成员")
  await capture("team-mode-work-light")
  await click(".browser-toggle")
  await until("聊天与浏览器分栏", () => evaluate("!!document.querySelector('.chat-browser-divider')"))
  await assertCenteredMode()
  await click(".browser-toggle")
  await click(".new-chat-composer .send-button")
  await until("首发失败提示", () => evaluate("document.querySelector('.chat-error')?.textContent.includes('预期的首发失败')"))
  assert.equal(await editorText(), "独立工作，创建成员")
  const router = await send("default", "router")
  const store = new TeamStore(join(paths.rootDir, "events.sqlite"))
  await until("成员执行完成", () => store.members().some((member) => member.routerId === router && store.status(member) === "idle"))
  assert.deepEqual(new Set((await evaluate("window.nicode.listDefaultSessions()")).map((session) => session.sessionId)), new Set([chat, router]))

  const project = await evaluate("window.nicode.createProject('协作项目')")
  const projectId = project.projectId
  await evaluate(`location.hash = ${JSON.stringify("#/projects/" + projectId + "/new-chat")}`)
  await until("项目聊天草稿页", () => mode(ORDINARY_MODE))
  await type("项目普通会话")
  const projectChat = await send(projectId, "ordinary")
  await selectMode(TEAM_MODE)
  assert.ok(await evaluate(`location.hash.includes(${JSON.stringify(projectId)})`))
  assert.equal(await editorText(), "")
  await type("项目工作，创建成员")
  const projectRouter = await send(projectId, "router")
  await until("项目成员执行完成", () => store.members().some((member) => member.routerId === projectRouter && store.status(member) === "idle"))
  const projects = await evaluate("window.nicode.listProjects()")
  assert.deepEqual(new Set(projects.find((item) => item.projectId === projectId).sessions.map((item) => item.sessionId)),
    new Set([projectChat, projectRouter]))
  await evaluate(`window.nicode.renameSession(${JSON.stringify(projectId)}, ${JSON.stringify(projectRouter)}, '项目 Router 历史')`)
  await selectMode(ORDINARY_MODE)
  await click(".titlebar-search")
  await until("共用搜索结果", () => evaluate("document.querySelectorAll('.search-result').length === 5"))
  await clickText(".search-result strong", "项目 Router 历史")
  await until("搜索回到 Router", () => mode(TEAM_MODE))
  await new Promise((done) => { window.webContents.once("did-finish-load", done); window.webContents.reload() })
  await until("刷新后从持久角色恢复模式", () => mode(TEAM_MODE))
  assert.equal(await evaluate("document.querySelector('.chat-page').dataset.sessionId"), projectRouter)

  await click(".sidebar-settings")
  await clickText(".settings-nav-option", "团队协作")
  const polling = "document.querySelector('input[name=pollingInterval]')"
  await until("四项配置已加载", () => evaluate(`${polling}?.value === '60' && document.querySelectorAll('[aria-label="团队协作设置"] input').length === 4`))
  const setPolling = (value) => evaluate(`(() => {
    const input = ${polling}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const submit = '[aria-label="团队协作设置"] button[type=submit]'
  await setPolling("29")
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(submit)}).disabled`), true)
  await setPolling("45")
  const originalConfig = await readFile(paths.configPath, "utf8")
  await writeFile(paths.configPath, "{")
  await click(submit)
  await until("保存失败提示", () => evaluate(`document.querySelector('[aria-label="团队协作设置"] [role=alert]')?.textContent.includes('无法保存')`))
  assert.equal(await evaluate(polling + ".value"), "45")
  assert.equal((await evaluate("window.nicode.getTeamWakeupConfig()")).pollingInterval, 60)
  await writeFile(paths.configPath, originalConfig)
  await click(submit)
  await until("保存成功反馈", () => evaluate(`document.querySelector('[aria-label="团队协作设置"] [role=status]')?.textContent.includes('已保存')`))
  assert.equal(JSON.parse(await readFile(paths.configPath, "utf8")).teamWakeup.pollingInterval, 45)
  await click('[aria-label="关闭设置"]')
  await click('[aria-label="切换深色外观"]')
  await click(".sidebar-toggle")
  window.setContentSize(420, 680)
  await until("深色窄窗", () => evaluate("innerWidth === 420 && document.documentElement.dataset.theme === 'dark'"))
  await capture("team-mode-router-dark-narrow")
  assert.deepEqual(failures, [])
  console.log("electron-team-mode: 模式、真实首发、混合历史、成员摘要排除、重载、草稿、设置失败重试和聊天页头通过")
}

void main().catch((error) => { console.error(error); failed = true }).finally(async () => {
  try {
    if (window && !window.isDestroyed()) window.destroy()
    if (profile) {
      assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
      await rm(profile, { recursive: true, force: true })
    }
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EBUSY"].includes(error.code)) console.warn("Electron 临时目录仍被占用")
    else { console.error(error); failed = true }
  } finally { app.exit(failed ? 1 : 0) }
})
