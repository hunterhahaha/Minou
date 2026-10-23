/** Electron 工作区：读取启动摘要，并由 hash 路由管理工作区与 Session 身份。 */
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter, Navigate, Outlet, Route, Routes, useMatch, useNavigate, useParams, useOutletContext } from "react-router"
import {
  IconChevronDown,
  IconFolder,
  IconFolderPlus,
  IconFolders,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMessageCirclePlus,
  IconMessages,
  IconPencilPlus,
  IconPlus,
  IconSettings,
  IconX,
  IconArrowUpRight,
  IconArrowUp,
  IconCpu,
  IconMessage,
  IconMoon,
  IconSearch,
  IconShieldCheck,
  IconSparkles,
  IconSun,
  IconTerminal2,
  IconTool,
} from "@tabler/icons-react"
import type { DirectorySelection, ProjectSummary, ProviderSummary, SessionSummary } from "../preload/session-api.ts"
import { SettingsDialog } from "./settings-dialog.tsx"
import type { SkillCache } from "./skill-settings.tsx"
import { WorkspaceSessionState, sessionKey, errorMessage } from "./session-state.ts"
import { SessionPage } from "./session-page.tsx"
import { WorkspaceSearch } from "./workspace-search.tsx"
import { useDialogFocus } from "./dialog-focus.tsx"
import { ComposerInput } from "./composer-input.tsx"
import { WindowControls } from "./window-controls.tsx"
import "./workspace.css"

/** 一项启动数据的加载、成功或失败状态。 */
type LoadState<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error" }
/** 当前页面及其工作区范围；Session 页面同时携带 Project 和 Session 身份。 */
type WorkspaceRoute =
  | { page: "new-chat"; group: "default" }
  | { page: "new-chat"; group: "project"; projectId: string }
  | { page: "session"; group: "default"; sessionId: string }
  | { page: "session"; group: "project"; projectId: string; sessionId: string }
/** 本页可切换的权限展示状态；对话创建前仅保存在渲染进程。 */
type Permission = "default" | "workspace-read-only" | "workspace-read-write" | "full-access"
const permissionLabels: Record<Permission, string> = {
  default: "默认", "workspace-read-only": "工作区只读",
  "workspace-read-write": "工作区读写", "full-access": "完全访问",
}
const permissionOptions: Permission[] = ["workspace-read-only", "workspace-read-write", "full-access"]

/**
 * 按持久化索引顺序显示一个分组的对话入口，并把所在分组与 Session 身份交给路由。
 * @param props 已取得的对话摘要列表。
 * @returns 可打开各 Session 路由的对话列表。
 */
function SessionList({
  projectId,
  sessions,
  activeSessionId,
  onOpenSession,
}: {
  projectId: string
  sessions: SessionSummary[]
  activeSessionId?: string
  onOpenSession: (projectId: string, sessionId: string) => void
}) {
  return <ul className="session-list">{sessions.map((session) =>
    <li key={session.sessionId}>
      <button
        className="session-name"
        type="button"
        title={session.name}
        aria-current={session.sessionId === activeSessionId ? "page" : undefined}
        onClick={() => onOpenSession(projectId, session.sessionId)}
      >
        <IconMessage size={15} stroke={1.6} aria-hidden="true" /><span>{session.name}</span>
      </button>
    </li>,
  )}</ul>
}

/**
 * 从匹配到的 Session 路由读取 Project 与 Session 身份，供后续对话页面使用。
 * @returns 优先读取工作区字典，仅缺键时发起历史加载的聊天页面。
 */
