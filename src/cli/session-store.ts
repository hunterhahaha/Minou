import { lstatSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { MCPCatalogTool, MCPConfig } from "../../runtime/mcp/src/types.ts"
import type { ModelRef } from "../../runtime/model/src/types.ts"
import { isModelRef, SANDBOX_MODES } from "../../runtime/session/src/session-state.ts"
import { checkConfig } from "../main/config-schema.ts"
import { CliInputError, TOOL_GROUPS } from "./protocol.ts"
import type { RunRequest } from "./protocol.ts"

/** 首次 run 决定的有效执行设置。每次续跑只补入新的用户消息。 */
export interface CliSessionSettings extends Pick<RunRequest,
  "supportsReasoning" | "workspace" | "isolated" | "sandboxMode" | "approveGroups" | "approveTools" | "maxSteps" | "timeoutSeconds"> {
  /** 首次执行选定的模型。凭据仍通过 Provider 存储读取。 */
  model: ModelRef
  /** 首次执行实际开放的内置工具名。 */
  systemTools: string[]
  /** 首次执行解析出的服务配置。 */
  mcpServers: MCPConfig[]
  /** 首次目录中可发现和调用的工具身份。 */
  mcpTools: Pick<MCPCatalogTool, "name" | "serverId" | "originalToolName">[]
  /** 首次执行的基础系统提示，独立于 SessionState 保存的上下文。 */
  systemPrompt: string
}

/**
 * 创建或打开当前 CLI 会话的设置，并取得跨进程独占权。
 * @param path 当前会话目录下的 SQLite 设置库。
 * @param initial 首次 run 要保存的设置；续跑省略。
 * @returns 已校验的设置和释放独占权的函数。
 * @throws CliInputError 会话缺少可续跑设置、设置损坏或已有进程在执行。
 */
export function openCliSession(path: string, initial?: CliSessionSettings): { settings: CliSessionSettings; close(): void } {
  if (!initial && !lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new CliInputError("会话不存在或缺少可续跑设置，请使用新版 run 创建会话。")
  }
  const db = new DatabaseSync(path)
  try {
    if (initial) {
      db.exec("CREATE TABLE cli_session (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL) STRICT")
      db.prepare("INSERT INTO cli_session (id, settings) VALUES (1, ?)").run(JSON.stringify(initial))
    }
    // 事务只持有这个会话的设置库，EventLog 和 SessionState 使用各自的数据库。
    db.exec("BEGIN IMMEDIATE")
    const row = db.prepare("SELECT settings FROM cli_session WHERE id = 1").get()
    const settings: unknown = typeof row?.settings === "string" ? JSON.parse(row.settings) : undefined
    if (!isCliSessionSettings(settings)) throw new CliInputError("CLI 会话设置无效。")
    return { settings, close: () => db.close() }
  } catch (error) {
    db.close()
    if (error instanceof CliInputError) throw error
    const code = (error as { errcode?: number })?.errcode
    if (code === 5 || code === 6) throw new CliInputError("此 CLI 会话正在执行。")
    throw new CliInputError("无法读取或保存 CLI 会话设置。")
  }
}

/**
 * 校验磁盘设置，复用模型、沙箱和 MCP 配置的现有约束。
 * @param value 解析出的会话设置。
 * @returns 设置是否可直接用于 CLI 工具与模型装配。
 */
function isCliSessionSettings(value: unknown): value is CliSessionSettings {
  if (!value || typeof value !== "object") return false
  const settings = value as Partial<CliSessionSettings>
  const isolated = settings.isolated
  if (!isModelRef(settings.model) || typeof settings.systemPrompt !== "string" ||
    typeof settings.workspace !== "string" || !isAbsolute(settings.workspace) ||
    typeof settings.supportsReasoning !== "boolean" ||
    !isolated || [isolated.skill, isolated.memory, isolated.mcp].some((flag) => typeof flag !== "boolean") ||
    settings.sandboxMode === undefined || !SANDBOX_MODES.includes(settings.sandboxMode) ||
    !Array.isArray(settings.approveGroups) || !settings.approveGroups.every((group) => TOOL_GROUPS.includes(group)) ||
    !Array.isArray(settings.approveTools) || !settings.approveTools.every((name) => typeof name === "string") ||
    !Array.isArray(settings.systemTools) || !settings.systemTools.every((name) => typeof name === "string") ||
    typeof settings.maxSteps !== "number" || !Number.isSafeInteger(settings.maxSteps) || settings.maxSteps < 1 ||
    typeof settings.timeoutSeconds !== "number" || !Number.isSafeInteger(settings.timeoutSeconds) ||
    settings.timeoutSeconds < 1 || settings.timeoutSeconds > Math.floor(2_147_483_647 / 1000) ||
    !Array.isArray(settings.mcpTools) || !settings.mcpTools.every((tool) =>
      tool && [tool.name, tool.serverId, tool.originalToolName].every((name) => typeof name === "string" && name.length > 0)) ||
    !Array.isArray(settings.mcpServers)) return false
  try { checkConfig({ version: 2, mcpServers: settings.mcpServers, runtime: { userMessageMode: "queue" } }) }
  catch { return false }
  return true
}
