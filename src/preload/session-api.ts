/**
 * Renderer 可调用的 Session 入口与启动页面查询，以及 preload 与主进程之间的 IPC 契约。
 *
 * preload 只暴露窄接口，不把 ipcRenderer 本体交给 Renderer。Runtime 仍运行在主进程；
 * 主进程在首批事件提交后返回可结构化克隆的 sessionId / turn，运行中追加返回入队确认，
 * Stop 返回幂等处理确认；后台事件流与 completion 均不跨 IPC。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 1、13、28 节。
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
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import type { AppError } from "../../runtime/error/src/types.ts"
import type { MCPConfig, MCPConnection } from "../../runtime/mcp/src/types.ts"
import type { SandboxMode, SessionSettingsPatch } from "../../runtime/session/src/session-state.ts"
import { isProjectId } from "../../runtime/session/src/project-id.ts"
import type { SkillRegistryEntry, SkillSummary, SkillTarget } from "../../runtime/skill/src/index.ts"

export type { SkillRegistryEntry, SkillSummary, SkillTarget }

export const NICODE_PRELOAD_GLOBAL = "nicode"

export const SESSION_IPC_CHANNELS = {
  startNewSession: "nicode:session:start-new",
  continueSession: "nicode:session:continue",
  enqueueSessionMessage: "nicode:session:enqueue-message",
  stopSession: "nicode:session:stop",
  getSessionData: "nicode:session:get-data",
  update: "nicode:session:update",
  updateSessionSettings: "nicode:session:update-settings",
  decideSessionApproval: "nicode:session:decide-approval",
} as const

/** 对话控制状态，revision 在同一个主进程内按对话递增。 */
export interface SessionControl extends Omit<SessionRuntimeSnapshot, "events" | "settings"> {
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
  /** 名称及最近事件时间。 */
  summary: SessionSummary
  /** 已提交的原始事件。 */
  events: SessionEvent[]
  /** events 中最后的序号。 */
  latestSeq: number
  /** 当前设置、活动状态与 Queue。 */
  control: SessionControl
}

/** 主进程统一推送；内存控制状态不写入 Event Log。 */
export type SessionUpdate = { projectId: string; sessionId: string } & (
  | { kind: "event"; event: SessionEvent }
  | { kind: "state"; control: SessionControl }
  | { kind: "error"; stage: "runtime" | "index" | "transport"; error: AppError }
)

export type { SessionSettingsPatch, SandboxMode }

/** 启动页面数据查询使用的固定 IPC channel。 */
export const STARTUP_DATA_IPC_CHANNELS = {
  listProjects: "nicode:data:projects",
  listDefaultSessions: "nicode:data:default-sessions",
  listProviders: "nicode:data:providers",
} as const

/** Project 创建和目录操作的固定 IPC channel。 */
export const PROJECT_IPC_CHANNELS = {
  selectDirectory: "nicode:project:select-directory",
  createProject: "nicode:project:create",
  addProjectDirectory: "nicode:project:add-directory",
  removeProjectDirectory: "nicode:project:remove-directory",
} as const

/** 供应商创建和修改的固定 IPC channel。 */
export const PROVIDER_IPC_CHANNELS = {
  listCompatibleProviderNames: "nicode:provider:compatible-names",
  createCompatibleProvider: "nicode:provider:create-compatible",
  createCustomProvider: "nicode:provider:create-custom",
  updateProvider: "nicode:provider:update",
  deleteProvider: "nicode:provider:delete",
  updateApiKey: "nicode:provider:update-api-key",
  createModel: "nicode:provider:create-model",
  updateModel: "nicode:provider:update-model",
  deleteModel: "nicode:provider:delete-model",
  setDefaultModel: "nicode:provider:set-default-model",
} as const

/** MCP 配置与运行状态操作的固定 channel。 */
export const MCP_IPC_CHANNELS = {
  listMcpServers: "nicode:mcp:list",
  createMcpServer: "nicode:mcp:create",
  updateMcpServer: "nicode:mcp:update",
  deleteMcpServer: "nicode:mcp:delete",
  reloadMcpServers: "nicode:mcp:reload",
} as const

