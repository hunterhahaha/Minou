/** 工作区生命周期内的原始事件缓存与纯展示投影，不保存凭据或模型 Adapter。 */
import type { AssistantContentBlock, ModelTextBlock } from "../../runtime/model/src/types.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import type { NiCodePreloadApi, SessionControl, SessionData, SessionSummary, SessionUpdate } from "../preload/session-api.ts"

/** 联合身份使用 JSON 数组编码。 */
export type SessionKey = string
/** 摘要、控制快照与操作状态独立于原始历史保存。 */
export interface SessionView {
  /** 历史查询返回的摘要。 */
  summary?: SessionSummary
  /** 已取得事件水位后生效的控制快照。 */
  control?: SessionControl
  /** 更高版本但尚未取得其 throughSeq 的快照。 */
  pendingControl?: SessionControl
  /** 正在执行首次加载或补查。 */
  loading?: boolean
  /** 历史查询失败；明确重试时清除。 */
  loadError?: string
  /** 命令或后台错误；下一次用户操作前清除。 */
  operationError?: string
  /** 当前正在提交用户操作，防止重复点击。 */
  busy?: boolean
}
/**
 * @param projectId 所属分组。
 * @param sessionId 对话或新聊天标识。
 * @returns 无拼接歧义的字典键。
 */
export function sessionKey(projectId: string, sessionId: string): SessionKey { return JSON.stringify([projectId, sessionId]) }
/**
 * @param groups 历史和实时事件。
 * @returns 按身份去重、按提交序号排序的原始事件。
 * @throws Error 同序号或同身份冲突。
 */
export function mergeSessionEvents(...groups: readonly (readonly SessionEvent[])[]): SessionEvent[] {
  const events = new Map<string, SessionEvent>()
  const seqs = new Map<number, string>()
  for (const group of groups) for (const event of group) {
    const previous = events.get(event.eventId)
    if ((previous && previous.seq !== event.seq) || (seqs.has(event.seq) && seqs.get(event.seq) !== event.eventId)) {
      throw new Error("对话事件身份冲突")
    }
    events.set(event.eventId, event)
    seqs.set(event.seq, event.eventId)
  }
  return [...events.values()].sort((a, b) => a.seq - b.seq)
}
/**
 * @param events 已排序事件。
 * @returns 从 1 起连续取得的最后序号。
 */
export function throughSeq(events: readonly SessionEvent[]): number {
  let seq = 0
  for (const event of events) { if (event.seq !== seq + 1) break; seq = event.seq }
  return seq
}
/**
 * @param error IPC 或缓存错误。
 * @returns 可显示的错误消息。
 */
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/**
 * Workspace 持有一个实例；路由卸载保留字典、草稿和未完成请求，工作区卸载取消订阅。
 * 所有变更直接通知 React 重绘，首次加载和缺口修复共用同一个请求表。
 */
export class WorkspaceSessionState {
  /** 只有完整初始化后才建立键，空数组同样属于有效缓存。 */
  readonly sessionEventsByKey: Record<SessionKey, SessionEvent[]> = {}
  /** 各对话控制、加载和操作状态。 */
  readonly sessionViewsByKey: Record<SessionKey, SessionView> = {}
  /** 对话及分组新聊天草稿。 */
  readonly draftsByKey: Record<SessionKey, string> = {}
  /** 同一身份只允许一个历史请求。 */
  readonly sessionLoadsRef = new Map<SessionKey, Promise<void>>()
  /** 未初始化历史对话先收到的事件。 */
  readonly pendingEventsRef = new Map<SessionKey, SessionEvent[]>()

