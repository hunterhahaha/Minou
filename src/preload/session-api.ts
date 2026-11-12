/**
 * Renderer 可调用的 Session 入口与启动页面查询，以及 preload 与主进程之间的 IPC 契约。
 *
 * preload 只暴露窄接口，不把 ipcRenderer 本体交给 Renderer。Runtime 仍运行在主进程；
 * 主进程在首批事件提交后返回可结构化克隆的 sessionId / turn，运行中追加返回入队确认，
 * Stop 返回幂等处理确认；后台事件流与 completion 均不跨 IPC。
 *
 */

import type {
  ContinueSessionInput,
  EnqueueSessionMessageInput,
  EnqueuedSessionMessageResponse,
  StartNewSessionInput,
  SessionRuntimeSnapshot,
} from "../../runtime/agent/src/session-runtime.ts"
import { PROTOCOLS } from "../../runtime/model/src/types.ts"
import type { Protocol, ModelRef, ReasoningField } from "../../runtime/model/src/types.ts"
import { isReasoningField, isReasoningLevels } from "../../runtime/model/src/reasoning.ts"
import type { AssistantBlockStreamEvent, SessionEvent } from "../../runtime/session/src/events.ts"
import type { AppError } from "../../runtime/error/src/types.ts"
import type { MCPConfig, MCPConnection } from "../../runtime/mcp/src/types.ts"
import type { SandboxMode, SessionSettingsPatch } from "../../runtime/session/src/session-state.ts"
import { isProjectId } from "../../runtime/session/src/project-id.ts"
import { isTeamWakeupConfig, type TeamWakeupConfig } from "../../runtime/session/src/team-wakeup-config.ts"
import type { SkillRegistryEntry, SkillSummary, SkillTarget } from "../../runtime/skill/src/index.ts"

export type { SkillRegistryEntry, SkillSummary, SkillTarget }

import type { WebSearchProviderConfig, WebSearchProviderDefinition, WebSearchProviderSaveInput, WebSearchProviderSummary } from "../../runtime/tools/src/web-search/types.ts"
export type { WebSearchProviderConfig, WebSearchProviderDefinition, WebSearchProviderSaveInput, WebSearchProviderSummary }

/** 搜索服务商配置管理的固定通道，不暴露任意 IPC 调用。 */
export const WEB_SEARCH_IPC_CHANNELS = {
  listWebSearchProviderDefinitions: "minou:web-search:definitions",
  listWebSearchProviders: "minou:web-search:list",
  getWebSearchProvider: "minou:web-search:get",
  createWebSearchProvider: "minou:web-search:create",
  updateWebSearchProvider: "minou:web-search:update",
  deleteWebSearchProvider: "minou:web-search:delete",
  setActiveWebSearchProvider: "minou:web-search:set-active",
} as const

/**
 * 检查列表和创建结果，拒绝把请求凭据混入摘要。
 * @param value 主进程返回的未知列表。
 * @returns 独立的无凭据摘要列表。
 * @throws TypeError 身份、名称、启用状态、唯一性或字段集合无效。
 */
function requireWebSearchSummaries(value: unknown): WebSearchProviderSummary[] {
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) &&
      Object.keys(entry).length === 3 && typeof entry.id === "string" && entry.id.trim() !== "" &&
      typeof entry.name === "string" && entry.name.trim() !== "" && typeof entry.enabled === "boolean") ||
      new Set(value.map((entry) => entry.id)).size !== value.length || value.filter((entry) => entry.enabled).length > 1) {
    throw new TypeError("搜索服务商摘要无效。")
  }
  return value.map(({ id, name, enabled }) => ({ id, name, enabled }))
}

/**
 * 检查可序列化预置定义和绑定字段，不包含用户参数值。
 * @param value 主进程返回的未知目录。
 * @returns 独立的服务商定义列表。
 * @throws TypeError 模板、参数元数据或字段路径无效。
 */
function requireWebSearchDefinitions(value: unknown): WebSearchProviderDefinition[] {
  /** @param path 未知路径。 @returns 非空安全字段路径是否有效。 */
  function validPath(path: unknown): boolean {
    return Array.isArray(path) && path.length > 0 && path.every((key) => typeof key === "string" && key !== "" && !["__proto__", "constructor", "prototype"].includes(key))
  }
  if (!Array.isArray(value) || !value.every((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim() || typeof entry.requestJsonTemplate !== "string" ||
        typeof entry.responseJmespath !== "string" || !entry.responseJmespath.trim() || !Array.isArray(entry.parameters)) return false
    try { JSON.parse(entry.requestJsonTemplate) } catch { return false }
    return new Set(entry.parameters.map((field: unknown) => isRecord(field) ? field.key : undefined)).size === entry.parameters.length && entry.parameters.every((field: unknown) =>
      isRecord(field) && typeof field.key === "string" && field.key.trim() !== "" && typeof field.label === "string" && field.label.trim() !== "" &&
      (field.type === "string" || field.type === "positiveInteger") && typeof field.required === "boolean" && typeof field.secret === "boolean" &&
      isRecord(field.target) && validPath(field.target.path) && (field.target.jsonPath === undefined || validPath(field.target.jsonPath)) &&
      (field.target.prefix === undefined || (field.type === "string" && typeof field.target.prefix === "string")) &&
      (field.max === undefined || (Number.isSafeInteger(field.max) && (field.max as number) > 0)) &&
      (field.defaultValue === undefined || (field.type === "string" ? typeof field.defaultValue === "string" :
        Number.isSafeInteger(field.defaultValue) && (field.defaultValue as number) > 0 && (field.max === undefined || (field.defaultValue as number) <= (field.max as number)))))
  }) || new Set(value.map((entry) => entry.name)).size !== value.length) throw new TypeError("搜索服务商目录无效。")
  return structuredClone(value) as WebSearchProviderDefinition[]
}

/** @param value 主进程写确认。 @throws TypeError 返回了非空业务数据。 */
function requireWebSearchConfirmation(value: unknown): void {
  if (value !== undefined) throw new TypeError("搜索配置操作确认无效。")
}

export const MINOU_PRELOAD_GLOBAL = "minou"

/** 团队成员查询与独立更新通道。 */
export const TEAM_SESSION_CHANNELS = {
  list: "minou:team:list-members",
  subscribe: "minou:team:subscribe-member",
  unsubscribe: "minou:team:unsubscribe-member",
  update: "minou:team:member-update",
} as const

export const SESSION_IPC_CHANNELS = {
  startNewSession: "minou:session:start-new",
  continueSession: "minou:session:continue",
  enqueueSessionMessage: "minou:session:enqueue-message",
  stopSession: "minou:session:stop",
  getSessionData: "minou:session:get-data",
  update: "minou:session:update",
  renameSession: "minou:session:rename",
  exportSessionMarkdown: "minou:session:export-markdown",
  updateSessionSettings: "minou:session:update-settings",
  decideSessionApproval: "minou:session:decide-approval",
} as const

/** 首批 Router 与 Workspace 事件提交后的启动确认通道。 */
export const START_TEAM_SESSION_CHANNEL = "minou:session:start-team"

/** 受信任 Renderer 读取与保存全局唤醒参数的固定通道。 */
export const TEAM_WAKEUP_CHANNELS = {
  read: "minou:team:get-wakeup-config",
  update: "minou:team:set-wakeup-config",
} as const

/** 由主进程按持久化身份识别的会话角色。 */
export type SessionKind = "ordinary" | "router" | "member"

/** 对话控制状态，revision 在同一个主进程内按对话递增。 */
export interface SessionControl extends Omit<SessionRuntimeSnapshot, "events" | "streamEvents" | "settings"> {
  /** 控制状态的版本，与持久化事件 seq 分开。 */
  revision: number
  /** 后续 Turn 启动时读取的模型选择。 */
  currentModel: ModelRef
  /** 后续工具调用检查的权限。 */
  sandboxMode: SandboxMode
}

/** 历史查询的可序列化结果。 */
export interface SessionData {
  /** 所属分组身份。 */
  projectId: string
  /** 对话身份。 */
  sessionId: string
  /** 该会话实际运行的角色。 */
  kind: SessionKind
  /** 名称及最近事件时间。 */
  summary: SessionSummary
  /** 已提交的原始事件。 */
  events: SessionEvent[]
  /** 活动 Step 尚在内存中的块开始与增量。 */
  streamEvents: AssistantBlockStreamEvent[]
  /** events 中最后的序号。 */
  latestSeq: number
  /** 当前设置、活动状态与 Queue。 */
  control: SessionControl
}

/** 主进程统一推送；内存控制状态不写入 Event Log。 */
export type SessionUpdate = { projectId: string; sessionId: string } & (
  | { kind: "event"; event: SessionEvent; sessionKind?: SessionKind }
  | { kind: "stream"; event: AssistantBlockStreamEvent }
  | { kind: "state"; control: SessionControl; summary?: SessionSummary }
  | { kind: "error"; stage: "runtime" | "index" | "transport"; error: AppError }
)

export type { SessionSettingsPatch, SandboxMode }

/** 启动页面数据查询使用的固定 IPC channel。 */
export const STARTUP_DATA_IPC_CHANNELS = {
  listProjects: "minou:data:projects",
  listDefaultSessions: "minou:data:default-sessions",
  listProviders: "minou:data:providers",
} as const

/** Project 创建、目录与 Git 分支操作的固定 IPC channel。 */
export const PROJECT_IPC_CHANNELS = {
  selectDirectory: "minou:project:select-directory",
  createProject: "minou:project:create",
  renameProject: "minou:project:rename",
  addProjectDirectory: "minou:project:add-directory",
  removeProjectDirectory: "minou:project:remove-directory",
  listProjectGitBranches: "minou:project:git-branches",
  switchProjectGitBranch: "minou:project:git-switch",
} as const

