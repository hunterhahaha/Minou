/**
 * SessionRuntime 的活动实例、消息队列与两个 Turn 入口（架构备忘录第 13.1、13.2 节）。
 *
 * SessionRuntime 绑定一个 Session 的 Event Log、派生状态、消息队列与持久化事件流；本文件实现
 * 第 10 节确定的 Event Log 校验与补写顺序，并以 FIFO 串行启动后续 Turn。
 * appendTurnStartAndUserMessage 必须在一个持久化批次中提交两条事件；失败不能启动 Loop。
 * 当前 runAgentLoop 只负责 Step，Turn 收尾仍由调用方处理。
 */

import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { CANCELLED, normalizeError } from "../../error/src/normalizer.ts"
import type { AppError } from "../../error/src/types.ts"
import type {
  ModelMessage,
  ModelRef,
  ModelTextBlock,
} from "../../model/src/types.ts"
import type {
  ApprovalRequestEvent,
  ApprovalResultEvent,
  AssistantBlockDeltaEvent,
  AssistantBlockEndEvent,
  AssistantBlockStartEvent,
  AssistantMessageEvent,
  SessionEvent,
  SessionEventInput,
  StepStartEvent,
  ToolResultEvent,
  TurnStartEvent,
  UserMessageEvent,
  SkillContextChange,
  TurnStartEventInput,
  UserMessageInput,
  UserMessageEventInput,
} from "../../session/src/events.ts"
import { createFileSessionEventLog } from "../../session/src/event-log.ts"
import type { FileSessionEventLog } from "../../session/src/event-log.ts"
import { createFileSessionState } from "../../session/src/session-state.ts"
import { TurnFileChangeTracker } from "../../session/src/file-changes.ts"
import type { ApprovalDecision, FileChange } from "../../session/src/events.ts"
import type {
  CurrentSessionBaseline,
  FileSessionState,
  SessionSkillContextEntry,
  SandboxMode,
  SessionSettingsPatch,
} from "../../session/src/session-state.ts"
import type { ToolExecutionContext, ToolResult } from "../../tools/src/types.ts"
import { runAgentLoop } from "./loop.ts"
import type { AgentLoopOptions, AgentLoopResult } from "./loop.ts"
import type { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"

/** 单个 SessionRuntime 的身份、存储位置和全局能力。 */
export interface SessionRuntimeOptions {
  /** 当前实例绑定的唯一 Session ID。 */
  sessionId: string
  /** 当前 Session 的绝对目录。 */
  sessionDirectory: string
  /** 所属 Project UUID 或 default。 */
  projectGroupId: string
  /** Session Event Log 数据库路径。 */
  databasePath: string
  /** Session Meta 数据库路径。 */
  metaDatabasePath: string
  /** 每个 Turn 的基础 System Prompt。 */
  systemPrompt: string
  /** 启动时创建、所有 Session 共用的具体能力对象。 */
  global: SessionRuntimeGlobal
  /** 测试或宿主控制事件时间的入口。 */
  now?: () => Date
  /** 测试或宿主控制事件 ID 的入口。 */
  createEventId?: () => string
  /** Queue、停止和关闭变化时通知宿主；回调不得抛出或等待模型执行。 */
  onStateChanged?: () => void
}

/**
 * 组合当前 Turn 唯一的固定 System Message。
 *
 * @param systemPrompt Agent 的基础系统设定。
 * @param workspaceInfo 当前 Project/default 的工作区说明。
 * @param baseline 与 Turn 开始增量检查相同的 AGENTS.md / Skill 基线。
 * @returns 以双换行分隔非空部分的 System Message。
 */
function composeSystemMessage(
  systemPrompt: string,
  workspaceInfo: string,
  baseline: CurrentSessionBaseline,
): string {
  if (!isAbsolute(baseline.agentsmd.path)) {
    throw new Error(`当前 Session 基线的 AGENTS.md 路径不是绝对路径：${baseline.agentsmd.path}`)
  }
  for (const entry of baseline.skills.entries) {
    if (typeof baseline.skills.descriptions[entry.name] !== "string") {
      throw new Error(`当前 Session 基线缺少 Skill description：${entry.name}`)
    }
  }
  return [systemPrompt, workspaceInfo, baseline.agentsmd.content, baseline.skills.content]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

/**
 * 按架构第 11.3 节把权威 Session Event 回放为模型上下文。
 *
 * @param events 已通过结构、生命周期、Block 与 Summary 校验的事件。
 * @param systemMessage 当前 Turn 新建的固定 System Message。
 * @returns 首项为 System Message、其余按日志顺序排列的模型消息。
 */
function replayModelContent(
  events: readonly SessionEvent[],
  systemMessage: string,
): ModelMessage[] {
  const content: ModelMessage[] = [{ role: "system", content: systemMessage }]
  const summary = events
    .filter((event) => event.type === "summary/end")
    .sort((left, right) => left.seq - right.seq)
    .at(-1)
  const throughEventSeq = summary?.throughEventSeq ?? 0
  if (summary !== undefined) content.push({ role: "user", content: summary.summary })

  for (const event of events) {
    if (event.seq <= throughEventSeq) continue
    switch (event.type) {
      case "context_update":
        content.push({ role: "user", content: event.content })
        break
      case "user/message":
        content.push({
          role: "user",
          content: event.message.content.map((block) => ({ ...block })),
        })
        break
      case "assistant/message":
        content.push({
          role: "assistant",
          content: structuredClone(event.message.content),
        })
        break
      case "tool/result":
        content.push({
          role: "tool",
          toolCallId: event.toolCallId,
          content: event.result.content
            .filter((block): block is ModelTextBlock => block.type === "text")
            .map((block) => ({ ...block })),
          isError: event.result.status === "error",
        })
        break
    }
  }
  return content
}

/**
 * 按第 12.3 节比较当前有效 Skills 与 Session 已保存比较状态。
 *
 * @param current 当前实际启用的有效 Skill，顺序即新增/替换事件顺序。
 * @param previous `meta.skills.entries` 中的历史比较状态。
 * @param descriptions 当前有效 Skill 的预算后 description。
 * @returns 应写入同一条 `context_update` 的有序 changes。
 */
function collectSkillChanges(
  current: readonly SessionSkillContextEntry[],
  previous: readonly SessionSkillContextEntry[],
  descriptions: Readonly<Record<string, string>>,
): SkillContextChange[] {
  const changes: SkillContextChange[] = []
  const currentByName = new Map(current.filter((entry) => entry.enabled).map((entry) => [entry.name, entry]))
  const previousByName = new Map(previous.map((entry) => [entry.name, entry]))

  for (const entry of current) {
    if (!entry.enabled) continue
    const old = previousByName.get(entry.name)
    const description = descriptions[entry.name]
    if (typeof description !== "string") {
      throw new Error(`当前 Session 基线缺少 Skill description：${entry.name}`)
    }
    if (old === undefined) {
      changes.push({ type: "new", name: entry.name, scope: entry.scope, description })
      continue
    }
    if (old.scope === entry.scope) {
      if (!old.enabled) changes.push({ type: "enabled", name: entry.name })
      continue
    }
    if (entry.scope === "project" && old.scope === "global") {
      changes.push({
        type: "replaced",
        name: entry.name,
        fromScope: old.scope,
        toScope: entry.scope,
        description,
      })
    }
  }

  for (const old of previous) {
    if (old.enabled && !currentByName.has(old.name)) {
      changes.push({ type: "disabled", name: old.name })
    }
  }
  return changes
}

/**
 * 把 AGENTS.md 的零上下文行差异格式化为模型可见增量。
 *
 * @param oldContent Session 比较快照。
 * @param newContent 当前 AGENTS.md 完整内容。
 * @returns 按连续差异 hunk 组织的 `<agents_md_update>` 文本。
 */
function formatAgentsMdUpdate(oldContent: string, newContent: string): string {
  const changes = diffLineHunks(splitLines(oldContent), splitLines(newContent))
  const hunks = changes.map((change) => {
    const sections: string[] = []
    if (change.removed.length > 0) sections.push(`Removed:\n${change.removed.join("\n")}`)
    if (change.added.length > 0) sections.push(`Added:\n${change.added.join("\n")}`)
    return `<change>\n${sections.join("\n\n")}\n</change>`
  })
  return [
    "<agents_md_update>",
    "",
    "The project's AGENTS.md has changed.",
    "",
    hunks.join("\n\n"),
    "",
    "</agents_md_update>",
  ].join("\n")
}

/** @param content 待按行比较的文本。 */
function splitLines(content: string): string[] {
  if (content === "") return []
  const normalized = content.replace(/\r\n/g, "\n")
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n")
}

/**
 * 使用最长公共子序列生成零上下文的连续行差异 hunk。
 *
 * @param oldLines 旧文本行。
 * @param newLines 新文本行。
 * @returns 每个连续差异区域的删除行与新增行。
 */
function diffLineHunks(
  oldLines: readonly string[],
  newLines: readonly string[],
): Array<{ removed: string[]; added: string[] }> {
  const columns = newLines.length + 1
  const table = new Uint32Array((oldLines.length + 1) * columns)
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * columns + newIndex
      table[offset] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * columns + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * columns + newIndex], table[offset + 1])
    }
  }

  const operations: Array<{ type: "equal" | "remove" | "add"; line: string }> = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length
      && newIndex < newLines.length
      && oldLines[oldIndex] === newLines[newIndex]
    ) {
      operations.push({ type: "equal", line: oldLines[oldIndex] })
      oldIndex += 1
      newIndex += 1
    } else if (
      oldIndex < oldLines.length
      && (
        newIndex >= newLines.length
        || table[(oldIndex + 1) * columns + newIndex] >= table[oldIndex * columns + newIndex + 1]
      )
    ) {
      operations.push({ type: "remove", line: oldLines[oldIndex] })
      oldIndex += 1
    } else {
      operations.push({ type: "add", line: newLines[newIndex] })
      newIndex += 1
    }
  }

  const hunks: Array<{ removed: string[]; added: string[] }> = []
  let current: { removed: string[]; added: string[] } | undefined
  for (const operation of operations) {
    if (operation.type === "equal") {
      if (current !== undefined) hunks.push(current)
      current = undefined
      continue
    }
    current ??= { removed: [], added: [] }
    if (operation.type === "remove") current.removed.push(operation.line)
    else current.added.push(operation.line)
  }
  if (current !== undefined) hunks.push(current)
  return hunks
}

/** @param sessionId 要绑定到磁盘路径的 Session ID。 */
function validateRuntimeSessionId(sessionId: string): void {
  if (
    sessionId.trim() === ""
    || sessionId === "."
    || sessionId === ".."
    || sessionId.includes("/")
    || sessionId.includes("\\")
  ) {
    throw new Error(`Session ID 必须是不含路径分隔符的非空目录名：${sessionId}`)
  }
}

/** 运行中追加消息成功后的 Renderer 可序列化确认。 */
export interface EnqueuedSessionMessageResponse {
  /** 接收消息的活动 Session。 */
  sessionId: string
  /** 随后写入 user/message.message.id 的稳定消息身份。 */
  messageId: string
  /** 已复制并加入后端内存队列的消息内容。 */
  content: ModelTextBlock[]
}

