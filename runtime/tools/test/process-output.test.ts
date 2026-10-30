import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolOutputStore, PROCESS_OUTPUT_LIMIT } from "../src/process/output-store.ts"
import { renderShell, renderTerminalInput } from "../src/render/process.ts"

/**
 * 运行本文件的离线断言或本机临时进程验证，并在结束时释放测试资源。
 * @returns 本文件全部验证和资源清理完成时兑现的 Promise。
 * @throws Error - 断言、临时存储或本机后端验证失败；顶层测试出口记录异常并设置失败退出码。
 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-output-"))
  try {
    const empty = new ToolOutputStore(directory).finish("empty")
    assert.deepEqual(empty, { output: "", totalBytes: 0, truncated: false })
    assert.match(JSON.stringify(renderShell({ ...empty, exitCode: 1 })), /Exit code: 1/)
    const exact = new ToolOutputStore(directory)
    exact.append(Buffer.alloc(PROCESS_OUTPUT_LIMIT, 97))
    assert.equal(exact.finish("exact").truncated, false)
    assert.deepEqual(await readdir(directory), [])
    const bytes = Buffer.from("甲".repeat(30000))
    const large = new ToolOutputStore(directory)
    large.append(bytes.subarray(0, 1001))
    large.append(bytes.subarray(1001, 66000))
    large.append(bytes.subarray(66000))
    const result = large.finish("large")
    assert.equal(result.totalBytes, bytes.length)
    assert.equal(result.truncated, true)
    assert.ok(Buffer.byteLength(result.output) <= PROCESS_OUTPUT_LIMIT)
    assert.equal(result.output.includes("\ufffd"), false)
    assert.deepEqual(await readFile(result.fullOutputPath!), bytes)
    assert.throws(() => large.append("late"), /已经结束/)
    const before = await readFile(result.fullOutputPath!)
    const next = new ToolOutputStore(directory)
    next.append("late")
    assert.equal(next.finish("next").output, "late")
    assert.deepEqual(await readFile(result.fullOutputPath!), before)
    const collision = new ToolOutputStore(directory)
    collision.append(bytes)
    assert.throws(() => collision.finish("large"), /exist|EEXIST/)
    collision.discard()
    assert.deepEqual(await readFile(result.fullOutputPath!), before)
    assert.throws(() => new ToolOutputStore(directory).finish("../escape"), /ID/)
    const abandoned = new ToolOutputStore(directory)
    abandoned.append(bytes)
    abandoned.discard()
    assert.deepEqual(await readdir(directory), ["call_large.log"])
    const rendered = JSON.stringify(renderTerminalInput({ ...result, terminalId: "term", status: "running" }))
    assert.match(rendered, /Status: running/)
    assert.match(rendered, /showing last 64 KB/)
    assert.match(rendered, /Full output saved to/)
    assert.deepEqual(renderShell({ source: "tool", code: "CANCELLED", message: "cancelled" }).content, [{ type: "text", text: "CANCELLED: cancelled" }])
  } finally { await rm(directory, { recursive: true, force: true }) }
  console.log("process output tests passed")
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