/** 供应商创建和修改的固定 IPC channel。 */
export const PROVIDER_IPC_CHANNELS = {
  listCompatibleProviders: "minou:provider:compatible-list",
  createCompatibleProvider: "minou:provider:create-compatible",
  createCustomProvider: "minou:provider:create-custom",
  updateProvider: "minou:provider:update",
  deleteProvider: "minou:provider:delete",
  updateApiKey: "minou:provider:update-api-key",
  createModel: "minou:provider:create-model",
  updateModel: "minou:provider:update-model",
  deleteModel: "minou:provider:delete-model",
  setDefaultModel: "minou:provider:set-default-model",
} as const

/** MCP 配置与运行状态操作的固定 channel。 */
export const MCP_IPC_CHANNELS = {
  listMcpServers: "minou:mcp:list",
  createMcpServer: "minou:mcp:create",
  updateMcpServer: "minou:mcp:update",
  deleteMcpServer: "minou:mcp:delete",
  reloadMcpServers: "minou:mcp:reload",
} as const

/** 单个来源的技能管理 channel；不参与启动数据预取。 */
export const SKILL_IPC_CHANNELS = {
  listSkills: "minou:skill:list",
  setSkillEnabled: "minou:skill:set-enabled",
} as const

/** 设置页面可序列化快照；不包含 SDK 对象或从宿主环境读取的 Bearer Token。 */
export interface MCPServerSummary {
  /** 当前持久化的完整有效配置。 */ config: MCPConfig
  /** 查询时全局连接状态；禁用项为 disconnected。 */ status: MCPConnection["status"]
  /** 当前 Catalog 中可用的工具数。 */ toolCount: number
  /** 不含远端异常或鉴权内容的稳定运行错误。 */ error?: AppError
}

/** 系统目录选择窗口返回的目录。 */
export interface DirectorySelection {
  path: string
  name: string
}

/** 关联目录变更的确认或失败原因。 */
export type ProjectDirectoryResult = { success: true } | { success: false; error: string }

/** Project 主目录的 Git 仓库与本地分支状态。 */
export interface ProjectGitBranchState {
  /** 主目录是否位于 Git 工作树中。 */
  isGitRepo: boolean
  /** 当前检出的本地分支名；游离 HEAD 或非仓库时为 null。 */
  currentBranch: string | null
  /** 按名称排序的本地分支列表；未提交新库含当前初始分支。 */
  branches: string[]
}

/** 切换 Project Git 分支后的最新状态或失败原因。 */
export type ProjectGitSwitchResult =
  | {
    /** 切换是否成功。 */
    success: true
    /** 切换完成后的最新分支状态。 */
    branchState: ProjectGitBranchState
  }
  | {
    /** 切换是否成功。 */
    success: false
    /** Git 返回或参数校验失败的具体原因。 */
    error: string
  }

/** 页面列表中的对话索引摘要。 */
export interface SessionSummary {
  /** 对话目录使用的身份。 */
  sessionId: string
  /** 对话显示名称。 */
  name: string
  /** 已保存的最近更新时间。 */
  updatedAt: string
}

/** 非 default Project 的页面摘要。 */
export interface ProjectSummary {
  /** Project UUID 身份。 */
  projectId: string
  /** Project 显示名称。 */
  name: string
  /** Project 配置最近更新时间。 */
  updatedAt: string
  /** 按配置顺序排列的关联目录。 */
  directories: string[]
  /** 按索引顺序排列的对话摘要。 */
  sessions: SessionSummary[]
}

/** Provider 下模型的页面摘要；模型身份由全局唯一的 modelId 标识。 */
export interface ModelSummary {
  /** 全局唯一的模型身份。 */
  modelId: string
  /** Provider API 请求中使用的模型名称。 */
  name: string
  /** 模型的有效上下文窗口。 */
  contextWindow: number
  /** 单次请求允许的最大输出 Token 数。 */
  maxOutputTokens: number
  /** 可供当前对话选择的推理等级。 */
  reasoningLevels: string[]
  /** 将等级写入协议请求体的字段路径。 */
  reasoningField: ReasoningField
  /** 是否是当前有效默认模型。 */
  isDefault: boolean
  /** 是否支持发送思考模式配置，创建时必须显式提供。 */
  supportsReasoning: boolean
}

/** 创建 Provider 或 Model 时提交的模型配置；主进程补入缺失的限制与推理字段并生成模型身份。 */
export interface ProviderModelInput {
  /** Provider API 请求中使用的模型名称。 */
  name: string
  /** 声明的上下文窗口；省略或传 null 时创建模型使用 256000。 */
  contextWindow?: number | null
  /** 请求允许的最大输出 Token；省略或传 null 时创建模型使用 32000。 */
  maxOutputTokens?: number | null
  /** 省略、null 或空数组时采用协议默认等级。 */
  reasoningLevels?: string[] | null
  /** 省略、null 或空路径时采用协议默认字段路径。 */
  reasoningField?: ReasoningField | null
  /** 是否支持发送思考模式配置，创建时必须显式提供。 */
  supportsReasoning: boolean
}

/** 按 Provider 与全局唯一 modelId 定位的模型引用。 */
export interface ProviderModelReference {
  /** 模型所属 Provider。 */
  providerId: string
  /** 主进程生成的全局唯一模型身份。 */
  modelId: string
}

/** 更新模型名称、限制或推理配置；省略字段时不修改原值。 */
export interface ProviderModelUpdate {
  /** Provider API 请求中使用的非空模型名称；省略时本次不更新名称。 */
  name?: string
  /** 新上下文窗口。 */
  contextWindow?: number
  /** 新最大输出 Token 数。 */
  maxOutputTokens?: number
  /** 完整替换等级列表；null 或空数组恢复默认。 */
  reasoningLevels?: string[] | null
  /** 完整替换请求字段路径；null 或空路径恢复默认。 */
  reasoningField?: ReasoningField | null
  /** 更新模型思考能力；省略时保持原值。 */
  supportsReasoning?: boolean
}

/** 一个已兼容供应商的名称与协议数组；每个名称只返回一项。 */
export interface CompatibleProviderOption {
  /** 已兼容供应商的确切名称。 */
  name: string
  /** 该名称兼容的非空、去重协议数组；创建时选择其中一个与名称联合匹配。 */
  protocol: Protocol[]
}

/** 已兼容供应商创建输入；连接地址及模型由名称和协议联合决定。 */
export interface CompatibleProviderCreateInput {
  type: "compatible"
  name: string
  protocol: Protocol
  apiKey: string
}

/** 自定义供应商创建输入；模型缺省推理配置由主进程补齐。 */
export interface CustomProviderCreateInput {
  type: "custom"
  name: string
  protocol: Protocol
  apiKey: string
  url: string
  models: ProviderModelInput[]
}

/** 不含凭据、包含协议连接地址的 Provider 页面摘要。 */
export interface ProviderSummary {
  /** Provider 稳定身份。 */
  providerId: string
  /** Provider 显示名称。 */
  name: string
  /** 创建来源；内置资料只用于创建时。 */
  type: "compatible" | "custom"
  /** 当前 Provider 唯一的协议。 */
  protocol: Protocol
  /** 可选的 Provider 服务地址。 */
  baseURL?: string
  /** 按保存顺序排列的模型摘要。 */
  models: ModelSummary[]
}

/** 在已有 Provider 上创建模型后返回的新增模型摘要。 */
export interface ModelAppend {
  /** 模型所属 Provider 的身份。 */
  providerId: string
  /** 主进程生成的全局唯一模型身份。 */
  modelId: string
  /** Provider API 请求中使用的模型名称。 */
  name: string
  /** 已保存模型的上下文窗口。 */
  contextWindow: number
  /** 已保存模型的最大输出 Token 数。 */
  maxOutputTokens: number
  /** 已保存的推理等级。 */
  reasoningLevels: string[]
  /** 已保存的请求字段路径。 */
  reasoningField: ReasoningField
  /** 是否支持发送思考模式配置，创建时必须显式提供。 */
  supportsReasoning: boolean
}

/** 首批 Turn 事件成功提交后即可返回前端的可序列化结果。 */
export interface StartedSessionResponse {
  sessionId: string
  turn: number
}

/** Router 的首批事件与 Workspace 身份已原子提交。 */
export interface StartedTeamSessionResponse extends StartedSessionResponse {
  /** 本 Router 唯一的协作 Workspace ID。 */
  workspaceId: string
}

/** 主进程已接受 Session Stop 命令的可序列化确认。 */
export interface StoppedSessionResponse {
  /** 已停止或当前无需停止的 Session。 */
  sessionId: string
}