/** Session 活动期的消息消费任务。 */
export interface SessionRuntimeProcessing {
  /** 队首消息成功提交为新 Turn 后解析；新建 Session 则立即指向已启动首轮。 */
  started: Promise<StartedSessionTurn>
  /** 队列耗尽、停止或失败时结束的整个活动期任务。 */
  completion: Promise<void>
}

export interface StartedSessionTurn {
  /** 新创建或继续运行的 Session ID。 */
  sessionId: string
  /** 已提交并正在运行的 Turn 编号。 */
  turn: number
  /** 当前活动 Session 中所有已成功持久化事件的单消费者异步流。 */
  events: AsyncIterable<SessionEvent>
  /** 成批提交新 Turn 后启动；调用方需等待并处理运行结果或错误。 */
  completion: Promise<AgentLoopResult>
}

export interface ContinueSessionInput {
  /** 要写入新 Turn 的用户文本内容。 */
  content: ModelTextBlock[]
  /** 要先保存到 Session Meta、再独立重读用于本 Turn 的模型选择。 */
  model: ModelRef
}

/** 运行中 Queue 使用的 content-only 输入；队列不捕获模型选择。 */
export interface EnqueueSessionMessageInput {
  /** 真正开始下一 Turn 时才与当时磁盘模型组合的用户文本。 */
  content: ModelTextBlock[]
}

/** 新对话的消息及首轮工具执行前保存的权限选择。 */
export interface StartNewSessionInput extends UserMessageInput {
  /** 省略时沿用 SessionState 的默认模式。 */
  sandboxMode?: SandboxMode
}

/** 后端尚未提交到 Event Log 的 Queue 消息。 */
export interface PendingSessionMessage extends EnqueueSessionMessageInput {
  /** 提交时复用为用户消息 ID。 */
  messageId: string
  /** 队列等待或首批事件准备中的状态。 */
  status: "queued" | "starting"
}

/** 宿主查询使用的快照；事件事实与内存活动状态分开保存。 */
export interface SessionRuntimeSnapshot {
  /** 查询时已经提交的事件。 */
  events: SessionEvent[]
  /** 当前 Meta 中的名称和设置。 */
  settings: { name: string; currentModel: ModelRef; sandboxMode: SandboxMode }
  /** 活动实例的状态；临时历史实例为 idle。 */
  phase: "idle" | "running" | "stopping"
  /** 活动或最近提交的 Turn。 */
  currentTurn?: number
  /** 应用内存状态前需要取得的事件序号。 */
  throughSeq: number
  /** 尚未提交的 Queue 消息。 */
  pendingMessages: PendingSessionMessage[]
  /** 关闭时丢弃的消息，仅在本实例内存中保留。 */
  discardedMessages: PendingSessionMessage[]
}

/** `repairSession` 读取和修复 Event Log 所需的最小持久化端口。 */
export interface SessionRepairPorts {
  /**
   * 检查 Session 目录并返回逐行解析后的 Event Log；缺失目录或日志时应拒绝。
   *
   * @returns 尚未信任、需要本文件校验的事件值集合。
   */
  readEvents(): Promise<readonly unknown[]>
  /**
   * 幂等补齐首次初始化可能缺失的 Session 派生文件。
   *
   */
  initializeSession(): Promise<void>
  /**
   * 根据已校验的日志修复 meta / contextstate / snapshot 等派生状态。
   * 该端口不得改写 Event Log。
   *
   * @param events 已通过 Event Log 结构和生命周期校验的事件。
   */
  repairDerivedState(events: readonly SessionEvent[]): Promise<void>
  /**
   * 追加一条恢复事件并返回已经分配身份、成功落盘的事件。
   *
   * @param event 要追加的恢复事件输入。
   * @returns 已分配 eventId、seq 等身份并持久化的完整事件。
   */
  appendEvent(event: SessionEventInput): Promise<SessionEvent>
}

/**
 * 单个活动 Session 的持久化、Turn、消息队列和事件流。
 *
 * 实例从创建起只服务 `sessionId` 指定的 Session。首次或继续入口由主进程启动，之后运行期间收到的
 * 消息进入当前实例的 FIFO 队列；消费循环在每个 Turn 完整结束后才会启动下一条消息。
 */
export class SessionRuntime implements SessionRepairPorts {
  /** 当前实例唯一绑定的 Session ID。 */
  readonly sessionId: string
  /** 当前活动期已经持久化的 Session 事件流。 */
  readonly events: AsyncIterable<SessionEvent>
  private readonly sessionDirectory: string
  private readonly projectGroupId: string
  private readonly eventLog: FileSessionEventLog
  private readonly sessionState: FileSessionState
  private readonly systemPrompt: string
  private readonly projectContext: ReturnType<SessionRuntimeGlobal["resolveProjectContext"]>
  /** 启动期创建一次并由所有 Session 共用的能力对象。 */
  private readonly global: SessionRuntimeGlobal
  private turnBaseline: Promise<CurrentSessionBaseline> | undefined
  private readonly abortController = new AbortController()
  private readonly eventStream = new SessionEventStream()
  private readonly pendingMessages: PendingSessionMessage[] = []
  private startingMessage: PendingSessionMessage | undefined
  private discardedMessages: PendingSessionMessage[] = []
  private initialization: Promise<void> | undefined
  private lastCommittedSeq = 0
  private readonly onStateChanged: (() => void) | undefined
  private readonly fileTrackers = new Map<number, TurnFileChangeTracker>()
  private readonly pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>()
  private approvalTail: Promise<void> = Promise.resolve()
  private processing = false
  private closed = false
  private activeTurn: number | undefined

  /**
   * 生成新 Session 使用的随机 ID。
   *
   * @returns 可用于 Session 目录名与事件身份的 UUID。
   */
  static createSessionId(): string {
    return randomUUID()
  }

  /**
   * 为一个 Session 创建活动 Runtime 和其持久化资源。
   * @param options Session 身份、目录、数据库及启动期共享能力。
   * @throws Error Session ID 或目录无效，或 Project 上下文无法解析。
   */
  constructor(options: SessionRuntimeOptions) {
    validateRuntimeSessionId(options.sessionId)
    if (!isAbsolute(options.sessionDirectory)) {
      throw new Error("Session 目录必须是绝对路径：" + options.sessionDirectory)
    }
    this.sessionId = options.sessionId
    this.sessionDirectory = resolve(options.sessionDirectory)
    this.projectGroupId = options.projectGroupId
    this.systemPrompt = options.systemPrompt
    this.global = options.global
    this.onStateChanged = options.onStateChanged
    this.projectContext = this.global.resolveProjectContext(options.projectGroupId)
    this.events = this.eventStream
    this.eventLog = createFileSessionEventLog({
      sessionId: this.sessionId,
      sessionDirectory: this.sessionDirectory,
      projectGroupId: this.projectGroupId,
      databasePath: options.databasePath,
      now: options.now,
      createEventId: options.createEventId,
    })
    this.sessionState = createFileSessionState({
      projectId: this.projectGroupId,
      sessionId: this.sessionId,
      sessionDirectory: this.sessionDirectory,
      databasePath: options.databasePath,
      metaDatabasePath: options.metaDatabasePath,
      readEvents: () => this.eventLog.readEvents(),
      resolveCurrentBaseline: () => this.resolveTurnBaseline(),
      estimateSkillTokens: (description) => this.global.estimateSkillTokens(description),
    })
  }

  /** @returns 当前正在执行或最近一次启动的 Turn，供宿主关联后台错误。 */
  get currentTurn(): number | undefined {
    return this.activeTurn
  }

  /**
   * 在目标 Project/default 分组下创建当前 Session 目录。
   * @returns 目录创建完成时解析。
   * @throws Error 目录已存在、父目录缺失或实例已关闭。
   */
  async createSessionDirectory(): Promise<void> {
    this.assertOpen()
    await mkdir(this.sessionDirectory, { recursive: false }).catch((error: unknown) => {
      throw new Error("无法创建 Session 目录：" + this.sessionDirectory, { cause: error })
    })
  }

  /**
   * 原子提交新 Turn 的首批事件，并在成功后依次发布。
   * @param events 顺序固定的 turn/start 与 user/message。
   * @returns 已持久化的两条事件。
   * @throws Error 持久化失败或实例已关闭。
   */
  async appendTurnStartAndUserMessage(
    events: readonly [TurnStartEventInput, UserMessageEventInput],
  ): Promise<readonly [TurnStartEvent, UserMessageEvent]> {
    this.assertOpen()
    const written = await this.eventLog.appendTurnStartAndUserMessage(events)
    this.activeTurn = written[0].turn
    this.publishPersistedEvent(written[0], "turn/start")
    this.publishPersistedEvent(written[1], "user/message")
    this.startingMessage = undefined
    this.onStateChanged?.()
    return written
  }

  /**
   * 读取尚待恢复流程校验的 Event Log。
   * @returns 当前日志事件。
   * @throws Error 日志不可读或实例已关闭。
   */
  readEvents(): Promise<readonly unknown[]> {
    this.assertOpen()
    return this.eventLog.readEvents()
  }

  /**
   * 首批事件提交后补齐派生状态。
   * @returns 初始化完成时解析。
   * @throws Error 派生状态初始化失败或实例已关闭。
   */
  initializeSession(): Promise<void> {
    this.assertOpen()
    return this.sessionState.initializeSession()
  }

  /**
   * 根据已校验的日志修复派生状态。
   * @param events 通过恢复算法校验的事件。
   * @returns 派生状态修复完成时解析。
   * @throws Error 修复失败或实例已关闭。
   */
  repairDerivedState(events: readonly SessionEvent[]): Promise<void> {
    this.assertOpen()
    return this.sessionState.repairDerivedState(events)
  }

  /**
   * 修复本 Session 后返回最后一个 Turn 编号。
   * @returns 恢复前日志中的最后 Turn 编号。
   * @throws SessionLogCorruptedError 日志不一致时抛出。
   */
  repairSession(): Promise<{ lastTurn: number }> {
    this.assertOpen()
    return repairSession(this.sessionId, this)
  }

  /**
   * 执行已有 Session 的 AGENTS.md / Skill 比较和提交。
   * @returns 基线变化提交并修复派生状态后解析。
   * @throws Error 日志不一致或提交失败。
   */
  prepareExistingTurn(): Promise<void> {
    this.assertOpen()
    return this.prepareExistingTurnInternal()
  }

  /**
   * 为当前开放 Turn 构建模型上下文。
   * @param turn 要构建上下文的 Turn 编号。
   * @returns AgentLoop 使用的模型消息。
   * @throws Error Turn 非当前开放 Turn 或日志损坏。
   */
  async buildContent(turn: number): Promise<ModelMessage[]> {
    this.assertOpen()
    const baseline = await this.resolveTurnBaseline()
    const events = validateEventLog(this.sessionId, await this.eventLog.readEvents())
    const lifecycle = validateLifecycle(this.sessionId, events)
    validateBlockStreams(this.sessionId, events)
    validateSummaries(this.sessionId, events)
    if (lifecycle.lastTurn !== turn || lifecycle.openTurn !== turn) {
      throw new Error("无法为非当前开放 Turn 构建 Context：期望 " +
        (lifecycle.openTurn ?? "无") + "，实际 " + turn)
    }
    return replayModelContent(events, composeSystemMessage(
      this.systemPrompt,
      this.projectContext.workspaceInfo,
      baseline,
    ))
  }

