import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TerminalRouter } from "../src/terminal/router.ts"
import { PwshPtyBackend } from "../src/terminal/backend.ts"

/**
 * 运行本文件的离线断言或本机临时进程验证，并在结束时释放测试资源。
 * @returns 本文件全部验证和资源清理完成时兑现的 Promise。
 * @throws Error - 断言、临时存储或本机后端验证失败；顶层测试出口记录异常并设置失败退出码。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "minou-pty-real-"))
  const router = new TerminalRouter()
  const signal = new AbortController().signal
  try {
    const missing = join(directory, "missing-pwsh")
    const unavailable = new TerminalRouter(new PwshPtyBackend(missing))
    try {
      await assert.rejects(() => unavailable.open("default", "missing", directory, directory, signal), (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "TERMINAL_START_FAILED" && error.message.includes(missing))
    } finally { await unavailable.dispose() }
    const terminal = await router.open("default", "one", directory, directory, signal)
    assert.equal(terminal.status, "idle")
    const result = await router.input("default", "one", terminal.id, "[Console]::WriteLine('PTY_OK_你好|' + $PSVersionTable.PSVersion.Major + '|' + $PSHOME + '|')\r", "first", signal)
    assert.equal(result.status, "idle")
    let initialOutput = result.output
    const host = /PTY_OK_你好\|7\|([^|\r\n]+)\|/
    for (let attempt = 0; attempt < 20 && !host.test(initialOutput); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      initialOutput += (await router.input("default", "one", terminal.id, "", `initial-late-${attempt}`, signal)).output
    }
    const home = host.exec(initialOutput)?.[1]
    assert.ok(home, JSON.stringify(initialOutput))
    assert.equal(await realpath(home), await realpath("resources/powershell"))
    assert.equal(result.output.includes("Minou;"), false)
    const childDirectory = join(directory, "cwd-test")
    await mkdir(childDirectory)
    const moved = await router.input("default", "one", terminal.id, `Set-Location -LiteralPath '${childDirectory.replaceAll("'", "''")}'\r`, "move", signal)
    assert.equal(moved.status, "idle")
    assert.equal((await realpath(router.list("default", "one")[0].cwd)).toLowerCase(), (await realpath(childDirectory)).toLowerCase())
    const long = await router.input("default", "one", terminal.id, "Start-Sleep -Seconds 30\r", "long", signal)
    assert.equal(long.status, "running")
    router.interrupt("default", "one")
    const stopped = await router.input("default", "one", terminal.id, "", "stopped", signal)
    assert.equal(stopped.status, "idle")
    assert.equal(router.list("default", "one")[0].status, "idle")
    const reused = await router.input("default", "one", terminal.id, "[Console]::WriteLine('REUSED')\r", "reuse", signal)
    assert.equal(reused.status, "idle")
    let received = reused.output
    for (let attempt = 0; attempt < 20 && !received.includes("REUSED"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      received += (await router.input("default", "one", terminal.id, "", `late-${attempt}`, signal)).output
    }
    assert.ok(received.includes("REUSED"), JSON.stringify(received))
    await router.close("default", "one", terminal.id)
    const exiting = await router.open("default", "natural-exit", directory, directory, signal)
    const exitResult = await router.input("default", "natural-exit", exiting.id, "exit\r", "natural-exit", signal)
    assert.equal(exitResult.status, "unknown")
    assert.deepEqual(router.list("default", "natural-exit"), [])
  } finally { await router.dispose(); await rm(directory, { recursive: true, force: true }) }
  console.log("real PTY tests passed")
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
