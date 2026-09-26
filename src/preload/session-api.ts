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
} from "../../runtime/agent/src/session-runtime.ts"
import { PROTOCOLS } from "../../runtime/model/src/types.ts"
import type { Protocol } from "../../runtime/model/src/types.ts"
import type { UserMessageInput } from "../../runtime/session/src/events.ts"
import { isProjectId } from "../../runtime/session/src/project-id.ts"

export const NICODE_PRELOAD_GLOBAL = "nicode"

export const SESSION_IPC_CHANNELS = {
  startNewSession: "nicode:session:start-new",
  continueSession: "nicode:session:continue",
  enqueueSessionMessage: "nicode:session:enqueue-message",
  stopSession: "nicode:session:stop",
} as const

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
  createProvider: "nicode:provider:create",
  deleteProvider: "nicode:provider:delete",
  updateApiKey: "nicode:provider:update-api-key",
  createModel: "nicode:provider:create-model",
  updateModel: "nicode:provider:update-model",
  deleteModel: "nicode:provider:delete-model",
  setDefaultModel: "nicode:provider:set-default-model",
} as const

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
  /** 是否是当前有效默认模型。 */
  isDefault: boolean
}

/** 创建 Provider 或 Model 时提交的模型配置；主进程为缺失的 Token 限制补入默认值并生成模型身份。 */
export interface ProviderModelInput {
  /** Provider API 请求中使用的模型名称。 */
  name: string
  /** 声明的上下文窗口；省略或传 null 时创建模型使用 256000。 */
  contextWindow?: number | null
  /** 请求允许的最大输出 Token；省略或传 null 时创建模型使用 32000。 */
  maxOutputTokens?: number | null
  /** 是否支持 reasoning。 */
  supportsReasoning?: boolean
  /** 是否支持工具调用。 */
  supportsTools?: boolean
  /** 是否支持并行工具调用。 */
  supportsParallelTools?: boolean
  /** 是否支持服务端响应 ID。 */
  supportsResponseId?: boolean
}

/** 按 Provider 与全局唯一 modelId 定位的模型引用。 */
export interface ProviderModelReference {
  /** 模型所属 Provider。 */
  providerId: string
  /** 主进程生成的全局唯一模型身份。 */
  modelId: string
}

/** 更新模型名称、必填 Token 限制或能力；名称传 null 表示不修改，能力字段传 null 清除对应可选值。 */
export interface ProviderModelUpdate {
  /** Provider API 请求中使用的非空模型名称；null 表示本次不更新名称。 */
  name?: string | null
  /** 新上下文窗口。 */
  contextWindow?: number
  /** 新最大输出 Token 数。 */
  maxOutputTokens?: number
  /** 新 reasoning 能力；传 null 表示未声明。 */
  supportsReasoning?: boolean | null
  /** 新工具调用能力；传 null 表示未声明。 */
  supportsTools?: boolean | null
  /** 新并行工具调用能力；传 null 表示未声明。 */
  supportsParallelTools?: boolean | null
  /** 新响应 ID 能力；传 null 表示未声明。 */
  supportsResponseId?: boolean | null
}

/** 不含凭据与协议连接参数的 Provider 页面摘要。 */
export interface ProviderSummary {
  /** Provider 稳定身份。 */
  providerId: string
  /** Provider 显示名称。 */
  name: string
  /** 当前 Provider 唯一的协议。 */
  protocol: Protocol
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
   * 创建 Provider、模型记录与 API Key。
   * @param name Provider 显示名称。
   * @param apiKey Provider API Key。
   * @param protocol Provider 使用的唯一协议。
   * @param url Provider 服务地址。
   * @param models 按顺序保存的模型名称与能力配置。
   * @returns 新建 Provider 的无凭据摘要。
   */
  createProvider(
    name: string,
    apiKey: string,
    protocol: Protocol,
    url: string,
    models: ProviderModelInput[],
  ): Promise<ProviderSummary>
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
   * 更新指定模型身份的名称或能力字段。
   * @param reference 要更新的 Provider 与模型引用。
   * @param update 要替换的名称或能力字段；能力字段可传 null 清除或使用默认值。
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
    input: UserMessageInput,
  ): Promise<StartedSessionResponse>
  /**
   * 在指定 Project 分组中恢复已有 Session。
   *
   * @param projectId Session 所属 Project UUID 或 default。
   * @param sessionId 要恢复的 Session 身份。
   * @param input 新 Turn 的用户消息与要先保存到 Session Meta 的模型选择。
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
}

/** Electron contextBridge.exposeInMainWorld 的最小接口。 */
export interface ContextBridgePort {
  exposeInMainWorld(apiKey: string, api: unknown): void
}

export function createSessionApi(ipcRenderer: IpcRendererInvokePort): NiCodePreloadApi {
  return Object.freeze({
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

    async createProvider(
      name: string,
      apiKey: string,
      protocol: Protocol,
      url: string,
      models: ProviderModelInput[],
    ): Promise<ProviderSummary> {
      return requireProviderSummary(await ipcRenderer.invoke(
        PROVIDER_IPC_CHANNELS.createProvider, name, apiKey, protocol, url, models,
      ))
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
      input: UserMessageInput,
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
    !isTextContent(value.content)
  ) {
    throw new TypeError("主进程返回了无效的 Session 消息入队结果")
  }
  return { sessionId: value.sessionId, content: value.content }
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
    (PROTOCOLS as readonly unknown[]).includes(item.protocol) &&
    Array.isArray(item.models) && item.models.every((model: unknown) =>
      isRecord(model) && typeof model.modelId === "string" && model.modelId.trim() !== "" && typeof model.name === "string" && model.name.trim() !== "" &&
      typeof model.contextWindow === "number" && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 &&
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
      typeof value.contextWindow !== "number" || !Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0) {
    throw new TypeError("主进程返回了无效的新建模型")
  }
  return {
    providerId: value.providerId,
    modelId: value.modelId,
    name: value.name,
    contextWindow: value.contextWindow,
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
