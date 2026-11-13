#!/usr/bin/env node
/** 独立 Node CLI 装配入口：直接组合现有 Runtime，无 Electron 或 IPC。 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Writable } from "node:stream"
import { performance } from "node:perf_hooks"
import { runAgentLoop } from "../../runtime/agent/src/loop.ts"
import { createAbortError } from "../../runtime/error/src/abort.ts"
import { MCPManager } from "../../runtime/mcp/src/index.ts"
import type { SessionLoadedMCPTool } from "../../runtime/mcp/src/types.ts"
import { MemoryManager } from "../../runtime/memory/src/index.ts"
import type { ModelRef } from "../../runtime/model/src/types.ts"
import { initNetworkDispatcher } from "../../runtime/network/src/dispatcher.ts"
import { createFileSessionEventLog, initializeSessionEventDatabase } from "../../runtime/session/src/event-log.ts"
import type { FileSessionEventLog } from "../../runtime/session/src/event-log.ts"
import type { ApprovalDecision, SessionEvent, SessionEventInput } from "../../runtime/session/src/events.ts"
import { TurnFileChangeTracker } from "../../runtime/session/src/file-changes.ts"
import { SkillManager } from "../../runtime/skill/src/index.ts"
import {
  bundledRipgrepPath, createExecuteToolCall, registerFileTools, registerMemoryTools, registerMCPTools,
  registerShellTools, registerSkillTools, registerTerminalTools, RenderRegistry, ShellRouter, TerminalRouter, ToolRegistry,
  registerWebSearchTool, WEB_SEARCH_DATABASE_FILE,
  registerWebFetchTool,
} from "../../runtime/tools/src/index.ts"
import type { ToolExecutionContext } from "../../runtime/tools/src/types.ts"
import { initializeConfigFilesSnapshot } from "../main/config-files.ts"
import { mcpToolChanges, modelHistory } from "../../runtime/agent/src/model-history.ts"
import { createTurnModelAdapter } from "../main/model-adapters.ts"
import { listProviders, readDefaultModel } from "../main/provider-store.ts"
import { estimateLocalTokens } from "../main/token-estimator.ts"
import {
  CLI_HELP, CliInputError, createStatistics, exitCode, mapEvent, mapUsage, observeEvent,
  outputDestination, readCliInput, resultStatus, writeResult,
} from "./protocol.ts"
import type { PublicEvent, RunRequest, RunResult, StopReason, ToolGroup } from "./protocol.ts"

const SYSTEM_PROMPT = "You are an AI agent powered by Minou."
const CLEANUP_MS = 5000

/**
 * 有限等待一个输出写入，使用 write 回调处理背压，不为流式事件建立无界缓冲。
 * @param stream stdout 或 stderr；调用方负责安装流错误监听。
 * @param data 已序列化的协议或诊断文本。
 * @returns 本次写入已处理。
 * @throws Error 管道失败或五秒内无法处理写入。
 */
export function writeOutput(stream: Writable, data: string): Promise<void> {
  return new Promise<void>((resolveWrite, reject) => {
    const timer = setTimeout(() => reject(new Error("输出写入超时")), CLEANUP_MS)
    try {
      stream.write(data, (error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolveWrite()
      })
    } catch (error) { clearTimeout(timer); reject(error) }
  })
}

/**
 * 有限等待现有资源清理；超时不丢弃任务的 rejection 处理器。
 * @param operation 已启动的资源清理任务。
 * @param milliseconds 剩余宽限时间。
 * @returns 所有资源清理完成。
 * @throws Error 清理失败或达到宽限时间。
 */
async function withinGrace(operation: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("资源清理超时")), Math.max(1, milliseconds))
    })])
  } finally { clearTimeout(timer) }
}

/**
 * 从既有 Provider 列表补齐 ModelRef，不保存或修改默认模型。
 * @param databasePath 已初始化的 Provider 数据库路径。
 * @param request 本次模型选择和可选等级。
 * @returns 唯一、完整的模型引用。
 * @throws CliInputError 默认模型为空、指定模型不存在或等级不支持。
 */
