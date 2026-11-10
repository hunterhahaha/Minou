/** Headless Agent Execution Protocol V1 的输入、公共事件和结果映射。 */
import { randomUUID } from "node:crypto"
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { accumulateUsage } from "../../runtime/model/src/types.ts"
import type { ModelRef, Usage } from "../../runtime/model/src/types.ts"
import type { MCPConfig } from "../../runtime/mcp/src/types.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import { SANDBOX_MODES } from "../../runtime/session/src/session-state.ts"
import type { SandboxMode } from "../../runtime/session/src/session-state.ts"
import { checkConfig } from "../main/config-schema.ts"

/** stdout 使用单个最终 JSON 或逐行公共事件。 */
export type OutputFormat = "json" | "jsonl"
/** 自动审批的固定工具组；只影响已触发的审批。 */
export const TOOL_GROUPS = ["file", "shell", "terminal", "mcp", "skill", "memory"] as const
/** 一种明确的自动审批分组。 */
export type ToolGroup = typeof TOOL_GROUPS[number]
/** 结束原因同时决定公共状态和进程退出码。 */
export type StopReason = "finished" | "invalid_request" | "max_steps" | "timeout" | "interrupted" | "model_incomplete" | "error"

/** 校验、路径解析和默认值补齐后的单次运行请求。 */
export interface RunRequest {
  /** 调用方关联身份，不用于文件路径。 */
  runId: string
  /** 保留原文的用户任务。 */
  prompt: string
  /** 可选的稳定模型 ID；省略时读取有效默认模型。 */
  modelId?: string
  /** 可选等级，模型解析阶段确认其合法性。 */
  reasoningLevel?: string
  /** 已验证存在的绝对工作目录。 */
  workspace: string
  /** 显式替换本次全局 MCP 配置；undefined 表示沿用全局配置。 */
  mcpServers?: MCPConfig[]
  /** true 表示完整禁用该模块。 */
  isolated: { skill: boolean; memory: boolean; mcp: boolean }
  /** 既有沙箱模式。 */
  sandboxMode: SandboxMode
  /** 命中任一工具组即可批准；不改变工具暴露。 */
  approveGroups: ToolGroup[]
  /** 精确匹配模型侧工具注册名，不使用通配符。 */
  approveTools: string[]
  /** 最多创建的 AgentLoop Step 数。 */
  maxSteps: number
  /** 包含初始化的总执行时间，不包含有限的收尾宽限。 */
  timeoutSeconds: number
}

/** 两种输入方式共用的最终启动输入。 */
export interface CliInput {
  /** 单次任务参数。 */
  request: RunRequest
  /** 最终结果 JSON 的绝对路径，父目录必须存在。 */
  output: string
  /** stdout 协议。 */
  format: OutputFormat
}

/** 可公开的输入错误；不携带 SDK 错误、配置正文或凭据。 */
export class CliInputError extends Error {
  /** @param message 可供调用方修正输入的公开说明。 */
  constructor(message: string) { super(message); this.name = "CliInputError" }
}

/** 公共事件的独立信封；data 只能由白名单映射产生。 */
export interface PublicEvent {
  /** 公共格式版本。 */ version: 1
  /** 公共序号，与内部 EventLog 序号无关。 */ seq: number
  /** 公共事件类型。 */ type: string
  /** 调用方关联身份。 */ run_id: string
  /** 本次内部 UUID。 */ session_id: string
  /** 白名单字段。 */ data: Record<string, unknown>
}

/** 仅输出已报告的统一用量；缓存和 reasoning 缺失时不补零。 */
export interface PublicUsage {
  /** 未缓存输入累计。 */ input_tokens: number
  /** 包含 reasoning 的输出累计。 */ output_tokens: number
  /** 厂商可确定的总量。 */ total_tokens?: number
  /** 缓存读取累计。 */ cache_read_tokens?: number
  /** 缓存写入累计。 */ cache_write_tokens?: number
  /** 输出中的 reasoning 子集。 */ reasoning_tokens?: number
}

