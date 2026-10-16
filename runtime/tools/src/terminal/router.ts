import { randomUUID } from "node:crypto"
import { ToolOutputStore } from "../process/output-store.ts"
import { processException } from "../process/access.ts"
import { PwshPtyBackend, type PtyBackend, type PtyEvent, type PtyProcess } from "./backend.ts"
import type { TerminalInputResult, TerminalState } from "./types.ts"

/** 不持久化的终端资源；标记监听与单次工具调用的取消信号相互独立。 */
interface TerminalEntry {
  /** 活动终端快照源。 */ state: TerminalState
  /** 已初始化的 Session 工具输出目录。 */ directory: string
  /** 本机终端句柄。 */ process?: PtyProcess
  /** 当前未交付输出，包含窗口结束后的积压。 */ pending: ToolOutputStore
  /** 最后开始或完成的命令执行序号。 */ run: number
  /** 是否已经收到首次就绪标记。 */ ready: boolean
  /** 自然退出，仍可拉取尾部输出。 */ exited: boolean
  /** 显式关闭后忽略所有迟到事件。 */ closed: boolean
  /** 输出落盘失败，后续调用返回错误直到关闭。 */ failure?: unknown
  /**
   * 将持续后端事件交给当前打开或输出收集操作；该操作结束后清除此临时出口。
   *
   * @param event - 已更新终端记录后交付的生命周期或输出事件。
   */ notify?: (event: PtyEvent) => void
}

/** 按 Project + Session 隔离并跨 Runtime 活动期保存终端资源。 */
export class TerminalRouter {
  private readonly backend: PtyBackend
  private readonly collectionMs: number
  private readonly startupMs: number
  private readonly sessions = new Map<string, Map<string, TerminalEntry>>()
  /**
   * 绑定 PTY 后端和收集时限；构造时不启动终端进程。
   *
   * @param backend - 创建本机 PTY 并持续报告输出、命令标记和退出事件的后端。
   * @param collectionMs - 单次输入的最长收集时间，默认 3000 毫秒；测试可传入较短时限。
   * @param startupMs - 打开终端等待首次就绪标记的时限，默认 10000 毫秒。
   */
  constructor(backend: PtyBackend = new PwshPtyBackend(), collectionMs = 3000, startupMs = 10000) { this.backend = backend; this.collectionMs = collectionMs; this.startupMs = startupMs }

  /**
   * 将 Project 与 Session 身份编码为资源字典的联合键。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 当前对话的 Session ID。
   * @returns 使用 JSON 数组编码的联合身份，避免两个字符串直接拼接产生歧义。
   */
  private key(projectId: string, sessionId: string): string { return JSON.stringify([projectId, sessionId]) }
  /**
   * 获取指定对话的终端字典；首次访问时创建空字典并登记到进程内资源表。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 与 projectId 共同确定终端资源隔离范围的 Session ID。
   * @returns 对话独占的可变终端字典；后续访问复用同一个字典对象。
   */
  private terminals(projectId: string, sessionId: string): Map<string, TerminalEntry> {
    const key = this.key(projectId, sessionId)
    let terminals = this.sessions.get(key)
    if (!terminals) { terminals = new Map(); this.sessions.set(key, terminals) }
    return terminals
  }
  /**
   * 从指定对话的资源字典查找终端，不创建新字典或新终端。自然退出但仍保留未读输出的记录仍可查到。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 允许访问目标终端的 Session ID。
   * @param id - 在该对话范围内查找的终端身份。
   * @returns 尚未显式移除的终端资源记录。
   * @throws Error - 终端不存在、属于其他对话或已经关闭；工具调用方负责转换为错误结果。
   */
  private entry(projectId: string, sessionId: string, id: string): TerminalEntry {
    const entry = this.sessions.get(this.key(projectId, sessionId))?.get(id)
    if (!entry || entry.closed) throw processException("TERMINAL_NOT_FOUND", "当前 Session 未找到终端：" + id)
    return entry
  }