  /**
   * 将模型选择写入本 Session Meta。
   * @param model 要保存的模型选择。
   * @returns 写入完成时解析。
   */
  writeCurrentModel(model: ModelRef): Promise<void> {
    this.assertOpen()
    return this.sessionState.writeCurrentModel(model)
  }

  /**
   * 从本 Session Meta 重新读取模型选择。
   * @returns 当前持久化的模型引用。
   */
  readCurrentModel(): Promise<ModelRef> {
    this.assertOpen()
    return this.sessionState.readCurrentModel()
  }

  /**
   * 查询已提交事件与当前设置；活动查询不执行异常恢复，关闭后的实例仍可读取最终快照。
   * @returns 事件数组、当前设置与 Queue 状态的脱离引用快照。
   * @throws Error 当初始化、日志或 Meta 不可读时抛出。
   */
  async readSnapshot(): Promise<SessionRuntimeSnapshot> {
    await this.initialization?.catch(() => {})
    const settings = await this.sessionState.readSettings()
    const events = validateEventLog(this.sessionId, await this.eventLog.readEvents())
    return {
      events: structuredClone(events), settings,
      phase: this.closed || (!this.processing && this.activeTurn === undefined)
        ? "idle" : this.abortController.signal.aborted ? "stopping" : "running",
      currentTurn: this.closed ? undefined : this.activeTurn,
      throughSeq: Math.max(this.lastCommittedSeq, events.at(-1)?.seq ?? 0),
      pendingMessages: structuredClone([
        ...(this.startingMessage === undefined ? [] : [this.startingMessage]), ...this.pendingMessages,
      ]),
      discardedMessages: structuredClone(this.discardedMessages),
    }
  }

  /**
   * 等待首次设置初始化后修改 Meta；模型选择不影响当前 Turn 的 Adapter。
   * @param patch 模型或沙箱模式的部分更新。
   * @throws Error 当初始化或设置写入失败时抛出。
   */
  async updateSettings(patch: SessionSettingsPatch): Promise<void> {
    this.assertOpen()
    await this.initialization
    await this.sessionState.writeSettings(patch)
    this.onStateChanged?.()
  }

  /**
   * 组装本 Turn 的模型、工具、事件与取消边界。
   * @param model 本 Turn 固定的模型选择。
   * @returns 本 Turn 的 AgentLoop 运行资源。
   * @throws Error Adapter 创建失败或实例已关闭。
   */
  async createLoopOptions(
    model: ModelRef,
  ): Promise<Omit<AgentLoopOptions, "turn" | "model" | "content">> {
    this.assertOpen()
    const adapter = await this.global.createTurnModelAdapter(structuredClone(model))
    return {
      adapter,
      tools: this.global.listToolDefinitions(),
      executeTool: (name, args, context) => this.global.executeTool(name, args, {
        ...context,
        projectId: this.projectGroupId,
        fileRuntime: {
          projectId: this.projectGroupId,
          sessionId: this.sessionId,
          tracker: this.trackerFor(context.turn),
          requestApproval: (toolName, path, execution) => this.requestToolApproval(toolName, `文件路径需要授权：${path}`, execution),
        },
        processRuntime: {
          projectId: this.projectGroupId,
          sessionId: this.sessionId,
          outputDirectory: join(this.sessionDirectory, "tool_output"),
          requestApproval: (toolName, reason, execution) => this.requestToolApproval(toolName, reason, execution),
        },
      }),
      signal: this.abortController.signal,
      appendEvent: (event) => this.appendEvent(event),
    }
  }

  /**
   * 追加并发布当前 Session 的一条完整事件。
   *
   * @param event 尚未分配持久化身份的事件输入。
   * @returns 已成功写入 Event Log 的完整事件。
   */
  async appendEvent(event: SessionEventInput): Promise<SessionEvent> {
    this.assertOpen()
    const written = await this.eventLog.appendEvent(event)
    this.publishPersistedEvent(written, event.type)
    return written
  }

  /**
   * 为 Renderer IPC 提交等待中的人工审批决定。
   * @param approvalId 审批请求事件的身份。
   * @param decision 用户明确作出的允许或拒绝决定。
   * @returns 找到当前等待请求时为 true。
   */
  decideApproval(approvalId: string, decision: "approved" | "denied"): boolean {
    const resolve = this.pendingApprovals.get(approvalId)
    if (resolve === undefined) return false
    this.pendingApprovals.delete(approvalId)
    resolve(decision)
    return true
  }

  /**
   * 在 turn/end 前持久化当前 Turn 的文件净变化。
   * @param turn 当前已完成执行的 Turn。
   * @returns 实际写入的文件变化；无净变化时为空。
   */
  async appendTurnFileChanges(turn: number): Promise<FileChange[]> {
    const tracker = this.fileTrackers.get(turn)
    if (tracker === undefined) return []
    const files = tracker.summarize()
    if (files.length > 0) await this.appendEvent({ type: "turn/file_changes", turn, files })
    this.fileTrackers.delete(turn)
    return files
  }

  /** @param turn 当前 Turn。 @returns 该 Turn 唯一的临时文件追踪器。 */
  private trackerFor(turn: number): TurnFileChangeTracker {
    let tracker = this.fileTrackers.get(turn)
    if (tracker === undefined) {
      tracker = new TurnFileChangeTracker()
      this.fileTrackers.set(turn, tracker)
    }
    return tracker
  }