/** 根据已提交事件累计的 Run 指标和最后一条公开回答。 */
export interface RunStatistics {
  /** 实际已提交的 Step 数。 */ steps: number
  /** 已结束工具调用块数量，包含拒绝和失败调用。 */ toolCalls: number
  /** 已提交的 Assistant Message 数量。 */ messages: number
  /** 报告了权威 Usage 的消息数量。 */ reportedUsage: number
  /** 最后一条 Assistant Message 的文本。 */ answer: string
  /** 仅已报告消息的累计 Usage。 */ usage?: Usage
}

/** 最终结果和 run.finished 使用同一份对象。 */
export interface RunResult {
  /** 公共格式版本。 */ version: 1
  /** 外部任务关联身份。 */ run_id: string
  /** 本次内部 UUID，不对应桌面对话索引。 */ session_id: string
  /** 执行状态，不表示答案正确。 */ status: "completed" | "stopped" | "failed"
  /** 精确终止原因。 */ stop_reason: StopReason
  /** 最后一个 Assistant Message 的公开文本。 */ answer: string
  /** 是否由模型正常完成输出。 */ answer_complete: boolean
  /** 实际固定模型；模型解析前失败时为 null。 */ model: ModelRef | null
  /** 本次独立内部日志及工具输出目录；创建前失败时为 null。 */ record_directory: string | null
  /** 已提交事件派生的指标。 */
  metrics: {
    steps: number; tool_calls: number; duration_ms: number; usage: PublicUsage | null
    usage_complete: boolean; usage_reported_steps: number; usage_scope: "reported_agent_requests"
  }
  /** 仅公开稳定错误码和阶段说明。 */ error?: { code: string; stage: string; message: string }
}

const VALUE_OPTIONS = new Set([
  "request", "output", "format", "prompt-file", "model", "reasoning-level", "workspace", "run-id",
  "max-steps", "timeout", "mcp-config", "isolate", "sandbox-mode", "auto-approve-groups", "auto-approve-tools",
])

/**
 * 尽力恢复错误路径的输出控制，不接受重复或缺少值的参数。
 * @param argv 原始命令参数。
 * @param cwd CLI 启动目录。
 * @returns 仅用于输入失败时的结果写入位置与 stdout 格式。
 */
export function outputDestination(argv: readonly string[], cwd: string): { output?: string; format: OutputFormat } {
  const values: Record<string, string[]> = { output: [], format: [] }
  for (let i = 0; i < argv.length; i++) {
    for (const name of ["output", "format"]) {
      if (argv[i].startsWith(`--${name}=`)) values[name].push(argv[i].slice(name.length + 3))
      else if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith("--")) values[name].push(argv[i + 1])
    }
  }
  return {
    output: values.output.length === 1 && values.output[0].trim() ? resolve(cwd, values.output[0]) : undefined,
    format: values.format.length === 1 && values.format[0] === "jsonl" ? "jsonl" : "json",
  }
}

/**
 * 读取两种互斥输入并补齐唯一的 RunRequest；不会初始化用户配置或启动 Runtime。
 * @param argv 包含 run 子命令的参数。
 * @param cwd 相对命令行路径的基准。
 * @returns 已校验的请求及输出控制。
 * @throws CliInputError 参数、JSON、输入文件或工作区无效。
 */
