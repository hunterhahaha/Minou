/** 使用真实 Electron、preload 和构建后的 React 页面进行本机交互验证，不访问网络或用户数据。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { SessionRuntime } = require("../../dist/runtime/agent/src/session-runtime.js")
const { registerSessionIpcHandlers } = require("../../dist/src/main/session-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { SESSION_IPC_CHANNELS: channels, STARTUP_DATA_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")
const model = { providerId: "p", protocol: "responses", modelId: "m", name: "本机测试模型" }
let window, profile
const rendererErrors = []
const failures = []
let historyQueries = 0
let releaseLoop
const loopGate = new Promise((done) => { releaseLoop = done })
let releaseAnswer
const answerGate = new Promise((done) => { releaseAnswer = done })
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
/** @returns 真实 Renderer 操作与缓存命中验证完成。 */
async function main() {
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  profile = await mkdtemp(join(tmpdir(), "nicode-renderer-electron-"))
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
  ipcMain.handle(STARTUP_DATA_IPC_CHANNELS.listProviders, () => [{ providerId: "p", name: "测试", protocol: "responses",
    models: [{ modelId: "m", name: model.name, isDefault: true, contextWindow: 256000, maxOutputTokens: 32000 }] }])
  window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
    preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } })
  window.webContents.on("console-message", (details) => { if (details.level === "error") rendererErrors.push(details.message) })
  await window.loadFile(join(process.cwd(), "dist/src/renderer/index.html"))
  await until(() => evaluate(`document.querySelector('textarea[aria-label="任务描述"]') !== null`))
  await type("任务描述", "第一条真实页面消息")
  await until(() => evaluate(`document.querySelector('[aria-label="发送消息"]')?.disabled === false`))
  await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`)
  await until(() => evaluate(`document.querySelector('.user-bubble')?.textContent === '第一条真实页面消息'`))
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
    processText: Array.from(node.querySelectorAll('.turn-process .assistant-text')).map(text => text.textContent),
    status: node.querySelector('.turn-process .turn-status')?.textContent,
    userInside: Boolean(node.querySelector('.user-bubble'))
  }))`), [1, 2].map(turn => ({ turn, parent: "DIV", process: "DETAILS", open: false, summary: "执行过程", final: "DIV",
    text: ["本机流式正文", "最终第二段"], innerDetails: 1, processText: ["本机思考过程"], status: "本轮完成", userInside: false })))
  assert.equal(await evaluate(`document.querySelectorAll('.assistant-text').length`), 6, "流式与权威消息不应重复展示")
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
      text: Array.from(document.querySelectorAll('.turn-process .assistant-text')).map(node => node.textContent),
      status: document.querySelector('.turn-process .turn-status')?.textContent,
      userInside: Boolean(document.querySelector('.turn-process .user-bubble'))
    })`), { open: false, finalCount: 0, text: content.map(block => block.text),
      status: reason === "completed" ? "本轮完成" : reason === "stopped" ? "本轮已停止" : "本轮执行失败", userInside: false })
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
    { type: "user/message", turn: 1, message: { id: "u", role: "user", content: [{ type: "text", text: "Markdown 渲染验证" }] } },
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
  await until(() => evaluate(`document.querySelector('.chat-page')?.dataset.sessionId === 'markdown-display' && document.querySelectorAll('.markdown-content').length === 2`))
  assert.equal(await evaluate(`document.querySelector('.assistant-entry > .assistant-text .markdown-content').innerHTML`), "", "空流式块应正常显示")
  assert.deepEqual(await evaluate(`({ strong: document.querySelector('.chat-detail .markdown-content strong')?.textContent,
    items: Array.from(document.querySelectorAll('.chat-detail .markdown-content li')).map(node => node.textContent) })`),
    { strong: "规划", items: ["检查 src", "验证渲染"] }, "思考块应渲染 Markdown")
  pushMarkdownEvents(5, 6)
  await until(() => evaluate(`document.querySelector('.assistant-entry > .assistant-text .markdown-content p')?.textContent === '**流式'`))
  assert.equal(await evaluate(`document.querySelector('.assistant-entry > .assistant-text strong') === null`), true)
  pushMarkdownEvents(6, 7)
  await until(() => evaluate(`document.querySelector('.assistant-entry > .assistant-text strong')?.textContent === '流式'`))
  assert.equal(await evaluate(`document.querySelector('.turn-process') === null`), true, "Markdown 更新不应提前结束 Turn")
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
    unsafeLink: "", scriptCount: 0, escapedHtml: true, markdownCount: 2 })
  await evaluate(`document.querySelector('.turn-process > summary').click(); document.querySelector('.turn-process details > summary').click()`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.deepEqual(await evaluate(`({
    codeWhitespace: getComputedStyle(document.querySelector('.final-answer pre')).whiteSpace,
    codeScrolls: document.querySelector('.final-answer pre').scrollWidth > document.querySelector('.final-answer pre').clientWidth,
    pageFits: document.querySelector('.chat-scroll').scrollWidth <= document.querySelector('.chat-scroll').clientWidth,
    thinking: document.querySelector('.turn-process .markdown-content strong')?.textContent })`),
    { codeWhitespace: "pre", codeScrolls: true, pageFits: true, thinking: "规划" })
  await writeFile(join(process.cwd(), "dist/electron-markdown-preview.png"), (await window.webContents.capturePage()).toPNG())
  await evaluate("location.hash = " + JSON.stringify(route))
  await until(() => evaluate(`document.querySelectorAll('.turn-process').length === 3`))
  assert.equal(historyQueries, beforeReturn, "终态展示夹具与返回已有对话均应命中缓存")
  assert.equal(await evaluate(`Boolean(window.nicode.onSessionUpdate) && typeof require === 'undefined'`), true)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const screenshotPath = join(process.cwd(), "dist/electron-session-preview.png")
  await writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG())
  assert.deepEqual(failures, [])
  assert.deepEqual(rendererErrors, [])
  console.log("electron-session.test.cjs: 真实页面新建、Queue、流式 Markdown、Turn 完成态、折叠交互、路由缓存与草稿保留验证通过；历史查询 " + historyQueries + " 次")
}
void main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy()
  if (profile) {
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true })
  }
  app.exit(process.exitCode ?? 0)
})
