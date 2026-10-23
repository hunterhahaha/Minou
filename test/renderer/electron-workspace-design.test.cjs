/** 使用真实 Electron 和 preload 验证工作台导航、摘要搜索、主题与焦点；全部数据为离线夹具。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { STARTUP_DATA_IPC_CHANNELS: startup, SESSION_IPC_CHANNELS: session, SKILL_IPC_CHANNELS: skill, MCP_IPC_CHANNELS: mcp } = require("../../dist/src/preload/session-api.js")
const { createElectronWindowManager } = require("../../dist/src/main/electron-windows.js")
let window, profile, failed = false, historyReads = 0, skillReads = 0, mcpReads = 0
const errors = []
const decisions = []
/** 各主题与页面实际计算色的对比度记录；每次检查写入 dist 供人工核对。 */
const paletteReports = []
const PROJECT = "a0000000-0000-4000-8000-000000000001"
const updatedAt = "2026-10-22T03:00:00.000Z"
const model = { providerId: "local-fixture", protocol: "responses", modelId: "model-fixture", name: "GPT-5.4" }
const providers = [{ providerId: model.providerId, name: "OpenAI", protocol: model.protocol, models: [{ modelId: model.modelId, name: model.name, isDefault: true, contextWindow: 128000, maxOutputTokens: 16000 }] }]
const sessions = [
  { sessionId: "design", name: "梳理项目结构与核心工作流", updatedAt },
  { sessionId: "review", name: "完善工具调用的错误处理", updatedAt },
  { sessionId: "notes", name: "下一次迭代的实现思路", updatedAt },
]
const projects = [{ projectId: PROJECT, name: "NiCode", updatedAt, directories: ["G:\\code\\NiCode"], sessions: [{ sessionId: "project-session", name: "设计新的协作体验", updatedAt }] }]
app.disableHardwareAcceleration()
app.commandLine.appendSwitch("force-device-scale-factor", "1")
/** 窗口销毁后仍等待 finally 清理临时目录，并由 app.exit 保留断言失败的退出码。 */
app.on("window-all-closed", () => {})
/** @param condition 页面状态条件。 @returns 条件满足。 @throws Error 十秒后超时。 */
async function until(condition) {
  const deadline = Date.now() + 10000
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("工作台页面验证等待超时")
    await new Promise((done) => setTimeout(done, 20))
  }
}
/** @param script 主世界表达式。 @returns 页面返回值。 */
const evaluate = (script) => window.webContents.executeJavaScript(script)
/** @param selector 可操作元素选择器。 @returns 点击完成。 */
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
/** @param selector 文本输入选择器。 @param value 目标内容。 @returns React 输入事件完成。 */
const input = (selector, value) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', {bubbles:true})) })()`)
/** @param key 快捷键。 @param modifiers 可选组合键。 @returns 键盘事件完成。 */
const key = (key, modifiers = {}) => evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true, cancelable:true, ...${JSON.stringify(modifiers)}}))`)
/** @param name 输出截图名称。 @returns 等待 React 与合成器更新后的 PNG。 */
async function screenshot(name) {
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  await new Promise((done) => setTimeout(done, 100))
  await writeFile(join(process.cwd(), "dist", name + ".png"), (await window.webContents.capturePage()).toPNG())
}
/**
 * 通过 Chromium 调试协议捕获当前审批与队列状态的三种常见色觉缺陷模拟。
 * @returns 三张截图完成后恢复正常视觉，并解除调试器连接。
 * @throws Error 调试协议、模拟类型或截图不受支持或执行失败；调用方负责报告测试失败。
 */
async function screenshotVisionDeficiencies() {
  const debuggerClient = window.webContents.debugger
  debuggerClient.attach("1.3")
  try {
    for (const type of ["deuteranopia", "protanopia", "tritanopia"]) {
      await debuggerClient.sendCommand("Emulation.setEmulatedVisionDeficiency", { type })
      await screenshot("workspace-vision-" + type)
    }
  } finally {
    try { await debuggerClient.sendCommand("Emulation.setEmulatedVisionDeficiency", { type: "none" }) }
    finally { debuggerClient.detach() }
  }
}
/** @returns 页面没有横向溢出。 */
async function fits() {
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true)
  assert.equal(await evaluate("[...document.querySelectorAll('.main-panel, .settings-dialog-content, .mcp-detail, .chat-scroll')].every(node => node.scrollWidth <= node.clientWidth + 1)"), true)
}
/**
 * 按 WCAG 的 sRGB 相对亮度计算颜色对比度；透明前景先合成到底色。
 * @param foreground Chromium 计算后的 rgb / rgba 前景色。
 * @param background Chromium 计算后的不透明 rgb / rgba 底色。
 * @returns 合成后的亮度对比比值。
 * @throws AssertionError 颜色不是当前样式使用的 sRGB 格式，或底色不透明。
 */
function contrastRatio(foreground, background) {
  /** @param color 计算颜色。 @returns RGB 与默认值为一的 alpha 通道。 */
  const channels = (color) => {
    assert.match(color, /^rgba?\(/, "对比度检查只接受计算后的 sRGB 颜色：" + color)
    const values = color.match(/[\d.]+/g).map(Number)
    return [...values.slice(0, 3), values[3] ?? 1]
  }
  /** @param rgb 不透明 RGB 通道。 @returns WCAG 相对亮度。 */
  const luminance = (rgb) => rgb.slice(0, 3).map((value) => {
    const srgb = value / 255
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
  const fg = channels(foreground), bg = channels(background)
  assert.equal(bg[3], 1, "对比度底色需要先解析到不透明表面：" + background)
  const rendered = fg.slice(0, 3).map((value, index) => value * fg[3] + bg[index] * (1 - fg[3]))
  const a = luminance(rendered), b = luminance(bg)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}
/**
 * 验证正文、次级文案、弱化文案、占位符、主操作与导航图标的主题配色。
 * @param state 当前页面或交互状态，用于报告定位；读取现有页面但不改变其交互状态。
 * @returns 记录实际颜色与最不利背景对应比值后的断言完成。
 * @throws AssertionError 任何正文角色未达到 4.5，或导航图标未达到 3。
 */
async function assertPaletteContrast(state) {
  const palette = await evaluate(`(() => {
    const probe = document.createElement('span')
    probe.hidden = true
    document.body.append(probe)
    const color = token => {
      probe.style.color = 'var(' + token + ')'
      return getComputedStyle(probe).color
    }
    const tokens = Object.fromEntries(['--canvas', '--surface', '--surface-muted', '--surface-focus', '--field', '--field-focus', '--hover', '--selected', '--accent-soft', '--text', '--secondary', '--muted', '--accent', '--accent-hover', '--on-accent', '--rail-hover', '--rail-active-text'].map(token => [token, color(token)]))
    probe.remove()
    const backgrounds = Object.entries(tokens).filter(([name]) => ['--canvas', '--surface', '--surface-muted', '--surface-focus', '--field', '--field-focus', '--hover', '--selected', '--accent-soft'].includes(name))
    for (const selector of ['.titlebar', '.sidebar', '.app-statusbar', '.settings-dialog', '.settings-dialog-nav', '.settings-dialog-content']) {
      const node = document.querySelector(selector)
      if (node) (getComputedStyle(node).backgroundImage.match(/rgba?\\([^)]*\\)/g) ?? []).forEach((value, index) => backgrounds.push([selector + ' gradient stop ' + index, value]))
    }
    const placeholders = [...document.querySelectorAll('textarea, .settings-field input, .search-input-row input')].map((node, index) => [node.tagName.toLowerCase() + '::placeholder ' + index, getComputedStyle(node, '::placeholder').color])
    const rail = document.querySelector('.activity-rail')
    const railBackgrounds = getComputedStyle(rail).backgroundImage.match(/rgba?\\([^)]*\\)/g) ?? [getComputedStyle(rail).backgroundColor]
    const railDefault = getComputedStyle(document.querySelector('.rail-button:not(.rail-button-active)'))
    const railActive = getComputedStyle(document.querySelector('.rail-button-active'))
    const enabledButton = document.querySelector('.send-button:not(:disabled), .settings-primary-button:not(:disabled)')
    const primary = enabledButton ? getComputedStyle(enabledButton) : null
    const selectedText = [...document.querySelectorAll('.settings-nav-option-active, .provider-list-item-active, .selector-menu button[aria-checked="true"]')].map(node => {
      const style = getComputedStyle(node)
      return [node.className || node.getAttribute('role'), style.color, style.backgroundColor]
    })
    return {
      theme: document.documentElement.dataset.theme, route: location.hash, tokens, backgrounds, placeholders, selectedText,
      rail: [['default', railDefault.color, railBackgrounds], ['hover', tokens['--rail-active-text'], [tokens['--rail-hover']]], ['active', railActive.color, [railActive.backgroundColor]]],
      primary: primary ? [primary.color, primary.backgroundColor] : [tokens['--on-accent'], tokens['--accent']],
      primaryEnabled: Boolean(enabledButton),
    }
  })()`)
  assert.ok(palette.placeholders.length > 0, "对比度检查读取实际输入控件的占位符颜色")
  const checks = []
  for (const [role, foreground] of [...['--text', '--secondary', '--muted'].map(token => [token, palette.tokens[token]]), ...palette.placeholders]) {
    const candidates = palette.backgrounds.map(([backgroundRole, background]) => ({ role, foreground, backgroundRole, background, ratio: contrastRatio(foreground, background), minimum: 4.5 }))
    checks.push(candidates.reduce((worst, candidate) => candidate.ratio < worst.ratio ? candidate : worst))
  }
  for (const [role, foreground, backgrounds] of palette.rail) {
    checks.push(backgrounds.map(background => ({ role: 'rail ' + role, foreground, background, ratio: contrastRatio(foreground, background), minimum: 3 })).reduce((worst, candidate) => candidate.ratio < worst.ratio ? candidate : worst))
  }
  for (const [role, foreground, background] of [['primary', ...palette.primary], ['primary hover', palette.tokens['--on-accent'], palette.tokens['--accent-hover']], ...palette.selectedText]) {
    checks.push({ role, foreground, background, ratio: contrastRatio(foreground, background), minimum: 4.5 })
  }
  paletteReports.push({ theme: palette.theme, route: palette.route, state, primaryEnabled: palette.primaryEnabled, checks })
  await writeFile(join(process.cwd(), "dist/workspace-contrast.json"), JSON.stringify(paletteReports, null, 2) + "\n")
  for (const check of checks) assert.ok(check.ratio >= check.minimum, palette.theme + ' / ' + state + ' / ' + check.role + ': ' + check.ratio.toFixed(2) + ':1 < ' + check.minimum + ':1 (' + check.foreground + ' on ' + check.background + ')')
}
/**
 * 验证正文与低明度差壳层的页面配色。
 * @param expectedColor 当前主题预期的不透明纯色工作区底色。
 * @param contentSelectors 当前路由应存在、并保持工作区底色或透明背景的正文容器。
 * @returns 工作区配色与角色对比度断言完成。
 * @throws AssertionError 配色偏离预期、正文混入其它表面、壳层失去渐变或角色对比度不足。
 */
async function assertWorkspacePalette(expectedColor, contentSelectors) {
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  const palette = await evaluate(`(() => {
    const panel = document.querySelector('.main-panel')
    const expected = ${JSON.stringify(expectedColor)}
    const shellGradients = ['.titlebar', '.sidebar', '.activity-rail', '.app-statusbar'].map(selector => [selector, getComputedStyle(document.querySelector(selector)).backgroundImage])
    const surfaceChannels = [getComputedStyle(panel).backgroundColor, ...shellGradients.flatMap(([, gradient]) => gradient.match(/rgba?\\([^)]*\\)/g) ?? [])].map(color => color.match(/[\\d.]+/g).slice(0, 3).map(Number))
    return {
      theme: document.documentElement.dataset.theme,
      canvas: getComputedStyle(panel).backgroundColor,
      surfaceChannelRanges: [0, 1, 2].map(channel => Math.max(...surfaceChannels.map(color => color[channel])) - Math.min(...surfaceChannels.map(color => color[channel]))),
      plainContent: ['.main-panel', '.panel-header', ...${JSON.stringify(contentSelectors)}].every(selector => {
        let node = document.querySelector(selector)
        if (!node) return false
        while (node && panel.contains(node)) {
          const style = getComputedStyle(node)
          if (style.backgroundImage !== 'none' || ![expected, 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor)) return false
          node = node.parentElement
        }
        return true
      }),
      gradientShell: shellGradients.every(([selector, gradient]) => gradient.includes('linear-gradient') && (gradient.match(/rgba?\\([^)]*\\)/g)?.length ?? 0) >= 2),
    }
  })()`)
  assert.equal(palette.canvas, expectedColor, "工作区使用浅色纯白或深色炭灰底色")
  assert.equal(palette.plainContent, true, "工作区标题与正文容器保留纯色底面，不混入渐变或色阶")
  assert.equal(palette.gradientShell, true, "标题栏、侧栏、导航与状态栏使用轻微渐变")
  const maximumSurfaceDifference = palette.theme === "dark" ? 24 : 32
  assert.ok(palette.surfaceChannelRanges.every(range => range <= maximumSurfaceDifference), "标题栏、侧栏、导航、状态栏与正文的背景明度接近；RGB 通道范围：" + palette.surfaceChannelRanges.join(", ") + "，上限：" + maximumSurfaceDifference)
  await assertPaletteContrast("workspace")
}
/** @returns 工作台展示与新增交互的回归验证完成。 */
async function main() {
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  profile = await mkdtemp(join(tmpdir(), "nicode-workspace-design-"))
  app.setPath("userData", join(profile, "electron"))
  ipcMain.handle(startup.listProjects, () => projects)
  ipcMain.handle(startup.listDefaultSessions, () => sessions)
  ipcMain.handle(startup.listProviders, () => providers)
  ipcMain.handle(skill.listSkills, () => {
    skillReads++
    return ["code-review", "project-conventions"].map((name, index) => ({ name, path: join(profile, "skills", name), scope: "global", enabled: index === 0, description: index === 0 ? "从代码结构、边界条件与可维护性出发，检查改动并给出清晰的建议。" : "记录项目约定，让每次协作都沿用熟悉的工作方式。" }))
  })
  ipcMain.handle(mcp.listMcpServers, () => {
    mcpReads++
    return [{ config: { name: "project-tools", transport: "stdio", command: "node", args: ["tools/server.js"], enabled: true }, status: "connected", toolCount: 8 }]
  })
  ipcMain.handle(session.getSessionData, (_event, projectId, sessionId) => {
    historyReads++
    const fixtures = [
      { type: "turn/start", turn: 1, model },
      { type: "user/message", turn: 1, message: { id: "user-1", role: "user", content: [{ type: "text", text: "帮我梳理一下这个项目的结构，看看核心模块是如何协作的。" }] } },
      { type: "assistant/message", turn: 1, step: 1, model, message: { id: "assistant-1", role: "assistant", content: [
        { type: "thinking", text: "先阅读项目入口，沿着调用关系定位状态与持久化边界。" },
        { type: "text", text: "## 一起看看项目的工作方式\n\n我已经梳理了项目的主要模块。整体可以分成三个清晰的部分：\n\n| 模块 | 职责 |\n| --- | --- |\n| 工作台 | 页面导航与用户操作 |\n| Runtime | 模型、工具与任务执行 |\n| Session | 事件记录与状态恢复 |\n\n每个对话在打开时加载历史，后续更新通过事件持续同步。\n\n~~~ts\nconst key = sessionKey(projectId, sessionId)\nif (!state.has(key)) {\n  await state.load(projectId, sessionId)\n}\n~~~\n\n接下来可以从你最关心的模块开始，继续深入。" },
      ] } },
      { type: "turn/end", turn: 1, reason: "completed" },
    ].map((event, index) => ({ ...event, eventId: "fixture-" + index, sessionId, createdAt: updatedAt, seq: index + 1 }))
    return { projectId, sessionId, summary: { sessionId, name: sessions[0].name, updatedAt }, events: fixtures, latestSeq: fixtures.length,
      control: { revision: 1, throughSeq: fixtures.length, currentModel: model, sandboxMode: "sandbox-full-access", phase: "idle", currentTurn: 1, pendingMessages: [], discardedMessages: [] } }
  })
  ipcMain.handle(session.decideSessionApproval, (_event, projectId, sessionId, approvalId, decision) => {
    decisions.push({ projectId, sessionId, approvalId, decision })
    for (const [seq, event] of [[8, { type: "approval/result", turn: 2, step: 1, approvalId, decision }], [9, { type: "turn/end", turn: 2, reason: "completed" }]]) {
      window.webContents.send(session.update, { kind: "event", projectId, sessionId, event: { ...event, seq, eventId: "approval-" + seq, sessionId, createdAt: updatedAt } })
    }
    window.webContents.send(session.update, { kind: "state", projectId, sessionId, control: { revision: 3, throughSeq: 9, phase: "idle", currentTurn: 2, currentModel: model, sandboxMode: "sandbox-full-access", pendingMessages: [], discardedMessages: [] } })
    return { accepted: true }
  })
  await app.whenReady()
  /** 测试保持窗口隐藏；放宽最小尺寸以额外覆盖窄窗口布局。 */
  class HiddenTestWindow extends BrowserWindow {
    constructor(options) { super({ ...options, width: 1440, height: 1000, minWidth: 480, minHeight: 400, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); window = this }
    show() {}
  }
  const manager = createElectronWindowManager(HiddenTestWindow, {
    preloadPath: join(process.cwd(), "dist/src/preload/index.js"),
    rendererHtmlPath: join(process.cwd(), "dist/src/renderer/index.html"),
    onWindowLoadFailure: (error) => { throw error },
  })
  manager.createMainWindow()
  window.webContents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message) })
  await until(() => evaluate("document.querySelectorAll('.session-name').length === 4 && Boolean(document.querySelector('.model-trigger'))"))
  assert.equal(historyReads, 0, "摘要首页不加载任何历史")
  assert.equal(skillReads + mcpReads, 0, "启动不读取技能或 MCP")
  await fits()
  await evaluate("document.activeElement.blur()")
  await screenshot("workspace-light")
  await assertWorkspacePalette("rgb(255, 255, 255)", [".welcome-scroll", ".welcome"])
  assert.equal(await evaluate("document.querySelectorAll('.sidebar-model-card').length"), 0, "移除侧栏模型就绪卡片")
  assert.equal(await evaluate("document.querySelector('.model-trigger').textContent.includes('GPT-5.4')"), true, "输入区保留当前模型选择入口")
  assert.equal(await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('.main-panel'))
    return ['Top', 'Right', 'Bottom', 'Left'].every(side => style['border' + side + 'Width'] === '1px') && parseFloat(style.borderTopLeftRadius) > 0 && parseFloat(style.borderBottomLeftRadius) > 0
  })()`), true, "工作区保留单像素边框和左侧圆角")
  assert.equal(await evaluate(`['.titlebar', '.sidebar', '.panel-header', '.composer'].every(selector => {
    const style = getComputedStyle(document.querySelector(selector))
    return ['Top', 'Right', 'Bottom', 'Left'].every(side => style['border' + side + 'Width'] === '0px')
  })`), true, "标题栏、侧栏、面包屑与输入容器通过色阶区分，无区域描边")
  const restingComposerShadow = await evaluate("getComputedStyle(document.querySelector('.composer')).boxShadow")
  await evaluate("document.querySelector('textarea').focus()")
  await screenshot("workspace-composer-focus")
  const focusedComposer = await evaluate(`(() => {
    const composer = getComputedStyle(document.querySelector('.composer'))
    const textarea = getComputedStyle(document.querySelector('textarea'))
    return { shadow: composer.boxShadow, outline: textarea.outlineWidth }
  })()`)
  assert.notEqual(focusedComposer.shadow, restingComposerShadow, "输入焦点使整个容器的阴影加深")
  assert.notEqual(focusedComposer.shadow, "none")
  assert.ok(focusedComposer.shadow.replace(/\([^)]*\)/g, "").split(",").length >= 2, "聚焦反馈包含多层柔和阴影")
  assert.equal(focusedComposer.outline, "0px", "输入焦点不显示亮色轮廓线")
  assert.equal(await evaluate("document.querySelectorAll('.starter-grid, .recent-sessions').length"), 0, "主页移除重复信息")
  const initialHeight = await evaluate("document.querySelector('textarea').clientHeight")
  assert.ok(initialHeight <= 48, "初始只有一行")
  await input('[aria-label="任务描述"]', "第一行\n第二行\n第三行\n第四行")
  await until(() => evaluate(`document.querySelector('textarea').clientHeight > ${initialHeight + 40}`))
  await input('[aria-label="任务描述"]', "一行内容\n".repeat(40))
  await until(() => evaluate("document.querySelector('textarea').clientHeight === 200 && getComputedStyle(document.querySelector('textarea')).overflowY === 'auto'"))
  await input('[aria-label="任务描述"]', "")
  await until(() => evaluate(`document.querySelector('textarea').clientHeight === ${initialHeight}`))
  assert.equal(await evaluate("getComputedStyle(document.querySelector('textarea')).resize"), "none")
  await input('[aria-label="任务描述"]', "我的草稿")
  await evaluate("document.querySelector('textarea').focus()")
  await until(() => evaluate("!document.querySelector('.send-button').disabled"))
  await screenshot("workspace-composer-draft")
  await assertPaletteContrast("composer draft enabled")
  await click(".model-trigger")
  await until(() => evaluate("Boolean(document.querySelector('.model-menu'))"))
  await screenshot("workspace-model-menu")
  await assertPaletteContrast("model menu")
  await key("Escape")
  await until(() => evaluate("!document.querySelector('.selector-menu')"))
  await key("k", { ctrlKey: true })
  await until(() => evaluate("document.activeElement.getAttribute('aria-label') === '搜索项目或对话'"))
  await input('[aria-label="搜索项目或对话"]', "不存在的名称")
  await until(() => evaluate("Boolean(document.querySelector('.search-empty'))"))
  assert.equal(historyReads, 0, "空搜索不访问历史")
  await key("Enter")
  assert.equal(historyReads, 0)
  await input('[aria-label="搜索项目或对话"]', "错误处理")
  await until(() => evaluate("document.querySelectorAll('.search-result').length === 1"))
  await screenshot("workspace-search")
  await key("Enter")
  await until(() => evaluate("Boolean(document.querySelector('.final-answer'))"))
  assert.equal(historyReads, 1, "仅选中对话时首次加载历史")
  await fits()
  await screenshot("workspace-conversation")
  await assertWorkspacePalette("rgb(255, 255, 255)", [".chat-page", ".chat-scroll", ".chat-messages", ".final-answer"])
  assert.equal(await evaluate("document.querySelector('[aria-label=\"对话模型\"]').options.length > 0"), true, "已有对话仍保留模型选择")
  await click('[aria-label="切换深色外观"]')
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
  await screenshot("workspace-conversation-dark")
  await assertWorkspacePalette("rgb(35, 35, 35)", [".chat-page", ".chat-scroll", ".chat-messages", ".final-answer"])
  assert.equal(historyReads, 1, "切换深色外观不重新读取对话历史")
  await click('[aria-label="切换浅色外观"]')
  await until(() => evaluate("document.documentElement.dataset.theme === 'light'"))
  await assertWorkspacePalette("rgb(255, 255, 255)", [".chat-page", ".chat-scroll", ".chat-messages", ".final-answer"])
  for (const [seq, event] of [
    [5, { type: "turn/start", turn: 2, model }],
    [6, { type: "user/message", turn: 2, message: { id: "user-2", role: "user", content: [{ type: "text", text: "继续检查项目目录，并整理下一步建议。" }] } }],
    [7, { type: "approval/request", turn: 2, step: 1, approvalId: "approval-fixture", toolCallId: "tool-fixture", toolName: "shell", reason: "本次访问需要你确认后继续。", arguments: { command: "Get-ChildItem -LiteralPath G:/code/NiCode" } }],
  ]) window.webContents.send(session.update, { kind: "event", projectId: "default", sessionId: "review", event: { ...event, seq, eventId: "approval-" + seq, sessionId: "review", createdAt: updatedAt } })
  window.webContents.send(session.update, { kind: "state", projectId: "default", sessionId: "review", control: { revision: 2, throughSeq: 7, phase: "running", currentTurn: 2, currentModel: model, sandboxMode: "sandbox-full-access", pendingMessages: [{ messageId: "queued", status: "queued", content: [{ type: "text", text: "之后再整理一份简短的改进清单。" }] }], discardedMessages: [] } })
  await until(() => evaluate("Boolean(document.querySelector('.approval-actions button:not(:disabled)')) && Boolean(document.querySelector('.queue-list'))"))
  await screenshot("workspace-approval-queue")
  await screenshotVisionDeficiencies()
  await click(".approval-actions .settings-primary-button")
  await until(() => evaluate("document.querySelector('.session-phase')?.textContent === '准备就绪'"))
  assert.deepEqual(decisions, [{ projectId: "default", sessionId: "review", approvalId: "approval-fixture", decision: "approved" }], "审批按钮沿用原有 IPC 参数")
  await click(".new-chat")
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"任务描述\"]'))"))
  assert.equal(await evaluate("document.querySelector('textarea').value === '我的草稿'"), true, "跨路由保留草稿")
  await key("k", { ctrlKey: true })
  await until(() => evaluate("document.activeElement.getAttribute('aria-label') === '搜索项目或对话'"))
  await input('[aria-label="搜索项目或对话"]', "错误处理")
  await key("Enter")
  await until(() => evaluate("Boolean(document.querySelector('.final-answer'))"))
  assert.equal(historyReads, 1, "再次访问命中原缓存")
  await click(".new-chat")
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"任务描述\"]'))"))
  await key("k", { ctrlKey: true })
  await until(() => evaluate("document.activeElement.getAttribute('aria-label') === '搜索项目或对话'"))
  await input('[aria-label="搜索项目或对话"]', "NiCode")
  await key("Enter")
  await until(() => evaluate("location.hash.includes('/projects/')"))
  assert.equal(historyReads, 1, "进入项目工作台不预载项目对话")
  await screenshot("workspace-project")
  await click('[aria-label="切换深色外观"]')
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
  await evaluate("document.activeElement.blur()")
  await screenshot("workspace-dark")
  await assertWorkspacePalette("rgb(35, 35, 35)", [".welcome-scroll", ".welcome"])
  const restingDarkComposer = await evaluate("getComputedStyle(document.querySelector('.composer')).backgroundColor.match(/[\\d.]+/g).slice(0, 3).map(Number)")
  await evaluate("document.querySelector('textarea').focus()")
  await screenshot("workspace-dark-focus")
  assert.equal(await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('.composer'))
    const channels = style.backgroundColor.match(/[\\d.]+/g).slice(0, 3).map(Number)
    return channels.every((value, index) => value < ${JSON.stringify(restingDarkComposer)}[index]) && style.boxShadow !== 'none' && style.boxShadow.replace(/\\([^)]*\\)/g, '').split(',').length >= 2
  })()`), true, "深色输入框聚焦时整体加深，并保留多层柔和阴影")
  await window.reload()
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark' && Boolean(document.querySelector('.welcome'))"))
  assert.equal(await evaluate("localStorage.getItem('nicode.appearance')"), "dark", "重新载入后保留主题")
  await assertWorkspacePalette("rgb(35, 35, 35)", [".welcome-scroll", ".welcome"])
  await click(".sidebar-settings")
  await until(() => evaluate("Boolean(document.querySelector('.provider-detail'))"))
  await screenshot("workspace-settings-dark")
  await assertPaletteContrast("settings")
  await key("Escape")
  await until(() => evaluate("!document.querySelector('.settings-dialog')"))
  await click('[aria-label="切换浅色外观"]')
  await click(".sidebar-settings")
  await until(() => evaluate("Boolean(document.querySelector('.provider-detail'))"))
  await screenshot("workspace-models")
  await assertPaletteContrast("settings")
  assert.equal(await evaluate(`['.settings-dialog', '.settings-dialog-header', '.settings-dialog-nav', '.provider-sidebar', '.settings-field input'].every(selector => {
    const style = getComputedStyle(document.querySelector(selector))
    return ['Top', 'Right', 'Bottom', 'Left'].every(side => style['border' + side + 'Width'] === '0px')
  })`), true, "设置弹窗、分区与字段移除描边")
  window.webContents.focus()
  await evaluate("document.querySelector('.settings-field input').focus()")
  await screenshot("workspace-field-focus")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.settings-field input')).outlineWidth"), "0px", "设置字段聚焦不显示亮线")
  const focusedField = await evaluate(`(() => {
    const node = document.querySelector('.settings-field input')
    return { active: document.activeElement?.getAttribute('aria-label'), focused: node.matches(':focus'), within: node.closest('.settings-field').matches(':focus-within'), documentFocused: document.hasFocus(), shadow: getComputedStyle(node).boxShadow }
  })()`)
  assert.equal(focusedField.focused && focusedField.within && focusedField.shadow !== 'none' && focusedField.shadow.replace(/\([^)]*\)/g, '').split(',').length >= 2, true, "设置字段沿用多层柔和阴影反馈：" + JSON.stringify(focusedField))
  assert.equal(await evaluate(`(() => { const rect = document.querySelector('.settings-dialog').getBoundingClientRect(); return rect.width <= Math.min(1080, innerWidth * .88) + 1 && rect.height <= Math.min(760, innerHeight * .84) + 1 && rect.top > 42 && rect.bottom < innerHeight - 25 })()`), true, "设置弹窗有尺寸上限与外部留白")
  const wideSettings = await evaluate("document.querySelector('.settings-dialog').clientWidth")
  window.setSize(800, 600)
  await until(() => evaluate("innerWidth === 800"))
  assert.equal(await evaluate(`(() => { const rect = document.querySelector('.settings-dialog').getBoundingClientRect(); return rect.width < ${wideSettings} && rect.height <= innerHeight * .84 + 1 && rect.top >= 42 && rect.bottom <= innerHeight - 25 })()`), true, "弹窗随主窗口缩小，并保留边距")
  await fits()
  await screenshot("workspace-settings-compact")
  window.setSize(1440, 1000)
  await until(() => evaluate("innerWidth === 1440"))
  await evaluate("[...document.querySelectorAll('.settings-nav-option')].find(node => node.textContent === 'MCP').click()")
  await until(() => evaluate("document.querySelector('.mcp-settings')?.getAttribute('aria-busy') === 'false'"))
  assert.equal(mcpReads, 1)
  await screenshot("workspace-mcp")
  await evaluate("[...document.querySelectorAll('.settings-nav-option')].find(node => node.textContent === '技能').click()")
  await until(() => evaluate("document.querySelectorAll('.skill-entry').length === 2"))
  assert.equal(skillReads, 1)
  await screenshot("workspace-skills")
  await key("Escape")
  await until(() => evaluate("!document.querySelector('.settings-dialog')"))
  await click('[aria-label="创建项目"]')
  await until(() => evaluate("document.activeElement.id === 'project-name'"))
  await screenshot("workspace-create-project")
  await key("Escape")
  await key("b", { ctrlKey: true })
  await until(() => evaluate("!document.querySelector('.sidebar')"))
  await key("b", { ctrlKey: true })
  await until(() => evaluate("Boolean(document.querySelector('.sidebar'))"))
  window.setSize(640, 760)
  await screenshot("workspace-narrow")
  await fits()
  await evaluate("document.querySelector('[aria-label=\"技能设置\"]').focus()")
  await click('[aria-label="技能设置"]')
  await until(() => evaluate("document.querySelectorAll('.skill-entry').length === 2"))
  await fits()
  await screenshot("workspace-settings-narrow")
  await evaluate("(() => { const nodes = [...document.querySelector('.settings-dialog').querySelectorAll('button, input, select')].filter(node => !node.disabled && node.getClientRects().length); nodes.at(-1).focus() })()")
  await key("Tab")
  assert.equal(await evaluate("document.querySelector('.settings-dialog').contains(document.activeElement)"), true, "Tab 焦点保留在弹窗内")
  await key("Escape")
  await until(() => evaluate("document.activeElement.getAttribute('aria-label') === '技能设置'"))
  window.setOpacity(0)
  window.setSkipTaskbar(true)
  await click('[aria-label="最大化窗口"]')
  await until(() => window.isMaximized())
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"还原窗口\"]'))"))
  await click('[aria-label="还原窗口"]')
  await until(() => !window.isMaximized())
  window.maximize()
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"还原窗口\"]'))"))
  window.unmaximize()
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"最大化窗口\"]'))"))
  await click('[aria-label="关闭窗口并最小化"]')
  await until(() => window.isMinimized())
  assert.equal(window.isDestroyed(), false, "关闭按钮保留窗口及应用")
  window.restore()
  window.hide()
  await click('[aria-label="最小化窗口"]')
  await until(() => window.isMinimized())
  assert.equal(window.isDestroyed(), false)
  assert.deepEqual(errors, [])
  console.log("electron-workspace-design: 纯白/炭灰工作区、低明度差壳层、主题角色与正文/占位符/主操作/导航图标对比度、渐变壳层、移除模型就绪卡片、摘要搜索与空结果、键盘导航、历史按需加载与缓存、可发送草稿、模型菜单、项目入口、主题恢复、浅深色设置、单行输入自适应、焦点、窄窗口及自绘窗口按钮均通过；截图保存在 dist/workspace-*.png，对比度报告保存在 dist/workspace-contrast.json")
}
void main().catch(async (error) => {
  failed = true
  console.error(error)
  if (window && !window.isDestroyed()) console.error(await evaluate("document.body.innerText"))
}).finally(async () => {
  try {
    if (window && !window.isDestroyed()) window.destroy()
    if (profile) { assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep)); await rm(profile, { recursive: true, force: true, maxRetries: 0 }) }
  } catch (error) {
    if (process.platform === "win32" && ["EBUSY", "EPERM"].includes(error.code)) {
      console.warn("Chromium 临时目录仍占用，Electron 退出后可清理：" + profile + " (" + error.code + ")")
    } else {
      failed = true
      console.error("清理测试临时目录失败", error)
    }
  } finally {
    app.exit(failed ? 1 : 0)
  }
})
