/** Headless Agent Execution Protocol V1 的输入、统计与结果。 */
import { randomUUID } from "node:crypto"
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { accumulateUsage } from "../../runtime/model/src/types.ts"
import type { ModelRef, Usage } from "../../runtime/model/src/types.ts"
import type { MCPConfig } from "../../runtime/mcp/src/types.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import { SANDBOX_MODES } from "../../runtime/session/src/session-state.ts"
import type { SandboxMode } from "../../runtime/session/src/session-state.ts"
import { checkConfig } from "../main/config-schema.ts"

/** 自动审批的固定工具组；只影响已触发的审批。 */
export const TOOL_GROUPS = ["file", "shell", "terminal", "mcp", "skill", "memory"] as const
/** 一种明确的自动审批分组。 */
export type ToolGroup = typeof TOOL_GROUPS[number]
/** 结束原因同时决定公共状态和进程退出码。 */
export type StopReason = "finished" | "invalid_request" | "max_steps" | "timeout" | "interrupted" | "model_incomplete" | "error"

/** 校验、路径解析和默认值补齐后的单次运行请求。 */
export interface RunRequest {
  /** 保留原文的用户任务。 */
  prompt: string
  /** 可选的稳定模型 ID；省略时读取有效默认模型。 */
  modelId?: string
  /** 本次运行是否向模型发送思考参数。 */
  supportsReasoning: boolean
  /** 可选等级，模型解析阶段确认其合法性。 */
  reasoningLevel?: string
  /** 已验证存在的绝对工作目录。 */
  workspace: string
  /** 显式提供本次 MCP 配置；省略时由 useConfiguredMcp 决定是否载入全局配置。 */
  mcpServers?: MCPConfig[]
  /** 未提供 MCP 配置文件时是否载入全局 MCP 服务。 */
  useConfiguredMcp: boolean
  /** 启用时只开放 systemTools 中列出的内置工具。 */
  restrictSystemTools: boolean
  /** 允许使用的精确内置工具名称；空数组表示白名单为空。 */
  systemTools: string[]
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

/** 单次 CLI 启动输入。 */
export interface CliInput {
  /** 单次任务参数。 */
  request: RunRequest
  /** 可选回答文件的绝对路径，父目录必须存在。 */
  output?: string
  /** 可选 JSON 运行结果文件的绝对路径，父目录必须存在。 */
  outputJson?: string
}

/** 可公开的输入错误；不携带 SDK 错误、配置正文或凭据。 */
export class CliInputError extends Error {
  /** @param message 可供调用方修正输入的公开说明。 */
  constructor(message: string) { super(message); this.name = "CliInputError" }
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
  /** 实际已提交的 Turn 数。 */ turns: number
  /** 实际已提交的 Step 数。 */ steps: number
  /** 已结束工具调用块数量，包含拒绝和失败调用。 */ toolCalls: number
  /** 已提交的 Assistant Message 数量。 */ messages: number
  /** 报告了权威 Usage 的消息数量。 */ reportedUsage: number
  /** 最后一条 Assistant Message 的文本。 */ answer: string
  /** 仅已报告消息的累计 Usage。 */ usage?: Usage
}

/** 可选写入 JSON 文件的最终运行结果。 */
export interface RunResult {
  /** 本次内部 UUID，不对应桌面对话索引。 */ session_id: string
  /** 执行状态，不表示答案正确。 */ status: "completed" | "stopped" | "failed"
  /** 精确终止原因。 */ stop_reason: StopReason
  /** 最后一个 Assistant Message 的公开文本。 */ answer: string
  /** 是否由模型正常完成输出。 */ answer_complete: boolean
  /** 实际固定模型；模型解析前失败时为 null。 */ model: ModelRef | null
  /** 本次独立内部日志及工具输出目录；创建前失败时为 null。 */ record_directory: string | null
  /** 本次事件日志数据库的绝对路径；初始化前失败时为 null。 */ event_log_path: string | null
  /** 已提交事件派生的指标。 */
  metrics: {
    turns: number; steps: number; tool_calls: number; duration_ms: number; usage: PublicUsage | null
    usage_complete: boolean; usage_reported_steps: number; usage_scope: "reported_agent_requests"
  }
  /** 仅公开稳定错误码和阶段说明。 */ error?: { code: string; stage: string; message: string }
}

const VALUE_OPTIONS = new Set([
  "prompt", "output", "outputjson", "modelid", "supportreason", "reasoning-level", "workspace",
  "max-steps", "timeout", "mcp-config", "isolate", "sandbox-mode", "auto-approve-groups", "auto-approve-tools",
  "restrict-system-tools", "system-tools", "use-configured-mcp",
])

/**
 * 解析平铺的命令行参数并补齐运行默认值。
 * @param argv 包含 run 子命令的参数。
 * @param cwd 相对命令行路径的基准。
 * @returns 已校验的请求及输出控制。
 * @throws CliInputError 参数、MCP 配置或工作区无效。
 */
export async function readCliInput(argv: readonly string[], cwd: string): Promise<CliInput> {
  if (argv[0] !== "run") throw new CliInputError("需要 run 子命令；使用 minou run --help 查看参数。")
  const options: Record<string, string> = {}
  for (let i = 1; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i])
    if (!match || !VALUE_OPTIONS.has(match[1])) throw new CliInputError("存在未知参数或位置参数。")
    const name = match[1]
    if (name in options) throw new CliInputError(`--${name} 不能重复。`)
    const value = match[2] ?? argv[++i]
    if (value === undefined || (match[2] === undefined && value.startsWith("--")) || !value.trim()) throw new CliInputError(`--${name} 缺少值。`)
    options[name] = value
  }
  const output = options.output === undefined ? undefined : resolve(cwd, options.output)
  const outputJson = options.outputjson === undefined ? undefined : resolve(cwd, options.outputjson)
  const caseInsensitive = process.platform === "win32"
  if (output !== undefined && outputJson !== undefined &&
    (caseInsensitive ? output.toLowerCase() === outputJson.toLowerCase() : output === outputJson)) {
    throw new CliInputError("--output 和 --outputjson 必须使用不同的文件路径。")
  }
  const prompt = text(options.prompt, "--prompt")
  const isolatedModules = csv(options.isolate)
  if (isolatedModules.some((name) => !["skill", "memory", "mcp"].includes(name))) {
    throw new CliInputError("--isolate 仅接受 skill、memory 和 mcp。")
  }
  const isolated = { skill: isolatedModules.includes("skill"), memory: isolatedModules.includes("memory"), mcp: isolatedModules.includes("mcp") }
  const mode = options["sandbox-mode"] ?? "sandbox-full-access"
  if (!SANDBOX_MODES.includes(mode as SandboxMode)) throw new CliInputError("--sandbox-mode 无效。")
  const groups = csv(options["auto-approve-groups"])
  if (groups.some((group) => !TOOL_GROUPS.includes(group as ToolGroup))) throw new CliInputError("--auto-approve-groups 包含未知工具组。")
  const workspace = resolve(cwd, options.workspace ?? ".")
  try { if (!(await stat(workspace)).isDirectory()) throw new Error() }
  catch { throw new CliInputError("--workspace 必须为现存目录。") }
  let mcpServers: MCPConfig[] | undefined
  if (options["mcp-config"] !== undefined) {
    if (isolated.mcp) throw new CliInputError("--isolate mcp 与 --mcp-config 冲突。")
    const config = object(await readJson(resolve(cwd, options["mcp-config"])), "--mcp-config", ["mcpServers"])
    try { checkConfig({ version: 2, mcpServers: config.mcpServers, runtime: { userMessageMode: "queue" } }) }
    catch { throw new CliInputError("--mcp-config 必须包含符合现有结构的 mcpServers 数组。") }
    mcpServers = config.mcpServers as MCPConfig[]
  }
  return {
    request: {
      prompt, modelId: options.modelid, supportsReasoning: booleanOption(options.supportreason, "supportreason") ?? true,
      reasoningLevel: options["reasoning-level"], workspace, mcpServers, isolated,
      useConfiguredMcp: booleanOption(options["use-configured-mcp"], "use-configured-mcp") ?? true,
      restrictSystemTools: booleanOption(options["restrict-system-tools"], "restrict-system-tools") ?? false,
      systemTools: csv(options["system-tools"]), sandboxMode: mode as SandboxMode,
      approveGroups: groups as ToolGroup[], approveTools: csv(options["auto-approve-tools"]),
      maxSteps: integer(Number(options["max-steps"] ?? 100), "--max-steps", Number.MAX_SAFE_INTEGER),
      timeoutSeconds: integer(Number(options.timeout ?? 1800), "--timeout", Math.floor(2_147_483_647 / 1000)),
    },
    output, outputJson,
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
 * 将逗号分隔的命令行值拆为名称列表。
 *
 * @param value 命令行列表。
 * @returns 按首次出现顺序去重后的名称；省略时为空。
 * @throws CliInputError 包含空条目。
 */
function csv(value?: string): string[] { return value === undefined ? [] : [...new Set(value.split(",").map((entry) => text(entry.trim(), "列表参数")))] }

/**
 * 读取显式的命令行布尔值并保留省略状态。
 * @param value 命令行原始值。
 * @param name 对应的命令行参数名称。
 * @returns 解析后的布尔值或 undefined。
 * @throws CliInputError 值既不是 true 也不是 false。
 */
function booleanOption(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (value === "true") return true
  if (value === "false") return false
  throw new CliInputError(`--${name} 仅接受 true 或 false。`)
}
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
export function createStatistics(): RunStatistics { return { turns: 0, steps: 0, toolCalls: 0, messages: 0, reportedUsage: 0, answer: "" } }

/**
 * 从已经持久化的权威事件累计指标，每条事件调用一次。
 * @param state 本次 Run 的统计状态。
 * @param event 已提交内部事件。
 */
export function observeEvent(state: RunStatistics, event: SessionEvent): void {
  if (event.type === "turn/start") state.turns++
  if (event.type === "step/start") state.steps++
  if (event.type === "assistant/block_end" && event.block.type === "tool_call") state.toolCalls++
  if (event.type === "assistant/message") {
    state.messages++
    state.answer = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n")
    if (event.usage !== undefined) { state.reportedUsage++; state.usage = accumulateUsage(state.usage, event.usage) }
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
 * @param content 已序列化的 UTF-8 文件内容。
 * @returns 原子替换完成。
 * @throws Error 写入或重命名失败，由 CLI 映射为输出错误。
 */
export async function writeOutputFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => undefined) }
}

