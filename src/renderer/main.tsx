/** Electron 工作区：读取启动摘要，并由 hash 路由管理工作区与 Session 身份。 */
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter, Navigate, Outlet, Route, Routes, useMatch, useNavigate, useParams } from "react-router"
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
  IconSend,
  IconSettings,
  IconX,
} from "@tabler/icons-react"
import type { DirectorySelection, ProjectSummary, ProviderSummary, SessionSummary } from "../preload/session-api.ts"
import { SettingsDialog } from "./settings-dialog.tsx"
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
        {session.name}
      </button>
    </li>,
  )}</ul>
}

/**
 * 从匹配到的 Session 路由读取 Project 与 Session 身份，供后续对话页面使用。
 * @returns 保存路由身份的空页面容器；不读取或渲染 Session 内容。
 */
function SessionRoute() {
  const { projectId, sessionId } = useParams<"projectId" | "sessionId">()
  if (projectId === undefined || sessionId === undefined) return null
  return <div data-project-id={projectId} data-session-id={sessionId} />
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
   * 打开设置弹窗
   * @returns 无返回值
   */
  function openSettingsDialog(): void {
    setOpenMenu(null)
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
    if (!focusComposerAfterNavigation || workspaceRoute.page !== "new-chat") return
    composerRef.current?.focus()
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

  return <div className="app-shell">
    <header className="titlebar">
      <div className="brand-mark" aria-hidden="true">N</div>
      <span className="brand-name">NiCode</span>
      <button className="sidebar-toggle" type="button" aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"} aria-pressed={!sidebarOpen} onClick={() => setSidebarOpen((current) => !current)}>{sidebarOpen ? <IconLayoutSidebarLeftCollapse size={16} stroke={1.5} aria-hidden="true" /> : <IconLayoutSidebarLeftExpand size={16} stroke={1.5} aria-hidden="true" />}</button>
      <nav className="titlebar-menu" aria-label="应用菜单"><span>文件</span><span>编辑</span><span>视图</span><span>帮助</span></nav>
    </header>

    <div className="workspace-shell">
      {sidebarOpen && <aside className="sidebar" aria-label="工作区侧栏">
        <button className="new-chat" type="button" aria-current={workspaceRoute.page === "new-chat" && workspaceRoute.group === "default" ? "page" : undefined} onClick={() => focusNewChatComposer()}><IconMessageCirclePlus size={18} stroke={1.5} aria-hidden="true" /><span>新聊天</span></button>
        <div className="sidebar-scroll">
          <section className="sidebar-section" aria-label="项目">
            <div className="section-heading-row">
              <button className="section-heading" type="button" aria-expanded={projectsOpen} onClick={() => setProjectsOpen((current) => !current)}><IconFolders size={18} stroke={1.5} aria-hidden="true" /><span>项目</span><span className={projectsOpen ? "chevron" : "chevron collapsed"}><IconChevronDown size={14} stroke={1.5} aria-hidden="true" /></span></button>
              <button className="section-action section-action-button" type="button" aria-label="创建项目" title="创建项目" onClick={openProjectDialog}><IconPlus size={18} stroke={1.5} aria-hidden="true" /></button>
            </div>
            {projectsOpen && <><DataStatus state={projects} retry={() => { void loadProjects() }} />
              {projects.status === "ready" && (projects.value.length === 0
                ? <p className="empty-list">暂无项目</p>
                : <ul className="project-list">{projects.value.map((project) => <li key={project.projectId}>
                    <div className={workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? "project-row project-row-active" : "project-row"}>
                      <button className="project-name" type="button" title={project.name} aria-expanded={expandedProjects.has(project.projectId)} aria-current={workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? "page" : undefined} onClick={() => toggleProject(project.projectId)}><IconFolder size={17} stroke={1.5} aria-hidden="true" /><span>{project.name}</span></button>
                      <button className="project-action-button" type="button" aria-label={`在 ${project.name} 中新建聊天`} title={`在 ${project.name} 中新建聊天`} onClick={() => focusNewChatComposer(project.projectId)}><IconPencilPlus size={16} stroke={1.5} aria-hidden="true" /></button>
                    </div>
                    {expandedProjects.has(project.projectId) && <SessionList
                      projectId={project.projectId}
                      sessions={project.sessions}
                      activeSessionId={workspaceRoute.page === "session" && workspaceRoute.group === "project" && workspaceRoute.projectId === project.projectId ? workspaceRoute.sessionId : undefined}
                      onOpenSession={navigateToSession}
                    />}
                  </li>)}</ul>)}
            </>}
          </section>

          <section className="sidebar-section chats-section" aria-label="聊天">
            <div className="section-heading-row">
              <button className="section-heading" type="button" aria-expanded={chatsOpen} onClick={() => setChatsOpen((current) => !current)}>
                <IconMessages size={18} stroke={1.5} aria-hidden="true" />
                <span>聊天</span>
                <span className={chatsOpen ? "chevron" : "chevron collapsed"}><IconChevronDown size={14} stroke={1.5} aria-hidden="true" /></span>
              </button>
              <button className="section-action section-action-button" type="button" aria-label="新建聊天" title="新建聊天" onClick={() => focusNewChatComposer()}>
                <IconPencilPlus size={18} stroke={1.5} aria-hidden="true" />
              </button>
            </div>
            {chatsOpen && <><DataStatus state={defaultSessions} retry={() => { void loadDefaultSessions() }} />
              {defaultSessions.status === "ready" && (defaultSessions.value.length === 0
                ? <p className="empty-list">暂无聊天</p>
                : <SessionList
                    projectId="default"
                    sessions={defaultSessions.value}
                    activeSessionId={workspaceRoute.page === "session" && workspaceRoute.group === "default" ? workspaceRoute.sessionId : undefined}
                    onOpenSession={navigateToSession}
                  />)}
            </>}
          </section>
        </div>
        <button className="sidebar-settings" type="button" onClick={openSettingsDialog}><IconSettings size={18} stroke={1.5} aria-hidden="true" /><span>设置</span></button>
      </aside>}

      <main className="main-panel">
        <div className="breadcrumb">
          <span>NiCode</span><span className="breadcrumb-divider">/</span>
          {workspaceRoute.group === "project" && <><strong>{activeProject?.name ?? "项目"}</strong><span className="breadcrumb-divider">/</span></>}
          <strong>{workspaceRoute.page === "new-chat" ? "新聊天" : "对话"}</strong>
        </div>
        <div className="more-actions" aria-hidden="true">···</div>
        {workspaceRoute.page === "session" ? <Outlet /> : <div className="welcome">
          <h1>我们从哪开始？</h1>
          <div className="composer">
            <textarea ref={composerRef} aria-label="任务描述" placeholder="描述你希望 NiCode 完成的任务…" />
            <div className="composer-toolbar">
              <div className="composer-controls">
                <span className="attachment-control" aria-disabled="true"><IconPlus size={15} stroke={1.5} aria-hidden="true" /><span>附加文件</span></span>
                <div className="selector-anchor">
                  <button className="selector-trigger" type="button" aria-label="权限" aria-haspopup="menu" aria-expanded={openMenu === "permission"} onClick={() => setOpenMenu((current) => current === "permission" ? null : "permission")}>权限：{permissionLabels[permission]} <span className="small-chevron">⌄</span></button>
                  {openMenu === "permission" && <div className="selector-menu permission-menu" role="menu" aria-label="权限选项">{permissionOptions.map((option) => <button type="button" role="menuitemradio" aria-checked={permission === option || (permission === "default" && option === "workspace-read-only")} key={option} onClick={() => { setPermission(option); setOpenMenu(null) }}>{permissionLabels[option]}{(permission === option || (permission === "default" && option === "workspace-read-only")) && <span aria-hidden="true">✓</span>}</button>)}</div>}
                </div>
              </div>
              <div className="composer-controls composer-controls-right">
                {providers.status === "loading" && <span className="model-status" role="status">模型加载中…</span>}
                {providers.status === "error" && <span className="model-status" role="alert">模型加载失败 <button className="retry-button" type="button" onClick={() => { void loadProviders() }}>重试</button></span>}
                {providers.status === "ready" && (modelOptions.length === 0
                  ? <span className="model-status">未配置模型</span>
                  : <div className="selector-anchor model-anchor"><button className="selector-trigger model-trigger" type="button" aria-label="模型" aria-haspopup="menu" aria-expanded={openMenu === "model"} onClick={() => setOpenMenu((current) => current === "model" ? null : "model")}>{selectedModel === undefined ? "未配置模型" : `${selectedModel.providerName} / ${selectedModel.name}`} <span className="small-chevron">⌄</span></button>
                    {openMenu === "model" && <div className="selector-menu model-menu" role="menu" aria-label="模型选项">{modelOptions.map((model) => <button type="button" role="menuitemradio" aria-checked={model.selectionKey === selectedModel?.selectionKey} key={model.selectionKey} title={`${model.providerName} / ${model.name}`} onClick={() => { setSelectedModelKey(model.selectionKey); setOpenMenu(null) }}><span>{model.providerName} / {model.name}</span>{model.selectionKey === selectedModel?.selectionKey && <span aria-hidden="true">✓</span>}</button>)}</div>}</div>)}
                <button className="send-button" type="button" disabled aria-label="发送消息"><IconSend size={16} stroke={1.8} aria-hidden="true" /></button>
              </div>
            </div>
          </div>
        </div>}
      </main>
    </div>
    {openMenu !== null && <div className="menu-backdrop" role="presentation" onClick={() => setOpenMenu(null)} />}
    {projectDialogOpen && <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeProjectDialog() }}>
      <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" aria-busy={creatingProject || selectingProjectDirectory}>
        <header className="project-dialog-header">
          <h2 id="project-dialog-title">创建项目</h2>
          <button className="project-dialog-close" type="button" aria-label="关闭" disabled={creatingProject} onClick={closeProjectDialog}><IconX size={20} stroke={1.5} aria-hidden="true" /></button>
        </header>
        <form className="project-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitProjectCreation() }}>
          <div className="project-dialog-field">
            <label htmlFor="project-name">项目名称</label>
            <div className="project-name-input">
              <IconFolder size={24} stroke={1.5} aria-hidden="true" />
              <input
                id="project-name"
                type="text"
                autoFocus
                placeholder="请输入项目名称"
                value={projectName}
                disabled={creatingProject}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </div>
          </div>
          <div className="project-dialog-field">
            <label id="project-directory-label">源文件夹</label>
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
            <button className="create-project-button" type="submit" disabled={projectName.trim() === "" || creatingProject || selectingProjectDirectory}>
              {creatingProject ? "正在创建…" : "创建项目"}
            </button>
          </footer>
        </form>
      </section>
    </div>}
    {settingsDialogOpen && <SettingsDialog
      onClose={closeSettingsDialog}
      onProvidersChange={(value) => setProviders({ status: "ready", value })}
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