export function resolveModel(databasePath: string, request: Pick<RunRequest, "modelId" | "reasoningLevel">): ModelRef {
  const id = request.modelId ?? readDefaultModel(databasePath)?.modelId
  const providers = listProviders(databasePath)
  for (const provider of providers) {
    const model = provider.models.find((entry) => entry.modelId === id)
    if (!model) continue
    const reasoningLevel = request.reasoningLevel ?? model.reasoningLevels[0]
    if (model.supportsReasoning && !model.reasoningLevels.includes(reasoningLevel)) throw new CliInputError("所选推理等级不属于模型的可选等级。")
    return { providerId: provider.id, protocol: provider.protocol, modelId: model.modelId, name: model.name, reasoningLevel }
  }
  throw new CliInputError("未找到指定模型或有效默认模型；请先配置 Minou 模型。")
}

/**
 * 根据固定名单与真实注册元数据匹配自动审批工具组，不使用前缀或通配符。
 * @param name 模型侧精确工具名。
 * @param registry 本次真实注册表。
 * @returns 已知分组，未知工具返回 undefined。
 */
export function toolGroup(name: string, registry: ToolRegistry): ToolGroup | undefined {
  const tool = registry.get(name)
  if (!tool) return undefined
  if (tool.kind === "mcp") return "mcp"
  if (["glob", "grep", "read", "write", "edit"].includes(name)) return "file"
  if (name === "shell") return "shell"
  if (["terminal_open", "terminal_input"].includes(name)) return "terminal"
  if (["mcp_list_tools", "mcp_load_tools", "tool_search"].includes(name)) return "mcp"
  if (name === "skill_load") return "skill"
  if (["memory_list", "memory_read", "memory_write"].includes(name)) return "memory"
  return undefined
}

