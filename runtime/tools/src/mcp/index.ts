/** MCP 发现工具和真正远端工具的成对注册；全局连接状态由 runtime/mcp 管理。 */
import { MCPManager, mcpError } from "../../../mcp/src/index.ts"
import type { MCPToolCallResult, MCPToolNameInfo } from "../../../mcp/src/types.ts"
import type { AppError } from "../../../error/src/types.ts"
import { isPlainRecord, registerTool } from "../tool-registry.ts"
import type { RenderRegistry, ToolRegistry, ToolArgumentValidation } from "../tool-registry.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolExecutionContext, ToolResult } from "../types.ts"
import { renderMCPResult } from "../render/mcp.ts"

/** 名称查看没有业务字段。 */
export type MCPListToolsInput = Record<string, never>
/** 指定载入时传递发现工具返回的稳定名称。 */
export interface MCPLoadToolsInput {
  /** 未知名称被跳过，空列表载入 0 个。 */ names: string[]
}
/** BM25 搜索输入。 */
export interface ToolSearchInput {
  /** 非空白查询。 */ query: string
}
/** 名称查看的轻量结果。 */
export interface MCPListToolsResult { /** 当前可用工具。 */ tools: MCPToolNameInfo[] }
/** 按名称载入的结果。 */
export interface MCPLoadToolsResult { /** 新载入工具数量。 */ loadedCount: number }
/** 搜索并载入的结果。 */
export interface ToolSearchResult { /** 新载入工具数量。 */ loadedCount: number }

/** 搜索优先说明，同样用于 list 和 load 的模型提示词。 */
export const MCP_DISCOVERY_GUIDANCE = "Prefer tool_search to find and automatically load the MCP tools you need. If tool_search cannot find suitable tools, use mcp_list_tools to inspect available names, then mcp_load_tools to load the selected tools. Newly loaded tools become available in the next model iteration."

/**
 * 登记 MCP 发现工具，并同步 Catalog 的真正工具和共用 renderer。
 * @param tools 应用共用工具表。
 * @param renders 应用共用结果整理器表。
 * @param manager 应用唯一 MCPManager。
 * @returns 解除 Catalog 订阅的函数；资源释放仍由 Manager 负责。
 * @throws Error 注册名称冲突或定义无效，启动装配负责报告。
 */