export async function readCliInput(argv: readonly string[], cwd: string): Promise<CliInput> {
  if (argv[0] !== "run") throw new CliInputError("需要 run 子命令；使用 nicode run --help 查看参数。")
  const options: Record<string, string> = {}
  for (let i = 1; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i])
    if (!match || !VALUE_OPTIONS.has(match[1])) throw new CliInputError("存在未知参数或位置参数。")
    const name = match[1]
    if (name in options) throw new CliInputError(`--${name} 不能重复。`)
    const value = match[2] ?? argv[++i]
    if (value === undefined || value.startsWith("--") || !value.trim()) throw new CliInputError(`--${name} 缺少值。`)
    options[name] = value
  }
  if (!options.output) throw new CliInputError("必须提供 --output。")
  const format = options.format ?? "json"
  if (format !== "json" && format !== "jsonl") throw new CliInputError("--format 仅支持 json 或 jsonl。")
  let raw: unknown
  let base = cwd
  if (options.request) {
    if (Object.keys(options).some((key) => !["request", "output", "format"].includes(key))) {
      throw new CliInputError("--request 与其他任务输入参数互斥。")
    }
    const path = resolve(cwd, options.request)
    base = dirname(path)
    raw = await readJson(path)
  } else {
    if (!options["prompt-file"]) throw new CliInputError("必须提供 --prompt-file 或 --request。")
    const isolated = Object.fromEntries(csv(options.isolate).map((name) => [name, true]))
    raw = {
      version: 1, prompt: await readText(resolve(cwd, options["prompt-file"])), run_id: options["run-id"],
      model: options.model, reasoning_level: options["reasoning-level"], workspace: options.workspace,
      mcp_config: options["mcp-config"], isolated,
      permissions: { sandbox_mode: options["sandbox-mode"], auto_approve: { groups: csv(options["auto-approve-groups"]), tools: csv(options["auto-approve-tools"]) } },
      limits: { max_steps: options["max-steps"] === undefined ? undefined : Number(options["max-steps"]), timeout_seconds: options.timeout === undefined ? undefined : Number(options.timeout) },
    }
  }
  return { request: await normalizeRequest(raw, base, cwd), output: resolve(cwd, options.output), format }
}

/**
 * 严格读取 Request V1，配置覆盖仅影响本次运行。
 * @param value 未信任的 Request JSON。
 * @param base Request 内路径的基准。
 * @param cwd 未设置 workspace 时的启动目录。
 * @returns 运行时输入。
 * @throws CliInputError 字段、模块组合、MCP 配置或路径不合法。
 */
export async function normalizeRequest(value: unknown, base: string, cwd: string): Promise<RunRequest> {
  const raw = object(value, "request", ["version", "run_id", "prompt", "model", "reasoning_level", "workspace", "mcp_config", "isolated", "permissions", "limits"])
  if (raw.version !== 1) throw new CliInputError("request.version 必须为 1。")
  const isolation = object(raw.isolated === undefined ? {} : raw.isolated, "isolated", ["skill", "memory", "mcp"])
  const isolated = { skill: false, memory: false, mcp: false }
  for (const key of ["skill", "memory", "mcp"] as const) {
    if (isolation[key] !== undefined && typeof isolation[key] !== "boolean") throw new CliInputError(`isolated.${key} 必须为布尔值。`)
    isolated[key] = isolation[key] === true
  }
  const permissions = object(raw.permissions === undefined ? {} : raw.permissions, "permissions", ["sandbox_mode", "auto_approve"])
  const mode = permissions.sandbox_mode === undefined ? "sandbox-full-access" : permissions.sandbox_mode
  if (mode === "auto" || !SANDBOX_MODES.includes(mode as SandboxMode)) throw new CliInputError("permissions.sandbox_mode 无效。")
  const approval = object(permissions.auto_approve === undefined ? {} : permissions.auto_approve, "auto_approve", ["groups", "tools"])
  const groups = strings(approval.groups === undefined ? [] : approval.groups, "auto_approve.groups")
  if (groups.some((group) => !TOOL_GROUPS.includes(group as ToolGroup))) throw new CliInputError("auto_approve.groups 包含未知工具组。")
  const limits = object(raw.limits === undefined ? {} : raw.limits, "limits", ["max_steps", "timeout_seconds"])
  const workspace = raw.workspace === undefined ? resolve(cwd) : resolve(base, text(raw.workspace, "workspace"))
  try { if (!(await stat(workspace)).isDirectory()) throw new Error() }
  catch { throw new CliInputError("workspace 必须为现存目录。") }
  let mcpServers: MCPConfig[] | undefined
  if (raw.mcp_config !== undefined) {
    if (isolated.mcp) throw new CliInputError("isolated.mcp=true 与 mcp_config 冲突。")
    const config = object(await readJson(resolve(base, text(raw.mcp_config, "mcp_config"))), "mcp_config", ["mcpServers"])
    try { checkConfig({ version: 2, mcpServers: config.mcpServers, runtime: { userMessageMode: "queue" } }) }
    catch { throw new CliInputError("mcp_config 必须包含符合现有结构的 mcpServers 数组。") }
    mcpServers = config.mcpServers as MCPConfig[]
  }
  return {
    runId: raw.run_id === undefined ? randomUUID() : text(raw.run_id, "run_id"),
    prompt: text(raw.prompt, "prompt"), modelId: optionalText(raw.model, "model"),
    reasoningLevel: optionalText(raw.reasoning_level, "reasoning_level"), workspace, mcpServers, isolated,
    sandboxMode: mode as SandboxMode, approveGroups: groups as ToolGroup[], approveTools: strings(approval.tools === undefined ? [] : approval.tools, "auto_approve.tools"),
    maxSteps: integer(limits.max_steps === undefined ? 100 : limits.max_steps, "max_steps", Number.MAX_SAFE_INTEGER),
    timeoutSeconds: integer(limits.timeout_seconds === undefined ? 1800 : limits.timeout_seconds, "timeout_seconds", Math.floor(2_147_483_647 / 1000)),
  }
}

