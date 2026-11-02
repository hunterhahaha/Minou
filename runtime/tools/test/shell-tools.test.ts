import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecuteToolCall, ToolRegistry, RenderRegistry, ShellRouter, registerShellTools } from "../src/index.ts"
import type { ToolCallContext } from "../src/types.ts"

/**
 * 运行本文件的离线断言或本机临时进程验证，并在结束时释放测试资源。
 * @returns 本文件全部验证和资源清理完成时兑现的 Promise。
 * @throws Error - 断言、临时存储或本机后端验证失败；顶层测试出口记录异常并设置失败退出码。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-shell-"))
  const router = new ShellRouter()
  try {
    const signal = new AbortController().signal
    const mixed = await router.execute("[Console]::Out.Write('你好'); [Console]::Error.Write('error'); exit 7", directory, directory, "mixed", signal)
    assert.equal(mixed.exitCode, 7)
    assert.ok(mixed.output.includes("你好") && mixed.output.includes("error"))
    assert.equal(mixed.totalBytes, Buffer.byteLength(mixed.output))
    const cwd = await router.execute("[Console]::Write((Get-Location).Path)", directory, directory, "cwd", signal)
    assert.equal((await realpath(cwd.output)).toLowerCase(), (await realpath(directory)).toLowerCase())
    const empty = await router.execute("exit 0", directory, directory, "empty", signal)
    assert.equal(empty.output, "")
    const large = await router.execute("[Console]::Write(('x' * 100000))", directory, directory, "large", signal)
    assert.equal(large.totalBytes, 100000)
    assert.equal((await readFile(large.fullOutputPath!)).length, 100000)
    await assert.rejects(() => new ShellRouter("missing-pwsh-nicode").execute("x", directory, directory, "bad", signal), /ENOENT|spawn/)
    const controller = new AbortController()
    const stopped = router.execute("[Console]::Write('partial'); Start-Sleep -Seconds 30", directory, directory, "stop", controller.signal)
    setTimeout(() => controller.abort(), 300)
    await assert.rejects(() => stopped, (error: unknown) => error instanceof Error && "code" in error && error.code === "CANCELLED")
    const shutdown = router.execute("Start-Sleep -Seconds 30", directory, directory, "shutdown", signal)
    const shutdownResult = assert.rejects(() => shutdown, (error: unknown) => error instanceof Error && "code" in error && error.code === "CANCELLED")
    await router.dispose()
    await shutdownResult
    assert.equal(signal.aborted, false, "应用清理必须主动取消命令，不依赖用户 Stop 信号")

    const tools = new ToolRegistry(), renders = new RenderRegistry()
    let approval = "denied" as "approved" | "denied" | "cancelled"
    let approvals = 0
    registerShellTools(tools, renders, router, () => ({ sandboxMode: "sandbox-read-only", cwd: directory }))
    const execute = createExecuteToolCall(tools, renders)
    const context: ToolCallContext = { turn: 1, step: 1, blockId: "block", toolCallId: "call", signal,
      processRuntime: { projectId: "default", sessionId: "session", outputDirectory: directory, requestApproval: async () => { approvals++; return approval } } }
    const invalid = await execute("shell", { command: "exit 0", cwd: directory }, context)
    assert.equal(invalid.status, "error")
    assert.equal(approvals, 0)
    const denied = await execute("shell", { command: "[Console]::Write('must not run')" }, context)
    assert.equal(denied.status, "error")
    if (denied.status === "error") assert.equal(denied.error.code, "APPROVAL_DENIED")
    assert.equal(JSON.stringify(denied.content).includes("must not run"), false)
    approval = "approved"
    const success = await execute("shell", { command: "exit 9" }, context)
    assert.equal(success.status, "success")
    assert.match(JSON.stringify(success.content), /Exit code: 9/)
    approval = "cancelled"
    const cancelled = await execute("shell", { command: "exit 0" }, context)
    if (cancelled.status === "error") assert.equal(cancelled.error.code, "CANCELLED"); else assert.fail("expected cancelled")
  } finally { await router.dispose(); await rm(directory, { recursive: true, force: true }) }
  console.log("shell tools tests passed")
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
