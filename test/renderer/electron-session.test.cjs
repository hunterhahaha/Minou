/** 使用真实 Electron、preload 和构建后的 React 页面进行本机交互验证，不访问网络或用户数据。 */
const assert = require("node:assert/strict")
const { mkdir, mkdtemp, realpath, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { createServer } = require("node:http")
const { TagManager } = require("../../dist/src/main/tag-manager.js")
const { app, BrowserWindow, ipcMain } = require("electron")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { readSessionMeta } = require("../../dist/runtime/session/src/meta-store.js")
const { SessionRuntime } = require("../../dist/runtime/agent/src/session-runtime.js")
const { registerSessionIpcHandlers } = require("../../dist/src/main/session-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { registerFileExplorerIpc } = require("../../dist/src/main/file-explorer-ipc.js")
const { insertProjectWorkspace } = require("../../dist/src/main/workspace-store.js")
const { SESSION_IPC_CHANNELS: channels, STARTUP_DATA_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")
const model = { providerId: "p", protocol: "responses", modelId: "m", name: "本机测试模型", reasoningLevel: "medium" }
const alternateModel = { ...model, modelId: "alternate", name: "短上下文模型" }
const firstUsage = { inputTokens: 8000, cacheReadTokens: 2000, cacheWriteTokens: 1000, outputTokens: 15 }
const alternateUsage = { inputTokens: 6000, cacheReadTokens: 4000, cacheWriteTokens: 2000, outputTokens: 15 }
let providerSupportsReasoning = true
let window, profile, failed = false
const rendererErrors = []
const failures = []
const modelUserInputs = []
let historyQueries = 0
let releaseTitle
const titleGate = new Promise((done) => { releaseTitle = done })
let releaseLoop
const loopGate = new Promise((done) => { releaseLoop = done })
let releaseAnswer
const answerGate = new Promise((done) => { releaseAnswer = done })
/** 清理结束后统一退出，避免窗口销毁时提前以成功状态结束测试。 */
app.on("window-all-closed", () => {})
/** @param predicate 等待的观察条件。 @returns 条件在十秒内满足。 */
async function until(predicate) {
  const deadline = Date.now() + 10000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Electron 页面验证等待超时")
    await new Promise((done) => setTimeout(done, 20))
  }
}
/** @param script Renderer 主世界的 DOM 操作。 @returns 执行结果。 */
const evaluate = (script) => window.webContents.executeJavaScript(script)
/** @returns 输入框下各项用量的可见文字，保留展示顺序。 */
const readUsage = () => evaluate(`["context", "cache", "turns", "tools"].flatMap(metric => {
  const node = document.querySelector('[data-usage-metric="' + metric + '"]')
  return node ? [node.textContent] : []
})`)
/** @param label 输入框名称。 @param text 输入内容。 @returns React 输入事件处理完成。 */
async function type(label, text) {
  await evaluate(`(() => {
    const node = document.querySelector('.composer-editor[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']')
    node.focus()
    window.getSelection().selectAllChildren(node)
    document.execCommand('insertText', false, ${JSON.stringify(text)})
  })()`)
}
/** @param name 截图文件名。 @returns 样式过渡完成后的实际窗口截图已写入 dist。 */
async function copyScreenshot(name) {
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  await writeFile(join(process.cwd(), "dist", name + ".png"), (await window.webContents.capturePage()).toPNG())
}
/** @returns 真实 Renderer 操作与缓存命中验证完成。 */
async function main() {
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  profile = await mkdtemp(join(tmpdir(), "nicode-renderer-electron-"))
  app.setPath("userData", join(profile, "electron"))
  const paths = await initializeConfigFiles(profile)
  await app.whenReady()
  const global = {
    resolveProjectContext: () => ({ workspaceInfo: "test", resolveCurrentBaseline: async () => ({
      agentsmd: { path: join(profile, "AGENTS.md"), hash: "test", content: "test" },
      skills: { content: "", entries: [], descriptions: {} }, mcp: [],
    }) }),
    estimateSkillTokens: () => 0, listToolDefinitions: () => [],
    executeTool: async () => { throw new Error("unexpected tool") },
    /** 对话展示测试使用足够大的窗口，避免进入另有专门测试的 Summary 压缩流程。 */
    createTurnModelAdapter: async (selectedModel) => ({  contextWindow: 256000, maxOutputTokens: 32000, stream: async function* (request, _signal, options) {
      if (options?.timeoutMs !== undefined) {
        await titleGate
        yield { type: "block_start", index: 0, blockType: "text" }
        yield { type: "block_end", index: 0, block: { type: "text", text: '{"title":"真实页面标题"}' } }
        yield { type: "stream_end", completion: "finished" }
        return
      }
      modelUserInputs.push(...(request.context.history?.events.filter((event) => event.type === "user/message") ?? []))
      await loopGate
      yield { type: "block_start", index: 0, blockType: "thinking" }
      yield { type: "block_delta", index: 0, delta: { type: "thinking", text: "本机思考过程" } }
      yield { type: "block_end", index: 0, block: { type: "thinking", text: "本机思考过程" } }
      yield { type: "block_start", index: 1, blockType: "text" }
      yield { type: "block_delta", index: 1, delta: { type: "text", text: "本机流式正文" } }
      await answerGate
      yield { type: "block_end", index: 1, block: { type: "text", text: "本机流式正文" } }
      yield { type: "block_start", index: 2, blockType: "text" }
      yield { type: "block_delta", index: 2, delta: { type: "text", text: "最终第二段" } }
      yield { type: "block_end", index: 2, block: { type: "text", text: "最终第二段" } }
      yield { type: "stream_end", completion: "finished", usage: selectedModel.modelId === alternateModel.modelId ? alternateUsage : firstUsage }
    } }),
  }
  const historyFixtures = new Map()
  const port = { handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
      if (channel === channels.getSessionData && args[0] === "default" && historyFixtures.has(args[1])) return historyFixtures.get(args[1])
      if (channel === channels.getSessionData) historyQueries++
      return listener(event, ...args)
    })
  } }
  registerSessionIpcHandlers(port, (projectId, sessionId, onStateChanged) => new SessionRuntime({
    sessionId, projectGroupId: projectId, sessionDirectory: join(paths.rootDir, "sessions", projectId, sessionId),
    databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, global, systemPrompt: "test", onStateChanged,
  }), (failure) => failures.push(failure), { sendSessionUpdateToRenderer: (update) => {
    if (window && !window.isDestroyed()) window.webContents.send(channels.update, update)
  } }, paths)
  registerStartupDataIpcHandlers(port, paths)
  registerFileExplorerIpc(ipcMain, paths.workspaceDatabasePath)
  ipcMain.removeHandler(STARTUP_DATA_IPC_CHANNELS.listProviders)
  ipcMain.handle(STARTUP_DATA_IPC_CHANNELS.listProviders, () => [{ providerId: "p", name: "测试", type: "custom", protocol: "responses",
    models: [{ supportsReasoning: providerSupportsReasoning, modelId: "m", name: model.name, isDefault: true, contextWindow: 256000, maxOutputTokens: 32000,
      reasoningLevels: ["low", "medium", "high"], reasoningField: { path: ["reasoning", "effort"] } },
      { supportsReasoning: false, modelId: alternateModel.modelId, name: alternateModel.name, isDefault: false, contextWindow: 128000, maxOutputTokens: 16000,
        reasoningLevels: ["medium"], reasoningField: { path: ["reasoning", "effort"] } }] }])
  window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
    preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } })
  window.webContents.on("console-message", (details) => { if (details.level === "error") rendererErrors.push(details.message) })
  new TagManager(ipcMain).register(window)
  await window.loadFile(join(process.cwd(), "dist/src/renderer/index.html"))
  assert.equal(await evaluate("isSecureContext && typeof navigator.clipboard?.writeText === 'function'"), true, "实际 Electron 页面提供剪贴板写入能力")
  /** 隔离剪贴板写入结果与失败场景，避免测试覆盖用户的系统剪贴板。 */
  await evaluate(`(() => {
    window.copiedMessages = []
    window.failClipboard = false
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => {
      if (window.failClipboard) throw new Error('注入剪贴板写入失败')
      window.copiedMessages.push(text)
    } })
  })()`)
  await until(() => evaluate(`document.querySelector('.composer-editor[aria-label="任务描述"]') !== null`))
  assert.deepEqual(await readUsage(), [], "新聊天页不显示会话用量")
  const sendAppearance = `(() => {
    const button = document.querySelector('.send-button'), style = getComputedStyle(button)
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const color = (value) => { probe.style.color = value; return getComputedStyle(probe).color }
    const result = { disabled: button.disabled, background: style.backgroundColor, foreground: style.color, opacity: style.opacity,
      accent: color('var(--accent)'), onAccent: color('var(--on-accent)'), mutedSurface: color('var(--surface-muted)'), muted: color('var(--muted)') }
    probe.remove()
    return result
  })()`
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  const disabledSend = await evaluate(sendAppearance)
  assert.equal(disabledSend.disabled, true, "空草稿时发送不可用")
  assert.equal(disabledSend.background, disabledSend.mutedSurface, "不可用发送按钮使用次级表面")
  assert.equal(disabledSend.foreground, disabledSend.muted, "不可用发送按钮保留可读前景")
  assert.equal(disabledSend.opacity, '1', "不可用发送按钮不整体降低透明度")
  await type("任务描述", "第一条真实页面消息")
  await until(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`))
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  const enabledSend = await evaluate(sendAppearance)
  assert.equal(enabledSend.background, enabledSend.accent, "可用发送按钮使用主操作底色")
  assert.equal(enabledSend.foreground, enabledSend.onAccent, "可用发送按钮使用主操作前景")
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await until(() => evaluate(`document.querySelector('.user-bubble')?.textContent === '第一条真实页面消息'`))
  await until(() => evaluate(`Boolean(document.querySelector('.session-name[title="新对话"]'))`))
  releaseTitle()
  await until(() => evaluate(`Boolean(document.querySelector('.session-name[title="真实页面标题"]'))`))
  assert.equal(await evaluate("document.querySelector('.user-label')"), null, "移除用户消息上方的你字")
  window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 })
  await evaluate("document.activeElement.blur()")
  await until(() => evaluate("getComputedStyle(document.querySelector('.user-message-actions')).opacity === '0'"))
  const userPoint = await evaluate("(() => { const rect = document.querySelector('.user-bubble').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  window.webContents.sendInputEvent({ type: "mouseMove", ...userPoint })
  await until(() => evaluate("getComputedStyle(document.querySelector('.user-message-actions')).opacity === '1'"))
  await evaluate("document.querySelector('.user-message .message-copy-button').click()")
  await until(() => evaluate("document.querySelector('.user-message .message-copy-feedback').textContent === '已复制'"))
  assert.equal(await evaluate("window.copiedMessages.at(-1)"), "第一条真实页面消息", "复制用户消息原文")
  await evaluate("window.failClipboard = true; document.querySelector('.user-message .message-copy-button').click()")
  await until(() => evaluate("document.querySelector('.user-message .message-copy-error')?.textContent === '复制失败，请重试'"))
  await evaluate("window.failClipboard = false; document.querySelector('.user-message .message-copy-button').click()")
  await until(() => evaluate("window.copiedMessages.length === 2"))
  window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 })
  await evaluate("document.querySelector('.user-message .message-copy-button').focus()")
  await until(() => evaluate("getComputedStyle(document.querySelector('.user-message-actions')).opacity === '1'"))
  assert.equal(await evaluate("document.activeElement.matches('.message-copy-button')"), true, "键盘聚焦时用户复制操作可见")
  await until(() => evaluate(`document.querySelector('[aria-label="停止"]')?.disabled === false`))
  assert.equal(await evaluate("document.querySelectorAll('.chat-footer .send-button').length"), 1, "运行中只显示一个发送或停止控件")
  assert.equal(await evaluate(`(() => {
    const button = document.querySelector('.chat-footer .send-button'), style = getComputedStyle(button), rect = button.getBoundingClientRect()
    const radius = style.borderTopLeftRadius.endsWith('%') ? parseFloat(style.borderTopLeftRadius) * rect.width / 100 : parseFloat(style.borderTopLeftRadius)
    button.dataset.testIdentity = 'same-button'
    return Math.abs(rect.width - rect.height) < 1 && radius >= rect.width / 2 - 0.5
  })()`), true, "运行中操作按钮为圆形")
  await type("消息内容", "  \n  ")
  assert.equal(await evaluate(`document.querySelector('[aria-label="停止"]')?.disabled === false`), true, "仅空白内容仍显示可用停止操作")
  const route = await evaluate(`location.hash`)
  await type("消息内容", "排队中的真实页面消息")
  await until(() => evaluate(`document.querySelector('[aria-label="加入队列"]')?.disabled === false`))
  assert.equal(await evaluate(`document.querySelector('[aria-label="加入队列"]').dataset.testIdentity`), "same-button", "输入变化时保持同一操作按钮和焦点身份")
  await evaluate(`document.querySelector('[aria-label="加入队列"]').click()`)
  await until(() => evaluate(`document.querySelector('[aria-label="待处理消息"]')?.textContent.includes('排队中的真实页面消息')`))
  assert.deepEqual(await readUsage(), ["上下文 — / 256,000 Token", "缓存命中率 —", "轮数 1", "工具调用 0"], "未开始的排队消息不计轮数")
  assert.equal(await evaluate("document.querySelector('.chat-footer .composer-caption')?.textContent"), "发送的消息将加入队列")
  await until(() => evaluate(`document.querySelector('[aria-label="停止"]')?.disabled === false`))
  assert.equal(await evaluate(`document.querySelector('[aria-label="停止"]').dataset.testIdentity`), "same-button", "加入队列并清空输入后同一按钮恢复停止")
  await evaluate(`document.querySelector('.new-chat').click()`)
  await until(() => evaluate(`document.querySelector('.composer-editor[aria-label="任务描述"]') !== null`))
  await type("任务描述", "切换保留的草稿")
  const beforeReturn = historyQueries
  await evaluate("location.hash = " + JSON.stringify(route))
  await until(() => evaluate(`document.querySelector('.chat-page') !== null`))
  assert.equal(historyQueries, beforeReturn, "缓存命中不能查询历史 IPC")
  releaseLoop()
  await until(() => evaluate(`Array.from(document.querySelectorAll('.assistant-text')).some(node => node.textContent === '本机流式正文')`))
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"复制AI回复\"]').length"), 0, "运行中的正文不显示 AI 复制入口")
  assert.equal(await evaluate("document.querySelectorAll('.message-label').length"), 1, "运行中的整轮回复只显示一个助手标题")
  assert.equal(await evaluate(`document.querySelectorAll('.turn-process, .final-answer').length`), 0, "没有 turn/end 时保持流式展示")
  releaseAnswer()
  await until(() => evaluate(`document.querySelectorAll('.user-bubble').length === 2 && document.querySelector('.session-phase')?.textContent === '准备就绪'`))
  assert.deepEqual(await readUsage(), ["上下文 11,000 / 256,000 Token", "缓存命中率 20%", "轮数 2", "工具调用 0"], "流式回复提交后显示完整输入量，排队消息开始后计入轮数")
  await until(() => evaluate(`(() => {
    const scroll = document.querySelector('.chat-scroll')
    return scroll.scrollHeight > scroll.clientHeight && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2
  })()`))
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.assistant-entry[data-turn]')).map(node => ({
    turn: Number(node.dataset.turn), parent: node.tagName,
    process: node.querySelector(':scope > .turn-process')?.tagName,
    open: node.querySelector(':scope > .turn-process')?.open,
    summary: node.querySelector(':scope > .turn-process > summary .process-title')?.textContent,
    final: node.querySelector(':scope > .final-answer')?.tagName,
    text: Array.from(node.querySelectorAll(':scope > .final-answer > .assistant-text')).map(text => text.textContent),
    innerDetails: node.querySelectorAll('.turn-process details').length,
    processText: Array.from(node.querySelectorAll('.turn-process .process-content')).map(text => text.textContent),
    statusCount: node.querySelectorAll('.turn-status').length,
    processCount: node.querySelector('.process-count')?.textContent,
    userInside: Boolean(node.querySelector('.user-bubble'))
  }))`), [1, 2].map(turn => ({ turn, parent: "DIV", process: "DETAILS", open: false, summary: "执行过程", final: "DIV",
    text: ["本机流式正文", "最终第二段"], innerDetails: 1, processText: ["本机思考过程"], statusCount: 0, processCount: "1 项", userInside: false })))
  assert.equal(await evaluate(`document.querySelectorAll('.assistant-text').length`), 4, "最终正文不重复，思考使用独立纯文本代码块")
  await evaluate(`document.querySelector('.assistant-entry[data-turn="1"] > .message-actions .message-copy-button').click()`)
  await until(() => evaluate("window.copiedMessages.at(-1) === '本机流式正文\\n\\n最终第二段'"))
  assert.equal(await evaluate("document.querySelectorAll('.assistant-entry[data-turn] > .message-actions .message-copy-button').length"), 2, "每条完整回复只提供一个正文复制入口")
  assert.equal(await evaluate("document.querySelectorAll('.message-label').length"), 2, "每轮完成回复只渲染一个助手标题")
  assert.equal(await evaluate("document.querySelectorAll('.turn-process .message-label, .turn-process [aria-label=\"复制AI回复\"]').length"), 0, "过程区域不渲染重复标题或中间正文复制入口")
  const sessionSelectorAppearance = `Array.from(document.querySelectorAll('.chat-select-label select')).map(node => {
    const style = getComputedStyle(node)
    return { value: node.value, color: style.color, background: style.backgroundColor, shadow: style.boxShadow, font: style.font, weight: style.fontWeight }
  })`
  await evaluate("document.activeElement.blur()")
  const restingSessionSelectors = await evaluate(sessionSelectorAppearance)
  assert.equal(restingSessionSelectors.every(control => control.background === "rgba(0, 0, 0, 0)"), true, "已有对话的权限与模型没有独立底色")
  assert.equal(await evaluate("document.querySelectorAll('.chat-select-label svg').length === 1 && [...document.querySelectorAll('.chat-select-label select')].every(node => getComputedStyle(node, '::picker-icon').display === 'none')"), true, "模型无图标，权限图标与文字绑定，两个入口均无箭头")
  const composerPoint = await evaluate("(() => { const rect = document.querySelector('.chat-footer .composer-editor').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  window.webContents.sendInputEvent({ type: "mouseMove", ...composerPoint })
  await copyScreenshot("electron-composer-selectors-hover")
  assert.deepEqual(await evaluate(sessionSelectorAppearance), restingSessionSelectors, "悬停对话输入框不改变权限与模型外观")
  await evaluate("document.querySelector('.chat-footer .composer-editor').focus()")
  await copyScreenshot("electron-composer-selectors-focus")
  assert.deepEqual(await evaluate(sessionSelectorAppearance), restingSessionSelectors, "聚焦对话输入框不改变权限与模型外观")
  const permissionIconPoint = await evaluate("(() => { const icon = document.querySelector('.chat-permission-select > svg').getBoundingClientRect(); const select = document.querySelector('[aria-label=\"对话权限\"]').getBoundingClientRect(); return { x: Math.round(icon.x + icon.width / 2), y: Math.round(icon.y + icon.height / 2), inside: icon.left >= select.left && icon.right <= select.right && icon.top >= select.top && icon.bottom <= select.bottom } })()")
  assert.equal(permissionIconPoint.inside, true, "权限图标位于选择控件的同一个点击区域内")
  window.webContents.focus()
  for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, x: permissionIconPoint.x, y: permissionIconPoint.y, button: "left", clickCount: 1 })
  await until(() => evaluate("document.querySelector('[aria-label=\"对话权限\"]').matches(':open')"))
  assert.equal(await evaluate(`(() => {
    const rects = [...document.querySelector('[aria-label="对话权限"]').options].map(option => option.getBoundingClientRect())
    return rects.every((rect, index) => rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && (index === 0 || rect.top - rects[index - 1].bottom >= 2))
  })()`), true, "权限菜单选项之间有留白且均在窗口内")
  await copyScreenshot("electron-permission-options")
  for (const keyCode of ["End", "Enter"]) {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode })
    window.webContents.sendInputEvent({ type: "keyUp", keyCode })
  }
  await until(() => evaluate("document.querySelector('[aria-label=\"对话权限\"]').value === 'full-access' && !document.querySelector('[aria-label=\"对话权限\"]').disabled"))
  for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, x: permissionIconPoint.x, y: permissionIconPoint.y, button: "left", clickCount: 1 })
  await until(() => evaluate("document.querySelector('[aria-label=\"对话权限\"]').matches(':open')"))
  for (const keyCode of ["Home", "Enter"]) {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode })
    window.webContents.sendInputEvent({ type: "keyUp", keyCode })
  }
  await until(() => evaluate("document.querySelector('[aria-label=\"对话权限\"]').value === 'sandbox-full-access' && !document.querySelector('[aria-label=\"对话权限\"]').disabled"))
  const modelPoint = await evaluate("(() => { const rect = document.querySelector('[aria-label=\"对话模型\"]').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, ...modelPoint, button: "left", clickCount: 1 })
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  for (const type of ["keyDown", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: "Escape" })
  await until(() => evaluate("!document.querySelector('.composer-model-panel:popover-open')"))
  await evaluate("document.querySelector('[aria-label=\"对话模型\"]').click()")
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  await evaluate("document.querySelector('[aria-label=\"设置推理等级\"]').click()")
  await until(() => evaluate("Boolean(document.querySelector('.reasoning-menu'))"))
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.reasoning-menu button > span')].map(node => node.textContent)"), ["low", "medium", "high"])
  const reasoningSessionId = await evaluate("document.querySelector('.chat-page').dataset.sessionId")
  assert.notEqual(readSessionMeta(paths.metaDatabasePath, "default", reasoningSessionId)?.currentModel.reasoningLevel, "high", "打开等级列表不修改对话设置")
  await evaluate("[...document.querySelectorAll('.reasoning-menu button')].find(node => node.querySelector('span').textContent === 'high').click()")
  await until(() => readSessionMeta(paths.metaDatabasePath, "default", reasoningSessionId)?.currentModel.reasoningLevel === "high")
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=对话模型]:not(:disabled)'))"))
  await evaluate("document.querySelector('[aria-label=对话模型]').click()")
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  await evaluate("document.querySelector('[aria-label=切换模型]').click()")
  await until(() => evaluate("Boolean(document.querySelector('.model-menu'))"))
  await evaluate("document.querySelector('.model-menu [title=\"测试 / 短上下文模型\"]').click()")
  await until(async () => (await readUsage())[0] === "上下文 11,000（来自其他模型） / 128,000 Token")
  assert.deepEqual((await readUsage()).slice(1), ["缓存命中率 20%", "轮数 2", "工具调用 0"], "切换模型时保留会话统计")
  assert.equal(await evaluate("document.querySelector('[data-usage-metric=pressure]').textContent"), "8.6%", "占用比例使用当前模型上限")
  assert.equal(await evaluate(`(() => {
    const usage = document.querySelector('.session-usage'), { top } = usage.getBoundingClientRect()
    return usage.previousElementSibling.getBoundingClientRect().bottom < top &&
      !usage.nextElementSibling && !document.querySelector('.chat-footer .composer-caption') &&
      [...usage.children].every(item => item.getBoundingClientRect().top === top)
  })()`), true, "宽窗用量保持一行且会话就绪时没有快捷键提示")
  await copyScreenshot("electron-session-usage-light")
  await evaluate("document.querySelector('[aria-label=切换深色外观]').click()")
  await evaluate("document.querySelector('[aria-label=收起侧栏]').click()")
  window.setContentSize(480, 760)
  window.webContents.setZoomFactor(1.5)
  await until(() => evaluate("innerWidth <= 320 && document.documentElement.dataset.theme === 'dark'"))
  assert.equal(await evaluate(`(() => {
    const row = document.querySelector('.session-usage'), { left, right } = row.getBoundingClientRect()
    const items = [...row.children].map(item => item.getBoundingClientRect())
    return getComputedStyle(row).fontSize === '12px' && new Set(items.map(item => item.top)).size > 1 &&
      items.every(item => item.left >= left && item.right <= right)
  })()`), true, "150% 窄窗换行显示用量，不缩小字号或溢出")
  await copyScreenshot("electron-session-usage-dark-narrow")
  window.webContents.setZoomFactor(1)
  window.setContentSize(1200, 800)
  await evaluate("document.querySelector('[aria-label=展开侧栏]').click()")
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=切换浅色外观]'))"))
  await evaluate("document.querySelector('[aria-label=切换浅色外观]').click()")
  await until(() => evaluate("innerWidth === 1200 && document.documentElement.dataset.theme === 'light'"))
  await evaluate(`document.querySelector('.turn-process > summary').click()`)
  await until(() => evaluate(`document.querySelector('.turn-process').open`))
  await evaluate(`document.querySelector('.turn-process details > summary').click()`)
  assert.equal(await evaluate(`document.querySelector('.turn-process details').open`), true, "内部小 details 仍可单独展开")
  await type("消息内容", "第三轮真实页面消息")
  assert.equal(await evaluate(`document.querySelector('.turn-process').open`), true, "草稿重绘不能关闭过程区域")
  await until(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`))
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await until(() => evaluate(`document.querySelectorAll('.turn-process').length === 3 && document.querySelector('.session-phase')?.textContent === '准备就绪'`))
  assert.deepEqual(await readUsage(), ["上下文 12,000 / 128,000 Token", "缓存命中率 26.7%", "轮数 3", "工具调用 0"], "所选模型提交用量后撤去来源提示，命中率继续按会话累计")
  assert.equal(await evaluate(`document.querySelector('.turn-process').open`), true, "后续 Turn 事件不能关闭已展开过程")
  await evaluate(`document.querySelector('.new-chat').click()`)
  await until(() => evaluate(`document.querySelector('.composer-editor[aria-label="任务描述"]')?.textContent === '切换保留的草稿'`))
  await evaluate("location.hash = " + JSON.stringify(route))
  await until(() => evaluate(`document.querySelectorAll('.user-bubble').length === 3`))
  assert.equal(historyQueries, beforeReturn)
  const originalSession = await evaluate(`document.querySelector('.chat-page').dataset.sessionId`)
  await evaluate(`document.querySelector('.turn-process > summary').click()`)
  await until(() => evaluate(`document.querySelector('.turn-process').open`))
  await evaluate(`document.querySelector('.new-chat').click()`)
  await until(() => evaluate(`document.querySelector('.composer-editor[aria-label="任务描述"]') !== null`))
  await type("任务描述", "不同对话的第一轮")
  await until(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`))
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await until(() => evaluate(`document.querySelector('.turn-process') !== null && document.querySelector('.session-phase')?.textContent === '准备就绪'`))
  assert.notEqual(await evaluate(`document.querySelector('.chat-page').dataset.sessionId`), originalSession)
  assert.deepEqual(await readUsage(), ["上下文 11,000 / 256,000 Token", "缓存命中率 20%", "轮数 1", "工具调用 0"], "会话之间不共享统计")
  assert.equal(await evaluate(`document.querySelector('.turn-process').open`), false, "不同对话的相同 Turn 编号不能继承展开状态")
  await evaluate("location.hash = " + JSON.stringify(route))
  await until(() => evaluate(`document.querySelectorAll('.turn-process').length === 3`))
  assert.equal(historyQueries, beforeReturn)
  for (const reason of ["stopped", "error", "completed"]) {
    const fixtureSession = "turn-display-" + reason
    const content = reason === "completed" ? [{ type: "thinking", text: "只有思考没有正文" }]
      : [{ type: "thinking", text: "中断前思考" }, { type: "text", text: "中断前正文" }]
    const fixtures = [
      { type: "turn/start", turn: 1, model },
      { type: "user/message", turn: 1, message: { id: "u", role: "user", content: [{ type: "text", text: "终态页面验证" }] } },
      { type: "assistant/message", turn: 1, step: 1, model, message: { id: "a", role: "assistant", content } },
      { type: "turn/end", turn: 1, reason },
    ]
    for (const [index, event] of fixtures.entries()) window.webContents.send(channels.update, { kind: "event", projectId: "default",
      sessionId: fixtureSession, event: { ...event, eventId: fixtureSession + index, sessionId: fixtureSession, seq: index + 1, createdAt: "2026-10-08T00:00:00.000Z" } })
    await evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`)
    await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, fixtureSession)))
    await until(() => evaluate(`document.querySelector('.chat-page')?.dataset.sessionId === ${JSON.stringify(fixtureSession)} && document.querySelector('.turn-process') !== null`))
    assert.deepEqual(await evaluate(`({
      open: document.querySelector('.turn-process').open,
      finalCount: document.querySelectorAll('.final-answer').length,
      text: Array.from(document.querySelectorAll('.turn-process .assistant-text, .turn-process .process-content')).map(node => node.textContent),
      statusCount: document.querySelectorAll('.turn-status').length,
      userInside: Boolean(document.querySelector('.turn-process .user-bubble'))
    })`), { open: false, finalCount: 0, text: content.map(block => block.text),
      statusCount: 0, userInside: false })
    assert.equal(await evaluate("document.querySelector('.assistant-entry[data-turn] > .message-actions')"), null, "没有最终正文时不显示最终回复复制入口")
    await evaluate("document.querySelector('.turn-process > summary').click()")
    assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"复制AI回复\"]').length"), 0, "停止、失败或没有最终正文时，展开过程也不显示 AI 复制入口")
    assert.equal(await evaluate("document.querySelectorAll('.message-label').length"), 1, "终态过程中的助手步骤不重复渲染标题")
  }
  const stepSession = "assistant-step-display"
  const flatProcessSurfaces = `Array.from(document.querySelectorAll('.chat-detail, .chat-detail > summary, .approval-actions button, .composer button')).map(node => {
    const style = getComputedStyle(node)
    return { name: node.className || node.tagName, background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow,
      borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => style['border' + side + 'Width']) }
  })`
  const stepStages = [
    { headers: 1, copies: 0, events: [
      { type: "turn/start", turn: 1, model },
      { type: "user/message", turn: 1, message: { id: "u1", role: "user", content: [{ type: "text", text: "检查项目并汇总结果" }] } },
      { type: "assistant/message", turn: 1, step: 1, model, message: { id: "a1", role: "assistant", content: [
        { type: "thinking", text: "先确认检查范围" }, { type: "text", text: "我先检查项目中的文件。" },
        { type: "tool_call", toolCallId: "shell1", name: "shell", arguments: { command: "dir" } },
      ] } },
      { type: "approval/request", turn: 1, step: 1, approvalId: "approval1", toolCallEventId: "call1", toolCallId: "shell1", blockId: "b1", toolName: "shell", arguments: { command: "dir" } },
    ] },
    { headers: 1, copies: 0, events: [
      { type: "approval/result", turn: 1, step: 1, approvalId: "approval1", decision: "denied" },
      { type: "tool/result", turn: 1, step: 1, toolCallEventId: "call1", toolCallId: "shell1", blockId: "b1", result: { status: "error", content: [{ type: "text", text: "审批已拒绝" }], error: { source: "tool", code: "APPROVAL_DENIED", message: "审批已拒绝" } } },
      { type: "assistant/block_start", turn: 1, step: 2, blockId: "b2", index: 0, blockType: "text" },
      { type: "assistant/block_delta", turn: 1, step: 2, blockId: "b2", delta: { type: "text", text: "改用文件读取工具继续检查。" } },
    ] },
    { headers: 1, copies: 0, events: [
      { type: "assistant/block_end", turn: 1, step: 2, blockId: "b2", index: 0, block: { type: "text", text: "改用文件读取工具继续检查。" } },
      { type: "assistant/message", turn: 1, step: 2, model, message: { id: "a2", role: "assistant", content: [
        { type: "text", text: "改用文件读取工具继续检查。" }, { type: "tool_call", toolCallId: "read1", name: "read", arguments: { path: "README.md" } },
      ] } },
      { type: "tool/result", turn: 1, step: 2, toolCallEventId: "call2", toolCallId: "read1", blockId: "b3", result: { status: "success", content: [{ type: "text", text: "文件检查完成" }] } },
      { type: "assistant/message", turn: 1, step: 3, model, message: { id: "a3", role: "assistant", content: [
        { type: "text", text: "**检查完成**，这是最终结果。" }, { type: "text", text: "仅复制这两段最终正文。" },
      ] } },
    ] },
    { headers: 1, copies: 1, events: [{ type: "turn/end", turn: 1, reason: "completed" }] },
    { headers: 2, copies: 1, events: [
      { type: "turn/start", turn: 2, model },
      { type: "user/message", turn: 2, message: { id: "u2", role: "user", content: [{ type: "text", text: "继续检查下一项" }] } },
      { type: "assistant/message", turn: 2, step: 1, model, message: { id: "a4", role: "assistant", content: [{ type: "text", text: "正在检查下一项。" }] } },
      { type: "assistant/block_start", turn: 2, step: 2, blockId: "b4", index: 0, blockType: "thinking" },
    ] },
    { headers: 2, copies: 1, events: [{ type: "turn/end", turn: 2, reason: "stopped" }] },
  ]
  let stepSeq = 0
  for (const [index, stage] of stepStages.entries()) {
    for (const event of stage.events) {
      stepSeq++
      window.webContents.send(channels.update, { kind: "event", projectId: "default", sessionId: stepSession,
        event: { ...event, eventId: stepSession + stepSeq, sessionId: stepSession, seq: stepSeq, createdAt: "2026-10-24T00:00:00.000Z" } })
    }
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    if (index === 0) {
      await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, stepSession)))
      await until(() => evaluate("document.querySelector('.chat-page')?.dataset.sessionId === 'assistant-step-display' && document.querySelector('.tool-detail') !== null"))
      assert.equal(await evaluate("document.querySelectorAll('.chat-messages .approval-card, .approval-popover').length"), 0, "请求不进入执行过程，非运行态也不弹出审批")
    }
    assert.equal(await evaluate("document.querySelectorAll('.message-label').length"), stage.headers, "工具、审批和后续模型步骤按 Turn 只显示一次标题，阶段 " + index)
    assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"复制AI回复\"]').length"), stage.copies, "只有成功完成 Turn 的最终正文提供复制，阶段 " + index)
    assert.equal(await evaluate("document.querySelectorAll('.turn-process .message-label, .turn-process [aria-label=\"复制AI回复\"]').length"), 0, "中间过程没有标题和复制入口")
    assert.equal(await evaluate("document.querySelectorAll('.turn-status').length"), 0, "完成、停止和失败不再生成结束提示行")
    window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 })
    await evaluate("document.activeElement.blur(); document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
    const surfaces = await evaluate(flatProcessSurfaces)
    assert.equal(surfaces.every(surface => surface.image === 'none' && surface.shadow === 'none' && surface.borders.every(width => width === '0px')), true,
      "执行过程、内部展开入口、审批区和输入按钮不叠加边框或阴影：" + JSON.stringify(surfaces))
    assert.equal(surfaces.filter(surface => !['send-button', 'settings-primary-button', 'settings-secondary-button'].includes(surface.name)).every(surface => surface.background === 'rgba(0, 0, 0, 0)'), true,
      "执行过程、内部展开入口和辅助输入按钮保持透明：" + JSON.stringify(surfaces))
    assert.equal(await evaluate("[...document.querySelectorAll('.process-content')].every(node => node.children.length === 1 && node.firstElementChild.matches('code.language-text') && node.querySelectorAll('pre, button, .markdown-content').length === 0)"), true, "每项详情仅有一层纯文本代码块")
    if (index === 1) {
      assert.equal(await evaluate("document.querySelector('.approval-result > summary').textContent.includes('审批已拒绝')"), true, "执行过程按结果事件显示已拒绝")
      assert.equal(await evaluate("document.querySelector('.assistant-entry').firstElementChild.matches('.message-label')"), true, "助手标题位于回复的最上面")
      await evaluate("document.querySelector('.chat-scroll').scrollTop = 0")
      const disclosureAppearance = `(() => {
        const node = document.querySelector('.thinking-detail > summary'), style = getComputedStyle(node), arrow = getComputedStyle(node, '::after')
        return { color: style.color, background: style.backgroundColor, before: getComputedStyle(node, '::before').content,
          arrowOpacity: arrow.opacity, arrowOrder: arrow.order, width: node.getBoundingClientRect().width }
      })()`
      const restingDisclosure = await evaluate(disclosureAppearance)
      assert.equal(restingDisclosure.before, 'none', "左侧不再有展开指示")
      assert.equal(restingDisclosure.arrowOrder, '1', "展开指示位于文字与计数的右侧")
      assert.equal(restingDisclosure.arrowOpacity, '0', "收起时默认隐藏指示")
      assert.notEqual(restingDisclosure.color, await evaluate("getComputedStyle(document.querySelector('.assistant-text')).color"), "过程按钮文字弱于正文")
      await copyScreenshot("electron-process-disclosure-rest")
      const thinkingPoint = await evaluate("(() => { const rect = document.querySelector('.thinking-detail > summary').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
      window.webContents.sendInputEvent({ type: "mouseMove", ...thinkingPoint })
      await until(() => evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary'), '::after').opacity === '1'"))
      const hoveredDisclosure = await evaluate(disclosureAppearance)
      assert.notEqual(hoveredDisclosure.color, restingDisclosure.color, "悬停时文字变亮")
      assert.equal(hoveredDisclosure.background, 'rgba(0, 0, 0, 0)', "悬停不增加按钮底色")
      assert.equal(hoveredDisclosure.width, restingDisclosure.width, "指示显隐不引起按钮或文字位移")
      await copyScreenshot("electron-process-disclosure-hover")
      window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 })
      await until(() => evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary'), '::after').opacity === '0'"))
      await evaluate("document.querySelector('.thinking-detail > summary').focus()")
      await until(() => evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary'), '::after').opacity === '1'"))
      for (const type of ["keyDown", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: "Space" })
      await until(() => evaluate("document.querySelector('.thinking-detail').open"))
      assert.equal(await evaluate("document.querySelector('.thinking-detail .process-content code').textContent"), "先确认检查范围", "键盘展开后可阅读完整思考原文")
      window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 })
      await evaluate("document.activeElement.blur()")
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary'), '::after').opacity"), '1', "展开后离开按钮仍保留收起指示")
      await copyScreenshot("electron-turn-running")
      window.setContentSize(640, 760)
      await until(() => evaluate("innerWidth === 640"))
      await copyScreenshot("electron-turn-running-narrow")
      assert.equal(await evaluate("document.querySelector('.chat-scroll').scrollWidth <= document.querySelector('.chat-scroll').clientWidth"), true, "多步回复在窄窗口不横向溢出")
      window.setContentSize(1200, 800)
      await until(() => evaluate("innerWidth === 1200"))
    }
    if (index === 3) {
      await evaluate("document.querySelector('.turn-process > summary').click()")
      await until(() => evaluate("document.querySelector('.turn-process').open"))
      assert.equal(await evaluate("document.querySelectorAll('.turn-process .assistant-entry').length"), 2, "前两个模型步骤完整保留在执行过程内")
      await evaluate("document.querySelector('[aria-label=\"复制AI回复\"]').click()")
      await until(() => evaluate("window.copiedMessages.at(-1) === '**检查完成**，这是最终结果。\\n\\n仅复制这两段最终正文。'"))
      await evaluate("document.querySelector('.thinking-detail > summary').click(); document.querySelector('.tool-detail > summary').click()")
      assert.equal(await evaluate("document.querySelector('.tool-detail .process-content code').textContent"), '{\n  "command": "dir"\n}', "工具参数以原始 JSON 代码块呈现")
      await copyScreenshot("electron-turn-final")
      await evaluate("document.querySelector('[aria-label=\"切换深色外观\"]').click()")
      await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
      await evaluate("document.querySelector('.chat-scroll').scrollTop = 0; document.querySelector('.thinking-detail > summary').click()")
      await until(() => evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary'), '::after').opacity === '0'"))
      const darkRest = await evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary')).color")
      await copyScreenshot("electron-turn-final-dark")
      const darkPoint = await evaluate("(() => { const rect = document.querySelector('.thinking-detail > summary').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
      window.webContents.sendInputEvent({ type: "mouseMove", ...darkPoint })
      await until(() => evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary'), '::after').opacity === '1'"))
      assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary')).color"), darkRest, "深色悬停也提高文字亮度")
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.thinking-detail > summary')).backgroundColor"), 'rgba(0, 0, 0, 0)', "深色悬停不增加底色")
      await copyScreenshot("electron-process-disclosure-hover-dark")
      window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 })
      await evaluate("document.querySelector('[aria-label=\"切换浅色外观\"]').click()")
      await until(() => evaluate("document.documentElement.dataset.theme === 'light'"))
    }
  }
  /** 本地事件夹具使用真实订阅入口；返回累计事件用于历史恢复验证。 */
  const mergedToolHistory = []
  const mergedToolSession = "merged-tool-display"
  /** @param entries 当前批次事件。 @returns 页面已接收并绘制本批次事件。 */
  async function pushToolEvents(entries) {
    for (const entry of entries) {
      const event = { ...entry, eventId: mergedToolSession + (mergedToolHistory.length + 1), sessionId: mergedToolSession,
        seq: mergedToolHistory.length + 1, createdAt: "2026-11-02T00:00:00.000Z" }
      mergedToolHistory.push(event)
      window.webContents.send(channels.update, { kind: "event", projectId: "default", sessionId: mergedToolSession, event })
    }
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  }
  /** @param id 调用 ID。 @param path 参数路径。 @returns 同名工具调用块。 */
  const toolBlock = (id, path) => ({ type: "tool_call", toolCallId: id, name: "read", arguments: { path } })
  /** @param turn 轮次。 @param step 模型步骤。 @param id 调用 ID。 @param text 结果正文。 @returns 成功结果事件。 */
  const toolResult = (turn, step, id, text) => ({ type: "tool/result", turn, step, toolCallId: id, toolCallEventId: "end-" + id,
    blockId: "block-" + id, result: { status: "success", content: [{ type: "text", text }] } })
  /** @returns 当前所有调用区域及独立结果区域的可比较展示快照。 */
  async function toolSnapshot() {
    return evaluate(`({ tools: [...document.querySelectorAll('.tool-detail')].map(node => ({
      summary: node.querySelector('summary').textContent, content: [...node.querySelectorAll('code')].map(code => code.textContent),
      nested: node.querySelectorAll('details').length, error: node.querySelector('.chat-error')?.textContent ?? null })),
      standalone: [...document.querySelectorAll('.chat-detail:not(.tool-detail)')].filter(node => node.querySelector(':scope > summary')?.textContent.startsWith('工具结果')).map(node => node.textContent),
      counts: [...document.querySelectorAll('.process-count')].map(node => node.textContent) })`)
  }
  await pushToolEvents([
    { type: "turn/start", turn: 1, model },
    { type: "assistant/block_start", turn: 1, step: 1, blockId: "block-shared", index: 0, blockType: "tool_call" },
    { type: "assistant/block_delta", turn: 1, step: 1, blockId: "block-shared", delta: { type: "tool_call", toolCallId: "shared", nameDelta: "read", argumentsDelta: '{"path":' } },
  ])
  await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, mergedToolSession)))
  await until(() => evaluate("document.querySelector('.chat-page')?.dataset.sessionId === 'merged-tool-display' && Boolean(document.querySelector('.tool-detail'))"))
  assert.deepEqual((await readUsage()).slice(1), ["缓存命中率 —", "轮数 1", "工具调用 0"], "流式工具片段尚未计入调用数")
  assert.equal(await evaluate("document.querySelector('.tool-detail').open"), false)
  await evaluate("window.originalToolNode = document.querySelector('.tool-detail'); window.originalToolNode.querySelector('summary').focus()")
  for (const type of ["keyDown", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: "Space" })
  await until(() => evaluate("window.originalToolNode.open"))
  await pushToolEvents([
    { type: "assistant/block_end", turn: 1, step: 1, blockId: "block-shared", index: 0, block: toolBlock("shared", "first.ts") },
    { type: "assistant/message", turn: 1, step: 1, model, usage: firstUsage, message: { id: "tools1", role: "assistant", content: [toolBlock("shared", "first.ts"), toolBlock("second", "second.ts")] } },
    toolResult(1, 1, "second", "第二调用先返回"),
  ])
  assert.equal((await readUsage())[3], "工具调用 2", "权威回复中的调用只统计一次，工具结果不增加次数")
  assert.equal(await evaluate("document.querySelector('.tool-detail') === window.originalToolNode && window.originalToolNode.open"), true, "权威消息不重建已展开的调用区域")
  assert.equal(await evaluate("document.querySelectorAll('.tool-detail')[1].open"), false, "结果不自动展开工具")
  assert.deepEqual((await toolSnapshot()).tools.map(tool => tool.content), [
    ['{\n  "path": "first.ts"\n}'], ['{\n  "path": "second.ts"\n}', "第二调用先返回"],
  ])
  const longResult = "第一调用原文 <script>window.toolInjected=true</script> **不解析**\n" + "长结果".repeat(500)
  await pushToolEvents([toolResult(1, 1, "shared", longResult)])
  assert.equal(await evaluate("document.querySelector('.tool-detail') === window.originalToolNode && window.originalToolNode.open && document.activeElement === window.originalToolNode.querySelector('summary')"), true, "追加结果保留原节点、展开状态及焦点")
  assert.deepEqual((await toolSnapshot()).standalone, [], "配对结果没有独立展开项")
  assert.equal(await evaluate("document.querySelector('.tool-detail .tool-result-content code').textContent"), longResult)
  assert.equal(await evaluate("Boolean(window.toolInjected) || Boolean(document.querySelector('.tool-detail script, .tool-detail strong'))"), false, "结果保持纯文本")
  assert.equal((await toolSnapshot()).tools.every(tool => tool.nested === 0), true, "结果不嵌套展开区域")
  await copyScreenshot("tool-results-merged-light")
  await evaluate("document.querySelector('[aria-label=\"切换深色外观\"]').click()")
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
  window.setContentSize(640, 760)
  await until(() => evaluate("innerWidth === 640"))
  assert.equal(await evaluate("document.querySelector('.chat-scroll').scrollWidth <= document.querySelector('.chat-scroll').clientWidth"), true, "长结果在窄窗无页面横向溢出")
  await copyScreenshot("tool-results-merged-dark-narrow")
  window.setContentSize(1200, 800)
  await evaluate("document.querySelector('[aria-label=\"切换浅色外观\"]').click()")
  await until(() => evaluate("document.documentElement.dataset.theme === 'light' && innerWidth === 1200"))
  await pushToolEvents([
    { type: "assistant/message", turn: 1, step: 2, model, message: { id: "tools2", role: "assistant", content: [toolBlock("shared", "next-step.ts")] } },
    { ...toolResult(1, 2, "shared", "失败结果正文"), result: { status: "error", content: [{ type: "text", text: "失败结果正文" }], error: { source: "tool", code: "TEST", message: "失败错误信息" } } },
    { type: "assistant/message", turn: 1, step: 3, model, message: { id: "tools3", role: "assistant", content: [toolBlock("missing", "missing.ts")] } },
    toolResult(1, 3, "orphan", "无法配对的结果"),
    { type: "turn/end", turn: 1, reason: "stopped" },
    { type: "turn/start", turn: 2, model },
    { type: "assistant/message", turn: 2, step: 1, model, message: { id: "tools4", role: "assistant", content: [toolBlock("shared", "next-turn.ts")] } },
    toolResult(2, 1, "shared", "第二轮独立结果"),
    { type: "turn/end", turn: 2, reason: "error" },
    { type: "turn/start", turn: 3, model },
    { type: "assistant/message", turn: 3, step: 1, model, message: { id: "tools5", role: "assistant", content: [toolBlock("done", "done.ts")] } },
    toolResult(3, 1, "done", "完成轮次结果"),
    { type: "turn/end", turn: 3, reason: "completed" },
  ])
  const mergedSnapshot = await toolSnapshot()
  assert.deepEqual(mergedSnapshot.tools.map(tool => tool.content.at(-1)), [longResult, "第二调用先返回", "失败结果正文", '{\n  "path": "missing.ts"\n}', "第二轮独立结果", "完成轮次结果"])
  assert.equal(mergedSnapshot.tools[2].error, "失败错误信息")
  assert.equal(mergedSnapshot.tools[3].summary, "工具：read", "无结果不虚构终态")
  assert.equal(mergedSnapshot.standalone.length, 1)
  assert.ok(mergedSnapshot.standalone[0].includes("无法配对的结果"))
  assert.deepEqual(mergedSnapshot.counts, ["4 项", "1 项", "1 项"], "过程项计数不包含已经合并的结果")
  await evaluate("location.hash = " + JSON.stringify(route))
  await until(() => evaluate("document.querySelector('.chat-page')?.dataset.sessionId === " + JSON.stringify(originalSession)))
  await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, mergedToolSession)))
  await until(() => evaluate("document.querySelectorAll('.tool-detail').length === 6"))
  assert.deepEqual(await toolSnapshot(), mergedSnapshot, "缓存恢复后的工具结果展示一致")
  const historySession = "merged-tool-history"
  historyFixtures.set(historySession, { projectId: "default", sessionId: historySession, kind: "ordinary",
    summary: { name: "工具合并历史", updatedAt: "2026-11-02T00:00:00.000Z", sessionId: historySession },
    events: mergedToolHistory.map(event => ({ ...event, sessionId: historySession })), latestSeq: mergedToolHistory.length,
    control: { phase: "idle", throughSeq: mergedToolHistory.length, currentTurn: 3, revision: 1, currentModel: model,
      sandboxMode: "sandbox-full-access", pendingMessages: [], discardedMessages: [] } })
  await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, historySession)))
  await until(() => evaluate("document.querySelector('.chat-page')?.dataset.sessionId === 'merged-tool-history' && document.querySelectorAll('.tool-detail').length === 6"))
  assert.deepEqual(await toolSnapshot(), mergedSnapshot, "历史 IPC 一次加载和实时逐条推送展示一致")
  assert.deepEqual(await readUsage(), ["上下文 11,000 / 256,000 Token", "缓存命中率 20%", "轮数 3", "工具调用 6"], "历史恢复完整统计，后续未报告用量的消息保留最近已知输入")
  await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, mergedToolSession)))
  await until(() => evaluate("document.querySelector('.chat-page')?.dataset.sessionId === 'merged-tool-display'"))
  await pushToolEvents([
    { type: "turn/start", turn: 4, model },
    { type: "assistant/message", turn: 4, step: 1, model, message: { id: "ambiguous", role: "assistant", content: [toolBlock("duplicate", "a.ts"), toolBlock("duplicate", "b.ts"), toolBlock("duplicate-result", "c.ts")] } },
    toolResult(4, 1, "duplicate", "调用身份歧义"),
    toolResult(4, 1, "duplicate-result", "结果身份歧义一"),
    toolResult(4, 1, "duplicate-result", "结果身份歧义二"),
  ])
  const ambiguousSnapshot = await toolSnapshot()
  assert.equal(ambiguousSnapshot.standalone.length, 4, "歧义结果全部保留独立展示")
  assert.equal(ambiguousSnapshot.tools.slice(-3).every(tool => tool.content.length === 1), true, "不把歧义结果挂到任一调用")
  const finalOnlySession = "final-only-display"
  const finalOnlyEvents = [
    { type: "turn/start", turn: 1, model },
    { type: "user/message", turn: 1, message: { id: "u", role: "user", content: [{ type: "text", text: "直接回答" }] } },
    { type: "assistant/message", turn: 1, step: 1, model, message: { id: "a", role: "assistant", content: [{ type: "text", text: "只有最终正文" }] } },
    { type: "turn/end", turn: 1, reason: "completed" },
  ]
  for (const [index, event] of finalOnlyEvents.entries()) window.webContents.send(channels.update, { kind: "event", projectId: "default", sessionId: finalOnlySession,
    event: { ...event, eventId: finalOnlySession + index, sessionId: finalOnlySession, seq: index + 1, createdAt: "2026-10-24T00:00:00.000Z" } })
  await evaluate("new Promise(resolve => requestAnimationFrame(resolve))")
  await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, finalOnlySession)))
  await until(() => evaluate("document.querySelector('.final-answer')?.textContent === '只有最终正文'"))
  assert.equal(await evaluate("document.querySelectorAll('.turn-process, .turn-status').length"), 0, "只有最终正文时不显示空执行过程或结束提示")
  assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"复制AI回复\"]').length"), 1, "删除结束提示不影响最终回答的识别与复制入口")
  const changes = [
    { path: "src/example.ts", changeType: "modified", stats: { additions: 1, deletions: 1 },
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-const before = 1", "+const after = 2", "\\ No newline at end of file"] }] },
    { path: "empty.txt", changeType: "created", stats: { additions: 0, deletions: 0 }, hunks: [] },
    { path: "created.txt", changeType: "created", stats: { additions: 1, deletions: 0 },
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+new fixture text"] }] },
    { path: "deleted.txt", changeType: "deleted", stats: { additions: 0, deletions: 1 },
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ["-old fixture text"] }] },
  ]
  window.webContents.send(channels.update, { kind: "event", projectId: "default", sessionId: finalOnlySession,
    event: { type: "turn/file_changes", turn: 1, files: changes, eventId: "browser-file-event", sessionId: finalOnlySession, seq: 5, createdAt: "2026-10-24T00:00:00.000Z" } })
  await until(() => evaluate("document.querySelectorAll('.turn-file-changes button').length === 4"))
  assert.equal(await evaluate("document.querySelector('.final-answer').nextElementSibling.querySelector('.turn-file-changes') !== null"), true)
  await evaluate("document.querySelector('.turn-file-changes button').click()")
  await until(() => evaluate("document.querySelector('.chat-browser-diff diffs-container')?.shadowRoot?.textContent.includes('const after')"))
  await evaluate("document.querySelector('.turn-file-changes button').click()")
  assert.equal(await evaluate("document.querySelectorAll('.chat-browser-tab').length"), 1)
  await evaluate("document.querySelectorAll('.turn-file-changes button')[1].click()")
  await until(() => evaluate("document.querySelector('.chat-browser-diff')?.textContent.includes('无文本差异')"))
  for (const [index, expected] of [[2, "new fixture text"], [3, "old fixture text"]]) {
    await evaluate("document.querySelectorAll('.turn-file-changes button')[" + index + "].click()")
    await until(() => evaluate("document.querySelector('.chat-browser-diff diffs-container')?.shadowRoot?.textContent.includes(" + JSON.stringify(expected) + ")"))
  }

  const server = createServer((request, response) => {
    if (request.url === "/retry" && !allowRetry) {
      request.socket.destroy()
      return
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end("<title>本机网页" + request.url + "</title><a href='/next'>Next</a>")
  })
  let allowRetry = false
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const base = "http://127.0.0.1:" + server.address().port
    const views = () => window.contentView.children.filter((view) => view.webContents && view.webContents !== window.webContents)
    const linkedReply = [
      { type: "turn/start", turn: 2, model },
      { type: "assistant/message", turn: 2, step: 1, model, message: { id: "links", role: "assistant", content: [
        { type: "text", text: `[**网页**](${base}/from-chat)\n\n${base}/auto-link` },
      ] } },
      { type: "turn/end", turn: 2, reason: "completed" },
    ]
    for (const [index, event] of linkedReply.entries()) window.webContents.send(channels.update, {
      kind: "event", projectId: "default", sessionId: finalOnlySession,
      event: { ...event, eventId: "browser-link-" + index, sessionId: finalOnlySession, seq: index + 6, createdAt: "2026-10-24T00:00:00.000Z" },
    })
    await until(() => evaluate("document.querySelectorAll('.final-answer .markdown-content a').length === 2"))
    const mainUrl = window.webContents.getURL()
    await evaluate("document.querySelector('.browser-toggle[aria-expanded=true]').click()")
    await until(() => evaluate("document.querySelector('#chat-browser-pane').hidden"))
    await evaluate("document.querySelector('.final-answer .markdown-content a strong').click()")
    await until(() => views().some((view) => view.getVisible() && view.webContents.getURL() === base + "/from-chat"))
    await evaluate("document.querySelector('.final-answer .markdown-content a:last-child[href$=auto-link]').click()")
    await until(() => views().some((view) => view.getVisible() && view.webContents.getURL() === base + "/auto-link"))
    assert.equal(views().length, 2, "链接新建标签并保留原网页")
    assert.equal(window.webContents.getURL(), mainUrl, "聊天主窗口保持原路由")
    assert.equal(await evaluate("document.querySelectorAll('.chat-browser-tab').length"), changes.length + 2)
    for (let i = 0; i < 2; i++) await evaluate("document.querySelector('.chat-browser-tab:last-child button:last-child').click()")
    await until(() => views().length === 0)
    console.log("聊天链接：收起时自动展开、Markdown 链接、自动链接、新标签与主窗口路由通过")
    const enterAddress = async (url) => {
      await evaluate(`(() => {
        const input = document.querySelector('.chat-browser-address')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await evaluate("document.querySelector('.chat-browser-toolbar').requestSubmit()")
    }
    await evaluate("document.querySelector('[aria-label=新建网页]').click()")
    await enterAddress(base)
    await until(() => views().some((view) => view.getVisible() && view.webContents.getTitle() === "本机网页/"))
    const first = views()[0]
    const contents = first.webContents
    assert.equal(await contents.executeJavaScript("typeof window.nicodeBrowser"), "undefined")
    assert.equal(await contents.executeJavaScript("window.open('file:///blocked') === null", true), true)
    assert.equal(await contents.executeJavaScript("window.open('/popup') !== null", true), true)
    await until(() => views().some((view) => view !== first && view.webContents.getTitle() === "本机网页/popup"))
    const popup = views().find((view) => view !== first)
    await until(() => evaluate("document.querySelector('.chat-browser-tab:last-child button')?.title === '本机网页/popup'"))
    if (!popup.getVisible()) await evaluate("document.querySelector('.chat-browser-tab:last-child button').click()")
    await until(() => popup.getVisible())
    assert.equal(await popup.webContents.executeJavaScript("window.opener.location.pathname"), "/")
    assert.equal(await popup.webContents.executeJavaScript("typeof window.nicodeBrowser"), "undefined")
    await popup.webContents.executeJavaScript("setTimeout(() => window.close(), 100); true")
    await until(() => views().length === 1 && first.getVisible())
    await contents.executeJavaScript(`(() => {
      const link = document.querySelector('a')
      link.target = '_blank'
      link.click()
    })()`, true)
    await until(() => views().some((view) => view !== first && view.getVisible() && view.webContents.getTitle() === "本机网页/next"))
    await evaluate("document.querySelector('.chat-browser-tab:last-child button:last-child').click()")
    await until(() => views().length === 1 && first.getVisible())
    await contents.executeJavaScript("document.cookie = 'browser=shared'; localStorage.setItem('browser','shared')")
    await enterAddress(base + "/next")
    await until(async () => contents.getURL().endsWith("/next") && await evaluate("!document.querySelector('[aria-label=后退]')?.disabled"))
    await evaluate("document.querySelector('[aria-label=后退]').click()")
    await until(() => contents.getURL() === base + "/")
    await enterAddress(base + "/retry")
    await until(() => evaluate("document.querySelector('.chat-browser-slot [role=alert]')?.textContent.includes('网页加载失败')"))
    await until(() => !first.getVisible())
    allowRetry = true
    await evaluate("document.querySelector('[aria-label=刷新]').click()")
    await until(() => first.getVisible() && contents.getTitle() === "本机网页/retry")
    await evaluate("document.querySelector('.chat-browser-tab button').click()")
    await until(() => !first.getVisible())
    await evaluate("document.querySelectorAll('.chat-browser-tab:last-child button')[0].click()")
    await until(() => first.getVisible())
    await evaluate("document.querySelector('[aria-label=搜索工作区]').click()")
    await until(() => !first.getVisible())
    await evaluate("document.querySelector('.search-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    await until(() => first.getVisible())
    await evaluate("document.querySelector('.sidebar-more').click()")
    await until(() => evaluate("Boolean(document.querySelector('.sidebar-action-menu'))"))
    await until(() => !first.getVisible())
    await evaluate("document.querySelector('.sidebar-action-menu button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    await until(() => first.getVisible())
    for (const zoom of [1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(zoom)
      await evaluate("window.dispatchEvent(new Event('resize'))")
      await until(async () => {
        const [x, y, width, height] = await evaluate("(() => { const {x,y,width,height} = document.querySelector('.chat-browser-slot').getBoundingClientRect(); return [x,y,width,height] })()")
        const rect = first.getBounds()
        return Math.abs(rect.x - x * zoom) <= 1 && Math.abs(rect.y - y * zoom) <= 1
          && Math.abs(rect.width - width * zoom) <= 1 && Math.abs(rect.height - height * zoom) <= 1
      })
    }
    window.webContents.setZoomFactor(1)
    const secondSession = "browser-second-session"
    const historyFixture = historyFixtures.get(historySession)
    historyFixtures.set(secondSession, { ...historyFixture, sessionId: secondSession,
      summary: { ...historyFixture.summary, sessionId: secondSession },
      events: [], latestSeq: 0, control: { ...historyFixture.control, throughSeq: 0, currentTurn: undefined, currentModel: { ...model, modelId: "missing-model" } } })
    await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, secondSession)))
    await until(() => !first.getVisible())
    await until(() => evaluate("document.querySelector('.chat-page')?.dataset.sessionId === 'browser-second-session'"))
    await until(async () => (await readUsage())[2] === "轮数 0")
    assert.deepEqual(await readUsage(), ["上下文 — / — Token", "缓存命中率 —", "轮数 0", "工具调用 0"], "空历史显示零计数，缺失模型配置显示占位")
    assert.equal(await evaluate("document.querySelectorAll('.chat-browser-tab').length"), 0)
    await evaluate("document.querySelector('.browser-toggle[aria-expanded=false]').click()")
    await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"关闭 新标签页\"]'))"))
    await evaluate("document.querySelector('[aria-label=\"关闭 新标签页\"]').click()")
    await until(() => evaluate("document.querySelector('#chat-browser-pane').hidden && !document.querySelector('.chat-browser-tab')"))
    await evaluate("document.querySelector('.browser-toggle[aria-expanded=false]').click()")
    await enterAddress(base)
    await until(() => views().length === 2 && views()[1].getVisible() && views()[1].webContents.getTitle() === "本机网页/")
    assert.equal(await views()[1].webContents.executeJavaScript("document.cookie + ' ' + localStorage.getItem('browser')"), "browser=shared shared")
    await evaluate("document.querySelector('.chat-browser-tab button:last-child').click()")
    await until(() => views().length === 1)
    await until(() => evaluate("document.querySelector('.browser-toggle').getAttribute('aria-expanded') === 'false'"))
    await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, finalOnlySession)))
    await until(() => first.getVisible())
    await evaluate("document.querySelector('.chat-browser-tab:last-child button:last-child').click()")
    await until(() => contents.isDestroyed())
    assert.equal(await evaluate("document.querySelector('.browser-toggle').getAttribute('aria-expanded')"), "true")
    while (await evaluate("document.querySelectorAll('.chat-browser-tab').length > 1")) {
      await evaluate("document.querySelector('.chat-browser-tab button:last-child').click()")
    }
    await evaluate("document.querySelector('.chat-browser-tab button:last-child').click()")
    await until(() => evaluate("document.querySelector('#chat-browser-pane').hidden"))
    console.log("内置浏览器：Diff、导航、视图复用、对话隔离、共享存储、布局缩放与销毁通过")
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  const markdownSession = "markdown-display"
  const thinkingMarkdown = "**规划**\n\n- 检查 `src`\n- 验证渲染"
  const codeText = 'const value = "' + "x".repeat(180) + '"\n  console.log(value)'
  const finalMarkdown = ["**流式**", "## 验证结果", "正文含有 **粗体**、*斜体* 和 `inlineCode`。",
    "1. 第一步\n2. 第二步", "> 引用内容", "~~~ts\n" + codeText + "\n~~~",
    "| 项目 | 状态 |\n| --- | --- |\n| 渲染 | 通过 |", "- [x] 已验证\n- [ ] 待处理", "~~删除线~~",
    "[文档](https://example.com/docs)", "[无效链接](javascript:alert%281%29)", "<script>alert('raw-html')</script>"].join("\n\n")
  const markdownFixtures = [
    { type: "turn/start", turn: 1, model },
    { type: "user/message", turn: 1, message: { id: "u", role: "user", content: [{ type: "text", text: "Markdown 渲染验证" }, { type: "text", text: "保留第二段与换行" }] } },
    { type: "assistant/block_start", turn: 1, step: 1, blockId: "thinking", index: 0, blockType: "thinking" },
    { type: "assistant/block_delta", turn: 1, step: 1, blockId: "thinking", delta: { type: "thinking", text: thinkingMarkdown } },
    { type: "assistant/block_start", turn: 1, step: 1, blockId: "text", index: 1, blockType: "text" },
    { type: "assistant/block_delta", turn: 1, step: 1, blockId: "text", delta: { type: "text", text: "**流式" } },
    { type: "assistant/block_delta", turn: 1, step: 1, blockId: "text", delta: { type: "text", text: "**" } },
    { type: "assistant/block_delta", turn: 1, step: 1, blockId: "text", delta: { type: "text", text: finalMarkdown.slice("**流式**".length) } },
    { type: "assistant/block_end", turn: 1, step: 1, blockId: "text", index: 1, block: { type: "text", text: finalMarkdown } },
    { type: "assistant/block_end", turn: 1, step: 1, blockId: "thinking", index: 0, block: { type: "thinking", text: thinkingMarkdown } },
    { type: "assistant/message", turn: 1, step: 1, model, message: { id: "a", role: "assistant", content: [
      { type: "thinking", text: thinkingMarkdown }, { type: "text", text: finalMarkdown },
    ] } },
    { type: "turn/end", turn: 1, reason: "completed" },
  ]
  /**
   * 沿用实际 preload 订阅通道推送指定片段，不写入用户数据。
   * @param start 首个夹具事件的数组索引。
   * @param end 片段的结束索引，不包含该事件。
   */
  function pushMarkdownEvents(start, end) {
    for (let index = start; index < end; index++) window.webContents.send(channels.update, { kind: "event", projectId: "default",
      sessionId: markdownSession, event: { ...markdownFixtures[index], eventId: markdownSession + index,
        sessionId: markdownSession, seq: index + 1, createdAt: "2026-10-08T00:00:00.000Z" } })
  }
  pushMarkdownEvents(0, 5)
  await evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`)
  await evaluate("location.hash = " + JSON.stringify(route.replace(originalSession, markdownSession)))
  await until(() => evaluate(`document.querySelector('.chat-page')?.dataset.sessionId === 'markdown-display' && document.querySelectorAll('.markdown-content').length === 1`))
  assert.equal(await evaluate(`document.querySelector('.assistant-entry > .assistant-text .markdown-content').innerHTML`), "", "空流式块应正常显示")
  assert.equal(await evaluate("document.querySelector('.assistant-entry > .message-actions')"), null, "空正文和纯思考不显示复制按钮")
  assert.equal(await evaluate("document.querySelector('.thinking-detail .process-content code').textContent"), thinkingMarkdown, "思考保留 Markdown 标记与换行作为纯文本")
  assert.equal(await evaluate("document.querySelectorAll('.thinking-detail strong, .thinking-detail li, .thinking-detail .markdown-content').length"), 0, "思考详情不会再次解析成嵌套 Markdown 内容")
  pushMarkdownEvents(5, 6)
  await until(() => evaluate(`document.querySelector('.assistant-entry > .assistant-text .markdown-content p')?.textContent === '**流式'`))
  assert.equal(await evaluate(`document.querySelector('.assistant-entry > .assistant-text strong') === null`), true)
  assert.equal(await evaluate("document.querySelector('[aria-label=\"复制AI回复\"]')"), null, "未完成的 Markdown 正文不显示复制入口")
  pushMarkdownEvents(6, 7)
  await until(() => evaluate(`document.querySelector('.assistant-entry > .assistant-text strong')?.textContent === '流式'`))
  assert.equal(await evaluate(`document.querySelector('.turn-process') === null`), true, "Markdown 更新不应提前结束 Turn")
  assert.equal(await evaluate("document.querySelector('[aria-label=\"复制AI回复\"]')"), null, "流式更新不会提前显示复制入口")
  pushMarkdownEvents(7, markdownFixtures.length)
  await until(() => evaluate(`document.querySelector('.final-answer .markdown-content h2')?.textContent === '验证结果'`))
  assert.deepEqual(await evaluate(`(() => {
    const node = document.querySelector('.final-answer .markdown-content')
    return { heading: node.querySelector('h2')?.textContent, strong: Array.from(node.querySelectorAll('strong')).map(item => item.textContent),
      emphasis: node.querySelector('em')?.textContent, inlineCode: node.querySelector('p code')?.textContent,
      ordered: Array.from(node.querySelectorAll('ol li')).map(item => item.textContent), quote: node.querySelector('blockquote')?.textContent.trim(),
      code: node.querySelector('pre code')?.textContent, language: node.querySelector('pre code')?.className,
      cells: Array.from(node.querySelectorAll('td')).map(item => item.textContent),
      tasks: Array.from(node.querySelectorAll('input[type="checkbox"]')).map(item => ({ checked: item.checked, disabled: item.disabled })),
      deleted: node.querySelector('del')?.textContent, link: node.querySelector('a')?.getAttribute('href'),
      unsafeLink: Array.from(node.querySelectorAll('a')).find(item => item.textContent === '无效链接')?.getAttribute('href'),
      scriptCount: node.querySelectorAll('script').length, escapedHtml: node.textContent.includes("<script>alert('raw-html')</script>"),
      markdownCount: document.querySelectorAll('.markdown-content').length }
  })()`), { heading: "验证结果", strong: ["流式", "粗体"], emphasis: "斜体", inlineCode: "inlineCode", ordered: ["第一步", "第二步"],
    quote: "引用内容", code: codeText + "\n", language: "language-ts", cells: ["渲染", "通过"],
    tasks: [{ checked: true, disabled: true }, { checked: false, disabled: true }], deleted: "删除线", link: "https://example.com/docs",
    unsafeLink: "", scriptCount: 0, escapedHtml: true, markdownCount: 1 })
  await evaluate("document.querySelector('.assistant-entry[data-turn] > .message-actions .message-copy-button').click()")
  await until(() => evaluate(`window.copiedMessages.at(-1) === ${JSON.stringify(finalMarkdown)}`))
  await evaluate("document.querySelector('.user-message .message-copy-button').click()")
  await until(() => evaluate("window.copiedMessages.at(-1) === 'Markdown 渲染验证\\n保留第二段与换行'"))
  await evaluate(`document.querySelector('.turn-process > summary').click(); document.querySelector('.turn-process details > summary').click()`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.deepEqual(await evaluate(`({
    codeWhitespace: getComputedStyle(document.querySelector('.final-answer pre')).whiteSpace,
    codeScrolls: document.querySelector('.final-answer pre').scrollWidth > document.querySelector('.final-answer pre').clientWidth,
    pageFits: document.querySelector('.chat-scroll').scrollWidth <= document.querySelector('.chat-scroll').clientWidth,
    thinking: document.querySelector('.turn-process .process-content code')?.textContent })`),
    { codeWhitespace: "pre", codeScrolls: true, pageFits: true, thinking: thinkingMarkdown })
  await writeFile(join(process.cwd(), "dist/electron-markdown-preview.png"), (await window.webContents.capturePage()).toPNG())
  await evaluate("location.hash = " + JSON.stringify(route))
  await until(() => evaluate(`document.querySelectorAll('.turn-process').length === 3`))
  assert.equal(historyQueries, beforeReturn, "终态展示夹具与返回已有对话均应命中缓存")
  assert.equal(await evaluate(`Boolean(window.nicode.onSessionUpdate) && typeof require === 'undefined'`), true)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const screenshotPath = join(process.cwd(), "dist/electron-session-preview.png")
  await writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG())
  await evaluate("document.querySelector('.chat-scroll').scrollTop = document.querySelector('.chat-scroll').scrollHeight; document.activeElement.blur()")
  const finalUserPoint = await evaluate("(() => { const rect = document.querySelectorAll('.user-bubble').item(2).getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  window.webContents.sendInputEvent({ type: "mouseMove", ...finalUserPoint })
  await until(() => evaluate("getComputedStyle(document.querySelectorAll('.user-message-actions').item(2)).opacity === '1'"))
  await copyScreenshot("electron-message-copy-light")
  await evaluate("document.querySelector('.chat-footer .composer-editor').focus()")
  await copyScreenshot("electron-composer-selectors-focus-light")
  await evaluate("document.querySelector('[aria-label=\"切换深色外观\"]').click()")
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
  await copyScreenshot("electron-message-copy-dark")
  await evaluate("document.activeElement.blur()")
  const restingDarkSelectors = await evaluate(sessionSelectorAppearance)
  await evaluate("document.querySelector('.chat-footer .composer-editor').focus()")
  await copyScreenshot("electron-composer-selectors-focus-dark")
  assert.deepEqual(await evaluate(sessionSelectorAppearance), restingDarkSelectors, "深色输入框聚焦也不改变权限与模型外观")
  window.setContentSize(640, 760)
  await until(() => evaluate("innerWidth === 640"))
  window.webContents.debugger.attach("1.3")
  try {
    await window.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true })
    await until(() => evaluate("matchMedia('(pointer: coarse)').matches && [...document.querySelectorAll('.user-message-actions')].every(node => getComputedStyle(node).opacity === '1')"))
    await until(() => evaluate("[...document.querySelectorAll('.chat-detail > summary')].every(node => getComputedStyle(node, '::after').opacity === '1')"))
    assert.equal(await evaluate("document.querySelector('.chat-scroll').scrollWidth <= document.querySelector('.chat-scroll').clientWidth"), true, "窄窗口复制操作不造成横向溢出")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.chat-permission-select > svg')).display !== 'none'"), true, "窄窗口权限图标与文字一起保留")
    await copyScreenshot("electron-message-copy-touch")
  } finally {
    await window.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false })
    window.webContents.debugger.detach()
  }
  providerSupportsReasoning = false
  await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload() })
  await until(() => evaluate("Boolean(document.querySelector('.chat-page .model-trigger:not(:disabled)'))"))
  assert.equal(await evaluate("Boolean(document.querySelector('.composer-model-reasoning'))"), false, '会话隐藏非思考模型等级')
  await evaluate("document.querySelector('.model-trigger').click()")
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=设置推理等级]'))"), false)
  assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=切换模型]'))"), true)
  await verifyComposerFiles(paths)
  assert.deepEqual(failures, [])
  assert.deepEqual(rendererErrors, [])
  console.log("electron-session.test.cjs: 每 Turn 单一助手标题、多步骤与审批继续运行无 AI 复制入口、仅最终回答复制、停止/失败/无正文、Markdown、用户复制反馈与重试、触屏常显、浅深色、窄窗口、新建、Queue、折叠交互、路由缓存与草稿验证通过；历史查询 " + historyQueries + " 次")
}

/** 验证真实编辑器、文件授权、发送给模型的文本与重载后的预览。
 * @param paths 隔离夹具的数据路径。
 */
async function verifyComposerFiles(paths) {
  const projectId = "d782d218-4419-49b4-ab76-96322ef8f08c"
  const root = join(profile, "引用目录")
  await mkdir(root)
  await mkdir(join(paths.rootDir, "sessions", projectId), { recursive: true })
  await writeFile(join(root, "main.ts"), "export const fixture = true\n")
  await writeFile(join(root, "config.json"), '{"composer":true}')
  insertProjectWorkspace(paths.workspaceDatabasePath, {
    version: 1, id: projectId, name: "文件引用测试", updatedAt: new Date().toISOString(), directories: [root], sessions: [],
  })
  await new Promise((resolve) => { window.webContents.once("did-finish-load", resolve); window.webContents.reload() })
  await evaluate(`location.hash = '#/projects/${projectId}/new-chat'`)
  await until(() => evaluate("document.querySelector('.composer-editor[aria-label=任务描述]') && document.body.innerText.includes('文件引用测试')"))
  window.setContentSize(1200, 800)
  await until(() => evaluate("innerWidth === 1200"))
  await evaluate("document.querySelector('[aria-label=\"切换浅色外观\"]')?.click()")
  const editor = "document.querySelector('.composer-editor')"
  const key = (name, options = {}) => evaluate(`${editor}.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: name, bubbles: true, cancelable: true, ...options })}))`)
  const append = (text) => evaluate(`document.execCommand('insertText', false, ${JSON.stringify(text)})`)
  const count = () => evaluate("document.querySelectorAll('.composer-editor .file-reference-chip').length")
  const result = (name) => evaluate(`document.querySelector('[role=option][aria-selected=true] strong')?.textContent === ${JSON.stringify(name)}`)
  const previewContains = (text) => evaluate(`document.querySelector('.chat-browser-explorer-page:not([hidden]) diffs-container')?.shadowRoot?.querySelector('[data-code]')?.textContent.includes(${JSON.stringify(text)})`)

  await type("任务描述", "@")
  await until(() => evaluate("document.querySelectorAll('.composer-file-menu [role=option]').length === 2"))
  const selected = await evaluate("document.querySelector('.composer-file-menu [aria-selected=true]').id")
  await key("ArrowDown")
  await until(() => evaluate(`document.querySelector('.composer-file-menu [aria-selected=true]')?.id !== ${JSON.stringify(selected)}`))
  await key("Escape")
  await until(() => evaluate("!document.querySelector('.composer-file-menu')"))
  await type("任务描述", "检查 @main")
  try { await until(() => result("main.ts")) }
  catch (error) {
    const editorState = await evaluate(`({ html: ${editor}.innerHTML, focused: document.activeElement === ${editor}, selection: window.getSelection().anchorOffset, menu: document.querySelector('.composer-file-menu')?.innerText })`)
    const files = await evaluate(`window.nicodeBrowser.searchProjectFiles(${JSON.stringify(projectId)}, 'main')`).catch(String)
    throw new Error(JSON.stringify({ editorState, files }), { cause: error })
  }
  await copyScreenshot("composer-files-menu-light")
  await key("Enter", { isComposing: true })
  assert.equal(await count(), 0, "输入法确认键不选文件也不发送")
  assert.equal(await result("main.ts"), true, "组合输入确认保持当前菜单")
  await key("Enter")
  await until(async () => (await count()) === 1)
  await append("和 @config")
  await until(() => result("config.json"))
  await evaluate("document.querySelector('[role=option][aria-selected=true]').click()")
  await until(async () => (await count()) === 2)
  await new Promise((resolve) => setTimeout(resolve, 550))
  await evaluate(`(() => {
    const instance = ${editor}.editor
    instance.state.doc.descendants((node, pos) => {
      if (node.type.name === 'fileReference' && node.attrs.name === 'config.json') instance.commands.setNodeSelection(pos)
    })
  })()`)
  await key("Backspace")
  await until(async () => (await count()) === 1)
  await key("z", { ctrlKey: true })
  await until(async () => (await count()) === 2)
  await key("y", { ctrlKey: true })
  await until(async () => (await count()) === 1)
  await key("z", { ctrlKey: true })
  await until(async () => (await count()) === 2)

  const copied = await evaluate(`(() => {
    const editor = ${editor}; window.getSelection().selectAllChildren(editor)
    return new Promise(resolve => requestAnimationFrame(() => {
      const data = new DataTransfer()
      editor.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      resolve({ html: data.getData('text/html'), text: data.getData('text/plain') })
    }))
  })()`)
  const mainPath = await realpath(join(root, "main.ts"))
  const configPath = await realpath(join(root, "config.json"))
  assert.equal(copied.text, `检查 ${mainPath} 和 ${configPath} `)
  assert.match(copied.html, /data-file-reference/)
  await evaluate(`(() => {
    const data = new DataTransfer(); data.setData('text/html', ${JSON.stringify(copied.html)})
    const editor = ${editor}; editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    window.getSelection().collapseToEnd()
  })()`)
  await until(async () => (await count()) === 2)
  await key("Enter", { shiftKey: true })
  await append("普通文本 dev@example.test 和 @literal。"); await key("Escape")
  await copyScreenshot("composer-file-chips-light")
  await evaluate("document.querySelector('.composer-editor [aria-label=\"预览 main.ts\"]').click()")
  await until(() => previewContains("export const fixture = true"))
  await evaluate("document.querySelector('.composer-editor [aria-label=\"预览 main.ts\"]').click()")
  assert.equal(await evaluate("document.querySelectorAll('.chat-browser-tab').length"), 1)
  await evaluate("document.querySelector('[aria-label=\"关闭 main.ts\"]').click()")
  await until(() => evaluate("!document.querySelector('.new-chat-composer .send-button').disabled"))
  await evaluate("document.querySelector('.new-chat-composer .send-button').click()")
  await until(() => evaluate("document.querySelectorAll('.user-bubble .file-reference-chip').length === 2"))
  const expected = `检查 ${mainPath} 和 ${configPath} \n普通文本 dev@example.test 和 @literal。`
  const stored = await evaluate(`window.nicode.getSessionData(${JSON.stringify(projectId)}, document.querySelector('.chat-page').dataset.sessionId)`)
  const message = stored.events.find((event) => event.type === "user/message").message
  assert.equal(message.content[0].text, expected)
  assert.deepEqual(message.fileReferences.map(({ absolutePath, offset }) => [absolutePath, offset]),
    [[mainPath, expected.indexOf(mainPath)], [configPath, expected.indexOf(configPath)]])
  await until(() => modelUserInputs.some((event) => event.content[0].text === expected))
  assert.deepEqual(Object.keys(modelUserInputs.find((event) => event.content[0].text === expected)).sort(), ["content", "seq", "type"])

  await new Promise((resolve) => { window.webContents.once("did-finish-load", resolve); window.webContents.reload() })
  await until(() => evaluate("document.querySelectorAll('.user-bubble .file-reference-chip').length === 2"))
  window.setContentSize(640, 760)
  await until(() => evaluate("innerWidth === 640"))
  await evaluate("document.querySelector('[aria-label=\"切换深色外观\"]')?.click()")
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
  await copyScreenshot("composer-file-history-dark-narrow")
  await evaluate("document.querySelector('.user-bubble [aria-label=\"预览 config.json\"]').click()")
  await until(() => previewContains('"composer":true'))
  await evaluate("document.querySelector('.chat-browser-chat-tab').click()")
  await evaluate("document.querySelector('.user-bubble [aria-label=\"预览 config.json\"]').click()")
  await until(() => previewContains('"composer":true'))
  assert.equal(await evaluate("document.querySelectorAll('.chat-browser-tab').length"), 1, "窄窗口内再次打开同一文件仍复用标签")
  await copyScreenshot("composer-file-preview-dark-narrow")
  console.log("Composer 文件引用：菜单导航、键盘与点击插入、IME 守卫、原子删除与撤销重做、复制粘贴、纯文本发送、落盘恢复和标签复用通过")
}
void main().catch((error) => { console.error(error); failed = true }).finally(async () => {
  try {
    if (window && !window.isDestroyed()) window.destroy()
    if (profile) {
      assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
      await rm(profile, { recursive: true, force: true, maxRetries: 0 })
    }
  } catch (error) {
    if (process.platform === "win32" && ["EBUSY", "EPERM"].includes(error.code)) console.warn("Chromium 临时目录仍占用，Electron 退出后可清理：" + profile)
    else { failed = true; console.error(error) }
  } finally { app.exit(failed ? 1 : 0) }
})