/** 单个来源的技能管理 channel；不参与启动数据预取。 */
export const SKILL_IPC_CHANNELS = {
  listSkills: "nicode:skill:list",
  setSkillEnabled: "nicode:skill:set-enabled",
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
}

/** 创建 Provider 或 Model 时提交的模型配置；主进程补入缺失的限制与推理字段并生成模型身份。 */
export interface ProviderModelInput {
  /** Provider API 请求中使用的模型名称。 */
  name: string
  /** 声明的上下文窗口；省略或传 null 时创建模型使用 256000。 */
  contextWindow?: number | null
  /** 请求允许的最大输出 Token；省略或传 null 时创建模型使用 32000。 */
  maxOutputTokens?: number | null
  /** 省略或传 null 时采用协议默认等级。 */
  reasoningLevels?: string[] | null
  /** 省略或传 null 时采用协议默认字段路径。 */
  reasoningField?: ReasoningField | null
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
  /** 完整替换可选等级列表。 */
  reasoningLevels?: string[]
  /** 完整替换请求字段路径。 */
  reasoningField?: ReasoningField
}

/** 已兼容供应商创建输入；连接地址及模型由内置目录决定。 */
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
}

/** 首批 Turn 事件成功提交后即可返回前端的可序列化结果。 */
export interface StartedSessionResponse {
  sessionId: string
  turn: number
}

/** 主进程已接受 Session Stop 命令的可序列化确认。 */
export interface StoppedSessionResponse {
  /** 已停止或当前无需停止的 Session。 */
  sessionId: string
}

