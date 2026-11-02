/** 从工作区事件字典派生聊天页面；输入操作仅走 preload 的固定 Session API。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { IconArrowDown, IconArrowUp, IconBrain, IconCheck, IconCopy, IconPlayerStop, IconShieldCheck, IconSparkles, IconTool } from "@tabler/icons-react"
import type { AssistantContentBlock } from "../../runtime/model/src/types.ts"
import { preferredReasoningLevel } from "../../runtime/model/src/reasoning.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import type { ProviderSummary, SandboxMode, SessionSettingsPatch } from "../preload/session-api.ts"
import { errorMessage, projectSessionEvents, sessionKey, WorkspaceSessionState, type ChatItem } from "./session-state.ts"
import { MarkdownContent } from "./markdown-content.tsx"
import { ComposerInput } from "./composer-input.tsx"
import { ComposerModelPicker } from "./composer-model-picker.tsx"

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
/** 页面内使用的原始工具结果事件；不改变持久化事件结构。 */
type ToolResultEvent = Extract<SessionEvent, { type: "tool/result" }>
/**
 * 为当前会话内的工具调用生成无拼接歧义的展示关联键。
 * @param turn 调用所属轮次。
 * @param step 轮次内的模型请求编号。
 * @param toolCallId 模型生成的工具调用 ID。
 * @returns 仅供本次页面渲染使用的关联键。
 */
function toolDisplayKey(turn: number, step: number, toolCallId: string): string { return JSON.stringify([turn, step, toolCallId]) }
/**
 * 正文渲染 Markdown；思考、工具参数和对应结果在展开后以纯文本代码块展示。
 * @param props Assistant 内容块及可选的唯一对应工具结果事件。
 * @returns Markdown 正文或思考/工具展开区域；结果不创建独立展开入口。
 */
function AssistantBlock({ block, toolResult }: { block: AssistantContentBlock; toolResult?: ToolResultEvent }) {
  if (block.type === "text") return <div className="assistant-text"><MarkdownContent text={block.text} /></div>
  if (block.type === "thinking") return <details className="chat-detail thinking-detail"><summary><IconBrain size={15} />思考过程</summary><pre className="process-content"><code className="language-text">{block.text}</code></pre></details>
  return <details className="chat-detail tool-detail"><summary><IconTool size={15} />工具：{block.name || "准备调用…"}{toolResult && (toolResult.result.status === "success" ? " · 完成" : " · 失败")}</summary>
    <div className="tool-section-label">调用参数</div>
    <pre className="process-content"><code className="language-text">{printable(block.arguments)}</code></pre>
    {toolResult && <>
      <div className="tool-section-label">工具结果</div>
      <pre className="process-content tool-result-content"><code className="language-text">{toolResult.result.content.filter((content) => content.type === "text").map((content) => content.text).join("\n\n")}</code></pre>
      {toolResult.result.status === "error" && <p className="chat-error">{toolResult.result.error.message}</p>}
    </>}
  </details>
}
/**
 * 复制单条消息的正文原文；反馈仅保留在当前按钮，不改写 Session 或消息内容。
 * @param props 待复制原文及区分用户消息和 AI 回复的无障碍标签。
 * @returns 复制按钮与结果提示；没有可见正文时不显示操作。
 */