/**
 * 校验未知值为对象且仅包含允许字段，不复制或改写对象。
 *
 * @param value 未信任对象。
 * @param label 字段职责。
 * @param keys 允许字段。
 * @returns 原对象。
 * @throws CliInputError 类型或字段无效。
 */
function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CliInputError(`${label} 必须为对象。`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !keys.includes(key))) throw new CliInputError(`${label} 包含未知字段。`)
  return result
}
/**
 * 校验必需文本为非空白字符串，保留原始正文。
 *
 * @param value 未信任文本。
 * @param label 字段职责。
 * @returns 不修改正文的非空文本。
 * @throws CliInputError 非文本或空白。
 */
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CliInputError(`${label} 必须为非空文本。`)
  return value
}
/**
 * 允许字段省略，存在时复用必需文本检查。
 *
 * @param value 可省略字段。
 * @param label 字段职责。
 * @returns 合法文本或 undefined。
 * @throws CliInputError 非空文本约束失败。
 */
function optionalText(value: unknown, label: string): string | undefined { return value === undefined ? undefined : text(value, label) }
/**
 * 检查字符串列表并去重，保留首次出现顺序。
 *
 * @param value 未信任数组。
 * @param label 字段职责。
 * @returns 去重文本列表。
 * @throws CliInputError 数组或条目无效。
 */
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new CliInputError(`${label} 必须为字符串数组。`)
  return [...new Set(value.map((entry) => text(entry, label)))]
}
/**
 * 将逗号分隔的命令行值拆为名称列表。
 *
 * @param value 命令行列表。
 * @returns 拆分后的名称；省略时为空。
 * @throws CliInputError 包含空条目。
 */
function csv(value?: string): string[] { return value === undefined ? [] : value.split(",").map((entry) => text(entry.trim(), "列表参数")) }
/**
 * 检查数值为约束范围内的正整数。
 *
 * @param value 数值。
 * @param label 字段名。
 * @param max 最大合法值。
 * @returns 合法正整数。
 * @throws CliInputError 超出约束。
 */
function integer(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new CliInputError(`${label} 必须为范围内的正整数。`)
  return value
}
/**
 * 以 UTF-8 读取 CLI 输入文件，并转换读取错误。
 *
 * @param path 输入路径。
 * @returns UTF-8 文本。
 * @throws CliInputError 文件不可读。
 */
async function readText(path: string): Promise<string> {
  try { return await readFile(path, "utf8") } catch { throw new CliInputError("输入文件不可读。") }
}
/**
 * 读取并解析 CLI JSON 输入，不信任解析后的业务结构。
 *
 * @param path JSON 路径。
 * @returns 未信任 JSON。
 * @throws CliInputError 文件不可读或 JSON 非法。
 */
async function readJson(path: string): Promise<unknown> {
  const input = await readText(path)
  try { return JSON.parse(input) as unknown } catch { throw new CliInputError("输入文件必须为合法 JSON。") }
}

/**
 * 创建当前 Run 独立的初始统计对象。
 *
 * @returns 本次运行的空统计状态。
 */
export function createStatistics(): RunStatistics { return { steps: 0, toolCalls: 0, messages: 0, reportedUsage: 0, answer: "" } }

