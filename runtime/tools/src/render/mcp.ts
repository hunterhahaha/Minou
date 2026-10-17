import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { MCPToolCallResult } from "../../../mcp/src/types.ts"
import type { AppError } from "../../../error/src/types.ts"
import type { ToolResult, ToolResultTextContent } from "../types.ts"
import { renderCommonError } from "../tool-executor.ts"

/** MCP 无顶层文本时的固定模型与持久化兜底。 */
export const MCP_NON_TEXT_FALLBACK = "Tool returned non-text content, but this application does not currently support rendering it."

/**
 * 只保留 SDK 顶层文本；业务错误保留远端文本并设置固定 MCP 错误。
 * @param output SDK 原始结果包装或统一错误。
 * @returns 可持久化的纯文本 ToolResult，不展开资源或 structuredContent。
 */
export function renderMCPResult(output: MCPToolCallResult | AppError): ToolResult {
  if ("source" in output) return renderCommonError(output)
  const raw = output.result as CallToolResult
  const content: ToolResultTextContent[] = raw.content.flatMap((block) => block.type === "text" ? [{ type: "text" as const, text: block.text }] : [])
  if (!content.length) content.push({ type: "text", text: MCP_NON_TEXT_FALLBACK })
  return raw.isError === true ? { status: "error", content, error: { source: "mcp", code: "MCP_TOOL_CALL_ERROR", message: "MCP tool execution failed." } } : { status: "success", content }
}