/** 暴露为 `window.minou` 的 Session 命令与启动页面查询。 */
export interface MinouPreloadApi {
  /** @returns 不含用户配置的预置目录。 @throws Error 查询或返回值校验失败。 */
  listWebSearchProviderDefinitions(): Promise<WebSearchProviderDefinition[]>
  /** @returns 全部无凭据摘要。 @throws Error 查询或返回值校验失败。 */
  listWebSearchProviders(): Promise<WebSearchProviderSummary[]>
  /** @param id 配置身份。 @returns 可能包含密钥的按需编辑详情。 @throws Error 配置缺失或返回值无效。 */
  getWebSearchProvider(id: string): Promise<WebSearchProviderConfig>
  /** @param input 前端生成的完整配置。 @returns 默认停用的新记录摘要。 @throws Error 校验或保存失败。 */
  createWebSearchProvider(input: WebSearchProviderSaveInput): Promise<WebSearchProviderSummary>
  /** @param id 配置身份。 @param input 完整替换内容。 @returns 保存确认。 @throws Error 配置缺失或保存失败。 */
  updateWebSearchProvider(id: string, input: WebSearchProviderSaveInput): Promise<void>
  /** @param id 配置身份。 @returns 删除确认，不自动选择替代项。 @throws Error 删除失败。 */
  deleteWebSearchProvider(id: string): Promise<void>
  /** @param id 要启用的身份；null 全部停用。 @returns 事务提交确认。 @throws Error 切换失败。 */
  setActiveWebSearchProvider(id: string | null): Promise<void>
  /**
   * 读取历史；前端缓存命中时不调用。
   * @param projectId 所属 Project 或 default。
   * @param sessionId 对话身份。
   * @returns 已提交事件及控制快照。
   * @throws Error 当历史恢复、存储或传输结果检查失败时抛出。
   */
  getSessionData(projectId: string, sessionId: string): Promise<SessionData>
  /**
   * 按需查询指定 Router 的成员，包含已关闭成员。
   * @param projectId Router 所属项目或 default。
   * @param routerId 团队 Router 的会话 ID。
   * @returns 按创建顺序排列的成员 ID。
   * @throws Error 当团队不存在、查询失败或结果无效时拒绝。
   */
  listTeamMembers(projectId: string, routerId: string): Promise<string[]>
  /**
   * 为当前窗口登记成员更新订阅，可重复调用。
   * @param projectId Router 所属项目或 default。
   * @param routerId 团队 Router 的会话 ID。
   * @param sessionId 该团队成员的会话 ID。
   * @returns 主进程确认订阅后解析。
   * @throws Error 当成员不属于该 Router 或窗口不可用时拒绝。
   */
  subscribeTeamSession(projectId: string, routerId: string, sessionId: string): Promise<void>
  /**
   * 解除当前窗口对该成员的订阅。
   * @param projectId Router 所属项目或 default。
   * @param routerId 团队 Router 的会话 ID。
   * @param sessionId 该团队成员的会话 ID。
   * @returns 主进程确认移除后解析。
   * @throws Error 当身份不匹配或窗口不可用时拒绝。
   */
  unsubscribeTeamSession(projectId: string, routerId: string, sessionId: string): Promise<void>
  /**
   * 独立接收已订阅成员的更新。
   * @param listener 接收通过校验的事件、控制状态或后台错误。
   * @returns 移除此监听器的函数。
   */
  onTeamSessionUpdate(listener: (update: SessionUpdate) => void): () => void
  /**
   * 监听普通会话和 Router 更新，只把业务数据交给页面。
   * @param listener 接收已检查的对话更新。
   * @returns 删除该监听器的函数。
   */
  onSessionUpdate(listener: (update: SessionUpdate) => void): () => void
  /**
   * 修改对话设置，运行中也可调用。
   * @param projectId 所属分组。
   * @param sessionId 对话身份。
   * @param patch 模型或权限更新。
   * @returns 后端确认的控制状态。
   * @throws Error 当更新或存储无效时抛出。
   */
  updateSessionSettings(projectId: string, sessionId: string, patch: Omit<SessionSettingsPatch, "name">): Promise<SessionControl>
  /**
   * 提交当前等待中的审批决定。
   * @param projectId 所属分组。
   * @param sessionId 对话身份。
   * @param approvalId 审批身份。
   * @param decision 用户明确作出的决定。
   * @returns accepted 为 false 时表示请求已经结束或不存在。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  decideSessionApproval(projectId: string, sessionId: string, approvalId: string, decision: "approved" | "denied"): Promise<{ accepted: boolean }>
  /**
   * 请求主进程显示目录选择器，取消时保留 null。
   *
   * @returns 选中的目录及名称；用户取消时为 null。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  selectDirectory(): Promise<DirectorySelection | null>
  /**
   * 创建没有关联对话的新 Project。
   * @param name 非空的项目名称。
   * @param directories 可选的现存绝对目录路径列表。
   * @returns 新项目的页面摘要。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  createProject(name: string, directories?: string[]): Promise<ProjectSummary>
  /**
   * 将现存目录追加到 Project 关联列表末尾。
   * @param projectId Project UUID。
   * @param directory 现存目录的绝对路径。
   * @returns 成功确认或失败原因。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  addProjectDirectory(projectId: string, directory: string): Promise<ProjectDirectoryResult>
  /**
   * 从 Project 的关联列表中移除目录。
   * @param projectId Project UUID。
   * @param directory 已关联的绝对路径。
   * @returns 成功确认或失败原因。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  removeProjectDirectory(projectId: string, directory: string): Promise<ProjectDirectoryResult>
  /**
   * 保存项目名称。
   * @param projectId 项目 UUID。
   * @param name 非空名称。
   * @returns 已提交的项目摘要。
   * @throws Error 保存失败或摘要无效。
   */
  renameProject(projectId: string, name: string): Promise<ProjectSummary>
  /**
   * 读取 Project 主目录的 Git 仓库与本地分支列表。
   * @param projectId 非 default Project UUID。
   * @returns 主目录的 Git 仓库状态与本地分支列表。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝。
   */
  listProjectGitBranches(projectId: string): Promise<ProjectGitBranchState>
  /**
   * 在 Project 主目录执行 `git switch` 切换到指定本地分支。
   * @param projectId 非 default Project UUID。
   * @param branch 目标本地分支名。
   * @returns 切换成功后的分支状态或失败原因。
   * @throws Error IPC 调用或返回值校验失败时拒绝。
   */
  switchProjectGitBranch(projectId: string, branch: string): Promise<ProjectGitSwitchResult>
  /**
   * 保存指定分组下的对话名称。
   * @param projectId 所属分组。
   * @param sessionId 对话身份。
   * @param name 非空名称。
   * @returns 已提交的对话摘要。
   * @throws Error 保存失败或摘要无效。
   */
  renameSession(projectId: string, sessionId: string, name: string): Promise<SessionSummary>
  /**
   * 读取已提交的对话正文并生成 Markdown。
   * @param projectId 所属分组。
   * @param sessionId 对话身份。
   * @returns 用户和助手正文。
   * @throws Error 日志无法读取、没有正文或返回值无效。
   */
  exportSessionMarkdown(projectId: string, sessionId: string): Promise<string>
  /**
   * 读取非 default Project 的当前页面摘要。
   * @returns Project 及其目录和对话索引摘要。
   * @throws Error 当数据库读取失败或主进程返回无效数据时由页面处理。
   */
  listProjects(): Promise<ProjectSummary[]>
  /**
   * 读取 default 分组的当前对话索引。
   * @returns default 分组的对话摘要。
   * @throws Error 当数据库读取失败或主进程返回无效数据时由页面处理。
   */
  listDefaultSessions(): Promise<SessionSummary[]>
  /**
   * 读取当前 Provider 与模型列表。
   * @returns 不含凭据的 Provider 及模型摘要。
   * @throws Error 当数据库读取失败或主进程返回无效数据时由页面处理。
   */
  listProviders(): Promise<ProviderSummary[]>
  /**
   * 按需同步并读取单个来源的全部技能，包含禁用项和单条描述错误。
   * @param target Global 或已登记的非 default Project。
   * @returns 来源技能列表；空列表同样是有效查询结果。
   * @throws Error 来源读取失败或主进程返回值无效。
   */
  listSkills(target: SkillTarget): Promise<SkillSummary[]>
  /**
   * 保存单个来源中指定技能的启停状态，不改写描述或对话历史。
   * @param target 要修改的来源。
   * @param name 完整文件夹名。
   * @param enabled 目标启用状态。
   * @returns 后端确认已持久化的登记项。
   * @throws Error 输入无效、技能不存在、保存失败或返回值无效。
   */
  setSkillEnabled(target: SkillTarget, name: string, enabled: boolean): Promise<SkillRegistryEntry>
  /**
   * 读取已保存 MCP 配置及当前连接状态。
   *
   * @returns 当前 MCP 配置和运行状态。
   * @throws Error 查询或返回值校验失败。
   */
  listMcpServers(): Promise<MCPServerSummary[]>
  /**
   * 请求保存新的 MCP 配置并执行对应连接尝试。
   *
   * @param config 完整配置。
   * @returns 保存及连接尝试后的列表。
   * @throws Error 输入、持久化或资源清理失败。
   */
  createMcpServer(config: MCPConfig): Promise<MCPServerSummary[]>
  /**
   * 按原始名称更新 MCP 配置并同步连接状态。
   *
   * @param originalName 当前名称。
   * @param config 完整新配置。
   * @returns 同步后的列表。
   * @throws Error 名称冲突、保存或清理失败。
   */
  updateMcpServer(originalName: string, config: MCPConfig): Promise<MCPServerSummary[]>
  /**
   * 请求删除指定 MCP 配置并清理对应连接资源。
   *
   * @param name 待删除的配置身份。
   * @returns 删除并清理后的列表。
   * @throws Error 名称不存在、保存或清理失败。
   */
  deleteMcpServer(name: string): Promise<MCPServerSummary[]>
  /**
   * 请求重新读取配置并重建启用项的 MCP 连接。
   *
   * @returns 重读配置并重新连接全部启用项后的列表。
   * @throws Error 配置无效或旧资源清理失败。
   */
  reloadMcpServers(): Promise<MCPServerSummary[]>
  /**
   * 读取内置兼容供应商目录，并检查名称与协议组合。
   *
   * @returns 按名称汇总的供应商及其协议数组；目录为空时返回空数组。
   * @throws TypeError 主进程返回的目录项无效。
   */
  listCompatibleProviders(): Promise<CompatibleProviderOption[]>
  /**
   * 根据内置目录创建 Provider 和模型，返回不含凭据的摘要。
   *
   * @param input 已兼容供应商名称、协议与凭据。
   * @returns 内置模型已保存后的无凭据摘要。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  createCompatibleProvider(input: CompatibleProviderCreateInput): Promise<ProviderSummary>
  /**
   * 保存自定义连接与模型配置，返回不含凭据的摘要。
   *
   * @param input 自定义连接和模型配置。
   * @returns 已保存的无凭据摘要。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  createCustomProvider(input: CustomProviderCreateInput): Promise<ProviderSummary>
  /**
   * 更新 Provider 显示名称与服务地址；空 URL 表示清除地址。
   * @param providerId 要更新的 Provider ID。
   * @param name 新的非空显示名称。
   * @param url 新服务地址；空字符串会清除已有地址。
   * @returns 主进程确认当前操作完成后解析。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  updateProvider(providerId: string, name: string, url: string): Promise<void>
  /**
   * 删除 Provider、其所有模型记录和 API Key。
   * @param providerId 要删除的 Provider ID。
   * @returns 主进程确认当前操作完成后解析。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  deleteProvider(providerId: string): Promise<void>
  /**
   * 替换或移除 Provider API Key。
   * @param providerId API Key 所属 Provider ID。
   * @param apiKey 新 API Key；null 表示移除。
   * @returns 主进程确认当前操作完成后解析。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  updateApiKey(providerId: string, apiKey: string | null): Promise<void>
  /**
   * 在 Provider 模型列表末尾新增一条记录。
   * @param providerId 模型所属 Provider ID。
   * @param model 新模型配置。
   * @returns 主进程生成身份后的模型摘要。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  createModel(providerId: string, model: ProviderModelInput): Promise<ModelAppend>
  /**
   * 更新指定模型身份的名称、Token 限制或推理配置。
   * @param reference 要更新的 Provider 与模型引用。
   * @param update 要替换的名称或 Token 限制。
   * @returns 主进程确认当前操作完成后解析。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  updateModel(reference: ProviderModelReference, update: ProviderModelUpdate): Promise<void>
  /**
   * 删除指定 Provider 下由 modelId 标识的模型。
   * @param reference 要删除的 Provider 与模型引用。
   * @returns 主进程确认当前操作完成后解析。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  deleteModel(reference: ProviderModelReference): Promise<void>
  /**
   * 设置默认模型，或传 null 回到列表顺序的第一个模型。
   * @param reference 默认模型的 Provider 与模型引用；null 表示清除显式默认值。
   * @returns 主进程确认当前操作完成后解析。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  setDefaultModel(reference: ProviderModelReference | null): Promise<void>
  /**
   * 在指定 Project 分组中创建并启动 Session。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param input 首轮用户消息与模型选择。
   * @returns 首批 Turn 事件成功提交后的 Session 身份和 Turn 编号。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  startNewSession(
    projectId: string,
    input: StartNewSessionInput,
  ): Promise<StartedSessionResponse>
  /**
   * 在指定 Project 中以首条用户消息创建 Router。
   * @param projectId 所属 Project UUID 或 default。
   * @param input 首条消息、模型与权限。
   * @returns 已提交的 Router、Turn 与 Workspace 身份。
   * @throws Error 首发或返回值校验失败时拒绝。
   */
  startTeamSession(projectId: string, input: StartNewSessionInput): Promise<StartedTeamSessionResponse>
  /** @returns 主进程当前生效的全局 Team 唤醒配置。 */
  getTeamWakeupConfig(): Promise<TeamWakeupConfig>
  /**
   * 保存并应用完整 Team 唤醒配置。
   * @param config 四项完整设置。
   * @returns 已保存并应用的配置。
   * @throws Error 输入、保存或返回值校验失败时拒绝。
   */
  setTeamWakeupConfig(config: TeamWakeupConfig): Promise<TeamWakeupConfig>
  /**
   * 在指定 Project 分组中恢复已有 Session。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param sessionId 要恢复的 Session 身份。
   * @param input 新 Turn 的用户消息；模型与推理等级从 Session Meta 读取。
   * @returns 新 Turn 首批事件成功提交后的 Session 身份和 Turn 编号。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  continueSession(
    projectId: string,
    sessionId: string,
    input: ContinueSessionInput,
  ): Promise<StartedSessionResponse>
  /**
   * 向指定 Project 中正在运行的 Session 追加消息。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param sessionId 正在运行的 Session 身份。
   * @param input 要入队的用户消息。
   * @returns Runtime 接受消息后的入队确认。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  enqueueSessionMessage(
    projectId: string,
    sessionId: string,
    input: EnqueueSessionMessageInput,
  ): Promise<EnqueuedSessionMessageResponse>
  /**
   * 停止指定 Project 中的活动 Session Runtime。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param sessionId 要停止的 Session 身份。
   * @returns 主进程已完成幂等 Stop 处理的确认。
   * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
   */
  stopSession(
    projectId: string,
    sessionId: string,
  ): Promise<StoppedSessionResponse>
}

