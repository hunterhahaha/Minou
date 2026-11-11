/** 使用真实 Electron 和 preload 验证工作台导航、摘要搜索、主题与焦点；全部数据为离线夹具。 */
const assert = require("node:assert/strict")
const { mkdtemp, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join, resolve, sep } = require("node:path")
const { app, BrowserWindow, ipcMain } = require("electron")
const { registerWindowIpcHandlers } = require("../../dist/src/main/window-ipc.js")
const { STARTUP_DATA_IPC_CHANNELS: startup, SESSION_IPC_CHANNELS: session, PROJECT_IPC_CHANNELS: projectChannels, SKILL_IPC_CHANNELS: skill, MCP_IPC_CHANNELS: mcp, PROVIDER_IPC_CHANNELS: provider } = require("../../dist/src/preload/session-api.js")
const { createElectronWindowManager } = require("../../dist/src/main/electron-windows.js")
let window, profile, failed = false, historyReads = 0, skillReads = 0, mcpReads = 0
const errors = []
const decisions = []
/** 各主题与页面实际计算色的对比度记录；每次检查写入 dist 供人工核对。 */
const paletteReports = []
/** 实际页面在各缩放级别下的文字与布局记录，不替代既有业务断言。 */
const typographyReports = []
const PROJECT = "a0000000-0000-4000-8000-000000000001"
const updatedAt = "2026-10-22T03:00:00.000Z"
const model = { providerId: "local-fixture", protocol: "responses", modelId: "model-fixture", name: "GPT-5.4", reasoningLevel: "medium" }
const providers = [{ providerId: model.providerId, name: "OpenAI", type: "custom", protocol: model.protocol, models: [{ supportsReasoning: true, modelId: model.modelId, name: model.name, isDefault: true, contextWindow: 128000, maxOutputTokens: 16000,
  reasoningLevels: ["low", "medium", "high"], reasoningField: { path: ["reasoning", "effort"] } }] }]
const sessions = [
  { sessionId: "design", name: "梳理项目结构与核心工作流", updatedAt },
  { sessionId: "review", name: "完善工具调用的错误处理", updatedAt },
  { sessionId: "notes", name: "下一次迭代的实现思路", updatedAt },
]
const projects = [
  { projectId: PROJECT, name: "NiCode", updatedAt, directories: ["G:\\code\\NiCode"], sessions: [{ sessionId: "project-session", name: "设计新的协作体验", updatedAt }] },
  { projectId: "a0000000-0000-4000-8000-000000000002", name: "一个包含较长名称的项目，用来确认侧栏始终保持简洁", updatedAt, directories: [], sessions: [] },
]
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
/** 读取菜单几何位置，并以实际内容尺寸计算窗口边界内的按钮锚点。 */
const modelMenuGeometry = `(() => {
    const button = document.querySelector('.model-trigger')
    const panel = document.getElementById(button.getAttribute('aria-controls'))
    const anchor = button.getBoundingClientRect()
    const rect = panel.getBoundingClientRect()
    return {
      open: panel.matches(':popover-open'), width: rect.width, height: rect.height,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      expectedLeft: Math.max(12, Math.min(anchor.right - rect.width, innerWidth - rect.width - 12)),
      expectedTop: Math.max(12, Math.min(anchor.top - rect.height - 10, innerHeight - rect.height - 12)),
      viewportWidth: innerWidth, viewportHeight: innerHeight,
    }
  })()`
/** @param geometry 菜单与入口的实测位置。 */
function assertModelMenuGeometry(geometry) {
  assert.ok(geometry.open && geometry.width > 0 && geometry.height > 0, JSON.stringify(geometry))
  assert.ok(Math.abs(geometry.left - geometry.expectedLeft) < 1 && Math.abs(geometry.top - geometry.expectedTop) < 1,
    "菜单一进入顶层就锚定模型按钮：" + JSON.stringify(geometry))
  assert.ok(geometry.right <= geometry.viewportWidth - 11 && geometry.bottom <= geometry.viewportHeight - 11,
    "菜单首次打开即位于窗口内：" + JSON.stringify(geometry))
}
/** 在原生激活按钮的同一个任务中检查浮层坐标，早于异步 toggle 事件。 */
async function openPositionedModelMenu() {
  const geometry = await evaluate(`(() => {
    document.querySelector('.model-trigger').click()
    return ${modelMenuGeometry}
  })()`)
  assertModelMenuGeometry(geometry)
}
/** @param selector 文本输入选择器。 @param value 目标内容。 @returns React 输入事件完成。 */
const input = (selector, value) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node.isContentEditable) {
    node.focus()
    window.getSelection().selectAllChildren(node)
    if (${JSON.stringify(value)}) document.execCommand('insertText', false, ${JSON.stringify(value)})
    else document.execCommand('delete')
  } else {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)})
    node.dispatchEvent(new Event('input', { bubbles: true }))
  } })()`)
/** @param key 快捷键。 @param modifiers 可选组合键。 @returns 键盘事件完成。 */
const key = (key, modifiers = {}) => evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true, cancelable:true, ...${JSON.stringify(modifiers)}}))`)
/**
 * 向 Chromium 发送真实按键，覆盖原生下拉浮层的默认键盘行为。
 * @param keyCode Electron 按键名称。
 * @returns 按键按下与释放事件已发送。
 */
