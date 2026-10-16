/** 隐藏 Electron 主进程的原生 PTY/真实 Shell 兼容性测试，只使用临时数据。 */
const { app } = require('electron')
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { TerminalRouter, ShellRouter } = require('../../dist/runtime/tools/src/index.js')

/**
 * 运行本文件的离线断言或本机临时进程验证，并在结束时释放测试资源。
 *
 * @returns 本文件全部验证和资源清理完成时兑现的 Promise。
 * @throws Error - 断言、临时存储或本机后端验证失败；顶层测试出口记录异常并设置失败退出码。
 */
async function main() {
  await app.whenReady()
  const directory = await mkdtemp(join(tmpdir(), 'nicode-electron-process-'))
  const terminals = new TerminalRouter(), shells = new ShellRouter()
  const signal = new AbortController().signal
  try {
    const shell = await shells.execute("[Console]::Write('ELECTRON_SHELL'); exit 5", directory, directory, 'shell', signal)
    assert.equal(shell.exitCode, 5)
    assert.equal(shell.output, 'ELECTRON_SHELL')
    const terminal = await terminals.open('default', 'electron', directory, directory, signal)
    assert.equal(terminal.status, 'idle')
    const result = await terminals.input('default', 'electron', terminal.id, "[Console]::WriteLine('ELECTRON_PTY')\r", 'pty', signal)
    assert.equal(result.status, 'idle')
    let output = result.output
    for (let attempt = 0; attempt < 20 && !output.includes('ELECTRON_PTY'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      output += (await terminals.input('default', 'electron', terminal.id, '', `late-${attempt}`, signal)).output
    }
    assert.ok(output.includes('ELECTRON_PTY'))
    const long = await terminals.input('default', 'electron', terminal.id, 'Start-Sleep -Seconds 30\r', 'long', signal)
    assert.equal(long.status, 'running')
    terminals.interrupt('default', 'electron')
    const stopped = await terminals.input('default', 'electron', terminal.id, '', 'stop', signal)
    assert.equal(stopped.status, 'idle')
    await terminals.close('default', 'electron', terminal.id)
    console.log('Electron process tools tests passed')
  } finally { await Promise.all([terminals.dispose(), shells.dispose()]); await rm(directory, { recursive: true, force: true }) }
}
main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
