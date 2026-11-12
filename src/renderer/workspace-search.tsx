/** 仅搜索工作区已有摘要；选中结果后才由既有路由决定是否读取对话历史。 */
import { useRef, useState } from "react"
import { IconFolder, IconX } from "@tabler/icons-react"
import type { ProjectSummary, SessionSummary } from "../preload/session-api.ts"
import { useDialogFocus } from "./dialog-focus.tsx"

/** 摘要搜索的输入与路由出口，组件没有 IPC 访问职责。 */
interface WorkspaceSearchProps {
  /** 已完成加载的项目摘要。 */
  projects: ProjectSummary[]
  /** 已完成加载的独立对话摘要。 */
  sessions: SessionSummary[]
  /** 摘要仍在加载或失败时显示，避免将不可用误报为没有结果。 */
  status?: string
  /** 关闭搜索并恢复入口焦点。 */
  onClose: () => void
  /** @param projectId 项目身份。 */
  onProject: (projectId: string) => void
  /** @param projectId 分组身份。 @param sessionId 对话身份。 */
  onSession: (projectId: string, sessionId: string) => void
}

/**
 * 按类别和名称筛选现有摘要，支持上下键、Enter 和 Escape；不加载任何消息正文。
 * @param props 已有摘要、加载提示与导航回调。
 * @returns 支持键盘操作的搜索弹窗。
 */
export function WorkspaceSearch({ projects, sessions, status, onClose, onProject, onSession }: WorkspaceSearchProps) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<"sessions" | "projects">("sessions")
  const [active, setActive] = useState(0)
  const dialogRef = useRef<HTMLElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const categoryName = category === "sessions" ? "对话" : "项目"
  const needle = query.trim().toLocaleLowerCase()
  const results = (category === "projects"
    ? projects.map((project) => ({ ...project, id: `project:${project.projectId}`, scope: "", sessionId: undefined }))
    : [
      ...sessions.map((session) => ({ ...session, id: `default:${session.sessionId}`, scope: "独立对话", projectId: "default" })),
      ...projects.flatMap((project) => project.sessions.map((session) => ({ ...session, id: `${project.projectId}:${session.sessionId}`, scope: project.name, projectId: project.projectId }))),
    ])
    .filter((item) => `${item.name} ${item.scope}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
  const activeIndex = Math.min(active, Math.max(0, results.length - 1))
  const now = Date.now()

  /**
   * 将摘要的更新时间压缩为适合单行显示的相对时间。
   * @param updatedAt 摘要更新时间。
   * @returns 相对时间，无法解析时返回空字符串。
   */
  function relativeTime(updatedAt: string): string {
    const timestamp = Date.parse(updatedAt)
    if (!Number.isFinite(timestamp)) return ""
    const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
    if (minutes < 1) return "刚刚"
    if (minutes < 60) return `${minutes} 分钟前`
    if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
    return `${Math.floor(minutes / 1440)} 天前`
  }

  /** 重置结果的选中位置和滚动位置，供切换类别或改写关键词时调用。 */
  function resetSelection(): void {
    setActive(0)
    if (resultsRef.current) resultsRef.current.scrollTop = 0
  }
  /**
   * 打开当前筛选结果中指定索引的对话或项目，空结果不导航。
   *
   * @param index 当前筛选结果的索引；空结果不执行导航。
   */
  function open(index: number): void {
    const result = results[index]
    if (!result) return
    if (result.sessionId === undefined) onProject(result.projectId)
    else onSession(result.projectId, result.sessionId)
    onClose()
  }
  return <div className="search-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} tabIndex={-1} className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索工作区" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        if (!event.nativeEvent.isComposing && !event.currentTarget.querySelector("select:open")) onClose()
      }
    }}>
      <div className="search-input-row">
        <select className="search-category" aria-label="搜索分类" value={category} onChange={(event) => {
          setCategory(event.target.value === "projects" ? "projects" : "sessions")
          resetSelection()
        }}>
          <option value="sessions">对话</option>
          <option value="projects">项目</option>
        </select>
        <input data-dialog-autofocus aria-label="搜索项目或对话" placeholder={`搜索${categoryName}…`} role="combobox" aria-autocomplete="list" aria-controls="workspace-search-results" aria-expanded="true" aria-activedescendant={results.length ? `search-result-${activeIndex}` : undefined} value={query}
          onChange={(event) => { setQuery(event.target.value); resetSelection() }} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              const next = Math.max(0, Math.min(results.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)))
              setActive(next)
              document.getElementById(`search-result-${next}`)?.scrollIntoView({ block: "nearest" })
            }
            if (event.key === "Enter") { event.preventDefault(); open(activeIndex) }
          }} />
        <button type="button" className="settings-icon-button" aria-label="关闭搜索" onClick={onClose}><IconX size={18} /></button>
      </div>
      {status && <p className="search-hint" role="status">{status}</p>}
      {!status && results.length === 0 && <p className="search-empty" role="status">没有找到匹配的{categoryName}</p>}
      <div ref={resultsRef} className="search-results" id="workspace-search-results" role="listbox" aria-label={`${categoryName}搜索结果`}>
        {results.map((result, index) => <button id={`search-result-${index}`} type="button" role="option" aria-selected={index === activeIndex} className="search-result" key={result.id} onMouseEnter={() => setActive(index)} onClick={() => open(index)}>
          <span className="search-result-copy" title={result.scope ? `${result.name} · ${result.scope}` : result.name}>
            <strong>{result.name}</strong>
            {result.scope && <small>{result.projectId !== "default" && <IconFolder size={14} aria-hidden="true" />}<span>{result.scope}</span></small>}
          </span>
          <time dateTime={result.updatedAt} title={result.updatedAt}>{relativeTime(result.updatedAt)}</time>
        </button>)}
      </div>
    </section>
  </div>
}
