import { createRequire } from "node:module"
import type { IPty } from "node-pty"
import { resolvePwsh } from "../process/pwsh.ts"

/** 后端只报告真实输出和明确的生命周期标记。 */
export type PtyEvent =
  | { type: "data"; data: string }
  | { type: "start"; run: number }
  | { type: "done"; run: number; cwd: string }
  | { type: "exit" }

/** 单个本机 PTY 进程句柄。 */
export interface PtyProcess {
  /**
   * 向已创建的本机 PTY 原样发送字符，不自动追加回车。
   * @param input - 需要发送的命令、交互文本或控制字符。
   * @throws Error - 本机 PTY 输入写入失败；路由负责转换为工具错误。
   */
  write(input: string): void
  /**
   * 终止本机终端并等待退出，释放输出和退出事件的监听；关闭期间不再报告业务事件。
   * @returns 进程退出和监听资源释放完成时兑现的 Promise。
   * @throws Error - 本机进程关闭失败；路由或宿主负责报告清理异常。
   */
  dispose(): Promise<void>
}
/** 终端路由与本机 PTY 的具体模块边界，也允许测试用可控进程。 */
export interface PtyBackend {
  /**
   * 创建一个本机 PTY 并接入持续事件出口；首次就绪等待和 Session 归属由 TerminalRouter 管理。
   * @param cwd - Runtime 解析的终端初始工作目录。
   * @param nonce - 此终端独占的随机内部标记身份。
   * @param receive - 持续接收输出、命令开始/完成标记及退出事件的回调。
   * @returns 可以原样写入并显式清理的终端进程句柄。
   * @throws Error - 后端加载或本机进程创建失败；路由负责将失败交给工具边界。
   */
  spawn(cwd: string, nonce: string, receive: (event: PtyEvent) => void): PtyProcess
}

/** 支持跨数据块的内部 OSC 标记解析器，只删除本终端匹配的协议。 */
export class PtyMarkerParser {
  private readonly receive: (event: PtyEvent) => void
  private buffer = ""
  private readonly prefix: string
  /**
   * 构造本终端的内部标记前缀并绑定事件出口；不读取或创建进程。
   * @param nonce - 此终端内部标记使用的随机身份。
   * @param receive - 按接收顺序处理可见文本和解析后标记的回调。
   */
  constructor(nonce: string, receive: (event: PtyEvent) => void) { this.prefix = `\x1b]633;NiCode;${nonce};`; this.receive = receive }

  /**
   * 解析本次字符串数据，保留跨块未完整标记；仅删除符合本终端身份和结构的内部标记，无效标记仍作为业务输出交付。
   * @param text - PTY 本次收到的已解码字符串数据。
   * @throws receive 回调抛出异常时原样传播；后端与路由负责保持事件出口的错误边界。
   */
  push(text: string): void {
    this.buffer += text
    while (this.buffer.length > 0) {
      const start = this.buffer.indexOf(this.prefix)
      if (start < 0) {
        let keep = Math.min(this.buffer.length, this.prefix.length - 1)
        while (keep > 0 && !this.buffer.endsWith(this.prefix.slice(0, keep))) keep--
        const visible = this.buffer.slice(0, this.buffer.length - keep)
        if (visible) this.receive({ type: "data", data: visible })
        this.buffer = this.buffer.slice(this.buffer.length - keep)
        return
      }
      if (start > 0) { this.receive({ type: "data", data: this.buffer.slice(0, start) }); this.buffer = this.buffer.slice(start) }
      const end = this.buffer.indexOf("\x07", this.prefix.length)
      if (end < 0 && this.buffer.length <= 16384) return
      if (end < 0) { this.receive({ type: "data", data: this.buffer[0] }); this.buffer = this.buffer.slice(1); continue }
      const token = this.buffer.slice(this.prefix.length, end).split(";")
      const run = Number(token[1])
      if (Number.isSafeInteger(run) && run >= 0 && token.length === 2 && token[0] === "S") this.receive({ type: "start", run })
      else if (Number.isSafeInteger(run) && run >= 0 && token.length === 3 && token[0] === "D" && /^[A-Za-z0-9+/]*={0,2}$/.test(token[2])) {
        this.receive({ type: "done", run, cwd: Buffer.from(token[2], "base64").toString("utf8") })
      } else this.receive({ type: "data", data: this.buffer.slice(0, end + 1) })
      this.buffer = this.buffer.slice(end + 1)
    }
  }
  /**
   * 进程退出时把无法组成完整标记的剩余字符串作为业务输出交付，并清空解析缓冲。
   * @throws receive 回调抛出异常时原样传播；事件出口负责处理。
   */
  end(): void { if (this.buffer) this.receive({ type: "data", data: this.buffer }); this.buffer = "" }
}

