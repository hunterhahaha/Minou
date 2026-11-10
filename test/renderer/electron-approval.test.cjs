/** 真实 Electron、preload 与 Runtime 的审批浮窗验证；使用离线工具和隔离临时数据。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { initializeConfigFiles } = require("../../dist/src/main/config-files.js")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { registerSessionIpcHandlers } = require("../../dist/src/main/session-ipc.js")
const { registerStartupDataIpcHandlers } = require("../../dist/src/main/startup-data-ipc.js")
const { SessionRuntime } = require("../../dist/runtime/agent/src/session-runtime.js")
const { SESSION_IPC_CHANNELS: channels, STARTUP_DATA_IPC_CHANNELS } = require("../../dist/src/preload/session-api.js")
const model = { providerId: "approval-provider", protocol: "responses", modelId: "approval-model", name: "离线审批模型", reasoningLevel: "medium" }
let window, profile, failed = false, toolCount = 2, failDecision = false, decisionCalls = 0
let autoReviews = 0
let holdUpdates = false
const heldUpdates = []
const failures = [], rendererErrors = []
app.on("window-all-closed", () => {})
/** @param predicate 页面观察条件。 @returns 条件在十秒内满足。 @throws Error 当观察超时。 */
async function until(predicate) {
  const deadline = Date.now() + 10000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("审批浮窗验证等待超时")
    await new Promise(done => setTimeout(done, 20))
  }
}
/** @param script Renderer 主世界脚本。 @returns 实际页面执行结果。 */
const evaluate = script => window.webContents.executeJavaScript(script)
/** @param label 输入框名称。 @param text 当前输入。 @returns React 输入更新完成。 */
async function type(label, text) {
  await evaluate(`(() => { const node = document.querySelector('.composer-editor[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
    node.focus()
    window.getSelection().selectAllChildren(node)
    document.execCommand('insertText', false, ${JSON.stringify(text)}) })()`)
}
/** @param name 输出截图名。 @returns 当前动画与布局稳定后的窗口截图已写入 dist。 */
async function screenshot(name) {
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  await new Promise(done => setTimeout(done, 100))
  await writeFile(join(process.cwd(), "dist", name + ".png"), (await window.webContents.capturePage()).toPNG())
}
/** @returns 新对话已经到达真实 Runtime 的审批等待点。 */
async function startApproval() {
  await evaluate("document.querySelector('.new-chat').click()")
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"任务描述\"]'))"))
  await type("任务描述", "检查工具审批")
  await until(() => evaluate("document.querySelector('[aria-label=\"发送消息\"]')?.disabled === false"))
  await evaluate("document.querySelector('[aria-label=\"发送消息\"]').click()")
  await until(() => evaluate("Boolean(document.querySelector('.approval-popover')) && !document.querySelector('.approval-actions .settings-primary-button').disabled"))
}
/** @returns 浮窗保持在输入框上方，内容和操作均没有溢出。 */
async function fits() {
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  const bounds = await evaluate(`(() => {
    const box = node => { const r = node.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left } }
    const dialog = document.querySelector('.approval-popover')
    return { dialog: box(dialog), composer: box(document.querySelector('.composer-anchor')), page: box(document.querySelector('.chat-page')),
      actions: box(document.querySelector('.approval-actions')), fits: dialog.scrollWidth <= dialog.clientWidth }
  })()`)
  assert.ok(bounds.dialog.bottom <= bounds.composer.top - 7, JSON.stringify(bounds))
  assert.ok(bounds.dialog.top >= bounds.page.top - 1 && bounds.actions.bottom <= bounds.dialog.bottom, JSON.stringify(bounds))
  assert.ok(bounds.dialog.left >= bounds.composer.left - 1 && bounds.dialog.right <= bounds.composer.right + 1 && bounds.fits, JSON.stringify(bounds))
}
/** @returns 审批浮窗、结果记录、重试、停止和对话恢复验证完成。 */
async function main() {
  profile = await mkdtemp(join(tmpdir(), "nicode-approval-electron-"))
  app.setPath("userData", join(profile, "electron"))
  const paths = await initializeConfigFiles(profile)
  await app.whenReady()
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  const global = {
    resolveProjectContext: () => ({ workspaceInfo: "offline", resolveCurrentBaseline: async () => ({
      agentsmd: { path: join(profile, "AGENTS.md"), hash: "test", content: "offline test" }, skills: { content: "", entries: [], descriptions: {} }, mcp: [],
    }) }),
    estimateSkillTokens: () => 0, listToolDefinitions: () => [], interruptTerminals: () => [], disposeProcessTools: async () => {},
    createTurnModelAdapter: async () => {
      let requests = 0
      const count = toolCount
      return {  contextWindow: 256000, maxOutputTokens: 32000, stream: async function* (_request, _signal, options) {
        if (options?.retry === false) {
          const approved = ++autoReviews === 1
          yield { type: "block_start", index: 0, blockType: "text" }
          yield { type: "block_end", index: 0, block: { type: "text", text: JSON.stringify({ riskLevel: "medium", approved }) } }
          yield { type: "stream_end", completion: "finished" }
          return
        }
        if (options?.timeoutMs !== undefined) return
        if (++requests === 1) {
          for (let index = 0; index < count; index++) {
            yield { type: "block_start", index, blockType: "tool_call" }
            yield { type: "block_end", index, block: { type: "tool_call", toolCallId: "offline-" + index, name: "shell", arguments: { command: "检查 " + "长参数与路径/".repeat(40) } } }
          }
          yield { type: "stream_end", completion: "tool_calls" }
        } else {
          yield { type: "block_start", index: 0, blockType: "text" }
          yield { type: "block_end", index: 0, block: { type: "text", text: "审批后的最终回答" } }
          yield { type: "stream_end", completion: "finished" }
        }
      } }
    },
    executeTool: async (name, args, context) => {
      const decision = await context.processRuntime.requestApproval(name, "工具将执行指定操作，请确认本次调用。", { ...context, validatedArguments: args })
      return decision === "approved" ? { status: "success", content: [{ type: "text", text: "离线工具完成" }] }
        : { status: "error", content: [{ type: "text", text: decision }], error: { source: "tool", code: decision, message: decision } }
    },
  }
  const port = { handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
      if (channel === channels.decideSessionApproval) {
        decisionCalls++
        if (failDecision) { failDecision = false; throw new Error("注入审批提交失败") }
      }
      return listener(event, ...args)
    })
  } }
  registerSessionIpcHandlers(port, (projectId, sessionId, onStateChanged) => new SessionRuntime({
    sessionId, projectGroupId: projectId, sessionDirectory: join(paths.rootDir, "sessions", projectId, sessionId),
    databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, global, systemPrompt: "offline", onStateChanged,
  }), error => failures.push(error), { sendSessionUpdateToRenderer: update => {
    if (holdUpdates) { heldUpdates.push(update); return }
    if (window && !window.isDestroyed()) window.webContents.send(channels.update, update)
  } }, paths)
  registerStartupDataIpcHandlers(port, paths)
  ipcMain.removeHandler(STARTUP_DATA_IPC_CHANNELS.listProviders)
  ipcMain.handle(STARTUP_DATA_IPC_CHANNELS.listProviders, () => [{ providerId: model.providerId, name: "离线测试", type: "custom", protocol: model.protocol,
    models: [{ supportsReasoning: true, modelId: model.modelId, name: model.name, isDefault: true, contextWindow: 256000, maxOutputTokens: 32000,
      reasoningLevels: ["low", "medium", "high"], reasoningField: { path: ["reasoning", "effort"] } }] }])
  window = new BrowserWindow({ show: false, width: 1200, height: 800, minWidth: 480, minHeight: 400, webPreferences: {
    preload: join(process.cwd(), "dist/src/preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } })
  window.webContents.on("console-message", details => { if (details.level === "error") rendererErrors.push(details.message) })
  await window.loadFile(join(process.cwd(), "dist/src/renderer/index.html"))
  await until(() => evaluate("Boolean(document.querySelector('.new-chat'))"))
  await startApproval()
  const route = await evaluate("location.hash")
  const firstId = await evaluate("document.querySelector('.approval-popover').dataset.approvalId")
  assert.equal(await evaluate("document.querySelectorAll('.chat-messages .approval-actions, .chat-messages .approval-card').length"), 0, "请求不在执行过程内渲染")
  assert.equal(await evaluate("document.querySelectorAll('.approval-popover').length"), 1)
  await screenshot("electron-approval-light")
  await fits()
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" })
  assert.equal(decisionCalls, 0, "Escape 不隐式批准或拒绝")
  await type("消息内容", "保留待发送草稿")
  await evaluate("document.querySelector('.new-chat').click()")
  await until(() => evaluate("!document.querySelector('.approval-popover') && Boolean(document.querySelector('[aria-label=\"任务描述\"]'))"))
  await evaluate("location.hash = " + JSON.stringify(route))
  await until(() => evaluate("Boolean(document.querySelector('.approval-popover'))"))
  assert.equal(await evaluate("document.querySelector('[aria-label=\"消息内容\"]').textContent"), "保留待发送草稿")
  await evaluate("document.querySelector('[aria-label=\"切换深色外观\"]').click()")
  await screenshot("electron-approval-dark")
  await fits()
  await evaluate("document.querySelector('[aria-label=\"切换浅色外观\"]').click()")
  window.setContentSize(640, 540)
  await type("消息内容", Array(25).fill("较长的待发送草稿").join("\n"))
  await screenshot("electron-approval-narrow")
  await fits()
  assert.equal(await evaluate(`(() => {
    const probe = document.createElement('span'); document.body.appendChild(probe)
    const color = token => { probe.style.color = 'var(' + token + ')'; return getComputedStyle(probe).color }
    const primary = getComputedStyle(document.querySelector('.approval-actions .settings-primary-button')).backgroundColor
    const secondary = getComputedStyle(document.querySelector('.approval-actions .settings-secondary-button')).backgroundColor
    const valid = primary === color('--accent') && secondary === color('--surface-muted'); probe.remove(); return valid
  })()`), true, "审批主次按钮使用已确认的操作层级")
  await evaluate("document.querySelector('.approval-actions .settings-primary-button').click(); document.querySelector('.approval-actions .settings-primary-button')?.click()")
  await until(() => evaluate(`document.querySelector('.approval-popover')?.dataset.approvalId !== ${JSON.stringify(firstId)} && Boolean(document.querySelector('.approval-popover'))`))
  assert.equal(decisionCalls, 1, "连点只提交一次决定")
  assert.equal(await evaluate("document.querySelectorAll('.approval-popover').length"), 1, "后续审批逐个呈现")
  await evaluate("document.querySelector('.approval-actions .settings-secondary-button').click()")
  await until(() => evaluate("!document.querySelector('.approval-popover') && document.querySelector('.session-phase').textContent === '准备就绪'"))
  await evaluate("document.querySelector('.turn-process > summary').click()")
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.approval-result > summary')].map(node => node.textContent)"), ["审批已批准 · shell", "审批已拒绝 · shell"])
  assert.equal(await evaluate("document.querySelectorAll('.turn-process .approval-actions, .turn-process .approval-popover').length"), 0)
  const data = await evaluate("window.nicode.getSessionData('default', document.querySelector('.chat-page').dataset.sessionId)")
  assert.deepEqual(data.events.filter(event => event.type === "approval/result").map(event => event.decision), ["approved", "denied"], "实际决定已经持久化")
  window.setContentSize(1200, 800)
  toolCount = 1
  await startApproval()
  failDecision = true
  await evaluate("document.querySelector('.approval-actions .settings-primary-button').click()")
  await until(() => evaluate("document.querySelector('.approval-popover [role=\"alert\"]')?.textContent.includes('注入审批提交失败') && !document.querySelector('.approval-actions .settings-primary-button').disabled"))
  await evaluate("document.querySelector('.approval-actions .settings-primary-button').click()")
  await until(() => evaluate("!document.querySelector('.approval-popover') && document.querySelector('.session-phase').textContent === '准备就绪'"))
  await startApproval()
  holdUpdates = true
  assert.deepEqual(await evaluate("window.nicode.decideSessionApproval('default', document.querySelector('.chat-page').dataset.sessionId, document.querySelector('.approval-popover').dataset.approvalId, 'denied')"), { accepted: true })
  await until(() => heldUpdates.some(update => update.kind === "state" && update.control.phase === "idle"))
  await evaluate("document.querySelector('.approval-actions .settings-primary-button').click()")
  await until(() => evaluate("!document.querySelector('.approval-popover') && document.querySelector('.session-phase').textContent === '准备就绪'"))
  assert.equal(await evaluate("document.querySelector('.chat-footer > .chat-error')?.textContent"), "这项审批已结束。", "失效决定通过历史查询同步已完成结果")
  await evaluate("document.querySelector('.turn-process > summary').click()")
  assert.equal(await evaluate("document.querySelector('.approval-result > summary').textContent"), "审批已拒绝 · shell", "失效请求不会覆盖真实审批结果")
  holdUpdates = false
  for (const update of heldUpdates.splice(0)) window.webContents.send(channels.update, update)
  const callsBeforeStop = decisionCalls
  await startApproval()
  await until(() => evaluate("document.querySelector('[aria-label=\"停止\"]')?.disabled === false"))
  await evaluate("document.querySelector('[aria-label=\"停止\"]').click()")
  await until(() => evaluate("!document.querySelector('.approval-popover') && document.querySelector('.session-phase').textContent === '准备就绪'"))
  await evaluate("document.querySelector('.turn-process > summary').click()")
  assert.equal(await evaluate("document.querySelector('.approval-result > summary').textContent"), "审批已取消 · shell")
  assert.equal(decisionCalls, callsBeforeStop, "停止由 Runtime 取消，前端不伪造拒绝")
  assert.equal(await evaluate("document.querySelector('.chat-footer > .chat-error')"), null, "停止流程不产生操作错误")
  await screenshot("electron-approval-result")
  await evaluate("document.querySelector('.new-chat').click()")
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"权限\"]'))"))
  await evaluate("document.querySelector('[aria-label=\"权限\"]').click()")
  await evaluate("[...document.querySelectorAll('.permission-menu button')].find(button => button.textContent === '自动审核').click()")
  await type("任务描述", "检查自动审核")
  await until(() => evaluate("document.querySelector('[aria-label=\"发送消息\"]')?.disabled === false"))
  await evaluate("document.querySelector('[aria-label=\"发送消息\"]').click()")
  await until(() => autoReviews === 1 && evaluate("document.querySelector('.session-phase')?.textContent === '准备就绪'"))
  assert.equal(await evaluate("document.querySelector('[aria-label=\"对话权限\"]').value"), "auto")
  assert.equal(await evaluate("Boolean(document.querySelector('.approval-popover'))"), false)
  const readSession = () => evaluate("window.nicode.getSessionData('default', document.querySelector('.chat-page').dataset.sessionId)")
  const approvedData = await readSession()
  assert.equal(approvedData.events.some(event => event.type.startsWith("approval/")), false)
  assert.equal(approvedData.events.find(event => event.type === "tool/result").result.status, "success")

  for (const mode of ["sandbox-full-access", "auto"]) {
    await evaluate(`(() => {
      const select = document.querySelector('[aria-label="对话权限"]')
      select.value = ${JSON.stringify(mode)}
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })()`)
    await until(async () => (await readSession()).control?.sandboxMode === mode)
  }
  const reloaded = new Promise(done => window.webContents.once("did-finish-load", done))
  window.webContents.reload()
  await reloaded
  await until(() => evaluate("document.querySelector('[aria-label=\"对话权限\"]')?.value === 'auto'"))
  await type("消息内容", "复核已有会话的自动审核")
  await until(() => evaluate("document.querySelector('[aria-label=\"发送消息\"]')?.disabled === false"))
  await evaluate("document.querySelector('[aria-label=\"发送消息\"]').click()")
  await until(() => autoReviews === 2 && evaluate("document.querySelector('.session-phase')?.textContent === '准备就绪'"))
  const deniedData = await readSession()
  assert.equal(deniedData.events.some(event => event.type.startsWith("approval/")), false)
  assert.equal(deniedData.events.filter(event => event.type === "tool/result").at(-1).result.error.code, "denied")
  assert.equal(decisionCalls, callsBeforeStop)
  assert.deepEqual(failures, [])
  assert.deepEqual(rendererErrors, [])
  console.log("electron-approval: 人工审批浮窗、批准/拒绝/取消及新对话与已有对话的自动审核、权限持久化通过")
}
void main().catch(error => { console.error(error); failed = true }).finally(async () => {
  try {
    if (window && !window.isDestroyed()) window.destroy()
    if (profile) { assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep)); await rm(profile, { recursive: true, force: true, maxRetries: 0 }) }
  } catch (error) {
    if (process.platform === "win32" && ["EBUSY", "EPERM"].includes(error.code)) console.warn("Chromium 临时目录仍占用，Electron 退出后可清理：" + profile)
    else { failed = true; console.error(error) }
  } finally { app.exit(failed ? 1 : 0) }
})