/** 暴露为 `window.nicode` 的 Session 命令与启动页面查询。 */
export interface NiCodePreloadApi {
  /**
   * 读取历史；前端缓存命中时不调用。
   * @param projectId 所属 Project 或 default。
   * @param sessionId 对话身份。
   * @returns 已提交事件及控制快照。
   * @throws Error 当历史恢复、存储或传输结果检查失败时抛出。
   */
  getSessionData(projectId: string, sessionId: string): Promise<SessionData>
  /**
   * 工作区统一监听更新，只把业务数据交给页面。
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
  updateSessionSettings(projectId: string, sessionId: string, patch: SessionSettingsPatch): Promise<SessionControl>
  /**
   * 提交当前等待中的审批决定。
   * @param projectId 所属分组。
   * @param sessionId 对话身份。
   * @param approvalId 审批身份。
   * @param decision 用户明确作出的决定。
   * @returns accepted 为 false 时表示请求已经结束或不存在。
   */
  decideSessionApproval(projectId: string, sessionId: string, approvalId: string, decision: "approved" | "denied"): Promise<{ accepted: boolean }>
  /** @returns 选中的目录及名称；用户取消时为 null。 */
  selectDirectory(): Promise<DirectorySelection | null>
  /**
   * 创建没有关联对话的新 Project。
   * @param name 非空的项目名称。
   * @param directories 可选的现存绝对目录路径列表。
   * @returns 新项目的页面摘要。
   */
  createProject(name: string, directories?: string[]): Promise<ProjectSummary>
  /**
   * 将现存目录追加到 Project 关联列表末尾。
   * @param projectId Project UUID。
   * @param directory 现存目录的绝对路径。
   * @returns 成功确认或失败原因。
   */
  addProjectDirectory(projectId: string, directory: string): Promise<ProjectDirectoryResult>
  /**
   * 从 Project 的关联列表中移除目录。
   * @param projectId Project UUID。
   * @param directory 现存目录的绝对路径。
   * @returns 成功确认或失败原因。
   */
  removeProjectDirectory(projectId: string, directory: string): Promise<ProjectDirectoryResult>
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
  /** @returns 当前 MCP 配置和运行状态。 @throws Error 查询或返回值校验失败。 */
  listMcpServers(): Promise<MCPServerSummary[]>
  /** @param config 完整配置。 @returns 保存及连接尝试后的列表。 @throws Error 输入、持久化或资源清理失败。 */
  createMcpServer(config: MCPConfig): Promise<MCPServerSummary[]>
  /** @param originalName 当前名称。 @param config 完整新配置。 @returns 同步后的列表。 @throws Error 名称冲突、保存或清理失败。 */
  updateMcpServer(originalName: string, config: MCPConfig): Promise<MCPServerSummary[]>
  /** @param name 待删除的配置身份。 @returns 删除并清理后的列表。 @throws Error 名称不存在、保存或清理失败。 */
  deleteMcpServer(name: string): Promise<MCPServerSummary[]>
  /** @returns 重读配置并重新连接全部启用项后的列表。 @throws Error 配置无效或旧资源清理失败。 */
  reloadMcpServers(): Promise<MCPServerSummary[]>
  /** @returns 内置目录中的已兼容供应商名称；目录为空时返回空数组。 */
  listCompatibleProviderNames(): Promise<string[]>
  /** @param input 已兼容供应商名称、协议与凭据。 @returns 内置模型已保存后的无凭据摘要。 */
  createCompatibleProvider(input: CompatibleProviderCreateInput): Promise<ProviderSummary>
  /** @param input 自定义连接和模型配置。 @returns 已保存的无凭据摘要。 */
  createCustomProvider(input: CustomProviderCreateInput): Promise<ProviderSummary>
  /**
   * 更新 Provider 显示名称与服务地址；空 URL 表示清除地址。
   * @param providerId 要更新的 Provider ID。
   * @param name 新的非空显示名称。
   * @param url 新服务地址；空字符串会清除已有地址。
   */
  updateProvider(providerId: string, name: string, url: string): Promise<void>
  /**
   * 删除 Provider、其所有模型记录和 API Key。
   * @param providerId 要删除的 Provider ID。
   */
  deleteProvider(providerId: string): Promise<void>
  /**
   * 替换或移除 Provider API Key。
   * @param providerId API Key 所属 Provider ID。
   * @param apiKey 新 API Key；null 表示移除。
   */
  updateApiKey(providerId: string, apiKey: string | null): Promise<void>
  /**
   * 在 Provider 模型列表末尾新增一条记录。
   * @param providerId 模型所属 Provider ID。
   * @param model 新模型配置。
   * @returns 主进程生成身份后的模型摘要。
   */
  createModel(providerId: string, model: ProviderModelInput): Promise<ModelAppend>
  /**
   * 更新指定模型身份的名称、Token 限制或推理配置。
   * @param reference 要更新的 Provider 与模型引用。
   * @param update 要替换的名称或 Token 限制。
   */
  updateModel(reference: ProviderModelReference, update: ProviderModelUpdate): Promise<void>
  /**
   * 删除指定 Provider 下由 modelId 标识的模型。
   * @param reference 要删除的 Provider 与模型引用。
   */
  deleteModel(reference: ProviderModelReference): Promise<void>
  /**
   * 设置默认模型，或传 null 回到列表顺序的第一个模型。
   * @param reference 默认模型的 Provider 与模型引用；null 表示清除显式默认值。
   */
  setDefaultModel(reference: ProviderModelReference | null): Promise<void>
  /**
   * 在指定 Project 分组中创建并启动 Session。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param input 首轮用户消息与模型选择。
   * @returns 首批 Turn 事件成功提交后的 Session 身份和 Turn 编号。
   */
  startNewSession(
    projectId: string,
    input: StartNewSessionInput,
  ): Promise<StartedSessionResponse>
  /**
   * 在指定 Project 分组中恢复已有 Session。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param sessionId 要恢复的 Session 身份。
   * @param input 新 Turn 的用户消息；模型与推理等级从 Session Meta 读取。
   * @returns 新 Turn 首批事件成功提交后的 Session 身份和 Turn 编号。
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
   */
  stopSession(
    projectId: string,
    sessionId: string,
  ): Promise<StoppedSessionResponse>
}

