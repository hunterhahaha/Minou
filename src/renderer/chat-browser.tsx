import { Component, lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { IconArrowLeft, IconArrowRight, IconPlus, IconRefresh, IconX } from "@tabler/icons-react"
import type { FileChange } from "../../runtime/session/src/events.ts"
import type { BrowserPresentation, WebTagRef, WebTagState } from "../preload/browser-api.ts"
import "./chat-browser.css"

const PatchDiff = lazy(async () => ({ default: (await import("@pierre/diffs/react")).PatchDiff }))

/** 标签只持有重新渲染所需的数据。 */
export type BrowserTag =
  | { kind: "diff"; id: string; eventId: string; file: FileChange }
  | ({ kind: "web"; id: string } & Omit<WebTagState, "ref">)

/** 一个对话中的标签顺序、选中项和窄窗面板。 */
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

  /** 将主进程状态合并到仍存在的网页标签。
   * @param update 网页实例的导航状态
   */
  receive({ ref, ...update }: WebTagState): void {
    const state = this.get(ref.sessionId)
    if (!state.tags.some((tag) => tag.kind === "web" && tag.id === ref.tagId)) return
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

/** 将第三方 Diff 渲染错误限制在当前标签。 */
class DiffBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  /** 渲染失败后切换为标签内错误。 @returns 错误状态。 */
  static getDerivedStateFromError() { return { failed: true } }
  /** 输出 Diff 或错误。 @returns 标签内容。 */
  render() {
    return this.state.failed ? <p role="alert">无法显示此文件的差异。</p> : this.props.children
  }
}

/** 聊天路由提供身份、弹层可见性和已有聊天节点。 */
interface BrowserWorkspaceProps {
  manager: TagManager
  sessionId: string
  obscured: boolean
  theme: "light" | "dark"
  children: ReactNode
}

/** 保持聊天挂载，并在可见网页的内容区上报布局。
 * @param props 对话、标签状态和聊天节点
 * @returns 聊天与内置浏览器工作区。
 */
export function BrowserWorkspace({ manager, sessionId, obscured, theme, children }: BrowserWorkspaceProps) {
  const browser = manager.get(sessionId)
  const workspace = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(true)
  const [address, setAddress] = useState("")
  const [error, setError] = useState("")
  const active = browser.tags.find((tag) => tag.id === browser.activeTagId)
  const web = active?.kind === "web" ? active : undefined
  const webId = web?.id
  const webUrl = web?.url
  const showBrowser = !narrow || browser.narrowPanel === "browser"
  const api = window.nicodeBrowser

  useLayoutEffect(() => {
    const element = workspace.current
    if (!element) return
    const measure = () => setNarrow(element.getBoundingClientRect().width < 960)
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
  }, [sessionId, webId, webUrl])

  useLayoutEffect(() => {
    const element = slot.current
    if (!webId || !showBrowser || obscured || !element || web?.status === "error") {
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
  }, [manager, sessionId, webId, web?.status, showBrowser, obscured])

  /** 提交网页操作并展示命令失败。 @param task 已发出的 IPC 请求。 */
  function run(task: Promise<void>): void {
    setError("")
    void task.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  /** 关闭标签并选择邻项。 @param tag 要关闭的标签。 */
  function close(tag: BrowserTag): void {
    const index = browser.tags.findIndex((item) => item.id === tag.id)
    const tags = browser.tags.filter((item) => item.id !== tag.id)
    manager.set(sessionId, {
      ...browser, tags,
      activeTagId: active?.id === tag.id ? (tags[index] ?? tags[index - 1])?.id ?? null : browser.activeTagId,
    })
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
    const id = crypto.randomUUID()
    const ref = { sessionId, tagId: id }
    manager.open(sessionId, { kind: "web", id, url: url.href, title: "", status: "loading", canGoBack: false, canGoForward: false })
    void api.createWebTag(ref, url.href).catch((cause: unknown) => manager.receive({
      ref, url: url.href, title: "", status: "error", canGoBack: false, canGoForward: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }))
  }

  const ref: WebTagRef | undefined = web && { sessionId, tagId: web.id }
  return <div className="chat-browser-workspace" ref={workspace} data-narrow={narrow}>
    {narrow && <div className="chat-browser-switch">
      <button type="button" aria-pressed={!showBrowser} onClick={() => manager.set(sessionId, { ...browser, narrowPanel: "chat" })}>聊天</button>
      <button type="button" aria-pressed={showBrowser} onClick={() => manager.set(sessionId, { ...browser, narrowPanel: "browser" })}>浏览器{browser.tags.length > 0 && " · " + browser.tags.length}</button>
    </div>}
    <div className="chat-browser-split">
      <div className="chat-browser-chat" hidden={narrow && showBrowser}>{children}</div>
      <section className="chat-browser-pane" aria-label="内置浏览器" hidden={!showBrowser}>
        <div className="chat-browser-tabs">
          <div className="chat-browser-tab-list" aria-label="已打开的标签">
            {browser.tags.map((tag) => {
              const label = tag.kind === "diff" ? tag.file.path : tag.title || tag.url
              return <div className="chat-browser-tab" data-active={active?.id === tag.id} key={tag.id}>
                <button type="button" title={label} aria-pressed={active?.id === tag.id} onClick={() => manager.open(sessionId, tag)}>{label}</button>
                <button type="button" aria-label={"关闭 " + label} onClick={() => close(tag)}><IconX size={14} /></button>
              </div>
            })}
          </div>
          <button type="button" aria-label="新建网页" title="新建网页" onClick={() => {
            manager.set(sessionId, { ...browser, activeTagId: null })
            setAddress("")
            setError("")
            requestAnimationFrame(() => workspace.current?.querySelector<HTMLInputElement>(".chat-browser-address")?.focus())
          }}><IconPlus size={16} /></button>
        </div>
        {(!active || web) && <form className="chat-browser-toolbar" onSubmit={(event) => { event.preventDefault(); openAddress() }}>
          {ref && <>
            <button type="button" aria-label="后退" disabled={!web?.canGoBack} onClick={() => run(api.goBack(ref))}><IconArrowLeft size={16} /></button>
            <button type="button" aria-label="前进" disabled={!web?.canGoForward} onClick={() => run(api.goForward(ref))}><IconArrowRight size={16} /></button>
            <button type="button" aria-label="刷新" onClick={() => run(api.reload(ref))}><IconRefresh size={16} /></button>
          </>}
          <input className="chat-browser-address" aria-label="网页地址" placeholder="输入网页地址" value={address} onChange={(event) => setAddress(event.target.value)} />
          <button type="submit" disabled={!address.trim() || !api}>打开</button>
        </form>}
        {error && <p className="chat-browser-message" role="alert">{error}</p>}
        {active?.kind === "diff" ? <div className="chat-browser-diff">
          {active.file.hunks.length === 0
            ? <p className="chat-browser-message">{active.file.path} · {active.file.changeType === "created" ? "新增" : active.file.changeType === "deleted" ? "删除" : "修改"}，无文本差异</p>
            : <DiffBoundary key={active.id}>
              <Suspense fallback={<p className="chat-browser-message">正在加载差异…</p>}>
                <PatchDiff patch={fileChangePatch(active.file)} options={{ diffStyle: "unified", overflow: "wrap", themeType: theme }} />
              </Suspense>
            </DiffBoundary>}
        </div> : <div className="chat-browser-slot" ref={slot}>
          {!web && <p className="chat-browser-message">输入网址，或点击聊天回复下方的文件查看差异。</p>}
          {web?.status === "error" && <p className="chat-browser-message" role="alert">网页加载失败。{web.error}</p>}
        </div>}
      </section>
    </div>
  </div>
}