/** Electron ipcRenderer.invoke 的最小接口，便于在不引入 Electron 类型依赖时测试。 */
export interface IpcRendererInvokePort {
  /**
   * 通过指定 IPC channel 调用主进程并返回未知业务结果。
   *
   * @param channel 固定 IPC channel。
   * @param args 传给主进程的业务参数。
   * @returns 主进程返回的未知业务结果，由上层方法校验。
   * @throws Error IPC 调用失败时拒绝，调用方负责展示或处理失败。
   */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  /**
   * 登记固定 channel 的推送监听器，Electron 事件仅在 preload 内部使用。
   *
   * @param channel 固定推送 channel。
   * @param listener 不向页面传递 Electron 事件的监听器。
   * @returns IPC 端口原始返回值，页面不直接消费。
   */
  on?(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  /**
   * 按 channel 与原监听函数移除本次推送订阅。
   *
   * @param channel 固定 channel。
   * @param listener 先前注册的同一监听器。
   * @returns IPC 端口原始返回值，页面不直接消费。
   */
  removeListener?(channel: string, listener: (event: unknown, value: unknown) => void): unknown
}

/** Electron contextBridge.exposeInMainWorld 的最小接口。 */
export interface ContextBridgePort {
  /**
   * 将已构造的窄接口发布到 Renderer 的指定全局名称。
   *
   * @param apiKey Renderer 中发布接口的全局名称。
   * @param api 已构造且允许暴露的窄接口对象。
   */
  exposeInMainWorld(apiKey: string, api: unknown): void
}

/**
 * 创建只调用固定 channel 并检查业务返回值的冻结 API，不暴露 ipcRenderer 本体。
 * @param ipcRenderer preload 持有的 IPC 调用与可选事件监听端口。
 * @returns Renderer 使用的 Minou 窄接口；构造时不发起请求。
 */
export function createSessionApi(ipcRenderer: IpcRendererInvokePort): MinouPreloadApi {
  return Object.freeze({
    /** @returns 已检查的预置目录。 @throws Error IPC 或结构无效。 */
    async listWebSearchProviderDefinitions(): Promise<WebSearchProviderDefinition[]> {
      return requireWebSearchDefinitions(await ipcRenderer.invoke(WEB_SEARCH_IPC_CHANNELS.listWebSearchProviderDefinitions))
    },
    /** @returns 全部无凭据摘要。 @throws Error IPC 或结构无效。 */
    async listWebSearchProviders(): Promise<WebSearchProviderSummary[]> {
      return requireWebSearchSummaries(await ipcRenderer.invoke(WEB_SEARCH_IPC_CHANNELS.listWebSearchProviders))
    },
    /** @param id 配置身份。 @returns 按需详情。 @throws Error IPC 或详情无效。 */
    async getWebSearchProvider(id: string): Promise<WebSearchProviderConfig> {
      const value: unknown = await ipcRenderer.invoke(WEB_SEARCH_IPC_CHANNELS.getWebSearchProvider, id)
      if (!isRecord(value) || typeof value.requestJson !== "string" || typeof value.responseJmespath !== "string" || !value.responseJmespath.trim()) throw new TypeError("搜索配置详情无效。")
      requireWebSearchSummaries([{ id: value.id, name: value.name, enabled: value.enabled }])
      try { JSON.parse(value.requestJson) } catch { throw new TypeError("搜索配置详情 JSON 无效。") }
      return { id: value.id as string, name: value.name as string, enabled: value.enabled as boolean,
        requestJson: value.requestJson, responseJmespath: value.responseJmespath }
    },
    /** @param input 最终请求内容。 @returns 新记录摘要。 @throws Error IPC 或摘要无效。 */
    async createWebSearchProvider(input: WebSearchProviderSaveInput): Promise<WebSearchProviderSummary> {
      return requireWebSearchSummaries([await ipcRenderer.invoke(WEB_SEARCH_IPC_CHANNELS.createWebSearchProvider, input)])[0]!
    },
    /** @param id 配置身份。 @param input 最终请求内容。 @returns 写入确认。 @throws Error 保存失败。 */
    async updateWebSearchProvider(id: string, input: WebSearchProviderSaveInput): Promise<void> {
      requireWebSearchConfirmation(await ipcRenderer.invoke(WEB_SEARCH_IPC_CHANNELS.updateWebSearchProvider, id, input))
    },
    /** @param id 配置身份。 @returns 删除确认。 @throws Error 删除失败。 */
    async deleteWebSearchProvider(id: string): Promise<void> {
      requireWebSearchConfirmation(await ipcRenderer.invoke(WEB_SEARCH_IPC_CHANNELS.deleteWebSearchProvider, id))
    },
    /** @param id 目标身份或 null。 @returns 切换确认。 @throws Error 切换失败。 */
    async setActiveWebSearchProvider(id: string | null): Promise<void> {
      requireWebSearchConfirmation(await ipcRenderer.invoke(WEB_SEARCH_IPC_CHANNELS.setActiveWebSearchProvider, id))
    },
    /**
     * 读取历史；前端缓存命中时不调用。
     * @param projectId 所属 Project 或 default。
     * @param sessionId 对话身份。
     * @returns 已提交事件及控制快照。
     * @throws Error 当历史恢复、存储或传输结果检查失败时抛出。
     */
    async getSessionData(projectId: string, sessionId: string): Promise<SessionData> {
      const data = requireSessionData(await ipcRenderer.invoke(SESSION_IPC_CHANNELS.getSessionData, projectId, sessionId))
      if (data.projectId !== projectId || data.sessionId !== sessionId) throw new TypeError("历史结果属于其他对话")
      return data
    },
    /** @see MinouPreloadApi.listTeamMembers */
    async listTeamMembers(projectId: string, routerId: string) {
      const ids = await ipcRenderer.invoke(TEAM_SESSION_CHANNELS.list, projectId, routerId)
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0)) throw new TypeError("团队成员列表无效")
      return ids
    },
    /** @see MinouPreloadApi.subscribeTeamSession */
    async subscribeTeamSession(projectId: string, routerId: string, sessionId: string) {
      await ipcRenderer.invoke(TEAM_SESSION_CHANNELS.subscribe, projectId, routerId, sessionId)
    },
    /** @see MinouPreloadApi.unsubscribeTeamSession */
    async unsubscribeTeamSession(projectId: string, routerId: string, sessionId: string) {
      await ipcRenderer.invoke(TEAM_SESSION_CHANNELS.unsubscribe, projectId, routerId, sessionId)
    },
    /** @see MinouPreloadApi.onTeamSessionUpdate */
    onTeamSessionUpdate(listener: (update: SessionUpdate) => void) {
      if (!ipcRenderer.on || !ipcRenderer.removeListener) return () => {}
      const receive = (_event: unknown, value: unknown): void => { listener(requireSessionUpdate(value)) }
      ipcRenderer.on(TEAM_SESSION_CHANNELS.update, receive)
      return () => { ipcRenderer.removeListener!(TEAM_SESSION_CHANNELS.update, receive) }
    },
    /**
     * 监听普通会话和 Router 更新，只把业务数据交给页面。
     * @param listener 接收已检查的对话更新。
     * @returns 删除该监听器的函数。
     */
    onSessionUpdate(listener: (update: SessionUpdate) => void): () => void {
      if (!ipcRenderer.on || !ipcRenderer.removeListener) throw new TypeError("IPC 端口不支持事件监听")
      const receive = (_event: unknown, value: unknown): void => { listener(requireSessionUpdate(value)) }
      ipcRenderer.on(SESSION_IPC_CHANNELS.update, receive)
      return () => { ipcRenderer.removeListener!(SESSION_IPC_CHANNELS.update, receive) }
    },
    /**
     * 修改对话设置，运行中也可调用。
     * @param projectId 所属分组。
     * @param sessionId 对话身份。
     * @param patch 模型或权限更新。
     * @returns 后端确认的控制状态。
     * @throws Error 当更新或存储无效时抛出。
     */
    async renameSession(projectId: string, sessionId: string, name: string): Promise<SessionSummary> {
      const [summary] = requireSessionSummaries([await ipcRenderer.invoke(SESSION_IPC_CHANNELS.renameSession, projectId, sessionId, name)])
      if (summary.sessionId !== sessionId) throw new TypeError("对话摘要身份无效")
      return summary
    },
    async exportSessionMarkdown(projectId: string, sessionId: string): Promise<string> {
      const markdown = await ipcRenderer.invoke(SESSION_IPC_CHANNELS.exportSessionMarkdown, projectId, sessionId)
      if (typeof markdown !== "string") throw new TypeError("对话 Markdown 无效")
      return markdown
    },
    async updateSessionSettings(projectId: string, sessionId: string, patch: Omit<SessionSettingsPatch, "name">): Promise<SessionControl> {
      return requireSessionControl(await ipcRenderer.invoke(SESSION_IPC_CHANNELS.updateSessionSettings, projectId, sessionId, patch))
    },
    /**
     * 提交当前等待中的审批决定。
     * @param projectId 所属分组。
     * @param sessionId 对话身份。
     * @param approvalId 审批身份。
     * @param decision 用户明确作出的决定。
     * @returns accepted 为 false 时表示请求已经结束或不存在。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async decideSessionApproval(projectId: string, sessionId: string, approvalId: string, decision: "approved" | "denied"): Promise<{ accepted: boolean }> {
      const value = await ipcRenderer.invoke(SESSION_IPC_CHANNELS.decideSessionApproval, projectId, sessionId, approvalId, decision)
      if (!isRecord(value) || typeof value.accepted !== "boolean") throw new TypeError("审批结果无效")
      return { accepted: value.accepted }
    },
    /**
     * @returns 选中的目录及名称；用户取消时为 null。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async selectDirectory(): Promise<DirectorySelection | null> {
      return requireDirectorySelection(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.selectDirectory))
    },

    /**
     * 创建没有关联对话的新 Project。
     * @param name 非空的项目名称。
     * @param directories 可选的现存绝对目录路径列表。
     * @returns 新项目的页面摘要。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async createProject(name: string, directories?: string[]): Promise<ProjectSummary> {
      return requireProjectSummary(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.createProject, name, directories))
    },

    /**
     * 将现存目录追加到 Project 关联列表末尾。
     * @param projectId Project UUID。
     * @param directory 现存目录的绝对路径。
     * @returns 成功确认或失败原因。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async renameProject(projectId: string, name: string): Promise<ProjectSummary> {
      const summary = requireProjectSummary(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.renameProject, projectId, name))
      if (summary.projectId !== projectId) throw new TypeError("项目摘要身份无效")
      return summary
    },
    async addProjectDirectory(projectId: string, directory: string): Promise<ProjectDirectoryResult> {
      return requireProjectDirectoryResult(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.addProjectDirectory, projectId, directory))
    },

    /**
     * 从 Project 的关联列表中移除目录。
     * @param projectId Project UUID。
     * @param directory 现存目录的绝对路径。
     * @returns 成功确认或失败原因。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async removeProjectDirectory(projectId: string, directory: string): Promise<ProjectDirectoryResult> {
      return requireProjectDirectoryResult(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.removeProjectDirectory, projectId, directory))
    },

    /**
     * 读取 Project 主目录的 Git 仓库与本地分支列表。
     * @param projectId 非 default Project UUID。
     * @returns 主目录的 Git 仓库状态与本地分支列表。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝。
     */
    async listProjectGitBranches(projectId: string): Promise<ProjectGitBranchState> {
      return requireProjectGitBranchState(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.listProjectGitBranches, projectId))
    },

