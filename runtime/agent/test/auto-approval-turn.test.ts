import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { loadFileAccessState } from "../../../src/main/file-access.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import { requestMessages } from "../../model/test/helpers.ts"
import type { ModelRef } from "../../model/src/types.ts"
import type { SessionEvent, SessionEventInput } from "../../session/src/events.ts"
import { RenderRegistry, ToolRegistry } from "../../tools/src/index.ts"
import { registerFileTools } from "../../tools/src/file/index.ts"
import { bundledRipgrepPath, canonicalPath } from "../../tools/src/filesystem/index.ts"
import { SessionRuntime } from "../src/session-runtime.ts"

const MODEL: ModelRef = { providerId: "p", protocol: "responses", modelId: "m", name: "Model", reasoningLevel: "high" }

/** 使用真实文件、进程权限、事件日志和会话设置验证自动审核。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-auto-approval-"))
  const paths = await initializeConfigFiles(root)
  const workspace = join(paths.rootDir, "sessions", "default", "workspace")
  const inside = join(workspace, "inside.txt"), outside = join(root, "outside.txt"), pending = join(root, "pending.txt")
  const calls = [
    { name: "read", arguments: { path: inside } },
    { name: "read", arguments: { path: outside } },
    { name: "read", arguments: { path: pending } },
    { name: "write", arguments: { path: join(workspace, "write.txt"), content: "direct write" } },
    { name: "shell", arguments: { command: "Write-Output offline" } },
    { name: "terminal_open", arguments: {} },
  ]
  const tools = new ToolRegistry(), renders = new RenderRegistry()
  registerFileTools(tools, renders, { rgPath: bundledRipgrepPath(process.cwd()),
    loadAccess: (projectId, sessionId) => loadFileAccessState(paths, projectId, sessionId) })
  const global = new SessionRuntimeGlobal(paths, tools, renders)
  let turns = 0
  const reviews: { turnContext: unknown[]; candidate: { toolName: string; arguments: unknown; reason: string } }[] = []
  global.createTurnModelAdapter = async () => {
    const turn = ++turns
    let steps = 0
    return { contextWindow: 128_000, maxOutputTokens: 4096, reasoningLevels: ["none", "high"], stream: async function* (request, _signal, options) {
      if (options?.retry === false) {
        const input = JSON.parse(String(requestMessages(request)[1].content)) as (typeof reviews)[number]
        reviews.push(input)
        const approved = reviews.length === 1
        const text = JSON.stringify({ riskLevel: approved ? "low" : "medium", approved })
        yield { type: "block_start", index: 0, blockType: "text" }
        yield { type: "block_end", index: 0, block: { type: "text", text } }
        yield { type: "stream_end", completion: "finished" }
      } else if (turn === 2 && ++steps === 1) {
        yield { type: "block_start", index: 0, blockType: "thinking" }
        yield { type: "block_end", index: 0, block: { type: "thinking", text: "excluded-thinking" } }
        yield { type: "block_start", index: 1, blockType: "text" }
        yield { type: "block_end", index: 1, block: { type: "text", text: "本轮助手正文" } }
        for (const [index, call] of calls.entries()) {
          yield { type: "block_start", index: index + 2, blockType: "tool_call" }
          yield { type: "block_end", index: index + 2, block: { type: "tool_call", toolCallId: "call-" + index, ...call } }
        }
        yield { type: "stream_end", completion: "tool_calls" }
      } else {
        yield { type: "stream_end", completion: "finished" }
      }
    } }
  }

  let insideCommitted!: () => void, outsideCommitted!: () => void
  const insideResult = new Promise<void>((resolve) => { insideCommitted = resolve })
  const outsideResult = new Promise<void>((resolve) => { outsideCommitted = resolve })
  const execute = global.executeTool.bind(global)
  global.executeTool = async (name, args, context) => {
    if (context.toolCallId === "call-1") await insideResult
    if (context.toolCallId === "call-2") await outsideResult
    return execute(name, args, context)
  }
  const sessionId = "auto-approval-session"
  const createRuntime = () => new SessionRuntime({
    sessionId, projectGroupId: "default", sessionDirectory: join(paths.rootDir, "sessions", "default", sessionId),
    databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath,
    systemPrompt: "excluded-system", global,
  })
  const initial = createRuntime()
  let resumed: SessionRuntime | undefined
  try {
    await writeFile(inside, "inside-result")
    await writeFile(outside, "outside-result")
    await writeFile(pending, "pending-result")
    const old = await initial.startNewSession({ content: [{ type: "text", text: "excluded-previous-turn" }], model: MODEL })
    await old.completion
    await initial.updateSettings({ sandboxMode: "auto" })
    initial.close()

    resumed = createRuntime()
    const append = resumed.appendEvent.bind(resumed)
    resumed.appendEvent = async (input: SessionEventInput) => {
      const event = await append(input)
      if (event.type === "tool/result" && event.toolCallId === "call-0") insideCommitted()
      if (event.type === "tool/result" && event.toolCallId === "call-1") outsideCommitted()
      return event
    }
    const current = await resumed.continueSession({ content: [{ type: "text", text: "本轮用户授权" }] })
    await current.completion
    assert.deepEqual(reviews.map(({ candidate }) => candidate.toolName), ["read", "read", "shell", "terminal_open"])
    assert.equal((reviews[0].candidate.arguments as { path: string }).path, outside)
    assert.equal(reviews[0].candidate.reason, `文件路径需要授权：${await canonicalPath(outside)}`)
    const firstContext = JSON.stringify(reviews[0].turnContext)
    for (const expected of ["本轮用户授权", "本轮助手正文", "call-0", "inside-result"]) assert.ok(firstContext.includes(expected), expected)
    for (const excluded of ["excluded-", "call-1", "call-2", "call-3", "outside-result", "pending.txt"]) {
      assert.ok(!firstContext.includes(excluded), excluded)
    }
    assert.match(JSON.stringify(reviews[1].turnContext), /outside-result/)
    const events = await resumed.readEvents() as SessionEvent[]
    assert.equal(events.some((event) => event.type.startsWith("approval/")), false)
    const results = events.filter((event) => event.type === "tool/result")
    assert.deepEqual(results.map(({ toolCallId, result }) => [toolCallId, result.status === "error" ? result.error.code : "success"]), [
      ["call-0", "success"], ["call-1", "success"], ["call-2", "APPROVAL_DENIED"], ["call-3", "success"],
      ["call-4", "APPROVAL_DENIED"], ["call-5", "APPROVAL_DENIED"],
    ])
    console.log("auto-approval-turn.test.ts: 本轮上下文、文件权限、进程拒绝、设置恢复和事件通过")
  } finally {
    initial.close()
    resumed?.close()
    await global.disposeProcessTools()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
