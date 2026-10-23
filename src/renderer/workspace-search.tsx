/** 仅搜索工作区已有摘要；选中结果后才由既有路由决定是否读取对话历史。 */
import { useRef, useState } from "react"
import { IconArrowUpRight, IconFolder, IconMessage, IconSearch, IconX } from "@tabler/icons-react"
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
 * 按名称筛选现有摘要，支持上下键、Enter 和 Escape；不加载任何消息正文。
 * @param props 已有摘要、加载提示与导航回调。
 * @returns 支持键盘操作的搜索弹窗。
 */
export function WorkspaceSearch({ projects, sessions, status, onClose, onProject, onSession }: WorkspaceSearchProps) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef)
  const needle = query.trim().toLocaleLowerCase()
  const results = [
    ...projects.map((project) => ({ id: `project:${project.projectId}`, name: project.name, scope: "项目", projectId: project.projectId, sessionId: undefined as string | undefined })),
    ...sessions.map((session) => ({ id: `default:${session.sessionId}`, name: session.name, scope: "独立对话", projectId: "default", sessionId: session.sessionId })),
    ...projects.flatMap((project) => project.sessions.map((session) => ({ id: `${project.projectId}:${session.sessionId}`, name: session.name, scope: project.name, projectId: project.projectId, sessionId: session.sessionId }))),
  ].filter((item) => `${item.name} ${item.scope}`.toLocaleLowerCase().includes(needle))
  const activeIndex = Math.min(active, Math.max(0, results.length - 1))
  /** @param index 当前筛选结果的索引；空结果不执行导航。 */
  function open(index: number): void {
    const result = results[index]
    if (!result) return
    if (result.sessionId === undefined) onProject(result.projectId)
    else onSession(result.projectId, result.sessionId)
    onClose()
  }
  return <div className="search-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} tabIndex={-1} className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索工作区" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose() }
    }}>
      <div className="search-input-row">
        <IconSearch size={21} aria-hidden="true" />
        <input data-dialog-autofocus aria-label="搜索项目或对话" placeholder="搜索项目或对话…" role="combobox" aria-autocomplete="list" aria-controls="workspace-search-results" aria-expanded="true" aria-activedescendant={results.length ? `search-result-${activeIndex}` : undefined} value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0) }} onKeyDown={(event) => {
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
      <div className="search-results" id="workspace-search-results" role="listbox" aria-label="搜索结果">
        {status && <p className="search-hint" role="status">{status}</p>}
        {results.length === 0 ? <div className="search-empty"><IconSearch size={28} /><strong>没有找到匹配结果</strong><span>试试其他项目或对话名称</span></div>
          : results.map((result, index) => <button id={`search-result-${index}`} type="button" role="option" aria-selected={index === activeIndex} className="search-result" key={result.id} onMouseEnter={() => setActive(index)} onClick={() => open(index)}>
            <span className="search-result-icon">{result.sessionId ? <IconMessage size={18} /> : <IconFolder size={18} />}</span>
            <span className="search-result-copy"><strong>{result.name}</strong><small>{result.scope}</small></span><IconArrowUpRight size={16} />
          </button>)}
      </div>
      <footer className="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>Enter</kbd> 打开</span><span>按名称搜索</span></footer>
    </section>
  </div>
}