/** 命令帮助不触发任何配置初始化。 */
export const CLI_HELP = `Minou Headless Agent Execution Protocol V1
minou run --prompt <text> [options]

Options:
  --modelid <id>                默认使用 Minou 有效默认模型
  --supportreason <true|false>   本次运行是否发送思考参数，默认 true
  --reasoning-level <level>     默认使用模型的第一个推理等级
  --workspace <directory>       默认使用启动目录
  --max-steps <count>            默认 100
  --timeout <seconds>            默认 1800
  --mcp-config <path>            仅替换本次 mcpServers
  --use-configured-mcp <bool>    是否使用全局 MCP 配置，默认 true
  --isolate <skill,memory,mcp>   禁用指定模块
  --restrict-system-tools <bool> 是否启用内置工具白名单，默认 false
  --system-tools <list>          白名单中的精确工具名，逗号分隔，默认空
  --sandbox-mode <mode>          full-access|sandbox-full-access|sandbox-read-only|auto
  --auto-approve-groups <list>   file,shell,terminal,mcp,skill,memory；auto 模式由模型审核
  --auto-approve-tools <list>    精确工具名；auto 模式由模型审核
  --output <path>                可选回答文件，写入 UTF-8 纯文本
  --outputjson <path>            可选最终运行结果，写入 JSON 文件
  --help                        显示帮助
`
