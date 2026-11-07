import type { ModelHistory, ModelHistoryEvent, ModelTextBlock } from "../../model/src/types.ts"
import type { McpToolChangeInput, SessionEvent } from "../../session/src/events.ts"
import type { MCPLoadResult } from "../../mcp/src/manager.ts"

/**
 * 以最近成功的 Summary 为起点裁剪并投影历史。
 * @param system 当前 Step 使用的固定系统提示。
 * @param events 宿主按持久化顺序读取的已提交事件。
 * @returns 保留序号、基线和模型相关字段的转换器输入。
 */
export function modelHistory(system: string, events: readonly SessionEvent[]): ModelHistory {
  const summary = events.filter((event) => event.type === "summary/end").at(-1)
  const history: ModelHistoryEvent[] = []
  for (const event of events) {
    const { seq } = event
    if (summary !== undefined && seq < summary.seq) continue
    switch (event.type) {
      case "summary/end": history.push({ seq, type: event.type, summary: event.summary }); break
      case "context_update": history.push({ seq, type: event.type, content: event.content }); break
      case "user/message": history.push({ seq, type: event.type, content: event.message.content }); break
      case "assistant/message": history.push({ seq, type: event.type, content: event.message.content, finishReason: event.finishReason }); break
      case "tool/result": history.push({
        seq, type: event.type, turn: event.turn, step: event.step,
        toolCallEventId: event.toolCallEventId, toolCallId: event.toolCallId,
        content: event.result.content.filter((block): block is ModelTextBlock => block.type === "text"),
        isError: event.result.status === "error",
      }); break
      case "mcp/tools_added": history.push({ seq, type: event.type, turn: event.turn, step: event.step, definitions: event.tools.map(({ definition }) => definition) }); break
      case "mcp/tools_removed": history.push({ seq, type: event.type, turn: event.turn, step: event.step, toolNames: event.toolNames }); break
    }
  }
  return { system, mcpBaseline: summary?.baseline.mcp ?? [], events: history }
}

/**
 * 为一次实际载入构造按提交顺序排列的增量事件。
 * @param change MCPManager 计算的本次载入结果。
 * @param turn 工具调用所属 Turn。
 * @param step 工具调用所属 Step。
 * @param toolCallEventId 对应工具调用块的已提交事件 ID。
 * @returns 先移除后新增的事件输入，省略空变化。
 * @throws Error 集合有变化却缺少原调用身份时抛出。
 */
export function mcpToolChanges(change: MCPLoadResult, turn: number, step: number, toolCallEventId: string | undefined): McpToolChangeInput[] {
  if (change.added.length === 0 && change.removed.length === 0) return []
  if (toolCallEventId === undefined) throw new Error("MCP 载入缺少工具调用事件身份")
  const source = { turn, step, toolCallEventId }
  const events: McpToolChangeInput[] = []
  if (change.removed.length > 0) events.push({ ...source, type: "mcp/tools_removed", toolNames: change.removed })
  if (change.added.length > 0) events.push({ ...source, type: "mcp/tools_added", tools: change.added })
  return events
}
