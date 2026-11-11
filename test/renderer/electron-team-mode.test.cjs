/** 以隐藏 Electron 窗口、真实 IPC 与离线模型验证 Team 桌面链路。 */
const assert = require("node:assert/strict")
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { DatabaseSync } = require("node:sqlite")
const { app, BrowserWindow, ipcMain } = require("electron")
const { initializeConfigFilesSnapshot } = require("../../dist/src/main/config-files.js")
const { createTrustedIpcMain } = require("../../dist/src/main/electron-windows.js")
const { startElectronApp } = require("../../dist/src/main/index.js")
const { saveModel, saveProvider } = require("../../dist/src/main/provider-store.js")
const { SessionRuntimeGlobal } = require("../../dist/src/main/session-runtime-global.js")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { SESSION_IPC_CHANNELS, STARTUP_DATA_IPC_CHANNELS, START_TEAM_SESSION_CHANNEL, TEAM_SESSION_CHANNELS } = require("../../dist/src/preload/session-api.js")
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
async function send(projectId, kind, checkStreaming) {
  await until("发送可用", () => evaluate("document.querySelector('.new-chat-composer .send-button')?.disabled === false"))
  await click(".new-chat-composer .send-button")
  await until("显示离线回复", () => evaluate("document.querySelector('.chat-page')?.textContent.includes('离线回复')"))
  const sessionId = await evaluate("document.querySelector('.chat-page').dataset.sessionId")
  const data = await evaluate(`window.nicode.getSessionData(${JSON.stringify(projectId)}, ${JSON.stringify(sessionId)})`)
  assert.equal(data.kind, kind)
  assert.ok(await mode(kind === "router" ? TEAM_MODE : ORDINARY_MODE))
  await checkStreaming?.(data)
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
  const delivered = []
  const gatedMembers = new Map()
  let releaseRouterReply
  let indexQueries = 0
  let delayedHistory
  let memberListOverride
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
      const assignment = /^成员续跑 (\S+) (.+)$/.exec(latestUser?.content[0]?.text ?? "")
      if (history?.system.includes("You are the Team Router") && assignment &&
          !history.events.some((event) => event.seq > latestUser.seq && event.type === "tool/result")) {
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block: { type: "tool_call", name: "communication",
          toolCallId: "member-assign-" + latestUser.seq, arguments: { event: "send_message", session_id: assignment[1], message: assignment[2] } } }
        yield { type: "stream_end", completion: "tool_calls" }
        return
      }
      if (history?.system.includes("You are a Team Session")) {
        const task = latestUser.content[0].text
        if (task !== "离线成员任务") await new Promise((done) => gatedMembers.set(task, done))
        const fragments = task === "可见成员压力" ? 600 : 200
        yield { type: "block_start", index: 0, blockType: "text" }
        for (let i = 0; i < fragments; i++) {
          if (i === 300) await new Promise((done) => gatedMembers.set(task + "后半段", done))
          if (task === "首屏交错" && (i === 50 || i === 100)) {
            await new Promise((done) => gatedMembers.set(task + i, done))
          }
          yield { type: "block_delta", index: 0, delta: { type: "text", text: i === 0 ? "**" + task + "**流" : "流" } }
        }
        yield { type: "block_end", index: 0, block: { type: "text", text: "**" + task + "**" + "流".repeat(fragments) } }
        yield { type: "stream_end", completion: "finished" }
        return
      }
      yield { type: "block_start", index: 0, blockType: "text" }
      if (latestUser?.content[0]?.text === "独立工作，创建成员") {
        yield { type: "block_delta", index: 0, delta: { type: "text", text: "离线回复" } }
        await new Promise((done) => { releaseRouterReply = done })
      }
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
      trusted.handle(channel, async (event, ...args) => {
        if (channel === START_TEAM_SESSION_CHANNEL && rejectFirstTeamStart) {
          rejectFirstTeamStart = false
          throw new Error("预期的首发失败")
        }
        if (channel === TEAM_SESSION_CHANNELS.list && memberListOverride) {
          const override = memberListOverride
          memberListOverride = undefined
          if (override === "error") throw new Error("成员列表夹具错误")
          return []
        }
        if ([STARTUP_DATA_IPC_CHANNELS.listProjects, STARTUP_DATA_IPC_CHANNELS.listDefaultSessions].includes(channel)) indexQueries++
        if (channel === SESSION_IPC_CHANNELS.getSessionData && delayedHistory?.id === args[1]) {
          const hold = delayedHistory
          delayedHistory = undefined
          const snapshot = await handler(event, ...args)
          await new Promise((done) => { hold.release = done })
          return snapshot
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
      sendSessionUpdate(update, recipients) {
        if (recipients && !recipients.has(window.webContents.id)) return
        delivered.push(update)
        window.webContents.send(recipients ? TEAM_SESSION_CHANNELS.update : SESSION_IPC_CHANNELS.update, update)
      },
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
  const databasePath = join(paths.rootDir, "events.sqlite")
  const durableEvents = (table, sessionId) => {
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const rows = db.prepare("SELECT seq, type, event_json FROM " + table + " WHERE session_id = ? ORDER BY seq").all(sessionId)
      assert.deepEqual(rows.map(({ seq }) => seq), rows.map((_, index) => index + 1))
      assert.ok(rows.every(({ type }) => type !== "assistant/block_start" && type !== "assistant/block_delta"))
      return rows.map(({ event_json }) => JSON.parse(event_json))
    } finally { db.close() }
  }
  const router = await send("default", "router", (data) => {
    assert.equal(data.streamEvents.at(-1)?.delta?.text, "离线回复")
    assert.equal(durableEvents("session_events", data.sessionId).at(-1)?.type, "step/start")
    releaseRouterReply()
  })
  await until("Router 完整回复已提交", () => durableEvents("session_events", router).some(
    ({ type, block }) => type === "assistant/block_end" && block.type === "text" && block.text === "离线回复"))
  const store = new TeamStore(databasePath)
  await until("成员执行完成", () => store.members().some((member) => member.routerId === router && store.status(member) === "idle"))
  assert.deepEqual(new Set((await evaluate("window.nicode.listDefaultSessions()")).map((session) => session.sessionId)), new Set([chat, router]))

  const member = store.members().find((item) => item.routerId === router)
  const memberUpdates = () => delivered.filter((update) => update.sessionId === member.sessionId)
  const memberPage = '.chat-browser-pane .chat-page[data-session-id="' + member.sessionId + '"]'
  const tab = '.chat-browser-tab-item button[title="' + member.sessionId + '"]'
  const hasMemberPage = () => evaluate("!!document.querySelector(" + JSON.stringify(memberPage) + ")")
  const memberHas = (label) => evaluate("document.querySelector(" + JSON.stringify(memberPage) + ")?.textContent.includes(" + JSON.stringify(label) + ")")
  const listMembers = async () => {
    await evaluate("(() => { const entry = document.querySelector('[aria-label=团队成员]'); entry.focus(); entry.click() })()")
    await until("成员选择按钮", () => evaluate("!!document.querySelector('.team-members-list button')"))
  }
  const openMember = async () => {
    await listMembers()
    await click(".team-members-list button")
    await until("只读成员对话已挂载", hasMemberPage)
    assert.equal(await evaluate("!!document.querySelector(" + JSON.stringify(memberPage + " .composer") + ")"), false)
  }
  const runMember = async (task) => {
    await evaluate("window.nicode.continueSession('default'," + JSON.stringify(router) + ", { content: [{ type: 'text', text: " +
      JSON.stringify("成员续跑 " + member.sessionId + " " + task) + " }] })")
    await until("Router 已完成且成员等候流式闸门", async () => gatedMembers.has(task) &&
      await evaluate("document.querySelector('.chat-browser-chat .session-phase')?.classList.contains('phase-idle')"))
  }
  const finishMember = async (task) => {
    gatedMembers.get(task)()
    await until("成员已完成", () => store.status(member) === "idle")
  }
  assert.equal(memberUpdates().length, 0, "200 个片段的首次后台执行无窗口推送")
  const initialData = await evaluate("window.nicode.getSessionData('default'," + JSON.stringify(member.sessionId) + ")")
  assert.deepEqual(initialData.streamEvents, [])
  assert.ok(durableEvents("team_session_events", member.sessionId).some(
    ({ type, block }) => type === "assistant/block_end" && block.type === "text" && block.text === "**离线成员任务**" + "流".repeat(200)))
  await listMembers()
  assert.equal(memberUpdates().length, 0)
  await evaluate("document.querySelector('[aria-labelledby=team-members-title]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await until("Escape 关闭成员列表并恢复焦点", () => evaluate("document.activeElement?.getAttribute('aria-label') === '团队成员'"))

  await runMember("首屏交错")
  gatedMembers.get("首屏交错")()
  await until("成员输出部分正文后等候", () => gatedMembers.has("首屏交错50"))
  const firstHistory = { id: member.sessionId }
  delayedHistory = firstHistory
  await openMember()
  await until("已截取成员历史快照", () => firstHistory.release)
  const beforeActive = memberUpdates().length
  gatedMembers.get("首屏交错50")()
  await until("历史未返回时已收到后续 50 个片段", () => gatedMembers.has("首屏交错100") && memberUpdates().slice(beforeActive).filter(
    (update) => update.kind === "stream" && update.event.type === "assistant/block_delta").length === 50)
  firstHistory.release()
  await until("完整块提交前已合并历史前缀和实时片段", () => memberHas("首屏交错" + "流".repeat(100)))
  assert.equal(durableEvents("team_session_events", member.sessionId).at(-1)?.type, "step/start")
  await finishMember("首屏交错100")
  await until("成员完整块已显示", () => memberHas("首屏交错" + "流".repeat(200)))
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  await writeFile(join(process.cwd(), "dist", "team-member-light-wide.png"), (await window.webContents.capturePage()).toPNG())
  await click('[aria-label="新建网页"]')
  await until("切换到其他标签时卸载成员页", async () => !(await hasMemberPage()))
  await click(tab)
  await until("切回标签复用缓存", () => memberHas("首屏交错流"))
  await click('[aria-label="关闭 新标签页"]')
  await openMember()
  assert.equal(await evaluate("document.querySelectorAll(" + JSON.stringify(tab) + ").length"), 1)

  await runMember("后台缓存")
  // Count React DOM prop commits on the existing Router record and Markdown nodes.
  // First verify the counters advance on a deliberate workspace render.
  await evaluate(`(() => {
    window.routerRenders = { transcript: 0, markdown: 0 }
    const track = (node, counter) => {
      const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"))
      if (!key) throw new Error("React DOM props unavailable")
      let props = node[key]
      Object.defineProperty(node, key, { configurable: true,
        get: () => props,
        set: (value) => { props = value; window.routerRenders[counter]++ },
      })
    }
    track(document.querySelector(".chat-browser-chat .chat-page"), "transcript")
    for (const node of document.querySelectorAll(".chat-browser-chat .markdown-content")) track(node, "markdown")
  })()`)
  await click(".browser-toggle")
  await until("收起时卸载成员页", async () => !(await hasMemberPage()))
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  const commitsBefore = await evaluate("window.routerRenders")
  assert.ok(commitsBefore.transcript > 0 && commitsBefore.markdown > 0)
  const queriesBefore = indexQueries
  const backgroundBefore = memberUpdates().length
  await evaluate("window.sampleGaps = []; window.lastSample = performance.now(); window.sampleTimer = setInterval(() => { const now = performance.now(); window.sampleGaps.push(now - window.lastSample); window.lastSample = now }, 10)")
  await finishMember("后台缓存")
  await until("后台成员收到 idle 状态", () => memberUpdates().slice(backgroundBefore).some(
    (update) => update.kind === "state" && update.control.phase === "idle"))
  await evaluate("new Promise(resolve => setTimeout(resolve, 50))")
  const gap = await evaluate("clearInterval(window.sampleTimer); Math.max(0, ...window.sampleGaps)")
  const commits = await evaluate("window.routerRenders")
  assert.deepEqual(commits, commitsBefore, "成员后台流未触发 Router 记录或 Markdown 重绘")
  assert.equal(indexQueries - queriesBefore, 0, "成员后台流未请求工作区摘要")
  assert.equal(await hasMemberPage(), false)
  await click(".browser-toggle")
  await until("重新挂载立即显示后台缓存", () => memberHas("后台缓存流"))
  console.log("member stream: unopened=0, background=" + (memberUpdates().length - backgroundBefore) +
    ", background Router/Markdown commits=0/0, max 10ms timer gap=" + gap.toFixed(1) + "ms")

  await runMember("可见成员压力")
  await evaluate(`(() => {
    const page = document.querySelector(${JSON.stringify(memberPage)})
    window.visibleMemberCommits = { transcript: 0, markdown: 0 }
    for (const [node, counter] of [[page, "transcript"], [page.querySelector(".final-answer .markdown-content"), "markdown"]]) {
      const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"))
      if (!key) throw new Error("React DOM props unavailable")
      let props = node[key]
      Object.defineProperty(node, key, { configurable: true, get: () => props,
        set: (value) => { props = value; window.visibleMemberCommits[counter]++ } })
    }
    window.sampleGaps = []
    window.lastSample = performance.now()
    window.sampleTimer = setInterval(() => {
      const now = performance.now()
      window.sampleGaps.push(now - window.lastSample)
      window.lastSample = now
    }, 10)
  })()`)
  const beforeVisible = memberUpdates().length
  const visibleDeltas = () => memberUpdates().slice(beforeVisible).filter(
    (update) => update.kind === "stream" && update.event.type === "assistant/block_delta").length
  const midpoint = "可见成员压力" + "流".repeat(300)
  gatedMembers.get("可见成员压力")()
  await until("可见成员呈现全部前半段片段", async () => gatedMembers.has("可见成员压力后半段") &&
    await evaluate(`[...document.querySelectorAll(${JSON.stringify(memberPage + " .assistant-entry .markdown-content")})]
      .some(node => node.textContent.trim() === ${JSON.stringify(midpoint)})`))
  const visibleCommits = await evaluate("window.visibleMemberCommits")
  const visibleGap = await evaluate("clearInterval(window.sampleTimer); Math.max(0, ...window.sampleGaps)")
  console.log("visible member stream: first " + visibleDeltas() + " fragments, transcript/old Markdown commits=" +
    visibleCommits.transcript + "/" + visibleCommits.markdown + ", max 10ms timer gap=" + visibleGap.toFixed(1) + "ms")
  assert.equal(visibleDeltas(), 300)
  assert.equal(durableEvents("team_session_events", member.sessionId).at(-1)?.type, "step/start")
  assert.equal(visibleCommits.markdown, 0, "可见成员流未重绘已完成的 Markdown")
  assert.ok(visibleCommits.transcript > 0 && visibleCommits.transcript < visibleDeltas(), "同帧片段合并为一次记录更新")
  assert.equal(store.status(member), "running")
  const otherSession = ".chats-section .session-name:not([aria-current])"
  await click(otherSession)
  await until("流式过程中切到普通会话并卸载成员页", () => evaluate(`document.querySelector(".chat-browser-chat .chat-page")
    ?.dataset.sessionId === ${JSON.stringify(chat)} && !document.querySelector(${JSON.stringify(memberPage)})`))
  await click(otherSession)
  await until("流式过程中切回团队会话并恢复成员正文", () => memberHas(midpoint))
  await finishMember("可见成员压力后半段")
  const finalText = "可见成员压力" + "流".repeat(600)
  await until("权威成员回复完整且回到就绪", () => evaluate(`(() => {
    const page = document.querySelector(${JSON.stringify(memberPage)})
    return page?.querySelector(".session-phase")?.classList.contains("phase-idle") &&
      [...page.querySelectorAll(".final-answer .markdown-content")].at(-1)?.textContent.trim() === ${JSON.stringify(finalText)}
  })()`))
  assert.equal(visibleDeltas(), 600)

  await runMember("标签已关闭")
  await click(tab + " + button")
  await until("关闭时卸载成员页", async () => !(await hasMemberPage()))
  await evaluate("window.nicode.listTeamMembers('default'," + JSON.stringify(router) + ")")
  const closedBefore = memberUpdates().length
  await finishMember("标签已关闭")
  assert.equal(memberUpdates().length, closedBefore)
  await openMember()
  await until("重新订阅时补齐关闭期间历史", () => memberHas("标签已关闭流"))
  await runMember("重载已退订")
  await new Promise((done) => { window.webContents.once("did-finish-load", done); window.webContents.reload() })
  await until("Router 重新加载", () => mode(TEAM_MODE))
  assert.equal(await hasMemberPage(), false)
  const beforeReloadedStream = memberUpdates().length
  await finishMember("重载已退订")
  assert.equal(memberUpdates().length, beforeReloadedStream)

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
  await assert.rejects(evaluate("window.nicode.subscribeTeamSession(" + JSON.stringify(projectId) + "," +
    JSON.stringify(projectRouter) + "," + JSON.stringify(member.sessionId) + ")"), /不属于/)
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
  memberListOverride = "empty"
  await click('[aria-label="团队成员"]')
  await until("成员列表为空", () => evaluate("document.querySelector('[aria-labelledby=team-members-title]')?.textContent.includes('当前团队暂无成员')"))
  await click('[aria-label="关闭团队成员"]')
  memberListOverride = "error"
  await click('[aria-label="团队成员"]')
  await until("成员查询失败提供重试", () => evaluate("[...document.querySelectorAll('[aria-labelledby=team-members-title] button')].some((node) => node.textContent === '重试')"))
  await clickText('[aria-labelledby=team-members-title] button', "重试")
  await until("窄窗成员列表", () => evaluate("!!document.querySelector('.team-members-list button')"))
  await click(".team-members-list button")
  await until("窄窗成员记录可见", () => evaluate("!!document.querySelector('.chat-browser-pane .chat-page .final-answer')"))
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  await writeFile(join(process.cwd(), "dist", "team-member-dark-narrow.png"), (await window.webContents.capturePage()).toPNG())
  await click(".chat-browser-chat-tab")
  await until("窄窗切回聊天卸载成员页", () => evaluate("!document.querySelector('.chat-browser-pane .chat-page')"))
  await click('[aria-label="团队成员"]')
  await until("窄窗再次显示成员列表", () => evaluate("!!document.querySelector('.team-members-list button')"))
  await click(".team-members-list button")
  await until("窄窗从聊天重开原成员标签", () => evaluate("!!document.querySelector('.chat-browser-pane .chat-page .final-answer')"))
  assert.equal(await evaluate("document.querySelectorAll('.chat-browser-tab-item button[title]:not(.chat-browser-chat-tab)').length"), 1)
  assert.deepEqual(failures, [])
  console.log("electron-team-mode: 模式、真实首发、混合历史、成员摘要排除、重载、草稿、设置失败重试和聊天页头通过")
}

const watchdog = setTimeout(() => { console.error("Team Mode Electron 夹具超过 60 秒"); app.exit(1) }, 60_000)
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
  } finally { clearTimeout(watchdog); app.exit(failed ? 1 : 0) }
})
