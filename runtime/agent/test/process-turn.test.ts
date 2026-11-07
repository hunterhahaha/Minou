import { requestMessages } from "../../model/test/helpers.ts"
/**
 * 使用脚本模型和真实本机 Shell、PTY 后端验证 Session 进程工具链。
 *
 * 覆盖工具结果回填、队列 Turn 复用终端、停止中断、继续对话与终端关闭；
 * 配置和会话存储使用临时目录，测试结束时释放进程工具资源。
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelAdapter, ModelRef, UnifiedModelRequest } from "../../model/src/types.ts"
import type { SessionEvent } from "../../session/src/events.ts"
import { createAbortError } from "../../error/src/abort.ts"
import { ToolRegistry, RenderRegistry } from "../../tools/src/index.ts"
import { SessionRuntime } from "../src/session-runtime.ts"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"

const MODEL: ModelRef = { providerId: "offline", protocol: "responses", modelId: "offline", name: "Offline", reasoningLevel: "medium" }
const MESSAGE = [{ type: "text" as const, text: "测试进程工具" }]

/**
 * 从下一 Step 的模型上下文提取指定工具结果，并断言调用关联及成功状态。
 * @param request - 下一 Step 收到的统一模型请求。
 * @param id - 要检查的工具调用 ID。
 * @returns 该工具结果全部 text 内容块拼接后的文本。
 * @throws AssertionError - 工具结果缺失、关联错误或属于失败结果。
 */
function toolText(request: UnifiedModelRequest, id: string): string {
  const result = requestMessages(request).find((message) => message.role === "tool" && message.toolCallId === id)
  assert.ok(result?.role === "tool" && !result.isError)
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
}

/**
 * 使用真实本机 Shell 和 PTY 验证工具回填、终端复用、停止与继续，并释放进程资源。
 *
 * @returns 本文件全部验证和资源清理完成时兑现的 Promise。
 * @throws Error - 断言、临时存储或本机后端验证失败；顶层测试出口记录异常并设置失败退出码。
 */
