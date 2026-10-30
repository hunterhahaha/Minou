/** 六个文件工具、权限与 render 的本机离线测试。 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TurnFileChangeTracker } from "../../session/src/file-changes.ts"
import type { SandboxMode } from "../../session/src/session-state.ts"
import { bundledRipgrepPath, runRipgrep } from "../src/filesystem/index.ts"
import { registerFileTools, type FileAccessState } from "../src/file/index.ts"
import { createExecuteToolCall } from "../src/tool-executor.ts"
import { RenderRegistry, ToolRegistry } from "../src/tool-registry.ts"
import type { ToolCallContext, ToolResult } from "../src/types.ts"

/**
 * 断言首个结果块为文本，并读取其模型可见内容。
 * @param result 工具结果。
 * @returns 首个模型可见文本。
 */
function content(result: ToolResult): string {
  const first = result.content[0]
  assert.equal(first.type, "text")
  return first.text
}

/**
 * 读取失败结果的错误码，成功结果返回 undefined。
 * @param result 工具结果。
 * @returns 错误码或 undefined。
 */
function code(result: ToolResult): string | undefined {
  return result.status === "error" ? result.error.code : undefined
}

/**
 * 按顺序执行当前文件的断言和已有资源清理流程。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-file-tools-"))
  try {
    const workspace = join(root, "workspace")
    const outside = join(root, "outside")
    await mkdir(workspace)
    await mkdir(outside)
    const sample = join(workspace, "sample.ts")
    const other = join(outside, "other.ts")
    await writeFile(sample, "alpha\nbeta\nalpha\n")
    await writeFile(other, "outside\n")
    let mode: SandboxMode = "sandbox-full-access"
    let roots = [workspace]
    let reads = 0
    let tightenAfterLoad = false
    let approval: "approved" | "denied" | "cancelled" = "denied"
    let approvalCalls = 0
    const tracker = new TurnFileChangeTracker()
    const tools = new ToolRegistry()
    const renders = new RenderRegistry()
    const rgPath = bundledRipgrepPath(process.cwd())
    registerFileTools(tools, renders, { rgPath, loadAccess: () => {
      reads += 1
      const state = { sandboxMode: mode, roots: [...roots] } satisfies FileAccessState
      if (tightenAfterLoad) { mode = "sandbox-full-access"; tightenAfterLoad = false }
      return state
    } })
    const execute = createExecuteToolCall(tools, renders)
    const context: ToolCallContext = {
      turn: 1, step: 1, blockId: "block", toolCallId: "call", toolCallEventId: "event",
      signal: new AbortController().signal,
      fileRuntime: {
        projectId: "default", sessionId: "session", tracker,
        requestApproval: async () => { approvalCalls += 1; return approval },
      },
    }

    assert.equal(code(await execute("read", { path: "relative.ts" }, context)), "ABSOLUTE_PATH_REQUIRED")
    const firstRead = await execute("read", { path: sample, offset: 2, limit: 1 }, context)
    assert.equal(firstRead.status, "success")
    assert.match(content(firstRead), /2 \| beta/)
    assert.match(content(firstRead), /offset=3/)
    assert.equal(code(await execute("read", { path: other }, context)), "APPROVAL_DENIED")
    assert.equal(approvalCalls, 1)
    mode = "full-access"
    tightenAfterLoad = true
    assert.equal(code(await execute("read", { path: other }, context)), "APPROVAL_DENIED")
    assert.equal(approvalCalls, 2, "权限在同一调用的第二次数据库读取变严时必须审批")
    roots = [workspace, outside]
    assert.equal((await execute("read", { path: other }, context)).status, "success")
    const beforeParallel = reads
    const parallel = await Promise.all([
      execute("read", { path: sample }, context),
      execute("read", { path: other }, context),
    ])
    assert.ok(parallel.every((result) => result.status === "success"))
    assert.equal(reads - beforeParallel, 4, "并发工具各自在执行函数内重读两次权限")
    assert.ok(reads >= 4)
    mode = "sandbox-read-only"
    assert.equal(code(await execute("write", { path: sample, content: "changed" }, context)), "APPROVAL_DENIED")
    assert.equal(await readFile(sample, "utf8"), "alpha\nbeta\nalpha\n")
    approval = "approved"
    const created = join(workspace, "nested", "created.ts")
    assert.equal((await execute("write", { path: created, content: "first\n" }, context)).status, "success")
    assert.equal(await readFile(created, "utf8"), "first\n")
    mode = "sandbox-full-access"
    assert.equal(code(await execute("edit", { path: sample, oldText: "alpha", newText: "x" }, context)), "AMBIGUOUS_MATCH")
    assert.equal(code(await execute("edit", { path: sample, oldText: "missing", newText: "x" }, context)), "MATCH_NOT_FOUND")
    assert.equal((await execute("edit", { path: created, oldText: "first", newText: "second" }, context)).status, "success")
    assert.equal((await execute("write", { path: created, content: "third\n" }, context)).status, "success")
    const presented = await execute("present", { files: [
      { path: "relative.ts", description: "bad" },
      { path: sample, description: "not tracked" },
      { path: created },
      { path: created, description: "Created a file" },
      { path: created, description: "Final description" },
    ] }, context)
    assert.equal(presented.status, "success")
    assert.match(content(presented), /已展示 1 个文件/)
    const changes = tracker.summarize()
    assert.equal(changes.length, 1)
    assert.equal(changes[0].changeType, "created")
    assert.equal(changes[0].description, "Final description")
    assert.equal(changes[0].stats.additions, 1)

    const glob = await execute("glob", { path: workspace, pattern: "*.ts", limit: 1 }, context)
    assert.equal(glob.status, "success", content(glob))
    assert.match(content(glob), /Results truncated/)
    const grep = await execute("grep", { path: workspace, pattern: "alpha", context: 1, limit: 1 }, context)
    assert.equal(grep.status, "success", content(grep))
    assert.match(content(grep), /sample\.ts/)
    assert.match(content(grep), /Results truncated/)
    assert.equal(content(await execute("grep", { path: workspace, pattern: "no-match" }, context)), "No matches found.")

    const cancelling = new AbortController()
    await assert.rejects(runRipgrep(rgPath, ["--files", "--", workspace], cancelling.signal, () => {
      cancelling.abort()
      return true
    }), { name: "AbortError" })

    try {
      await symlink(outside, join(workspace, "escape"), "junction")
      mode = "sandbox-full-access"
      roots = [workspace]
      approval = "denied"
      assert.equal(code(await execute("read", { path: join(workspace, "escape", "other.ts") }, context)), "APPROVAL_DENIED")
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error
    }
    console.log("file-tools.test.ts: 文件工具、权限与 render 断言通过")
  } finally { await rm(root, { recursive: true, force: true }) }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
