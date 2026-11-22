import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { loadFileAccessState } from "../../../src/main/file-access.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import type { ModelRef } from "../../model/src/types.ts"
import type { SessionEvent, SessionEventInput } from "../../session/src/events.ts"
import { registerFileTools } from "../../tools/src/file/index.ts"
import { bundledRipgrepPath, canonicalPath } from "../../tools/src/filesystem/index.ts"
import { pathPermission, type PathPermission } from "../../tools/src/security/permissions.ts"
import { authorizeSandboxedProcess } from "../../tools/src/process/access.ts"
import type { ToolExecutionContext } from "../../tools/src/types.ts"
import { RenderRegistry, ToolRegistry } from "../../tools/src/tool-registry.ts"
import { SessionRuntime } from "../src/session-runtime.ts"

const model: ModelRef = { providerId: "p", protocol: "responses", modelId: "m", name: "Model", reasoningLevel: "high" }

/**
 * 验证受阻模式通过显式多项审批持久化授权，并在会话重新打开后使用已批准路径。
 * @returns 断言和临时资源清理完成后解析。
 * @throws Error 审批、事件、持久化或工具状态不符合预期。
 */
async function main(): Promise<void> {
  const tmp = await realpath(tmpdir())
  const root = await mkdtemp(join(tmp, "minou-sandbox-"))
  const paths = await initializeConfigFiles(root)
  const workspace = join(paths.rootDir, "sessions", "default", "workspace")
  const blocked = join(root, "blocked.txt")
  const readable = join(root, "readable.txt")
  const writableWorkspace = join(workspace, "output.txt")
  const grants = { path: { read: [readable, blocked], write: [workspace] }, network: true }
  const calls = [
    { name: "read", arguments: { path: readable } },
    { name: "write", arguments: { path: writableWorkspace, content: "read-only" } },
    { name: "shell", arguments: { command: "exit 3" } },
    { name: "shell", arguments: { command: "exit 4", mode: "temporary", permissions: grants } },
    { name: "request_permissions", arguments: grants },
    { name: "read", arguments: { path: readable } },
    { name: "read", arguments: { path: blocked } },
    { name: "write", arguments: { path: writableWorkspace, content: "granted" } },
    { name: "shell", arguments: { command: "exit 5", mode: "unrestricted" } },
    { name: "read", arguments: { path: blocked, mode: "temporary", permissions: grants } },
  ]
  const tools = new ToolRegistry()
  const renders = new RenderRegistry()
  const loadAccess = (projectId: string, sessionId: string) => loadFileAccessState(paths, projectId, sessionId)
  registerFileTools(tools, renders, { rgPath: bundledRipgrepPath(process.cwd()), loadAccess, sandbox: null })
  const global = new SessionRuntimeGlobal(paths, tools, renders, null)
  const terminalInput = tools.listDefinitions().find(({ name }) => name === "terminal_input")
  assert.deepEqual(Object.keys((terminalInput?.inputSchema as { properties: object }).properties), ["terminalId", "input"])
  let activeCalls = calls
  global.createTurnModelAdapter = async () => {
    let step = 0
    return { contextWindow: 128_000, maxOutputTokens: 4096, reasoningLevels: ["none", "high"], stream: async function* () {
      if (step++ === 0) {
        for (const [index, call] of activeCalls.entries()) {
          yield { type: "block_start", index, blockType: "tool_call" }
          yield { type: "block_end", index, block: { type: "tool_call", toolCallId: "call-" + index, ...call } }
        }
        yield { type: "stream_end", completion: "tool_calls" }
      } else yield { type: "stream_end", completion: "finished" }
    } }
  }
  const sessionId = "permission-session"
  const createRuntime = () => new SessionRuntime({
    sessionId, projectGroupId: "default", sessionDirectory: join(paths.rootDir, "sessions", "default", sessionId),
    databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath,
    global, systemPrompt: "test",
  })
  const runtime = createRuntime()
  let resumed: SessionRuntime | undefined
  try {
    const nested: PathPermission[] = [
      { path: root, access: "DENY" }, { path: workspace, access: "READ" }, { path: writableWorkspace, access: "WRITE" },
    ]
    assert.equal(pathPermission(nested, blocked), "DENY")
    assert.equal(pathPermission(nested, join(workspace, "other.txt")), "READ")
    assert.equal(pathPermission(nested, writableWorkspace), "WRITE")
    const context: ToolExecutionContext<object> = {
      turn: 1, step: 1, toolCallId: "temporary", blockId: "temporary", signal: new AbortController().signal,
      validatedArguments: {},
      processRuntime: {
        projectId: "default", sessionId, outputDirectory: root,
        requestApproval: async () => assert.fail("必须使用显式审批端口"),
      },
      toolPermissions: {
        grant: async () => assert.fail("临时授权不得写入 Meta"),
        approve: async (_tool, scope, details) => {
          assert.equal(scope, "temporary")
          const { type, operation } = details as { type: string; operation: { command: string } }
          assert.deepEqual(operation, { command: "exit 0" })
          return type === "write" ? "approved" : "denied"
        },
      },
    }
    const load = () => ({ sandboxMode: "sandbox-read-only" as const, cwd: workspace })
    const temporary = await authorizeSandboxedProcess("shell", "exit 0", { mode: "temporary", permissions: grants },
      context, load, "bubblewrap")
    assert.equal(pathPermission(temporary.access!.policy.paths, workspace), "WRITE")
    assert.equal(pathPermission(temporary.access!.policy.paths, readable), "DENY")
    assert.equal(temporary.access!.policy.network, false)
    const ordinary = await authorizeSandboxedProcess("shell", "exit 0", { mode: "default" }, context, load, "bubblewrap")
    assert.equal(pathPermission(ordinary.access!.policy.paths, workspace), "READ")

    const fullLaunch = await authorizeSandboxedProcess("terminal_open", "exit 0", { mode: "default" },
      context, () => ({ ...load(), sandboxMode: "full-access" }), "bubblewrap")
    assert.deepEqual(fullLaunch.access, {
      backend: "bubblewrap", policy: { paths: [{ path: await canonicalPath(homedir()), access: "WRITE" }], network: true },
    })
    const native = await authorizeSandboxedProcess("terminal_open", "exit 0", { mode: "default" },
      context, () => ({ ...load(), sandboxMode: "full-access" }), "processcontainer")
    assert.equal(native.access, undefined)
    await assert.rejects(() => authorizeSandboxedProcess("terminal_open", "exit 0", { mode: "default" },
      context, () => ({ ...load(), sandboxMode: "full-access" }), null), { code: "SANDBOX_BLOCKED" })

    await writeFile(readable, "approved content")
    await writeFile(blocked, "denied content")
    const append = runtime.appendEvent.bind(runtime)
    runtime.appendEvent = async (input: SessionEventInput) => {
      const event = await append(input)
      if (event.type === "approval/request") {
        const args = event.arguments as { path?: string; type?: string }
        const decision = args.type === "network" || args.path === await canonicalPath(blocked) ||
          event.permissionScope === "unrestricted" ? "denied" : "approved"
        assert.equal(runtime.decideApproval(event.approvalId, decision), true)
      }
      return event
    }
    const turn = await runtime.startNewSession({ model, content: [{ type: "text", text: "test grants" }] })
    await turn.completion
    const events = await runtime.readEvents() as SessionEvent[]
    const approvals = events.filter((event) => event.type === "approval/request")
    assert.deepEqual(approvals.map((event) => event.permissionScope),
      ["persistent", "persistent", "persistent", "persistent", "unrestricted"])
    assert.deepEqual(approvals[4].arguments, { command: "exit 5" })
    const results = events.filter((event) => event.type === "tool/result")
      .sort((a, b) => Number(a.toolCallId.slice(5)) - Number(b.toolCallId.slice(5)))
    assert.deepEqual(results.map((event) => event.result.status === "success" ? "success" : event.result.error.code),
      ["FILE_PERMISSION_DENIED", "FILE_PERMISSION_DENIED", "SANDBOX_BLOCKED", "SANDBOX_BLOCKED", "success",
        "success", "FILE_PERMISSION_DENIED", "success", "APPROVAL_DENIED", "SANDBOX_BLOCKED"])
    assert.match(JSON.stringify(results[4].result.content), /rejectedRequests/)
    assert.equal(loadAccess("default", sessionId).permissions?.network, false)

    runtime.close()
    resumed = createRuntime()
    await resumed.updateSettings({ sandboxMode: "sandbox-full-access" })
    await resumed.updateSettings({ sandboxMode: "sandbox-read-only" })
    activeCalls = [
      { name: "read", arguments: { path: readable } },
      { name: "write", arguments: { path: writableWorkspace, content: "reset" } },
    ]
    const next = await resumed.continueSession({ content: [{ type: "text", text: "test restored grants" }] })
    await next.completion
    const after = await resumed.readEvents() as SessionEvent[]
    const restored = after.filter((event) => event.type === "tool/result").filter((event) => event.turn === 2)
      .sort((a, b) => a.toolCallId.localeCompare(b.toolCallId))
    assert.deepEqual(restored.map((event) => event.result.status === "success" ? "success" : event.result.error.code),
      ["success", "FILE_PERMISSION_DENIED"])
    assert.equal(after.filter((event) => event.type === "approval/request").length, approvals.length)
  } finally {
    runtime.close()
    resumed?.close()
    await global.disposeProcessTools()
    const child = relative(tmp, root)
    assert.ok(child.startsWith("minou-sandbox-") && !child.includes(sep) && !isAbsolute(child))
    await rm(root, { recursive: true, force: true })
  }
  console.log("sandbox permissions tests passed")
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