    /**
     * 在 Project 主目录执行 `git switch` 切换到指定本地分支。
     * @param projectId 非 default Project UUID。
     * @param branch 目标本地分支名。
     * @returns 切换成功后的分支状态或失败原因。
     * @throws Error IPC 调用或返回值校验失败时拒绝。
     */
    async switchProjectGitBranch(projectId: string, branch: string): Promise<ProjectGitSwitchResult> {
      return requireProjectGitSwitchResult(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.switchProjectGitBranch, projectId, branch))
    },

    /**
     * 读取非 default Project 的当前页面摘要。
     * @returns Project 及其目录和对话索引摘要。
     * @throws Error 当数据库读取失败或主进程返回无效数据时由页面处理。
     */
    async listProjects(): Promise<ProjectSummary[]> {
      return requireProjectSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listProjects))
    },

    /**
     * 读取 default 分组的当前对话索引。
     * @returns default 分组的对话摘要。
     * @throws Error 当数据库读取失败或主进程返回无效数据时由页面处理。
     */
    async listDefaultSessions(): Promise<SessionSummary[]> {
      return requireSessionSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions))
    },

    /**
     * 读取当前 Provider 与模型列表。
     * @returns 不含凭据的 Provider 及模型摘要。
     * @throws Error 当数据库读取失败或主进程返回无效数据时由页面处理。
     */
    async listProviders(): Promise<ProviderSummary[]> {
      return requireProviderSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listProviders))
    },

    /**
     * 按需同步并读取单个来源的全部技能，包含禁用项和单条描述错误。
     * @param target Global 或已登记的非 default Project。
     * @returns 来源技能列表；空列表同样是有效查询结果。
     * @throws Error 来源读取失败或主进程返回值无效。
     */
    async listSkills(target: SkillTarget): Promise<SkillSummary[]> {
      const value = await ipcRenderer.invoke(SKILL_IPC_CHANNELS.listSkills, target)
      if (!Array.isArray(value)) throw new TypeError("主进程返回了无效的 Skill 列表")
      const names = new Set<string>()
      return value.map((item: unknown): SkillSummary => {
        const entry = requireSkillEntry(item, target)
        if (!isRecord(item) || names.has(entry.name) ||
            !((typeof item.description === "string" && item.description.trim() !== "" && item.descriptionError === undefined) ||
              (typeof item.descriptionError === "string" && item.descriptionError.trim() !== "" && item.description === undefined))) {
          throw new TypeError("主进程返回了无效的 Skill 描述")
        }
        names.add(entry.name)
        return { ...entry, ...(typeof item.description === "string" ? { description: item.description } : { descriptionError: item.descriptionError as string }) }
      })
    },

    /**
     * 保存单个来源中指定技能的启停状态，不改写描述或对话历史。
     * @param target 要修改的来源。
     * @param name 完整文件夹名。
     * @param enabled 目标启用状态。
     * @returns 后端确认已持久化的登记项。
     * @throws Error 输入无效、技能不存在、保存失败或返回值无效。
     */
    async setSkillEnabled(target: SkillTarget, name: string, enabled: boolean): Promise<SkillRegistryEntry> {
      const entry = requireSkillEntry(await ipcRenderer.invoke(SKILL_IPC_CHANNELS.setSkillEnabled, target, name, enabled), target)
      if (entry.name !== name || entry.enabled !== enabled) throw new TypeError("Skill 保存结果与请求不一致")
      return entry
    },

    /**
     * @returns 当前 MCP 配置和运行状态。
     * @throws Error 查询或返回值校验失败。
     */
    async listMcpServers(): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.listMcpServers))
    },
    /**
     * @param config 完整配置。
     * @returns 保存及连接尝试后的列表。
     * @throws Error 输入、持久化或资源清理失败。
     */
    async createMcpServer(config: MCPConfig): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.createMcpServer, config))
    },
    /**
     * @param originalName 当前名称。
     * @param config 完整新配置。
     * @returns 同步后的列表。
     * @throws Error 名称冲突、保存或清理失败。
     */
    async updateMcpServer(originalName: string, config: MCPConfig): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.updateMcpServer, originalName, config))
    },
    /**
     * @param name 待删除的配置身份。
     * @returns 删除并清理后的列表。
     * @throws Error 名称不存在、保存或清理失败。
     */
    async deleteMcpServer(name: string): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.deleteMcpServer, name))
    },
    /**
     * @returns 重读配置并重新连接全部启用项后的列表。
     * @throws Error 配置无效或旧资源清理失败。
     */
    async reloadMcpServers(): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.reloadMcpServers))
    },

    /**
     * @returns 按名称汇总的供应商及其协议数组；目录为空时返回空数组。
     * @throws TypeError 主进程返回的目录项无效。
     */
    async listCompatibleProviders(): Promise<CompatibleProviderOption[]> {
      const value = await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.listCompatibleProviders)
      if (!Array.isArray(value) || !value.every((entry: unknown): entry is CompatibleProviderOption =>
        isRecord(entry) && Object.keys(entry).length === 2 &&
        typeof entry.name === "string" && entry.name.trim() !== "" &&
        Array.isArray(entry.protocol) && entry.protocol.length > 0 &&
        entry.protocol.every((protocol: unknown) => PROTOCOLS.some((supported) => supported === protocol)) &&
        new Set(entry.protocol).size === entry.protocol.length)) {
        throw new TypeError("主进程返回了无效的已兼容供应商列表")
      }
      if (new Set(value.map((entry) => entry.name)).size !== value.length) {
        throw new TypeError("主进程返回了重复的已兼容供应商名称")
      }
      return value
    },

    /**
     * @param input 已兼容供应商名称、协议与凭据。
     * @returns 内置模型已保存后的无凭据摘要。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async createCompatibleProvider(input: CompatibleProviderCreateInput): Promise<ProviderSummary> {
      return requireProviderSummary(await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.createCompatibleProvider, input))
    },

    /**
     * @param input 自定义连接和模型配置。
     * @returns 已保存的无凭据摘要。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async createCustomProvider(input: CustomProviderCreateInput): Promise<ProviderSummary> {
      return requireProviderSummary(await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.createCustomProvider, input))
    },

    /**
     * 更新 Provider 显示名称与服务地址；空 URL 表示清除地址。
     * @param providerId 要更新的 Provider ID。
     * @param name 新的非空显示名称。
     * @param url 新服务地址；空字符串会清除已有地址。
     * @returns 主进程确认当前操作完成后解析。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async updateProvider(providerId: string, name: string, url: string): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.updateProvider, providerId, name, url)
    },

    /**
     * 删除 Provider、其所有模型记录和 API Key。
     * @param providerId 要删除的 Provider ID。
     * @returns 主进程确认当前操作完成后解析。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async deleteProvider(providerId: string): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.deleteProvider, providerId)
    },

    /**
     * 替换或移除 Provider API Key。
     * @param providerId API Key 所属 Provider ID。
     * @param apiKey 新 API Key；null 表示移除。
     * @returns 主进程确认当前操作完成后解析。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async updateApiKey(providerId: string, apiKey: string | null): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.updateApiKey, providerId, apiKey)
    },

    /**
     * 在 Provider 模型列表末尾新增一条记录。
     * @param providerId 模型所属 Provider ID。
     * @param model 新模型配置。
     * @returns 主进程生成身份后的模型摘要。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async createModel(providerId: string, model: ProviderModelInput): Promise<ModelAppend> {
      return requireModelAppend(await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.createModel, providerId, model))
    },

    /**
     * 更新指定模型身份的名称、Token 限制或推理配置。
     * @param reference 要更新的 Provider 与模型引用。
     * @param update 要替换的名称或 Token 限制。
     * @returns 主进程确认当前操作完成后解析。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async updateModel(reference: ProviderModelReference, update: ProviderModelUpdate): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.updateModel, reference, update)
    },

    /**
     * 删除指定 Provider 下由 modelId 标识的模型。
     * @param reference 要删除的 Provider 与模型引用。
     * @returns 主进程确认当前操作完成后解析。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async deleteModel(reference: ProviderModelReference): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.deleteModel, reference)
    },

    /**
     * 设置默认模型，或传 null 回到列表顺序的第一个模型。
     * @param reference 默认模型的 Provider 与模型引用；null 表示清除显式默认值。
     * @returns 主进程确认当前操作完成后解析。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async setDefaultModel(reference: ProviderModelReference | null): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.setDefaultModel, reference)
    },

    /**
     * 在指定 Project 分组中创建并启动 Session。
     * @param projectId Session 所属 Project UUID 或 default。
     * @param input 首轮用户消息与模型选择。
     * @returns 首批 Turn 事件成功提交后的 Session 身份和 Turn 编号。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async startNewSession(
      projectId: string,
      input: StartNewSessionInput,
    ): Promise<StartedSessionResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.startNewSession,
        projectId,
        input,
      )
      return requireStartedSessionResponse(response)
    },

    async startTeamSession(projectId: string, input: StartNewSessionInput): Promise<StartedTeamSessionResponse> {
      const response = await ipcRenderer.invoke(START_TEAM_SESSION_CHANNEL, projectId, input)
      const started = requireStartedSessionResponse(response)
      if (!isProjectId(started.sessionId) || started.sessionId === "default") {
        throw new TypeError("主进程返回了无效的 Router 会话身份")
      }
      if (!isRecord(response) || !isProjectId(response.workspaceId) || response.workspaceId === "default") {
        throw new TypeError("主进程返回了无效的 Team Workspace 身份")
      }
      return { ...started, workspaceId: response.workspaceId }
    },

    async getTeamWakeupConfig(): Promise<TeamWakeupConfig> {
      return requireTeamWakeupConfig(await ipcRenderer.invoke(TEAM_WAKEUP_CHANNELS.read))
    },

    async setTeamWakeupConfig(config: TeamWakeupConfig): Promise<TeamWakeupConfig> {
      if (!isTeamWakeupConfig(config)) throw new TypeError("Team 唤醒配置无效")
      return requireTeamWakeupConfig(await ipcRenderer.invoke(TEAM_WAKEUP_CHANNELS.update, config))
    },

    /**
     * 在指定 Project 分组中恢复已有 Session。
     * @param projectId Session 所属 Project UUID 或 default。
     * @param sessionId 要恢复的 Session 身份。
     * @param input 新 Turn 的用户消息；模型与推理等级从 Session Meta 读取。
     * @returns 新 Turn 首批事件成功提交后的 Session 身份和 Turn 编号。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async continueSession(
      projectId: string,
      sessionId: string,
      input: ContinueSessionInput,
    ): Promise<StartedSessionResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.continueSession,
        projectId,
        sessionId,
        input,
      )
      return requireStartedSessionResponse(response)
    },

    /**
     * 向指定 Project 中正在运行的 Session 追加消息。
     * @param projectId Session 所属 Project UUID 或 default。
     * @param sessionId 正在运行的 Session 身份。
     * @param input 要入队的用户消息。
     * @returns Runtime 接受消息后的入队确认。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async enqueueSessionMessage(
      projectId: string,
      sessionId: string,
      input: EnqueueSessionMessageInput,
    ): Promise<EnqueuedSessionMessageResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.enqueueSessionMessage,
        projectId,
        sessionId,
        input,
      )
      return requireEnqueuedSessionMessageResponse(response)
    },

    /**
     * 停止指定 Project 中的活动 Session Runtime。
     * @param projectId Session 所属 Project UUID 或 default。
     * @param sessionId 要停止的 Session 身份。
     * @returns 主进程已完成幂等 Stop 处理的确认。
     * @throws Error IPC 调用、后端处理或返回值校验失败时拒绝，页面负责保留当前状态并报告失败。
     */
    async stopSession(
      projectId: string,
      sessionId: string,
    ): Promise<StoppedSessionResponse> {
      const response = await ipcRenderer.invoke(
        SESSION_IPC_CHANNELS.stopSession,
        projectId,
        sessionId,
      )
      return requireStoppedSessionResponse(response)
    },
  })
}

