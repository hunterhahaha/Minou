/**
 * SessionRuntime 的活动实例、消息队列与两个 Turn 入口（架构备忘录第 13.1、13.2 节）。
 *
 * SessionRuntimePorts 绑定一个 Session 的 Event Log、派生状态、消息队列与持久化事件流；本文件实现
 * 第 10 节确定的 Event Log 校验与补写顺序，并以 FIFO 串行启动后续 Turn。
 * appendTurnStartAndUserMessage 必须在一个持久化批次中提交两条事件；失败不能启动 Loop。
 * 当前 runAgentLoop 只负责 Step，Turn 收尾仍由调用方处理。
 */

import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { CANCELLED } from "../../error/src/normalizer.ts"
import type {
  ModelAdapter,
  ModelMessage,
  ModelRef,
  ModelTextBlock,
  UnifiedToolDefinition,
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
import type {
  CurrentSessionBaseline,
  FileSessionState,
  SessionSkillContextEntry,
} from "../../session/src/session-state.ts"
import type { ToolResult } from "../../tools/src/types.ts"
import { runAgentLoop } from "./loop.ts"
import type { AgentLoopOptions, AgentLoopResult, ExecuteToolCall } from "./loop.ts"

/**
 * 单个 SessionRuntimePorts 使用的具体文件、上下文和 AgentLoop 资源绑定。
 *
 * 该类直接实现 Session 目录、Event Log 批量提交、Turn 开始增量、Context 回放与 Loop 资源装配；
 * Project/Skill 发现仍沿用既有 `resolveCurrentBaseline` 函数边界；启动装配只提供按 Turn
 * 创建 Adapter 的工厂和工具执行器，不保存跨 Turn Adapter。
 */
export class SessionRuntimeBindings {
  /** 当前绑定唯一服务的 Session ID。 */
  readonly sessionId: string
  /** 当前 Session 的 Event Log 与派生状态端口。 */
  readonly repairPorts: SessionRepairPorts

  private readonly sessionDirectory: string
  private readonly eventLog: FileSessionEventLog
  private readonly sessionState: FileSessionState
  private readonly systemPrompt: string
  private readonly workspaceInfo: string
  private readonly createTurnModelAdapter: (model: ModelRef) => Promise<ModelAdapter>
  private readonly executeTool: ExecuteToolCall
  private readonly resolveCurrentBaselineSource: () => Promise<CurrentSessionBaseline>
  private turnBaseline: Promise<CurrentSessionBaseline> | undefined

  /**
   * 创建一个完全绑定到单个 Session 的运行资源集合。
   *
   * @param options Session 文件位置、固定 System Message 片段、当前基线解析器、每 Turn Adapter 工厂与工具执行入口。
   * @throws Error 当 Session ID 或目录无效时抛出。
   */
  constructor(options: {
    sessionId: string
    sessionDirectory: string
    projectGroupId: string
    databasePath: string
    systemPrompt: string
    workspaceInfo: string
    resolveCurrentBaseline(): Promise<CurrentSessionBaseline>
    estimateSkillTokens(description: string): number
    createTurnModelAdapter(model: ModelRef): Promise<ModelAdapter>
    executeTool: ExecuteToolCall
    now?: () => Date
    createEventId?: () => string
  }) {
    validateRuntimeSessionId(options.sessionId)
    if (!isAbsolute(options.sessionDirectory)) {
      throw new Error(`Session 目录必须是绝对路径：${options.sessionDirectory}`)
    }
    this.sessionId = options.sessionId
    this.sessionDirectory = resolve(options.sessionDirectory)
    this.systemPrompt = options.systemPrompt
    this.workspaceInfo = options.workspaceInfo
    this.createTurnModelAdapter = options.createTurnModelAdapter
    this.executeTool = options.executeTool
    this.resolveCurrentBaselineSource = options.resolveCurrentBaseline

    this.eventLog = createFileSessionEventLog({
      sessionId: options.sessionId,
      sessionDirectory: this.sessionDirectory,
      projectGroupId: options.projectGroupId,
      databasePath: options.databasePath,
      now: options.now,
      createEventId: options.createEventId,
    })
    this.sessionState = createFileSessionState({
      sessionId: options.sessionId,
      sessionDirectory: this.sessionDirectory,
      databasePath: options.databasePath,
      readEvents: () => this.eventLog.readEvents(),
      resolveCurrentBaseline: () => this.resolveTurnBaseline(),
      estimateSkillTokens: options.estimateSkillTokens,
    })
    this.repairPorts = {
      readEvents: () => this.eventLog.readEvents(),
      initializeSession: () => this.sessionState.initializeSession(),
      repairDerivedState: (events) => this.sessionState.repairDerivedState(events),
      appendEvent: (event) => this.eventLog.appendEvent(event),
    }
  }

  /**
   * 在目标 Project/default 分组下创建当前 Session 的目录。
   *
   * @throws Error 当父分组不存在、目标目录已经存在或创建失败时抛出。
   */
  async createSessionDirectory(): Promise<void> {
    await mkdir(this.sessionDirectory, { recursive: false }).catch((error: unknown) => {
      throw new Error(`无法创建 Session 目录：${this.sessionDirectory}`, { cause: error })
    })
  }

  /**
   * 两条事件一次提交，顺序固定；实现者负责分配事件身份和持久化。
   * 同一 Session 并发启动时，须确保 turn 仍是下一个编号，否则拒绝提交。
   *
   * @param events 按 `turn/start`、`user/message` 顺序排列的成批事件。
   * @returns 已分配身份并成功持久化的两条完整事件。
   */
  appendTurnStartAndUserMessage(
    events: readonly [TurnStartEventInput, UserMessageEventInput],
  ): Promise<readonly [TurnStartEvent, UserMessageEvent]> {
    return this.eventLog.appendTurnStartAndUserMessage(events)
  }

  /**
   * 已有 Session 的 AGENTS.md / Skills 增量检查；先提交事件再更新比较状态。
   * 检查产生的事件必须使用注入的当前 Session 事件出口。
   *
   * @param appendEvent 当前活动实例唯一的持久化事件出口。
   */
  prepareExistingTurn(
    appendEvent: (event: SessionEventInput) => Promise<SessionEvent>,
  ): Promise<void> {
    return this.prepareExistingTurnInternal(appendEvent)
  }

  /**
   * 在进入 Loop 前构建一次完整 content。
   *
   * @param turn 要构建上下文的 Turn 编号。
   * @returns 供 AgentLoop 使用的模型消息上下文。
   */
  async buildContent(turn: number): Promise<ModelMessage[]> {
    const baseline = await this.resolveTurnBaseline()
    const events = validateEventLog(this.sessionId, await this.eventLog.readEvents())
    const lifecycle = validateLifecycle(this.sessionId, events)
    validateBlockStreams(this.sessionId, events)
    validateSummaries(this.sessionId, events)
    if (lifecycle.lastTurn !== turn || lifecycle.openTurn !== turn) {
      throw new Error(
        `无法为非当前开放 Turn 构建 Context：期望 ${lifecycle.openTurn ?? "无"}，实际 ${turn}`,
      )
    }
    return replayModelContent(events, composeSystemMessage(
      this.systemPrompt,
      this.workspaceInfo,
      baseline,
    ))
  }

  /**
   * 提供尚未由 SessionRuntime 装配的 Adapter 和工具。
   * 当前活动期共享的取消信号与唯一事件出口由 SessionRuntimePorts 注入。
   *
   * @param model 本 Turn 固定使用的模型引用。
   * @returns 可与 Turn、content、取消信号和事件出口合并成 AgentLoopOptions 的运行资源。
   */
  async createLoopOptions(
    model: ModelRef,
  ): Promise<Omit<AgentLoopOptions, "turn" | "model" | "content" | "signal" | "appendEvent">> {
    const adapter = await this.createTurnModelAdapter(structuredClone(model))
    return {
      adapter,
      tools: buildTools(model),
      executeTool: this.executeTool,
    }
  }

  /** @param model 要原子保存到当前 Session Meta 的模型选择。 */
  writeCurrentModel(model: ModelRef): Promise<void> {
    return this.sessionState.writeCurrentModel(model)
  }

  /** @returns 每次都从当前 Session `meta.json` 重新读取的模型选择。 */
  readCurrentModel(): Promise<ModelRef> {
    return this.sessionState.readCurrentModel()
  }

  /** 读取并缓存当前 Turn 使用的同一份固定上下文基线。 */
  private resolveTurnBaseline(): Promise<CurrentSessionBaseline> {
    if (this.turnBaseline === undefined) {
      this.turnBaseline = this.resolveCurrentBaselineSource().then((baseline) => structuredClone(baseline))
    }
    return this.turnBaseline
  }

  /** 执行已有 Session 的 AGENTS.md / Skill 比较、事件提交与派生状态推进。 */
  private async prepareExistingTurnInternal(
    appendEvent: (event: SessionEventInput) => Promise<SessionEvent>,
  ): Promise<void> {
    const events = validateEventLog(this.sessionId, await this.eventLog.readEvents())
    const lifecycle = validateLifecycle(this.sessionId, events)
    if (lifecycle.openTurn !== undefined || lifecycle.openStep !== undefined) {
      throw new Error(`Session 尚未恢复到一致状态，不能准备下一 Turn：${this.sessionId}`)
    }
    validateBlockStreams(this.sessionId, events)
    validateSummaries(this.sessionId, events)

    this.turnBaseline = this.resolveCurrentBaselineSource().then((baseline) => structuredClone(baseline))
    const baseline = await this.turnBaseline
    const comparison = await this.sessionState.readContextComparisonState()
    const turn = lifecycle.lastTurn + 1
    const appended: SessionEvent[] = []

    if (comparison.agentsSnapshot !== baseline.agentsmd.content) {
      const written = await appendEvent({
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
      const written = await appendEvent({
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
}

/**
 * 当前阶段的 Tool Definition 构建出口。
 *
 * ToolExposureManager 尚未落地；项目负责人已确认本任务只保留空工具构建占位，不能在这里伪造工具能力。
 *
 * @param _model 当前 Turn 的模型引用，后续 ToolExposureManager 可据模型能力筛选工具。
 * @returns 当前阶段不向模型暴露任何工具。
 */
function buildTools(_model: ModelRef): UnifiedToolDefinition[] {
  // TODO: ToolExposureManager 落地后，由它按当前 Session 与模型能力构建工具定义。
  return []
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
 * 单个活动 Session 的运行端口、消息队列和持久化事件流。
 *
 * 实例从创建起只服务 `sessionId` 指定的 Session。首次或继续入口由主进程启动，之后运行期间收到的
 * 消息进入当前实例的 FIFO 队列；消费循环在每个 Turn 完整结束后才会启动下一条消息。
 */
export class SessionRuntimePorts {
  /** 当前实例唯一绑定的 Session ID。 */
  readonly sessionId: string
  /** 当前活动期已经持久化的 Session 事件流。 */
  readonly events: AsyncIterable<SessionEvent>

  private readonly bindings: SessionRuntimeBindings
  /** 当前活动 Runtime 中所有 Turn / Loop 共享的取消控制器。 */
  private readonly abortController = new AbortController()
  private readonly eventStream = new SessionEventStream()
  private readonly pendingMessages: EnqueueSessionMessageInput[] = []
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
   * 创建一个绑定单个 Session 的活动 Runtime。
   *
   * @param sessionId 当前实例唯一服务的 Session ID。
   * @param bindings 当前 Session 已绑定的持久化、上下文和 Loop 宿主能力。
   */
  constructor(sessionId: string, bindings: SessionRuntimeBindings) {
    if (sessionId.trim() === "") {
      throw new Error("SessionRuntimePorts.sessionId 不能为空")
    }
    this.sessionId = sessionId
    this.bindings = bindings
    this.events = this.eventStream
  }

  /** 当前正在执行或最近一次启动的 Turn，供宿主关联后台错误。 */
  get currentTurn(): number | undefined {
    return this.activeTurn
  }

  /** 在目标 Project/default 分组下创建当前 Session 目录。 */
  createSessionDirectory(): Promise<void> {
    this.assertOpen()
    return this.bindings.createSessionDirectory()
  }

  /**
   * 成批提交新 Turn 的两条首事件，并在整个批次成功后发布到事件流。
   *
   * @param events 顺序固定的 `turn/start` 与 `user/message` 输入。
   * @returns 已成功持久化的完整事件。
   */
  async appendTurnStartAndUserMessage(
    events: readonly [TurnStartEventInput, UserMessageEventInput],
  ): Promise<readonly [TurnStartEvent, UserMessageEvent]> {
    this.assertOpen()
    const written = await this.bindings.appendTurnStartAndUserMessage(events)
    this.publishPersistedEvent(written[0], "turn/start")
    this.publishPersistedEvent(written[1], "user/message")
    return written
  }

  /** 首批事件已提交后，幂等补齐当前 Session 的派生状态。 */
  initializeSession(): Promise<void> {
    this.assertOpen()
    return this.bindings.repairPorts.initializeSession()
  }

  /**
   * 修复当前 Session 并返回最后 Turn；模型必须在 Turn 真正开始时另行从磁盘读取。
   *
   * @returns Event Log 修复后的最后 Turn 编号。
   */
  repairSession(): Promise<{ lastTurn: number }> {
    this.assertOpen()
    return repairSession(this.sessionId, this.boundRepairPorts())
  }

  /** 执行当前 Session 的 Turn 开始增量检查。 */
  prepareExistingTurn(): Promise<void> {
    this.assertOpen()
    return this.bindings.prepareExistingTurn((event) => this.appendEvent(event))
  }

  /**
   * 为指定 Turn 构建完整模型上下文。
   *
   * @param turn 要构建上下文的 Turn 编号。
   * @returns AgentLoop 使用的模型消息。
   */
  buildContent(turn: number): Promise<ModelMessage[]> {
    this.assertOpen()
    return this.bindings.buildContent(turn)
  }

  /** @param model 要原子保存到当前 Session Meta 的模型选择。 */
  writeCurrentModel(model: ModelRef): Promise<void> {
    this.assertOpen()
    return this.bindings.writeCurrentModel(model)
  }

  /** @returns 每次都从当前 Session `meta.json` 重新读取的模型选择。 */
  readCurrentModel(): Promise<ModelRef> {
    this.assertOpen()
    return this.bindings.readCurrentModel()
  }

  /**
   * 创建 Loop 资源，并强制注入当前活动期共享的取消信号与持久化事件出口。
   *
   * @param model 当前 Turn 固定使用的模型。
   * @returns 完整的 AgentLoop 非 Turn 参数。
   */
  async createLoopOptions(
    model: ModelRef,
  ): Promise<Omit<AgentLoopOptions, "turn" | "model" | "content">> {
    this.assertOpen()
    const options = await this.bindings.createLoopOptions(model)
    return {
      ...options,
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
    const written = await this.bindings.repairPorts.appendEvent(event)
    this.publishPersistedEvent(written, event.type)
    return written
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
    const queued = { content: cloneMessageContent(input.content) }
    this.pendingMessages.push(queued)
    return { sessionId: this.sessionId, content: cloneMessageContent(queued.content) }
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
   * aborted 状态。重复停止或实例已关闭时不产生额外效果。
   */
  stop(): void {
    if (this.closed) return
    this.abortController.abort()
  }

  /**
   * 关闭当前活动实例，丢弃尚未启动的消息并结束事件流。
   * 重复关闭不会产生额外效果。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.pendingMessages.length = 0
    this.eventStream.close()
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
          current = await continueQueuedSession(input, this)
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

  private boundRepairPorts(): SessionRepairPorts {
    return {
      readEvents: () => this.bindings.repairPorts.readEvents(),
      initializeSession: () => this.bindings.repairPorts.initializeSession(),
      repairDerivedState: (events) => this.bindings.repairPorts.repairDerivedState(events),
      appendEvent: (event) => this.appendEvent(event),
    }
  }

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
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`SessionRuntimePorts 已关闭：${this.sessionId}`)
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

/** 文件系统版 `SessionRepairPorts` 的创建参数。 */
export interface FileSessionRepairPortsOptions {
  /** 当前文件端口唯一绑定的 Session ID。 */
  sessionId: string
  /** 当前 Session 目录的绝对路径。 */
  sessionDirectory: string
  /** Session 所属 Project/default 分组 ID。 */
  projectGroupId: string
  /** 共享 Event Log 数据库绝对路径。 */
  databasePath: string
  /** 读取恢复当下的 AGENTS.md、Skill、MCP 及其它 Session meta 基线。 */
  resolveCurrentBaseline(): Promise<CurrentSessionBaseline>
  /** 计算 Skill description 的估算 Token，用于重放已提交的 Skill 增量。 */
  estimateSkillTokens(description: string): number
  /** 测试或宿主需要控制恢复事件时间时使用。 */
  now?: () => Date
  /** 测试或宿主需要控制恢复事件 ID 时使用。 */
  createEventId?: () => string
}

/**
 * 为一个确定的 Session 装配 `SessionRepairPorts` 的四项文件系统能力。
 *
 * Event Log 的读取与追加由 SessionEventLog 实现；派生文件的初始化与修复由 SessionState 实现。
 * AGENTS.md / Skill / MCP 的发现仍由各自 Runtime 负责，并通过 `resolveCurrentBaseline` 注入。
 * 同一活动 Session 应复用返回端口；新的 Session 创建自己的端口，不建立 Project 级访问器。
 *
 * @param options Session 身份与目录、当前上下文基线提供者及可选事件身份依赖。
 * @returns 只能服务该 Session、可交给 `repairSession` / `createRepairSession` 的完整端口。
 */
export function createFileSessionRepairPorts(
  options: FileSessionRepairPortsOptions,
): SessionRepairPorts {
  const eventLog = createFileSessionEventLog({
    sessionId: options.sessionId,
    sessionDirectory: options.sessionDirectory,
    projectGroupId: options.projectGroupId,
    databasePath: options.databasePath,
    now: options.now,
    createEventId: options.createEventId,
  })
  const sessionState = createFileSessionState({
    sessionId: options.sessionId,
    sessionDirectory: options.sessionDirectory,
    databasePath: options.databasePath,
    readEvents: eventLog.readEvents,
    resolveCurrentBaseline: options.resolveCurrentBaseline,
    estimateSkillTokens: options.estimateSkillTokens,
  })
  return {
    readEvents: () => eventLog.readEvents(),
    initializeSession: () => sessionState.initializeSession(),
    repairDerivedState: (events) => sessionState.repairDerivedState(events),
    appendEvent: (event) => eventLog.appendEvent(event),
  }
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
 * 创建已经绑定 Session 身份与文件端口的修复函数。
 * 持久化细节保留在 ports，恢复顺序和补写决策集中在本文件。
 *
 * @param sessionId 当前修复函数唯一服务的 Session ID。
 * @param ports 已经绑定同一 Session 的持久化端口。
 * @returns 无需再次传入 Session ID 的修复函数。
 */
export function createRepairSession(
  sessionId: string,
  ports: SessionRepairPorts,
): () => Promise<{ lastTurn: number }> {
  return () => repairSession(sessionId, ports)
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
 * 首次创建 Session。成功提交首批事件后即返回 sessionId，并继续初始化和运行。
 *
 * @param input 首个用户消息及其指定的模型。
 * @param ports 提供目录创建、首批事件提交、初始化和 AgentLoop 资源的运行端口。
 * @returns 已提交的 Session/Turn 身份，以及后台 AgentLoop 的完成 Promise。
 * @throws 首批事件提交失败时抛出，且不会启动 AgentLoop。
 */
export async function startNewSession(
  input: UserMessageInput,
  ports: SessionRuntimePorts,
): Promise<StartedSessionTurn> {
  const sessionId = ports.sessionId
  const turn = 1

  await ports.createSessionDirectory()
  await ports.appendTurnStartAndUserMessage(turnEvents(turn, input.model, input.content))

  const completion = runCommittedTurn(turn, ports, async () => {
    await ports.initializeSession()
    await ports.writeCurrentModel(input.model)
    const model = await ports.readCurrentModel()
    const loopOptions = await ports.createLoopOptions(model)
    return startLoop(turn, model, loopOptions, ports)
  })
  return { sessionId, turn, events: ports.events, completion }
}

/**
 * 在已修复的 Session 上创建下一 Turn，然后进入同一个 AgentLoop。
 *
 * @param input 下一 Turn 的用户消息与要覆盖到 Session Meta 的模型选择。
 * @param ports 提供 Session 修复、增量检查、事件提交和 AgentLoop 资源的运行端口。
 * @returns 已提交的下一 Turn 身份，以及后台 AgentLoop 的完成 Promise。
 * @throws Session 修复、增量检查或首批事件提交失败时抛出。
 */
export async function continueSession(
  input: ContinueSessionInput,
  ports: SessionRuntimePorts,
): Promise<StartedSessionTurn> {
  const sessionId = ports.sessionId
  const state = await ports.repairSession()
  await ports.prepareExistingTurn()
  await ports.writeCurrentModel(input.model)
  const model = await ports.readCurrentModel()
  const loopOptions = await ports.createLoopOptions(model)

  const turn = state.lastTurn + 1
  await ports.appendTurnStartAndUserMessage(turnEvents(turn, model, input.content))

  return {
    sessionId,
    turn,
    events: ports.events,
    completion: runCommittedTurn(
      turn,
      ports,
      () => startLoop(turn, model, loopOptions, ports),
    ),
  }
}

/**
 * 为 Queue 中的 content-only 消息启动下一 Turn。
 *
 * Queue 不覆盖模型；增量准备结束后重新打开 `meta.json`，并在提交新 Turn 前完成
 * 本 Turn Adapter 创建。失败时不会留下半提交的 `turn/start`。
 *
 * @param input Queue 中仅保存的用户文本。
 * @param ports 当前活动 Session 的运行端口。
 * @returns 已提交并开始执行的下一 Turn。
 */
async function continueQueuedSession(
  input: EnqueueSessionMessageInput,
  ports: SessionRuntimePorts,
): Promise<StartedSessionTurn> {
  const sessionId = ports.sessionId
  const state = await ports.repairSession()
  await ports.prepareExistingTurn()
  const model = await ports.readCurrentModel()
  const loopOptions = await ports.createLoopOptions(model)

  const turn = state.lastTurn + 1
  await ports.appendTurnStartAndUserMessage(turnEvents(turn, model, input.content))
  return {
    sessionId,
    turn,
    events: ports.events,
    completion: runCommittedTurn(
      turn,
      ports,
      () => startLoop(turn, model, loopOptions, ports),
    ),
  }
}

/**
 * 执行已经提交 `turn/start + user/message` 的 Turn，并保证 completion 覆盖最小 Turn 收尾。
 *
 * @param turn 当前已经提交的 Turn 编号。
 * @param ports 当前 Session 的运行端口。
 * @param run 初始化剩余状态并执行 AgentLoop 的函数。
 * @returns AgentLoop 结果；返回前已经提交对应的 `turn/end`。
 * @throws 初始化或 Loop 失败时先尝试提交 `turn/end(error)`，随后传播原始错误。
 */
async function runCommittedTurn(
  turn: number,
  ports: SessionRuntimePorts,
  run: () => Promise<AgentLoopResult>,
): Promise<AgentLoopResult> {
  let result: AgentLoopResult
  try {
    result = await run()
  } catch (error) {
    try {
      await ports.appendEvent({ type: "turn/end", turn, reason: "error" })
    } catch {
      // 保留原始运行错误；下次 repairSession 会修复仍未闭合的 Turn。
    }
    throw error
  }

  await ports.appendEvent({
    type: "turn/end",
    turn,
    reason: result.stopped ? "stopped" : "completed",
  })
  return result
}

/**
 * 构造新 Turn 必须成批提交的 `turn/start` 与 `user/message` 事件。
 *
 * @param turn 新 Turn 编号。
 * @param model 新 Turn 固定使用的模型引用。
 * @param content 用户消息的文本块内容。
 * @returns 顺序固定的两条事件输入。
 */
function turnEvents(
  turn: number,
  model: ModelRef,
  content: ModelTextBlock[],
): readonly [TurnStartEventInput, UserMessageEventInput] {
  return [
    { type: "turn/start", turn, model },
    { type: "user/message", turn, message: { id: randomUUID(), role: "user", content } },
  ]
}

/**
 * 为指定 Turn 构建上下文和 Loop 运行资源，并启动 AgentLoop。
 *
 * @param turn 要运行的 Turn 编号。
 * @param model 本 Turn 固定使用的模型引用。
 * @param ports 提供上下文构建和 Loop 依赖装配能力的端口。
 * @returns AgentLoop 的最终运行结果。
 * @throws AgentLoop 执行期间发生的非取消错误。
 */
async function startLoop(
  turn: number,
  model: ModelRef,
  options: Omit<AgentLoopOptions, "turn" | "model" | "content">,
  ports: SessionRuntimePorts,
): Promise<AgentLoopResult> {
  const content = await ports.buildContent(turn)
  return runAgentLoop({ ...options, turn, model, content })
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
