import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TerminalRouter, PtyMarkerParser, registerTerminalTools, ToolRegistry, RenderRegistry, createExecuteToolCall } from "../src/index.ts"
import type { PtyBackend, PtyEvent, PtyProcess } from "../src/terminal/backend.ts"
import type { ToolCallContext } from "../src/types.ts"

/** 可控终端，模拟标记、持续输出、退出和拒绝 Ctrl+C。 */
class FakeBackend implements PtyBackend {
  readonly children: Array<{ receive: (event: PtyEvent) => void; input: string[]; disposed: boolean }> = []
  /**
   * 创建可控的测试终端句柄，异步报告首次就绪，并记录输入与清理调用。
   * @param cwd - 首次就绪事件报告的初始工作目录。
   * @param _nonce - 后端接口传入的随机身份；本测试后端不解析内部协议。
   * @param receive - 测试用于驱动路由输出、标记和退出事件的回调。
   * @returns 可以记录输入并标记已释放状态的测试进程。
   */
  spawn(cwd: string, _nonce: string, receive: (event: PtyEvent) => void): PtyProcess {
    const child = { receive, input: [] as string[], disposed: false }
    this.children.push(child)
    queueMicrotask(() => receive({ type: "done", run: 0, cwd }))
    return { write: (input) => { child.input.push(input) }, dispose: async () => { child.disposed = true } }
  }
}