  /**
   * 顺序写入审批请求、等待外部决定或 Stop，再写入审批结果。
   * @param toolName 待审批工具。
   * @param reason 工具提供的审批说明；文件调用包含已规范化路径。
   * @param context 完整的调用身份与参数。
   * @returns 明确决定或取消。
   */
  private async requestToolApproval(
    toolName: string,
    reason: string,
    context: ToolExecutionContext<object>,
  ): Promise<ApprovalDecision> {
    const previous = this.approvalTail
    let release!: () => void
    this.approvalTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (context.signal.aborted) return "cancelled"
      if (context.toolCallEventId === undefined) throw new Error("审批缺少工具调用事件身份")
      const approvalId = randomUUID()
      let settle!: (value: ApprovalDecision) => void
      const response = new Promise<ApprovalDecision>((resolve) => { settle = resolve })
      const abort = () => {
        this.pendingApprovals.delete(approvalId)
        settle("cancelled")
      }
      this.pendingApprovals.set(approvalId, (value) => {
        context.signal.removeEventListener("abort", abort)
        settle(value)
      })
      context.signal.addEventListener("abort", abort, { once: true })
      try {
        await this.appendEvent({
          type: "approval/request", turn: context.turn, step: context.step,
          approvalId, toolCallEventId: context.toolCallEventId,
          toolCallId: context.toolCallId, blockId: context.blockId,
          toolName, arguments: context.validatedArguments,
          reason,
        })
      } catch (error) {
        this.pendingApprovals.delete(approvalId)
        context.signal.removeEventListener("abort", abort)
        throw error
      }
      if (context.signal.aborted) abort()
      const decision = await response
      await this.appendEvent({ type: "approval/result", turn: context.turn, step: context.step, approvalId, decision })
      return decision
    } finally { release() }
  }

  /**
   * 把运行中的新用户消息复制后加入当前 Session 的 FIFO 队列。
   *
   * @param input 用户文本内容；队列不保存模型或 Turn。
   * @returns Renderer 可保存到内存队列的确认数据。
   * @throws Error 当前实例已经关闭或正在停止时抛出。
   */
  enqueueSessionMessage(input: EnqueueSessionMessageInput): EnqueuedSessionMessageResponse {
    this.assertOpen()
    if (this.abortController.signal.aborted) {
      throw new Error(`Session 正在停止，不能追加消息：${this.sessionId}`)
    }
    const queued: PendingSessionMessage = {
      messageId: randomUUID(), content: cloneMessageContent(input.content), status: "queued",
    }
    this.pendingMessages.push(queued)
    this.onStateChanged?.()
    return { sessionId: this.sessionId, messageId: queued.messageId, content: cloneMessageContent(queued.content) }
  }

  /**
   * 启动当前活动期唯一的消息消费循环。
   *
   * 新 Session 传入已经启动的首轮；已有 Session 省略它，并要求调用前已经把首条消息放入队列。
   * 每个 Turn 完整结束后才会读取下一条消息。stopped、error 或队列耗尽都会关闭实例与事件流。
   *
   * @param initialTurn 新建 Session 已经启动的首轮；已有 Session 省略。
   * @returns 首个已启动 Turn 与整个活动期的完成 Promise。
   * @throws Error 当前实例已处理过队列，或已有 Session 的初始队列为空时抛出。
   */
  processMessageQueue(initialTurn?: StartedSessionTurn): SessionRuntimeProcessing {
    this.assertOpen()
    if (this.processing) {
      throw new Error(`Session 消息队列已经在处理：${this.sessionId}`)
    }
    if (initialTurn === undefined && this.pendingMessages.length === 0) {
      throw new Error(`Session 消息队列为空，无法启动：${this.sessionId}`)
    }
    if (initialTurn !== undefined && initialTurn.sessionId !== this.sessionId) {
      throw new Error(
        `首轮属于其它 Session：${initialTurn.sessionId}，当前实例为 ${this.sessionId}`,
      )
    }
    this.processing = true
    let resolveStarted!: (started: StartedSessionTurn) => void
    let rejectStarted!: (error: unknown) => void
    const started = initialTurn === undefined
      ? new Promise<StartedSessionTurn>((resolve, reject) => {
        resolveStarted = resolve
        rejectStarted = reject
      })
      : Promise.resolve(initialTurn)

    const completion = this.consumeMessageQueue(
      initialTurn,
      initialTurn === undefined ? resolveStarted : undefined,
      initialTurn === undefined ? rejectStarted : undefined,
    ).finally(() => {
      this.close()
    })

    return { started, completion }
  }

  /**
   * 停止当前 Session Runtime 活动期。
   *
   * 同一实例中的所有 Turn / Loop 观察同一个信号；首次调用会使其永久进入
   * aborted 状态，并向此对话全部活动 PTY 发送一次 Ctrl+C；终端状态仍等待后端完成标记。
   * 重复停止或实例已关闭时不产生额外效果。
   */
  stop(): void {
    if (this.closed || this.abortController.signal.aborted) return
    this.abortController.abort()
    const failures = this.global.interruptTerminals(this.projectGroupId, this.sessionId)
    for (const error of failures) console.error("PTY Ctrl+C 发送失败：", error)
    this.onStateChanged?.()
  }

  /**
   * 关闭当前活动实例，丢弃尚未启动的消息并结束事件流。
   * 重复关闭不会产生额外效果。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.discardedMessages = structuredClone([
      ...(this.startingMessage === undefined ? [] : [this.startingMessage]), ...this.pendingMessages,
    ])
    this.startingMessage = undefined
    this.pendingMessages.length = 0
    this.eventStream.close()
    this.onStateChanged?.()
  }

  private async consumeMessageQueue(
    initialTurn: StartedSessionTurn | undefined,
    resolveStarted: ((started: StartedSessionTurn) => void) | undefined,
    rejectStarted: ((error: unknown) => void) | undefined,
  ): Promise<void> {
    let current = initialTurn
    try {
      while (true) {
        if (current === undefined) {
          const input = this.pendingMessages.shift()
          if (input === undefined) return
          this.startingMessage = { ...input, status: "starting" }
          this.onStateChanged?.()
          current = await this.continueQueuedSession(input)
          resolveStarted?.(current)
          resolveStarted = undefined
          rejectStarted = undefined
        }

        this.activeTurn = current.turn
        const result = await current.completion
        if (result.stopped || this.abortController.signal.aborted) return

        current = undefined
        if (this.pendingMessages.length === 0) return
      }
    } catch (error) {
      rejectStarted?.(error)
      throw error
    }
  }

  /**
   * 读取并缓存本 Turn 的同一份上下文基线。
   * @returns 当前 Turn 的固定 AGENTS.md、Skill 和 MCP 基线。
   */
  private resolveTurnBaseline(): Promise<CurrentSessionBaseline> {
    if (this.turnBaseline === undefined) {
      this.turnBaseline = this.projectContext.resolveCurrentBaseline()
        .then((baseline) => structuredClone(baseline))
    }
    return this.turnBaseline
  }

  /**
   * 比较已有 Session 的基线，先提交变化事件再推进派生状态。
   * @returns 比较及提交完成时解析。
   * @throws Error 日志未恢复到闭合状态或持久化失败。
   */
  private async prepareExistingTurnInternal(): Promise<void> {
    const events = validateEventLog(this.sessionId, await this.eventLog.readEvents())
    const lifecycle = validateLifecycle(this.sessionId, events)
    if (lifecycle.openTurn !== undefined || lifecycle.openStep !== undefined) {
      throw new Error(`Session 尚未恢复到一致状态，不能准备下一 Turn：${this.sessionId}`)
    }
    validateBlockStreams(this.sessionId, events)
    validateSummaries(this.sessionId, events)

    this.turnBaseline = this.projectContext.resolveCurrentBaseline().then((baseline) => structuredClone(baseline))
    const baseline = await this.turnBaseline
    const comparison = await this.sessionState.readContextComparisonState()
    const turn = lifecycle.lastTurn + 1
    const appended: SessionEvent[] = []

    if (comparison.agentsSnapshot !== baseline.agentsmd.content) {
      const written = await this.appendEvent({
        type: "context_update",
        turn,
        source: {
          type: "agents_md",
          path: baseline.agentsmd.path,
          hash: baseline.agentsmd.hash,
          fullContent: baseline.agentsmd.content,
        },
        content: formatAgentsMdUpdate(comparison.agentsSnapshot, baseline.agentsmd.content),
      })
      appended.push(written)
    }

    const skillChanges = collectSkillChanges(
      baseline.skills.entries,
      comparison.skills.entries,
      baseline.skills.descriptions,
    )
    if (skillChanges.length > 0) {
      const written = await this.appendEvent({
        type: "context_update",
        turn,
        source: { type: "skill", changes: skillChanges },
        content: `<skills_update>\n${JSON.stringify(skillChanges, null, 2)}\n</skills_update>`,
      })
      appended.push(written)
    }

    if (appended.length > 0) {
      await this.sessionState.repairDerivedState([...events, ...appended])
    }
  }

  /**
   * 首次提交并启动本 Session 的首个 Turn。
   * @param input 首个用户消息和模型选择。
   * @returns 已提交的 Turn 身份、事件流与后台运行任务。
   * @throws Error 目录创建或首批事件提交失败。
   */
  async startNewSession(input: StartNewSessionInput): Promise<StartedSessionTurn> {
    const turn = 1
    await this.createSessionDirectory()
    await this.appendTurnStartAndUserMessage(turnEvents(turn, input.model, input.content))
    const completion = this.runCommittedTurn(turn, async () => {
      this.initialization = (async () => {
        await this.initializeSession()
        await this.writeCurrentModel(input.model)
        if (input.sandboxMode !== undefined) await this.sessionState.writeSettings({ sandboxMode: input.sandboxMode })
      })()
      await this.initialization
      this.onStateChanged?.()
      const model = await this.readCurrentModel()
      const loopOptions = await this.createLoopOptions(model)
      return this.startLoop(turn, model, loopOptions)
    })
    return { sessionId: this.sessionId, turn, events: this.events, completion }
  }

  /**
   * 修复已有 Session，提交并启动下一 Turn。
   * @param input 下一 Turn 的用户消息和模型选择。
   * @returns 已提交的 Turn 身份、事件流与后台运行任务。
   * @throws Error 恢复、基线检查、Adapter 创建或首批提交失败。
   */
  async continueSession(input: ContinueSessionInput): Promise<StartedSessionTurn> {
    const state = await this.repairSession()
    await this.prepareExistingTurn()
    await this.writeCurrentModel(input.model)
    const model = await this.readCurrentModel()
    const loopOptions = await this.createLoopOptions(model)
    const turn = state.lastTurn + 1
    await this.appendTurnStartAndUserMessage(turnEvents(turn, model, input.content))
    return {
      sessionId: this.sessionId,
      turn,
      events: this.events,
      completion: this.runCommittedTurn(turn, () => this.startLoop(turn, model, loopOptions)),
    }
  }

  /**
   * Queue 启动下一 Turn 时才读取当前模型。
   * @param input 队首仅包含文本的消息。
   * @returns 已提交并启动的下一 Turn。
   * @throws Error 恢复、准备、Adapter 创建或首批提交失败。
   */
  private async continueQueuedSession(input: PendingSessionMessage): Promise<StartedSessionTurn> {
    const state = await this.repairSession()
    await this.prepareExistingTurn()
    const model = await this.readCurrentModel()
    const loopOptions = await this.createLoopOptions(model)
    const turn = state.lastTurn + 1
    await this.appendTurnStartAndUserMessage(turnEvents(turn, model, input.content, input.messageId))
    return {
      sessionId: this.sessionId,
      turn,
      events: this.events,
      completion: this.runCommittedTurn(turn, () => this.startLoop(turn, model, loopOptions)),
    }
  }

  /**
   * 保证已提交的 Turn 在成功或失败时都尝试写入结束事件。
   * @param turn 已提交的 Turn 编号。
   * @param run 初始化余下状态并执行 AgentLoop 的操作。
   * @returns AgentLoop 结果；返回前已提交 Turn 结束事件。
   * @throws Error 运行失败时先尝试提交错误结束事件，再传播原错误。
   */
  private async runCommittedTurn(
    turn: number,
    run: () => Promise<AgentLoopResult>,
  ): Promise<AgentLoopResult> {
    let result: AgentLoopResult
    try {
      result = await run()
    } catch (error) {
      const appError: AppError = isAppErrorValue(error)
        ? { source: error.source, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
        : normalizeError(error, "runtime", "TURN_FAILED")
      try { await this.appendEvent({ type: "app/error", turn, error: appError }) }
      catch { /* 存储不可用时由宿主报告原错误。 */ }
      try { await this.appendTurnFileChanges(turn) } catch { /* 保留运行错误。 */ }
      try { await this.appendEvent({ type: "turn/end", turn, reason: "error" }) }
      catch { /* 下次恢复时补写。 */ }
      throw error
    }
    try { await this.appendTurnFileChanges(turn) }
    catch (error) {
      try { await this.appendEvent({ type: "turn/end", turn, reason: "error" }) }
      catch { /* 下次恢复时补写。 */ }
      throw error
    }
    await this.appendEvent({
      type: "turn/end",
      turn,
      reason: result.stopped ? "stopped" : "completed",
    })
    return result
  }

  /**
   * 为指定 Turn 构建上下文并运行 AgentLoop。
   * @param turn 要运行的 Turn 编号。
   * @param model 该 Turn 固定的模型引用。
   * @param options 已装配的模型、工具、事件和取消资源。
   * @returns AgentLoop 的运行结果。
   * @throws Error 上下文构建或 Loop 运行失败。
   */
  private async startLoop(
    turn: number,
    model: ModelRef,
    options: Omit<AgentLoopOptions, "turn" | "model" | "content">,
  ): Promise<AgentLoopResult> {
    const content = await this.buildContent(turn)
    return runAgentLoop({ ...options, turn, model, content })
  }

  /**
   * 校验持久化事件身份后发布到当前活动事件流。
   * @param event 已持久化的事件。
   * @param expectedType 调用方期望写入的事件类型。
   * @throws Error 事件属于其它 Session 或类型不符。
   */
  private publishPersistedEvent(event: SessionEvent, expectedType: SessionEvent["type"]): void {
    if (event.sessionId !== this.sessionId) {
      throw new Error(
        `持久化事件属于其它 Session：${event.sessionId}，当前实例为 ${this.sessionId}`,
      )
    }
    if (event.type !== expectedType) {
      throw new Error(`持久化事件类型不匹配：期望 ${expectedType}，实际 ${event.type}`)
    }
    this.eventStream.publish(event)
    this.lastCommittedSeq = event.seq
  }

  /** @throws Error 当前实例已关闭时抛出。 */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`SessionRuntime 已关闭：${this.sessionId}`)
    }
  }
}

/** 单消费者、实例内存级的 SessionEvent 异步流。 */
class SessionEventStream implements AsyncIterable<SessionEvent> {
  private readonly buffered: SessionEvent[] = []
  private nextResolver: ((result: IteratorResult<SessionEvent>) => void) | undefined
  private iteratorCreated = false
  private closed = false

  /** @param event 已经成功持久化的 Session 事件。 */
  publish(event: SessionEvent): void {
    if (this.closed) return
    const resolveNext = this.nextResolver
    if (resolveNext !== undefined) {
      this.nextResolver = undefined
      resolveNext({ value: event, done: false })
      return
    }
    this.buffered.push(event)
  }

  /** 结束事件流；缓冲区中的既有事件仍会先被消费。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.buffered.length === 0 && this.nextResolver !== undefined) {
      const resolveNext = this.nextResolver
      this.nextResolver = undefined
      resolveNext({ value: undefined, done: true })
    }
  }

  /** @returns 当前事件流唯一的异步迭代器。 */
  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    if (this.iteratorCreated) {
      throw new Error("Session 事件流只能消费一次")
    }
    this.iteratorCreated = true
    return {
      next: () => this.next(),
    }
  }

  private next(): Promise<IteratorResult<SessionEvent>> {
    const event = this.buffered.shift()
    if (event !== undefined) {
      return Promise.resolve({ value: event, done: false })
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true })
    }
    return new Promise((resolve) => {
      this.nextResolver = resolve
    })
  }
}

/** @param content 要保存到内存队列或返回给 Renderer 的文本内容。 */
function cloneMessageContent(content: readonly ModelTextBlock[]): ModelTextBlock[] {
  return content.map((block) => ({ ...block }))
}

export const SESSION_LOG_CORRUPTED = "SESSION_LOG_CORRUPTED"

/** Event Log 无法按架构规则解释时抛出的统一 Storage 错误。 */
export class SessionLogCorruptedError extends Error {
  readonly source = "storage" as const
  readonly code = SESSION_LOG_CORRUPTED

  /**
   * @param sessionId 被判定为损坏的 Session ID。
   * @param detail 描述违反的 Event Log 规则的具体原因。
   */
  constructor(sessionId: string, detail: string) {
    super(`Session Event Log 已损坏（${sessionId}）：${detail}`)
    this.name = "SessionLogCorruptedError"
  }
}