  /** 唯一的历史查询出口；缓存命中不会调用。 */
  private readonly api: Pick<NiCodePreloadApi, "getSessionData">
  /** Workspace 的 React 更新通知。 */
  private readonly changed: () => void
  /**
   * 构造一个由 Workspace 持有的缓存实例。
   * @param api preload 查询能力。
   * @param changed 状态改变时通知工作区重绘。
   */
  constructor(api: Pick<NiCodePreloadApi, "getSessionData">, changed: () => void) { this.api = api; this.changed = changed }
  /**
   * @param key 联合身份。
   * @returns 键是否已经完整初始化。
   */
  has(key: SessionKey): boolean { return Object.hasOwn(this.sessionEventsByKey, key) }
  /**
   * @param key 联合身份。
   * @returns 独立的视图状态；不创建事件条目。
   */
  view(key: SessionKey): SessionView { return this.sessionViewsByKey[key] ??= {} }
  /**
   * @param key 草稿身份。
   * @param text 新草稿。
   */
  setDraft(key: SessionKey, text: string): void { this.draftsByKey[key] = text; this.changed() }
  /**
   * @param key 对话身份。
   * @param patch 操作或加载状态。
   */
  setView(key: SessionKey, patch: Partial<SessionView>): void { Object.assign(this.view(key), patch); this.changed() }
  /**
   * @param projectId 分组。
   * @param sessionId 对话。
   * @param force 明确重试或缺口修复时允许查询缓存。
   * @returns 请求结束；失败保留已有数据并传播。
   */
  load(projectId: string, sessionId: string, force = false): Promise<void> {
    const key = sessionKey(projectId, sessionId)
    const existing = this.sessionLoadsRef.get(key)
    if (existing) return existing
    if (this.has(key) && !force) return Promise.resolve()
    this.setView(key, { loading: true, loadError: undefined })
    let succeeded = false
    const request = Promise.resolve().then(() => this.api.getSessionData(projectId, sessionId)).then((data) => {
      this.applyData(data)
      succeeded = true
    }).catch((error: unknown) => {
      this.setView(key, { loadError: errorMessage(error) })
      throw error
    }).finally(() => {
      this.sessionLoadsRef.delete(key)
      this.setView(key, { loading: false })
      if (succeeded && this.needsRepair(key)) void this.load(projectId, sessionId, true).catch(() => {})
    })
    this.sessionLoadsRef.set(key, request)
    return request
  }
  /**
   * @param data 查询结果；合并请求期间已到达的事件，不覆盖较新控制版本。
   */
  applyData(data: SessionData): void {
    const key = sessionKey(data.projectId, data.sessionId)
    this.sessionEventsByKey[key] = mergeSessionEvents(data.events, this.sessionEventsByKey[key] ?? [], this.pendingEventsRef.get(key) ?? [])
    this.pendingEventsRef.delete(key)
    this.view(key).summary = data.summary
    this.acceptControl(key, data.control)
    this.releaseControl(key)
    this.changed()
  }
  /**
   * @param update 工作区订阅到的事件、控制或后台错误。
   */
  receive(update: SessionUpdate): void {
    const key = sessionKey(update.projectId, update.sessionId)
    if (update.kind === "event") {
      if (this.has(key) || update.event.seq === 1) {
        this.sessionEventsByKey[key] = mergeSessionEvents(this.sessionEventsByKey[key] ?? [], this.pendingEventsRef.get(key) ?? [], [update.event])
        this.pendingEventsRef.delete(key)
      } else {
        this.pendingEventsRef.set(key, mergeSessionEvents(this.pendingEventsRef.get(key) ?? [], [update.event]))
      }
      this.releaseControl(key)
    } else if (update.kind === "state") this.acceptControl(key, update.control)
    else this.view(key).operationError = update.error.message
    this.changed()
    if (this.needsRepair(key)) void this.load(update.projectId, update.sessionId, true).catch(() => {})
  }
  /**
   * @param key 身份。
   * @param control 设置响应或推送。
   */
  acceptControl(key: SessionKey, control: SessionControl): void {
    const view = this.view(key)
    const revision = Math.max(view.control?.revision ?? -1, view.pendingControl?.revision ?? -1)
    if (control.revision <= revision) return
    view.pendingControl = control
    this.releaseControl(key)
  }
  /**
   * @param key 身份。
   * @returns 是否已有正式缓存但缺少事件或状态对应的历史。
   */
  private needsRepair(key: SessionKey): boolean {
    if (!this.has(key)) return false
    const events = this.sessionEventsByKey[key]
    const through = throughSeq(events)
    return through < (events.at(-1)?.seq ?? 0) || through < (this.view(key).pendingControl?.throughSeq ?? 0)
  }
  /**
   * @param key 身份；状态只在其 throughSeq 已取得时生效。
   */
  private releaseControl(key: SessionKey): void {
    const view = this.view(key)
    if (this.has(key) && view.pendingControl && view.pendingControl.throughSeq <= throughSeq(this.sessionEventsByKey[key])) {
      view.control = view.pendingControl
      view.pendingControl = undefined
    }
  }
}

/** 一个 Step 的流式或权威正文。 */
export interface AssistantDisplay {
  /** Assistant Step 展示分支。 */
  kind: "assistant"
  /** 当前对话内由 Turn/Step 组成的稳定身份。 */
  id: string
  /** 内容所属的 Turn。 */
  turn: number
  /** Turn 内的模型请求编号。 */
  step: number
  /** 按块顺序排列的流式或权威内容。 */
  blocks: AssistantContentBlock[]
}
/** 复用原始事件的展示项；是否生成标签由页面决定。 */
export interface EventDisplay {
  /** 原始事件展示分支。 */
  kind: "event"
  /** 原始事件的稳定身份。 */
  id: string
  /** 展示来源；投影不改写该事件。 */
  event: SessionEvent
}
/** 进行中直接展示或结束后收入过程区域的内容。 */
export type ChatItem = AssistantDisplay | EventDisplay
/** 已收到 turn/end 的助手展示；用户消息继续作为独立项。 */
export interface CompletedTurnDisplay {
  /** Turn 整体展示分支，包括 completed、stopped 与 error。 */
  kind: "completed-turn"
  /** 当前对话内由 Turn 编号组成的稳定身份。 */
  id: string
  /** 内容所属的 Turn。 */
  turn: number
  /** 原始 turn/end 的结束原因。 */
  reason: Extract<SessionEvent, { type: "turn/end" }>["reason"]
  /** 保持原投影顺序的非最终正文内容，包含结束状态事件。 */
  process: ChatItem[]
  /** completed 时最后一条权威消息的全部 text 块；其它终态或无正文时为空。 */
  finalAnswer: ModelTextBlock[]
}
/** 未结束的直接展示项、用户消息或已结束 Turn 的整体展示。 */
export type ChatDisplay = ChatItem | CompletedTurnDisplay
/**
 * 汇聚 Assistant 流式块并以权威消息覆盖同一 Step；收到 turn/end 后重组该 Turn。
 * 仅 completed 提取最后一条权威消息的全部正文，用户消息与无 Turn 事件独立展示。
 * 不修改输入事件或工作区缓存；历史与实时更新使用相同投影规则。
 * @param events 单个对话按 seq 排序的原始事件。
 * @returns 未结束的平铺内容以及已结束 Turn 的过程和可选最终正文。
 */