/** Electron ipcRenderer.invoke 的最小接口，便于在不引入 Electron 类型依赖时测试。 */
export interface IpcRendererInvokePort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  /** @param channel 固定推送 channel。 @param listener 不向页面传递 Electron 事件的监听器。 */
  on?(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  /** @param channel 固定 channel。 @param listener 先前注册的同一监听器。 */
  removeListener?(channel: string, listener: (event: unknown, value: unknown) => void): unknown
}

/** Electron contextBridge.exposeInMainWorld 的最小接口。 */
export interface ContextBridgePort {
  exposeInMainWorld(apiKey: string, api: unknown): void
}

/**
 * 创建只调用固定 channel 并检查业务返回值的冻结 API，不暴露 ipcRenderer 本体。
 * @param ipcRenderer preload 持有的 IPC 调用与可选事件监听端口。
 * @returns Renderer 使用的 NiCode 窄接口；构造时不发起请求。
 */
export function createSessionApi(ipcRenderer: IpcRendererInvokePort): NiCodePreloadApi {
  return Object.freeze({
    async getSessionData(projectId: string, sessionId: string): Promise<SessionData> {
      const data = requireSessionData(await ipcRenderer.invoke(SESSION_IPC_CHANNELS.getSessionData, projectId, sessionId))
      if (data.projectId !== projectId || data.sessionId !== sessionId) throw new TypeError("历史结果属于其他对话")
      return data
    },
    onSessionUpdate(listener: (update: SessionUpdate) => void): () => void {
      if (!ipcRenderer.on || !ipcRenderer.removeListener) throw new TypeError("IPC 端口不支持事件监听")
      const receive = (_event: unknown, value: unknown): void => { listener(requireSessionUpdate(value)) }
      ipcRenderer.on(SESSION_IPC_CHANNELS.update, receive)
      return () => { ipcRenderer.removeListener!(SESSION_IPC_CHANNELS.update, receive) }
    },
    async updateSessionSettings(projectId: string, sessionId: string, patch: SessionSettingsPatch): Promise<SessionControl> {
      return requireSessionControl(await ipcRenderer.invoke(SESSION_IPC_CHANNELS.updateSessionSettings, projectId, sessionId, patch))
    },
    async decideSessionApproval(projectId: string, sessionId: string, approvalId: string, decision: "approved" | "denied"): Promise<{ accepted: boolean }> {
      const value = await ipcRenderer.invoke(SESSION_IPC_CHANNELS.decideSessionApproval, projectId, sessionId, approvalId, decision)
      if (!isRecord(value) || typeof value.accepted !== "boolean") throw new TypeError("审批结果无效")
      return { accepted: value.accepted }
    },
    async selectDirectory(): Promise<DirectorySelection | null> {
      return requireDirectorySelection(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.selectDirectory))
    },

    async createProject(name: string, directories?: string[]): Promise<ProjectSummary> {
      return requireProjectSummary(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.createProject, name, directories))
    },

    async addProjectDirectory(projectId: string, directory: string): Promise<ProjectDirectoryResult> {
      return requireProjectDirectoryResult(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.addProjectDirectory, projectId, directory))
    },

    async removeProjectDirectory(projectId: string, directory: string): Promise<ProjectDirectoryResult> {
      return requireProjectDirectoryResult(await ipcRenderer.invoke(PROJECT_IPC_CHANNELS.removeProjectDirectory, projectId, directory))
    },

    async listProjects(): Promise<ProjectSummary[]> {
      return requireProjectSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listProjects))
    },

    async listDefaultSessions(): Promise<SessionSummary[]> {
      return requireSessionSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions))
    },

    async listProviders(): Promise<ProviderSummary[]> {
      return requireProviderSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listProviders))
    },

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

    async setSkillEnabled(target: SkillTarget, name: string, enabled: boolean): Promise<SkillRegistryEntry> {
      const entry = requireSkillEntry(await ipcRenderer.invoke(SKILL_IPC_CHANNELS.setSkillEnabled, target, name, enabled), target)
      if (entry.name !== name || entry.enabled !== enabled) throw new TypeError("Skill 保存结果与请求不一致")
      return entry
    },

    async listMcpServers(): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.listMcpServers))
    },
    async createMcpServer(config: MCPConfig): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.createMcpServer, config))
    },
    async updateMcpServer(originalName: string, config: MCPConfig): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.updateMcpServer, originalName, config))
    },
    async deleteMcpServer(name: string): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.deleteMcpServer, name))
    },
    async reloadMcpServers(): Promise<MCPServerSummary[]> {
      return requireMcpSummaries(await ipcRenderer.invoke(MCP_IPC_CHANNELS.reloadMcpServers))
    },

    async listCompatibleProviderNames(): Promise<string[]> {
      const value = await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.listCompatibleProviderNames)
      if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && name.trim() !== "") ||
          new Set(value).size !== value.length) throw new TypeError("主进程返回了无效的已兼容供应商名称")
      return value
    },

    async createCompatibleProvider(input: CompatibleProviderCreateInput): Promise<ProviderSummary> {
      return requireProviderSummary(await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.createCompatibleProvider, input))
    },

    async createCustomProvider(input: CustomProviderCreateInput): Promise<ProviderSummary> {
      return requireProviderSummary(await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.createCustomProvider, input))
    },

    async updateProvider(providerId: string, name: string, url: string): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.updateProvider, providerId, name, url)
    },

    async deleteProvider(providerId: string): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.deleteProvider, providerId)
    },

    async updateApiKey(providerId: string, apiKey: string | null): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.updateApiKey, providerId, apiKey)
    },

    async createModel(providerId: string, model: ProviderModelInput): Promise<ModelAppend> {
      return requireModelAppend(await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.createModel, providerId, model))
    },

    async updateModel(reference: ProviderModelReference, update: ProviderModelUpdate): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.updateModel, reference, update)
    },

    async deleteModel(reference: ProviderModelReference): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.deleteModel, reference)
    },

    async setDefaultModel(reference: ProviderModelReference | null): Promise<void> {
      await ipcRenderer.invoke(PROVIDER_IPC_CHANNELS.setDefaultModel, reference)
    },

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

