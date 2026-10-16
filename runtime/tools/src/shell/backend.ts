import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"
import { ToolOutputStore } from "../process/output-store.ts"
import { processException } from "../process/access.ts"
import type { ShellResult } from "./types.ts"

/**
 * 请求终止仍在运行的子进程；Windows 使用隐藏的 taskkill 辅助进程请求结束进程树，启动错误时回退到 child.kill。此处不检查 taskkill 退出码，最终流关闭由执行方法等待。
 *
 * @param child - 本次 Shell 调用创建的子进程对象。
 * @returns 终止请求处理完成时兑现的 Promise；没有 PID 或已取得退出码时直接完成。
 * @throws Error - 创建辅助进程或发出终止请求时出现同步异常；调用方负责处理终止失败。
 */
export async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform !== "win32") { child.kill("SIGKILL"); return }
  await new Promise<void>((resolve) => {
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    killer.once("error", () => { child.kill(); resolve() })
    killer.once("close", () => resolve())
  })
}
/** Windows V1 pwsh 后端，收集一次性进程的 stdout/stderr。 */
export class PwshShellBackend {
  private readonly executable: string
  private readonly processes = new Map<ChildProcess, { cancel: () => void; done: Promise<void> }>()
  /**
   * 绑定一次性 Shell 使用的可执行文件，构造时不创建进程。
   *
   * @param executable - PowerShell 7 可执行文件名或路径，默认使用 pwsh。
   */
  constructor(executable = "pwsh") { this.executable = executable }

  /**
   * 以一次性 PowerShell 进程运行命令，按接收顺序合并 stdout/stderr，等待流关闭后发布本次输出。取消时请求终止进程树；无论成功或失败均释放本次缓冲资源。
   *
   * @param command - 原始 PowerShell 命令，通过 UTF-16LE EncodedCommand 参数传递。
   * @param cwd - Runtime 为本次新进程解析的工作目录。
   * @param directory - 已初始化的 Session 工具输出绝对目录。
   * @param callId - 发布完整大输出日志时使用的工具调用 ID。
   * @param signal - 本次命令的取消信号，取消后返回取消异常而不交付部分输出。
   * @returns 本次命令输出和实际退出码；非零退出码仍是正常命令结果。
   * @throws Error - 启动、输出初始化或保存、取消、清理失败，或没有退出码；登记的工具负责转换为 AppError。
   */
  async execute(command: string, cwd: string, directory: string, callId: string, signal: AbortSignal): Promise<ShellResult> {
    if (signal.aborted) throw processException("CANCELLED", "工具调用已取消")
    const output = new ToolOutputStore(directory)
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;\n" + command
    const child = spawn(this.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let failure: unknown
    let termination: Promise<void> | undefined
    const kill = () => { termination ??= terminateProcess(child) }
    const append = (chunk: Buffer) => { try { if (failure === undefined) output.append(chunk) } catch (error) { failure = processException("OUTPUT_WRITE_FAILED", String(error)); kill() } }
    child.stdout!.on("data", append)
    child.stderr!.on("data", append)
    const abort = () => { failure = processException("CANCELLED", "工具调用已取消"); kill() }
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    this.processes.set(child, { cancel: abort, done })
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("error", (error) => { failure = processException("SHELL_START_FAILED", error.message) })
        child.once("close", (code) => resolve(code))
      })
      await termination
      if (signal.aborted) throw processException("CANCELLED", "工具调用已取消")
      if (failure !== undefined) throw failure
      if (exitCode === null) throw processException("SHELL_EXIT_FAILED", "Shell 进程没有返回退出码")
      return { ...output.finish(callId), exitCode }
    } finally {
      signal.removeEventListener("abort", abort)
      this.processes.delete(child)
      try { output.discard() } finally { resolveDone() }
    }
  }
  /**
   * 主动取消此后端仍在执行的全部命令，等待其进程退出和输出资源释放，不依赖用户取消信号。
   *
   * @returns 所有被取消命令的资源释放完成时兑现的 Promise。
   */
  async dispose(): Promise<void> {
    const active = [...this.processes.values()]
    for (const entry of active) entry.cancel()
    await Promise.all(active.map((entry) => entry.done))
  }
}
/** V1 Shell 路由仅绑定 pwsh，不接受模型侧后端选择。 */
export class ShellRouter extends PwshShellBackend {}