export function projectSessionEvents(events: readonly SessionEvent[]): ChatDisplay[] {
  const result: ChatItem[] = []
  const steps = new Map<string, { display: AssistantDisplay; blocks: Map<string, { index: number; block: AssistantContentBlock }>; authoritative: boolean }>()
  const endings = new Map<number, Extract<SessionEvent, { type: "turn/end" }>>()
  const lastMessageSteps = new Map<number, number>()
  for (const event of events) {
    if (event.type === "turn/end") endings.set(event.turn, event)
    if (event.type === "assistant/block_start" || event.type === "assistant/block_delta" || event.type === "assistant/block_end" || event.type === "assistant/message") {
      const key = JSON.stringify([event.turn, event.step])
      let state = steps.get(key)
      if (!state) {
        const display: AssistantDisplay = { kind: "assistant", id: key, turn: event.turn, step: event.step, blocks: [] }
        state = { display, blocks: new Map(), authoritative: false }
        steps.set(key, state); result.push(display)
      }
      if (event.type === "assistant/message") {
        state.display.blocks = structuredClone(event.message.content)
        state.authoritative = true
        lastMessageSteps.set(event.turn, event.step)
        continue
      }
      if (state.authoritative) continue
      if (event.type === "assistant/block_start") state.blocks.set(event.blockId, {
        index: event.index, block: event.blockType === "tool_call"
          ? { type: "tool_call", toolCallId: "", name: "", arguments: "" }
          : { type: event.blockType, text: "" },
      })
      else if (event.type === "assistant/block_end") state.blocks.set(event.blockId, { index: event.index, block: structuredClone(event.block) })
      else {
        const current = state.blocks.get(event.blockId)
        if (current && current.block.type === event.delta.type) {
          if (current.block.type === "tool_call" && event.delta.type === "tool_call") {
            current.block.toolCallId = event.delta.toolCallId
            current.block.name += event.delta.nameDelta ?? ""
            current.block.arguments = String(current.block.arguments ?? "") + (event.delta.argumentsDelta ?? "")
          } else if (current.block.type !== "tool_call" && event.delta.type !== "tool_call") current.block.text += event.delta.text
        }
      }
      state.display.blocks = [...state.blocks.values()].sort((a, b) => a.index - b.index).map((value) => value.block)
    } else if (["user/message", "tool/result", "approval/request", "approval/result", "app/error", "turn/file_changes", "turn/end", "summary/start", "summary/end", "context_update"].includes(event.type)) {
      result.push({ kind: "event", id: event.eventId, event })
    }
  }
  /** 每个已结束 Turn 的整体展示与外部用户消息；只存本次投影派生数据。 */
  const completed = new Map<number, { display: CompletedTurnDisplay; users: EventDisplay[] }>()
  for (const [turn, end] of endings) completed.set(turn, {
    display: { kind: "completed-turn", id: JSON.stringify(["turn", turn]), turn, reason: end.reason, process: [], finalAnswer: [] },
    users: [],
  })
  for (const item of result) {
    const turn = item.kind === "assistant" ? item.turn : item.event.turn
    const group = turn === undefined ? undefined : completed.get(turn)
    if (!group) continue
    if (item.kind === "event" && item.event.type === "user/message") {
      group.users.push(item)
    } else if (item.kind === "assistant" && group.display.reason === "completed" && item.step === lastMessageSteps.get(item.turn)) {
      group.display.finalAnswer = item.blocks.filter((block) => block.type === "text")
      const processBlocks = item.blocks.filter((block) => block.type !== "text")
      if (processBlocks.length > 0) group.display.process.push({ ...item, blocks: processBlocks })
    } else group.display.process.push(item)
  }
  const display: ChatDisplay[] = []
  const emitted = new Set<number>()
  for (const item of result) {
    const turn = item.kind === "assistant" ? item.turn : item.event.turn
    const group = turn === undefined ? undefined : completed.get(turn)
    if (!group) display.push(item)
    else if (!emitted.has(group.display.turn)) {
      display.push(...group.users, group.display)
      emitted.add(group.display.turn)
    }
  }
  return display
}
