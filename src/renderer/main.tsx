/** Electron 工作区：读取启动摘要，并由 hash 路由管理工作区与 Session 身份。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { BrowserWorkspace, TagManager } from "./chat-browser.tsx"
import { createPortal } from "react-dom"
import { createRoot } from "react-dom/client"
import { HashRouter, Navigate, Outlet, Route, Routes, useMatch, useNavigate, useParams, useOutletContext, useSearchParams } from "react-router"
import {
  IconCheck,
  IconChevronDown,
  IconDots,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconGitBranch,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconPlus,
  IconAdjustmentsHorizontal,
  IconX,
  IconArrowUpRight,
  IconArrowUp,
  IconMoon,
  IconSearch,
  IconShieldCheck,
  IconSun,
  IconTerminal2,
  IconUsers,
} from "@tabler/icons-react"
import type {
  DirectorySelection,
  ProjectGitBranchState,
  ProjectSummary,
  ProviderSummary,
  SessionSummary,
} from "../preload/session-api.ts"
import { preferredReasoningLevel } from "../../runtime/model/src/reasoning.ts"
import { SettingsDialog } from "./settings-dialog.tsx"
import type { SkillCache } from "./skill-settings.tsx"
import { WorkspaceSessionState, sessionKey, errorMessage } from "./session-state.ts"
import { TeamSessionState } from "./team-session-state.ts"
import { SessionPage } from "./session-page.tsx"
import { WorkspaceSearch } from "./workspace-search.tsx"
import { useDialogFocus } from "./dialog-focus.tsx"
import { ComposerInput } from "./composer-input.tsx"
import { serializeComposerMessage } from "./composer-message.ts"
import { ComposerModelPicker } from "./composer-model-picker.tsx"
import { WindowControls } from "./window-controls.tsx"
import "./workspace.css"

/**
 * 按需查询 Router 的成员。弹窗关闭时释放查询视图和焦点边界。
 * @param props Router 身份和选择、关闭回调。
 * @returns 使用现有弹窗样式的成员列表。
 */
function TeamMembersDialog({ projectId, routerId, onOpen, onClose }: {
  projectId: string; routerId: string; onOpen(sessionId: string): void; onClose(): void
}) {
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog)
  const [attempt, setAttempt] = useState(0)
  const [members, setMembers] = useState<LoadState<string[]>>({ status: "loading" })
  useEffect(() => {
    let active = true
    void window.nicode.listTeamMembers(projectId, routerId).then(
      (value) => { if (active) setMembers({ status: "ready", value }) },
      () => { if (active) setMembers({ status: "error" }) },
    )
    return () => { active = false }
  }, [projectId, routerId, attempt])

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="project-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="team-members-title" tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose() } }}>
      <div className="project-dialog-header">
        <h2 id="team-members-title">团队成员</h2>
        <button type="button" className="settings-icon-button" aria-label="关闭团队成员" onClick={onClose}><IconX size={17} /></button>
      </div>
      <DataStatus state={members} retry={() => {
        setMembers({ status: "loading" })
        setAttempt((value) => value + 1)
      }} />
      {members.status === "ready" && (members.value.length === 0 ? <p role="status">当前团队暂无成员。</p> :
        <ul className="team-members-list">{members.value.map((id) => <li key={id}>
          <button type="button" className="settings-secondary-button" title={id} onClick={() => onOpen(id)}>成员 {id}</button>
        </li>)}</ul>)}
    </section>
  </div>
}

/** 一项启动数据的加载、成功或失败状态。 */
type LoadState<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error" }
/** 决定新会话首发的工作台模式。 */
type WorkspaceMode = "chat" | "work"
/** 当前页面及其工作区范围；Session 页面同时携带 Project 和 Session 身份。 */
type WorkspaceRoute =
  | { page: "new-chat"; group: "default" }
  | { page: "new-chat"; group: "project"; projectId: string }
  | { page: "session"; group: "default"; sessionId: string }
  | { page: "session"; group: "project"; projectId: string; sessionId: string }
/** 菜单操作固定使用打开时的项目及对话身份。 */
type SidebarTarget = { projectId: string; name: string; sessionId?: string }
type SidebarDialog = { kind: "rename" | "directories"; target: SidebarTarget }

/**
 * 显示独立于导航按钮的更多操作入口。
 * @param props 目标、展开状态及打开菜单的回调。
 * @returns 可通过键盘或指针操作的按钮。
 */
function SidebarMore({ target, expanded, onOpen }: {
  target: SidebarTarget
  expanded: boolean
  onOpen: (target: SidebarTarget, anchor: HTMLButtonElement) => void
}) {
  return <button type="button" className="sidebar-more" aria-label={`${target.name}的更多操作`}
    aria-haspopup="menu" aria-expanded={expanded} onClick={(event) => onOpen(target, event.currentTarget)}>
    <IconDots size={16} aria-hidden="true" />
  </button>
}

/** 本页可切换的权限展示状态；对话创建前仅保存在渲染进程。 */
type Permission = "default" | "workspace-read-only" | "workspace-read-write" | "auto" | "full-access"
const permissionLabels: Record<Permission, string> = {
  default: "默认", "workspace-read-only": "工作区只读",
  "workspace-read-write": "工作区读写", auto: "自动审核", "full-access": "完全访问",
}
const permissionOptions: Permission[] = ["workspace-read-only", "workspace-read-write", "auto", "full-access"]

/** 每组侧栏对话首次展示及每次追加的条数。 */
const SIDEBAR_SESSION_BATCH_SIZE = 5

/**
 * 按已保存的更新时间从新到旧排列摘要，时间相同则保留输入顺序。
 * @param left 左侧摘要。
 * @param right 右侧摘要。
 * @returns 用于数组排序的时间差。
 */
function newestFirst(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

/**
 * 按更新时间分批展示一个分组的对话入口，并把分组与 Session 身份交给路由。
 * @param props 已取得的对话摘要列表。
 * @returns 当前可见的对话列表和仍有剩余时的展开入口。
 */
function SessionList({
  projectId,
  sessions,
  activeSessionId,
  onOpenSession,
  menuAnchor,
  onMore,
}: {
  projectId: string
  sessions: SessionSummary[]
  activeSessionId?: string
  menuAnchor: SidebarTarget | undefined
  onMore: (target: SidebarTarget, anchor: HTMLButtonElement) => void
  onOpenSession: (projectId: string, sessionId: string) => void
}) {
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_SESSION_BATCH_SIZE)
  const firstRevealedSession = useRef<HTMLButtonElement>(null)
  const visibleSessions = [...sessions].sort(newestFirst).slice(0, visibleCount)

  useLayoutEffect(() => {
    firstRevealedSession.current?.focus()
  }, [visibleCount])

  return <><ul className="session-list">{visibleSessions.map((session, index) =>
    <li key={session.sessionId} className="sidebar-session-row">
      <button
        className="session-name"
        type="button"
        ref={index === visibleCount - SIDEBAR_SESSION_BATCH_SIZE && visibleCount > SIDEBAR_SESSION_BATCH_SIZE ? firstRevealedSession : undefined}
        title={session.name}
        aria-current={session.sessionId === activeSessionId ? "page" : undefined}
        onClick={() => onOpenSession(projectId, session.sessionId)}
      >
        <span>{session.name}</span>
      </button>
      <SidebarMore target={{ projectId, sessionId: session.sessionId, name: session.name }}
        expanded={menuAnchor?.projectId === projectId && menuAnchor.sessionId === session.sessionId} onOpen={onMore} />
    </li>,
  )}</ul>
    {visibleCount < sessions.length && <button className="session-list-more" type="button"
      onClick={() => setVisibleCount((count) => count + SIDEBAR_SESSION_BATCH_SIZE)}>展开显示</button>}
  </>
}

/**
 * 从匹配到的 Session 路由读取 Project 与 Session 身份，供后续对话页面使用。
 * @returns 优先读取工作区字典，仅缺键时发起历史加载的聊天页面。
 */
function SessionRoute() {
  const { projectId, sessionId } = useParams<"projectId" | "sessionId">()
  const { state, providers, browserTags } = useOutletContext<{ state: WorkspaceSessionState; providers: ProviderSummary[]; browserTags: TagManager }>()
  useEffect(() => {
    if (projectId === undefined || sessionId === undefined) return
    if (state.has(sessionKey(projectId, sessionId))) return
    void state.load(projectId, sessionId).catch(() => {})
  }, [state, projectId, sessionId])
  if (projectId === undefined || sessionId === undefined) return null
  if (state.view(sessionKey(projectId, sessionId)).kind === "member") {
    return <p className="data-status">该成员会话由所属 Router 管理。</p>
  }
  return <SessionPage projectId={projectId} sessionId={sessionId} state={state} providers={providers}
      onOpenFile={(file) => browserTags.openFileReference(sessionId, file)}
      onOpenWeb={(url) => browserTags.openWeb(sessionId, url)}
      onOpenDiff={(eventId, file) => browserTags.open(sessionId, { kind: "diff", id: JSON.stringify([eventId, file.path]), eventId, file })} />
}