/**
 * PowerShell 7 的真实 ConPTY 后端。PSConsoleHostReadLine 接受一条命令后报告开始，
 * prompt 报告相同执行序号的完成；交互程序绕过 ReadLine，不制造新命令标记。
 */
export class PwshPtyBackend implements PtyBackend {
  private readonly executable: string
  /**
   * 绑定 PowerShell 7 后端的可执行文件名或路径，构造时不加载 node-pty 或创建终端。
   * @param executable - PowerShell 7 可执行文件名或路径，默认使用 pwsh。
   */
  constructor(executable = "pwsh") { this.executable = executable }
  /**
   * 加载真实 node-pty 后端并启动持久 PowerShell，注入随机身份和执行序号标记，挂接跨块解析与退出监听。该方法返回句柄，不等待首次就绪标记。
   * @param cwd - 本次新终端的初始工作目录。
   * @param nonce - 注入 PowerShell 并用于过滤内部协议的随机终端身份。
   * @param receive - 接收可见输出、明确命令状态标记和自然退出事件的持续回调。
   * @returns 已接入监听的 PTY 句柄；调用方通过 dispose 结束进程并释放监听。
   * @throws Error - PowerShell 路径解析、node-pty 加载或进程创建失败；TerminalRouter 负责处理启动失败和就绪超时。
   */
  spawn(cwd: string, nonce: string, receive: (event: PtyEvent) => void): PtyProcess {
    const script = `
$ErrorActionPreference = 'Stop'
Import-Module PSReadLine
Set-PSReadLineOption -HistorySaveStyle SaveNothing -PredictionSource None
$global:NiCodeRun = 0
$global:NiCodePrefix = [char]27 + ']633;NiCode;${nonce};'
function global:PSConsoleHostReadLine {
  $lastRunStatus = $?
  Microsoft.PowerShell.Core\\Set-StrictMode -Off
  $line = [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($host.Runspace, $ExecutionContext, $lastRunStatus)
  if (-not [string]::IsNullOrWhiteSpace($line)) {
    $global:NiCodeRun++
    [Console]::Write($global:NiCodePrefix + 'S;' + $global:NiCodeRun + [char]7)
  }
  return $line
}
function global:prompt {
  $path = $ExecutionContext.SessionState.Path.CurrentLocation.Path
  $encodedPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))
  [Console]::Write($global:NiCodePrefix + 'D;' + $global:NiCodeRun + ';' + $encodedPath + [char]7)
  return 'PS> '
}
$ErrorActionPreference = 'Continue'
`
    const require = createRequire(typeof __filename === "string" ? __filename : `${process.cwd()}/package.json`)
    const pty = require("node-pty") as { spawn(file: string, args: string[], options: object): IPty }
    const child = pty.spawn(resolvePwsh(this.executable), ["-NoLogo", "-NoProfile", "-NoExit", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd, cols: 120, rows: 30, name: "xterm-256color", env: { ...process.env, TERM: "xterm-256color" } })
    let disposed = false
    let resolveExit!: () => void
    const exitedPromise = new Promise<void>((resolve) => { resolveExit = resolve })
    const parser = new PtyMarkerParser(nonce, (event) => { if (!disposed) receive(event) })
    const data = child.onData((text) => parser.push(text))
    const exit = child.onExit(() => { resolveExit(); if (!disposed) { parser.end(); receive({ type: "exit" }) } })
    return {
      write: (input) => child.write(input),
      dispose: async () => {
        if (disposed) { await exitedPromise; return }
        disposed = true
        data.dispose()
        /** node-pty 的系统 ConPTY 路径在自然退出后仍需 kill 释放输出辅助线程。 */
        try { child.kill(); await exitedPromise } finally { exit.dispose() }
      },
    }
  }
}