/**
 * 创建冻结的窄接口，并通过 contextBridge 暴露给 Renderer。
 *
 * @param contextBridge preload 持有的安全桥接端口。
 * @param ipcRenderer preload 持有的 IPC 调用及监听端口。
 * @throws Error 接口创建或桥接暴露失败时传播，preload 启动入口负责报告。
 */
export function exposeSessionApi(
  contextBridge: ContextBridgePort,
  ipcRenderer: IpcRendererInvokePort,
): MinouPreloadApi {
  const api = createSessionApi(ipcRenderer)
  contextBridge.exposeInMainWorld(MINOU_PRELOAD_GLOBAL, api)
  return api
}

/**
 * 检查技能登记返回值的名称、绝对路径、作用域及启停状态，只保留消费字段。
 * @param value 主进程返回的未知登记项。
 * @param target 本次请求的作用域。
 * @returns 独立的有效登记项。
 * @throws TypeError 字段无效或返回的来源作用域与请求不符。
 */
function requireSkillEntry(value: unknown, target: SkillTarget): SkillRegistryEntry {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim() === "" ||
      value.name === "." || value.name === ".." || /[/\\]/.test(value.name) ||
      typeof value.path !== "string" || !/^(?:[a-z]:[/\\]|\\\\|\/)/i.test(value.path) ||
      value.scope !== target.scope || typeof value.enabled !== "boolean") throw new TypeError("主进程返回了无效的 Skill 登记项")
  return { name: value.name, path: value.path, scope: target.scope, enabled: value.enabled }
}

/**
 * 检查 MCP 页面快照的可消费字段，不把配置对象当作 SDK 资源。
 * @param value 主进程返回的未知值。
 * @returns 可安全供设置页面读取的独立快照。
 * @throws TypeError 列表、配置、运行状态、工具数或错误字段无效。
 */
function requireMcpSummaries(value: unknown): MCPServerSummary[] {
  if (!Array.isArray(value)) throw new TypeError("主进程返回了无效的 MCP 列表")
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.config) || typeof entry.config.name !== "string" || entry.config.name.trim() === "" ||
        typeof entry.config.enabled !== "boolean" || !["connecting", "connected", "disconnected", "error"].includes(entry.status as string) ||
        !Number.isSafeInteger(entry.toolCount) || (entry.toolCount as number) < 0) throw new TypeError("主进程返回了无效的 MCP 状态")
    const config = entry.config
    /** @param map 未知键值对象。 @returns 键非空且所有值为字符串时为 true。 */
    const stringMap = (map: unknown): boolean => isRecord(map) && Object.entries(map).every(([key, item]) => key.trim() !== "" && typeof item === "string")
    /** @param key 配置字段。 @returns 省略或非空字符串时为 true。 */
    const optionalString = (key: string): boolean => config[key] === undefined || (typeof config[key] === "string" && (config[key] as string).trim() !== "")
    /** @param key 超时字段。 @returns 省略或计时器范围内有限正数秒时为 true。 */
    const timeoutValid = (key: string): boolean => config[key] === undefined || (typeof config[key] === "number" && Number.isFinite(config[key]) && (config[key] as number) > 0 && (config[key] as number) * 1000 <= 2_147_483_647)
    const valid = config.transport === "stdio"
      ? typeof config.command === "string" && config.command.trim() !== "" && optionalString("cwd") &&
        (config.args === undefined || (Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string"))) &&
        (config.env === undefined || stringMap(config.env))
      : config.transport === "streamable-http" && typeof config.url === "string" && isMcpHttpUrl(config.url) && optionalString("bearer_token_env_var") &&
        (config.http_headers === undefined || stringMap(config.http_headers)) &&
        !(config.bearer_token_env_var !== undefined && isRecord(config.http_headers) && Object.keys(config.http_headers).some((key) => key.toLowerCase() === "authorization"))
    if (!valid || !timeoutValid("startup_timeout_sec") || !timeoutValid("tool_timeout_sec") ||
        (entry.error !== undefined && (!isRecord(entry.error) || entry.error.source !== "mcp" || typeof entry.error.code !== "string" || typeof entry.error.message !== "string"))) {
      throw new TypeError("主进程返回了无效的 MCP 配置")
    }
  }
  return structuredClone(value) as MCPServerSummary[]
}