/**
 * 为单个启动数据区域显示加载状态或失败重试入口。
 * @param props 数据状态和对应的重试操作。
 * @returns 状态提示；成功时不渲染提示。
 */
function DataStatus({ state, retry }: { state: LoadState<unknown>; retry: () => void }) {
  if (state.status === "loading") return <p className="data-status" role="status">加载中…</p>
  if (state.status === "error") return <p className="data-status" role="alert">加载失败 <button className="retry-button" type="button" onClick={retry}>重试</button></p>
  return null
}

/**
 * 分别读取三份启动数据，维护工作区侧栏，并按匹配路由显示新聊天或 Session 容器。
 * @returns 带独立加载状态的工作区首屏。
 */
function Workspace() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projectNewChatMatch = useMatch("/projects/:projectId/new-chat")
  const sessionMatch = useMatch("/sessions/:projectId/:sessionId")
  const workspaceRoute: WorkspaceRoute = sessionMatch === null
    ? projectNewChatMatch === null
      ? { page: "new-chat", group: "default" }
      : { page: "new-chat", group: "project", projectId: projectNewChatMatch.params.projectId! }
    : sessionMatch.params.projectId === "default"
      ? { page: "session", group: "default", sessionId: sessionMatch.params.sessionId! }
      : {
          page: "session",
          group: "project",
          projectId: sessionMatch.params.projectId!,
          sessionId: sessionMatch.params.sessionId!,
        }
  const [projects, setProjects] = useState<LoadState<ProjectSummary[]>>({ status: "loading" })
  const [defaultSessions, setDefaultSessions] = useState<LoadState<SessionSummary[]>>({ status: "loading" })
  const [providers, setProviders] = useState<LoadState<ProviderSummary[]>>({ status: "loading" })
  const [, setSessionVersion] = useState(0)
  const [sessionsState] = useState(() => new WorkspaceSessionState(window.nicode, () => setSessionVersion((version) => version + 1)))
  const groupId = workspaceRoute.group === "project" ? workspaceRoute.projectId : "default"
  const draftMode: WorkspaceMode = searchParams.get("mode") === "work" ? "work" : "chat"
  const currentKind = workspaceRoute.page === "session"
    ? sessionsState.view(sessionKey(groupId, workspaceRoute.sessionId)).kind
    : undefined
  const newConversationLabel = draftMode === "work" ? "新团队会话" : "新聊天"
  const newDraftKey = sessionKey(groupId, draftMode === "work" ? "$new-work" : "$new-chat")
  const [, setBrowserVersion] = useState(0)
  const [teamSessions] = useState(() => new TeamSessionState(window.nicode))
  const [teamMembersRouter, setTeamMembersRouter] = useState<string | null>(null)
  useEffect(() => window.nicode.onTeamSessionUpdate((update) => teamSessions.receive(update)), [teamSessions])
  const [browserTags] = useState(() => new TagManager(() => setBrowserVersion((version) => version + 1)))
  useEffect(() => window.nicodeBrowser?.onWebTagState((update) => browserTags.receive(update)), [browserTags])
  const newChatView = sessionsState.view(newDraftKey)
  const [savingDefaultModel, setSavingDefaultModel] = useState(false)
  const [defaultModelError, setDefaultModelError] = useState<string | undefined>()
  const [permission, setPermission] = useState<Permission>("default")
  const [newChatReasoningLevel, setNewChatReasoningLevel] = useState("medium")
  const [sidebarMenu, setSidebarMenu] = useState<{ target: SidebarTarget; anchor: HTMLButtonElement } | null>(null)
  const [sidebarDialog, setSidebarDialog] = useState<SidebarDialog | null>(null)
  const [sidebarName, setSidebarName] = useState("")
  const [sidebarBusy, setSidebarBusy] = useState(false)
  const [sidebarError, setSidebarError] = useState<string | null>(null)
  const [renamingBreadcrumbSession, setRenamingBreadcrumbSession] = useState(false)
  const [breadcrumbSessionName, setBreadcrumbSessionName] = useState("")
  const [breadcrumbRenameBusy, setBreadcrumbRenameBusy] = useState(false)
  const [breadcrumbRenameError, setBreadcrumbRenameError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<{ text: string; error: boolean } | null>(null)
  const sidebarMenuRef = useRef<HTMLDivElement>(null)
  const sidebarDialogRef = useRef<HTMLElement>(null)
  const breadcrumbInputRef = useRef<HTMLInputElement>(null)
  const breadcrumbSessionButtonRef = useRef<HTMLButtonElement>(null)
  const skipBreadcrumbBlurCommitRef = useRef(false)
  useDialogFocus(sidebarDialogRef, sidebarDialog !== null)

  useLayoutEffect(() => {
    const menu = sidebarMenuRef.current
    if (!sidebarMenu || !menu) return
    const anchor = sidebarMenu.anchor
    /** 根据按钮与菜单的实际尺寸定位，在空间不足时向上展开。 */
    function positionMenu(): void {
      if (!menu) return
      const rect = anchor.getBoundingClientRect()
      const { width, height } = menu.getBoundingClientRect()
      const top = rect.bottom + 4 + height <= window.innerHeight - 8 ? rect.bottom + 4 : rect.top - height - 4
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
      menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`
    }
    positionMenu()
    menu.querySelector("button")?.focus({ preventScroll: true })
    window.addEventListener("resize", positionMenu)
    window.addEventListener("scroll", positionMenu, true)
    return () => {
      window.removeEventListener("resize", positionMenu)
      window.removeEventListener("scroll", positionMenu, true)
    }
  }, [sidebarMenu])

  useEffect(() => {
    if (!copyStatus) return
    const timer = window.setTimeout(() => setCopyStatus(null), 4500)
    return () => window.clearTimeout(timer)
  }, [copyStatus])

  const [openMenu, setOpenMenu] = useState<"permission" | "project" | "branch" | null>(null)
  const [gitBranchState, setGitBranchState] = useState<ProjectGitBranchState | null>(null)
  const [switchingGitBranch, setSwitchingGitBranch] = useState(false)
  const [gitSwitchError, setGitSwitchError] = useState<string | undefined>()
  const gitBranchRequestIdRef = useRef(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [chatsOpen, setChatsOpen] = useState(true)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const composerRef = useRef<HTMLElement>(null)
  const createdProjectsRef = useRef<ProjectSummary[]>([])
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [projectDirectories, setProjectDirectories] = useState<DirectorySelection[]>([])
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null)
  const [selectingProjectDirectory, setSelectingProjectDirectory] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [focusDraftKey, setFocusDraftKey] = useState<string | null>(null)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<"models" | "mcp" | "skills">("models")
  const [searchOpen, setSearchOpen] = useState(false)
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { return localStorage.getItem("nicode.appearance") === "dark" ? "dark" : "light" }
    catch { return "light" }
  })
  const projectDialogRef = useRef<HTMLElement>(null)
  useDialogFocus(projectDialogRef, projectDialogOpen)
  /** 技能列表只在查看时读取，弹窗卸载和工作区路由切换均保留字典。 */
  const [skillsByScope, setSkillsByScope] = useState<SkillCache>({})

  /**
   * 刷新指定分组的对话索引摘要，不重新加载完整历史。
   *
   * @param projectId 要刷新的摘要分组；不重查聊天历史。
   * @returns 摘要更新完成。
   */
  async function refreshSessionSummaries(projectId: string): Promise<void> {
    try {
      if (projectId === "default") setDefaultSessions({ status: "ready", value: await window.nicode.listDefaultSessions() })
      else setProjects({ status: "ready", value: await window.nicode.listProjects() })
    } catch (error) { console.error("更新对话列表失败", error) }
  }
  /**
   * 打开行菜单并保留用于键盘焦点恢复的按钮。
   * @param target 项目或对话身份。
   * @param anchor 触发菜单的按钮。
   */
  function openSidebarMenu(target: SidebarTarget, anchor: HTMLButtonElement): void {
    setOpenMenu(null)
    setSidebarMenu((current) => current?.anchor === anchor ? null : { target, anchor })
  }

  /**
   * 从菜单打开对应弹窗。
   * @param kind 弹窗操作。
   */
  function openSidebarDialog(kind: SidebarDialog["kind"]): void {
    if (!sidebarMenu) return
    sidebarMenu.anchor.focus()
    setSidebarName(sidebarMenu.target.name)
    setSidebarError(null)
    setSidebarDialog({ kind, target: sidebarMenu.target })
    setSidebarMenu(null)
  }

  /**
   * 持久化会话新名称，并同步工作区缓存与所属分组的侧栏摘要。
   * @param projectId 会话所属分组 ID；独立对话传 "default"。
   * @param sessionId 目标持久化会话 ID。
   * @param name 去除首尾空白后的非空会话名称。
   * @returns 更新后的会话摘要。
   * @throws 当 IPC 重命名失败时向上抛出错误，由调用方负责恢复与提示。
   */
  async function persistSessionRename(projectId: string, sessionId: string, name: string): Promise<SessionSummary> {
    const summary = await window.nicode.renameSession(projectId, sessionId, name)
    const key = sessionKey(projectId, sessionId)
    if (sessionsState.has(key)) sessionsState.setView(key, { summary })
    await refreshSessionSummaries(projectId)
    return summary
  }

  /**
   * 提交名称并同步侧栏及对话缓存。
   * @returns 保存或错误提示完成。
   */
  async function renameSidebarTarget(): Promise<void> {
    const name = sidebarName.trim()
    if (!sidebarDialog || sidebarBusy || !name) return
    const { projectId, sessionId } = sidebarDialog.target
    setSidebarBusy(true)
    setSidebarError(null)
    try {
      if (sessionId === undefined) {
        const project = await window.nicode.renameProject(projectId, name)
        setProjects((current) => current.status === "ready"
          ? { status: "ready", value: current.value.map((item) => item.projectId === projectId ? { ...item, name: project.name, updatedAt: project.updatedAt } : item) }
          : current)
      } else {
        await persistSessionRename(projectId, sessionId, name)
      }
      setSidebarDialog(null)
    } catch (error) { setSidebarError(errorMessage(error)) }
    finally { setSidebarBusy(false) }
  }

  /**
   * 增加或移除一项关联目录。
   * @param directory 传入已关联路径时移除，省略时通过系统窗口选择新目录。
   * @returns 目录保存、取消选择或错误提示完成。
   */
  async function changeSidebarDirectory(directory?: string): Promise<void> {
    if (!sidebarDialog || sidebarBusy) return
    const { projectId } = sidebarDialog.target
    setSidebarBusy(true)
    setSidebarError(null)
    try {
      const path = directory ?? (await window.nicode.selectDirectory())?.path
      if (path === undefined) return
      const result = directory === undefined
        ? await window.nicode.addProjectDirectory(projectId, path)
        : await window.nicode.removeProjectDirectory(projectId, path)
      if (!result.success) throw new Error(result.error)
      setProjects({ status: "ready", value: await window.nicode.listProjects() })
    } catch (error) { setSidebarError(errorMessage(error)) }
    finally { setSidebarBusy(false) }
  }

  /**
   * 将菜单目标的对话正文写入剪贴板。
   * @returns 复制成功或失败提示完成。
   */
  async function copySidebarConversation(): Promise<void> {
    if (!sidebarMenu || sidebarMenu.target.sessionId === undefined) return
    const { projectId, sessionId } = sidebarMenu.target
    sidebarMenu.anchor.focus()
    setSidebarMenu(null)
    setCopyStatus(null)
    try {
      const markdown = await window.nicode.exportSessionMarkdown(projectId, sessionId)
      await navigator.clipboard.writeText(markdown)
      setCopyStatus({ text: "已复制对话", error: false })
    } catch (error) {
      setCopyStatus({ text: `复制对话失败：${errorMessage(error)}`, error: true })
    }
  }

  useEffect(() => window.nicode.onSessionUpdate((update) => {
    try { sessionsState.receive(update) }
    catch (error) { sessionsState.setView(sessionKey(update.projectId, update.sessionId), { operationError: errorMessage(error) }) }
    if ((update.kind === "event" && update.event.type === "turn/end") || (update.kind === "state" && update.summary)) void refreshSessionSummaries(update.projectId)
  }), [sessionsState])

  /**
   * 查询项目摘要，将结果或错误保存到当前页面状态。
   *
   * @returns 项目查询结束后的 Promise；失败会转成当前区域的错误状态。
   */
  async function loadProjects(): Promise<void> {
    setProjects({ status: "loading" })
    try {
      const loaded = await window.nicode.listProjects()
      const value = [...loaded]
      for (const createdProject of createdProjectsRef.current) {
        const existingIndex = value.findIndex((project) => project.projectId === createdProject.projectId)
        if (existingIndex === -1) value.push(createdProject)
        else value[existingIndex] = createdProject
      }
      value.sort(newestFirst)
      setProjects({ status: "ready", value })
      setExpandedProjects(new Set(value.length > 0 ? [value[0].projectId] : []))
    } catch (error) {
      console.error("加载项目列表失败", error)
      setProjects({ status: "error" })
    }
  }

  /**
   * 查询 default 分组对话摘要，将结果或错误保存到当前页面状态。
   *
   * @returns default 对话查询结束后的 Promise；失败会转成当前区域的错误状态。
   */
  async function loadDefaultSessions(): Promise<void> {
    setDefaultSessions({ status: "loading" })
    try {
      setDefaultSessions({ status: "ready", value: await window.nicode.listDefaultSessions() })
    } catch (error) {
      console.error("加载 default 对话列表失败", error)
      setDefaultSessions({ status: "error" })
    }
  }

  /**
   * 查询不含凭据的 Provider 摘要并更新当前页面状态。
   *
   * @returns Provider 查询结束后的 Promise；失败会转成当前区域的错误状态。
   */
  async function loadProviders(): Promise<void> {
    setProviders({ status: "loading" })
    try {
      setProviders({ status: "ready", value: await window.nicode.listProviders() })
    } catch (error) {
      console.error("加载模型列表失败", error)
      setProviders({ status: "error" })
    }
  }

  /**
   * 只切换一个项目索引的展开状态。
   * @param projectId 项目数据库标识。
   */
  function toggleProject(projectId: string): void {
    setExpandedProjects((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  /**
   * 切换到 default 或指定 Project 的新聊天路由。
   * @param projectId 指定时表示项目分组；省略时表示 default 分组。
   * @param mode 首发模式，默认为普通聊天。
   * @returns 导航完成时无返回值。
   */
  function navigateToNewChat(projectId?: string, mode: WorkspaceMode = "chat"): void {
    setOpenMenu(null)
    const path = projectId === undefined
      ? "/default/new-chat"
      : `/projects/${encodeURIComponent(projectId)}/new-chat`
    navigate(mode === "work" ? path + "?mode=work" : path)
  }

  /**
   * 导航到以 Project ID 与 Session ID 联合标识的对话路由。
   * @param projectId Session 所属 Project ID；default 对话使用 "default"。
   * @param sessionId 要打开的持久化 Session ID。
   * @returns 导航完成时无返回值。
   */
  function navigateToSession(projectId: string, sessionId: string): void {
    setOpenMenu(null)
    navigate(`/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`)
  }

  /**
   * 切换到指定分组与模式的新会话并聚焦任务输入框。
   * @param projectId 指定时使用该项目；省略时使用 default 分组。
   * @param mode 首发模式，默认为普通聊天。
   * @returns 输入框获得焦点时无返回值；已有草稿保持不变。
   */
  function focusNewChatComposer(projectId?: string, mode: WorkspaceMode = "chat"): void {
    setFocusDraftKey(sessionKey(projectId ?? "default", mode === "work" ? "$new-work" : "$new-chat"))
    navigateToNewChat(projectId, mode)
  }

  /**
   * 打开创建项目弹窗并开始一份空白表单。
   * @returns 弹窗打开时无返回值。
   */
  function openProjectDialog(): void {
    setOpenMenu(null)
    setProjectName("")
    setProjectDirectories([])
    setProjectDialogError(null)
    setProjectDialogOpen(true)
  }

  /**
   * 关闭创建项目弹窗；项目创建提交期间保持弹窗打开。
   * @returns 弹窗关闭时无返回值。
   */
  function closeProjectDialog(): void {
    if (creatingProject) return
    setProjectDialogOpen(false)
    setProjectDirectories([])
  }

  /**
   * 通过主进程系统目录选择器读取并追加项目关联目录；相同绝对路径只保留一次。
   * @returns 用户选中目录或取消选择后无返回值。
   */
  async function selectProjectDirectory(): Promise<void> {
    setProjectDialogError(null)
    setSelectingProjectDirectory(true)
    try {
      const selection = await window.nicode.selectDirectory()
      if (selection !== null) {
        setProjectDirectories((current) => current.some((directory) => directory.path === selection.path)
          ? current
          : [...current, selection])
      }
    } catch (error) {
      console.error("选择项目目录失败", error)
      setProjectDialogError("选择目录失败，请重试。")
    } finally {
      setSelectingProjectDirectory(false)
    }
  }

  /**
   * 从当前创建项目表单的临时目录列表中移除指定绝对路径。
   * @param path 要移除的目录绝对路径。
   * @returns 更新临时目录列表时无返回值。
   */
  function removeProjectDirectory(path: string): void {
    setProjectDirectories((current) => current.filter((directory) => directory.path !== path))
  }

  /**
   * 创建项目并把主进程返回的摘要追加到当前侧栏列表。
   * @returns 创建成功后关闭弹窗；失败时保留表单并显示错误。
   */
  async function submitProjectCreation(): Promise<void> {
    const name = projectName.trim()
    if (name === "" || creatingProject || selectingProjectDirectory) return

    setCreatingProject(true)
    setProjectDialogError(null)
    try {
      const createdProject = await window.nicode.createProject(
        name,
        projectDirectories.length === 0 ? undefined : projectDirectories.map((directory) => directory.path),
      )
      createdProjectsRef.current = [
        ...createdProjectsRef.current.filter((project) => project.projectId !== createdProject.projectId),
        createdProject,
      ]
      setProjects((current) => {
        const value = current.status === "ready" ? current.value : []
        const existingIndex = value.findIndex((project) => project.projectId === createdProject.projectId)
        if (existingIndex === -1) return { status: "ready", value: [...value, createdProject] }
        return {
          status: "ready",
          value: value.map((project) => project.projectId === createdProject.projectId ? createdProject : project),
        }
      })
      setProjectDialogOpen(false)
      setProjectDirectories([])
    } catch (error) {
      console.error("创建项目失败", error)
      setProjectDialogError("创建项目失败，请检查名称和目录后重试。")
    } finally {
      setCreatingProject(false)
    }
  }

  /**
   * 打开设置弹窗并选择入口页。
   * @param section 本次进入的设置分区；默认模型。
   * @returns 无返回值
   */
  function openSettingsDialog(section: "models" | "mcp" | "skills" = "models"): void {
    setOpenMenu(null)
    setSettingsSection(section)
    setSettingsDialogOpen(true)
  }

  /**
   * 关闭设置弹窗
   * @returns 无返回值
   */
  function closeSettingsDialog(): void {
    setSettingsDialogOpen(false)
  }

  useEffect(() => {
    void Promise.allSettled([loadProjects(), loadDefaultSessions(), loadProviders()])
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem("nicode.appearance", theme) } catch { /** 存储不可用时主题仍在本次窗口内生效。 */ }
  }, [theme])

  useEffect(() => {
    /**
     * 处理工作区导航快捷键，保留输入法与业务弹窗的键盘边界。
     *
     * @param event 应用快捷键仅在没有业务弹窗时处理，输入法组合期间不导航。
     */
    function workspaceShortcut(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.isComposing || document.querySelector('[aria-modal="true"]')) return
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setOpenMenu(null); setSearchOpen(true) }
      if (event.key.toLowerCase() === "b") { event.preventDefault(); setSidebarOpen((current) => !current) }
      if (event.key.toLowerCase() === "o" && event.shiftKey) { event.preventDefault(); focusNewChatComposer(groupId === "default" ? undefined : groupId, "chat") }
      if (event.key === ",") { event.preventDefault(); openSettingsDialog() }
    }
    window.addEventListener("keydown", workspaceShortcut)
    return () => window.removeEventListener("keydown", workspaceShortcut)
  }, [groupId])

  useEffect(() => {
    if (focusDraftKey === null || workspaceRoute.page !== "new-chat" || newDraftKey !== focusDraftKey) return
    if (!document.querySelector('[aria-modal="true"]')) composerRef.current?.focus()
    setFocusDraftKey(null)
  }, [focusDraftKey, workspaceRoute.page, newDraftKey])

  useEffect(() => {
    if (openMenu === null) return
    /**
     * 按当前弹层及提交状态处理 Escape，保留已有关闭保护。
     *
     * @param event 键盘事件；Escape 关闭当前弹层。
     */
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpenMenu(null)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [openMenu])

  useEffect(() => {
    if (!projectDialogOpen) return
    /**
     * 在项目创建弹窗中处理 Escape，提交期间保留弹窗。
     *
     * @param event 键盘事件；Escape 在提交期间不关闭弹窗。
     */
    function closeProjectDialogOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape" && !creatingProject) closeProjectDialog()
    }
    window.addEventListener("keydown", closeProjectDialogOnEscape)
    return () => window.removeEventListener("keydown", closeProjectDialogOnEscape)
  }, [projectDialogOpen, creatingProject])

  const modelOptions = providers.status === "ready"
    ? providers.value.flatMap((provider) => {
        const seenModelIds = new Set<string>()
        return provider.models.flatMap((model) => {
          if (seenModelIds.has(model.modelId)) return []
          seenModelIds.add(model.modelId)
          return [{
            ...model,
            providerId: provider.providerId,
            providerName: provider.name,
            protocol: provider.protocol,
            selectionKey: JSON.stringify([provider.providerId, model.modelId]),
          }]
        })
      })
    : []
  const selectedModel = modelOptions.find((model) => model.isDefault)
  const selectedReasoningLevel = selectedModel === undefined ? undefined
    : preferredReasoningLevel(selectedModel.reasoningLevels, newChatReasoningLevel)
  const activeProject = workspaceRoute.group === "project" && projects.status === "ready"
    ? projects.value.find((project) => project.projectId === workspaceRoute.projectId)
    : undefined
  const activePrimaryDirectory = activeProject?.directories[0]
  const currentSessions = groupId === "default"
    ? defaultSessions.status === "ready" ? defaultSessions.value : []
    : activeProject?.sessions ?? []
  // 新会话预览按模式区分，使用独立于会话 UUID 的标识。
  const browserOwner = workspaceRoute.page === "session" ? workspaceRoute.sessionId : draftMode === "work" ? "new-work" : "new-chat"
  const teamMembersOpen = currentKind === "router" && teamMembersRouter === browserOwner
  const browserState = browserTags.get(browserOwner)
  const browserExpanded = browserState.narrowPanel === "browser"
  const currentRouteSessionId = workspaceRoute.page === "session" ? workspaceRoute.sessionId : undefined
  const activeSessionKey = currentRouteSessionId ? sessionKey(groupId, currentRouteSessionId) : undefined
  const currentSession = workspaceRoute.page === "session"
    ? (currentSessions.find((session) => session.sessionId === workspaceRoute.sessionId)
      ?? (activeSessionKey && sessionsState.has(activeSessionKey) ? sessionsState.sessionViewsByKey[activeSessionKey]?.summary : undefined))
    : undefined
  const runningCount = Object.values(sessionsState.sessionViewsByKey).filter((view) => view.control?.phase === "running" || view.control?.phase === "stopping").length

  useEffect(() => {
    skipBreadcrumbBlurCommitRef.current = false
    setRenamingBreadcrumbSession(false)
    setBreadcrumbSessionName("")
    setBreadcrumbRenameBusy(false)
    setBreadcrumbRenameError(null)
  }, [workspaceRoute.page, groupId, currentRouteSessionId])

  useEffect(() => {
    if (!renamingBreadcrumbSession) return
    const input = breadcrumbInputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [renamingBreadcrumbSession])

  /**
   * 同步指定 Project 主目录的 Git 分支状态，使用递增请求号丢弃过期响应。
   * @param projectId 非 default Project UUID。
   * @returns 分支查询完成；无法读取或未提供分支 handler 时收起分支入口。
   */
  async function loadProjectGitBranches(projectId: string): Promise<void> {
    const requestId = ++gitBranchRequestIdRef.current
    try {
      const state = await window.nicode.listProjectGitBranches(projectId)
      if (requestId === gitBranchRequestIdRef.current) setGitBranchState(state)
    } catch {
      if (requestId === gitBranchRequestIdRef.current) setGitBranchState(null)
    }
  }

  useEffect(() => {
    setGitSwitchError(undefined)
    setOpenMenu((current) => current === "branch" ? null : current)
    if (workspaceRoute.page !== "new-chat" || !activeProject || !activePrimaryDirectory) {
      gitBranchRequestIdRef.current++
      setGitBranchState(null)
      return
    }
    const targetProjectId = activeProject.projectId
    void loadProjectGitBranches(targetProjectId)
    /** 窗口重新获得焦点时同步外部 Git CLI 变更的当前分支与列表。 */
    function handleWindowFocus(): void {
      void loadProjectGitBranches(targetProjectId)
    }
    window.addEventListener("focus", handleWindowFocus)
    return () => {
      gitBranchRequestIdRef.current++
      window.removeEventListener("focus", handleWindowFocus)
    }
  }, [workspaceRoute.page, activeProject?.projectId, activePrimaryDirectory])

  /**
   * 在新聊天上下文栏切换归属工作区或项目，并在目标草稿为空且不含跨项目文件引用时迁移当前输入内容。
   * @param targetProjectId 目标 Project UUID；省略时切换为独立对话（default）。
   * @returns 路由已切换，保留当前普通/团队模式并将焦点还给新聊天输入框。
   */
  function selectNewChatProject(targetProjectId?: string): void {
    const targetGroupId = targetProjectId ?? "default"
    if (targetGroupId === groupId) {
      setOpenMenu(null)
      return
    }
    const modeSuffix = draftMode === "work" ? "$new-work" : "$new-chat"
    const currentDraft = sessionsState.draftsByKey[newDraftKey]
    const targetDraftKey = sessionKey(targetGroupId, modeSuffix)
    const targetDraft = sessionsState.draftsByKey[targetDraftKey]
    const currentMessage = serializeComposerMessage(currentDraft)
    const targetMessage = serializeComposerMessage(targetDraft)
    const targetEmpty = !targetMessage.content[0].text.trim() && !(targetMessage.fileReferences?.length)
    const canTransferPlainText = currentMessage.content[0].text.trim().length > 0 && !(currentMessage.fileReferences?.length)
    if (currentDraft && targetEmpty && canTransferPlainText) {
      sessionsState.setDraft(targetDraftKey, currentDraft)
      sessionsState.setDraft(newDraftKey)
    }
    focusNewChatComposer(targetProjectId, draftMode)
  }

  /**
   * 通过主进程在当前项目主目录执行 `git switch`，成功后更新分支状态，失败时保留原分支并报告真实错误。
   * @param branch 目标本地分支名称。
   * @returns 分支切换请求结束；所有错误均转为页面警告提示。
   */
  async function selectProjectGitBranch(branch: string): Promise<void> {
    if (!activeProject || switchingGitBranch) return
    const targetProjectId = activeProject.projectId
    const requestId = ++gitBranchRequestIdRef.current
    setOpenMenu(null)
    setSwitchingGitBranch(true)
    setGitSwitchError(undefined)
    try {
      const result = await window.nicode.switchProjectGitBranch(targetProjectId, branch)
      if (result.success) {
        if (requestId === gitBranchRequestIdRef.current) setGitBranchState(result.branchState)
      } else {
        setGitSwitchError(result.error)
        void loadProjectGitBranches(targetProjectId)
      }
    } catch (error) {
      setGitSwitchError(errorMessage(error))
      void loadProjectGitBranches(targetProjectId)
    } finally {
      setSwitchingGitBranch(false)
    }
  }

  /**
   * 进入页头当前对话名称的原地重命名状态。
   * @returns 处于已有持久化会话页面时开启编辑框；其余路由保持静态标题。
   */
  function startBreadcrumbRename(): void {
    if (!currentSession) return
    skipBreadcrumbBlurCommitRef.current = false
    setBreadcrumbSessionName(currentSession.name)
    setBreadcrumbRenameError(null)
    setRenamingBreadcrumbSession(true)
  }

  /**
   * 取消页头对话名称重命名，丢弃未提交输入并避免后续失焦重复提交。
   * @param restoreFocus 是否在退出编辑后将焦点还原到标题按钮。
   * @returns 编辑状态已重置。
   */
  function cancelBreadcrumbRename(restoreFocus = false): void {
    skipBreadcrumbBlurCommitRef.current = true
    setRenamingBreadcrumbSession(false)
    setBreadcrumbRenameError(null)
    if (restoreFocus) queueMicrotask(() => breadcrumbSessionButtonRef.current?.focus())
  }

  /**
   * 提交页头编辑后的对话名称；空白或未变化时直接退出，失败时保留输入并展示错误提示。
   * @param trigger 触发来源：回车提交（submit）或失焦提交（blur）。
   * @returns 重命名处理完成；IPC 错误已转为行内提示且可再次提交。
   */
  async function commitBreadcrumbRename(trigger: "submit" | "blur"): Promise<void> {
    if (trigger === "blur" && skipBreadcrumbBlurCommitRef.current) {
      skipBreadcrumbBlurCommitRef.current = false
      return
    }
    if (breadcrumbRenameBusy || workspaceRoute.page !== "session" || !currentSession) return
    const trimmed = breadcrumbSessionName.trim()
    if (!trimmed || trimmed === currentSession.name) {
      setRenamingBreadcrumbSession(false)
      setBreadcrumbRenameError(null)
      if (trigger === "submit") queueMicrotask(() => breadcrumbSessionButtonRef.current?.focus())
      return
    }
    setBreadcrumbRenameBusy(true)
    setBreadcrumbRenameError(null)
    try {
      await persistSessionRename(groupId, currentSession.sessionId, trimmed)
      setRenamingBreadcrumbSession(false)
      if (trigger === "submit") queueMicrotask(() => breadcrumbSessionButtonRef.current?.focus())
    } catch (error) {
      setBreadcrumbRenameError(errorMessage(error))
    } finally {
      setBreadcrumbRenameBusy(false)
    }
  }

  /**
   * 保存新聊天选择的全局默认模型，成功后同步本地默认标记；失败时保留原选择并显示错误。
   * @param selectionKey Provider 与模型身份组成的页面选项键。
   * @returns 本次保存尝试结束；异常已转换为页面错误状态。
   */
  async function selectDefaultModel(selectionKey: string): Promise<void> {
    if (savingDefaultModel) return
    const model = modelOptions.find((option) => option.selectionKey === selectionKey)
    if (model === undefined) return
    setOpenMenu(null)
    setSavingDefaultModel(true)
    setDefaultModelError(undefined)
    try {
      await window.nicode.setDefaultModel({ providerId: model.providerId, modelId: model.modelId })
      setNewChatReasoningLevel(preferredReasoningLevel(model.reasoningLevels, newChatReasoningLevel))
      setProviders((current) => current.status !== "ready" ? current : {
        status: "ready",
        value: current.value.map((provider) => ({
          ...provider,
          models: provider.models.map((entry) => ({
            ...entry,
            isDefault: provider.providerId === model.providerId && entry.modelId === model.modelId,
          })),
        })),
      })
    } catch (error) {
      setDefaultModelError("默认模型保存失败：" + errorMessage(error))
    } finally {
      setSavingDefaultModel(false)
    }
  }

  /**
   * 提交当前分组草稿，首批事件成功后清理草稿并进入新对话。
   *
   * @returns 新对话首批事件提交后清理当前分组草稿并导航；失败保留草稿。
   */
  async function sendNewChat(): Promise<void> {
    const draft = sessionsState.draftsByKey[newDraftKey]
    const message = serializeComposerMessage(draft)
    if (!message.content[0].text.trim() || !selectedModel || !selectedReasoningLevel || savingDefaultModel || sessionsState.view(newDraftKey).busy) return
    sessionsState.setView(newDraftKey, { busy: true, operationError: undefined })
    try {
      const { providerId, protocol, modelId, name } = selectedModel
      const input: Parameters<typeof window.nicode.startNewSession>[1] = {
        ...message, model: { providerId, protocol, modelId, name, reasoningLevel: selectedReasoningLevel },
        sandboxMode: permission === "workspace-read-only" ? "sandbox-read-only" : permission === "auto" || permission === "full-access" ? permission : "sandbox-full-access",
      }
      const response = draftMode === "work"
        ? await window.nicode.startTeamSession(groupId, input)
        : await window.nicode.startNewSession(groupId, input)
      sessionsState.setView(sessionKey(groupId, response.sessionId), { kind: draftMode === "work" ? "router" : "ordinary" })
      if (sessionsState.draftsByKey[newDraftKey] === draft) sessionsState.setDraft(newDraftKey)
      void refreshSessionSummaries(groupId)
      navigateToSession(groupId, response.sessionId)
    } catch (error) { sessionsState.setView(newDraftKey, { operationError: errorMessage(error) }) }
    finally { sessionsState.setView(newDraftKey, { busy: false }) }
  }

  return <div className="app-shell">
    <header className="titlebar">
      <div className="titlebar-left">
        <div className="titlebar-brand"><span className="brand-mark" aria-hidden="true"><IconTerminal2 size={13} stroke={1.9} /></span><span className="brand-name">NiCode</span></div>
        <button type="button" className="sidebar-toggle" aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"} title={sidebarOpen ? "收起侧栏 · Ctrl B" : "展开侧栏 · Ctrl B"} onClick={() => setSidebarOpen((current) => !current)}><IconLayoutSidebar size={16} stroke={1.6} aria-hidden="true" /></button>
        <button className="titlebar-search" type="button" disabled={settingsDialogOpen || projectDialogOpen || searchOpen} onClick={() => setSearchOpen(true)} aria-label="搜索工作区" title="搜索项目和对话 · Ctrl K"><IconSearch size={16} stroke={1.6} aria-hidden="true" /></button>
      </div>
      <div className="titlebar-actions">
        {runningCount > 0 && <span className="titlebar-running" role="status"><i className="status-dot" />{runningCount} 个对话运行中</span>}
      </div>
      <WindowControls />
    </header>
    <div className="workspace-shell">
      {sidebarOpen && <aside className="sidebar" aria-label="工作区侧栏">
        <div className="sidebar-create" aria-label="创建对话">
          <button className="new-chat sidebar-create-item" type="button" title="新聊天 · Ctrl Shift O" aria-current={workspaceRoute.page === "new-chat" && workspaceRoute.group === "default" && draftMode === "chat" ? "page" : undefined} onClick={() => focusNewChatComposer(undefined, "chat")}><IconPlus size={16} stroke={1.6} aria-hidden="true" /><span>新聊天</span></button>
          <button className="new-team-chat sidebar-create-item" type="button" title="新团队会话" aria-current={workspaceRoute.page === "new-chat" && workspaceRoute.group === "default" && draftMode === "work" ? "page" : undefined} onClick={() => focusNewChatComposer(undefined, "work")}><IconUsers size={16} stroke={1.6} aria-hidden="true" /><span>新团队会话</span></button>
        </div>
        <nav className="sidebar-scroll" aria-label="项目和对话">
          <section className="sidebar-section project-section" aria-label="项目">
            <div className="section-heading-row">
              <button className="section-heading" type="button" aria-expanded={projectsOpen} onClick={() => setProjectsOpen((current) => !current)}><span>项目</span>{projects.status === "ready" && <span className="section-count">{projects.value.length}</span>}<span className={projectsOpen ? "chevron" : "chevron collapsed"}><IconChevronDown size={12} /></span></button>
              <button className="section-action section-action-button" type="button" aria-label="创建项目" title="创建项目" onClick={openProjectDialog}><IconPlus size={16} /></button>
            </div>
            {projectsOpen && <><DataStatus state={projects} retry={() => { void loadProjects() }} />
              {projects.status === "ready" && (projects.value.length === 0
                ? <button className="sidebar-empty" type="button" onClick={openProjectDialog}><IconFolderPlus size={23} /><strong>为想法建立一个空间</strong><span>创建项目，连接你的代码</span></button>
                : <ul className="project-list">{[...projects.value].sort(newestFirst).map((project) => <li key={project.projectId}>
                    <div className={workspaceRoute.page === "new-chat" && workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? "project-row project-row-active" : "project-row"}>
                      <button className="project-name" type="button" title={project.name} aria-expanded={expandedProjects.has(project.projectId)} aria-current={workspaceRoute.page === "new-chat" && workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? "page" : undefined} onClick={() => toggleProject(project.projectId)}>
                        {expandedProjects.has(project.projectId) ? <IconFolderOpen stroke={1.6} aria-hidden="true" /> : <IconFolder stroke={1.6} aria-hidden="true" />}
                        <span>{project.name}</span>
                      </button>
                      <button className="project-action-button" type="button" aria-label={`在 ${project.name} 中新建聊天`} title={`在 ${project.name} 中新建聊天`} onClick={() => focusNewChatComposer(project.projectId, "chat")}><IconPlus size={16} stroke={1.6} aria-hidden="true" /></button>
                      <SidebarMore target={project} expanded={sidebarMenu?.target.projectId === project.projectId && sidebarMenu.target.sessionId === undefined} onOpen={openSidebarMenu} />
                    </div>
                    {expandedProjects.has(project.projectId) && <div className="project-sessions"><SessionList projectId={project.projectId} sessions={project.sessions} activeSessionId={workspaceRoute.page === "session" && workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? workspaceRoute.sessionId : undefined} onOpenSession={navigateToSession} menuAnchor={sidebarMenu?.target} onMore={openSidebarMenu} />
                      {project.sessions.length === 0 && <button className="project-first-chat" type="button" onClick={() => focusNewChatComposer(project.projectId, "chat")}>开始第一段对话 <IconArrowUpRight size={12} /></button>}
                    </div>}
                  </li>)}</ul>)}
            </>}
          </section>
          <section className="sidebar-section chats-section" aria-label="聊天">
            <div className="section-heading-row">
              <button className="section-heading" type="button" aria-expanded={chatsOpen} onClick={() => setChatsOpen((current) => !current)}><span>独立对话</span>{defaultSessions.status === "ready" && <span className="section-count">{defaultSessions.value.length}</span>}<span className={chatsOpen ? "chevron" : "chevron collapsed"}><IconChevronDown size={12} /></span></button>
              <button className="section-action section-action-button" type="button" aria-label="新建聊天" title="新建聊天" onClick={() => focusNewChatComposer(undefined, "chat")}><IconPlus size={16} stroke={1.6} aria-hidden="true" /></button>
            </div>
            {chatsOpen && <><DataStatus state={defaultSessions} retry={() => { void loadDefaultSessions() }} />
              {defaultSessions.status === "ready" && (defaultSessions.value.length === 0 ? <p className="empty-list">你的下一段对话，从这里开始。</p> : <SessionList projectId="default" sessions={defaultSessions.value} activeSessionId={workspaceRoute.page === "session" && workspaceRoute.group === "default" ? workspaceRoute.sessionId : undefined} onOpenSession={navigateToSession} menuAnchor={sidebarMenu?.target} onMore={openSidebarMenu} />)}
            </>}
          </section>
        </nav>
        <div className="sidebar-footer">
          <button className="sidebar-settings" type="button" aria-label="设置" title="设置 · Ctrl ," onClick={() => openSettingsDialog()}><IconAdjustmentsHorizontal size={17} stroke={1.6} aria-hidden="true" /><span>设置</span></button>
          <button className="sidebar-theme" type="button" aria-label={theme === "light" ? "切换深色外观" : "切换浅色外观"} title={theme === "light" ? "深色外观" : "浅色外观"} onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}>{theme === "light" ? <IconMoon size={17} stroke={1.6} aria-hidden="true" /> : <IconSun size={17} stroke={1.6} aria-hidden="true" />}</button>
        </div>
      </aside>}
      <div className="workspace-main">
        <header className="panel-header">
          <div className="panel-header-row">
            <div className="panel-header-context">
              <div className="breadcrumb">
                {activeProject && <>
                  <button className="breadcrumb-project" type="button" title={activeProject.directories.join(" · ") || activeProject.name}
                    aria-label={`进入项目 ${activeProject.name} 的新聊天`}
                    onClick={() => focusNewChatComposer(activeProject.projectId, "chat")}>{activeProject.name}</button>
                  <span className="breadcrumb-divider">/</span>
                </>}
                {workspaceRoute.page === "session" && currentSession
                  ? (renamingBreadcrumbSession
                    ? <>
                      <input ref={breadcrumbInputRef} className="breadcrumb-rename-input" type="text" aria-label="修改对话名称"
                        value={breadcrumbSessionName} readOnly={breadcrumbRenameBusy}
                        onChange={(event) => { setBreadcrumbSessionName(event.target.value); setBreadcrumbRenameError(null) }}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing) return
                          if (event.key === "Enter") { event.preventDefault(); void commitBreadcrumbRename("submit") }
                          else if (event.key === "Escape") { event.preventDefault(); cancelBreadcrumbRename(true) }
                        }}
                        onBlur={() => { void commitBreadcrumbRename("blur") }} />
                      {breadcrumbRenameError && <span className="breadcrumb-rename-error" role="alert" title={breadcrumbRenameError}>{breadcrumbRenameError}</span>}
                    </>
                    : <button ref={breadcrumbSessionButtonRef} className="breadcrumb-session" type="button"
                        title={`${currentSession.name} · 点击修改对话名称`} aria-label={`修改对话名称：${currentSession.name}`}
                        onClick={startBreadcrumbRename}><strong>{currentSession.name}</strong></button>)
                  : <strong title={currentSession?.name}>{workspaceRoute.page === "new-chat" ? newConversationLabel : currentSession?.name ?? "对话"}</strong>}
              </div>
            </div>
            <div className="panel-header-actions">
              {currentKind === "router" && <button className="settings-icon-button" type="button" aria-label="团队成员" title="团队成员"
                aria-haspopup="dialog" onClick={() => setTeamMembersRouter(browserOwner)}><IconUsers size={17} aria-hidden="true" /></button>}
              {!sidebarOpen && <>
                <button className="settings-icon-button" type="button" aria-label="设置" title="设置 · Ctrl ," onClick={() => openSettingsDialog()}><IconAdjustmentsHorizontal size={17} stroke={1.6} aria-hidden="true" /></button>
                <button className="settings-icon-button" type="button" aria-label={theme === "light" ? "切换深色外观" : "切换浅色外观"} title={theme === "light" ? "深色外观" : "浅色外观"} onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}>{theme === "light" ? <IconMoon size={17} stroke={1.6} aria-hidden="true" /> : <IconSun size={17} stroke={1.6} aria-hidden="true" />}</button>
              </>}{(workspaceRoute.page === "session" || !sidebarOpen) && <button className="settings-icon-button" type="button" aria-label="在当前空间新建聊天" title="在当前空间新建聊天" onClick={() => focusNewChatComposer(groupId === "default" ? undefined : groupId, "chat")}><IconPlus size={17} stroke={1.6} aria-hidden="true" /></button>}
              <button className="settings-icon-button browser-toggle" type="button" aria-expanded={browserExpanded} aria-controls="chat-browser-pane"
                aria-label={browserExpanded ? "收起内置浏览器" : "展开内置浏览器"} title={browserExpanded ? "收起内置浏览器" : "展开内置浏览器"}
                onClick={() => {
                  if (!browserExpanded && browserState.activeTagId === null) {
                    browserTags.open(browserOwner, { kind: "blank", id: crypto.randomUUID() })
                    return
                  }
                  browserTags.set(browserOwner, { ...browserState, narrowPanel: browserExpanded ? "chat" : "browser" })
                }}>
                <IconLayoutSidebarRight size={17} stroke={1.6} aria-hidden="true" />
              </button>
            </div>
          </div>
        </header>
        <main className="main-panel">
          <BrowserWorkspace manager={browserTags} teamSessions={teamSessions} sessionId={browserOwner} projectId={groupId}
            projects={projects.status === "ready" ? projects.value : []} theme={theme}
            obscured={teamMembersOpen || settingsDialogOpen || projectDialogOpen || searchOpen || openMenu !== null || sidebarMenu !== null || sidebarDialog !== null}
            toggle={null}>
        {workspaceRoute.page === "session" ? <Outlet context={{ state: sessionsState, browserTags, providers: providers.status === "ready" ? providers.value : [] }} /> : <div className="welcome-scroll"><div className="welcome">
          <div className="welcome-hero">
            <div className="welcome-mark" aria-hidden="true"><IconTerminal2 size={42} stroke={1.4} /></div>
            <h1>{draftMode === "work" ? "我们要做什么？" : "有什么想一起完成？"}</h1>
          </div>
          <div className="welcome-dock">
            {newChatView.operationError && <p className="chat-error" role="alert">{newChatView.operationError}</p>}
            {defaultModelError && <p className="chat-error" role="alert">{defaultModelError}</p>}
            {gitSwitchError && <p className="chat-error" role="alert">{gitSwitchError}</p>}
            <div className="composer-dock">
              <div className="composer-context-bar">
                <div className="composer-context-controls">
                  <div className="selector-anchor context-selector-anchor context-project-anchor">
                    <button className="selector-trigger context-trigger context-project-trigger" type="button" aria-label="所属项目" aria-haspopup="menu" aria-expanded={openMenu === "project"}
                      title={activeProject ? (activeProject.directories.join(" · ") || activeProject.name) : "全局独立对话"}
                      onClick={() => setOpenMenu((current) => current === "project" ? null : "project")}>
                      {activeProject ? <IconFolder size={14} stroke={1.6} aria-hidden="true" /> : <IconTerminal2 size={14} stroke={1.6} aria-hidden="true" />}
                      <span className="context-trigger-label">{activeProject ? activeProject.name : "独立对话"}</span>
                      <IconChevronDown className="context-trigger-chevron" size={12} stroke={1.7} aria-hidden="true" />
                    </button>
                    {openMenu === "project" && <div className="selector-menu context-selector-menu context-project-menu" role="menu" aria-label="选择项目">
                      <p className="menu-label">选择新对话归属</p>
                      <button type="button" role="menuitemradio" aria-checked={groupId === "default"} onClick={() => selectNewChatProject(undefined)}>
                        <span><strong>独立对话</strong><small>默认工作区</small></span>
                        {groupId === "default" && <IconCheck size={15} stroke={1.8} aria-hidden="true" />}
                      </button>
                      {projects.status === "ready" && [...projects.value].sort(newestFirst).map((project) => (
                        <button key={project.projectId} type="button" role="menuitemradio" aria-checked={groupId === project.projectId} onClick={() => selectNewChatProject(project.projectId)}>
                          <span><strong>{project.name}</strong>{project.directories[0] && <small>{project.directories[0]}</small>}</span>
                          {groupId === project.projectId && <IconCheck size={15} stroke={1.8} aria-hidden="true" />}
                        </button>
                      ))}
                      {projects.status === "loading" && <p className="menu-empty">项目加载中…</p>}
                      {projects.status === "error" && <p className="menu-empty">项目列表加载失败</p>}
                    </div>}
                  </div>
                  {activeProject && gitBranchState?.isGitRepo && <div className="selector-anchor context-selector-anchor context-branch-anchor">
                    <button className="selector-trigger context-trigger context-branch-trigger" type="button" aria-label="Git 分支" aria-haspopup="menu" aria-expanded={openMenu === "branch"} disabled={switchingGitBranch}
                      title={gitBranchState.currentBranch ? `当前 Git 分支：${gitBranchState.currentBranch}` : "当前处于游离 HEAD"}
                      onClick={() => {
                        setGitSwitchError(undefined)
                        if (openMenu === "branch") { setOpenMenu(null); return }
                        setOpenMenu("branch")
                        void loadProjectGitBranches(activeProject.projectId)
                      }}>
                      <IconGitBranch size={14} stroke={1.6} aria-hidden="true" />
                      <span className="context-trigger-label">{switchingGitBranch ? "切换中…" : gitBranchState.currentBranch ?? "游离 HEAD"}</span>
                      <IconChevronDown className="context-trigger-chevron" size={12} stroke={1.7} aria-hidden="true" />
                    </button>
                    {openMenu === "branch" && <div className="selector-menu context-selector-menu context-branch-menu" role="menu" aria-label="选择 Git 分支">
                      <p className="menu-label">切换本地分支</p>
                      {gitBranchState.branches.length === 0
                        ? <p className="menu-empty">暂无本地分支</p>
                        : gitBranchState.branches.map((branch) => (
                          <button key={branch} type="button" role="menuitemradio" aria-checked={gitBranchState.currentBranch === branch} onClick={() => { void selectProjectGitBranch(branch) }}>
                            <span><strong>{branch}</strong></span>
                            {gitBranchState.currentBranch === branch && <IconCheck size={15} stroke={1.8} aria-hidden="true" />}
                          </button>
                        ))}
                    </div>}
                  </div>}
                </div>
                <span className="composer-context-mode">
                  {draftMode === "work" && <IconUsers size={13} stroke={1.6} aria-hidden="true" />}
                  <span>{draftMode === "work" ? "团队协作" : "标准对话"}</span>
                </span>
              </div>
              <div className="composer new-chat-composer">
                <ComposerInput key={newDraftKey} inputRef={composerRef} projectId={groupId} label="任务描述" placeholder={draftMode === "work" ? "描述要交给团队协作的任务…" : "描述你想做的事，剩下的一起完成…"}
                  value={sessionsState.draftsByKey[newDraftKey]} onChange={(document) => sessionsState.setDraft(newDraftKey, document)}
                  onSend={() => void sendNewChat()} onOpenFile={(file) => browserTags.openFileReference(browserOwner, file)} />
                <div className="composer-toolbar">
                  <div className="composer-controls">
                    <div className="selector-anchor"><button className="selector-trigger" type="button" aria-label="权限" aria-haspopup="menu" aria-expanded={openMenu === "permission"} onClick={() => setOpenMenu((current) => current === "permission" ? null : "permission")}><IconShieldCheck size={15} aria-hidden="true" /><span>{permission === "default" ? "工作区读写" : permissionLabels[permission]}</span></button>
                      {openMenu === "permission" && <div className="selector-menu permission-menu" role="menu" aria-label="权限选项"><p className="menu-label">允许 NiCode 做什么</p>{permissionOptions.map((option) => <button type="button" role="menuitemradio" aria-checked={permission === option || (permission === "default" && option === "workspace-read-write")} key={option} onClick={() => { setPermission(option); setOpenMenu(null) }}>{permissionLabels[option]}{(permission === option || (permission === "default" && option === "workspace-read-write")) && <span aria-hidden="true">✓</span>}</button>)}</div>}
                    </div>
                  </div>
                  <div className="composer-controls composer-controls-right">
                    {providers.status === "loading" && <span className="model-status" role="status">模型加载中…</span>}
                    {providers.status === "error" && <span className="model-status" role="alert">模型加载失败 <button className="retry-button" type="button" onClick={() => { void loadProviders() }}>重试</button></span>}
                    {providers.status === "ready" && (modelOptions.length === 0 ? <button className="selector-trigger setup-model-trigger" type="button" onClick={() => openSettingsDialog()}>配置模型</button>
                      : <ComposerModelPicker label="模型" options={modelOptions.map((model) => ({ key: model.selectionKey, name: model.name, providerName: model.providerName }))}
                          selectedKey={selectedModel?.selectionKey ?? ""} modelName={selectedModel?.name ?? "选择模型"}
                          supportsReasoning={selectedModel?.supportsReasoning ?? false} reasoningLevel={selectedReasoningLevel ?? ""} reasoningLevels={selectedModel?.reasoningLevels ?? []}
                          disabled={savingDefaultModel || Boolean(newChatView.busy)} onModelChange={(key) => { void selectDefaultModel(key) }} onReasoningChange={setNewChatReasoningLevel} />)}
                    <button className="send-button" type="button" disabled={!selectedModel || !selectedReasoningLevel || savingDefaultModel || newChatView.busy || !serializeComposerMessage(sessionsState.draftsByKey[newDraftKey]).content[0].text.trim()} onClick={() => void sendNewChat()} aria-label="发送消息"><IconArrowUp size={18} stroke={2} /></button>
                  </div>
                </div>
              </div>
            </div>
            <div className="composer-caption"><span>Enter 发送 · Shift + Enter 换行</span></div>
          </div>
        </div></div>}
          </BrowserWorkspace>
        </main>
      </div>
    </div>
    {openMenu !== null && <div className="menu-backdrop" role="presentation" onClick={() => setOpenMenu(null)} />}
    {searchOpen && <WorkspaceSearch projects={projects.status === "ready" ? projects.value : []} sessions={defaultSessions.status === "ready" ? defaultSessions.value : []} status={projects.status === "error" || defaultSessions.status === "error" ? "部分摘要加载失败，可在侧栏重试；下方显示已加载结果。" : projects.status === "loading" || defaultSessions.status === "loading" ? "正在加载更多摘要…" : undefined} onClose={() => setSearchOpen(false)} onProject={navigateToNewChat} onSession={navigateToSession} />}
    {teamMembersOpen && <TeamMembersDialog key={browserOwner} projectId={groupId} routerId={browserOwner}
      onClose={() => setTeamMembersRouter(null)} onOpen={(sessionId) => {
        const target = { projectId: groupId, routerId: browserOwner, sessionId }
        browserTags.open(browserOwner, { kind: "team-session", id: JSON.stringify(["team-session", groupId, sessionId]), target })
        teamSessions.open(target)
        setTeamMembersRouter(null)
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('.chat-browser-pane .chat-browser-tab-item[data-active="true"] > button')?.focus()
        })
      }} />}
    {sidebarMenu && createPortal(<>
      <div className="menu-backdrop sidebar-menu-backdrop" onPointerDown={() => setSidebarMenu(null)} />
      <div ref={sidebarMenuRef} className="selector-menu sidebar-action-menu" role="menu" aria-label="更多操作"
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") {
            event.stopPropagation()
            if (event.key === "Escape") event.preventDefault()
            sidebarMenu.anchor.focus()
            setSidebarMenu(null)
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault()
            const items = Array.from(event.currentTarget.querySelectorAll("button"))
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
              : (index + items.length + (event.key === "ArrowDown" ? 1 : -1)) % items.length
            items[next]?.focus()
          }
        }}>
        {sidebarMenu.target.sessionId === undefined && <button type="button" role="menuitem" onClick={() => openSidebarDialog("directories")}>设置关联目录</button>}
        {sidebarMenu.target.sessionId === undefined && <button type="button" role="menuitem" onClick={() => { const projectId = sidebarMenu.target.projectId; setSidebarMenu(null); focusNewChatComposer(projectId, "work") }}>新建团队会话</button>}
        <button type="button" role="menuitem" onClick={() => openSidebarDialog("rename")}>重命名</button>
        {sidebarMenu.target.sessionId !== undefined && <button type="button" role="menuitem" onClick={() => void copySidebarConversation()}>复制对话</button>}
      </div>
    </>, document.body)}
    {sidebarDialog && <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !sidebarBusy) setSidebarDialog(null)
    }}>
      <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="sidebar-dialog-title"
        aria-busy={sidebarBusy} ref={sidebarDialogRef} tabIndex={-1} onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.stopPropagation()
            if (!sidebarBusy) setSidebarDialog(null)
          }
        }}>
        <header className="project-dialog-header">
          <h2 id="sidebar-dialog-title">{sidebarDialog.kind === "directories" ? "设置关联目录" : sidebarDialog.target.sessionId === undefined ? "重命名项目" : "重命名对话"}</h2>
          <button type="button" className="project-dialog-close" aria-label="关闭" disabled={sidebarBusy} onClick={() => setSidebarDialog(null)}><IconX size={20} aria-hidden="true" /></button>
        </header>
        {sidebarDialog.kind === "rename" ? <form className="project-dialog-form" onSubmit={(event) => { event.preventDefault(); void renameSidebarTarget() }}>
          <div className="project-dialog-field">
            <label htmlFor="sidebar-target-name">名称</label>
            <div className="project-name-input"><input id="sidebar-target-name" data-dialog-autofocus value={sidebarName} disabled={sidebarBusy} onChange={(event) => setSidebarName(event.target.value)} /></div>
          </div>
          {sidebarError && <p className="project-dialog-error" role="alert">{sidebarError}</p>}
          <footer className="project-dialog-footer">
            <button type="button" className="settings-secondary-button" disabled={sidebarBusy} onClick={() => setSidebarDialog(null)}>取消</button>
            <button type="submit" className="create-project-button" disabled={sidebarBusy || !sidebarName.trim()}>保存</button>
          </footer>
        </form> : <div className="project-dialog-form">
          <p className="project-dialog-description">首个关联目录用作工作目录。没有关联目录时使用内置工作区。</p>
          <div className="project-directory-list">
            {(projects.status === "ready" ? projects.value.find((project) => project.projectId === sidebarDialog.target.projectId)?.directories ?? [] : []).map((directory) =>
              <div className="project-directory-row" key={directory} title={directory}>
                <span className="project-directory-name">{directory}</span>
                <button type="button" className="project-directory-remove" aria-label={`移除目录 ${directory}`} disabled={sidebarBusy}
                  onClick={() => void changeSidebarDirectory(directory)}><IconX size={16} aria-hidden="true" /></button>
              </div>)}
            <button type="button" className="project-directory-add" data-dialog-autofocus disabled={sidebarBusy} onClick={() => void changeSidebarDirectory()}>
              <IconPlus size={16} aria-hidden="true" /> 添加目录
            </button>
          </div>
          {sidebarError && <p className="project-dialog-error" role="alert">{sidebarError}</p>}
        </div>}
      </section>
    </div>}
    {copyStatus && <div className="sidebar-copy-status" role={copyStatus.error ? "alert" : "status"}>{copyStatus.text}</div>}
    {projectDialogOpen && <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeProjectDialog() }}>
      <section ref={projectDialogRef} tabIndex={-1} className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" aria-busy={creatingProject || selectingProjectDirectory}>
        <header className="project-dialog-header">
          <div><p className="settings-eyebrow">一个专注的起点</p><h2 id="project-dialog-title">创建项目</h2></div>
          <button className="project-dialog-close" type="button" aria-label="关闭" disabled={creatingProject} onClick={closeProjectDialog}><IconX size={20} stroke={1.5} aria-hidden="true" /></button>
        </header>
        <p className="project-dialog-description">将相关代码与对话放在一起，让每次协作都有上下文。</p>
        <form className="project-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitProjectCreation() }}>
          <div className="project-dialog-field">
            <label htmlFor="project-name">项目名称</label>
            <div className="project-name-input">
              <IconFolder size={24} stroke={1.5} aria-hidden="true" />
              <input
                id="project-name"
                type="text"
                data-dialog-autofocus
                placeholder="请输入项目名称"
                value={projectName}
                disabled={creatingProject}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </div>
          </div>
          <div className="project-dialog-field">
            <label id="project-directory-label">源文件夹 <span className="optional-label">可选</span></label>
            {projectDirectories.length === 0
              ? <button
                  className="project-directory-empty"
                  type="button"
                  disabled={selectingProjectDirectory || creatingProject}
                  onClick={() => { void selectProjectDirectory() }}
                >
                  <IconFolderPlus size={24} stroke={1.5} aria-hidden="true" />
                  <span>添加 NiCode 可读取和编辑的文件夹</span>
                </button>
              : <div className="project-directory-list" role="group" aria-labelledby="project-directory-label" aria-busy={selectingProjectDirectory || creatingProject}>
                  {projectDirectories.map((directory) => <div className="project-directory-row" key={directory.path} title={directory.path}>
                    <IconFolder size={20} stroke={1.5} aria-hidden="true" />
                    <span className="project-directory-name">{directory.name}</span>
                    <button
                      className="project-directory-remove"
                      type="button"
                      aria-label={`移除文件夹 ${directory.name}`}
                      title="移除文件夹"
                      disabled={selectingProjectDirectory || creatingProject}
                      onClick={() => removeProjectDirectory(directory.path)}
                    >
                      <IconX size={17} stroke={1.5} aria-hidden="true" />
                    </button>
                  </div>)}
                  <button
                    className="project-directory-add"
                    type="button"
                    aria-label="添加文件夹"
                    disabled={selectingProjectDirectory || creatingProject}
                    onClick={() => { void selectProjectDirectory() }}
                  >
                    <IconFolderPlus size={20} stroke={1.5} aria-hidden="true" />
                    <span>{selectingProjectDirectory ? "正在打开目录选择器…" : "添加文件夹"}</span>
                  </button>
                </div>}
          </div>
          {projectDialogError !== null && <p className="project-dialog-error" role="alert">{projectDialogError}</p>}
          <footer className="project-dialog-footer">
            <button className="settings-secondary-button" type="button" disabled={creatingProject} onClick={closeProjectDialog}>取消</button>
            <button className="create-project-button" type="submit" disabled={projectName.trim() === "" || creatingProject || selectingProjectDirectory}>
              {creatingProject ? "正在创建…" : "创建项目"}
            </button>
          </footer>
        </form>
      </section>
    </div>}
    {settingsDialogOpen && <SettingsDialog
      initialSection={settingsSection}
      onClose={closeSettingsDialog}
      onProvidersChange={(value) => setProviders({ status: "ready", value })}
      projects={projects}
      onReloadProjects={() => { void loadProjects() }}
      skillsByScope={skillsByScope}
      onSkillsChange={setSkillsByScope}
    />}
  </div>
}

/**
 * 安装 Electron 使用的 hash 路由，保留新聊天页并增加 Project / Session 参数页。
 * @returns 包含工作区布局及其页面路由的 Router。
 */
function App() {
  return <HashRouter>
    <Routes>
      <Route path="/" element={<Workspace />}>
        <Route path="default/new-chat" element={null} />
        <Route path="projects/:projectId/new-chat" element={null} />
        <Route path="sessions/:projectId/:sessionId" element={<SessionRoute />} />
        <Route path="*" element={<Navigate to="/default/new-chat" replace />} />
      </Route>
    </Routes>
  </HashRouter>
}

const root = document.getElementById("root")
if (root === null) throw new Error("缺少工作区页面根节点")
createRoot(root).render(<App />)