/** 把窄化后的 Session API 安装到 Renderer 的 `window.nicode`。 */
export function exposeSessionApi(
  contextBridge: ContextBridgePort,
  ipcRenderer: IpcRendererInvokePort,
): NiCodePreloadApi {
  const api = createSessionApi(ipcRenderer)
  contextBridge.exposeInMainWorld(NICODE_PRELOAD_GLOBAL, api)
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

/** @param value 待检查的 URL。 @returns 是否为绝对 HTTP(S) 地址。 */
function isMcpHttpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol) } catch { return false }
}

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

/** @param value 未经检查的模型引用。 @returns 是否具有现有 ModelRef 的必需字段。 */
function isModelReference(value: unknown): value is ModelRef {
  return isRecord(value) && typeof value.providerId === "string" && value.providerId.length > 0 &&
    typeof value.modelId === "string" && value.modelId.length > 0 && typeof value.name === "string" &&
    typeof value.reasoningLevel === "string" && value.reasoningLevel.trim() !== "" &&
    (PROTOCOLS as readonly unknown[]).includes(value.protocol)
}

/** @param value 未知 IPC 值。 @returns 已检查的控制快照。 @throws TypeError 当必需字段无效时抛出。 */
function requireSessionControl(value: unknown): SessionControl {
  const messagesValid = (items: unknown): boolean => Array.isArray(items) && items.every((item) =>
    isRecord(item) && typeof item.messageId === "string" && item.messageId.length > 0 &&
    (item.status === "queued" || item.status === "starting") && isTextContent(item.content))
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      !Number.isSafeInteger(value.throughSeq) || (value.throughSeq as number) < 0 ||
      !isModelReference(value.currentModel) ||
      !["sandbox-read-only", "sandbox-full-access", "full-access"].includes(value.sandboxMode as string) ||
      !["idle", "running", "stopping"].includes(value.phase as string) ||
      (value.currentTurn !== undefined && (!Number.isSafeInteger(value.currentTurn) || (value.currentTurn as number) <= 0)) ||
      !messagesValid(value.pendingMessages) || !messagesValid(value.discardedMessages)) {
    throw new TypeError("主进程返回了无效的对话控制状态")
  }
  return value as unknown as SessionControl
}

