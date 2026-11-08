import { Component, lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { IconArrowLeft, IconArrowRight, IconFile, IconFileDiff, IconFolderOpen, IconMaximize, IconMessage, IconMinimize, IconPlus, IconRefresh, IconWorld, IconX } from "@tabler/icons-react"
import type { FileChange, FileReference } from "../../runtime/session/src/events.ts"
import type { BrowserPresentation, WebTagRef, WebTagState } from "../preload/browser-api.ts"
import type { ProjectSummary } from "../preload/session-api.ts"
import "./chat-browser.css"

const PatchDiff = lazy(async () => ({ default: (await import("@pierre/diffs/react")).PatchDiff }))
const FileExplorerViewer = lazy(() => import("./file-explorer-viewer.tsx"))
const ReferencedFilePreview = lazy(async () => ({ default: (await import("./file-preview.tsx")).ReferencedFilePreview }))
const minimumSplitPercent = 25
const maximumSplitPercent = 100 - minimumSplitPercent

/** 标签只持有重新渲染所需的数据。 */
export type BrowserTag =
  | { kind: "blank"; id: string }
  | { kind: "diff"; id: string; eventId: string; file: FileChange }
  | { kind: "file-explorer"; id: string; projectId: string }
  | { kind: "file-reference"; id: string; file: FileReference }
  | ({ kind: "web"; id: string } & Omit<WebTagState, "ref" | "opened" | "closed">)

/** 一个浏览器工作区的标签顺序、选中项和面板可见状态。 */
export interface ConversationBrowserState {
  tags: BrowserTag[]
  activeTagId: string | null
  narrowPanel: "chat" | "browser"
}

const emptyBrowser: ConversationBrowserState = { tags: [], activeTagId: null, narrowPanel: "chat" }

/** 按对话管理 React 标签，布局版本在整个宿主工作台内递增。 */
export class TagManager {
  private readonly bySession = new Map<string, ConversationBrowserState>()
  private revision = 0
  private showingWeb = false

  /** 建立工作台标签缓存。 @param changed 通知 React 状态变化。 */
  constructor(private readonly changed: () => void) {}

  /** 读取对话标签。 @param sessionId 对话身份 @returns 当前标签快照。 */
  get(sessionId: string): ConversationBrowserState {
    return this.bySession.get(sessionId) ?? emptyBrowser
  }

  /** 替换对话标签快照。 @param sessionId 对话身份 @param state 新状态。 */
  set(sessionId: string, state: ConversationBrowserState): void {
    this.bySession.set(sessionId, state)
    this.changed()
  }

  /** 打开或选中已有标签。 @param sessionId 对话身份 @param tag 待打开标签。 */
  open(sessionId: string, tag: BrowserTag): void {
    const state = this.get(sessionId)
    const tags = state.tags.some((item) => item.id === tag.id) ? state.tags : [...state.tags, tag]
    this.set(sessionId, { tags, activeTagId: tag.id, narrowPanel: "browser" })
  }

  /** 打开网页标签，创建失败时将错误保留在对应标签中。
   * @param sessionId 浏览器所属对话。
   * @param url 已校验的绝对 HTTP(S) 地址。
   * @param blankId 地址栏提交时转换的空白标签，省略时新建标签并展开浏览器。
   */
  openWeb(sessionId: string, url: string, blankId?: string): void {
    const id = blankId ?? crypto.randomUUID()
    const ref = { sessionId, tagId: id }
    const tag: BrowserTag = { kind: "web", id, url, title: "", status: "loading", canGoBack: false, canGoForward: false }
    if (blankId === undefined) this.open(sessionId, tag)
    else {
      const state = this.get(sessionId)
      this.set(sessionId, { ...state, tags: state.tags.map((item) => item.id === blankId ? tag : item) })
    }
    void window.nicodeBrowser.createWebTag(ref, url).catch((cause: unknown) => this.receive({
      ref, url, title: "", status: "error", canGoBack: false, canGoForward: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }))
  }

  /**
   * 打开或选中当前对话中对应项目的文件查看器标签。
   * @param sessionId 浏览器所属对话。
   * @param projectId 项目身份，目录选择由查看器管理。
   */
  openFileExplorer(sessionId: string, projectId: string): void {
    const tag = this.get(sessionId).tags.find((item) => item.kind === "file-explorer" && item.projectId === projectId)
    this.open(sessionId, tag ?? { kind: "file-explorer", id: crypto.randomUUID(), projectId })
  }

  /**
   * 按项目与已解析路径打开文件预览或选中现有标签。
   * @param sessionId 浏览器所属对话。
   * @param file Composer 或历史消息里的文件引用。
   */
  openFileReference(sessionId: string, file: FileReference): void {
    const id = JSON.stringify(["file", file.projectId, file.absolutePath])
    const state = this.get(sessionId)
    const tag: BrowserTag = { kind: "file-reference", id, file }
    const tags = state.tags.some((item) => item.id === id) ? state.tags.map((item) => item.id === id ? tag : item) : [...state.tags, tag]
    this.set(sessionId, { tags, activeTagId: id, narrowPanel: "browser" })
  }

  /**
   * 取出仍打开的资源查看器，供工作区跨标签、对话保留页面实例。
   * @returns 所有打开的查看器标签。
   */
  fileExplorers(): Extract<BrowserTag, { kind: "file-explorer" }>[] {
    return [...this.bySession.values()].flatMap(({ tags }) => tags.filter((tag) => tag.kind === "file-explorer"))
  }

  /** 移除标签，选中邻项，并在最后一个标签关闭时收起面板。
   * @param sessionId 浏览器所属工作区。
   * @param tagId 要移除的标签身份。
   */
  remove(sessionId: string, tagId: string): void {
    const state = this.get(sessionId)
    const index = state.tags.findIndex((tag) => tag.id === tagId)
    if (index === -1) return
    const tags = state.tags.filter((tag) => tag.id !== tagId)
    this.set(sessionId, {
      tags,
      activeTagId: state.activeTagId === tagId ? (tags[index] ?? tags[index - 1])?.id ?? null : state.activeTagId,
      narrowPanel: tags.length === 0 ? "chat" : state.narrowPanel,
    })
  }

  /** 将主进程状态合并到仍存在的网页标签。
   * @param update 网页实例的导航状态
   */
  receive({ ref, opened, closed, ...update }: WebTagState): void {
    const state = this.get(ref.sessionId)
    const index = state.tags.findIndex((tag) => tag.kind === "web" && tag.id === ref.tagId)
    if (closed && index !== -1) {
      this.remove(ref.sessionId, ref.tagId)
      return
    }
    if (index === -1) {
      if (!opened || closed) return
      const tag: BrowserTag = { kind: "web", id: ref.tagId, ...update }
      if (opened === "foreground") this.open(ref.sessionId, tag)
      else this.set(ref.sessionId, { ...state, tags: [...state.tags, tag] })
      return
    }
    this.set(ref.sessionId, { ...state, tags: state.tags.map((tag) =>
      tag.kind === "web" && tag.id === ref.tagId ? { ...tag, ...update } : tag) })
  }

  /** 上报当前布局意图。 @param active 唯一应展示的网页及其坐标，或隐藏意图。 */
  present(active: BrowserPresentation["active"]): void {
    if (active === null && !this.showingWeb) return
    this.showingWeb = active !== null
    void window.nicodeBrowser?.present({ revision: ++this.revision, active }).catch(console.error)
  }
}

/** 将事件里的单个文件还原为 unified patch。
 * @param file 会话事件保存的净变化
 * @returns 包含文件头和原始 hunk 行的 patch。
 */
export function fileChangePatch(file: FileChange): string {
  const path = file.path.replace(/[\r\n\t]/g, " ")
  const oldPath = file.changeType === "created" ? "/dev/null" : path
  const newPath = file.changeType === "deleted" ? "/dev/null" : path
  const hunks = file.hunks.flatMap((hunk) => {
    // Unified diff anchors an empty range to the preceding line.
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart
    const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart
    return ["@@ -" + oldStart + "," + hunk.oldLines + " +" + newStart + "," + hunk.newLines + " @@", ...hunk.lines]
  })
  return ["--- " + oldPath, "+++ " + newPath, ...hunks, ""].join("\n")
}

/** 将页面渲染错误限制在当前标签。 */
class BrowserPageBoundary extends Component<{ children: ReactNode; message: string }, { failed: boolean }> {
  state = { failed: false }
  /** 渲染失败后切换为标签内错误。 @returns 错误状态。 */
  static getDerivedStateFromError() { return { failed: true } }
  /** 输出页面或错误。 @returns 标签内容。 */
  render() {
    return this.state.failed ? <p role="alert">{this.props.message}</p> : this.props.children
  }
}

/** 聊天路由提供身份、弹层可见性和已有聊天节点。 */
interface BrowserWorkspaceProps {
  manager: TagManager
  sessionId: string
  projectId: string
  projects: readonly ProjectSummary[]
  obscured: boolean
  theme: "light" | "dark"
  /** 工作台提供的浏览器开关，展开和收起时共用同一按钮。 */
  toggle: ReactNode
  children: ReactNode
}

/** 保持聊天挂载，并在可见网页的内容区上报布局。
 * @param props 对话、标签状态和聊天节点
 * @returns 聊天与内置浏览器工作区。
 */
export function BrowserWorkspace({ manager, sessionId, projectId, projects, obscured, theme, toggle, children }: BrowserWorkspaceProps) {
  const browser = manager.get(sessionId)
  const workspace = useRef<HTMLDivElement>(null)
  const split = useRef<HTMLDivElement>(null)
  const [chatPercent, setChatPercent] = useState(50)
  const [dragPercent, setDragPercent] = useState<number | null>(null)
  const [browserMaximized, setBrowserMaximized] = useState(false)
  const [chatTabSelected, setChatTabSelected] = useState(false)
  const slot = useRef<HTMLDivElement>(null)
  const tabList = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(true)
  const [address, setAddress] = useState("")
  const [error, setError] = useState("")
  const project = projects.find((item) => item.projectId === projectId)
  // Draft routes share browser tabs, so project file tabs also require a project match.
  const visibleTags = browser.tags.filter((tag) => {
    if (tag.kind === "file-explorer") return tag.projectId === projectId
    if (tag.kind === "file-reference") return tag.file.projectId === projectId
    return true
  })
  const active = visibleTags.find((tag) => tag.id === browser.activeTagId) ?? visibleTags.at(-1)
  const activeFile = active?.kind === "file-reference" ? active : undefined
  const web = active?.kind === "web" ? active : undefined
  const webId = web?.id
  const webUrl = web?.url
  const showBrowser = browser.narrowPanel === "browser"
  const showDivider = showBrowser && !narrow && !browserMaximized
  const previewBrowserOnly = showDivider && dragPercent !== null && dragPercent < minimumSplitPercent
  const previewChatOnly = showDivider && dragPercent !== null && dragPercent > maximumSplitPercent
  const browserVisible = showBrowser && !previewChatOnly
  const chatHidden = (showBrowser && !showDivider) || previewBrowserOnly
  const showChatTabContent = chatHidden && chatTabSelected
  const visibleChatPercent = dragPercent ?? chatPercent
  const maximizeLabel = browserMaximized ? "恢复分栏" : "铺满工作区"
  const api = window.nicodeBrowser

  const canOpenProjectFiles = Boolean(api && project?.directories.length)
  const projectFilesTitle = canOpenProjectFiles ? "打开项目文件"
    : projectId === "default" ? "进入项目后可查看关联文件夹" : "项目需要先关联文件夹"

  useLayoutEffect(() => {
    setBrowserMaximized(false)
  }, [sessionId, showBrowser])

  useLayoutEffect(() => {
    setChatTabSelected(false)
  }, [sessionId, showBrowser, showDivider, active?.id, activeFile])

  useLayoutEffect(() => {
    const element = workspace.current
    if (!element) return
    const measure = () => setNarrow(element.getBoundingClientRect().width < 640)
    measure()
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  useLayoutEffect(() => {
    setAddress(webUrl ?? "")
    setError("")
  }, [sessionId, active?.id, webId, webUrl])

  useLayoutEffect(() => {
    if (browserVisible) {
      tabList.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })
    }
  }, [browserVisible, active?.id, showChatTabContent])

  useLayoutEffect(() => {
    const element = slot.current
    if (!webId || !browserVisible || showChatTabContent || obscured || !element || web?.status === "error") {
      manager.present(null)
      return
    }
    const measure = () => {
      const { x, y, width, height } = element.getBoundingClientRect()
      manager.present(width && height ? { ref: { sessionId, tagId: webId }, bounds: { x, y, width, height } } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (workspace.current) observer.observe(workspace.current)
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
      manager.present(null)
    }
  }, [manager, sessionId, webId, web?.status, browserVisible, showChatTabContent, obscured])

  /** 提交网页操作并展示命令失败。 @param task 已发出的 IPC 请求。 */
  function run(task: Promise<void>): void {
    setError("")
    void task.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  /** 关闭标签并选择邻项。 @param tag 要关闭的标签。 */
  function close(tag: BrowserTag): void {
    manager.remove(sessionId, tag.id)
    if (tag.kind === "web") run(api.closeWebTag({ sessionId, tagId: tag.id }))
  }

  /** 校验地址并创建或导航网页。 */
  function openAddress(): void {
    const input = address.trim()
    if (!input) return
    const url = URL.parse(input.includes("://") ? input : "https://" + input)
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      setError("请输入有效的 HTTP 或 HTTPS 地址")
      return
    }
    if (web) {
      run(api.navigateWebTag({ sessionId, tagId: web.id }, url.href))
      return
    }
    if (active && active.kind !== "blank") return
    manager.openWeb(sessionId, url.href, active?.id)
  }

  /** 更新聊天区宽度，给两侧保留可操作空间。
   * @param percent 聊天区占分栏的百分比。
   */
  function resizeChat(percent: number): void {
    setChatPercent(Math.min(maximumSplitPercent, Math.max(minimumSplitPercent, Math.round(percent))))
  }

  /** 将指针位置转换为当前分栏比例。
   * @param clientX 指针在视口中的横坐标。
   * @param dividerWidth 分隔线热区宽度。
   * @returns 聊天栏预览比例。
   */
  function pointerPercent(clientX: number, dividerWidth: number): number {
    const bounds = split.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= dividerWidth) return visibleChatPercent
    const percent = (clientX - bounds.left - dividerWidth / 2) / (bounds.width - dividerWidth) * 100
    return Math.min(100, Math.max(0, Math.round(percent)))
  }

  const ref: WebTagRef | undefined = web && { sessionId, tagId: web.id }
  return <div className="chat-browser-workspace" ref={workspace} data-narrow={narrow} data-expanded={browserVisible}
    data-chat-tab-selected={showChatTabContent}>
    <div className="chat-browser-split" ref={split}>
      <div id="chat-browser-chat" className="chat-browser-chat" hidden={chatHidden && !showChatTabContent}
        style={showDivider ? { flexGrow: visibleChatPercent } : undefined}>{children}</div>
      {showDivider && <div className="chat-browser-divider" role="separator" tabIndex={0}
        data-snapped={previewBrowserOnly || previewChatOnly}
        aria-label="调整聊天与浏览器宽度" aria-orientation="vertical" aria-controls="chat-browser-pane"
        aria-valuemin={dragPercent === null ? minimumSplitPercent : 0}
        aria-valuemax={dragPercent === null ? maximumSplitPercent : 100} aria-valuenow={visibleChatPercent}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          setDragPercent(pointerPercent(event.clientX, event.currentTarget.offsetWidth))
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          const percent = pointerPercent(event.clientX, event.currentTarget.offsetWidth)
          setDragPercent(null)
          if (percent < minimumSplitPercent) setBrowserMaximized(true)
          else if (percent > maximumSplitPercent) manager.set(sessionId, { ...browser, narrowPanel: "chat" })
          else resizeChat(percent)
        }}
        onLostPointerCapture={() => setDragPercent(null)}
        onKeyDown={(event) => {
          const percent = { ArrowLeft: chatPercent - 5, ArrowRight: chatPercent + 5, Home: minimumSplitPercent, End: maximumSplitPercent }[event.key]
          if (typeof percent !== "number") return
          event.preventDefault()
          resizeChat(percent)
        }}
      />}
      <section id="chat-browser-pane" className="chat-browser-pane" aria-label="内置浏览器" hidden={!browserVisible}
        style={showDivider ? { flexGrow: 100 - visibleChatPercent } : undefined}>
        <div className="chat-browser-tabs">
          <div className="chat-browser-tab-list" ref={tabList} aria-label="已打开的标签">
          {chatHidden && <div className="chat-browser-tab-item" data-active={showChatTabContent}>
            <button className="chat-browser-chat-tab" type="button" aria-controls="chat-browser-chat"
            aria-pressed={showChatTabContent} onClick={() => setChatTabSelected(true)}>
            <IconMessage size={15} aria-hidden="true" />
            <span>聊天</span>
          </button></div>}
            {visibleTags.map((tag) => {
              const label = tag.kind === "diff" ? tag.file.path : tag.kind === "web" ? tag.title || tag.url
                : tag.kind === "file-explorer" ? "项目文件" : tag.kind === "file-reference" ? tag.file.name : "新标签页"
              return <div className="chat-browser-tab chat-browser-tab-item" data-active={!showChatTabContent && active?.id === tag.id} key={tag.id}>
                <button type="button" title={tag.kind === "file-reference" ? tag.file.absolutePath : label} aria-pressed={!showChatTabContent && active?.id === tag.id} onClick={() => {
                  setChatTabSelected(false)
                  manager.open(sessionId, tag)
                }}>
                  {tag.kind === "diff" ? <IconFileDiff size={15} aria-hidden="true" />
                    : tag.kind === "file-explorer" ? <IconFolderOpen size={15} aria-hidden="true" />
                      : tag.kind === "file-reference" ? <IconFile size={15} aria-hidden="true" /> : <IconWorld size={15} aria-hidden="true" />}
                  <span>{label}</span>
                </button>
                <button type="button" aria-label={"关闭 " + label} onClick={() => close(tag)}><IconX size={14} /></button>
              </div>
            })}
          </div>
          <button type="button" aria-label="新建网页" title="新建网页" onClick={() => {
            setChatTabSelected(false)
            manager.open(sessionId, { kind: "blank", id: crypto.randomUUID() })
            setAddress("")
            setError("")
            requestAnimationFrame(() => workspace.current?.querySelector<HTMLInputElement>(".chat-browser-address")?.focus())
          }}><IconPlus size={16} /></button>
          <button type="button" aria-label="打开项目文件" title={projectFilesTitle} disabled={!canOpenProjectFiles}
            onClick={() => manager.openFileExplorer(sessionId, projectId)}><IconFolderOpen size={17} aria-hidden="true" /></button>
          {!narrow && <button className="chat-browser-maximize" type="button"
            aria-label={maximizeLabel} title={maximizeLabel} aria-controls="chat-browser-pane"
            onClick={() => setBrowserMaximized(!browserMaximized)}>
            {browserMaximized ? <IconMinimize size={16} aria-hidden="true" /> : <IconMaximize size={16} aria-hidden="true" />}
          </button>}
        </div>
        {(!active || active.kind === "blank" || active.kind === "web") && <form className="chat-browser-toolbar" onSubmit={(event) => { event.preventDefault(); openAddress() }}>
          {ref && <div className="chat-browser-navigation" role="group" aria-label="网页导航">
            <button type="button" aria-label="后退" disabled={!web?.canGoBack} onClick={() => run(api.goBack(ref))}><IconArrowLeft size={16} /></button>
            <button type="button" aria-label="前进" disabled={!web?.canGoForward} onClick={() => run(api.goForward(ref))}><IconArrowRight size={16} /></button>
            <button type="button" aria-label="刷新" onClick={() => run(api.reload(ref))}><IconRefresh size={16} /></button>
          </div>}
          <input className="chat-browser-address" aria-label="网页地址" placeholder="输入网页地址" value={address} onChange={(event) => setAddress(event.target.value)} />
          <button className="chat-browser-submit" type="submit" aria-label="打开" title="打开网址" disabled={!address.trim() || !api}><IconArrowRight size={16} aria-hidden="true" /></button>
        </form>}
        {error && <p className="chat-browser-message" role="alert">{error}</p>}
        {active?.kind === "diff" ? <div className="chat-browser-diff">
          {active.file.hunks.length === 0
            ? <p className="chat-browser-message">{active.file.path} · {active.file.changeType === "created" ? "新增" : active.file.changeType === "deleted" ? "删除" : "修改"}，无文本差异</p>
            : <BrowserPageBoundary key={active.id} message="无法显示此文件的差异。">
              <Suspense fallback={<p className="chat-browser-message">正在加载差异…</p>}>
                <PatchDiff patch={fileChangePatch(active.file)} options={{ diffStyle: "unified", overflow: "wrap", themeType: theme }} />
              </Suspense>
            </BrowserPageBoundary>}
        </div> : active?.kind === "file-reference" ? <div className="chat-browser-explorer-page" hidden={showChatTabContent}>
          <BrowserPageBoundary key={active.id} message="无法显示此文件的预览。">
            <Suspense fallback={<p className="chat-browser-message" role="status">正在加载文件预览…</p>}>
              {project?.directories.includes(active.file.directoryPath)
                ? <ReferencedFilePreview reference={active.file} theme={theme} />
                : <p className="chat-browser-message" role="alert">此文件的目录未关联到当前项目。</p>}
            </Suspense>
          </BrowserPageBoundary>
        </div> : active?.kind !== "file-explorer" && <div className="chat-browser-slot" ref={slot}>
          {!web && <div className="chat-browser-start">
            <IconWorld size={32} stroke={1.4} aria-hidden="true" />
            <h2>新标签页</h2>
            <p>在上方输入网址，按 Enter 打开。</p>
          </div>}
          {web?.status === "error" && <p className="chat-browser-message" role="alert">网页加载失败。{web.error}</p>}
        </div>}
        {manager.fileExplorers().map((tag) => <div key={tag.id} className="chat-browser-explorer-page"
          hidden={active?.id !== tag.id || showChatTabContent}>
          <BrowserPageBoundary message="无法显示文件资源查看器。">
            <Suspense fallback={<p className="chat-browser-message" role="status">正在加载文件资源查看器…</p>}>
              <FileExplorerViewer projectId={tag.projectId} theme={theme}
                directories={projects.find((item) => item.projectId === tag.projectId)?.directories ?? []} />
            </Suspense>
          </BrowserPageBoundary>
        </div>)}
      </section>
    </div>
    {toggle}
  </div>
}
