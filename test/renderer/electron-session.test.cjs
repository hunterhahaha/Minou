/** 使用真实 Electron、preload 和构建后的 React 页面进行本机交互验证，不访问网络或用户数据。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { readSessionMeta } = require("../../dist/runtime/session/src/meta-store.js")
const { SessionRuntime } = require("../../dist/runtime/agent/src/session-runtime.js")
const { registerSessionIpcHandlers } = require("../../dist/src/main/session-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { SESSION_IPC_CHANNELS: channels, STARTUP_DATA_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")
const model = { providerId: "p", protocol: "responses", modelId: "m", name: "本机测试模型", reasoningLevel: "medium" }
let window, profile, failed = false
const rendererErrors = []
const failures = []
let historyQueries = 0
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
/** @param label 输入框名称。 @param text 输入内容。 @returns React 输入事件处理完成。 */
async function type(label, text) {
  await evaluate(`(() => {
    const node = document.querySelector('textarea[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, ${JSON.stringify(text)})
    node.dispatchEvent(new Event('input', { bubbles: true }))
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
    createTurnModelAdapter: async () => ({ contextWindow: 256000, maxOutputTokens: 32000, stream: async function* () {
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
      yield { type: "stream_end", completion: "finished" }
    } }),
  }
  const port = { handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
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
  ipcMain.removeHandler(STARTUP_DATA_IPC_CHANNELS.listProviders)
  ipcMain.handle(STARTUP_DATA_IPC_CHANNELS.listProviders, () => [{ providerId: "p", name: "测试", type: "custom", protocol: "responses",
    models: [{ modelId: "m", name: model.name, isDefault: true, contextWindow: 256000, maxOutputTokens: 32000,
      reasoningLevels: ["low", "medium", "high"], reasoningField: { path: ["reasoning", "effort"] } }] }])
  window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
    preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } })
  window.webContents.on("console-message", (details) => { if (details.level === "error") rendererErrors.push(details.message) })
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
  await until(() => evaluate(`document.querySelector('textarea[aria-label="任务描述"]') !== null`))
  await type("任务描述", "第一条真实页面消息")
  await until(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`))
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await until(() => evaluate(`document.querySelector('.user-bubble')?.textContent === '第一条真实页面消息'`))
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
  await until(() => evaluate(`document.querySelector('[aria-label="加入队列"]')?.disabled === true`))
  const route = await evaluate(`location.hash`)
  await type("消息内容", "排队中的真实页面消息")
  await until(() => evaluate(`document.querySelector('[aria-label="加入队列"]')?.disabled === false`))
  await evaluate(`document.querySelector('[aria-label="加入队列"]').click()`)
  await until(() => evaluate(`document.querySelector('[aria-label="待处理消息"]')?.textContent.includes('排队中的真实页面消息')`))
  await evaluate(`document.querySelector('.new-chat').click()`)
  await until(() => evaluate(`document.querySelector('textarea[aria-label="任务描述"]') !== null`))
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
  const composerPoint = await evaluate("(() => { const rect = document.querySelector('.chat-footer textarea').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  window.webContents.sendInputEvent({ type: "mouseMove", ...composerPoint })
  await copyScreenshot("electron-composer-selectors-hover")
  assert.deepEqual(await evaluate(sessionSelectorAppearance), restingSessionSelectors, "悬停对话输入框不改变权限与模型外观")
  await evaluate("document.querySelector('.chat-footer textarea').focus()")
  await copyScreenshot("electron-composer-selectors-focus")
  assert.deepEqual(await evaluate(sessionSelectorAppearance), restingSessionSelectors, "聚焦对话输入框不改变权限与模型外观")
  const permissionIconPoint = await evaluate("(() => { const icon = document.querySelector('.chat-permission-select > svg').getBoundingClientRect(); const select = document.querySelector('[aria-label=\"对话权限\"]').getBoundingClientRect(); return { x: Math.round(icon.x + icon.width / 2), y: Math.round(icon.y + icon.height / 2), inside: icon.left >= select.left && icon.right <= select.right && icon.top >= select.top && icon.bottom <= select.bottom } })()")
  assert.equal(permissionIconPoint.inside, true, "权限图标位于选择控件的同一个点击区域内")
  window.webContents.focus()
  for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, x: permissionIconPoint.x, y: permissionIconPoint.y, button: "left", clickCount: 1 })
  await until(() => evaluate("document.querySelector('[aria-label=\"对话权限\"]').matches(':open')"))
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
  await evaluate(`document.querySelector('.turn-process > summary').click()`)
  await until(() => evaluate(`document.querySelector('.turn-process').open`))
  await evaluate(`document.querySelector('.turn-process details > summary').click()`)
  assert.equal(await evaluate(`document.querySelector('.turn-process details').open`), true, "内部小 details 仍可单独展开")
  await type("消息内容", "第三轮真实页面消息")
  assert.equal(await evaluate(`document.querySelector('.turn-process').open`), true, "草稿重绘不能关闭过程区域")
  await until(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`))
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await until(() => evaluate(`document.querySelectorAll('.turn-process').length === 3 && document.querySelector('.session-phase')?.textContent === '准备就绪'`))
  assert.equal(await evaluate(`document.querySelector('.turn-process').open`), true, "后续 Turn 事件不能关闭已展开过程")
  await evaluate(`document.querySelector('.new-chat').click()`)
  await until(() => evaluate(`document.querySelector('textarea[aria-label="任务描述"]')?.value === '切换保留的草稿'`))
  await evaluate("location.hash = " + JSON.stringify(route))
  await until(() => evaluate(`document.querySelectorAll('.user-bubble').length === 3`))
  assert.equal(historyQueries, beforeReturn)
  const originalSession = await evaluate(`document.querySelector('.chat-page').dataset.sessionId`)
  await evaluate(`document.querySelector('.turn-process > summary').click()`)
  await until(() => evaluate(`document.querySelector('.turn-process').open`))
  await evaluate(`document.querySelector('.new-chat').click()`)
  await until(() => evaluate(`document.querySelector('textarea[aria-label="任务描述"]') !== null`))
  await type("任务描述", "不同对话的第一轮")
  await until(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`))
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await until(() => evaluate(`document.querySelector('.turn-process') !== null && document.querySelector('.session-phase')?.textContent === '准备就绪'`))
  assert.notEqual(await evaluate(`document.querySelector('.chat-page').dataset.sessionId`), originalSession)
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
    assert.equal(surfaces.every(surface => surface.background === 'rgba(0, 0, 0, 0)' && surface.image === 'none' && surface.shadow === 'none' && surface.borders.every(width => width === '0px')), true,
      "执行过程、内部展开入口、审批区和输入按钮不叠加框或常驻底色：" + JSON.stringify(surfaces))
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
  await evaluate("document.querySelector('.chat-footer textarea').focus()")
  await copyScreenshot("electron-composer-selectors-focus-light")
  await evaluate("document.querySelector('[aria-label=\"切换深色外观\"]').click()")
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
  await copyScreenshot("electron-message-copy-dark")
  await evaluate("document.activeElement.blur()")
  const restingDarkSelectors = await evaluate(sessionSelectorAppearance)
  await evaluate("document.querySelector('.chat-footer textarea').focus()")
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
  assert.deepEqual(failures, [])
  assert.deepEqual(rendererErrors, [])
  console.log("electron-session.test.cjs: 每 Turn 单一助手标题、多步骤与审批继续运行无 AI 复制入口、仅最终回答复制、停止/失败/无正文、Markdown、用户复制反馈与重试、触屏常显、浅深色、窄窗口、新建、Queue、折叠交互、路由缓存与草稿验证通过；历史查询 " + historyQueries + " 次")
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