/** @param value 未知事件值。 @returns 是否具有持久化事件的身份与已知类型。 */
function isSessionEvent(value: unknown): value is SessionEvent {
  return isRecord(value) && typeof value.eventId === "string" && value.eventId.length > 0 &&
    typeof value.sessionId === "string" && typeof value.createdAt === "string" &&
    Number.isSafeInteger(value.seq) && (value.seq as number) > 0 &&
    ["context_update", "user/message", "assistant/block_start", "assistant/block_delta", "assistant/block_end",
      "assistant/message", "tool/result", "app/error", "summary/start", "summary/end", "turn/file_changes",
      "turn/start", "turn/end", "step/start", "step/end", "approval/request", "approval/result"].includes(value.type as string)
}

/** @param value IPC 查询结果。
 * @returns 身份与事件顺序已检查的历史。
 * @throws TypeError 当结果无效时抛出。
 */
function requireSessionData(value: unknown): SessionData {
  if (!isRecord(value) || !isProjectId(value.projectId) || typeof value.sessionId !== "string" ||
      !Array.isArray(value.events) || !value.events.every((event, index, events) => isSessionEvent(event) &&
        event.sessionId === value.sessionId && event.seq === index + 1) ||
      value.latestSeq !== (value.events.at(-1)?.seq ?? 0)) throw new TypeError("主进程返回了无效的对话历史")
  const [summary] = requireSessionSummaries([value.summary])
  if (summary.sessionId !== value.sessionId) throw new TypeError("对话摘要身份无效")
  return { projectId: value.projectId, sessionId: value.sessionId, summary, events: value.events,
    latestSeq: value.latestSeq as number, control: requireSessionControl(value.control) }
}
/** @param value 主进程推送值。
 * @returns 已检查的业务更新。
 * @throws TypeError 当更新无效时抛出。
 */
function requireSessionUpdate(value: unknown): SessionUpdate {
  if (!isRecord(value) || !isProjectId(value.projectId) || typeof value.sessionId !== "string") {
    throw new TypeError("对话更新身份无效")
  }
  if (value.kind === "event" && isSessionEvent(value.event) && value.event.sessionId === value.sessionId) {
    return value as unknown as SessionUpdate
  }
  if (value.kind === "state") return { projectId: value.projectId, sessionId: value.sessionId,
    kind: "state", control: requireSessionControl(value.control) }
  if (value.kind === "error" && ["runtime", "index", "transport"].includes(value.stage as string) &&
      isRecord(value.error) && typeof value.error.source === "string" && typeof value.error.code === "string" &&
      typeof value.error.message === "string") return value as unknown as SessionUpdate
  throw new TypeError("主进程返回了无效的对话更新")
}

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

/** @returns 已检查的单个 Project 摘要；无效时抛出 TypeError。 */
function requireProjectSummary(value: unknown): ProjectSummary {
  return requireProjectSummaries([value])[0]
}

/** @returns 已检查的目录选择结果；取消时为 null。 */
function requireDirectorySelection(value: unknown): DirectorySelection | null {
  if (value === null) return null
  if (!isRecord(value) || typeof value.path !== "string" ||
      typeof value.name !== "string" || value.path.length === 0 || value.name.length === 0) {
    throw new TypeError("主进程返回了无效的目录选择结果")
  }
  return { path: value.path, name: value.name }
}

/** @returns 已检查的目录变更结果。 */
function requireProjectDirectoryResult(value: unknown): ProjectDirectoryResult {
  if (isRecord(value) && value.success === true) return { success: true }
  if (isRecord(value) && value.success === false &&
      typeof value.error === "string" && value.error.length > 0) {
    return { success: false, error: value.error }
  }
  throw new TypeError("主进程返回了无效的项目目录操作结果")
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
      isReasoningLevels(model.reasoningLevels) && isReasoningField(model.reasoningField, item.protocol as Protocol) &&
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