async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "nicode-process-turn-"))
  const paths = await initializeConfigFiles(profile)
  const global = new SessionRuntimeGlobal(paths, new ToolRegistry(), new RenderRegistry())
  const sessionId = "process-session"
  let terminalId = ""
  let adapterCount = 0
  let polledLateOutput = false
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let modelWaiting!: () => void
  const waiting = new Promise<void>((resolve) => { modelWaiting = resolve })
  global.createTurnModelAdapter = async (): Promise<ModelAdapter> => {
    const turn = ++adapterCount
    let step = 0
    return { contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (request, signal) {
      step++
      assert.ok(["shell", "terminal_open", "terminal_input", "terminal_close", "terminal_list"].every((name) => request.tools?.some((tool) => tool.name === name)))
      if (turn === 1 && step === 1) await firstGate
      if (turn === 3) {
        modelWaiting()
        await new Promise<never>((_resolve, reject) => {
          /**
           * 以取消错误拒绝脚本模型等待中的 Promise，使停止操作进入 Loop 取消收尾。
           */
          const abort = () => reject(createAbortError())
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true })
        })
      }
      const calls: Array<{ name: string; arguments: object; toolCallId: string }> = []
      if (turn === 1 && step === 1) {
        calls.push({ name: "shell", arguments: { command: "[Console]::Write('SHELL_CONTEXT'); exit 7" }, toolCallId: "shell-1" }, { name: "terminal_open", arguments: {}, toolCallId: "open-1" })
      } else if (turn === 1 && step === 2) {
        assert.match(toolText(request, "shell-1"), /Exit code: 7/)
        assert.match(toolText(request, "shell-1"), /SHELL_CONTEXT/)
        terminalId = /ID: (term_[^\s]+)/.exec(toolText(request, "open-1"))![1]
        calls.push({ name: "terminal_input", arguments: { terminalId, input: "Start-Sleep -Seconds 30\r" }, toolCallId: "long-1" })
      } else if (turn === 1 && step === 3) {
        assert.match(toolText(request, "long-1"), /Status: running/)
      } else if (turn === 2 && step === 1) {
        assert.equal(global.terminalRouter.list("default", sessionId)[0].id, terminalId)
        calls.push({ name: "terminal_list", arguments: {}, toolCallId: "list-2" })
      } else if (turn === 2 && step === 2) {
        assert.match(toolText(request, "list-2"), /Status: running/)
      } else if (turn === 4 && step === 1) {
        calls.push({ name: "terminal_input", arguments: { terminalId, input: "[Console]::WriteLine('CONTINUED')\r" }, toolCallId: "reuse-4" })
      } else if (turn === 4 && step === 2) {
        assert.match(toolText(request, "reuse-4"), /Status: idle/)
        if (!toolText(request, "reuse-4").includes("CONTINUED")) {
          polledLateOutput = true
          await new Promise((resolve) => setTimeout(resolve, 50))
          calls.push({ name: "terminal_input", arguments: { terminalId, input: "" }, toolCallId: "late-4" })
        }
      } else if (turn === 4 && step === 3) {
        assert.match(toolText(request, "reuse-4") + toolText(request, "late-4"), /CONTINUED/)
      }
      if (calls.length) {
        for (const [index, call] of calls.entries()) {
          yield { type: "block_start", index, blockType: "tool_call" }
          yield { type: "block_end", index, block: { type: "tool_call", ...call } }
        }
        yield { type: "stream_end", completion: "tool_calls" }
      } else yield { type: "stream_end", completion: "finished" }
    } }
  }
  /**
   * 为同一持久化 Session 创建新的活动实例，模型脚本与全局能力由当前场景共用。
   * @returns 绑定测试 Session 目录和数据库的新 Runtime。
   * @throws Error Runtime 构造失败时抛出，调用方负责释放场景资源。
   */
  const runtime = () => new SessionRuntime({ projectGroupId: "default", sessionId, sessionDirectory: join(paths.rootDir, "sessions", "default", sessionId), databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "离线测试", global })
  try {
    const first = runtime()
    const started = await first.startNewSession({ content: MESSAGE, model: MODEL, sandboxMode: "full-access" })
    first.enqueueSessionMessage({ content: MESSAGE })
    const processing = first.processMessageQueue(started)
    releaseFirst()
    await processing.completion
    assert.equal(adapterCount, 2)
    assert.equal(global.terminalRouter.list("default", sessionId)[0].status, "running")
    assert.deepEqual(global.terminalRouter.list("default", "different"), [])

    const resumed = runtime()
    const continuation = await resumed.continueSession({ content: MESSAGE })
    await waiting
    let interrupts = 0
    const interrupt = global.interruptTerminals.bind(global)
    global.interruptTerminals = (project, session) => { interrupts++; return interrupt(project, session) }
    resumed.stop(); resumed.stop()
    assert.equal(interrupts, 1)
    assert.equal(global.terminalRouter.list("default", sessionId)[0].status, "running")
    await continuation.completion
    for (let attempt = 0; attempt < 100 && global.terminalRouter.list("default", sessionId)[0].status !== "idle"; attempt++) await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(global.terminalRouter.list("default", sessionId)[0].status, "idle")
    const next = runtime()
    const continued = await next.continueSession({ content: MESSAGE })
    await continued.completion
    const events = await next.readEvents() as readonly SessionEvent[]
    assert.ok(events.some((event) => event.type === "turn/end" && event.reason === "stopped"))
    const results = events.filter((event) => event.type === "tool/result")
    assert.equal(results.length, polledLateOutput ? 6 : 5)
    assert.ok(results.every((event) => event.type === "tool/result" && event.toolCallEventId.length > 0))
    await global.terminalRouter.close("default", sessionId, terminalId)
  } finally { await global.disposeProcessTools(); await rm(profile, { recursive: true, force: true }) }
  console.log("process turn tests passed")
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
