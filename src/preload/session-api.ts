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

/** Provider 下模型的页面摘要；name 与 modelId 相同。 */
export interface ModelSummary {
  /** 模型全局唯一身份。 */
  modelId: string
  /** 当前与 modelId 相同的显示名称。 */
  name: string
}

/** 不含凭据和协议连接参数的 Provider 页面摘要。 */
export interface ProviderSummary {
  /** Provider 稳定身份。 */
  providerId: string
  /** Provider 显示名称。 */
  name: string
  /** 按保存顺序排列的模型摘要。 */
  models: ModelSummary[]
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
    async listProjects(): Promise<ProjectSummary[]> {
      return requireProjectSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listProjects))
    },

    async listDefaultSessions(): Promise<SessionSummary[]> {
      return requireSessionSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listDefaultSessions))
    },

    async listProviders(): Promise<ProviderSummary[]> {
      return requireProviderSummaries(await ipcRenderer.invoke(STARTUP_DATA_IPC_CHANNELS.listProviders))
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

/**
 * 检查 Provider 和模型摘要中没有缺失的显示字段。
 * @param value 未经检查的 IPC 结果。
 * @returns 已检查的 Provider 摘要数组。
 * @throws TypeError 当结果缺少必需字段时抛出。
 */
function requireProviderSummaries(value: unknown): ProviderSummary[] {
  if (!Array.isArray(value) || !value.every((item) =>
    isRecord(item) && typeof item.providerId === "string" && typeof item.name === "string" &&
    Array.isArray(item.models) && item.models.every((model: unknown) =>
      isRecord(model) && typeof model.modelId === "string" && typeof model.name === "string")
  )) throw new TypeError("主进程返回了无效的 Provider 列表")
  return value as ProviderSummary[]
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
