/** 从工作区事件字典派生聊天页面；输入操作仅走 preload 的固定 Session API。 */
import { useEffect, useRef, useState } from "react"
import { IconArrowDown, IconArrowUp, IconBrain, IconCheck, IconCpu, IconPlayerStop, IconShieldCheck, IconSparkles, IconTool } from "@tabler/icons-react"
import type { ModelRef, AssistantContentBlock } from "../../runtime/model/src/types.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import type { ProviderSummary, SandboxMode, SessionSettingsPatch } from "../preload/session-api.ts"
import { errorMessage, projectSessionEvents, sessionKey, WorkspaceSessionState, type ChatItem } from "./session-state.ts"
import { MarkdownContent } from "./markdown-content.tsx"
import { ComposerInput } from "./composer-input.tsx"

/** 已确定的 Session 权限展示。 */
export const sandboxLabels: Record<SandboxMode, string> = {
  "sandbox-full-access": "工作区读写", "sandbox-read-only": "工作区只读", "full-access": "完全访问",
}
/** 聊天路由与 Workspace 的明确数据边界。 */
export interface SessionPageProps {
  /** 路由中的分组身份。 */
  projectId: string
  /** 路由中的对话身份。 */
  sessionId: string
  /** 工作区持有的跨路由缓存与操作状态。 */
  state: WorkspaceSessionState
  /** 已有 Provider 的模型选项。 */
  providers: ProviderSummary[]
}
/**
 * @param value 工具参数或结果。
 * @returns 人可读的文本。
 */
function printable(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "" }
/**
 * 以 Markdown 展示正文与思考，工具调用仍按现有参数展示。
 * @param props 一个 Assistant 内容块。
 * @returns Markdown 正文或可展开的 Thinking/工具信息。
 */
function AssistantBlock({ block }: { block: AssistantContentBlock }) {
  if (block.type === "text") return <div className="assistant-text"><MarkdownContent text={block.text} /></div>
  if (block.type === "thinking") return <details className="chat-detail thinking-detail"><summary><IconBrain size={15} />思考过程</summary><div className="assistant-text"><MarkdownContent text={block.text} /></div></details>
  return <details className="chat-detail tool-detail"><summary><IconTool size={15} />工具：{block.name || "准备调用…"}</summary><pre>{printable(block.arguments)}</pre></details>
}
/**
 * 渲染一个对话。加载由 SessionRoute 决定；此组件只读取字典并发送明确的用户操作。
 * @param props 联合身份、工作区状态与可选模型。
 * @returns 消息、审批、Queue、权限与固定在底部的输入区。
 */