/**
 * 运行本文件的离线断言或本机临时进程验证，并在结束时释放测试资源。
 * @returns 本文件全部验证和资源清理完成时兑现的 Promise。
 * @throws Error - 断言、临时存储或本机后端验证失败；顶层测试出口记录异常并设置失败退出码。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-terminal-"))
  const backend = new FakeBackend(), router = new TerminalRouter(backend, 20, 100)
  const signal = new AbortController().signal
  try {
    const events: PtyEvent[] = []
    const parser = new PtyMarkerParser("nonce", (event) => events.push(event))
    const marker = "\x1b]633;NiCode;nonce;D;1;" + Buffer.from(directory).toString("base64") + "\x07"
    parser.push("before" + marker.slice(0, 17)); parser.push(marker.slice(17) + "after")
    assert.deepEqual(events, [{ type: "data", data: "before" }, { type: "done", run: 1, cwd: directory }, { type: "data", data: "after" }])
    const first = await router.open("default", "one", directory, directory, signal)
    assert.equal(first.status, "idle")
    const child = backend.children[0]
    const partial = await router.input("default", "one", first.id, "echo", "partial", signal)
    assert.equal(partial.status, "idle")
    assert.deepEqual(child.input, ["echo"])
    const collecting = router.input("default", "one", first.id, "\r", "first", signal)
    child.receive({ type: "start", run: 1 })
    assert.equal(router.list("default", "one")[0].status, "running")
    child.receive({ type: "done", run: 0, cwd: "old" })
    child.receive({ type: "data", data: "hello" })
    const timed = await collecting
    assert.equal(timed.status, "running")
    assert.equal(timed.output, "hello")
    child.receive({ type: "data", data: "late" })
    child.receive({ type: "done", run: 1, cwd: "new" })
    assert.equal(timed.status, "running")
    assert.deepEqual(router.list("default", "one")[0], { ...first, cwd: "new", status: "idle" })
    const polled = await router.input("default", "one", first.id, "", "poll", signal)
    assert.equal(polled.output, "late")
    assert.equal(polled.status, "idle")
    assert.equal((await router.input("default", "one", first.id, "", "poll2", signal)).output, "")

    const controller = new AbortController()
    const cancelled = router.input("default", "one", first.id, "long\r", "cancel", controller.signal)
    child.receive({ type: "start", run: 2 })
    child.receive({ type: "data", data: "unreturned" })
    controller.abort()
    await assert.rejects(() => cancelled, /取消/)
    router.interrupt("default", "one")
    assert.equal(child.input.at(-1), "\x03")
    assert.equal(router.list("default", "one")[0].status, "running")
    child.receive({ type: "done", run: 1, cwd: "wrong" })
    assert.equal(router.list("default", "one")[0].status, "running")
    child.receive({ type: "done", run: 2, cwd: directory })
    assert.equal(router.list("default", "one")[0].status, "idle")
    assert.equal((await router.input("default", "one", first.id, "", "recover", signal)).output, "unreturned")
    child.receive({ type: "data", data: "x".repeat(100000) })
    const big = await router.input("default", "one", first.id, "", "big", signal)
    assert.equal((await readFile(big.fullOutputPath!)).length, 100000)
    child.receive({ type: "data", data: "tail" })
    child.receive({ type: "exit" })
    assert.deepEqual(router.list("default", "one"), [])
    await assert.rejects(() => router.input("default", "one", first.id, "x", "exited", signal), /退出/)
    const exited = await router.input("default", "one", first.id, "", "drain", signal)
    assert.equal(exited.output, "tail"); assert.equal(exited.status, "unknown")
    assert.equal((await readFile(big.fullOutputPath!)).length, 100000)
    const second = await router.open("default", "one", directory, directory, signal)
    const other = await router.open("default", "two", directory, directory, signal)
    await assert.rejects(() => router.input("default", "two", second.id, "", "cross", signal), /未找到/)
    router.interrupt("default", "one")
    assert.deepEqual(backend.children[2].input, [])
    const closing = router.input("default", "one", second.id, "waiting\r", "closing", signal)
    backend.children[1].receive({ type: "start", run: 1 })
    const closingResult = assert.rejects(() => closing, /关闭/)
    await router.close("default", "one", second.id)
    await closingResult
    backend.children[1].receive({ type: "done", run: 0, cwd: directory })
    assert.deepEqual(router.list("default", "one"), [])
    assert.equal(router.list("default", "two")[0].id, other.id)

    const tools = new ToolRegistry(), renders = new RenderRegistry()
    let approvals = 0
    registerTerminalTools(tools, renders, router, () => ({ sandboxMode: "sandbox-full-access", cwd: directory }))
    for (const name of ["terminal_open", "terminal_input"]) {
      assert.ok(tools.listDefinitions().find((tool) => tool.name === name)?.description?.includes(`Current platform: ${process.platform}. Use PowerShell 7 syntax`))
    }
    const execute = createExecuteToolCall(tools, renders)
    const context: ToolCallContext = { turn: 1, step: 1, blockId: "block", toolCallId: "tool", signal,
      processRuntime: { projectId: "default", sessionId: "two", outputDirectory: directory, requestApproval: async () => { approvals++; return "denied" } } }
    assert.equal((await execute("terminal_list", {}, context)).status, "success")
    assert.equal(approvals, 0)
    assert.equal((await execute("terminal_input", { terminalId: other.id, input: "" }, context)).status, "error")
    assert.equal(approvals, 1)
    assert.equal((await execute("terminal_open", { cwd: directory }, context)).status, "error")
    assert.equal((await execute("terminal_open", { constructor: "unexpected" }, context)).status, "error")
    let startupDisposals = 0
    const silent: PtyBackend = { spawn: () => ({ write: () => {}, dispose: async () => { startupDisposals++ } }) }
    const opening = new TerminalRouter(silent, 20, 5)
    await assert.rejects(() => opening.open("default", "startup", directory, directory, signal), /报告就绪/)
    assert.equal(startupDisposals, 1)
    assert.deepEqual(opening.list("default", "startup"), [])
    const openingController = new AbortController()
    const cancelledOpen = opening.open("default", "startup", directory, directory, openingController.signal)
    const rejectedOpen = assert.rejects(() => cancelledOpen, /取消/)
    openingController.abort()
    await rejectedOpen
    assert.equal(startupDisposals, 2)
    await opening.dispose()
  } finally { await router.dispose(); await rm(directory, { recursive: true, force: true }) }
  console.log("terminal tools tests passed")
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