/**
 * 检查地址是否为绝对 HTTP 或 HTTPS URL。
 *
 * @param value 待检查的 URL。
 * @returns 是否为绝对 HTTP(S) 地址。
 */
function isMcpHttpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol) } catch { return false }
}

/**
 * 检查新建或继续 Turn 的 IPC 确认结果，只返回 Session 身份和 Turn。
 *
 * @param value 主进程返回的未知结果。
 * @returns 身份与 Turn 编号通过检查的启动确认。
 * @throws Error 结果缺少有效身份或 Turn 编号时抛出 TypeError。
 */
function requireStartedSessionResponse(value: unknown): StartedSessionResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    !("turn" in value) ||
    typeof value.turn !== "number" ||
    !Number.isInteger(value.turn) ||
    value.turn <= 0
  ) {
    throw new TypeError("主进程返回了无效的 Session 启动结果")
  }
  return { sessionId: value.sessionId, turn: value.turn }
}

/**
 * 校验主进程返回的配置快照。
 * @param value 未知 IPC 返回值。
 * @returns 完整的 Team 唤醒参数。
 * @throws TypeError 当任一字段无效时抛出。
 */
function requireTeamWakeupConfig(value: unknown): TeamWakeupConfig {
  if (!isTeamWakeupConfig(value)) throw new TypeError("主进程返回了无效的 Team 唤醒配置")
  return value
}

/**
 * 检查入队确认的身份、消息 ID 和文本块，只返回允许的确认字段。
 *
 * @param value 主进程返回的未知入队结果。
 * @returns 通过检查的入队确认；文本块保持返回值中的引用。
 * @throws Error 入队确认字段不符合契约时抛出 TypeError。
 */
function requireEnqueuedSessionMessageResponse(value: unknown): EnqueuedSessionMessageResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    !("content" in value) ||
    !isTextContent(value.content) ||
    !("messageId" in value) || typeof value.messageId !== "string" || value.messageId.length === 0
  ) {
    throw new TypeError("主进程返回了无效的 Session 消息入队结果")
  }
  return { sessionId: value.sessionId, messageId: value.messageId, content: value.content }
}

/**
 * 检查模型引用的必需身份、协议及推理等级字段。
 *
 * @param value 未经检查的模型引用。
 * @returns 是否具有现有 ModelRef 的必需字段。
 */
function isModelReference(value: unknown): value is ModelRef {
  return isRecord(value) && typeof value.providerId === "string" && value.providerId.length > 0 &&
    typeof value.modelId === "string" && value.modelId.length > 0 && typeof value.name === "string" &&
    typeof value.reasoningLevel === "string" && value.reasoningLevel.trim() !== "" &&
    (PROTOCOLS as readonly unknown[]).includes(value.protocol)
}

/**
 * 检查控制快照的版本、水位、设置和内存消息状态。
 *
 * @param value 未知 IPC 值。
 * @returns 已检查的控制快照。
 * @throws TypeError 当必需字段无效时抛出。
 */
function requireSessionControl(value: unknown): SessionControl {
  const messagesValid = (items: unknown): boolean => Array.isArray(items) && items.every((item) =>
    isRecord(item) && typeof item.messageId === "string" && item.messageId.length > 0 &&
    (item.status === "queued" || item.status === "starting") && isTextContent(item.content))
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      !Number.isSafeInteger(value.throughSeq) || (value.throughSeq as number) < 0 ||
      !isModelReference(value.currentModel) ||
      !["sandbox-read-only", "sandbox-full-access", "full-access", "auto"].includes(value.sandboxMode as string) ||
      !["idle", "running", "stopping"].includes(value.phase as string) ||
      (value.currentTurn !== undefined && (!Number.isSafeInteger(value.currentTurn) || (value.currentTurn as number) <= 0)) ||
      !messagesValid(value.pendingMessages) || !messagesValid(value.discardedMessages)) {
    throw new TypeError("主进程返回了无效的对话控制状态")
  }
  return value as unknown as SessionControl
}

/**
 * 检查事件的日志身份与类型，不在此完整校验各事件载荷。
 *
 * @param value 未知事件值。
 * @returns 是否具有持久化事件的身份与已知类型。
 */
function isSessionEvent(value: unknown): value is SessionEvent {
  return isRecord(value) && typeof value.eventId === "string" && value.eventId.length > 0 &&
    typeof value.sessionId === "string" && typeof value.createdAt === "string" &&
    Number.isSafeInteger(value.seq) && (value.seq as number) > 0 &&
    ["context_update", "user/message", "assistant/block_start", "assistant/block_delta", "assistant/block_end",
      "assistant/message", "tool/result", "app/error", "summary/start", "summary/end", "turn/file_changes",
      "turn/start", "turn/end", "step/start", "step/end", "approval/request", "approval/result",
      "mcp/tools_added", "mcp/tools_removed"].includes(value.type as string)
}

/**
 * 检查内存流片段的身份、排序字段与载荷。
 * @param value IPC 返回的未知事件。
 * @returns 是否为可展示的块开始或增量。
 */
function isAssistantBlockStreamEvent(value: unknown): value is AssistantBlockStreamEvent {
  if (!isRecord(value) || "seq" in value || typeof value.eventId !== "string" || value.eventId.length === 0 ||
      typeof value.sessionId !== "string" || typeof value.createdAt !== "string" ||
      typeof value.blockId !== "string" || value.blockId.length === 0 ||
      ![value.turn, value.step, value.streamSeq, value.afterSeq].every((seq) =>
        typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0)) return false
  if (value.type === "assistant/block_start") {
    return Number.isSafeInteger(value.index) && (value.index as number) >= 0 &&
      (value.blockType === "text" || value.blockType === "thinking" || value.blockType === "tool_call")
  }
  if (value.type !== "assistant/block_delta" || !isRecord(value.delta)) return false
  const delta = value.delta
  if (delta.type === "tool_call") {
    return typeof delta.toolCallId === "string" &&
      (delta.nameDelta === undefined || typeof delta.nameDelta === "string") &&
      (delta.argumentsDelta === undefined || typeof delta.argumentsDelta === "string")
  }
  return (delta.type === "text" || delta.type === "thinking") && typeof delta.text === "string"
}

/**
 * 检查历史结果的身份、连续事件序号、摘要和控制快照。
 *
 * @param value IPC 查询结果。
 * @returns 身份与事件顺序已检查的历史。
 * @throws TypeError 当结果无效时抛出。
 */
function requireSessionData(value: unknown): SessionData {
  if (!isRecord(value) || !isProjectId(value.projectId) || typeof value.sessionId !== "string" ||
      !isSessionKind(value.kind) ||
      !Array.isArray(value.events) || !value.events.every((event, index, events) => isSessionEvent(event) &&
        event.sessionId === value.sessionId && event.seq === index + 1) ||
      value.latestSeq !== (value.events.at(-1)?.seq ?? 0)) throw new TypeError("主进程返回了无效的对话历史")
  const latestSeq = value.latestSeq as number
  const streamEvents = value.streamEvents
  if (!Array.isArray(streamEvents) || !streamEvents.every((event, index) =>
    isAssistantBlockStreamEvent(event) && event.sessionId === value.sessionId && event.streamSeq === index + 1 &&
    event.afterSeq <= latestSeq && (index === 0 ||
      (event.turn === streamEvents[0].turn && event.step === streamEvents[0].step &&
        event.afterSeq >= streamEvents[index - 1].afterSeq)))) {
    throw new TypeError("主进程返回了无效的活动流片段")
  }
  const [summary] = requireSessionSummaries([value.summary])
  if (summary.sessionId !== value.sessionId) throw new TypeError("对话摘要身份无效")
  return { projectId: value.projectId, sessionId: value.sessionId, kind: value.kind, summary, events: value.events,
    streamEvents, latestSeq, control: requireSessionControl(value.control) }
}

/** @param value IPC 字段。 @returns 是否为已知的会话角色。 */
function isSessionKind(value: unknown): value is SessionKind {
  return value === "ordinary" || value === "router" || value === "member"
}
/**
 * 检查主进程推送的事件、状态或错误业务更新。
 *
 * @param value 主进程推送值。
 * @returns 已检查的业务更新。
 * @throws TypeError 当更新无效时抛出。
 */