export function SessionPage({ projectId, sessionId, state, providers }: SessionPageProps) {
  const key = sessionKey(projectId, sessionId)
  const events = state.sessionEventsByKey[key] ?? []
  const view = state.view(key)
  const control = view.control
  const endRef = useRef<HTMLDivElement>(null)
  const scrollingRef = useRef<HTMLDivElement>(null)
  const followsRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const blocks = projectSessionEvents(events)
  const committedMessageIds = new Set(events.filter((event) => event.type === "user/message").map((event) => event.message.id))
  const pendingMessages = control?.pendingMessages.filter((message) => !committedMessageIds.has(message.messageId)) ?? []
  const approvalResults = new Map(events.filter((event) => event.type === "approval/result").map((event) => [event.approvalId, event.decision]))
  const modelOptions = providers.flatMap((provider) => provider.models.map((model) => ({
    providerId: provider.providerId, protocol: provider.protocol, modelId: model.modelId, name: model.name,
    label: provider.name + " / " + model.name,
  })))
  const selectedKey = control ? JSON.stringify([control.currentModel.providerId, control.currentModel.modelId]) : ""
  useEffect(() => { followsRef.current = true; setShowScrollToBottom(false); endRef.current?.scrollIntoView() }, [key])
  useEffect(() => { if (followsRef.current) endRef.current?.scrollIntoView({ block: "end" }) }, [events.length, key])

  /**
   * @param action 一个 IPC 操作。
   * @returns 操作完成；失败显示在当前对话且保留草稿。
   */
  async function operate(action: () => Promise<unknown>): Promise<void> {
    if (state.view(key).busy) return
    state.setView(key, { busy: true, operationError: undefined })
    try { await action() }
    catch (error) { state.setView(key, { operationError: errorMessage(error) }) }
    finally { state.setView(key, { busy: false }) }
  }
  /**
   * @param text 可选的未发送消息重试。
   * @returns 发送完成，成功时仅清理未改变的原草稿。
   */
  async function send(text = state.draftsByKey[key] ?? ""): Promise<void> {
    if (!text.trim() || !control || control.phase === "stopping") return
    await operate(async () => {
      const content = [{ type: "text" as const, text }]
      if (control.phase === "running") await window.nicode.enqueueSessionMessage(projectId, sessionId, { content })
      else await window.nicode.continueSession(projectId, sessionId, { content, model: control.currentModel })
      if (state.draftsByKey[key] === text) state.setDraft(key, "")
    })
  }
  /**
   * @param patch 后端确认后才显示的设置。
   * @returns 保存完成。
   */
  async function settings(patch: SessionSettingsPatch): Promise<void> {
    await operate(async () => {
      const next = await window.nicode.updateSessionSettings(projectId, sessionId, patch)
      state.receive({ kind: "state", projectId, sessionId, control: next })
    })
  }
  /**
   * @param event 请求审批的持久化事件。
   * @param decision 用户的明确决定。
   * @returns 操作完成。
   */
  async function decide(event: Extract<SessionEvent, { type: "approval/request" }>, decision: "approved" | "denied"): Promise<void> {
    await operate(async () => {
      const result = await window.nicode.decideSessionApproval(projectId, sessionId, event.approvalId, decision)
      if (!result.accepted) state.setView(key, { operationError: "这项审批已结束。" })
    })
  }
  /**
   * @param event 展示所需的持久化事件。
   * @returns 对应的消息或事件卡片。
   */
  function eventView(event: SessionEvent) {
    if (event.type === "user/message") return <div className="user-bubble">{event.message.content.map((block) => block.text).join("\n")}</div>
    if (event.type === "app/error") return <p className="chat-error" role="alert">{event.error.message}</p>
    if (event.type === "approval/result") return null
    if (event.type === "approval/request") {
      const result = approvalResults.get(event.approvalId)
      return <section className="approval-card"><div className="approval-heading"><IconShieldCheck size={20} /><div><span>需要你的确认</span><strong>工具访问需要批准：{event.toolName}</strong></div></div>
        {event.reason && <p>{event.reason}</p>}<pre>{printable(event.arguments)}</pre>
        {result ? <p>审批{result === "approved" ? "已批准" : result === "denied" ? "已拒绝" : "已取消"}</p>
          : <div className="approval-actions"><button className="settings-primary-button" disabled={view.busy || control?.phase !== "running"} onClick={() => void decide(event, "approved")}><IconCheck size={14} />批准</button><button className="settings-secondary-button" disabled={view.busy || control?.phase !== "running"} onClick={() => void decide(event, "denied")}>拒绝</button></div>}
      </section>
    }
    if (event.type === "tool/result") return <details className="chat-detail"><summary>工具结果 · {event.result.status === "success" ? "完成" : "失败"}</summary>
      {event.result.content.map((block, index) => block.type === "text" ? <pre key={index}>{block.text}</pre> : null)}
      {event.result.status === "error" && <p className="chat-error">{event.result.error.message}</p>}
    </details>
    if (event.type === "turn/file_changes") return <details className="chat-detail"><summary>文件变化</summary><pre>{printable(event.files)}</pre></details>
    if (event.type === "turn/end") return <p className={`turn-status turn-${event.reason}`}><IconCheck size={13} />{event.reason === "completed" ? "本轮完成" : event.reason === "stopped" ? "本轮已停止" : "本轮执行失败"}</p>
    if (event.type === "context_update") return <details className="chat-detail"><summary>上下文更新</summary><pre>{event.content}</pre></details>
    return null
  }
  /**
   * 复用进行中的内容标签，同时为完成态过程内容保留原有内部折叠与审批行为。
   * @param item 一个 Assistant Step 或原始事件展示项。
   * @returns 对应内容的展示容器；组件 key 在当前对话内稳定。
   */
  function itemView(item: ChatItem) {
    return <div className={"chat-entry " + (item.kind === "assistant" ? "assistant-entry" : "")} key={JSON.stringify([key, item.id])}>
      {item.kind === "assistant" && <div className="message-label"><span className="assistant-avatar"><IconSparkles size={13} /></span><strong>NiCode</strong><span>协作伙伴</span></div>}
      {item.kind === "event" && item.event.type === "user/message" && <div className="message-label user-label">你</div>}
      {item.kind === "assistant" ? item.blocks.map((content, index) => <AssistantBlock block={content} key={index} />) : eventView(item.event)}
    </div>
  }
  return <section className="chat-page" data-project-id={projectId} data-session-id={sessionId}>
    <div className="session-topline"><span>对话记录 <small>{events.filter((event) => event.type === "user/message").length} 条消息</small></span><span className={`session-phase phase-${control?.phase ?? "loading"}`} role="status"><i className="status-dot" />{!control ? "正在同步" : control.phase === "running" ? "正在运行" : control.phase === "stopping" ? "正在停止" : "准备就绪"}</span></div>
    <div className="chat-scroll" ref={scrollingRef} onScroll={() => {
      const node = scrollingRef.current
      if (node) { followsRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; setShowScrollToBottom(!followsRef.current) }
    }}>
      <div className="chat-messages">
        {!state.has(key) && <p role="status">{view.loading ? "正在加载对话…" : "等待加载对话"}</p>}
        {view.loadError && <p className="chat-error" role="alert">{view.loadError} <button onClick={() => void state.load(projectId, sessionId, true).catch(() => {})}>重试</button></p>}
        {blocks.map((block) => block.kind === "completed-turn"
          ? <div className="chat-entry assistant-entry" key={JSON.stringify([key, block.id])} data-turn={block.turn}>
            <div className="message-label"><span className="assistant-avatar"><IconSparkles size={13} /></span><strong>NiCode</strong><span>协作伙伴</span></div>
            <details className="chat-detail turn-process"><summary><IconTool size={15} /><span className="process-title">执行过程</span><span className="process-count">{block.process.length} 项</span></summary>{block.process.map(itemView)}</details>
            {block.finalAnswer.length > 0 && <div className="final-answer">
              {block.finalAnswer.map((content, index) => <AssistantBlock block={content} key={index} />)}
            </div>}
          </div>
          : itemView(block))}
        {control?.phase === "running" && <div className="agent-working" role="status"><span className="working-dots"><i /><i /><i /></span>NiCode 正在处理任务</div>}
        <div ref={endRef} />
      </div>
    </div>
    <div className="chat-footer">
      {showScrollToBottom && <button type="button" className="scroll-to-bottom" aria-label="回到最新消息" onClick={() => { followsRef.current = true; setShowScrollToBottom(false); endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }) }}><IconArrowDown size={15} />最新消息</button>}
      {pendingMessages.length > 0 && <section className="queue-list" aria-label="待处理消息">{pendingMessages.map((message) =>
        <div key={message.messageId}><span>{message.status === "starting" ? "正在准备" : "排队中"}</span><p>{message.content.map((block) => block.text).join("\n")}</p></div>)}</section>}
      {control && control.discardedMessages.length > 0 && <section className="queue-list" aria-label="未发送消息">{control.discardedMessages.map((message) =>
        <div key={message.messageId}><span>未发送</span><p>{message.content.map((block) => block.text).join("\n")}</p><button disabled={view.busy || control.phase === "stopping"} onClick={() => void send(message.content.map((block) => block.text).join("\n"))}>重试发送</button></div>)}</section>}
      {view.operationError && <p className="chat-error" role="alert">{view.operationError}</p>}
      <div className="composer">
        <ComposerInput aria-label="消息内容" placeholder={control?.phase === "running" ? "输入下一条消息，发送后加入队列…" : "继续这段对话…"}
          value={state.draftsByKey[key] ?? ""} onChange={(event) => state.setDraft(key, event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
        <div className="composer-toolbar">
          <div className="chat-selectors">
            <label className="chat-select-label"><IconShieldCheck size={14} /><select aria-label="对话权限" disabled={!control || view.busy} value={control?.sandboxMode ?? "sandbox-full-access"} onChange={(event) => void settings({ sandboxMode: event.target.value as SandboxMode })}>
              {Object.entries(sandboxLabels).map(([mode, label]) => <option value={mode} key={mode}>{label}</option>)}
            </select></label>
            <label className="chat-select-label"><IconCpu size={14} /><select aria-label="对话模型" disabled={!control || view.busy} value={selectedKey} onChange={(event) => {
              const model = modelOptions.find((item) => JSON.stringify([item.providerId, item.modelId]) === event.target.value)
              if (model) { const { label: _label, ...reference } = model; void settings({ model: reference as ModelRef }) }
            }}>
              {control && !modelOptions.some((model) => JSON.stringify([model.providerId, model.modelId]) === selectedKey) && <option value={selectedKey}>{control.currentModel.name}</option>}
              {modelOptions.map((model) => <option value={JSON.stringify([model.providerId, model.modelId])} key={JSON.stringify([model.providerId, model.modelId])}>{model.label}</option>)}
            </select></label>
          </div>
          <div className="composer-controls">
            {control && control.phase !== "idle" && <button className="stop-button" disabled={view.busy || control.phase === "stopping"} onClick={() => void operate(() => window.nicode.stopSession(projectId, sessionId))}><IconPlayerStop size={13} />{control.phase === "stopping" ? "正在停止" : "停止"}</button>}
            <button className="send-button" aria-label={control?.phase === "running" ? "加入队列" : "发送消息"} disabled={!control || view.busy || control.phase === "stopping" || !(state.draftsByKey[key] ?? "").trim()} onClick={() => void send()}><IconArrowUp size={18} stroke={2} /></button>
          </div>
        </div>
      </div>
      <div className="composer-caption"><span>{control?.phase === "running" ? "发送的消息将加入队列" : "Enter 发送 · Shift + Enter 换行"}</span></div>
    </div>
  </section>
}