/**
 * 按开发备忘录第 10 节把 Session 修复到可继续创建新 Turn 的一致状态。
 *
 * @param sessionId 要读取和修复的 Session ID。
 * @param ports 提供 Event Log 访问、初始化、派生状态修复和事件追加能力的端口。
 * @returns 修复前 Event Log 中的最后 Turn 编号；不返回修复阶段读取过的模型。
 * @throws SessionLogCorruptedError 当日志结构、生命周期或恢复关联不一致时抛出。
 */
export async function repairSession(
  sessionId: string,
  ports: SessionRepairPorts,
): Promise<{ lastTurn: number }> {
  const events = validateEventLog(sessionId, await ports.readEvents())
  const lifecycle = validateLifecycle(sessionId, events)
  validateBlockStreams(sessionId, events)
  validateSummaries(sessionId, events)

  await ports.initializeSession()
  await ports.repairDerivedState(events)

  const append = async (input: SessionEventInput): Promise<SessionEvent> => {
    const previousSeq = events.at(-1)?.seq ?? 0
    const written = validateSessionEvent(sessionId, await ports.appendEvent(input), events.length)
    if (written.type !== input.type) {
      corrupted(sessionId, `追加 ${input.type} 后返回了 ${written.type}`)
    }
    for (const [field, expected] of Object.entries(input)) {
      if (!isDeepStrictEqual((written as unknown as Record<string, unknown>)[field], expected)) {
        corrupted(sessionId, `追加 ${input.type} 后返回的 ${field} 与请求不一致`)
      }
    }
    if (written.seq <= previousSeq) {
      corrupted(sessionId, `追加事件的 seq ${written.seq} 未大于 ${previousSeq}`)
    }
    if (events.some((event) => event.eventId === written.eventId)) {
      corrupted(sessionId, `追加事件使用了重复 eventId：${written.eventId}`)
    }
    events.push(written)
    return written
  }

  await repairBlockEnds(sessionId, events, append)
  await repairAssistantMessages(sessionId, events, append)
  await repairApprovalsAndToolResults(sessionId, events, append)

  if (lifecycle.openStep !== undefined) {
    await append({
      type: "step/end",
      turn: lifecycle.openStep.turn,
      step: lifecycle.openStep.step,
      reason: "error",
    })
  }
  if (lifecycle.openTurn !== undefined) {
    await append({ type: "turn/end", turn: lifecycle.openTurn, reason: "error" })
  }

  return { lastTurn: lifecycle.lastTurn }
}

/**
 * 构造新 Turn 必须成批提交的 `turn/start` 与 `user/message` 事件。
 *
 * @param turn 新 Turn 编号。
 * @param model 新 Turn 固定使用的模型引用。
 * @param content 用户消息的文本块内容。
 * @param messageId Queue 入队身份；普通发送省略时生成新身份。
 * @returns 顺序固定的两条事件输入。
 */
function turnEvents(
  turn: number,
  model: ModelRef,
  content: ModelTextBlock[],
  messageId: string = randomUUID(),
): readonly [TurnStartEventInput, UserMessageEventInput] {
  return [
    { type: "turn/start", turn, model },
    { type: "user/message", turn, message: { id: messageId, role: "user", content } },
  ]
}

/** @param value 未知异常。 @returns 是否已经具有统一 AppError 的必需字段。 */
function isAppErrorValue(value: unknown): value is AppError {
  return typeof value === "object" && value !== null && "source" in value &&
    typeof value.source === "string" && ["runtime", "model", "tool", "mcp", "storage", "system"].includes(value.source) &&
    "code" in value && typeof value.code === "string" &&
    "message" in value && typeof value.message === "string"
}


type AppendRecoveryEvent = (event: SessionEventInput) => Promise<SessionEvent>

interface LifecycleState {
  /** Event Log 中已出现的最后一个 Turn 编号。 */
  lastTurn: number
  /** 当前尚未写入 `turn/end` 的 Turn 编号。 */
  openTurn?: number
  /** 当前尚未写入 `step/end` 的 Step 身份。 */
  openStep?: { turn: number; step: number }
}

interface BlockStream {
  /** Block 的 `assistant/block_start` 事件。 */
  start: AssistantBlockStartEvent
  /** Block 收到的全部 Delta 事件，按日志顺序排列。 */
  deltas: AssistantBlockDeltaEvent[]
  /** Block 的 `assistant/block_end` 事件；缺失时表示需要恢复。 */
  end?: AssistantBlockEndEvent
}

interface AuthoritativeToolCall {
  /** 包含该工具调用的权威 `assistant/message` 事件。 */
  message: AssistantMessageEvent
  /** 与消息中的工具调用匹配的权威 `assistant/block_end` 事件。 */
  end: AssistantBlockEndEvent & {
    block: Extract<AssistantBlockEndEvent["block"], { type: "tool_call" }>
  }
}

const APPROVAL_DENIED = "APPROVAL_DENIED"
const EXECUTION_STATE_UNKNOWN = "EXECUTION_STATE_UNKNOWN"

type RecoveryToolErrorCode =
  | typeof CANCELLED
  | typeof APPROVAL_DENIED
  | typeof EXECUTION_STATE_UNKNOWN

/**
 * 校验 Event Log 的最小结构、事件身份、序号以及首个 Turn 的提交顺序。
 *
 * @param sessionId 期望所有事件所属的 Session ID。
 * @param values 从持久化层读取、尚未信任的事件值。
 * @returns 通过基础结构校验并保持原日志顺序的 SessionEvent 数组。
 * @throws SessionLogCorruptedError 当日志为空、事件无效、序号不递增或首批事件不完整时抛出。
 */
function validateEventLog(sessionId: string, values: readonly unknown[]): SessionEvent[] {
  if (values.length < 2) {
    corrupted(sessionId, "缺少同批提交的首个 turn/start 与 user/message")
  }

  const events: SessionEvent[] = []
  const eventIds = new Set<string>()
  let previousSeq = 0

  for (const [index, value] of values.entries()) {
    const event = validateSessionEvent(sessionId, value, index)
    if (event.seq <= previousSeq) {
      corrupted(sessionId, `第 ${index + 1} 条事件的 seq 未严格递增`)
    }
    if (eventIds.has(event.eventId)) {
      corrupted(sessionId, `eventId 重复：${event.eventId}`)
    }
    previousSeq = event.seq
    eventIds.add(event.eventId)
    events.push(event)
  }

  const first = events[0]
  const second = events[1]
  if (first.type !== "turn/start" || first.turn !== 1) {
    corrupted(sessionId, "首条事件不是 turn=1 的 turn/start")
  }
  if (second.type !== "user/message" || second.turn !== 1) {
    corrupted(sessionId, "首个 turn/start 缺少同批提交的首条 user/message")
  }
  for (const [index, event] of events.entries()) {
    if (event.type !== "turn/start") continue
    const next = events[index + 1]
    if (next?.type !== "user/message" || next.turn !== event.turn) {
      corrupted(sessionId, `turn/start ${event.turn} 缺少同批提交的首条 user/message`)
    }
  }

  return events
}

/**
 * 校验并窄化单条 Session 事件的公共身份字段和按类型字段。
 *
 * @param sessionId 期望事件所属的 Session ID。
 * @param value 待校验的原始事件值。
 * @param index 事件在 Event Log 中的零基索引，用于生成诊断信息。
 * @returns 通过结构校验的 SessionEvent。
 * @throws SessionLogCorruptedError 当事件不是合法的已知事件类型或字段值无效时抛出。
 */
function validateSessionEvent(sessionId: string, value: unknown, index: number): SessionEvent {
  if (!isRecord(value)) corrupted(sessionId, `第 ${index + 1} 条事件不是对象`)
  const event = value as Record<string, unknown>
  if (!isNonEmptyString(event.eventId)) corrupted(sessionId, `第 ${index + 1} 条事件缺少 eventId`)
  if (event.sessionId !== sessionId) corrupted(sessionId, `第 ${index + 1} 条事件的 sessionId 不匹配`)
  if (!isPositiveInteger(event.seq)) corrupted(sessionId, `第 ${index + 1} 条事件的 seq 无效`)
  if (!isNonEmptyString(event.createdAt)) corrupted(sessionId, `第 ${index + 1} 条事件缺少 createdAt`)

  switch (event.type) {
    case "turn/start":
      requireTurn(sessionId, event, index)
      requireModel(sessionId, event.model, index)
      break
    case "turn/end":
      requireTurn(sessionId, event, index)
      requireEndReason(sessionId, event.reason, index)
      break
    case "user/message":
      requireTurn(sessionId, event, index)
      requireUserMessage(sessionId, event.message, index)
      break
    case "step/start":
      requireTurnAndStep(sessionId, event, index)
      break
    case "step/end":
      requireTurnAndStep(sessionId, event, index)
      requireEndReason(sessionId, event.reason, index)
      break
    case "assistant/block_start":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "blockId", index)
      if (!isNonNegativeInteger(event.index)) corrupted(sessionId, `第 ${index + 1} 条事件的块 index 无效`)
      if (event.blockType !== "thinking" && event.blockType !== "text" && event.blockType !== "tool_call") {
        corrupted(sessionId, `第 ${index + 1} 条事件的 blockType 无效`)
      }
      break
    case "assistant/block_delta":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "blockId", index)
      requireBlockDelta(sessionId, event.delta, index)
      break
    case "assistant/block_end":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "blockId", index)
      if (!isNonNegativeInteger(event.index)) corrupted(sessionId, `第 ${index + 1} 条事件的块 index 无效`)
      requireAssistantBlock(sessionId, event.block, index)
      break
    case "assistant/message":
      requireTurnAndStep(sessionId, event, index)
      requireAssistantMessage(sessionId, event.message, index)
      requireModel(sessionId, event.model, index)
      if (event.usage !== undefined) requireUsage(sessionId, event.usage, index)
      if (event.finishReason !== undefined && typeof event.finishReason !== "string") {
        corrupted(sessionId, `第 ${index + 1} 条事件的 finishReason 无效`)
      }
      break
    case "tool/result":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "toolCallEventId", index)
      requireStringField(sessionId, event, "toolCallId", index)
      requireStringField(sessionId, event, "blockId", index)
      requireToolResult(sessionId, event.result, index)
      break
    case "approval/request":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "approvalId", index)
      requireStringField(sessionId, event, "toolCallEventId", index)
      requireStringField(sessionId, event, "toolCallId", index)
      requireStringField(sessionId, event, "blockId", index)
      requireStringField(sessionId, event, "toolName", index)
      if (event.reason !== undefined && typeof event.reason !== "string") {
        corrupted(sessionId, `第 ${index + 1} 条事件的 approval reason 无效`)
      }
      break
    case "approval/result":
      requireTurnAndStep(sessionId, event, index)
      requireStringField(sessionId, event, "approvalId", index)
      if (event.decision !== "approved" && event.decision !== "denied" && event.decision !== "cancelled") {
        corrupted(sessionId, `第 ${index + 1} 条事件的 approval decision 无效`)
      }
      break
    case "context_update":
      requireTurn(sessionId, event, index)
      if (typeof event.content !== "string" || !isRecord(event.source)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 context_update 无效`)
      }
      if (event.source.type === "agents_md") {
        if (
          !isNonEmptyString(event.source.path) ||
          !isNonEmptyString(event.source.hash) ||
          typeof event.source.fullContent !== "string"
        ) {
          corrupted(sessionId, `第 ${index + 1} 条事件的 agents_md source 无效`)
        }
      } else if (event.source.type === "skill") {
        if (!Array.isArray(event.source.changes)) {
          corrupted(sessionId, `第 ${index + 1} 条事件的 skill changes 无效`)
        }
      } else {
        corrupted(sessionId, `第 ${index + 1} 条事件的 context_update source 无效`)
      }
      break
    case "app/error":
      if (event.turn !== undefined && !isPositiveInteger(event.turn)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 turn 无效`)
      }
      if (event.step !== undefined && !isPositiveInteger(event.step)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 step 无效`)
      }
      if (
        !isRecord(event.error) ||
        !isAppErrorSource(event.error.source) ||
        !isNonEmptyString(event.error.code) ||
        typeof event.error.message !== "string"
      ) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 AppError 无效`)
      }
      if (event.sourceEventId !== undefined && !isNonEmptyString(event.sourceEventId)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 sourceEventId 无效`)
      }
      break
    case "summary/start":
      requireTurn(sessionId, event, index)
      requireStringField(sessionId, event, "summaryId", index)
      if (!isPositiveInteger(event.throughEventSeq)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 throughEventSeq 无效`)
      }
      break
    case "summary/end":
      requireTurn(sessionId, event, index)
      requireStringField(sessionId, event, "summaryId", index)
      if (!isNonEmptyString(event.summary) || !isPositiveInteger(event.throughEventSeq)) {
        corrupted(sessionId, `第 ${index + 1} 条事件的 summary/end 无效`)
      }
      if (event.usage !== undefined) requireUsage(sessionId, event.usage, index)
      break
    case "turn/file_changes":
      requireTurn(sessionId, event, index)
      if (!Array.isArray(event.files)) corrupted(sessionId, `第 ${index + 1} 条事件的 files 无效`)
      break
    default:
      corrupted(sessionId, `第 ${index + 1} 条事件类型未知：${String(event.type)}`)
  }

  return event as unknown as SessionEvent
}