function SessionRoute() {
  const { projectId, sessionId } = useParams<"projectId" | "sessionId">()
  const { state, providers } = useOutletContext<{ state: WorkspaceSessionState; providers: ProviderSummary[] }>()
  useEffect(() => {
    if (projectId === undefined || sessionId === undefined) return
    if (state.has(sessionKey(projectId, sessionId))) return
    void state.load(projectId, sessionId).catch(() => {})
  }, [state, projectId, sessionId])
  if (projectId === undefined || sessionId === undefined) return null
  return <SessionPage projectId={projectId} sessionId={sessionId} state={state} providers={providers} />
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
  const newDraftKey = sessionKey(groupId, "$new-chat")
  const newChatView = sessionsState.view(newDraftKey)
  const [selectedModelKey, setSelectedModelKey] = useState<string | undefined>()
  const [permission, setPermission] = useState<Permission>("default")
  const [openMenu, setOpenMenu] = useState<"permission" | "model" | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [chatsOpen, setChatsOpen] = useState(true)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const createdProjectsRef = useRef<ProjectSummary[]>([])
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [projectDirectories, setProjectDirectories] = useState<DirectorySelection[]>([])
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null)
  const [selectingProjectDirectory, setSelectingProjectDirectory] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [focusComposerAfterNavigation, setFocusComposerAfterNavigation] = useState(false)
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

  /** @param projectId 要刷新的摘要分组；不重查聊天历史。 @returns 摘要更新完成。 */
  async function refreshSessionSummaries(projectId: string): Promise<void> {
    try {
      if (projectId === "default") setDefaultSessions({ status: "ready", value: await window.nicode.listDefaultSessions() })
      else setProjects({ status: "ready", value: await window.nicode.listProjects() })
    } catch (error) { console.error("更新对话列表失败", error) }
  }
  useEffect(() => window.nicode.onSessionUpdate((update) => {
    try { sessionsState.receive(update) }
    catch (error) { sessionsState.setView(sessionKey(update.projectId, update.sessionId), { operationError: errorMessage(error) }) }
    if (update.kind === "event" && update.event.type === "turn/end") void refreshSessionSummaries(update.projectId)
  }), [sessionsState])

  /** @returns 项目查询结束后的 Promise；失败会转成当前区域的错误状态。 */
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
      setProjects({ status: "ready", value })
      setExpandedProjects(new Set(value.length > 0 ? [value[0].projectId] : []))
    } catch (error) {
      console.error("加载项目列表失败", error)
      setProjects({ status: "error" })
    }
  }

  /** @returns default 对话查询结束后的 Promise；失败会转成当前区域的错误状态。 */
  async function loadDefaultSessions(): Promise<void> {
    setDefaultSessions({ status: "loading" })
    try {
      setDefaultSessions({ status: "ready", value: await window.nicode.listDefaultSessions() })
    } catch (error) {
      console.error("加载 default 对话列表失败", error)
      setDefaultSessions({ status: "error" })
    }
  }

  /** @returns Provider 查询结束后的 Promise；失败会转成当前区域的错误状态。 */
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
   * @returns 导航完成时无返回值。
   */
  function navigateToNewChat(projectId?: string): void {
    setOpenMenu(null)
    navigate(projectId === undefined
      ? "/default/new-chat"
      : `/projects/${encodeURIComponent(projectId)}/new-chat`)
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
   * 切换到指定分组的新聊天并聚焦任务输入框。
   * @param projectId 指定时使用该项目；省略时使用 default 分组。
   * @returns 输入框获得焦点时无返回值；已有草稿保持不变。
   */
  function focusNewChatComposer(projectId?: string): void {
    setFocusComposerAfterNavigation(true)
    navigateToNewChat(projectId)
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
    /** @param event 应用快捷键仅在没有业务弹窗时处理，输入法组合期间不导航。 */
    function workspaceShortcut(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.isComposing || document.querySelector('[aria-modal="true"]')) return
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setOpenMenu(null); setSearchOpen(true) }
      if (event.key.toLowerCase() === "b") { event.preventDefault(); setSidebarOpen((current) => !current) }
      if (event.key.toLowerCase() === "o" && event.shiftKey) { event.preventDefault(); focusNewChatComposer(groupId === "default" ? undefined : groupId) }
      if (event.key === ",") { event.preventDefault(); openSettingsDialog() }
    }
    window.addEventListener("keydown", workspaceShortcut)
    return () => window.removeEventListener("keydown", workspaceShortcut)
  }, [groupId])

  useEffect(() => {
    if (!focusComposerAfterNavigation || workspaceRoute.page !== "new-chat") return
    if (!document.querySelector('[aria-modal="true"]')) composerRef.current?.focus()
    setFocusComposerAfterNavigation(false)
  }, [focusComposerAfterNavigation, workspaceRoute.page])

  useEffect(() => {
    if (openMenu === null) return
    /** @param event 键盘事件；Escape 关闭当前弹层。 */
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpenMenu(null)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [openMenu])

  useEffect(() => {
    if (!projectDialogOpen) return
    /** @param event 键盘事件；Escape 在提交期间不关闭弹窗。 */
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
  const defaultModel = modelOptions.find((model) => model.isDefault)
  const selectedModel = modelOptions.find((model) => model.selectionKey === selectedModelKey) ?? defaultModel
  const activeProject = workspaceRoute.group === "project" && projects.status === "ready"
    ? projects.value.find((project) => project.projectId === workspaceRoute.projectId)
    : undefined
  const currentSessions = groupId === "default"
    ? defaultSessions.status === "ready" ? defaultSessions.value : []
    : activeProject?.sessions ?? []
  const currentSession = workspaceRoute.page === "session" ? currentSessions.find((session) => session.sessionId === workspaceRoute.sessionId) : undefined
  const runningCount = Object.values(sessionsState.sessionViewsByKey).filter((view) => view.control?.phase === "running" || view.control?.phase === "stopping").length

  /** @returns 新对话首批事件提交后清理当前分组草稿并导航；失败保留草稿。 */
  async function sendNewChat(): Promise<void> {
    const text = sessionsState.draftsByKey[newDraftKey] ?? ""
    if (!text.trim() || !selectedModel || sessionsState.view(newDraftKey).busy) return
    sessionsState.setView(newDraftKey, { busy: true, operationError: undefined })
    try {
      const { providerId, protocol, modelId, name } = selectedModel
      const response = await window.nicode.startNewSession(groupId, {
        content: [{ type: "text", text }], model: { providerId, protocol, modelId, name },
        sandboxMode: permission === "workspace-read-only" ? "sandbox-read-only" : permission === "full-access" ? "full-access" : "sandbox-full-access",
      })
      if (sessionsState.draftsByKey[newDraftKey] === text) sessionsState.setDraft(newDraftKey, "")
      void refreshSessionSummaries(groupId)
      navigateToSession(groupId, response.sessionId)
    } catch (error) { sessionsState.setView(newDraftKey, { operationError: errorMessage(error) }) }
    finally { sessionsState.setView(newDraftKey, { busy: false }) }
  }

  return <div className="app-shell">
    <header className="titlebar">
      <div className="titlebar-brand"><span className="brand-mark" aria-hidden="true"><IconTerminal2 size={17} stroke={2} /></span><span className="brand-name">NiCode</span><span className="titlebar-label">工作台</span></div>
      <button className="titlebar-search" type="button" disabled={settingsDialogOpen || projectDialogOpen || searchOpen} onClick={() => setSearchOpen(true)} aria-label="搜索工作区"><IconSearch size={14} /><span>搜索项目和对话</span><kbd>Ctrl K</kbd></button>
      <WindowControls />
    </header>
    <div className="workspace-shell">
      <nav className="activity-rail" aria-label="主导航">
        <button className="rail-button rail-button-active" aria-label="对话工作台" title="对话工作台" type="button" onClick={() => { setSidebarOpen(true); focusNewChatComposer() }}><IconMessages size={21} stroke={1.6} /></button>
        <button className="rail-button" aria-label="查看项目" title="查看项目" type="button" onClick={() => { setSidebarOpen(true); setProjectsOpen(true); requestAnimationFrame(() => document.querySelector<HTMLElement>('.project-section .section-heading')?.focus()) }}><IconFolders size={21} stroke={1.6} /></button>
        <div className="rail-divider" />
        <button className="rail-button" aria-label="技能设置" title="技能" type="button" onClick={() => openSettingsDialog("skills")}><IconSparkles size={21} stroke={1.6} /></button>
        <button className="rail-button" aria-label="MCP 设置" title="工具连接" type="button" onClick={() => openSettingsDialog("mcp")}><IconTool size={21} stroke={1.6} /></button>
        <div className="rail-bottom">
          <button className="rail-button" type="button" aria-label={theme === "light" ? "切换深色外观" : "切换浅色外观"} title={theme === "light" ? "深色外观" : "浅色外观"} onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}>{theme === "light" ? <IconMoon size={20} stroke={1.6} /> : <IconSun size={20} stroke={1.6} />}</button>
          <button className="rail-button sidebar-settings" type="button" aria-label="设置" title="设置 · Ctrl ," onClick={() => openSettingsDialog()}><IconSettings size={21} stroke={1.6} /></button>
          <span className="local-avatar" title="本地工作空间">N</span>
        </div>
      </nav>
      {sidebarOpen && <aside className="sidebar" aria-label="工作区侧栏">
        <div className="workspace-identity"><span className="workspace-avatar"><IconTerminal2 size={20} stroke={1.6} /></span><div><strong>我的工作空间</strong><span><i className="status-dot" />本地运行</span></div><button type="button" className="sidebar-toggle" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}><IconLayoutSidebarLeftCollapse size={17} /></button></div>
        <button className="new-chat" type="button" aria-current={workspaceRoute.page === "new-chat" && workspaceRoute.group === "default" ? "page" : undefined} onClick={() => focusNewChatComposer()}><IconMessageCirclePlus size={18} stroke={1.7} /><span>新聊天</span><kbd>Ctrl ⇧ O</kbd></button>
        <button className="sidebar-search" type="button" onClick={() => setSearchOpen(true)}><IconSearch size={16} /><span>搜索工作区</span><kbd>Ctrl K</kbd></button>
        <div className="sidebar-scroll">
          <section className="sidebar-section project-section" aria-label="项目">
            <div className="section-heading-row">
              <button className="section-heading" type="button" aria-expanded={projectsOpen} onClick={() => setProjectsOpen((current) => !current)}><span>项目</span>{projects.status === "ready" && <span className="section-count">{projects.value.length}</span>}<span className={projectsOpen ? "chevron" : "chevron collapsed"}><IconChevronDown size={12} /></span></button>
              <button className="section-action section-action-button" type="button" aria-label="创建项目" title="创建项目" onClick={openProjectDialog}><IconPlus size={16} /></button>
            </div>
            {projectsOpen && <><DataStatus state={projects} retry={() => { void loadProjects() }} />
              {projects.status === "ready" && (projects.value.length === 0
                ? <button className="sidebar-empty" type="button" onClick={openProjectDialog}><IconFolderPlus size={23} /><strong>为想法建立一个空间</strong><span>创建项目，连接你的代码</span></button>
                : <ul className="project-list">{projects.value.map((project) => <li key={project.projectId}>
                    <div className={workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? "project-row project-row-active" : "project-row"}>
                      <button className="project-name" type="button" title={project.name} aria-expanded={expandedProjects.has(project.projectId)} aria-current={workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? "page" : undefined} onClick={() => toggleProject(project.projectId)}><IconFolder size={17} stroke={1.6} /><span>{project.name}</span><IconChevronDown className={expandedProjects.has(project.projectId) ? "project-chevron" : "project-chevron collapsed"} size={12} /></button>
                      <button className="project-action-button" type="button" aria-label={`在 ${project.name} 中新建聊天`} title={`在 ${project.name} 中新建聊天`} onClick={() => focusNewChatComposer(project.projectId)}><IconPencilPlus size={16} /></button>
                    </div>
                    {expandedProjects.has(project.projectId) && <div className="project-sessions"><SessionList projectId={project.projectId} sessions={project.sessions} activeSessionId={workspaceRoute.page === "session" && workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? workspaceRoute.sessionId : undefined} onOpenSession={navigateToSession} />
                      {project.sessions.length === 0 && <button className="project-first-chat" type="button" onClick={() => focusNewChatComposer(project.projectId)}>开始第一段对话 <IconArrowUpRight size={12} /></button>}
                    </div>}
                  </li>)}</ul>)}
            </>}
          </section>
          <section className="sidebar-section chats-section" aria-label="聊天">
            <div className="section-heading-row">
              <button className="section-heading" type="button" aria-expanded={chatsOpen} onClick={() => setChatsOpen((current) => !current)}><span>独立对话</span>{defaultSessions.status === "ready" && <span className="section-count">{defaultSessions.value.length}</span>}<span className={chatsOpen ? "chevron" : "chevron collapsed"}><IconChevronDown size={12} /></span></button>
              <button className="section-action section-action-button" type="button" aria-label="新建聊天" title="新建聊天" onClick={() => focusNewChatComposer()}><IconPencilPlus size={16} /></button>
            </div>
            {chatsOpen && <><DataStatus state={defaultSessions} retry={() => { void loadDefaultSessions() }} />
              {defaultSessions.status === "ready" && (defaultSessions.value.length === 0 ? <p className="empty-list">你的下一段对话，从这里开始。</p> : <SessionList projectId="default" sessions={defaultSessions.value} activeSessionId={workspaceRoute.page === "session" && workspaceRoute.group === "default" ? workspaceRoute.sessionId : undefined} onOpenSession={navigateToSession} />)}
            </>}
          </section>
        </div>
      </aside>}
      <main className="main-panel">
        <header className="panel-header">
          {!sidebarOpen && <button className="settings-icon-button" type="button" aria-label="展开侧栏" onClick={() => setSidebarOpen(true)}><IconLayoutSidebarLeftExpand size={18} /></button>}
          <div className="breadcrumb"><span>{activeProject?.name ?? "工作空间"}</span><span className="breadcrumb-divider">/</span><strong title={currentSession?.name}>{workspaceRoute.page === "new-chat" ? "新聊天" : currentSession?.name ?? "对话"}</strong></div>
          <div className="panel-header-actions"><span className="workspace-badge"><IconFolder size={13} />{activeProject ? "项目空间" : "独立空间"}</span>{workspaceRoute.page === "session" && <button className="settings-icon-button" type="button" aria-label="在当前空间新建聊天" title="新聊天" onClick={() => focusNewChatComposer(groupId === "default" ? undefined : groupId)}><IconPencilPlus size={18} /></button>}</div>
        </header>
        {workspaceRoute.page === "session" ? <Outlet context={{ state: sessionsState, providers: providers.status === "ready" ? providers.value : [] }} /> : <div className="welcome-scroll"><div className="welcome">
          <div className="welcome-intro"><h1>有什么想一起完成？</h1>{activeProject && <p className="welcome-project" title={activeProject.directories.join(" · ")}><IconFolder size={14} />{activeProject.name}</p>}</div>
          {newChatView.operationError && <p className="chat-error" role="alert">{newChatView.operationError}</p>}
          <div className="composer new-chat-composer">
            <ComposerInput inputRef={composerRef} aria-label="任务描述" placeholder="描述你想做的事，剩下的一起完成…" value={sessionsState.draftsByKey[newDraftKey] ?? ""} onChange={(event) => sessionsState.setDraft(newDraftKey, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendNewChat() } }} />
            <div className="composer-toolbar">
              <div className="composer-controls">
                <div className="selector-anchor"><button className="selector-trigger" type="button" aria-label="权限" aria-haspopup="menu" aria-expanded={openMenu === "permission"} onClick={() => setOpenMenu((current) => current === "permission" ? null : "permission")}><IconShieldCheck size={15} />{permission === "default" ? "工作区读写" : permissionLabels[permission]}<IconChevronDown size={12} /></button>
                  {openMenu === "permission" && <div className="selector-menu permission-menu" role="menu" aria-label="权限选项"><p className="menu-label">允许 NiCode 做什么</p>{permissionOptions.map((option) => <button type="button" role="menuitemradio" aria-checked={permission === option || (permission === "default" && option === "workspace-read-write")} key={option} onClick={() => { setPermission(option); setOpenMenu(null) }}>{permissionLabels[option]}{(permission === option || (permission === "default" && option === "workspace-read-write")) && <span aria-hidden="true">✓</span>}</button>)}</div>}
                </div>
              </div>
              <div className="composer-controls composer-controls-right">
                {providers.status === "loading" && <span className="model-status" role="status">模型加载中…</span>}
                {providers.status === "error" && <span className="model-status" role="alert">模型加载失败 <button className="retry-button" type="button" onClick={() => { void loadProviders() }}>重试</button></span>}
                {providers.status === "ready" && (modelOptions.length === 0 ? <button className="selector-trigger setup-model-trigger" type="button" onClick={() => openSettingsDialog()}><IconCpu size={15} />配置模型<IconArrowUpRight size={12} /></button>
                  : <div className="selector-anchor model-anchor"><button className="selector-trigger model-trigger" type="button" aria-label="模型" aria-haspopup="menu" aria-expanded={openMenu === "model"} title={`${selectedModel?.providerName} / ${selectedModel?.name}`} onClick={() => setOpenMenu((current) => current === "model" ? null : "model")}><IconCpu size={15} /><span>{selectedModel?.name}</span><IconChevronDown size={12} /></button>
                    {openMenu === "model" && <div className="selector-menu model-menu" role="menu" aria-label="模型选项"><p className="menu-label">选择模型</p>{modelOptions.map((model) => <button type="button" role="menuitemradio" aria-checked={model.selectionKey === selectedModel?.selectionKey} key={model.selectionKey} title={`${model.providerName} / ${model.name}`} onClick={() => { setSelectedModelKey(model.selectionKey); setOpenMenu(null) }}><span><strong>{model.name}</strong><small>{model.providerName}</small></span>{model.selectionKey === selectedModel?.selectionKey && <span aria-hidden="true">✓</span>}</button>)}</div>}</div>)}
                <button className="send-button" type="button" disabled={!selectedModel || newChatView.busy || !(sessionsState.draftsByKey[newDraftKey] ?? "").trim()} onClick={() => void sendNewChat()} aria-label="发送消息"><IconArrowUp size={18} stroke={2} /></button>
              </div>
            </div>
          </div>
          <div className="composer-caption"><span>Enter 发送 · Shift + Enter 换行</span></div>
        </div></div>}
      </main>
    </div>
    <footer className="app-statusbar"><span><i className="status-dot" />{runningCount > 0 ? `${runningCount} 个对话运行中` : "本地工作台"}</span></footer>
    {openMenu !== null && <div className="menu-backdrop" role="presentation" onClick={() => setOpenMenu(null)} />}
    {searchOpen && <WorkspaceSearch projects={projects.status === "ready" ? projects.value : []} sessions={defaultSessions.status === "ready" ? defaultSessions.value : []} status={projects.status === "error" || defaultSessions.status === "error" ? "部分摘要加载失败，可在侧栏重试；下方显示已加载结果。" : projects.status === "loading" || defaultSessions.status === "loading" ? "正在加载更多摘要…" : undefined} onClose={() => setSearchOpen(false)} onProject={navigateToNewChat} onSession={navigateToSession} />}
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