/**
 * 从已经持久化的权威事件累计指标，每条事件调用一次。
 * @param state 本次 Run 的统计状态。
 * @param event 已提交内部事件。
 */
export function observeEvent(state: RunStatistics, event: SessionEvent): void {
  if (event.type === "step/start") state.steps++
  if (event.type === "assistant/block_end" && event.block.type === "tool_call") state.toolCalls++
  if (event.type === "assistant/message") {
    state.messages++
    state.answer = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n")
    if (event.usage !== undefined) { state.reportedUsage++; state.usage = accumulateUsage(state.usage, event.usage) }
  }
}

/**
 * 将内部事件映射为公开白名单字段，思考和原始工具载荷不导出。
 * @param event 已提交内部事件。
 * @returns 公共类型与载荷，或无需输出。
 */
export function mapEvent(event: SessionEvent): { type: string; data: Record<string, unknown> } | undefined {
  const step = event.step
  switch (event.type) {
    case "step/start": return { type: "step.started", data: { step } }
    case "step/end": return { type: "step.completed", data: { step, reason: event.reason } }
    case "assistant/block_delta":
      if (event.delta.type === "text") return { type: "message.delta", data: { step, block_id: event.blockId, text: event.delta.text } }
      return undefined
    case "assistant/message": return { type: "message.completed", data: { step, text: event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n") } }
    case "tool/result": return { type: "tool.completed", data: { step, call_id: event.toolCallId, status: event.result.status } }
    case "approval/result": return { type: "approval.resolved", data: { step, approval_id: event.approvalId, decision: event.decision } }
    default: return undefined
  }
}

/**
 * 将内部累计 Usage 转为公共输出字段，保留未报告状态。
 *
 * @param usage 已报告消息的累计 Usage。
 * @returns 公共字段名，缺失字段保持缺失。
 */
export function mapUsage(usage?: Usage): PublicUsage | null {
  if (!usage) return null
  return {
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cache_read_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cache_write_tokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens }),
  }
}

/**
 * 将内部结束原因映射为公共执行状态。
 *
 * @param reason 最终结束原因。
 * @returns 公共执行状态。
 */
export function resultStatus(reason: StopReason): RunResult["status"] {
  return reason === "finished" ? "completed" : reason === "error" || reason === "invalid_request" ? "failed" : "stopped"
}
/**
 * 将内部结束原因映射为固定 CLI 退出码。
 *
 * @param reason 最终结束原因。
 * @returns V1 固定退出码。
 */
export function exitCode(reason: StopReason): number {
  return { finished: 0, invalid_request: 2, max_steps: 10, timeout: 124, interrupted: 130, model_incomplete: 1, error: 1 }[reason]
}

/**
 * 同目录临时文件完成后重命名，失败时保留原结果并删除临时文件。
 * @param path 输出绝对路径，父目录必须存在。
 * @param result 已脱离凭据和内部事件的公共结果。
 * @returns 原子替换完成。
 * @throws Error 写入或重命名失败，由 CLI 映射为输出错误。
 */
export async function writeResult(path: string, result: RunResult): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => undefined) }
}

/** 命令帮助不触发任何配置初始化。 */
export const CLI_HELP = `NiCode Headless Agent Execution Protocol V1
nicode run --prompt-file <file> --output <result.json> [options]
nicode run --request <request.json> --output <result.json> [--format json|jsonl]

Options:
  --model <modelId>             默认使用 NiCode 有效默认模型
  --reasoning-level <level>     默认使用模型的第一个推理等级
  --workspace <directory>       默认使用启动目录
  --run-id <id>                 外部关联 ID
  --max-steps <count>            默认 100
  --timeout <seconds>            默认 1800
  --mcp-config <json>            仅替换本次 mcpServers
  --isolate <skill,memory,mcp>   禁用指定模块
  --sandbox-mode <mode>          full-access|sandbox-full-access|sandbox-read-only
  --auto-approve-groups <list>   file,shell,terminal,mcp,skill,memory
  --auto-approve-tools <list>    精确工具名；仅在触发审批时生效
  --format <json|jsonl>          stdout 格式，默认 json
  --help                        显示帮助
`