/**
 * 校验 Turn、Step 及其生命周期事件的顺序和嵌套关系。
 *
 * @param sessionId 被校验的 Session ID。
 * @param events 已通过单事件结构校验的事件序列。
 * @returns 当前日志的最后 Turn，以及尚未正常关闭的 Turn/Step。
 * @throws SessionLogCorruptedError 当生命周期存在跳号、重复、交叉或未匹配关闭事件时抛出。
 */
function validateLifecycle(sessionId: string, events: readonly SessionEvent[]): LifecycleState {
  const turns = new Map<number, TurnStartEvent>()
  const endedTurns = new Set<number>()
  const stepStarts = new Map<string, StepStartEvent>()
  const stepEnds = new Set<string>()
  const lastStepByTurn = new Map<number, number>()
  let openTurn: number | undefined
  let openStep: { turn: number; step: number } | undefined

  for (const event of events) {
    switch (event.type) {
      case "turn/start": {
        if (openTurn !== undefined) {
          corrupted(sessionId, `turn ${event.turn} 开始时 turn ${openTurn} 尚未结束`)
        }
        if (turns.has(event.turn) || event.turn !== turns.size + 1) {
          corrupted(sessionId, `turn/start 编号不连续或重复：${event.turn}`)
        }
        turns.set(event.turn, event)
        openTurn = event.turn
        break
      }
      case "turn/end": {
        if (!turns.has(event.turn)) corrupted(sessionId, `turn/end ${event.turn} 没有对应 turn/start`)
        if (endedTurns.has(event.turn)) corrupted(sessionId, `turn/end ${event.turn} 重复`)
        if (openTurn !== event.turn) corrupted(sessionId, `turn/end ${event.turn} 不在当前 Turn`)
        if (openStep !== undefined) {
          corrupted(sessionId, `turn/end ${event.turn} 之前 step ${openStep.step} 尚未结束`)
        }
        endedTurns.add(event.turn)
        openTurn = undefined
        break
      }
      case "step/start": {
        if (!turns.has(event.turn)) corrupted(sessionId, `step/start ${event.turn}:${event.step} 缺少 turn/start`)
        if (openTurn !== event.turn || endedTurns.has(event.turn)) {
          corrupted(sessionId, `step/start ${event.turn}:${event.step} 不在开放的 Turn 中`)
        }
        if (openStep !== undefined) {
          corrupted(sessionId, `step ${event.turn}:${event.step} 开始时上一个 Step 尚未结束`)
        }
        const expected = (lastStepByTurn.get(event.turn) ?? 0) + 1
        const key = stepKey(event.turn, event.step)
        if (event.step !== expected || stepStarts.has(key)) {
          corrupted(sessionId, `step/start 编号不连续或重复：${event.turn}:${event.step}`)
        }
        stepStarts.set(key, event)
        lastStepByTurn.set(event.turn, event.step)
        openStep = { turn: event.turn, step: event.step }
        break
      }
      case "step/end": {
        const key = stepKey(event.turn, event.step)
        if (!stepStarts.has(key)) corrupted(sessionId, `step/end ${key} 没有对应 step/start`)
        if (stepEnds.has(key)) corrupted(sessionId, `step/end ${key} 重复`)
        if (openStep?.turn !== event.turn || openStep.step !== event.step) {
          corrupted(sessionId, `step/end ${key} 不在当前 Step`)
        }
        stepEnds.add(key)
        openStep = undefined
        break
      }
      case "user/message":
        if (!turns.has(event.turn) || endedTurns.has(event.turn)) {
          corrupted(sessionId, `user/message 位于未开始或已结束的 turn ${event.turn}`)
        }
        break
      case "summary/start":
      case "summary/end":
      case "turn/file_changes":
        if (openTurn !== event.turn || endedTurns.has(event.turn) || openStep !== undefined) {
          corrupted(sessionId, `${event.type} 位于未开始或已结束的 turn ${event.turn}`)
        }
        break
      case "context_update":
        if (openTurn !== undefined || event.turn !== turns.size + 1) {
          corrupted(sessionId, `context_update 不在下一 Turn 开始前：${event.turn}`)
        }
        break
      default:
        if (isStepScopedEvent(event)) {
          if (openStep?.turn !== event.turn || openStep.step !== event.step) {
            corrupted(sessionId, `${event.type} 位于未开始或已结束的 step ${event.turn}:${event.step}`)
          }
        }
    }
  }

  return {
    lastTurn: turns.size,
    openTurn,
    openStep,
  }
}

/**
 * 校验每个 Assistant Block 的 start、delta、end 流，并建立可供恢复使用的索引。
 *
 * @param sessionId 被校验的 Session ID。
 * @param events 已通过基础结构和生命周期校验的事件序列。
 * @returns 以 Turn、Step、Block ID 为键的 Block 流索引。
 * @throws SessionLogCorruptedError 当 Block 缺少前置事件、重复结束、类型不一致或内容不一致时抛出。
 */
function validateBlockStreams(sessionId: string, events: readonly SessionEvent[]): Map<string, BlockStream> {
  const streams = new Map<string, BlockStream>()
  const nextIndexByStep = new Map<string, number>()

  for (const event of events) {
    if (event.type === "assistant/block_start") {
      const key = blockKey(event.turn, event.step, event.blockId)
      if (streams.has(key)) corrupted(sessionId, `BlockStart 重复：${key}`)
      const step = stepKey(event.turn, event.step)
      const expectedIndex = nextIndexByStep.get(step) ?? 0
      if (event.index !== expectedIndex) {
        corrupted(sessionId, `Block index 不连续：${step}:${event.index}`)
      }
      nextIndexByStep.set(step, expectedIndex + 1)
      streams.set(key, { start: event, deltas: [] })
      continue
    }

    if (event.type === "assistant/block_delta") {
      const key = blockKey(event.turn, event.step, event.blockId)
      const stream = streams.get(key)
      if (stream === undefined) corrupted(sessionId, `BlockDelta 缺少 BlockStart：${key}`)
      if (stream.end !== undefined) corrupted(sessionId, `BlockEnd 后仍有 BlockDelta：${key}`)
      if (stream.start.blockType !== event.delta.type) {
        corrupted(sessionId, `BlockDelta 类型与 BlockStart 不一致：${key}`)
      }
      stream.deltas.push(event)
      continue
    }

    if (event.type === "assistant/block_end") {
      const key = blockKey(event.turn, event.step, event.blockId)
      const stream = streams.get(key)
      if (stream === undefined) corrupted(sessionId, `BlockEnd 缺少 BlockStart：${key}`)
      if (stream.end !== undefined) corrupted(sessionId, `BlockEnd 重复：${key}`)
      if (stream.start.index !== event.index || stream.start.blockType !== event.block.type) {
        corrupted(sessionId, `BlockEnd 与 BlockStart 不匹配：${key}`)
      }
      if (event.block.type === "thinking" || event.block.type === "text") {
        const deltaText = stream.deltas.map((delta) => {
          if (delta.delta.type !== event.block.type || delta.delta.type === "tool_call") {
            corrupted(sessionId, `BlockEnd 与 Delta 类型不一致：${key}`)
          }
          return delta.delta.text
        }).join("")
        if (stream.deltas.length > 0 && deltaText !== event.block.text) {
          corrupted(sessionId, `BlockEnd 文本与 Delta 不一致：${key}`)
        }
      } else {
        const toolCallIds = new Set(stream.deltas.map((delta) => {
          if (delta.delta.type !== "tool_call") corrupted(sessionId, `tool_call Delta 类型不一致：${key}`)
          return delta.delta.toolCallId
        }))
        if (toolCallIds.size > 1 || (toolCallIds.size === 1 && !toolCallIds.has(event.block.toolCallId))) {
          corrupted(sessionId, `tool_call BlockEnd 与 Delta 身份不一致：${key}`)
        }
      }
      stream.end = event
    }
  }

  return streams
}

/**
 * 校验 Summary 事件的配对关系及其覆盖范围。
 *
 * @param sessionId 被校验的 Session ID。
 * @param events 已通过基础结构和生命周期校验的事件序列。
 * @throws SessionLogCorruptedError 当 Summary 重复、缺少配对事件或覆盖序号不一致时抛出。
 */
function validateSummaries(sessionId: string, events: readonly SessionEvent[]): void {
  const starts = new Map<string, Extract<SessionEvent, { type: "summary/start" }>>()
  const ends = new Set<string>()
  for (const event of events) {
    if (event.type === "summary/start") {
      if (starts.has(event.summaryId)) corrupted(sessionId, `summary/start 重复：${event.summaryId}`)
      if (event.throughEventSeq >= event.seq) {
        corrupted(sessionId, `summary/start 的 throughEventSeq 未早于自身：${event.summaryId}`)
      }
      starts.set(event.summaryId, event)
    }
    if (event.type === "summary/end") {
      const start = starts.get(event.summaryId)
      if (start === undefined) corrupted(sessionId, `summary/end 缺少 start：${event.summaryId}`)
      if (ends.has(event.summaryId)) corrupted(sessionId, `summary/end 重复：${event.summaryId}`)
      if (event.turn !== start.turn || event.throughEventSeq !== start.throughEventSeq) {
        corrupted(sessionId, `summary/end 与 start 不匹配：${event.summaryId}`)
      }
      ends.add(event.summaryId)
    }
  }
}