function requireSessionUpdate(value: unknown): SessionUpdate {
  if (!isRecord(value) || !isProjectId(value.projectId) || typeof value.sessionId !== "string") {
    throw new TypeError("对话更新身份无效")
  }
  if (value.kind === "event" && isSessionEvent(value.event) && value.event.sessionId === value.sessionId) {
    if ("sessionKind" in value && (value.event.seq !== 1 || !isSessionKind(value.sessionKind))) {
      throw new TypeError("对话更新角色无效")
    }
    return value as unknown as SessionUpdate
  }
  if (value.kind === "stream" && isAssistantBlockStreamEvent(value.event) && value.event.sessionId === value.sessionId) {
    return { projectId: value.projectId, sessionId: value.sessionId, kind: "stream", event: value.event }
  }
  if (value.kind === "state") {
    const control = requireSessionControl(value.control)
    if (value.summary === undefined) return { projectId: value.projectId, sessionId: value.sessionId, kind: "state", control }
    const [summary] = requireSessionSummaries([value.summary])
    if (summary.sessionId !== value.sessionId) throw new TypeError("对话摘要身份无效")
    return { projectId: value.projectId, sessionId: value.sessionId, kind: "state", control, summary }
  }
  if (value.kind === "error" && ["runtime", "index", "transport"].includes(value.stage as string) &&
      isRecord(value.error) && typeof value.error.source === "string" && typeof value.error.code === "string" &&
      typeof value.error.message === "string") return value as unknown as SessionUpdate
  throw new TypeError("主进程返回了无效的对话更新")
}

/**
 * 检查停止操作的 Session 身份确认。
 *
 * @param value 主进程返回的未知停止结果。
 * @returns 包含有效 Session ID 的停止确认。
 * @throws Error Session ID 缺失或无效时抛出 TypeError。
 */
function requireStoppedSessionResponse(value: unknown): StoppedSessionResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0
  ) {
    throw new TypeError("主进程返回了无效的 Session 停止结果")
  }
  return { sessionId: value.sessionId }
}

/**
 * 检查主进程返回的对话索引摘要，避免把非法值交给页面。
 * @param value 未经检查的 IPC 结果。
 * @returns 已检查的对话摘要数组。
 * @throws TypeError 当结果缺少必需字段时抛出。
 */
function requireSessionSummaries(value: unknown): SessionSummary[] {
  if (!Array.isArray(value) || !value.every((item) =>
    isRecord(item) && typeof item.sessionId === "string" &&
    typeof item.name === "string" && typeof item.updatedAt === "string"
  )) throw new TypeError("主进程返回了无效的对话列表")
  return value as SessionSummary[]
}

/**
 * 检查非 default Project 及其目录、对话索引。
 * @param value 未经检查的 IPC 结果。
 * @returns 已检查的 Project 摘要数组。
 * @throws TypeError 当结果缺少必需字段时抛出。
 */
function requireProjectSummaries(value: unknown): ProjectSummary[] {
  if (!Array.isArray(value) || !value.every((item) =>
    isRecord(item) && isProjectId(item.projectId) && item.projectId !== "default" &&
    typeof item.name === "string" && typeof item.updatedAt === "string" &&
    Array.isArray(item.directories) && item.directories.every((directory: unknown) => typeof directory === "string") &&
    Array.isArray(item.sessions) && item.sessions.every((session: unknown) =>
      isRecord(session) && typeof session.sessionId === "string" &&
      typeof session.name === "string" && typeof session.updatedAt === "string")
  )) throw new TypeError("主进程返回了无效的项目列表")
  return value as ProjectSummary[]
}

/**
 * 复用项目列表检查器校验单个项目摘要。
 *
 * @param value 未经检查的单个 IPC 项目结果。
 * @returns 通过检查的项目摘要。
 * @throws Error 摘要字段无效时抛出 TypeError。
 */
function requireProjectSummary(value: unknown): ProjectSummary {
  return requireProjectSummaries([value])[0]
}

/**
 * 检查系统目录选择结果，并保留用户取消的 null。
 *
 * @param value 主进程返回的目录选择结果。
 * @returns 有效目录选择，或表示取消的 null。
 * @throws Error 非空结果缺少有效路径与名称时抛出 TypeError。
 */
function requireDirectorySelection(value: unknown): DirectorySelection | null {
  if (value === null) return null
  if (!isRecord(value) || typeof value.path !== "string" ||
      typeof value.name !== "string" || value.path.length === 0 || value.name.length === 0) {
    throw new TypeError("主进程返回了无效的目录选择结果")
  }
  return { path: value.path, name: value.name }
}

/**
 * 检查项目关联目录操作的成功确认或失败说明。
 *
 * @param value 主进程返回的目录操作结果。
 * @returns 通过检查的目录操作确认。
 * @throws Error 确认结构无效时抛出 TypeError。
 */
function requireProjectDirectoryResult(value: unknown): ProjectDirectoryResult {
  if (isRecord(value) && value.success === true) return { success: true }
  if (isRecord(value) && value.success === false &&
      typeof value.error === "string" && value.error.length > 0) {
    return { success: false, error: value.error }
  }
  throw new TypeError("主进程返回了无效的项目目录操作结果")
}

/**
 * 检查主进程返回的 Project Git 分支状态结构。
 * @param value 未经检查的 IPC 结果。
 * @returns 已校验的 Git 分支状态。
 * @throws TypeError 当状态字段缺失、类型错误或非 Git 仓库附带分支时抛出。
 */
function requireProjectGitBranchState(value: unknown): ProjectGitBranchState {
  if (!isRecord(value) || typeof value.isGitRepo !== "boolean") {
    throw new TypeError("主进程返回了无效的 Git 分支状态")
  }
  const currentBranchValid = value.currentBranch === null ||
    (typeof value.currentBranch === "string" && value.currentBranch.trim() !== "")
  const branchesValid = Array.isArray(value.branches) &&
    value.branches.every((branch: unknown) => typeof branch === "string" && branch.trim() !== "")
  if (!currentBranchValid || !branchesValid) {
    throw new TypeError("主进程返回了无效的 Git 分支列表")
  }
  const currentBranch = value.currentBranch as string | null
  const branches = value.branches as string[]
  if (!value.isGitRepo && (currentBranch !== null || branches.length > 0)) {
    throw new TypeError("非 Git 仓库不应包含分支状态")
  }
  return { isGitRepo: value.isGitRepo, currentBranch, branches }
}

/**
 * 检查主进程返回的 Git 分支切换结果。
 * @param value 未经检查的 IPC 结果。
 * @returns 已校验的切换确认或失败原因。
 * @throws TypeError 当切换结果缺少状态或错误信息时抛出。
 */
function requireProjectGitSwitchResult(value: unknown): ProjectGitSwitchResult {
  if (isRecord(value) && value.success === true) {
    return { success: true, branchState: requireProjectGitBranchState(value.branchState) }
  }
  if (isRecord(value) && value.success === false &&
      typeof value.error === "string" && value.error.length > 0) {
    return { success: false, error: value.error }
  }
  throw new TypeError("主进程返回了无效的 Git 分支切换结果")
}

/**
 * 检查 Provider 协议与 Provider、模型摘要的必需字段。
 * @param value 未经检查的 IPC 结果。
 * @returns 已检查的 Provider 摘要数组。
 * @throws TypeError 当结果缺少必需字段时抛出。
 */
function requireProviderSummaries(value: unknown): ProviderSummary[] {
  if (!Array.isArray(value) || !value.every((item) =>
    isRecord(item) && typeof item.providerId === "string" && typeof item.name === "string" &&
    (item.type === "compatible" || item.type === "custom") &&
    (PROTOCOLS as readonly unknown[]).includes(item.protocol) &&
    (item.baseURL === undefined || typeof item.baseURL === "string") &&
    Array.isArray(item.models) && item.models.every((model: unknown) =>
      isRecord(model) && typeof model.modelId === "string" && model.modelId.trim() !== "" && typeof model.name === "string" && model.name.trim() !== "" &&
      typeof model.contextWindow === "number" && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 &&
      typeof model.maxOutputTokens === "number" && Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0 &&
      typeof model.supportsReasoning === "boolean" && isReasoningLevels(model.reasoningLevels) && isReasoningField(model.reasoningField, item.protocol as Protocol) &&
      typeof model.isDefault === "boolean")
  )) throw new TypeError("主进程返回了无效的 Provider 列表")
  return value as ProviderSummary[]
}

/**
 * 检查主进程创建 Provider 后返回的摘要。
 * @param value 未经检查的 IPC 返回值。
 * @returns 单个 Provider 摘要。
 * @throws TypeError 当主进程返回值不符合 Provider 摘要结构时抛出。
 */
function requireProviderSummary(value: unknown): ProviderSummary {
  const provider = requireProviderSummaries([value])[0]
  if (provider === undefined) throw new TypeError("主进程未返回新建的 Provider")
  return provider
}

/**
 * 检查主进程新增模型后返回的摘要。
 * @param value 未经检查的 IPC 返回值。
 * @returns 结构有效的新增模型摘要。
 * @throws TypeError 当主进程返回值缺少必需字段或数值无效时抛出。
 */
function requireModelAppend(value: unknown): ModelAppend {
  if (!isRecord(value) || typeof value.providerId !== "string" || value.providerId.trim() === "" ||
      typeof value.modelId !== "string" || value.modelId.trim() === "" ||
      typeof value.name !== "string" || value.name.trim() === "" ||
      typeof value.contextWindow !== "number" || !Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0 ||
      typeof value.maxOutputTokens !== "number" || !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens <= 0 ||
      typeof value.supportsReasoning !== "boolean" ||
      !isReasoningLevels(value.reasoningLevels) ||
      !(isReasoningField(value.reasoningField, "anthropic_messages") ||
        isReasoningField(value.reasoningField, "chat_completions") ||
        isReasoningField(value.reasoningField, "responses"))) {
    throw new TypeError("主进程返回了无效的新建模型")
  }
  return {
    providerId: value.providerId,
    modelId: value.modelId,
    name: value.name,
    contextWindow: value.contextWindow,
    maxOutputTokens: value.maxOutputTokens,
    supportsReasoning: value.supportsReasoning,
    reasoningLevels: value.reasoningLevels,
    reasoningField: value.reasoningField,
  }
}

/**
 * 把未知 IPC 返回值缩小为非数组对象。
 * @param value 未经检查的值。
 * @returns 值是非数组对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 检查未知值是否为文本内容块数组，不改写块内容。
 *
 * @param value 待检查的消息内容。
 * @returns 值是否满足当前消息文本块检查条件。
 */
function isTextContent(value: unknown): value is EnqueueSessionMessageInput["content"] {
  return Array.isArray(value) && value.every((block) =>
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
  )
}