function nativeKey(keyCode) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode })
}
/** @param selector 已渲染且可见的元素。 @returns 实际鼠标按下与释放事件已发送。 */
async function nativeClick(selector) {
  const point = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()`)
  window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 })
  window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 })
}
/**
 * 在用户手势下打开实际 select 浮层，并核对外观、选中项对比度与屏幕边界。
 * @param selector 当前页面的原生 select 选择器。
 * @returns 浮层打开且实际渲染检查通过。
 * @throws AssertionError 浮层未采用定制外观、被截断或选中项对比度不足。
 */
async function openSelect(selector) {
  window.webContents.focus()
  await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({ block: 'center' }); node.focus() })()`)
  await nativeClick(selector)
  await until(() => evaluate(`document.querySelector(${JSON.stringify(selector)}).matches(':open')`))
  const presentation = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    const picker = getComputedStyle(node, '::picker(select)')
    const selected = getComputedStyle(node.selectedOptions[0])
    return {
      appearance: getComputedStyle(node).appearance,
      radius: picker.borderRadius, shadow: picker.boxShadow, border: picker.borderTopWidth,
      selected: [selected.color, selected.backgroundColor],
      fits: [...node.options].every(option => { const rect = option.getBoundingClientRect(); return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight })
    }
  })()`)
  assert.equal(presentation.appearance, "base-select", "沿用 select 的原生选择行为并定制外观")
  assert.equal(presentation.radius, "10px", "浮层沿用页面圆角")
  assert.equal(presentation.border, "0px", "展开浮层无系统方框描边")
  assert.notEqual(presentation.shadow, "none", "浮层保留柔和阴影")
  assert.equal(presentation.fits, true, "展开选项位于屏幕范围内")
  assert.ok(contrastRatio(...presentation.selected) >= 4.5, "选中项文字对比度达到 4.5:1")
}
/** @param name 输出截图名称。 @returns 等待 React 与合成器更新后的 PNG。 */
async function screenshot(name) {
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })")
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  await new Promise((done) => setTimeout(done, 100))
  await writeFile(join(process.cwd(), "dist", name + ".png"), (await window.webContents.capturePage()).toPNG())
  if (["workspace-light", "workspace-dark", "workspace-conversation", "workspace-conversation-dark", "workspace-models", "workspace-settings-dark", "workspace-skills", "workspace-settings-narrow", "workspace-approval-queue"].includes(name)) await assertTypographyAtZoom(name)
}

/** 在当前菜单临时替换显示文字以检查长失效等级，不改变应用状态。 @param variant 截图名称后缀。 @returns 布局检查完成。 */
async function assertLongInvalidLevel(variant) {
  await evaluate(`(() => { const node = document.querySelector('[data-model-setting="reasoning"] .model-setting-value'); node.dataset.fixtureOriginal = node.textContent; node.textContent = 'very-long-custom-reasoning-level-that-must-wrap-without-hiding-the-invalid-indicator（已失效）' })()`)
  await until(() => evaluate(`(() => { const rect = document.querySelector('.composer-model-panel').getBoundingClientRect(); return rect.left >= 12 && rect.top >= 12 && rect.right <= innerWidth - 12 && rect.bottom <= innerHeight - 12 })()`))
  const layout = await evaluate(`(() => {
    const node = document.querySelector('[data-model-setting="reasoning"] .model-setting-value'), style = getComputedStyle(node), rect = node.getBoundingClientRect()
    const end = document.createRange(); end.setStart(node.firstChild, node.textContent.length - 5); end.setEnd(node.firstChild, node.textContent.length)
    const last = end.getBoundingClientRect()
    return { text: node.textContent, whiteSpace: style.whiteSpace, height: rect.height, lineHeight: parseFloat(style.lineHeight), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, lastVisible: last.left >= rect.left - 1 && last.right <= rect.right + 1 && last.top >= rect.top - 1 && last.bottom <= rect.bottom + 1 }
  })()`)
  assert.ok(layout.text.endsWith('（已失效）') && layout.whiteSpace !== 'nowrap' && layout.height > layout.lineHeight && layout.scrollWidth <= layout.clientWidth && layout.scrollHeight <= layout.clientHeight && layout.lastVisible, "长等级与失效提示完整换行：" + JSON.stringify(layout))
  await screenshot("workspace-model-invalid-long-" + variant)
  await evaluate(`(() => { const node = document.querySelector('[data-model-setting="reasoning"] .model-setting-value'); node.textContent = node.dataset.fixtureOriginal; delete node.dataset.fixtureOriginal })()`)
}

/** 在当前已选项临时替换显示文字，检查长名称和勾选标记。 @param variant 截图名称后缀。 @returns 布局检查完成。 */
async function assertLongModelOption(variant) {
  await evaluate(`(() => { const row = document.querySelector('.model-menu [aria-checked="true"]'), name = row.querySelector('strong'), provider = row.querySelector('small'); name.dataset.fixtureOriginal = name.textContent; provider.dataset.fixtureOriginal = provider.textContent; name.textContent = 'very-long-model-name-that-must-wrap-to-remain-readable-in-the-menu'; provider.textContent = 'very-long-provider-name-that-must-also-wrap-without-clipping' })()`)
  await until(() => evaluate(`(() => { const rect = document.querySelector('.composer-model-panel').getBoundingClientRect(); return rect.left >= 12 && rect.top >= 12 && rect.right <= innerWidth - 12 && rect.bottom <= innerHeight - 12 })()`))
  const layout = await evaluate(`(() => {
    const row = document.querySelector('.model-menu [aria-checked="true"]'), name = row.querySelector('strong'), provider = row.querySelector('small'), icon = row.querySelector('svg')
    const text = [name, provider].map(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return { whiteSpace: style.whiteSpace, height: rect.height, lineHeight: parseFloat(style.lineHeight), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight } })
    const labelRect = row.querySelector('span').getBoundingClientRect(), iconRect = icon.getBoundingClientRect(), rowRect = row.getBoundingClientRect()
    return { text, iconWidth: iconRect.width, separate: labelRect.right <= iconRect.left && iconRect.right <= rowRect.right }
  })()`)
  assert.ok(layout.text.every(item => item.whiteSpace !== 'nowrap' && item.height > item.lineHeight && item.scrollWidth <= item.clientWidth && item.scrollHeight <= item.clientHeight) && layout.iconWidth >= 14 && layout.separate, "长模型、供应商完整换行且不挤压勾选标记：" + JSON.stringify(layout))
  await screenshot("workspace-model-menu-long-" + variant)
  await evaluate(`(() => { for (const node of document.querySelectorAll('.model-menu [data-fixture-original]')) { node.textContent = node.dataset.fixtureOriginal; delete node.dataset.fixtureOriginal } })()`)
}

/** 检查真实键盘焦点、鼠标悬停和当前项的视觉层级。 @param variant 截图名称后缀。 @returns 状态检查完成。 */
async function assertModelStates(variant) {
  window.webContents.focus()
  await until(() => evaluate("document.activeElement === document.querySelector('.reasoning-menu [aria-checked=\"true\"]')"))
  nativeKey("End")
  await until(() => evaluate("document.activeElement === document.querySelector('.reasoning-menu button:last-child')"))
  const hoverPoint = await evaluate("(() => { const rect = document.querySelector('.reasoning-menu button:first-child').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  window.webContents.sendInputEvent({ type: "mouseMove", ...hoverPoint })
  await until(() => evaluate("document.querySelector('.reasoning-menu button:first-child').matches(':hover')"))
  const states = await evaluate(`(() => { const selected = document.querySelector('.reasoning-menu [aria-checked="true"]'), hover = document.querySelector('.reasoning-menu button:first-child'), focus = document.activeElement; return { selected: getComputedStyle(selected).backgroundColor, hover: getComputedStyle(hover).backgroundColor, focusVisible: focus.matches(':focus-visible'), focusShadow: getComputedStyle(focus).boxShadow } })()`)
  assert.ok(states.selected !== states.hover && states.focusVisible && states.focusShadow !== 'none', "焦点、选中与悬停状态可区分：" + JSON.stringify(states))
  await screenshot("workspace-model-states-" + variant)
  await evaluate("document.querySelector('.reasoning-menu [aria-checked=\"true\"]').focus()")
}
/**
 * 在当前真实页面核对缩放后的文字下限、代码字体、横向边界和 Composer 操作区域。
 * @param state 截图场景名称，用于报告与截图定位。
 * @returns 100%、125%、150% 的检查与截图完成，原缩放级别恢复。
 * @throws AssertionError 关键文字过小、代码字体错误、页面溢出或 Composer 操作被挤出视口；调用方报告失败。
 */
async function assertTypographyAtZoom(state) {
  const originalZoom = window.webContents.getZoomFactor()
  try {
    for (const zoom of [1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(zoom)
      await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
      await new Promise(done => setTimeout(done, 100))
      const presentation = await evaluate(`(() => {
        const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'
        const controls = [...document.querySelectorAll('.selector-trigger, .chat-select-label select, .stop-button, .settings-primary-button, .settings-secondary-button, .settings-nav-option, .settings-field input, .settings-field select')].filter(visible)
        const code = [...document.querySelectorAll('.skill-path, .process-content, .markdown-content pre code')].filter(visible)
        const composer = [...document.querySelectorAll('.composer-toolbar button, .composer-toolbar select')].filter(visible)
        return {
          theme: document.documentElement.dataset.theme, width: innerWidth, height: innerHeight,
          controls: controls.map(node => ({ name: node.getAttribute('aria-label') || node.textContent.trim(), size: parseFloat(getComputedStyle(node).fontSize) })),
          code: code.map(node => ({ size: parseFloat(getComputedStyle(node).fontSize), family: getComputedStyle(node).fontFamily })),
          overflow: document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.main-panel, .settings-dialog-content, .mcp-detail, .chat-scroll')].some(node => node.scrollWidth > node.clientWidth + 1),
          composerFits: composer.every(node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.left >= -1 && rect.right <= innerWidth + 1 })
        }
      })()`)
      typographyReports.push({ state, zoom, ...presentation })
      await writeFile(join(process.cwd(), 'dist/ui02-typography.json'), JSON.stringify(typographyReports, null, 2) + '\n')
      assert.equal(presentation.controls.every(control => control.size >= 13), true, state + ' / ' + zoom + ': 关键控件文字不随窄窗缩小')
      assert.equal(presentation.code.every(code => code.size >= 13 && /Cascadia Code.*Consolas.*monospace/.test(code.family)), true, state + ' / ' + zoom + ': 代码与路径使用可读的等宽字体')
      assert.equal(presentation.overflow, false, state + ' / ' + zoom + ': 页面没有意外横向溢出')
      assert.equal(presentation.composerFits, true, state + ' / ' + zoom + ': Composer 操作位于视口内')
      if (zoom !== 1) await writeFile(join(process.cwd(), 'dist', 'ui02-' + state + '-' + zoom * 100 + '.png'), (await window.webContents.capturePage()).toPNG())
    }
  } finally {
    window.webContents.setZoomFactor(originalZoom)
    await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))")
  }
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
 * 验证正文、浮层、占位符、主操作、导航图标与焦点标记的主题配色。
 * @param state 当前页面或交互状态，用于报告定位；读取现有页面但不改变其交互状态。
 * @returns 记录实际颜色与最不利背景对应比值后的断言完成。
 * @throws AssertionError 任何正文角色未达到 4.5，或导航图标、焦点标记未达到 3。
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
    const tokens = Object.fromEntries(['--canvas', '--surface', '--surface-muted', '--popover', '--focus-ring', '--surface-focus', '--field', '--field-focus', '--hover', '--selected', '--accent-soft', '--text', '--secondary', '--muted', '--accent', '--accent-hover', '--on-accent'].map(token => [token, color(token)]))
    probe.remove()
    const backgrounds = Object.entries(tokens).filter(([name]) => ['--canvas', '--surface', '--surface-muted', '--popover', '--surface-focus', '--field', '--field-focus', '--hover', '--selected', '--accent-soft'].includes(name))
    for (const selector of ['.titlebar', '.sidebar', '.app-statusbar', '.settings-dialog', '.settings-dialog-nav', '.settings-dialog-content']) {
      const node = document.querySelector(selector)
      if (node) (getComputedStyle(node).backgroundImage.match(/rgba?\\([^)]*\\)/g) ?? []).forEach((value, index) => backgrounds.push([selector + ' gradient stop ' + index, value]))
    }
    const placeholders = [...document.querySelectorAll('.settings-field input, .search-input-row input')].map((node, index) => [node.tagName.toLowerCase() + '::placeholder ' + index, getComputedStyle(node, '::placeholder').color])
    const editor = document.querySelector('.composer-editor')
    if (editor) placeholders.push(['Composer 占位文字', getComputedStyle(editor, '::before').color])
    const sidebar = getComputedStyle(document.querySelector('.sidebar'))
    const navigationBackgrounds = sidebar.backgroundImage.match(/rgba?\\([^)]*\\)/g) ?? [sidebar.backgroundColor]
    const navigationDefault = getComputedStyle(document.querySelector('.sidebar-settings'))
    const enabledButton = document.querySelector('.send-button:not(:disabled), .settings-primary-button:not(:disabled)')
    const primary = enabledButton ? getComputedStyle(enabledButton) : null
    let primaryBackground = primary?.backgroundColor
    for (let parent = enabledButton?.parentElement; parent && primaryBackground === 'rgba(0, 0, 0, 0)'; parent = parent.parentElement) primaryBackground = getComputedStyle(parent).backgroundColor
    const selectedText = [...document.querySelectorAll('.session-name[aria-current="page"], .settings-nav-option-active, .provider-list-item-active, .selector-menu button[aria-checked="true"]')].map(node => {
      const style = getComputedStyle(node)
      return [node.className || node.getAttribute('role'), style.color, style.backgroundColor]
    })
    return {
      theme: document.documentElement.dataset.theme, route: location.hash, tokens, backgrounds, placeholders, selectedText,
      navigation: [['default', navigationDefault.color, navigationBackgrounds], ['hover', tokens['--text'], [tokens['--hover']]]],
      primary: primary ? [primary.color, primaryBackground] : [tokens['--secondary'], tokens['--canvas']],
      primaryEnabled: Boolean(enabledButton),
    }
  })()`)
  assert.ok(palette.placeholders.length > 0, "对比度检查读取实际输入控件的占位符颜色")
  const checks = []
  for (const [role, foreground] of [...['--text', '--secondary', '--muted'].map(token => [token, palette.tokens[token]]), ...palette.placeholders]) {
    const candidates = palette.backgrounds.map(([backgroundRole, background]) => ({ role, foreground, backgroundRole, background, ratio: contrastRatio(foreground, background), minimum: 4.5 }))
    checks.push(candidates.reduce((worst, candidate) => candidate.ratio < worst.ratio ? candidate : worst))
  }
  for (const [role, foreground, backgrounds] of palette.navigation) {
    checks.push(backgrounds.map(background => ({ role: 'navigation ' + role, foreground, background, ratio: contrastRatio(foreground, background), minimum: 3 })).reduce((worst, candidate) => candidate.ratio < worst.ratio ? candidate : worst))
  }
  for (const [role, foreground, background] of [['primary', ...palette.primary], ['primary hover', palette.tokens['--text'], palette.tokens['--hover']], ...palette.selectedText]) {
    checks.push({ role, foreground, background, ratio: contrastRatio(foreground, background), minimum: 4.5 })
  }
  for (const [backgroundRole, background] of palette.backgrounds) {
    const foreground = palette.tokens['--focus-ring']
    checks.push({ role: 'focus ring', foreground, backgroundRole, background, ratio: contrastRatio(foreground, background), minimum: 3 })
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
    const shellGradients = ['.titlebar', '.sidebar', '.app-statusbar'].map(selector => [selector, getComputedStyle(document.querySelector(selector)).backgroundImage])
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
  /** @param token 当前主题的颜色 Token。 @returns 浏览器解析后的颜色。 */
  const tokenColor = (token) => evaluate(`(() => { const probe = document.createElement('span'); probe.style.color = 'var(' + ${JSON.stringify(token)} + ')'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color })()`)
  registerWindowIpcHandlers(ipcMain, BrowserWindow)
  profile = await mkdtemp(join(tmpdir(), "nicode-workspace-design-"))
  app.setPath("userData", join(profile, "electron"))
  let renameFails = true
  let pickDirectory = false
  const folder = join(profile, "associated")
  const transcript = "## 用户\n\n**原文**\n\n## 助手\n\n回复"
  ipcMain.handle(projectChannels.renameProject, (_event, id, name) => {
    const project = projects.find((item) => item.projectId === id)
    assert.equal(id, PROJECT)
    project.name = name
    return project
  })
  ipcMain.handle(projectChannels.selectDirectory, () => pickDirectory ? { path: folder, name: "associated" } : null)
  ipcMain.handle(projectChannels.addProjectDirectory, (_event, id, path) => {
    assert.equal(id, PROJECT)
    assert.equal(path, folder)
    projects[0].directories.push(path)
    return { success: true }
  })
  ipcMain.handle(projectChannels.removeProjectDirectory, (_event, id, path) => {
    assert.equal(id, PROJECT)
    projects[0].directories = projects[0].directories.filter((directory) => directory !== path)
    return { success: true }
  })
  ipcMain.handle(session.renameSession, (_event, id, sessionId, name) => {
    assert.equal(id, PROJECT)
    assert.equal(sessionId, "project-session")
    if (renameFails) { renameFails = false; throw new Error("保存失败，请重试") }
    projects[0].sessions[0].name = name
    return projects[0].sessions[0]
  })
  ipcMain.handle(session.exportSessionMarkdown, (_event, id, sessionId) => {
    assert.equal(id, "default")
    assert.equal(sessionId, "design")
    return transcript
  })
  let summaryReads = 0
  ipcMain.handle(startup.listProjects, () => { summaryReads++; return projects })
  ipcMain.handle(startup.listDefaultSessions, () => { summaryReads++; return sessions })
  ipcMain.handle(startup.listProviders, () => providers)
  ipcMain.handle(provider.listCompatibleProviders, () => [])
  ipcMain.handle(skill.listSkills, (_event, target) => {
    skillReads++
    return ["code-review", "project-conventions"].map((name, index) => ({ name, path: join(profile, target.scope === "global" ? "global" : target.projectId, "skills", name), scope: target.scope, enabled: index === 0, description: index === 0 ? "从代码结构、边界条件与可维护性出发，检查改动并给出清晰的建议。" : "记录项目约定，让每次协作都沿用熟悉的工作方式。" }))
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
    return { projectId, sessionId, kind: "ordinary", summary: { sessionId, name: sessions[0].name, updatedAt }, events: fixtures, streamEvents: [], latestSeq: fixtures.length,
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
    onWindowCreated: (window) => window.on("close", (event) => {
      event.preventDefault()
      window.minimize()
    }),
  })
  manager.createMainWindow()
  window.webContents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message) })
  await until(() => evaluate("document.querySelectorAll('.session-name').length === 4 && Boolean(document.querySelector('.model-trigger'))"))
  assert.equal(historyReads, 0, "摘要首页不加载任何历史")
  assert.equal(skillReads + mcpReads, 0, "启动不读取技能或 MCP")
  await fits()
  await evaluate("document.activeElement.blur()")
  window.webContents.sendInputEvent({ type: "mouseMove", x: 800, y: 300 })
  await screenshot("workspace-light")
  assert.equal(await evaluate("document.querySelector('.send-button').disabled"), true, "空草稿时发送按钮禁用")
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.send-button')).backgroundColor"), await tokenColor('--accent'), "禁用的发送按钮不占用主操作强调色")
  await assertWorkspacePalette("rgb(255, 255, 255)", [".welcome-scroll", ".welcome"])
  assert.equal(await evaluate("Boolean(document.querySelector('.activity-rail, .workspace-identity, .sidebar-search, .session-name svg, .workspace-badge'))"), false, "单侧栏移除重复身份、搜索、图标和空间标记")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.project-action-button')).opacity"), "0", "项目添加按钮默认隐去")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.section-action-button')).opacity"), "0", "分组操作默认隐去")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.composer-caption')).opacity"), "0", "输入提示在输入前保持安静")
  const projectRow = await evaluate("(() => { const rect = document.querySelector('.project-row').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), width: rect.width } })()")
  window.webContents.sendInputEvent({ type: "mouseMove", x: projectRow.x, y: projectRow.y })
  await until(() => evaluate("getComputedStyle(document.querySelector('.project-action-button')).opacity === '1'"))
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.chats-section .section-action-button')).opacity"), "0", "悬停项目只披露当前行操作")
  assert.equal(await evaluate("getComputedStyle(document.querySelectorAll('.project-action-button')[1]).opacity"), "0", "其它项目的操作保持隐藏")
  assert.equal(await evaluate("(() => { const node = document.querySelectorAll('.project-name > span')[1]; return node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis' })()"), true, "长项目名称省略显示，完整名称仍可通过 title 读取")
  assert.equal(await evaluate("document.querySelector('.project-row').getBoundingClientRect().width"), projectRow.width, "披露操作不挤动列表")
  await screenshot("workspace-sidebar-hover")
  window.webContents.sendInputEvent({ type: "mouseMove", x: 800, y: 300 })
  await until(() => evaluate("getComputedStyle(document.querySelector('.project-action-button')).opacity === '0'"))
  await evaluate("document.querySelector('.project-name').focus()")
  await until(() => evaluate("getComputedStyle(document.querySelector('.project-action-button')).opacity === '1'"))
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" })
  await until(() => evaluate("document.activeElement.matches('.project-action-button')"))
  const focusedOutline = await evaluate("(() => { const style = getComputedStyle(document.activeElement); return [style.outlineStyle, style.outlineWidth, style.outlineColor] })()")
  assert.notEqual(focusedOutline[1], '0px', "键盘焦点有可见轮廓")
  const focusedPoint = await evaluate("(() => { const rect = document.activeElement.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  window.webContents.sendInputEvent({ type: "mouseMove", ...focusedPoint })
  await until(() => evaluate("document.activeElement.matches(':hover')"))
  assert.deepEqual(await evaluate("(() => { const style = getComputedStyle(document.activeElement); return [style.outlineStyle, style.outlineWidth, style.outlineColor] })()"), focusedOutline, "悬停不覆盖键盘焦点轮廓")
  await screenshot("workspace-sidebar-focus")
  await click(".project-action-button")
  await until(() => evaluate("location.hash.includes('/projects/') && document.activeElement.matches('.composer-editor')"))
  assert.equal(await evaluate("document.querySelector('.breadcrumb > span').title"), projects[0].directories.join(" · "), "关联目录仍可从项目名称的悬停提示读取")
  assert.equal(historyReads, 0, "渐进披露入口打开项目新聊天，不读取历史")
  await click(".new-chat")
  await until(() => evaluate("location.hash.includes('/default/new-chat')"))
  await evaluate("document.activeElement.blur(); document.querySelector('.project-section .section-heading').focus()")
  await until(() => evaluate("getComputedStyle(document.querySelector('.section-action-button')).opacity === '1'"))
  await evaluate("document.activeElement.blur()")
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
  const newChatSelectorAppearance = `Array.from(document.querySelectorAll('.new-chat-composer .selector-trigger')).map(node => {
    const style = getComputedStyle(node)
    return { text: node.textContent, color: style.color, background: style.backgroundColor, shadow: style.boxShadow, font: style.font, weight: style.fontWeight }
  })`
  const restingNewChatSelectors = await evaluate(newChatSelectorAppearance)
  assert.equal(restingNewChatSelectors.every(control => control.background === "rgba(0, 0, 0, 0)"), true, "新聊天的权限与模型没有独立底色")
  assert.equal(await evaluate("[...document.querySelectorAll('.new-chat-composer button:not(.send-button), .composer-toolbar, .composer-controls')].every(node => { const style = getComputedStyle(node); return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.boxShadow === 'none' && style.borderTopWidth === '0px' })"), true, "输入框内的选择入口和工具栏不形成第二层框")
  assert.equal(await evaluate("document.querySelectorAll('.new-chat-composer [aria-label=\"权限\"] svg').length === 1 && document.querySelectorAll('.model-trigger > .composer-model-chevron').length === 1"), true, "模型入口保留一个展开箭头")
  const newComposerPoint = await evaluate("(() => { const rect = document.querySelector('.new-chat-composer .composer-editor').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } })()")
  window.webContents.sendInputEvent({ type: "mouseMove", ...newComposerPoint })
  await screenshot("workspace-composer-hover")
  assert.deepEqual(await evaluate(newChatSelectorAppearance), restingNewChatSelectors, "悬停新聊天输入框不改变权限与模型外观")
  window.webContents.focus()
  await evaluate("document.querySelector('.composer-editor').focus()")
  await screenshot("workspace-composer-focus")
  assert.deepEqual(await evaluate(newChatSelectorAppearance), restingNewChatSelectors, "聚焦新聊天输入框不改变权限与模型外观")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.composer-caption')).opacity"), "1", "输入聚焦后披露快捷键提示")
  const focusedComposer = await evaluate(`(() => {
    const composer = getComputedStyle(document.querySelector('.composer'))
    const textarea = getComputedStyle(document.querySelector('.composer-editor'))
    return { shadow: composer.boxShadow, outlineStyle: composer.outlineStyle, inputOutline: textarea.outlineWidth, radius: composer.borderTopLeftRadius, inputRadius: textarea.borderTopLeftRadius, fontSize: textarea.fontSize, lineHeight: textarea.lineHeight }
  })()`)
  assert.notEqual(focusedComposer.shadow, restingComposerShadow, "输入聚焦时整个容器显示阴影反馈")
  assert.ok(focusedComposer.shadow.replace(/\([^)]*\)/g, "").split(",").length >= 2, "聚焦反馈保留多层柔和阴影")
  assert.equal(focusedComposer.outlineStyle, "none", "输入外壳不显示焦点描边")
  assert.equal(focusedComposer.inputOutline, "0px", "文本域不显示焦点描边")
  assert.deepEqual([focusedComposer.radius, focusedComposer.inputRadius, focusedComposer.fontSize, focusedComposer.lineHeight], ["12px", "12px", "14px", "22px"], "外壳及输入遵循共同的圆角和字阶")
  nativeKey("Tab")
  await until(() => evaluate("document.activeElement?.getAttribute('aria-label') === '权限' && document.activeElement.matches(':focus-visible')"))
  await evaluate("Promise.all(document.activeElement.getAnimations().map(animation => animation.finished))")
  assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none", "新对话权限入口的键盘焦点没有线框")
  assert.equal(await evaluate("getComputedStyle(document.activeElement).backgroundColor"), await tokenColor('--hover'), "权限入口使用可见背景反馈键盘焦点")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.composer')).outlineStyle"), "none", "工具栏聚焦时外壳不显示描边")
  for (const type of ["keyDown", "char", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: type === "char" ? "\r" : "Enter" })
  await until(() => evaluate("Boolean(document.querySelector('.permission-menu'))"))
  nativeKey("Tab")
  await until(() => evaluate("document.activeElement?.matches('.permission-menu button:focus-visible')"))
  await evaluate("Promise.all(document.activeElement.getAnimations().map(animation => animation.finished))")
  assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none", "权限选项的键盘焦点没有线框")
  assert.equal(await evaluate("getComputedStyle(document.activeElement).backgroundColor"), await tokenColor('--hover'), "权限选项使用可见背景反馈键盘焦点")
  nativeKey("Escape")
  await until(() => evaluate("!document.querySelector('.permission-menu')"))
  window.webContents.focus()
  await evaluate("document.querySelector('.composer-editor').focus()")
  assert.equal(await evaluate("document.querySelectorAll('.starter-grid, .recent-sessions').length"), 0, "主页移除重复信息")
  const initialHeight = await evaluate("document.querySelector('.composer-editor').clientHeight")
  assert.ok(initialHeight <= 48, "初始只有一行")
  await input('[aria-label="任务描述"]', "第一行\n第二行\n第三行\n第四行")
  await until(() => evaluate(`document.querySelector('.composer-editor').clientHeight > ${initialHeight + 40}`))
  await input('[aria-label="任务描述"]', "一行内容\n".repeat(40))
  await until(() => evaluate("document.querySelector('.composer-editor').clientHeight === 200 && getComputedStyle(document.querySelector('.composer-editor')).overflowY === 'auto'"))
  await input('[aria-label="任务描述"]', "")
  await until(() => evaluate(`document.querySelector('.composer-editor').clientHeight === ${initialHeight}`))
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.composer-editor')).resize"), "none")
  await nativeClick('[aria-label="权限"] svg')
  await until(() => evaluate("Boolean(document.querySelector('.permission-menu'))"))
  const permissionMenuFits = `(() => {
    const rects = [...document.querySelectorAll('.permission-menu button')].map(button => button.getBoundingClientRect())
    return rects.length === 4 && rects.every((rect, index) => rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && (index === 0 || rect.top - rects[index - 1].bottom >= 3.5))
  })()`
  assert.equal(await evaluate(permissionMenuFits), true, "新对话权限选项之间有留白且菜单位于窗口内")
  await screenshot("workspace-permission-light")
  await nativeClick(".permission-menu button:last-of-type")
  await until(() => evaluate("document.querySelector('[aria-label=\"权限\"]').textContent === '完全访问'"))
  await nativeClick('[aria-label="权限"]')
  await until(() => evaluate("Boolean(document.querySelector('.permission-menu'))"))
  await nativeClick(".permission-menu button:nth-of-type(2)")
  await until(() => evaluate("document.querySelector('[aria-label=\"权限\"]').textContent === '工作区读写'"))
  await input('[aria-label="任务描述"]', "我的草稿")
  await evaluate("document.querySelector('.composer-editor').focus()")
  await until(() => evaluate("!document.querySelector('.send-button').disabled"))
  await evaluate("Promise.all(document.querySelector('.send-button').getAnimations().map(animation => animation.finished))")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.send-button')).backgroundColor"), await tokenColor('--accent'), "可发送时使用主操作强调色")
  await screenshot("workspace-composer-draft")
  await assertPaletteContrast("composer draft enabled")
  await openPositionedModelMenu()
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  assert.equal(await evaluate("document.querySelectorAll('.reasoning-anchor').length"), 0, "模型和推理共用一个入口")
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.model-setting-label')].map(node => node.textContent)"), ["模型", "推理等级"], "主菜单只显示模型和推理等级两行")
  assert.equal(await evaluate("Boolean(document.querySelector('.composer-model-panel input[type=\"range\"]'))"), false, "等级通过列表选择")
  assert.equal(await evaluate("(() => { const name = document.querySelector('.composer-model-name').getBoundingClientRect(); const level = document.querySelector('.composer-model-reasoning').getBoundingClientRect(); return Math.abs(name.top - level.top) < 2 && level.left >= name.right })()"), true, "模型名和推理等级在同一行")
  assert.equal(await evaluate("(() => { const rect = document.querySelector('.composer-model-panel').getBoundingClientRect(); return rect.left >= 12 && rect.top >= 12 && rect.right <= innerWidth - 12 && rect.bottom <= innerHeight - 12 })()"), true, "模型面板位于窗口内")
  await screenshot("workspace-model-settings")
  await assertLongInvalidLevel("light")
  window.webContents.focus()
  await evaluate("document.querySelector('[aria-label=\"设置推理等级\"]').focus()")
  nativeKey("Right")
  await until(() => evaluate("Boolean(document.querySelector('.reasoning-menu'))"))
  assertModelMenuGeometry(await evaluate(modelMenuGeometry))
  await until(() => evaluate("document.activeElement === document.querySelector('.reasoning-menu [aria-checked=\"true\"]')"))
  await assertModelStates("light")
  nativeKey("End")
  await until(() => evaluate("document.activeElement?.textContent.includes('high')"))
  for (const type of ["keyDown", "char", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: type === "char" ? "\r" : "Enter" })
  await until(() => evaluate("document.querySelector('.composer-model-reasoning').textContent === 'high'"))
  await click(".model-trigger")
  await until(() => evaluate("Boolean(document.querySelector('.model-settings-menu'))"))
  await click('[aria-label="设置推理等级"]')
  await until(() => evaluate("Boolean(document.querySelector('.reasoning-menu'))"))
  await until(() => evaluate("document.activeElement === document.querySelector('.reasoning-menu [aria-checked=\"true\"]')"))
  nativeKey("Home")
  await until(() => evaluate("document.activeElement?.textContent.includes('low')"))
  for (const type of ["keyDown", "char", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: type === "char" ? "\r" : "Enter" })
  await until(() => evaluate("document.querySelector('.composer-model-reasoning').textContent === 'low'"))
  await click(".model-trigger")
  await until(() => evaluate("Boolean(document.querySelector('.model-settings-menu'))"))
  await screenshot("workspace-model-reasoning")
  window.setSize(640, 800)
  await until(() => evaluate("innerWidth === 640"))
  await fits()
  await screenshot("workspace-model-reasoning-narrow")
  await assertLongInvalidLevel("narrow")
  const compactModelMenu = await evaluate("(() => { const node = document.querySelector('.composer-model-panel'); const rect = node.getBoundingClientRect(); return { open: node.matches(':popover-open'), left: rect.left, right: rect.right, top: rect.top, viewport: innerWidth } })()")
  assert.ok(compactModelMenu.open && compactModelMenu.left >= 12 && compactModelMenu.right <= compactModelMenu.viewport - 12 && compactModelMenu.top >= 12, "窄窗口菜单边界：" + JSON.stringify(compactModelMenu))
  await key("Escape")
  await until(() => evaluate("!document.querySelector('.composer-model-panel:popover-open')"))
  await openPositionedModelMenu()
  await until(() => evaluate("Boolean(document.querySelector('.model-settings-menu'))"))
  await click('[aria-label="切换模型"]')
  await until(() => evaluate("Boolean(document.querySelector('.model-menu'))"))
  assertModelMenuGeometry(await evaluate(modelMenuGeometry))
  await assertLongModelOption("narrow")
  await click('.model-panel-back')
  await until(() => evaluate("Boolean(document.querySelector('.model-settings-menu'))"))
  window.setSize(1440, 1000)
  await until(() => evaluate("innerWidth === 1440"))
  await click('[aria-label="切换模型"]')
  await until(() => evaluate("Boolean(document.querySelector('.model-menu'))"))
  await screenshot("workspace-model-menu")
  await assertLongModelOption("light")
  await assertPaletteContrast("model menu")
  await key("Escape")
  await until(() => evaluate("!document.querySelector('.composer-model-panel:popover-open')"))
  assert.equal(await evaluate("document.activeElement.classList.contains('model-trigger')"), true, "Escape 恢复模型入口焦点")
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
  assert.equal(await evaluate("document.querySelector('[aria-label=\"对话模型\"]').tagName"), "BUTTON", "已有对话使用统一模型和推理入口")
  await click('[aria-label="切换深色外观"]')
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
  await screenshot("workspace-conversation-dark")
  await nativeClick('[aria-label="对话模型"]')
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-panel:popover-open'))"))
  await until(() => evaluate("document.activeElement === document.querySelector('[data-model-setting=\"models\"]')"))
  await key("Escape")
  await until(() => evaluate("!document.querySelector('.composer-model-panel:popover-open')"))
  await openPositionedModelMenu()
  await until(() => evaluate("Boolean(document.querySelector('.model-settings-menu'))"))
  await screenshot("workspace-model-reasoning-dark")
  await assertLongInvalidLevel("dark")
  /** 截取已渲染的菜单和入口，供直接对照本次参考图。 */
  const modelMenuBounds = await evaluate("(() => { const panel = document.querySelector('.composer-model-panel').getBoundingClientRect(); const trigger = document.querySelector('.model-trigger').getBoundingClientRect(); const x = Math.floor(Math.max(0, panel.left - 12)); const y = Math.floor(Math.max(0, panel.top - 12)); return { x, y, width: Math.ceil(Math.min(innerWidth, Math.max(panel.right, trigger.right) + 12)) - x, height: Math.ceil(Math.min(innerHeight, trigger.bottom + 8)) - y } })()")
  await writeFile(join(process.cwd(), "dist/workspace-model-settings-detail-dark.png"), (await window.webContents.capturePage(modelMenuBounds)).toPNG())
  await click('[aria-label="切换模型"]')
  await until(() => evaluate("Boolean(document.querySelector('.model-menu'))"))
  await assertLongModelOption("dark")
  await click('.model-panel-back')
  await until(() => evaluate("Boolean(document.querySelector('.model-settings-menu'))"))
  await click('[aria-label="设置推理等级"]')
  await until(() => evaluate("Boolean(document.querySelector('.reasoning-menu'))"))
  await assertModelStates("dark")
  await key("Escape")
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
  await until(() => evaluate("document.querySelector('[aria-label=\"停止\"]')?.disabled === false"))
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.approval-actions .settings-primary-button')).backgroundColor"), await tokenColor('--accent'), "审批确认使用主操作强调色")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.approval-actions .settings-secondary-button')).backgroundColor"), await tokenColor('--surface-muted'), "审批拒绝使用次级操作底色")
  assert.equal(await evaluate("document.querySelectorAll('.chat-messages .approval-actions, .chat-messages .approval-card').length"), 0, "审批请求只在输入区浮窗中显示")
  assert.equal(await evaluate("document.querySelector('.approval-popover')?.getAttribute('role')"), "dialog")
  await screenshot("workspace-approval-queue")
  await screenshotVisionDeficiencies()
  await click(".approval-actions .settings-primary-button")
  await until(() => evaluate("document.querySelector('.session-phase')?.textContent === '准备就绪'"))
  assert.deepEqual(decisions, [{ projectId: "default", sessionId: "review", approvalId: "approval-fixture", decision: "approved" }], "审批按钮沿用原有 IPC 参数")
  window.webContents.send(session.update, { kind: "state", projectId: "default", sessionId: "review", control: { revision: 4, throughSeq: 9, phase: "stopping", currentTurn: 2, currentModel: model, sandboxMode: "sandbox-full-access", pendingMessages: [], discardedMessages: [] } })
  await until(() => evaluate("document.querySelector('[aria-label=\"正在停止\"]')?.disabled === true"))
  await input('[aria-label="消息内容"]', "停止期间的草稿")
  assert.equal(await evaluate("document.querySelector('[aria-label=\"正在停止\"]')?.disabled === true && !document.querySelector('[aria-label=\"加入队列\"]')"), true, "停止中即使有草稿也不能发送或重复停止")
  await input('[aria-label="消息内容"]', "")
  window.webContents.send(session.update, { kind: "state", projectId: "default", sessionId: "review", control: { revision: 5, throughSeq: 9, phase: "idle", currentTurn: 2, currentModel: model, sandboxMode: "sandbox-full-access", pendingMessages: [], discardedMessages: [] } })
  await until(() => evaluate("document.querySelector('[aria-label=\"发送消息\"]')?.disabled === true"))
  await click(".new-chat")
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"任务描述\"]'))"))
  assert.equal(await evaluate("document.querySelector('.composer-editor').textContent === '我的草稿'"), true, "跨路由保留草稿")
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
  await nativeClick('[aria-label="权限"]')
  await until(() => evaluate("Boolean(document.querySelector('.permission-menu'))"))
  assert.equal(await evaluate(permissionMenuFits), true, "深色主题的新对话权限选项有留白且位于窗口内")
  await screenshot("workspace-permission-dark")
  nativeKey("Escape")
  await until(() => evaluate("!document.querySelector('.permission-menu')"))
  await evaluate("document.activeElement.blur()")
  window.webContents.sendInputEvent({ type: "mouseMove", x: 4, y: 4 })
  await evaluate("Promise.all(document.querySelector('.composer').getAnimations().map(animation => animation.finished))")
  const restingDarkComposer = await evaluate("getComputedStyle(document.querySelector('.composer')).backgroundColor.match(/[\\d.]+/g).slice(0, 3).map(Number)")
  await evaluate("document.querySelector('.composer-editor').focus()")
  await screenshot("workspace-dark-focus")
  assert.equal(await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('.composer'))
    const channels = style.backgroundColor.match(/[\\d.]+/g).slice(0, 3).map(Number)
    return channels.every((value, index) => value < ${JSON.stringify(restingDarkComposer)}[index]) && style.boxShadow !== 'none' && style.boxShadow.replace(/\\([^)]*\\)/g, '').split(',').length >= 2 && style.outlineStyle === 'none'
  })()`), true, "深色输入框聚焦时整体加深并显示柔和阴影，不显示描边")
  await window.reload()
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark' && Boolean(document.querySelector('.welcome'))"))
  assert.equal(await evaluate("localStorage.getItem('nicode.appearance')"), "dark", "重新载入后保留主题")
  await assertWorkspacePalette("rgb(35, 35, 35)", [".welcome-scroll", ".welcome"])
  await click(".sidebar-settings")
  await until(() => evaluate("Boolean(document.querySelector('.provider-detail'))"))
  await screenshot("workspace-settings-dark")
  await assertPaletteContrast("settings")
  await click('[aria-label="新增供应商"]')
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"供应商\"]'))"))
  assert.deepEqual(await evaluate("[...document.querySelector('[aria-label=\"供应商\"]').options].map(option => option.textContent)"), ["自定义"], "空目录只显示自定义")
  await openSelect('[aria-label="供应商协议"]')
  await screenshot("workspace-select-protocol-dark")
  nativeKey("Escape")
  await until(() => evaluate("!document.querySelector('select:open')"))
  assert.equal(await evaluate("Boolean(document.querySelector('.settings-dialog'))"), true, "Escape 先关闭下拉浮层，保留设置弹窗")
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
  assert.equal(await evaluate("[...document.querySelectorAll('.provider-model-editor')].every(node => { const style = getComputedStyle(node); return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none' && style.borderTopWidth === '0px' })"), true, "模型编辑区不再用卡片包字段")
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
  await click('[aria-label="新增供应商"]')
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"供应商协议\"]'))"))
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.settings-form-footer .settings-primary-button')).backgroundColor"), await tokenColor('--accent'), "无效表单的提交按钮保持禁用外观")
  await openSelect('[aria-label="供应商协议"]')
  await screenshot("workspace-select-protocol")
  nativeKey("End")
  nativeKey("Enter")
  await until(() => evaluate("!document.querySelector('select:open') && document.querySelector('[aria-label=\"供应商协议\"]').value !== ''"))
  await evaluate("[...document.querySelectorAll('.settings-nav-option')].find(node => node.textContent === 'MCP').click()")
  await until(() => evaluate("document.querySelector('.mcp-settings')?.getAttribute('aria-busy') === 'false'"))
  assert.equal(mcpReads, 1)
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('[aria-label=\"新增 MCP\"]')).backgroundColor"), await tokenColor('--accent'), "列表新增操作不占用主操作强调色")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[aria-label=\"刷新 MCP\"]')).backgroundColor"), await tokenColor('--surface-muted'), "次级按钮使用低对比底色")
  await screenshot("workspace-mcp")
  await openSelect('[aria-label="MCP 传输类型"]')
  await screenshot("workspace-select-mcp")
  await nativeClick('[aria-label="MCP 传输类型"] option[value="streamable-http"]')
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"MCP URL\"]'))"))
  await openSelect('[aria-label="MCP 传输类型"]')
  nativeKey("Home")
  nativeKey("Enter")
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"MCP 启动命令\"]'))"))
  await evaluate("[...document.querySelectorAll('.settings-nav-option')].find(node => node.textContent === '技能').click()")
  await until(() => evaluate("document.querySelectorAll('.skill-entry').length === 2"))
  assert.equal(skillReads, 1)
  await screenshot("workspace-skills")
  await openSelect('[aria-label="技能作用域"]')
  await screenshot("workspace-select-scope")
  nativeKey("End")
  nativeKey("Enter")
  await until(() => evaluate(`document.querySelector('[aria-label="技能作用域"]').value === ${JSON.stringify('project:' + projects[1].projectId)} && document.querySelectorAll('.skill-entry').length === 2`))
  await fits()
  await screenshot("workspace-select-scope-long")
  await openSelect('[aria-label="技能作用域"]')
  nativeKey("Home")
  nativeKey("Enter")
  await until(() => evaluate("document.querySelector('[aria-label=\"技能作用域\"]').value === 'global' && !document.querySelector('select:open')"))
  await openSelect('[aria-label="技能作用域"]')
  await nativeClick(".skill-toolbar h3")
  await until(() => evaluate("!document.querySelector('select:open')"))
  assert.equal(await evaluate("Boolean(document.querySelector('.settings-dialog'))"), true, "点击浮层外只收起选项")
  await key("Escape")
  await until(() => evaluate("!document.querySelector('.settings-dialog')"))
  await click('[aria-label="创建项目"]')
  await until(() => evaluate("document.activeElement.id === 'project-name'"))
  assert.equal(await evaluate("document.querySelector('.create-project-button').disabled"), true, "空项目名不能提交")
  await input('#project-name', '视觉验证项目')
  await until(() => evaluate("!document.querySelector('.create-project-button').disabled"))
  await evaluate("Promise.all(document.querySelector('.create-project-button').getAnimations().map(animation => animation.finished))")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.create-project-button')).backgroundColor"), await tokenColor('--accent'), "项目创建确认使用主操作强调色")
  await screenshot("workspace-create-project")
  await key("Escape")
  await key("b", { ctrlKey: true })
  await until(() => evaluate("!document.querySelector('.sidebar')"))
  assert.equal(await evaluate("Boolean(document.querySelector('.panel-header [aria-label=\"设置\"]') && document.querySelector('.panel-header [aria-label=\"切换深色外观\"]') && document.querySelector('.panel-header [aria-label=\"在当前空间新建聊天\"]'))"), true, "收起侧栏后仍可访问设置、外观与新聊天")
  await click('[aria-label="展开侧栏"]')
  await until(() => evaluate("Boolean(document.querySelector('.sidebar'))"))
  window.setSize(640, 760)
  await screenshot("workspace-narrow")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.new-chat-composer [aria-label=\"权限\"] svg')).display !== 'none'"), true, "窄窗口仍保留绑定的权限图标")
  await nativeClick('[aria-label="权限"]')
  await until(() => evaluate("Boolean(document.querySelector('.permission-menu'))"))
  assert.equal(await evaluate(permissionMenuFits), true, "窄窗口的新对话权限菜单有留白且未越出窗口")
  await screenshot("workspace-permission-narrow")
  nativeKey("Escape")
  await until(() => evaluate("!document.querySelector('.permission-menu')"))
  await fits()
  await evaluate("document.querySelector('.sidebar-settings').focus()")
  await click(".sidebar-settings")
  await until(() => evaluate("Boolean(document.querySelector('.settings-dialog'))"))
  await evaluate("[...document.querySelectorAll('.settings-nav-option')].find(node => node.textContent === '技能').click()")
  await until(() => evaluate("document.querySelectorAll('.skill-entry').length === 2"))
  await fits()
  await screenshot("workspace-settings-narrow")
  await openSelect('[aria-label="技能作用域"]')
  await screenshot("workspace-select-scope-narrow")
  nativeKey("Escape")
  await until(() => evaluate("!document.querySelector('select:open')"))
  await evaluate("(() => { const nodes = [...document.querySelector('.settings-dialog').querySelectorAll('button, input, select')].filter(node => !node.disabled && node.getClientRects().length); nodes.at(-1).focus() })()")
  await key("Tab")
  assert.equal(await evaluate("document.querySelector('.settings-dialog').contains(document.activeElement)"), true, "Tab 焦点保留在弹窗内")
  await key("Escape")
  await until(() => evaluate("document.activeElement.matches('.sidebar-settings')"))
  window.webContents.debugger.attach("1.3")
  try {
    await window.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true })
    await until(() => evaluate("matchMedia('(pointer: coarse)').matches"))
    await evaluate("document.activeElement.blur()")
    await until(() => evaluate("[...document.querySelectorAll('.section-action-button, .project-action-button')].every(node => getComputedStyle(node).opacity === '1')"))
    await until(() => evaluate("[...document.querySelectorAll('.sidebar-more')].every(node => getComputedStyle(node).opacity === '1')"))
    await screenshot("workspace-touch")
  } finally {
    await window.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false })
    window.webContents.debugger.detach()
  }
  await click('.project-sessions .session-name')
  await until(() => evaluate("Boolean(document.querySelector('.project-sessions .session-name[aria-current=\"page\"]') && document.querySelector('.final-answer'))"))
  window.webContents.sendInputEvent({ type: "mouseMove", x: 500, y: 100 })
  await evaluate("document.activeElement.blur()")
  /** aria-current 更新后，等待现有背景过渡产生可见帧，再检查选中外观。 */
  await until(() => evaluate("getComputedStyle(document.querySelector('.project-sessions .session-name[aria-current=\"page\"]')).backgroundColor !== 'rgba(0, 0, 0, 0)'"))
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.project-row')).backgroundColor"), "rgba(0, 0, 0, 0)", "选中项目对话时项目行保留原底色")
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.project-sessions .session-name[aria-current=\"page\"]')).backgroundColor"), "rgba(0, 0, 0, 0)", "只为选中的对话保留高亮")
  assert.equal(await evaluate("document.querySelector('.project-name').hasAttribute('aria-current')"), false, "项目分组不同时标记为当前页面")
  await screenshot('workspace-project-session-centered')
  const originalRoute = await evaluate("location.hash")
  const historyBeforeCopy = historyReads
  const projectMore = ".project-row .sidebar-more"
  const projectSessionMore = ".project-sessions .sidebar-more"
  const defaultMore = ".chats-section .sidebar-more"
  const menu = ".sidebar-action-menu"
  const dialog = "[aria-labelledby=sidebar-dialog-title]"
  const nameField = "#sidebar-target-name"
  await click(projectMore)
  await until(() => evaluate("document.activeElement.textContent === '设置关联目录'"))
  await key("ArrowDown")
  assert.equal(await evaluate("document.activeElement.textContent"), "重命名")
  await key("Escape")
  await until(() => evaluate("document.activeElement.matches('.project-row .sidebar-more') && !document.querySelector('.sidebar-action-menu')"))
  await click(projectMore)
  await click(menu + " button:first-child")
  await until(() => evaluate("document.activeElement.matches('.project-directory-add')"))
  await click(dialog + " .project-directory-add")
  await until(() => evaluate("!document.querySelector('.project-directory-add').disabled"))
  assert.equal(await evaluate("document.querySelectorAll('[aria-labelledby=sidebar-dialog-title] .project-directory-row').length"), 1)
  pickDirectory = true
  await click(dialog + " .project-directory-add")
  await until(() => evaluate("document.querySelectorAll('[aria-labelledby=sidebar-dialog-title] .project-directory-row').length === 2"))
  await click(dialog + " .project-directory-row:nth-child(2) button")
  await until(() => evaluate("document.querySelectorAll('[aria-labelledby=sidebar-dialog-title] .project-directory-row').length === 1"))
  await click(dialog + " .project-dialog-close")
  await click(projectMore)
  await click(menu + " button:last-child")
  await until(() => evaluate("document.activeElement.id === 'sidebar-target-name'"))
  assert.equal(await evaluate("document.querySelector('#sidebar-target-name').value"), "NiCode")
  await input(nameField, "  NiCode Workspace  ")
  await click(dialog + " button[type=submit]")
  await until(() => evaluate("document.querySelector('.breadcrumb > span').textContent === 'NiCode Workspace'"))
  await click(projectSessionMore)
  await click(menu + " button:first-child")
  await until(() => evaluate("document.activeElement.id === 'sidebar-target-name'"))
  await input(nameField, "  已重命名的项目对话  ")
  await click(dialog + " button[type=submit]")
  await until(() => evaluate("document.querySelector('.project-dialog-error')?.textContent.includes('保存失败')"))
  assert.equal(await evaluate("document.querySelector('#sidebar-target-name').value"), "  已重命名的项目对话  ")
  await click(dialog + " button[type=submit]")
  await until(() => evaluate("document.querySelector('.breadcrumb strong').textContent === '已重命名的项目对话'"))
  const originalSize = window.getContentSize()
  window.setContentSize(480, 520)
  await until(() => evaluate("innerWidth <= 480"))
  await click(projectSessionMore)
  await until(() => evaluate("Boolean(document.querySelector('.sidebar-action-menu'))"))
  assert.equal(await evaluate("(() => { const r = document.querySelector('.sidebar-action-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })()"), true)
  await screenshot("workspace-sidebar-menu-narrow")
  assert.equal(await evaluate("document.querySelectorAll('.sidebar-action-menu [role=menuitem]').length"), 2)
  await key("Escape")
  window.setContentSize(...originalSize)
  await evaluate("Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text) => { window.copiedSidebarText = text } })")
  await click(defaultMore)
  await click(menu + " button:last-child")
  await until(() => evaluate("document.querySelector('.sidebar-copy-status')?.textContent === '已复制对话'"))
  assert.equal(await evaluate("window.copiedSidebarText"), transcript)
  await evaluate("Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('剪贴板不可用') } })")
  await click(defaultMore)
  await click(menu + " button:last-child")
  await until(() => evaluate("document.querySelector('.sidebar-copy-status[role=alert]')?.textContent.includes('剪贴板不可用')"))
  await evaluate("delete navigator.clipboard.writeText; document.querySelector('.sidebar-copy-status').getAnimations().forEach(animation => animation.finish())")
  assert.equal(await evaluate("location.hash"), originalRoute)
  assert.equal(historyReads, historyBeforeCopy, "后台复制和重命名均不导航或重新读取对话")

  await click('.project-name')
  await until(() => evaluate("!document.querySelector('.project-sessions')"))
  assert.equal(await evaluate("document.querySelector('.project-row').classList.contains('project-row-active')"), false, "收起当前对话所属项目不恢复项目行高亮")
  await click('.project-name')
  await until(() => evaluate("Boolean(document.querySelector('.project-sessions .session-name[aria-current=\"page\"]'))"))
  await click('.project-action-button')
  await until(() => evaluate("location.hash.includes('/projects/') && Boolean(document.querySelector('.project-row-active'))"))
  assert.equal(await evaluate("document.querySelector('.project-name').getAttribute('aria-current')"), "page", "项目新聊天页面仍标记当前项目入口")

  const sidebarFixture = [4, 1, 12, 3, 9, 6, 10, 2, 8, 11, 5, 7].map((number) => ({
    sessionId: `sidebar-${number}`, name: `侧栏摘要 ${number}`,
    updatedAt: new Date(Date.parse(updatedAt) + number * 1000).toISOString(),
  }))
  sidebarFixture.find((item) => item.sessionId === "sidebar-8").name = "侧栏摘要 8 · 一个很长的对话标题，用来验证文件夹下方的对话名称保持单行并在窄窗口中截断"
  projects[0].sessions = sidebarFixture
  projects[1].sessions = sidebarFixture.slice(0, 5)
  sessions.splice(0, sessions.length, ...sidebarFixture)
  for (const projectId of [PROJECT, "default"]) {
    window.webContents.send(session.update, { kind: "event", projectId, sessionId: "sidebar-refresh",
      event: { type: "turn/end", turn: 1, reason: "completed", seq: 1, eventId: "sidebar-update", sessionId: "sidebar-refresh", createdAt: updatedAt } })
  }
  const projectList = ".project-sessions"
  const defaultList = ".chats-section"
  const more = " .session-list-more"
  const sidebarNames = (scope) => evaluate(`[...document.querySelectorAll('${scope} .session-name')].map(node => node.title.match(/^侧栏摘要 (\\d+)/)?.[1])`)
  await until(async () => (await sidebarNames(projectList)).length === 5 && (await sidebarNames(defaultList)).length === 5)
  const sorted = ["12", "11", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1"]
  assert.deepEqual(await sidebarNames(projectList), sorted.slice(0, 5))
  assert.deepEqual(await sidebarNames(defaultList), sorted.slice(0, 5))
  const readsBeforeReveal = summaryReads
  const historyBeforeReveal = historyReads

  await click('.titlebar-search')
  await until(() => evaluate("Boolean(document.querySelector('.search-input-row input'))"))
  await input('.search-input-row input', '侧栏摘要 1')
  await until(() => evaluate("[...document.querySelectorAll('.search-result strong')].some(node => node.textContent === '侧栏摘要 1')"))
  await click('[aria-label="关闭搜索"]')
  await until(() => evaluate("!document.querySelector('.search-dialog')"))
  await click(".project-sessions .session-name")
  await until(() => evaluate("Boolean(document.querySelector('.project-sessions .session-name[aria-current]') && document.querySelector('.final-answer'))"))
  const summaryWindowSize = window.getContentSize()
  window.setContentSize(1200, 900)
  await until(() => evaluate("innerWidth === 1200 && !document.querySelector('.sidebar-copy-status')"))
  await screenshot("workspace-sidebar-summary")
  window.setContentSize(640, 800)
  await until(() => evaluate("innerWidth <= 640"))
  await click('[aria-label="切换深色外观"]')
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark'"))
  assert.equal(await evaluate(`(() => {
    const labels = document.querySelectorAll('.project-list > li:first-child :is(.project-name > span, .session-name > span, .session-list-more)')
    const starts = [...labels].map(node => node.getBoundingClientRect().left + (node.tagName === 'BUTTON' ? parseFloat(getComputedStyle(node).paddingLeft) : 0))
    const longTitle = labels[5]
    return starts.every(left => left === starts[0]) && longTitle.scrollWidth > longTitle.clientWidth && getComputedStyle(longTitle).textOverflow === 'ellipsis'
  })()`), true, "窄窗内项目标题、对话标题与展开入口对齐，长标题单行截断")
  await screenshot("workspace-sidebar-summary-narrow")
  await click('[aria-label="切换浅色外观"]')
  window.setContentSize(...summaryWindowSize)
  await until(() => evaluate(`innerWidth === ${summaryWindowSize[0]}`))
  await evaluate("document.querySelector('.project-sessions .session-list-more').focus()")
  await click(projectList + more)
  await until(async () => (await sidebarNames(projectList)).length === 10)
  assert.deepEqual(await sidebarNames(projectList), sorted.slice(0, 10))
  assert.deepEqual(await sidebarNames(defaultList), sorted.slice(0, 5), "项目与独立对话分别展开")
  assert.equal(await evaluate("document.activeElement.title"), "侧栏摘要 7", "展开后聚焦第一条新增对话")
  await click(projectList + more)
  await until(async () => (await sidebarNames(projectList)).length === 12)
  assert.deepEqual(await sidebarNames(projectList), sorted)
  assert.equal(await evaluate("Boolean(document.querySelector('.project-sessions .session-list-more'))"), false)
  await click(defaultList + more)
  await until(async () => (await sidebarNames(defaultList)).length === 10)
  assert.deepEqual(await sidebarNames(defaultList), sorted.slice(0, 10))
  assert.equal(summaryReads, readsBeforeReveal, "展开只处理前端已取得的摘要")
  assert.equal(historyReads, historyBeforeReveal + 1, "只有打开对话才读取历史")

  projects[1].updatedAt = sidebarFixture[0].updatedAt
  projects[0].sessions = sidebarFixture.map((item) => item.sessionId === "sidebar-1"
    ? { ...item, updatedAt: new Date(Date.parse(updatedAt) + 60000).toISOString() } : item)
  window.webContents.send(session.update, { kind: "event", projectId: PROJECT, sessionId: "sidebar-1",
    event: { type: "turn/end", turn: 1, reason: "completed", seq: 1, eventId: "sidebar-reorder", sessionId: "sidebar-1", createdAt: updatedAt } })
  await until(async () => (await sidebarNames(projectList))[0] === "1")
  assert.equal(await evaluate("document.querySelector('.project-name').title"), projects[1].name, "收到更新后项目按时间重新排序")
  assert.equal((await sidebarNames(projectList)).length, 12, "摘要更新保留已展开条数")
  await click('.project-name')
  await until(() => evaluate("document.querySelectorAll('.project-sessions').length === 2"))
  assert.equal(await evaluate("document.querySelectorAll('.project-sessions')[0].querySelectorAll('.session-name').length"), 5)
  assert.equal(await evaluate("Boolean(document.querySelector('.project-list > li:first-child .session-list-more'))"), false, "恰好五条无需展开")

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
  await click('[aria-label="关闭窗口"]')
  await until(() => window.isMinimized())
  assert.equal(window.isDestroyed(), false, "关闭按钮保留窗口及应用")
  window.restore()
  window.hide()
  await click('[aria-label="最小化窗口"]')
  await until(() => window.isMinimized())
  assert.equal(window.isDestroyed(), false)
  assert.deepEqual(errors, [])
  console.log("electron-workspace-design: 主题下拉浮层、鼠标与键盘选择、Escape 分层关闭、外部点击收起、浮层边界与选中项对比度、单侧栏与渐进披露、触屏、摘要搜索、历史缓存、草稿、模型菜单、项目入口、主题恢复、设置、输入自适应、窄窗口及窗口按钮均通过；截图保存在 dist/workspace-*.png，对比度报告保存在 dist/workspace-contrast.json")
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