function MessageCopyButton({ text, label }: { text: string; label: "复制AI回复" | "复制用户消息" }) {
  const [copying, setCopying] = useState(false)
  const [result, setResult] = useState<{ text: string; status: "copied" | "error" } | null>(null)
  const outcome = result?.text === text ? result.status : null
  useEffect(() => {
    if (result?.status !== "copied") return
    const timer = setTimeout(() => setResult(null), 2000)
    return () => clearTimeout(timer)
  }, [result])
  /**
   * 将点击时的正文快照写入系统剪贴板，写入失败时保留可重试入口。
   * @returns 写入和本地反馈更新完成；剪贴板异常转成当前按钮旁的错误提示。
   */
  async function copyMessage(): Promise<void> {
    if (copying) return
    setCopying(true)
    setResult(null)
    try { await navigator.clipboard.writeText(text); setResult({ text, status: "copied" }) }
    catch { setResult({ text, status: "error" }) }
    finally { setCopying(false) }
  }
  if (!text.trim()) return null
  return <span className="message-copy-control">
    <button type="button" className="message-copy-button" aria-label={label} title={outcome === "copied" ? "已复制" : outcome === "error" ? "复制失败，请重试" : label} disabled={copying} onClick={() => void copyMessage()}>
      {outcome === "copied" ? <IconCheck size={16} stroke={1.6} aria-hidden="true" /> : <IconCopy size={16} stroke={1.6} aria-hidden="true" />}
    </button>
    <span className={outcome === "error" ? "message-copy-feedback message-copy-error" : "message-copy-feedback"} role={outcome === "error" ? "alert" : "status"}>{outcome === "copied" ? "已复制" : outcome === "error" ? "复制失败，请重试" : ""}</span>
  </span>
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
  const showStop = control?.phase === "stopping" || (control?.phase === "running" && !(state.draftsByKey[key] ?? "").trim())
  const endRef = useRef<HTMLDivElement>(null)
  const scrollingRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const approvalRef = useRef<HTMLElement>(null)
  const followsRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [submittedApprovalId, setSubmittedApprovalId] = useState<string | null>(null)
  const blocks = projectSessionEvents(events)
  /** 每次从当前投影计数，避免流式块和权威消息被当作两次调用。 */
  const toolCallCounts = new Map<string, number>()
  for (const display of blocks) {
    const items = display.kind === "completed-turn" ? display.process : [display]
    for (const item of items) if (item.kind === "assistant") for (const content of item.blocks) {
      if (content.type !== "tool_call" || !content.toolCallId) continue
      const identity = toolDisplayKey(item.turn, item.step, content.toolCallId)
      toolCallCounts.set(identity, (toolCallCounts.get(identity) ?? 0) + 1)
    }
  }
  /** null 表示结果身份存在歧义；保留这些事件的独立展示。 */
  const toolResults = new Map<string, ToolResultEvent | null>()
  for (const event of events) if (event.type === "tool/result") {
    const identity = toolDisplayKey(event.turn, event.step, event.toolCallId)
    toolResults.set(identity, toolResults.has(identity) ? null : event)
  }
  const pairedResultIds = new Set<string>()
  for (const [identity, result] of toolResults) {
    if (result && toolCallCounts.get(identity) === 1) pairedResultIds.add(result.eventId)
    else toolResults.set(identity, null)
  }
  /** 未结束 Turn 的首个 Assistant Step 承担整轮标题；完成态由 Turn 容器承担。 */
  const firstAssistantByTurn = new Map<number, string>()
  for (const block of blocks) {
    if (block.kind === "assistant" && !firstAssistantByTurn.has(block.turn)) firstAssistantByTurn.set(block.turn, block.id)
  }
  const committedMessageIds = new Set(events.filter((event) => event.type === "user/message").map((event) => event.message.id))
  const pendingMessages = control?.pendingMessages.filter((message) => !committedMessageIds.has(message.messageId)) ?? []
  const approvalRequests = new Map(events.filter((event) => event.type === "approval/request").map((event) => [event.approvalId, event]))
  const approvalResults = new Set(events.filter((event) => event.type === "approval/result").map((event) => event.approvalId))
  const turnEnded = events.some((event) => event.type === "turn/end" && event.turn === control?.currentTurn)
  const pendingApproval = control?.phase === "running" && !turnEnded
    ? [...approvalRequests.values()].find((event) => event.turn === control.currentTurn && !approvalResults.has(event.approvalId)) : undefined
  const modelOptions = providers.flatMap((provider) => provider.models.map((model) => ({
    providerId: provider.providerId, protocol: provider.protocol, modelId: model.modelId, name: model.name,
    supportsReasoning: model.supportsReasoning,
    reasoningLevels: model.reasoningLevels,
    providerName: provider.name,
  })))
  const selectedKey = control ? JSON.stringify([control.currentModel.providerId, control.currentModel.modelId]) : ""
  const currentModelOption = modelOptions.find((model) => JSON.stringify([model.providerId, model.modelId]) === selectedKey)
  const reasoningOptions = currentModelOption?.reasoningLevels ?? []
  useEffect(() => { followsRef.current = true; setShowScrollToBottom(false); endRef.current?.scrollIntoView() }, [key])
  useEffect(() => { if (followsRef.current) endRef.current?.scrollIntoView({ block: "end" }) }, [events.length, key])
  useLayoutEffect(() => {
    const composer = composerRef.current, page = pageRef.current, dialog = approvalRef.current
    if (!pendingApproval || !composer || !page || !dialog) return
    /** 根据输入区上方的实际空间限制浮窗高度；输入区增高或窗口缩小时保留可见操作。 */
    const measure = () => composer.style.setProperty("--approval-space", Math.max(0, composer.getBoundingClientRect().top - page.getBoundingClientRect().top - 10) + "px")
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(page); observer.observe(composer)
    if (composer.parentElement) observer.observe(composer.parentElement)
    if (!composer.contains(document.activeElement)) dialog.focus()
    return () => { observer.disconnect() }
  }, [key, pendingApproval?.approvalId])

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
      else await window.nicode.continueSession(projectId, sessionId, { content })
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
   * @returns 决定提交完成；已接受时等待结果事件移除浮窗，失效请求主动重新同步历史。
   */
  async function decide(event: Extract<SessionEvent, { type: "approval/request" }>, decision: "approved" | "denied"): Promise<void> {
    if (pendingApproval?.approvalId !== event.approvalId || submittedApprovalId === event.approvalId) return
    await operate(async () => {
      const result = await window.nicode.decideSessionApproval(projectId, sessionId, event.approvalId, decision)
      if (result.accepted) {
        setSubmittedApprovalId(event.approvalId)
        if (approvalRef.current?.contains(document.activeElement)) composerRef.current?.querySelector("textarea")?.focus()
      } else {
        state.setView(key, { operationError: "这项审批已结束。" })
        await state.load(projectId, sessionId, true)
      }
    })
  }
  /**
   * @param event 展示所需的持久化事件。
   * @returns 对应消息、审批结果或可展开的纯文本事件详情；请求由输入区浮窗处理。
   */
  function eventView(event: SessionEvent) {
    if (event.type === "user/message") {
      const text = event.message.content.map((block) => block.text).join("\n")
      return <div className="user-message"><div className="user-bubble">{text}</div><div className="message-actions user-message-actions"><MessageCopyButton text={text} label="复制用户消息" /></div></div>
    }
    if (event.type === "app/error") return <p className="chat-error" role="alert">{event.error.message}</p>
    if (event.type === "approval/result") {
      const request = approvalRequests.get(event.approvalId)
      return <details className="chat-detail approval-result" data-approval-id={event.approvalId}><summary><IconShieldCheck size={15} />审批{event.decision === "approved" ? "已批准" : event.decision === "denied" ? "已拒绝" : "已取消"}{request ? " · " + request.toolName : ""}</summary>
        {request?.reason && <p>{request.reason}</p>}
        <pre className="process-content"><code className="language-text">{request ? printable(request.arguments) : event.decision}</code></pre>
      </details>
    }
    if (event.type === "tool/result") return <details className="chat-detail"><summary>工具结果 · {event.result.status === "success" ? "完成" : "失败"}</summary>
      <pre className="process-content"><code className="language-text">{event.result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n")}</code></pre>
      {event.result.status === "error" && <p className="chat-error">{event.result.error.message}</p>}
    </details>
    if (event.type === "turn/file_changes") return <details className="chat-detail"><summary>文件变化</summary><pre className="process-content"><code className="language-text">{printable(event.files)}</code></pre></details>
    if (event.type === "context_update") return <details className="chat-detail"><summary>上下文更新</summary><pre className="process-content"><code className="language-text">{event.content}</code></pre></details>
    return null
  }
  /**
   * 展示过程内容；仅未结束 Turn 的首个 Assistant Step 显示整轮标题，过程项不提供 AI 复制入口。
   * @param item 一个 Assistant Step 或原始事件展示项。
   * @param showAssistantLabel 是否在该 Step 上显示整轮标题；完成态过程项保持 false。
   * @returns 对应内容的展示容器；组件 key 在当前对话内稳定。
   */
  function itemView(item: ChatItem, showAssistantLabel = false) {
    if (item.kind === "event" && item.event.type === "approval/request") return null
    if (item.kind === "event" && pairedResultIds.has(item.id)) return null
    return <div className={"chat-entry " + (item.kind === "assistant" ? "assistant-entry" : "")} key={JSON.stringify([key, item.id])}>
      {item.kind === "assistant" && showAssistantLabel && <div className="message-label"><span className="assistant-avatar"><IconSparkles size={13} /></span><strong>NiCode</strong><span>协作伙伴</span></div>}
      {item.kind === "assistant" ? item.blocks.map((content, index) => <AssistantBlock block={content} key={index}
        toolResult={content.type === "tool_call" ? toolResults.get(toolDisplayKey(item.turn, item.step, content.toolCallId)) ?? undefined : undefined} />) : eventView(item.event)}
    </div>
  }
  return <section className="chat-page" ref={pageRef} data-project-id={projectId} data-session-id={sessionId}>
    <div className="session-topline"><span>对话记录 <small>{events.filter((event) => event.type === "user/message").length} 条消息</small></span><span className={`session-phase phase-${control?.phase ?? "loading"}`} role="status"><i className="status-dot" />{!control ? "正在同步" : control.phase === "running" ? "正在运行" : control.phase === "stopping" ? "正在停止" : "准备就绪"}</span></div>
    <div className="chat-scroll" ref={scrollingRef} onScroll={() => {
      const node = scrollingRef.current
      if (node) { followsRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; setShowScrollToBottom(!followsRef.current) }
    }}>
      <div className="chat-messages">
        {!state.has(key) && <p role="status">{view.loading ? "正在加载对话…" : "等待加载对话"}</p>}
        {view.loadError && <p className="chat-error" role="alert">{view.loadError} <button onClick={() => void state.load(projectId, sessionId, true).catch(() => {})}>重试</button></p>}
        {blocks.map((block) => {
          if (block.kind !== "completed-turn") return itemView(block, block.kind === "assistant" && firstAssistantByTurn.get(block.turn) === block.id)
          const process = block.process.filter((item) => item.kind !== "event" || (item.event.type !== "turn/end" && item.event.type !== "approval/request" && !pairedResultIds.has(item.id)))
          return <div className="chat-entry assistant-entry" key={JSON.stringify([key, block.id])} data-turn={block.turn}>
            <div className="message-label"><span className="assistant-avatar"><IconSparkles size={13} /></span><strong>NiCode</strong><span>协作伙伴</span></div>
            {process.length > 0 && <details className="chat-detail turn-process"><summary><IconTool size={15} /><span className="process-title">执行过程</span><span className="process-count">{process.length} 项</span></summary>{process.map((item) => itemView(item))}</details>}
            {block.finalAnswer.length > 0 && <div className="final-answer">
              {block.finalAnswer.map((content, index) => <AssistantBlock block={content} key={index} />)}
            </div>}
            {block.finalAnswer.some((content) => content.text.trim()) && <div className="message-actions"><MessageCopyButton text={block.finalAnswer.map((content) => content.text).join("\n\n")} label="复制AI回复" /></div>}
          </div>
        })}
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
      {!pendingApproval && view.operationError && <p className="chat-error" role="alert">{view.operationError}</p>}
      <div className="composer-anchor" ref={composerRef}>
      {pendingApproval && <section className="approval-popover" role="dialog" aria-modal="false" aria-labelledby="approval-title" tabIndex={-1} ref={approvalRef} key={pendingApproval.approvalId} data-approval-id={pendingApproval.approvalId}>
        <div className="approval-heading"><IconShieldCheck size={19} /><div><span>需要你的确认</span><strong id="approval-title">工具访问需要批准：{pendingApproval.toolName}</strong></div></div>
        <div className="approval-body">
          {pendingApproval.reason && <p>{pendingApproval.reason}</p>}
          <pre className="process-content"><code className="language-text">{printable(pendingApproval.arguments)}</code></pre>
        </div>
        <div className="approval-actions"><span role="status">{view.busy || submittedApprovalId === pendingApproval.approvalId ? "正在确认…" : "仅本次调用"}</span><button type="button" className="settings-secondary-button" disabled={view.busy || submittedApprovalId === pendingApproval.approvalId} onClick={() => void decide(pendingApproval, "denied")}>拒绝</button><button type="button" className="settings-primary-button" disabled={view.busy || submittedApprovalId === pendingApproval.approvalId} onClick={() => void decide(pendingApproval, "approved")}><IconCheck size={14} />批准</button></div>
        {view.operationError && <p className="chat-error" role="alert">{view.operationError}</p>}
      </section>}
      <div className="composer">
        <ComposerInput aria-label="消息内容" placeholder={control?.phase === "running" ? "输入下一条消息，发送后加入队列…" : "继续这段对话…"}
          value={state.draftsByKey[key] ?? ""} onChange={(event) => state.setDraft(key, event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
        <div className="composer-toolbar">
          <div className="chat-selectors">
            <label className="chat-select-label chat-permission-select"><IconShieldCheck size={15} aria-hidden="true" /><select aria-label="对话权限" disabled={!control || view.busy} value={control?.sandboxMode ?? "sandbox-full-access"} onChange={(event) => void settings({ sandboxMode: event.target.value as SandboxMode })}>
              {Object.entries(sandboxLabels).map(([mode, label]) => <option value={mode} key={mode}>{label}</option>)}
            </select></label>
          </div>
          <div className="composer-controls">
            <ComposerModelPicker key={key} label="对话模型" options={modelOptions.map((model) => ({ key: JSON.stringify([model.providerId, model.modelId]), name: model.name, providerName: model.providerName }))}
              selectedKey={selectedKey} modelName={control?.currentModel.name ?? "选择模型"} reasoningLevel={control?.currentModel.reasoningLevel ?? ""}
              supportsReasoning={currentModelOption?.supportsReasoning ?? false} reasoningLevels={reasoningOptions} disabled={!control || Boolean(view.busy)}
              onModelChange={(selection) => {
                const model = modelOptions.find((item) => JSON.stringify([item.providerId, item.modelId]) === selection)
                if (model) { const { providerName: _provider, supportsReasoning: _supportsReasoning, reasoningLevels, ...reference } = model; void settings({ model: {
                  ...reference, reasoningLevel: preferredReasoningLevel(reasoningLevels, control?.currentModel.reasoningLevel),
                } }) }
              }} onReasoningChange={(reasoningLevel) => { if (control) void settings({ model: { ...control.currentModel, reasoningLevel } }) }} />
            <button type="button" className="send-button" aria-label={showStop ? (control?.phase === "stopping" ? "正在停止" : "停止") : (control?.phase === "running" ? "加入队列" : "发送消息")} title={showStop ? (control?.phase === "stopping" ? "正在停止" : "停止") : (control?.phase === "running" ? "加入队列" : "发送消息")} disabled={!control || view.busy || control.phase === "stopping" || (!showStop && !(state.draftsByKey[key] ?? "").trim())} onClick={() => { if (showStop) void operate(() => window.nicode.stopSession(projectId, sessionId)); else void send() }}>{showStop ? <IconPlayerStop size={16} stroke={2} aria-hidden="true" /> : <IconArrowUp size={18} stroke={2} aria-hidden="true" />}</button>
          </div>
        </div>
      </div>
      </div>
      <div className="composer-caption"><span>{control?.phase === "running" ? "发送的消息将加入队列" : "Enter 发送 · Shift + Enter 换行"}</span></div>
    </div>
  </section>
}