/**
 * 执行一次独立 CLI 调用。生产入口每进程只调用一次，并在返回后退出以关闭超宽限的残留句柄。
 * @param argv 包含 run 子命令的参数。
 * @returns 公共协议对应的退出码；所有正常输出已等待写入回调。
 * @throws 仅未预期的宿主异常可能向上传播；预期输入、运行和输出错误映射为退出码。
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  if ((argv.length === 1 && argv[0] === "--help") || (argv.length === 2 && argv[0] === "run" && argv[1] === "--help")) {
    const consumeError = (): void => {}
    process.stdout.on("error", consumeError)
    try { await writeOutput(process.stdout, CLI_HELP); return 0 }
    catch { return 1 }
    finally { process.stdout.off("error", consumeError) }
  }
  const cwd = process.cwd()
  const sessionId = randomUUID()
  const destination = outputDestination(argv, cwd)
  const statistics = createStatistics()
  const controller = new AbortController()
  let request: RunRequest | undefined
  let runId: string = sessionId
  let model: ModelRef | null = null
  let recordDirectory: string | null = null
  let eventLog: FileSessionEventLog | undefined
  let fileTracker: TurnFileChangeTracker | undefined
  let reason: StopReason | undefined
  let error: RunResult["error"]
  let stage = "input"
  let startedAt = performance.now()
  let stoppedAt: number | undefined
  let publicSeq = 0
  let stdoutFailed = false
  let finished = false
  let startedTurn = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abandonTimer: ReturnType<typeof setTimeout> | undefined
  let outputTail: Promise<void> = Promise.resolve()
  let mcp: MCPManager | undefined
  let shell: ShellRouter | undefined
  let terminal: TerminalRouter | undefined
  let dispatcher: ReturnType<typeof initNetworkDispatcher> | undefined
  let unsubscribeMcp: (() => void) | undefined
  let disposal: Promise<void> | undefined
  let releaseStopped!: () => void
  const stopped = new Promise<void>((resolveStopped) => { releaseStopped = resolveStopped })

  /**
   * 释放本次 CLI Run 的共享资源，重复调用复用同一清理任务。
   *
   * @returns 共享的清理任务，停止期间和 finally 可重复调用。
   * @throws Error 清理任一资源失败。
   */
  function dispose(): Promise<void> {
    return disposal ??= (async () => {
      unsubscribeMcp?.()
      const results = await Promise.allSettled([mcp?.dispose(), shell?.dispose(), terminal?.dispose(),
        controller.signal.aborted ? dispatcher?.destroy() : dispatcher?.close()])
      if (results.some((result) => result.status === "rejected")) throw new Error("部分运行资源清理失败")
    })()
  }
  /**
   * 记录首个停止原因、触发共享取消信号并立即开始资源释放。
   *
   * @param cause 首个取消原因。使现有工具和模型观察同一信号，并立即启动资源释放。
   */
  function stop(cause: StopReason): void {
    if (reason !== undefined || finished) return
    reason = cause
    stoppedAt = performance.now()
    controller.abort()
    terminal?.interrupt("default", sessionId)
    releaseStopped()
    /** 每个异步初始化后都会检查取消状态，避免释放后继续创建新资源。 */
    void dispose().catch(() => undefined)
  }
  /**
   * 在 CLI 执行边界检查是否已有停止请求。
   *
   * @throws AbortError 本次已收到停止请求。
   */
  function checkStopped(): void { if (controller.signal.aborted) throw createAbortError() }
  /**
   * 按公共协议向 stdout 有序写入事件。
   *
   * @param type 公共事件类型。
   * @param data 白名单数据。
   * @returns 有序写入完成。
   * @throws Error stdout 失败。
   */
  function emit(type: string, data: Record<string, unknown>): Promise<void> {
    if (destination.format !== "jsonl") return Promise.resolve()
    const event: PublicEvent = { version: 1, seq: ++publicSeq, type, run_id: runId, session_id: sessionId, data }
    const writing = outputTail.then(async () => {
      if (stdoutFailed) throw new Error("stdout 已关闭")
      try { await writeOutput(process.stdout, `${JSON.stringify(event)}\n`) }
      catch { stdoutFailed = true; stop("error"); throw new Error("stdout 写入失败") }
    })
    outputTail = writing.catch(() => undefined)
    return writing
  }
  /**
   * 先提交内部事件，再更新运行统计与允许公开的事件输出。
   *
   * @param input 未分配身份的现有事件。
   * @returns 已持久化事件。
   * @throws Error 存储或公共输出失败。
   */
  async function appendEvent(input: SessionEventInput) {
    if (finished || !eventLog) throw new Error("本次事件日志不可写")
    const event = await eventLog.appendEvent(input)
    if (finished) return event
    observeEvent(statistics, event)
    const mapped = mapEvent(event)
    if (mapped) await emit(mapped.type, mapped.data)
    return event
  }
  /** 将进程信号统一映射为用户中断。 */
  const interrupt = (): void => stop("interrupted")
  /** stdout 错误必须被消费，避免 EPIPE 成为未处理异常。 */
  const outputError = (): void => { stdoutFailed = true; stop("error") }
  process.stdout.on("error", outputError)
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)

  /**
   * 独立装配本次 CLI Run 的模型与工具，执行 AgentLoop 并映射运行结果。
   *
   * @returns 完成模型与工具执行。
   * @throws Error 所有阶段的错误由外层映射为公共结果。
   */
  async function execute(): Promise<void> {
    request = (await readCliInput(argv, cwd)).request
    runId = request.runId
    startedAt = performance.now()
    checkStopped()
    timeout = setTimeout(() => stop("timeout"), request.timeoutSeconds * 1000)
    await emit("run.started", {})
    stage = "initialization"
    const { paths, config } = await initializeConfigFilesSnapshot(process.env.USERPROFILE ?? homedir(), { skipSkills: request.isolated.skill })
    checkStopped()
    recordDirectory = join(paths.rootDir, "logs", "cli", sessionId)
    const outputDirectory = join(recordDirectory, "tool_output")
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
    checkStopped()
    const databasePath = join(recordDirectory, "events.sqlite")
    await initializeSessionEventDatabase(databasePath)
    checkStopped()
    eventLog = createFileSessionEventLog({ sessionId, projectGroupId: "default", sessionDirectory: recordDirectory, databasePath })
    dispatcher = initNetworkDispatcher()
    model = resolveModel(paths.providerDatabasePath, request)
    const adapter = await createTurnModelAdapter(paths, model)
    checkStopped()
    const tools = new ToolRegistry()
    const renders = new RenderRegistry()
    const tracker = fileTracker = new TurnFileChangeTracker()
    const mode = request.sandboxMode
    const workspace = request.workspace
    const roots = [workspace, outputDirectory]
    /** 编译入口位于 dist/src/cli；源码导入仅供仓库内的离线测试。 */
    const applicationRoot = typeof __dirname === "string" ? resolve(__dirname, "../../..") : cwd
    registerFileTools(tools, renders, { rgPath: bundledRipgrepPath(applicationRoot), loadAccess: () => ({ sandboxMode: mode, roots }) })
    registerWebSearchTool(tools, renders, join(paths.rootDir, WEB_SEARCH_DATABASE_FILE), estimateLocalTokens)
    registerWebFetchTool(tools, renders)
    shell = new ShellRouter()
    terminal = new TerminalRouter()
    /** @returns 本次固定的沙箱模式和新进程初始目录。 */
    const processAccess = () => ({ sandboxMode: mode, cwd: workspace })
    registerShellTools(tools, renders, shell, processAccess)
    registerTerminalTools(tools, renders, terminal, processAccess)
    if (!request.isolated.memory) registerMemoryTools(tools, renders, new MemoryManager(paths.rootDir))
    let skillContent = ""
    if (!request.isolated.skill) {
      const skills = new SkillManager(paths.rootDir, estimateLocalTokens)
      registerSkillTools(tools, renders, skills)
      skillContent = (await skills.resolveSkills("default")).content
      checkStopped()
    }
    let loaded: SessionLoadedMCPTool[] = []
    if (!request.isolated.mcp) {
      mcp = new MCPManager(estimateLocalTokens)
      unsubscribeMcp = registerMCPTools(tools, renders, mcp)
      await mcp.initialize(request.mcpServers ?? config.mcpServers)
      checkStopped()
      for (const connection of mcp.getConnectionStates()) {
        if (connection.error) await writeOutput(process.stderr, `MCP 服务连接失败：${connection.name}\n`)
      }
    }
    const agentsPath = join(workspace, "AGENTS.md")
    let agents = ""
    try {
      if (!(await stat(agentsPath)).isFile()) throw new Error("AGENTS.md 必须为普通文件")
      agents = await readFile(agentsPath, "utf8")
    } catch (failure) {
      if (!(failure instanceof Error && "code" in failure && failure.code === "ENOENT")) throw failure
    }
    checkStopped()
    const workspaceInfo = `<workspace_info>\n${JSON.stringify({ cwd: workspace, directories: [workspace], allowedRoots: roots, toolOutputDirectory: outputDirectory }, null, 2)}\n</workspace_info>`
    const system = [SYSTEM_PROMPT, workspaceInfo, agents, skillContent].filter(Boolean).join("\n\n")
    const initial = await eventLog.appendTurnStartAndUserMessage([
      { type: "turn/start", turn: 1, model },
      { type: "user/message", turn: 1, message: { id: randomUUID(), role: "user", content: [{ type: "text", text: request.prompt }] } },
    ])
    startedTurn = initial.length === 2
    const executeTool = createExecuteToolCall(tools, renders)
    /** @param name 触发审批的注册名。 @param _reason 内部说明。 @param context 原始调用身份。 @returns 立即作出的决定。 @throws Error 审批记录失败。 */
    const approve = async (name: string, _reason: string, context: ToolExecutionContext<object>): Promise<ApprovalDecision> => {
      if (!context.toolCallEventId) throw new Error("审批缺少工具调用事件身份")
      const approvalId = randomUUID()
      await appendEvent({ type: "approval/request", turn: context.turn, step: context.step, approvalId,
        toolCallEventId: context.toolCallEventId, toolCallId: context.toolCallId, blockId: context.blockId,
        toolName: name, arguments: context.validatedArguments })
      const group = toolGroup(name, tools)
      const decision = context.signal.aborted ? "cancelled" : request!.approveTools.includes(name) || (group !== undefined && request!.approveGroups.includes(group)) ? "approved" : "denied"
      await appendEvent({ type: "approval/result", turn: context.turn, step: context.step, approvalId, decision })
      return decision
    }
    stage = "execution"
    const result = await runAgentLoop({
      turn: 1, model, adapter, content: [], signal: controller.signal, appendEvent,
      tools: tools.listDefinitions().filter((definition) => tools.get(definition.name)?.kind === "builtin"),
      prepareHistory: async () => modelHistory(system, await eventLog!.readEvents() as SessionEvent[]),
      executeTool: async (name, args, context) => {
        if (finished) throw createAbortError()
        await emit("tool.started", { step: context.step, call_id: context.toolCallId, tool: name })
        return executeTool(name, args, {
          ...context, projectId: "default",
          fileRuntime: { projectId: "default", sessionId, tracker, requestApproval: approve },
          processRuntime: { projectId: "default", sessionId, outputDirectory, requestApproval: approve },
          ...(mcp ? { mcpRuntime: {
            projectId: "default", sessionId, contextWindow: adapter.contextWindow,
            readLoadedTools: async () => structuredClone(loaded),
            writeLoadedTools: async (entries, change) => {
              const inputs = change ? mcpToolChanges(change, context.turn, context.step, context.toolCallEventId) : []
              if (inputs.length > 0) await eventLog!.appendMcpToolChanges(inputs)
              loaded = structuredClone(entries)
            },
            readSandboxMode: async () => mode, requestApproval: approve,
          } } : {}),
        })
      },
      beforeStep: async ({ step }) => {
        checkStopped()
        if (step > request!.maxSteps) { stop("max_steps"); throw createAbortError() }
      },
    })
    if (!reason) reason = !result.stopped && result.completion === "finished" ? "finished" : "model_incomplete"
  }

  try {
    await Promise.race([execute(), stopped.then(() => new Promise<never>((_resolve, reject) => {
      abandonTimer = setTimeout(() => reject(createAbortError()), CLEANUP_MS)
    }))])
  } catch (failure) {
    if (!reason || reason === "finished") reason = failure instanceof CliInputError ? "invalid_request" : "error"
    if (reason === "error" || reason === "invalid_request") error = {
      code: failure instanceof CliInputError ? "INVALID_REQUEST" : stdoutFailed ? "OUTPUT_FAILED" : "RUN_FAILED",
      stage, message: failure instanceof CliInputError ? failure.message : "本次运行失败，请检查本地运行记录和配置。",
    }
  } finally {
    clearTimeout(timeout)
    clearTimeout(abandonTimer)
    finished = true
    try { await withinGrace(dispose(), stoppedAt === undefined ? CLEANUP_MS : CLEANUP_MS - (performance.now() - stoppedAt)) }
    catch {
      void dispatcher?.destroy().catch(() => undefined)
      if (reason === "finished" || !reason) reason = "error"
      error ??= { code: "CLEANUP_FAILED", stage: "cleanup", message: "部分资源清理失败或超时。" }
    }
    if (eventLog && startedTurn) {
      try {
        if (error) await eventLog.appendEvent({ type: "app/error", turn: 1, error: { source: "runtime", code: error.code, message: error.message } })
        const changes = fileTracker?.summarize() ?? []
        if (changes.length) await eventLog.appendEvent({ type: "turn/file_changes", turn: 1, files: changes })
        await eventLog.appendEvent({ type: "turn/end", turn: 1, reason: reason === "finished" ? "completed" : reason === "error" || reason === "invalid_request" ? "error" : "stopped" })
      } catch {
        reason = "error"
        error = { code: "EVENT_WRITE_FAILED", stage: "output", message: "运行记录无法完成写入。" }
      }
    }
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }
  const finalReason = reason ?? "error"
  const result: RunResult = {
    version: 1, run_id: runId, session_id: sessionId, status: resultStatus(finalReason), stop_reason: finalReason,
    answer: statistics.answer, answer_complete: finalReason === "finished", model, record_directory: recordDirectory,
    metrics: { steps: statistics.steps, tool_calls: statistics.toolCalls, duration_ms: Math.round(performance.now() - startedAt),
      usage: mapUsage(statistics.usage), usage_complete: statistics.steps > 0 && statistics.reportedUsage === statistics.steps,
      usage_reported_steps: statistics.reportedUsage, usage_scope: "reported_agent_requests" },
    ...(error ? { error } : {}),
  }
  let code = exitCode(finalReason)
  try {
    if (destination.output) await writeResult(destination.output, result)
  } catch {
    code = 1
    result.status = "failed"; result.stop_reason = "error"; result.answer_complete = false
    result.error = { code: "OUTPUT_FAILED", stage: "output", message: "最终结果无法原子写入指定路径。" }
  }
  try {
    if (destination.format === "jsonl") await emit("run.finished", { result })
    else if (!stdoutFailed) await writeOutput(process.stdout, `${JSON.stringify(result)}\n`)
    else code = 1
  } catch {
    code = 1
    result.status = "failed"; result.stop_reason = "error"; result.answer_complete = false
    result.error = { code: "OUTPUT_FAILED", stage: "output", message: "stdout 无法完成协议输出。" }
    if (destination.output) await writeResult(destination.output, result).catch(() => undefined)
  }
  if (result.error) await writeOutput(process.stderr, `${result.error.code}: ${result.error.message}\n`).catch(() => undefined)
  await outputTail
  process.stdout.off("error", outputError)
  return code
}

if (typeof require !== "undefined" && require.main === module) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
    /** 先让 Node 排空网络/原生句柄的 close 回调；仅残留句柄阻止退出时才强制结束。 */
    setTimeout(() => process.exit(code), 1000).unref()
  }, () => {
    process.stderr.write("CLI 启动失败。\n", () => process.exit(1))
  })
}