/**
 * 为已开始但尚未结束的文本 Block 补写 `assistant/block_end`。
 *
 * Tool Call 不会在这里自动补写，因为其参数完整性和执行结果需要由后续恢复逻辑处理。
 *
 * @param sessionId 被修复的 Session ID。
 * @param events 当前已校验且可能随恢复事件增长的事件数组。
 * @param append 追加并校验恢复事件的函数。
 * @returns 所有可确定恢复的文本 Block 均补写完成后结束。
 * @throws SessionLogCorruptedError 当 Block Delta 无法还原为一致文本时抛出。
 */
async function repairBlockEnds(
  sessionId: string,
  events: SessionEvent[],
  append: AppendRecoveryEvent,
): Promise<void> {
  const streams = validateBlockStreams(sessionId, events)
  for (const stream of streams.values()) {
    if (stream.end !== undefined || stream.start.blockType === "tool_call") continue

    const text = stream.deltas.map((event) => {
      if (event.delta.type !== stream.start.blockType || event.delta.type === "tool_call") {
        corrupted(sessionId, `文本 Block 的 Delta 类型不一致：${stream.start.blockId}`)
      }
      return event.delta.text
    }).join("")

    await append({
      type: "assistant/block_end",
      turn: stream.start.turn,
      step: stream.start.step,
      blockId: stream.start.blockId,
      index: stream.start.index,
      block: { type: stream.start.blockType, text },
    })
  }
}

/**
 * 校验现有 `assistant/message`，并为缺失的消息补写由 BlockEnd 重建的内容。
 *
 * @param sessionId 被修复的 Session ID。
 * @param events 当前已校验且可能随恢复事件增长的事件数组。
 * @param append 追加并校验恢复事件的函数。
 * @returns 所有可由权威 BlockEnd 确定的 Assistant 消息均已校验或补写完成。
 * @throws SessionLogCorruptedError 当消息与 BlockEnd、Turn 模型或内容不一致时抛出。
 */
async function repairAssistantMessages(
  sessionId: string,
  events: SessionEvent[],
  append: AppendRecoveryEvent,
): Promise<void> {
  const turnModels = new Map<number, ModelRef>()
  const messages = new Map<string, AssistantMessageEvent>()
  const blockEnds = new Map<string, AssistantBlockEndEvent[]>()

  for (const event of events) {
    if (event.type === "turn/start") turnModels.set(event.turn, event.model)
    if (event.type === "assistant/message") {
      const key = stepKey(event.turn, event.step)
      if (messages.has(key)) corrupted(sessionId, `assistant/message 重复：${key}`)
      messages.set(key, event)
    }
    if (event.type === "assistant/block_end") {
      const key = stepKey(event.turn, event.step)
      const group = blockEnds.get(key) ?? []
      group.push(event)
      blockEnds.set(key, group)
    }
  }

  for (const [key, ends] of blockEnds) {
    const indexes = new Set<number>()
    for (const end of ends) {
      if (indexes.has(end.index)) corrupted(sessionId, `同一 Step 的 Block index 重复：${key}:${end.index}`)
      indexes.add(end.index)
    }
    const existing = messages.get(key)
    const expectedContent = [...ends].sort((left, right) => left.index - right.index).map((end) => end.block)
    if (existing !== undefined) {
      const turnModel = turnModels.get(existing.turn)
      if (turnModel === undefined || !isDeepStrictEqual(existing.model, turnModel)) {
        corrupted(sessionId, `assistant/message.model 与 turn/start.model 不一致：${key}`)
      }
      if (!isDeepStrictEqual(existing.message.content, expectedContent)) {
        corrupted(sessionId, `assistant/message.content 与 BlockEnd 不一致：${key}`)
      }
      continue
    }

    const [first] = ends
    const model = turnModels.get(first.turn)
    if (model === undefined) corrupted(sessionId, `恢复 assistant/message 时缺少 turn/start.model：${key}`)
    await append({
      type: "assistant/message",
      turn: first.turn,
      step: first.step,
      message: {
        id: randomUUID(),
        role: "assistant",
        content: expectedContent,
      },
      model,
    })
  }

  for (const [key, message] of messages) {
    if (blockEnds.has(key)) continue
    const turnModel = turnModels.get(message.turn)
    if (turnModel === undefined || !isDeepStrictEqual(message.model, turnModel)) {
      corrupted(sessionId, `assistant/message.model 与 turn/start.model 不一致：${key}`)
    }
    if (message.message.content.length > 0) {
      corrupted(sessionId, `assistant/message 有内容但没有可用 BlockEnd：${key}`)
    }
  }
}

/**
 * 校验审批和工具结果的关联，并为未完成的调用补写确定性的恢复结果。
 *
 * @param sessionId 被修复的 Session ID。
 * @param events 当前已校验且可能随恢复事件增长的事件数组。
 * @param append 追加并校验恢复事件的函数。
 * @returns 所有权威工具调用都具备审批终态和工具结果后结束。
 * @throws SessionLogCorruptedError 当审批、工具调用或工具结果关联不一致时抛出。
 */
async function repairApprovalsAndToolResults(
  sessionId: string,
  events: SessionEvent[],
  append: AppendRecoveryEvent,
): Promise<void> {
  const calls = collectAuthoritativeToolCalls(sessionId, events)
  const callsByEventId = new Map(calls.map((call) => [call.end.eventId, call]))
  const requestsByCall = new Map<string, ApprovalRequestEvent>()
  const requestsByApproval = new Map<string, ApprovalRequestEvent>()
  const decisions = new Map<string, ApprovalResultEvent>()
  const toolResults = new Map<string, ToolResultEvent>()

  for (const event of events) {
    if (event.type === "approval/request") {
      const call = callsByEventId.get(event.toolCallEventId)
      if (call === undefined) corrupted(sessionId, `approval/request 引用了非权威 tool_call：${event.approvalId}`)
      if (
        event.turn !== call.end.turn ||
        event.step !== call.end.step ||
        event.toolCallId !== call.end.block.toolCallId ||
        event.blockId !== call.end.blockId ||
        event.toolName !== call.end.block.name
      ) {
        corrupted(sessionId, `approval/request 与 tool_call 不匹配：${event.approvalId}`)
      }
      if (requestsByCall.has(event.toolCallEventId) || requestsByApproval.has(event.approvalId)) {
        corrupted(sessionId, `approval/request 重复：${event.approvalId}`)
      }
      requestsByCall.set(event.toolCallEventId, event)
      requestsByApproval.set(event.approvalId, event)
    }

    if (event.type === "approval/result") {
      const request = requestsByApproval.get(event.approvalId)
      if (request === undefined) corrupted(sessionId, `approval/result 缺少 request：${event.approvalId}`)
      if (event.turn !== request.turn || event.step !== request.step) {
        corrupted(sessionId, `approval/result 与 request 身份不匹配：${event.approvalId}`)
      }
      if (decisions.has(event.approvalId)) corrupted(sessionId, `approval/result 重复：${event.approvalId}`)
      decisions.set(event.approvalId, event)
    }

    if (event.type === "tool/result") {
      const call = callsByEventId.get(event.toolCallEventId)
      if (call === undefined) corrupted(sessionId, `tool/result 引用了非权威 tool_call：${event.toolCallId}`)
      if (
        event.turn !== call.end.turn ||
        event.step !== call.end.step ||
        event.toolCallId !== call.end.block.toolCallId ||
        event.blockId !== call.end.blockId
      ) {
        corrupted(sessionId, `tool/result 与 tool_call 不匹配：${event.toolCallId}`)
      }
      if (toolResults.has(event.toolCallEventId)) corrupted(sessionId, `tool/result 重复：${event.toolCallId}`)
      toolResults.set(event.toolCallEventId, event)
    }
  }

  for (const request of requestsByApproval.values()) {
    if (decisions.has(request.approvalId)) continue
    const written = await append({
      type: "approval/result",
      turn: request.turn,
      step: request.step,
      approvalId: request.approvalId,
      decision: "cancelled",
    })
    if (written.type !== "approval/result") corrupted(sessionId, "补写 approval/result 返回了错误事件类型")
    decisions.set(request.approvalId, written)
  }

  for (const call of calls) {
    if (toolResults.has(call.end.eventId)) continue
    const request = requestsByCall.get(call.end.eventId)
    const decision = request === undefined ? undefined : decisions.get(request.approvalId)?.decision
    const code = recoveryToolErrorCode(decision)
    const written = await append({
      type: "tool/result",
      turn: call.end.turn,
      step: call.end.step,
      toolCallEventId: call.end.eventId,
      toolCallId: call.end.block.toolCallId,
      blockId: call.end.blockId,
      result: recoveryToolResult(code),
    })
    if (written.type !== "tool/result") corrupted(sessionId, "补写 tool/result 返回了错误事件类型")
    toolResults.set(call.end.eventId, written)
  }
}

/**
 * 从权威 Assistant 消息中收集并校验唯一匹配的工具调用 BlockEnd。
 *
 * @param sessionId 被校验的 Session ID。
 * @param events 已通过基础结构校验的事件序列。
 * @returns 按 Assistant 消息出现顺序排列的权威工具调用。
 * @throws SessionLogCorruptedError 当工具调用找不到唯一匹配的 BlockEnd 或内容不一致时抛出。
 */
function collectAuthoritativeToolCalls(
  sessionId: string,
  events: readonly SessionEvent[],
): AuthoritativeToolCall[] {
  const blockEnds = events.filter(
    (event): event is AuthoritativeToolCall["end"] =>
      event.type === "assistant/block_end" && event.block.type === "tool_call",
  )
  const calls: AuthoritativeToolCall[] = []
  const seenEventIds = new Set<string>()

  for (const message of events) {
    if (message.type !== "assistant/message") continue
    for (const block of message.message.content) {
      if (block.type !== "tool_call") continue
      const matching = blockEnds.filter(
        (end) => end.turn === message.turn &&
          end.step === message.step &&
          end.block.toolCallId === block.toolCallId,
      )
      if (matching.length !== 1) {
        corrupted(sessionId, `权威 assistant/message 的 tool_call 无唯一 BlockEnd：${block.toolCallId}`)
      }
      const end = matching[0]
      if (end.block.name !== block.name || !isDeepStrictEqual(end.block.arguments, block.arguments)) {
        corrupted(sessionId, `assistant/message 与 tool_call BlockEnd 内容不一致：${block.toolCallId}`)
      }
      if (seenEventIds.has(end.eventId)) {
        corrupted(sessionId, `权威 tool_call 重复：${block.toolCallId}`)
      }
      seenEventIds.add(end.eventId)
      calls.push({ message, end })
    }
  }

  return calls
}

/**
 * 根据审批决定选择 Session 恢复时应使用的工具错误码。
 *
 * @param decision 关联审批的决定；缺失表示执行状态未知。
 * @returns 用于恢复 ToolResult 的错误码。
 */
function recoveryToolErrorCode(
  decision: ApprovalResultEvent["decision"] | undefined,
): RecoveryToolErrorCode {
  if (decision === "denied") return APPROVAL_DENIED
  if (decision === "cancelled") return CANCELLED
  return EXECUTION_STATE_UNKNOWN
}

/**
 * 根据恢复错误码创建不会触发自动重试的错误 ToolResult。
 *
 * @param code Session 恢复期间确定的工具错误码。
 * @returns 描述恢复结果的统一错误工具结果。
 */
