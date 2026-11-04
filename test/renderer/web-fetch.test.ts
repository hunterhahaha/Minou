/** 验证通用 Renderer 投影保留抓取成功与失败结果，不引入专属状态。 */
import { renderWebFetch } from "../../runtime/tools/src/render/web-fetch.ts"
import assert from "node:assert/strict"
import { projectSessionEvents, mergeSessionEvents } from "../../src/renderer/session-state.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"
import type { ToolResult } from "../../runtime/tools/src/types.ts"

for (const result of [
  renderWebFetch({ text: "# Truncated Markdown", truncated: true, totalBytes: 40000, fullOutputPath: "C:\\profile\\.nicode\\sessions\\default\\fetch-session\\tool_output\\web_fetch_00000000-0000-4000-8000-000000000001.md" }),
  { status: "success", content: [{ type: "text", text: "# Markdown\n\n**原文**" }] },
  { status: "error", content: [{ type: "text", text: "网页正文超过 5 MiB，已丢弃全部内容。" }], error: { source: "tool", code: "WEB_FETCH_TOO_LARGE", message: "网页正文超过 5 MiB，已丢弃全部内容。" } },
] satisfies ToolResult[]) {
  const call = { type: "tool_call", toolCallId: "fetch-1", name: "web_fetch", arguments: { url: "https://example.com" } } as const
  const base = { sessionId: "fetch-session", turn: 1, step: 1, createdAt: "2026-11-04T00:00:00Z" }
  const events: SessionEvent[] = [
    { ...base, seq: 1, eventId: "call", type: "assistant/block_end", blockId: "b", index: 0, block: call },
    { ...base, seq: 2, eventId: "result", type: "tool/result", blockId: "b", toolCallId: "fetch-1", toolCallEventId: "call", result },
  ]
  const view = projectSessionEvents(events)
  assert.equal(view[0].kind, "assistant")
  if (view[0].kind === "assistant") assert.deepEqual(view[0].blocks, [call])
  assert.ok(view[1].kind === "event" && view[1].event.type === "tool/result")
  assert.deepEqual(view[1].event.result, result)
  assert.equal(view[1].event.toolCallId, call.toolCallId)
  assert.equal(view[1].event.turn, base.turn)
  assert.equal(view[1].event.step, base.step)
  assert.deepEqual(projectSessionEvents(mergeSessionEvents(events.slice(0, 1), events)), view)
}
console.log("Renderer web-fetch: 成功原文、失败结果及历史/增量投影通过")