  /**
   * 创建并登记一个 PTY，等待首次就绪标记后返回状态快照。启动失败或取消时移除记录并清理进程和未读输出。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 新终端归属的 Session ID。
   * @param cwd - Runtime 解析出的终端初始工作目录。
   * @param directory - Session 已初始化的 tool_output 绝对目录，用于输出缓冲和日志。
   * @param signal - 仅控制本次打开等待的取消信号；打开成功后不持续绑定终端生命周期。
   * @returns 首次就绪后的 idle 状态副本；底层终端继续由路由持有。
   * @throws Error - 输出目录不可用、启动失败、就绪超时、取消或清理失败；工具调用方负责转换为 AppError。
   */
  async open(projectId: string, sessionId: string, cwd: string, directory: string, signal: AbortSignal): Promise<TerminalState> {
    if (signal.aborted) throw processException("CANCELLED", "工具调用已取消")
    const state: TerminalState = { id: `term_${randomUUID()}`, cwd, status: "unknown" }
    const entry: TerminalEntry = { state, directory, pending: new ToolOutputStore(directory), run: 0, ready: false, exited: false, closed: false }
    const terminals = this.terminals(projectId, sessionId)
    terminals.set(state.id, entry)
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); entry.notify = undefined }
        const finish = (error?: unknown) => { cleanup(); if (error !== undefined) reject(error); else resolve() }
        const abort = () => finish(processException("CANCELLED", "工具调用已取消"))
        const timer = setTimeout(() => finish(processException("TERMINAL_START_TIMEOUT", "PTY 未在 10 秒内报告就绪")), this.startupMs)
        entry.notify = (event) => {
          if (entry.closed) finish(processException("CANCELLED", "终端操作已关闭"))
          else if (entry.failure) finish(entry.failure)
          else if (event.type === "done" && entry.ready) finish()
          else if (event.type === "exit") finish(processException("TERMINAL_START_FAILED", "PTY 在就绪前退出"))
        }
        signal.addEventListener("abort", abort, { once: true })
        try { entry.process = this.backend.spawn(cwd, randomUUID(), (event) => this.receive(entry, event)) }
        catch (error) { finish(processException("TERMINAL_START_FAILED", error instanceof Error ? error.message : "PTY 启动失败")) }
        if (signal.aborted) abort()
      })
      return { ...state }
    } catch (error) { await this.remove(terminals, entry); throw error }
  }

  /**
   * 向目标 PTY 原样写入输入，并收集本窗口归属的未交付输出；空输入只拉取输出。完成标记、退出或收集时限结束本次窗口，不根据输出内容猜测命令状态。
   * 成功交付后切换到新的输出批次，晚到内容留给下一次调用。取消保留未交付内容，持续标记监听仍可更新终端状态。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 允许访问目标终端的 Session ID。
   * @param id - 当前对话中的目标终端身份。
   * @param input - 原样写入的命令或交互字符；提交命令需包含回车，空字符串仅收集输出。
   * @param callId - 用于发布本次完整大输出日志的工具调用 ID。
   * @param signal - 本次收集的取消信号；该方法不自行发送 Ctrl+C，进程中断由 SessionRuntime 的 Stop 路径负责。
   * @returns 本次输出和收集边界时的状态副本；后续标记不会修改已返回结果。
   * @throws Error - 目标不存在、已退出终端收到非空输入、并发操作、取消、写入或输出保存失败；工具调用方负责转换为错误结果。
   */
  async input(projectId: string, sessionId: string, id: string, input: string, callId: string, signal: AbortSignal): Promise<TerminalInputResult> {
    const entry = this.entry(projectId, sessionId, id)
    if (signal.aborted) throw processException("CANCELLED", "工具调用已取消")
    if (entry.failure) throw entry.failure
    if (entry.notify) throw processException("TERMINAL_BUSY", "同一终端已有正在执行的操作")
    if (entry.exited && input !== "") throw processException("TERMINAL_EXITED", "终端进程已经退出：" + id)
    return new Promise<TerminalInputResult>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let completion: ReturnType<typeof setImmediate> | undefined
      const cleanup = () => { clearTimeout(timer); clearImmediate(completion); signal.removeEventListener("abort", abort); entry.notify = undefined }
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== undefined) { reject(error); return }
        try {
          const output = entry.pending.finish(callId)
          entry.pending = new ToolOutputStore(entry.directory)
          const result: TerminalInputResult = { ...output, terminalId: id, status: entry.exited ? "unknown" : entry.state.status }
          if (entry.exited) void this.remove(this.terminals(projectId, sessionId), entry).catch((error) => { console.error("已退出终端清理失败：", error) })
          resolve(result)
        } catch (failure) { entry.failure = failure; reject(failure) }
      }
      const abort = () => finish(processException("CANCELLED", "工具调用已取消"))
      entry.notify = (event) => {
        if (entry.closed) finish(processException("CANCELLED", "终端操作已关闭"))
        else if (entry.failure) finish(entry.failure)
        else if (event.type === "exit") finish()
        else if (event.type === "done" && event.run === entry.run && entry.state.status === "idle") {
          /** ConPTY 的 OSC 会先于同一次读取中的屏幕文本交付；只延到本轮读取完成，不以安静时段猜测结束。 */
          completion ??= setImmediate(() => finish())
        }
      }
      signal.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => finish(), this.collectionMs)
      try {
        if (entry.exited || (input === "" && entry.state.status === "idle")) finish()
        else if (input !== "") entry.process!.write(input)
      } catch (error) { finish(processException("TERMINAL_WRITE_FAILED", error instanceof Error ? error.message : "终端输入失败")) }
      if (signal.aborted) abort()
    })
  }

  /**
   * 读取指定对话的活动终端快照，排除尚未就绪、自然退出及已关闭的记录。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 要查询的 Session ID。
   * @returns 活动终端状态的独立副本数组；不存在该对话的资源表时返回空数组。
   */
  list(projectId: string, sessionId: string): TerminalState[] {
    return [...(this.sessions.get(this.key(projectId, sessionId))?.values() ?? [])].filter((e) => !e.exited && !e.closed && e.ready).map((e) => ({ ...e.state }))
  }
  /**
   * 显式移除目标终端并等待本机进程退出，丢弃其尚未交付的输出。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 允许关闭目标终端的 Session ID。
   * @param id - 需要关闭的终端身份。
   * @returns 进程退出和资源清理完成时兑现的 Promise。
   * @throws Error - 目标不存在、关闭或输出资源清理失败；工具调用方负责返回关闭错误。
   */
  async close(projectId: string, sessionId: string, id: string): Promise<void> { await this.remove(this.terminals(projectId, sessionId), this.entry(projectId, sessionId, id)) }
  /**
   * 向当前对话全部尚未退出的 PTY 各发送一次 Ctrl+C。发送本身不更新状态，也不证明前台命令已经终止。
   *
   * @param projectId - 对话所属的 Project ID 或 default 分组身份。
   * @param sessionId - 需要中断其活动终端的 Session ID。
   * @returns 发送 Ctrl+C 时捕获的异常列表；空数组仅表示发送调用没有抛出异常。
   */
  interrupt(projectId: string, sessionId: string): unknown[] {
    const errors: unknown[] = []
    for (const entry of this.sessions.get(this.key(projectId, sessionId))?.values() ?? []) {
      if (!entry.closed && !entry.exited) try { entry.process?.write("\x03") } catch (error) { errors.push(error) }
    }
    return errors
  }
  /**
   * 应用退出时移除全部终端资源，等待各进程退出并清理未读临时输出；普通 Runtime 活动期关闭不调用此方法。
   *
   * @returns 全部清理任务完成时兑现的 Promise。
   * @throws AggregateError - 一个或多个终端清理任务失败；宿主负责报告其中的异常。
   */
  async dispose(): Promise<void> {
    const pending: Promise<void>[] = []
    for (const terminals of this.sessions.values()) for (const entry of [...terminals.values()]) pending.push(this.remove(terminals, entry))
    const results = await Promise.allSettled(pending)
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason)
    this.sessions.clear()
    if (errors.length) throw new AggregateError(errors, "部分终端清理失败")
  }
  /**
   * 先将记录标记为关闭并从字典移除，通知正在等待的操作，然后释放本机进程与未读输出；迟到事件无法恢复该记录。
   *
   * @param terminals - 目标终端所属的对话资源字典。
   * @param entry - 需要移除和清理的终端记录。
   * @returns 进程退出和输出资源清理完成时兑现的 Promise。
   * @throws Error - 本机进程或输出资源清理失败；记录仍已从活动字典移除。
   */
  private async remove(terminals: Map<string, TerminalEntry>, entry: TerminalEntry): Promise<void> {
    entry.closed = true
    terminals.delete(entry.state.id)
    entry.notify?.({ type: "exit" })
    try { await entry.process?.dispose() } finally { entry.pending.discard() }
  }
  /**
   * 处理持续到来的后端事件：追加未读输出，通过匹配的执行序号更新状态和 cwd，并通知当前打开或收集操作。已关闭记录的事件直接忽略。
   *
   * @param entry - 接收事件的终端资源记录。
   * @param event - 原始数据、命令开始、命令完成或进程退出事件。
   */
  private receive(entry: TerminalEntry, event: PtyEvent): void {
    if (entry.closed) return
    let notify = true
    if (event.type === "data") {
      try { if (!entry.failure) entry.pending.append(event.data) } catch (error) { entry.failure = processException("OUTPUT_WRITE_FAILED", String(error)) }
    } else if (event.type === "start" && event.run > entry.run) {
      entry.run = event.run
      entry.state.status = "running"
    } else if (event.type === "done") {
      const firstReady = !entry.ready && event.run === 0
      if (firstReady) entry.ready = true
      if (entry.ready && event.run === entry.run && (firstReady || entry.state.status === "running")) { entry.state.status = "idle"; entry.state.cwd = event.cwd }
      else notify = false
    } else if (event.type === "exit") {
      entry.exited = true
      entry.state.status = "unknown"
    }
    if (notify) entry.notify?.(event)
  }
}