function recoveryToolResult(code: RecoveryToolErrorCode): ToolResult {
  const message = code === CANCELLED
    ? "工具调用已在 Session 恢复期间取消"
    : code === APPROVAL_DENIED
      ? "工具调用未获批准"
      : "工具调用的执行状态未知，未自动重试"
  return {
    status: "error",
    content: [{ type: "text", text: `${code}: ${message}` }],
    error: { source: "tool", code, message },
  }
}

/**
 * 要求事件包含正整数 Turn 编号。
 *
 * @param sessionId 被校验的 Session ID。
 * @param event 待校验的事件对象。
 * @param index 事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当 `turn` 不是正整数时抛出。
 */
function requireTurn(sessionId: string, event: Record<string, unknown>, index: number): void {
  if (!isPositiveInteger(event.turn)) corrupted(sessionId, `第 ${index + 1} 条事件的 turn 无效`)
}

/**
 * 要求事件同时包含正整数 Turn 和 Step 编号。
 *
 * @param sessionId 被校验的 Session ID。
 * @param event 待校验的事件对象。
 * @param index 事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当 `turn` 或 `step` 不是正整数时抛出。
 */
function requireTurnAndStep(sessionId: string, event: Record<string, unknown>, index: number): void {
  requireTurn(sessionId, event, index)
  if (!isPositiveInteger(event.step)) corrupted(sessionId, `第 ${index + 1} 条事件的 step 无效`)
}

/**
 * 要求事件包含非空字符串字段。
 *
 * @param sessionId 被校验的 Session ID。
 * @param event 待校验的事件对象。
 * @param field 要求存在的字段名。
 * @param index 事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当字段缺失或不是非空字符串时抛出。
 */
function requireStringField(
  sessionId: string,
  event: Record<string, unknown>,
  field: string,
  index: number,
): void {
  if (!isNonEmptyString(event[field])) corrupted(sessionId, `第 ${index + 1} 条事件缺少 ${field}`)
}

/**
 * 校验 Turn 或 Step 的结束原因。
 *
 * @param sessionId 被校验的 Session ID。
 * @param reason 待校验的结束原因。
 * @param index 事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当结束原因不是合法的 completed、stopped 或 error 时抛出。
 */
function requireEndReason(sessionId: string, reason: unknown, index: number): void {
  if (reason !== "completed" && reason !== "stopped" && reason !== "error") {
    corrupted(sessionId, `第 ${index + 1} 条事件的结束原因无效`)
  }
}

/**
 * 校验事件中的模型引用结构。
 *
 * @param sessionId 被校验的 Session ID。
 * @param model 待校验的模型引用值。
 * @param index 事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当模型引用缺少必要字段或协议无效时抛出。
 */
function requireModel(sessionId: string, model: unknown, index: number): void {
  if (!isRecord(model)) corrupted(sessionId, `第 ${index + 1} 条事件缺少 model`)
  if (!isNonEmptyString(model.providerId) || !isNonEmptyString(model.modelId)) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 model 无效`)
  }
  if (model.protocol !== "anthropic_messages" && model.protocol !== "chat_completions" && model.protocol !== "responses") {
    corrupted(sessionId, `第 ${index + 1} 条事件的 model.protocol 无效`)
  }
}

/**
 * 校验用户消息的身份、角色和文本内容。
 *
 * @param sessionId 被校验的 Session ID。
 * @param message 待校验的用户消息值。
 * @param index 事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当消息身份、角色或 content 结构无效时抛出。
 */
function requireUserMessage(sessionId: string, message: unknown, index: number): void {
  if (!isRecord(message) || !isNonEmptyString(message.id) || message.role !== "user") {
    corrupted(sessionId, `第 ${index + 1} 条事件的 user message 无效`)
  }
  if (!Array.isArray(message.content) || !message.content.every(isTextBlock)) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 user content 无效`)
  }
}

/**
 * 校验 Assistant 消息的身份、角色和全部内容块。
 *
 * @param sessionId 被校验的 Session ID。
 * @param message 待校验的 Assistant 消息值。
 * @param index 事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当消息或任一内容块结构无效时抛出。
 */
function requireAssistantMessage(sessionId: string, message: unknown, index: number): void {
  if (!isRecord(message) || !isNonEmptyString(message.id) || message.role !== "assistant") {
    corrupted(sessionId, `第 ${index + 1} 条事件的 assistant message 无效`)
  }
  if (!Array.isArray(message.content)) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 assistant content 无效`)
  }
  for (const block of message.content) requireAssistantBlock(sessionId, block, index)
}

/**
 * 校验 Assistant 内容块的文本或工具调用结构。
 *
 * @param sessionId 被校验的 Session ID。
 * @param block 待校验的 Assistant 内容块值。
 * @param index 所属事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当内容块类型或对应字段无效时抛出。
 */
function requireAssistantBlock(sessionId: string, block: unknown, index: number): void {
  if (!isRecord(block)) corrupted(sessionId, `第 ${index + 1} 条事件的 Assistant Block 无效`)
  if (block.type === "thinking" || block.type === "text") {
    if (typeof block.text !== "string") corrupted(sessionId, `第 ${index + 1} 条事件的文本 Block 无效`)
    return
  }
  if (block.type === "tool_call") {
    if (!isNonEmptyString(block.toolCallId) || !isNonEmptyString(block.name) || !("arguments" in block)) {
      corrupted(sessionId, `第 ${index + 1} 条事件的 tool_call Block 无效`)
    }
    return
  }
  corrupted(sessionId, `第 ${index + 1} 条事件的 Assistant Block 类型无效`)
}

/**
 * 校验 Assistant Block Delta 的文本或工具调用增量结构。
 *
 * @param sessionId 被校验的 Session ID。
 * @param delta 待校验的 Block Delta 值。
 * @param index 所属事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当 Delta 类型或字段值无效时抛出。
 */
function requireBlockDelta(sessionId: string, delta: unknown, index: number): void {
  if (!isRecord(delta)) corrupted(sessionId, `第 ${index + 1} 条事件的 Block Delta 无效`)
  if (delta.type === "thinking" || delta.type === "text") {
    if (typeof delta.text !== "string") corrupted(sessionId, `第 ${index + 1} 条事件的文本 Delta 无效`)
    return
  }
  if (delta.type === "tool_call") {
    if (!isNonEmptyString(delta.toolCallId)) corrupted(sessionId, `第 ${index + 1} 条事件的 tool_call Delta 无效`)
    if (delta.nameDelta !== undefined && typeof delta.nameDelta !== "string") {
      corrupted(sessionId, `第 ${index + 1} 条事件的 nameDelta 无效`)
    }
    if (delta.argumentsDelta !== undefined && typeof delta.argumentsDelta !== "string") {
      corrupted(sessionId, `第 ${index + 1} 条事件的 argumentsDelta 无效`)
    }
    return
  }
  corrupted(sessionId, `第 ${index + 1} 条事件的 Block Delta 类型无效`)
}

/**
 * 校验统一 ToolResult 的状态、内容和错误字段。
 *
 * @param sessionId 被校验的 Session ID。
 * @param result 待校验的工具结果值。
 * @param index 所属事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当结果状态、content 或 error 结构无效时抛出。
 */
function requireToolResult(sessionId: string, result: unknown, index: number): void {
  if (!isRecord(result) || (result.status !== "success" && result.status !== "error")) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 ToolResult 无效`)
  }
  if (!Array.isArray(result.content)) corrupted(sessionId, `第 ${index + 1} 条事件的 ToolResult.content 无效`)
  if (result.status === "error" && !isRecord(result.error)) {
    corrupted(sessionId, `第 ${index + 1} 条错误 ToolResult 缺少 error`)
  }
}

/**
 * 校验模型 Usage 的必填和可选计数字段。
 *
 * @param sessionId 被校验的 Session ID。
 * @param usage 待校验的 Usage 值。
 * @param index 所属事件在日志中的零基索引。
 * @throws SessionLogCorruptedError 当计数不是有限的非负数时抛出。
 */
function requireUsage(sessionId: string, usage: unknown, index: number): void {
  if (!isRecord(usage) || !isNonNegativeNumber(usage.inputTokens) || !isNonNegativeNumber(usage.outputTokens)) {
    corrupted(sessionId, `第 ${index + 1} 条事件的 Usage 无效`)
  }
  for (const field of ["totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    if (usage[field] !== undefined && !isNonNegativeNumber(usage[field])) {
      corrupted(sessionId, `第 ${index + 1} 条事件的 Usage.${field} 无效`)
    }
  }
}

/**
 * 判断事件是否必须位于一个已打开的 Step 内。
 *
 * @param event 待判断的 Session 事件。
 * @returns 事件是否带有 Step 作用域并受 Step 生命周期约束。
 */
function isStepScopedEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { step: number }> {
  return event.type === "step/start" ||
    event.type === "step/end" ||
    event.type === "assistant/block_start" ||
    event.type === "assistant/block_delta" ||
    event.type === "assistant/block_end" ||
    event.type === "assistant/message" ||
    event.type === "tool/result" ||
    event.type === "approval/request" ||
    event.type === "approval/result"
}

/**
 * 构造 Block 流索引键。
 *
 * @param turn Block 所属的 Turn 编号。
 * @param step Block 所属的 Step 编号。
 * @param blockId Block 的稳定 ID。
 * @returns 用于索引 Block 流的复合键。
 */
function blockKey(turn: number, step: number, blockId: string): string {
  return `${turn}:${step}:${blockId}`
}

/**
 * 构造 Step 索引键。
 *
 * @param turn Step 所属的 Turn 编号。
 * @param step Step 编号。
 * @returns 用于索引 Step 状态的复合键。
 */
function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/**
 * 判断未知值是否为非数组对象记录。
 *
 * @param value 待判断的未知值。
 * @returns 值是否可按字符串键访问。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 判断未知值是否为大于零的整数。
 *
 * @param value 待判断的未知值。
 * @returns 值是否为正整数。
 */
function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0
}

/**
 * 判断未知值是否为非负整数。
 *
 * @param value 待判断的未知值。
 * @returns 值是否为非负整数。
 */
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
}

/**
 * 判断未知值是否为有限的非负数字。
 *
 * @param value 待判断的未知值。
 * @returns 值是否为有限且大于等于零的数字。
 */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/**
 * 判断未知值是否为非空字符串。
 *
 * @param value 待判断的未知值。
 * @returns 值是否为长度大于零的字符串。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/**
 * 判断未知值是否为架构允许的 AppError 来源。
 *
 * @param value 待判断的未知值。
 * @returns 值是否属于合法的 AppError source。
 */
function isAppErrorSource(value: unknown): boolean {
  return value === "runtime" ||
    value === "model" ||
    value === "tool" ||
    value === "mcp" ||
    value === "storage" ||
    value === "system"
}

/**
 * 判断未知值是否为包含字符串文本的模型文本块。
 *
 * @param value 待判断的未知值。
 * @returns 值是否符合 `{ type: "text", text: string }` 结构。
 */
function isTextBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "text" && typeof value.text === "string"
}

/**
 * 以统一的 Session 日志损坏错误中断当前校验或恢复流程。
 *
 * @param sessionId 被判定为损坏的 Session ID。
 * @param detail 描述具体不一致原因的诊断信息。
 * @throws SessionLogCorruptedError 始终抛出该错误，不返回。
 */
function corrupted(sessionId: string, detail: string): never {
  throw new SessionLogCorruptedError(sessionId, detail)
}