export function registerMCPTools(tools: ToolRegistry, renders: RenderRegistry, manager: MCPManager): () => void {
  registerTool<MCPListToolsInput, MCPListToolsResult>(tools, renders, {
    kind: "builtin", definition: { name: "mcp_list_tools", description: `List available MCP tool names and Server IDs without loading their schemas. ${MCP_DISCOVERY_GUIDANCE}`, inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    validateArguments: (input) => isPlainRecord(input) && Object.keys(input).length === 0 ? { success: true, data: {} } : invalid("mcp_list_tools 不接受业务参数。"),
    execute: async () => ({ tools: manager.listTools() }),
    render: (result) => isError(result) ? renderCommonError(result) : success(result.tools.length ? result.tools.map((tool) => `${tool.name}\nServer ID: ${tool.serverId}`).join("\n\n") : "No MCP tools found."),
  })
  registerTool<MCPLoadToolsInput, MCPLoadToolsResult>(tools, renders, {
    kind: "builtin", definition: { name: "mcp_load_tools", description: `Load or refresh selected MCP tools by the exact names returned by mcp_list_tools. Already-loaded tools receive current schemas; the returned count includes only newly loaded tools. ${MCP_DISCOVERY_GUIDANCE}`, inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"], additionalProperties: false } },
    validateArguments: (input) => isPlainRecord(input) && Object.keys(input).every((key) => key === "names") && Array.isArray(input.names) && input.names.every((name) => typeof name === "string") ? { success: true, data: { names: input.names as string[] } } : invalid("names 必须是字符串数组。"),
    execute: (input, context) => load(manager, input.names, context),
    render: (result) => isError(result) ? renderCommonError(result) : success(`Loaded ${result.loadedCount} MCP tools.`),
  })
  registerTool<ToolSearchInput, ToolSearchResult>(tools, renders, {
    kind: "builtin", definition: { name: "tool_search", description: `Search MCP tools by Server name, tool name and description using BM25, and automatically load up to eight matches. ${MCP_DISCOVERY_GUIDANCE}`, inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false } },
    validateArguments: (input) => isPlainRecord(input) && Object.keys(input).every((key) => key === "query") && typeof input.query === "string" && input.query.trim().length > 0 ? { success: true, data: { query: input.query } } : invalid("query 必须是非空白字符串。"),
    execute: (input, context) => load(manager, manager.searchTools(input.query), context),
    render: (result) => isError(result) ? renderCommonError(result) : success(`Loaded ${result.loadedCount} tools.`),
  })
  const registered = new Set<string>()
  /** Catalog 已完整发布后同步两个表，不直接加入 Session 暴露列表。 */
  const synchronize = (): void => {
    for (const name of registered) { tools.removeMCP(name); renders.removeMCP(name) }
    registered.clear()
    for (const { name } of manager.listTools()) {
      const tool = manager.getTool(name)!
      registerTool<Record<string, unknown>, MCPToolCallResult>(tools, renders, {
        kind: "mcp", mcp: { serverId: tool.serverId, originalToolName: tool.originalToolName }, definition: { ...tool.definition, name: tool.name },
        validateArguments: (input) => {
          const current = manager.getTool(name)
          if (!current) return invalid("MCP 工具当前不可用。")
          const check = current.validate(input)
          return check.valid ? { success: true, data: check.data! } : invalid("MCP 工具参数不符合当前 Schema。")
        },
        execute: (input, context) => manager.executeMCPTool(name, input, context), render: renderMCPResult,
      })
      registered.add(name)
    }
  }
  synchronize()
  return manager.onCatalogChanged(synchronize)
}

/**
 * 按当前 Session 的模型窗口计算 MCP 载入状态，并提交载入记录及有效定义。
 * @param manager 全局目录和预算计算器。
 * @param names 本批候选。
 * @param context Session 边界。
 * @returns 持久化后的新载入数量或错误。
 */
async function load(manager: MCPManager, names: string[], context: ToolExecutionContext<object>): Promise<MCPLoadToolsResult | AppError> {
  if (!context.mcpRuntime) return mcpError("MCP_RUNTIME_MISSING", "当前 Session 缺少 MCP 上下文。")
  if (!context.mcpRuntime.contextWindow) return mcpError("MCP_CONTEXT_WINDOW_MISSING", "当前模型缺少 MCP 预算上下文窗口。")
  try {
    const previous = await context.mcpRuntime.readLoadedTools()
    if (context.signal.aborted) return mcpError("CANCELLED", "MCP 工具载入已取消。")
    const result = manager.loadTools(names, previous, context.mcpRuntime.contextWindow)
    await context.mcpRuntime.writeLoadedTools(result.loaded, result)
    return { loadedCount: result.loadedCount }
  } catch { return mcpError("MCP_LOAD_FAILED", "MCP 工具状态读取或保存失败。") }
}

/**
 * 构造参数校验失败结果，供统一执行入口交给结果整理器。
 * @param message 参数错误说明。
 * @returns 统一参数失败。
 */
function invalid<T extends object>(message: string): ToolArgumentValidation<T> { return { success: false, error: mcpError("INVALID_TOOL_ARGUMENTS", message) } }
/**
 * 根据结果字段区分业务输出与 AppError。
 * @param result 专属结果或错误。
 * @returns 是否为 AppError。
 */
function isError(result: object): result is AppError { return "source" in result && "code" in result && "message" in result }
/**
 * 将成功说明包装为统一文本 ToolResult。
 * @param text 成功结果文本。
 * @returns 统一文本结果。
 */
function success(text: string): ToolResult { return { status: "success", content: [{ type: "text", text }] } }
