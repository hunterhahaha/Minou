/** 编译后的真实 Node CLI：本机假模型、真实工具/MCP、文件输出和取消集成验证。 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { initializeConfigFilesSnapshot, writeMcpServers } from "../../src/main/config-files.ts"
import { saveModel, saveProvider, setProviderApiKey } from "../../src/main/provider-store.ts"
import { createMCPTestServer, testTool } from "../../runtime/mcp/test/helpers.ts"
import type { RunResult } from "../../src/cli/protocol.ts"
import type { SessionEvent } from "../../runtime/session/src/events.ts"

/** 可检查的 Chat Completions 请求。 */
interface RequestBody { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string; description?: string; parameters: { properties?: Record<string, unknown> } } }>; model: string; reasoning_effort?: string; tool_choice?: string }
/** 每个本地模型请求的脚本，挂起场景可保留 response 不结束。 */
type Respond = (body: RequestBody, attempt: number, response: ServerResponse) => void
/** 一次真实 CLI 子进程的输出。 */
interface Outcome { code: number | null; result: RunResult; events: SessionEvent[]; stdout: string; stderr: string; requests: RequestBody[] }

/**
 * 发布一个真实 SDK 可消费的 Chat Completion 流。
 * @param response HTTP 响应。
 * @param calls 本轮模型请求执行的工具。
 * @param answer 本轮文本。
 * @param finish 协议完成原因。
 * @param usage 是否发布权威 Usage。
 */
function reply(response: ServerResponse, calls: Array<{ name: string; args: object }> = [], answer = "answer", finish = calls.length ? "tool_calls" : "stop", usage = true): void {
  response.writeHead(200, { "content-type": "text/event-stream" })
  const chunk = (delta: object, reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fake-api-model", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`)
  chunk({ role: "assistant", reasoning_content: "top-secret-thinking" })
  if (answer) chunk({ content: answer })
  calls.forEach((call, index) => chunk({ tool_calls: [{ index, id: `call-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }))
  chunk({}, finish)
  if (usage) response.write(`data: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } } })}\n\n`)
  response.end("data: [DONE]\n\n")
}

/** @returns 所有集成场景完成。 @throws AssertionError 命令协议或既有 Runtime 行为不符。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "minou-cli-run-"))
  const profile = join(root, "profile")
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "AGENTS.md"), "Workspace rule from CLI fixture.")
  let requests: RequestBody[] = []
  let serverFailure: unknown
  let respond: Respond = (_body, _attempt, response) => reply(response)
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody
      body.tools ??= []
      for (const tool of body.tools) {
        assert.notEqual(tool.function.name, "present")
        assert.equal(Object.hasOwn(tool.function.parameters.properties ?? {}, "callDescription"), false)
        assert.doesNotMatch(tool.function.description ?? "", /\bpresent\b/)
      }
      requests.push(body)
      respond(body, requests.length, response)
    })().catch((error) => { serverFailure = error; response.writeHead(500); response.end() })
  })
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done))
  const address = provider.address()
  assert.ok(address && typeof address !== "string")
  const { paths } = await initializeConfigFilesSnapshot(profile)
  saveProvider(paths.providerDatabasePath, { id: "fixture", name: "fixture", type: "custom", protocol: "chat_completions", baseURL: `http://127.0.0.1:${address.port}/v1` })
  saveModel(paths.providerDatabasePath, { supportsReasoning: true, providerId: "fixture", modelId: "fixture-model", name: "fake-api-model", contextWindow: 128000, maxOutputTokens: 4096, reasoningLevels: ["low", "high"], reasoningField: { path: ["reasoning_effort"] } })
  setProviderApiKey(paths.providerDatabasePath, "fixture", "top-secret-key")
  saveModel(paths.providerDatabasePath, { supportsReasoning: false, providerId: "fixture", modelId: "plain-model", name: "plain-api-model", contextWindow: 128000, maxOutputTokens: 4096 })
  let serial = 0
  const cli = resolve("dist/src/cli/main.js")
  /** @param args 编译入口参数。 @param breakPipe 是否主动关闭 stdout。 @param onSpawn 获取强制结束进程的函数。 @returns 原始 stdout、stderr 和退出码。 */
  async function raw(args: string[], breakPipe = false, onSpawn?: (kill: () => void) => void) {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, USERPROFILE: profile }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    onSpawn?.(() => { child.kill("SIGKILL") })
    let stdout = "", stderr = ""
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk; if (breakPipe) child.stdout.destroy() })
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("原始 CLI 超时")) }, 15000)
      child.on("error", (error) => { clearTimeout(timer); reject(error) })
      child.on("close", (value) => { clearTimeout(timer); done(value) })
    })
    return { code, stdout, stderr }
  }
  /** @param args 本次启动选项。 @param script 本次模型脚本。 @param extra 额外 Node 参数。 @param isolateByDefault 是否默认关闭 Skill、Memory 和 MCP。 @returns 命令结果和模型请求。 */
  async function run(args: string[] = [], script?: Respond, extra: string[] = [], isolateByDefault = true): Promise<Outcome> {
    const id = ++serial
    const output = join(root, `answer-${id}`)
    const outputJson = join(root, `result-${id}.json`)
    const isolated = !isolateByDefault || args.includes("--isolate") ? [] : ["--isolate", "skill,memory,mcp"]
    requests = []
    serverFailure = undefined
    respond = script ?? ((_body, _attempt, response) => reply(response))
    const child = spawn(process.execPath, [...extra, cli, "run", "--prompt", "fixture task", "--workspace", workspace, "--output", output, "--outputjson", outputJson, ...isolated, ...args], { env: { ...process.env, USERPROFILE: profile }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI 场景超时: ${id}\n${stderr}`)) }, 18000)
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("close", (value) => { clearTimeout(timer); done(value) })
    })
    if (serverFailure) throw serverFailure
    const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEvent)
    const result = JSON.parse(await readFile(outputJson, "utf8")) as RunResult
    assert.doesNotMatch(stdout, /top-secret-key/)
    assert.equal(Object.hasOwn(result, "version"), false)
    assert.equal(Object.hasOwn(result, "run_id"), false)
    assert.equal(Object.hasOwn(result, "runid"), false)
    if (events.some((event) => event.type === "turn/start")) assert.equal(await readFile(output, "utf8"), result.answer)
    else await assert.rejects(readFile(output, "utf8"), /ENOENT/)
    if (result.event_log_path) {
      const db = new DatabaseSync(result.event_log_path, { readOnly: true })
      try {
        const recorded = db.prepare("SELECT event_json FROM session_events ORDER BY seq").all()
        assert.deepEqual(events, recorded.map((row) => JSON.parse(row.event_json as string)))
      } finally { db.close() }
    } else assert.deepEqual(events, [])
    return { code, result, events, stdout, stderr, requests: [...requests] }
  }
  /**
   * 续跑一次已建立的 CLI 会话。
   * @param sessionId 首次 run 返回的会话身份。
   * @param prompt 本轮用户消息。
   * @param script 本轮模型脚本。
   * @returns 本次提交的事件与模型请求。
   */
  async function resume(sessionId: string, prompt: string, script?: Respond) {
    requests = []
    serverFailure = undefined
    respond = script ?? ((_body, _attempt, response) => reply(response))
    const outcome = await raw(["continue", "--session-id", sessionId, "--prompt", prompt])
    if (serverFailure) throw serverFailure
    assert.equal(outcome.code, 0, outcome.stderr)
    const events = outcome.stdout.trim().split("\n").map((line) => JSON.parse(line) as SessionEvent)
    assert.ok(events.every((event) => event.sessionId === sessionId))
    return { events, requests: [...requests] }
  }

  try {
    const help = await raw(["run", "--help"])
    assert.equal(help.code, 0)
    assert.doesNotMatch(help.stdout, /--format/)
    const normal = await run()
    assert.equal(normal.code, 0, normal.stderr)
    assert.equal(normal.result.answer, "answer")
    assert.equal(normal.result.metrics.turns, 1)
    assert.equal(normal.result.metrics.steps, 1)
    assert.equal(normal.result.metrics.usage?.input_tokens, 7)
    assert.equal(normal.result.metrics.usage_complete, true)
    assert.equal(normal.result.model?.reasoningLevel, "low")
    assert.equal(normal.requests[0].model, "fake-api-model")
    assert.equal(normal.requests[0].reasoning_effort, "low")
    assert.match(normal.requests[0].messages[0].content, /Workspace rule from CLI fixture/)
    assert.equal(normal.requests[0].tools.some((tool) => ["skill_load", "memory_list", "tool_search"].includes(tool.function.name)), false)
    assert.ok(normal.result.record_directory?.endsWith(normal.result.session_id))
    assert.equal(normal.result.event_log_path, join(normal.result.record_directory!, "events.sqlite"))
    const messages = normal.events.filter((event) => event.type === "assistant/message")
    assert.equal(messages.length, 1)
    assert.ok(messages[0].message.content.some((block) => block.type === "text" && block.text === "answer"))
    assert.ok(normal.stdout.includes("top-secret-thinking"))
    assert.deepEqual(normal.events.slice(0, 2).map((event) => event.type), ["turn/start", "user/message"])
    assert.equal(normal.events.at(-1)?.type, "turn/end")
    assert.ok(normal.stderr.includes(`回答文件：${join(root, "answer-1")}\n`))
    const enabledByDefault = await run(["--modelid", "plain-model"])
    assert.equal(enabledByDefault.code, 0, enabledByDefault.stderr)
    assert.equal(enabledByDefault.requests[0].model, "plain-api-model")
    assert.equal(enabledByDefault.requests[0].reasoning_effort, "low")
    const disabled = await run(["--modelid", "fixture-model", "--supportreason", "false", "--reasoning-level", "unused"])
    assert.equal(disabled.code, 0, disabled.stderr)
    assert.equal(disabled.requests[0].reasoning_effort, undefined)
    const invalidLevel = await run(["--supportreason", "true", "--reasoning-level", "unused"])
    assert.equal(invalidLevel.code, 2)
    assert.equal(invalidLevel.requests.length, 0)
    requests = []
    const simpleOutput = join(root, "simple-answer")
    const simple = await raw(["run", "--prompt", "simple task", "--workspace", workspace,
      "--output", simpleOutput, "--isolate", "skill,memory,mcp"])
    assert.equal(simple.code, 0, simple.stderr)
    const simpleEvents = simple.stdout.trim().split("\n").map((line) => JSON.parse(line) as SessionEvent)
    assert.deepEqual(simpleEvents.slice(0, 2).map((event) => event.type), ["turn/start", "user/message"])
    assert.equal(simpleEvents.at(-1)?.type, "turn/end")
    assert.equal(await readFile(simpleOutput, "utf8"), "answer")
    assert.doesNotMatch(simple.stderr, /运行结果文件：/)
    const defaultOutput = await raw(["run", "--prompt", "simple task", "--workspace", workspace,
      "--isolate", "skill,memory,mcp", "--restrict-system-tools", "true", "--system-tools", "read,glob"])
    assert.equal(defaultOutput.code, 0, defaultOutput.stderr)
    assert.deepEqual(requests.at(-1)?.tools.map((tool) => tool.function.name), ["glob", "read"])
    const defaultEvents = defaultOutput.stdout.trim().split("\n").map((line) => JSON.parse(line) as SessionEvent)
    assert.equal(defaultEvents.at(-1)?.type, "turn/end")
    const defaultPath = join(paths.rootDir, "logs", "cli", defaultEvents[0].sessionId, "result.json")
    await assert.rejects(readFile(defaultPath, "utf8"), /ENOENT/)
    assert.doesNotMatch(defaultOutput.stderr, /回答文件：|运行结果文件：/)
    const failedAnswerJson = join(root, "failed-answer.json")
    const outputFailure = await raw(["run", "--prompt", "simple task", "--workspace", workspace,
      "--output", root, "--outputjson", failedAnswerJson, "--isolate", "skill,memory,mcp"])
    assert.equal(outputFailure.code, 1)
    const outputFailureEvents = outputFailure.stdout.trim().split("\n").map((line) => JSON.parse(line) as SessionEvent)
    assert.equal(outputFailureEvents.at(-1)?.type, "turn/end")
    const failedAnswerResult = JSON.parse(await readFile(failedAnswerJson, "utf8")) as RunResult
    assert.equal(failedAnswerResult.error?.code, "OUTPUT_FAILED")
    assert.equal(failedAnswerResult.answer, "answer")
    assert.doesNotMatch(outputFailure.stderr, /回答文件：/)
    const jsonFailure = await raw(["run", "--prompt", "JSON write failure", "--workspace", workspace,
      "--outputjson", root, "--isolate", "skill,memory,mcp"])
    assert.equal(jsonFailure.code, 1)
    assert.match(jsonFailure.stderr, /OUTPUT_FAILED/)
    assert.equal((JSON.parse(jsonFailure.stdout.trim().split("\n").at(-1)!) as SessionEvent).type, "turn/end")
    const invalidPath = join(root, "existing-answer")
    await writeFile(invalidPath, "existing")
    assert.equal((await raw(["run", "--bad", "x", "--output", invalidPath])).code, 2)
    assert.equal(await readFile(invalidPath, "utf8"), "existing")
    const invalidDefaultOutput = await raw(["run", "--bad", "x"])
    assert.equal(invalidDefaultOutput.code, 2)
    assert.equal(invalidDefaultOutput.stdout, "")
    assert.match(invalidDefaultOutput.stderr, /INVALID_REQUEST/)
    assert.doesNotMatch(invalidDefaultOutput.stderr, /回答文件：|运行结果文件：/)

    const deniedPath = join(workspace, "excluded-tool.txt")
    const restricted = await run(["--restrict-system-tools", "true", "--system-tools", "read", "--sandbox-mode", "full-access"],
      (body, attempt, response) => {
        assert.deepEqual(body.tools.map((tool) => tool.function.name), ["read"])
        if (attempt === 1) reply(response, [{ name: "read", args: { path: join(workspace, "AGENTS.md") } },
          { name: "write", args: { path: deniedPath, content: "unavailable tool" } }], "")
        else reply(response)
      })
    assert.equal(restricted.code, 0, restricted.stderr)
    assert.equal(restricted.result.metrics.tool_calls, 2)
    assert.match(restricted.requests[1].messages.at(-1)!.content, /TOOL_NOT_FOUND/)
    await assert.rejects(readFile(deniedPath), /ENOENT/)
    const emptyAllowlist = await run(["--restrict-system-tools", "true"])
    assert.equal(emptyAllowlist.code, 0, emptyAllowlist.stderr)
    assert.equal(emptyAllowlist.requests[0].tools.length, 0)
    const inactiveAllowlist = await run(["--system-tools", "read"])
    assert.equal(inactiveAllowlist.code, 0, inactiveAllowlist.stderr)
    assert.ok(inactiveAllowlist.requests[0].tools.some((tool) => tool.function.name === "write"))
    for (const unavailable of ["missing_tool", "skill_load", "mcp_list_tools"]) {
      const invalid = await run(["--restrict-system-tools", "true", "--system-tools", unavailable])
      assert.equal(invalid.code, 2)
      assert.ok(invalid.result.error?.message.includes(unavailable))
      assert.equal(invalid.result.metrics.turns, 0)
      assert.equal(invalid.requests.length, 0)
    }

    const outside = join(root, "outside.txt")
    const inside = join(workspace, "inside.txt")
    const cases = [
      { mode: "sandbox-full-access", path: inside, groups: [], tools: [], allow: true, approval: false },
      { mode: "sandbox-full-access", path: outside, groups: [], tools: [], allow: false, approval: true },
      { mode: "sandbox-read-only", path: inside, groups: [], tools: [], allow: false, approval: true },
      { mode: "sandbox-read-only", path: inside, groups: ["file"], tools: [], allow: true, approval: true },
      { mode: "sandbox-read-only", path: inside, groups: [], tools: ["write"], allow: true, approval: true },
      { mode: "full-access", path: outside, groups: [], tools: [], allow: true, approval: false },
    ]
    for (const item of cases) {
      await rm(item.path, { force: true })
      const outcome = await run(["--sandbox-mode", item.mode, ...(item.groups.length ? ["--auto-approve-groups", item.groups.join(",")] : []),
        ...(item.tools.length ? ["--auto-approve-tools", item.tools.join(",")] : [])], (_body, attempt, response) => {
        if (attempt === 1) reply(response, [{ name: "write", args: { path: item.path, content: "private-tool-payload" } }], "")
        else reply(response)
      })
      assert.equal(outcome.code, 0, outcome.stderr)
      if (item.allow) assert.equal(await readFile(item.path, "utf8"), "private-tool-payload")
      else await assert.rejects(readFile(item.path), /ENOENT/)
      assert.equal(outcome.events.some((event) => event.type === "approval/result"), item.approval)
      assert.equal(outcome.result.metrics.tool_calls, 1)
      assert.equal(outcome.result.metrics.steps, 2)
      assert.equal(outcome.result.metrics.usage?.input_tokens, 14)
      assert.ok(outcome.stdout.includes("private-tool-payload"))
      const db = new DatabaseSync(outcome.result.event_log_path!, { readOnly: true })
      const events = db.prepare("SELECT event_json FROM session_events ORDER BY seq").all().map((row) => JSON.parse(row.event_json as string))
      db.close()
      assert.ok(events.every((event) => event.type !== "assistant/block_start" && event.type !== "assistant/block_delta"))
      assert.deepEqual(events.map((event) => event.seq), events.map((_event, index) => index + 1))
      const block = events.find((event) => event.type === "assistant/block_end" && event.block.type === "tool_call")
      assert.equal(events.find((event) => event.type === "tool/result").toolCallEventId, block.eventId)
      assert.equal(events.at(-1).type, "turn/end")
    }
    for (const approved of [true, false]) {
      await rm(outside, { force: true })
      const auto = await run(["--reasoning-level", "high", "--sandbox-mode", "auto", ...(approved ? [] : ["--auto-approve-groups", "file"])], (body, attempt, response) => {
        if (attempt === 1) reply(response, [{ name: "write", args: { path: outside, content: "reviewed write" } }], "")
        else if (attempt === 2) {
          assert.equal(body.model, "fake-api-model")
          assert.equal(body.reasoning_effort, "low")
          assert.equal(body.tool_choice, "none")
          assert.deepEqual(body.tools, [])
          const review = JSON.parse(body.messages.at(-1)!.content)
          assert.equal(review.candidate.toolName, "write")
          assert.equal(review.candidate.arguments.path, outside)
          assert.equal(review.turnContext[0].role, "user")
          reply(response, [], JSON.stringify({ riskLevel: "low", approved }))
        } else reply(response)
      })
      assert.equal(auto.code, 0, auto.stderr)
      assert.equal(auto.events.find((event) => event.type === "approval/result")?.decision, approved ? "approved" : "denied")
      if (approved) assert.equal(await readFile(outside, "utf8"), "reviewed write")
      else await assert.rejects(readFile(outside), /ENOENT/)
      assert.equal(auto.requests.length, 3)
      assert.equal(auto.result.metrics.turns, 1)
      assert.equal(auto.result.metrics.steps, 2)
      assert.equal(auto.result.metrics.usage?.total_tokens, 24)
      assert.equal(auto.result.metrics.usage_complete, true)
    }
    const limited = await run(["--max-steps", "1"], (_body, _attempt, response) => reply(response, [{ name: "read", args: { path: inside } }], ""))
    assert.equal(limited.code, 10)
    assert.equal(limited.result.stop_reason, "max_steps")
    assert.equal(limited.result.metrics.steps, 1)
    assert.equal(limited.requests.length, 1)
    const incomplete = await run([], (_body, _attempt, response) => reply(response, [], "partial", "length"))
    assert.equal(incomplete.code, 1)
    assert.equal(incomplete.result.stop_reason, "model_incomplete")
    assert.equal(incomplete.result.answer_complete, false)
    const missing = await run(["--modelid", "does-not-exist"])
    assert.equal(missing.code, 2)
    assert.equal(missing.requests.length, 0)
    assert.equal(missing.result.metrics.turns, 0)
    assert.ok(missing.result.event_log_path)
    const failed = await run([], (_body, _attempt, response) => { response.writeHead(400); response.end(JSON.stringify({ error: { message: "private-sdk-error-with-secret", type: "invalid_request_error" } })) })
    assert.equal(failed.code, 1)
    assert.equal(failed.result.stop_reason, "error")
    assert.equal(failed.stdout.includes("private-sdk-error"), false)
    const failedAfterWrite = await run([], (_body, attempt, response) => {
      if (attempt === 1) reply(response, [{ name: "write", args: { path: inside, content: "persist-before-model-error" } }], "")
      else { response.writeHead(400); response.end(JSON.stringify({ error: { message: "failed after write" } })) }
    })
    assert.equal(failedAfterWrite.code, 1)
    assert.equal(failedAfterWrite.result.metrics.usage_complete, false, "失败 Step 未报告 Usage 时不能标为完整统计")
    const failedLog = new DatabaseSync(join(failedAfterWrite.result.record_directory!, "events.sqlite"), { readOnly: true })
    const recordedTypes = failedLog.prepare("SELECT type FROM session_events ORDER BY seq").all().map((row) => row.type)
    failedLog.close()
    assert.ok(recordedTypes.includes("turn/file_changes"), "模型失败也必须保存已执行的文件变化记录")
    const mixedUsage = await run([], (_body, attempt, response) => attempt === 1
      ? reply(response, [{ name: "read", args: { path: inside } }], "", "tool_calls", false) : reply(response))
    assert.equal(mixedUsage.result.metrics.usage_complete, false)
    assert.equal(mixedUsage.result.metrics.usage_reported_steps, 1)

    const skill = join(paths.rootDir, "skills", "fixture-skill")
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, "SKILL.md"), "---\ndescription: global fixture skill description\n---\nprivate skill body")
    const enabled = await run(["--reasoning-level", "high"], undefined, [], false)
    assert.equal(enabled.code, 0, enabled.stderr)
    assert.match(enabled.requests[0].messages[0].content, /global fixture skill description/)
    assert.doesNotMatch(enabled.requests[0].messages[0].content, /private skill body/)
    for (const name of ["skill_load", "memory_list", "mcp_list_tools"]) assert.ok(enabled.requests[0].tools.some((tool) => tool.function.name === name))
    const initialRules = await readFile(join(workspace, "AGENTS.md"), "utf8")
    const contextPath = join(enabled.result.record_directory!, "contextstate.json")
    const initialContext = JSON.parse(await readFile(contextPath, "utf8"))
    assert.deepEqual(Object.keys(initialContext).sort(), ["agentsmd", "mcp", "skills"])
    assert.equal(initialContext.agentsmd.content, initialRules)
    const activeSession = enabled.result.session_id
    const noChanges = await resume(activeSession, "First follow-up.")
    assert.deepEqual(noChanges.events.slice(0, 2).map((event) => event.type), ["turn/start", "user/message"])
    assert.equal(noChanges.events[0].seq, enabled.events.at(-1)!.seq + 1)
    assert.ok(noChanges.events.every((event) => event.turn === 2))
    assert.equal(noChanges.requests[0].reasoning_effort, "high")
    assert.ok(noChanges.requests[0].messages.some((message) => message.content === "fixture task"))
    assert.ok(noChanges.requests[0].messages.some((message) => message.content === "First follow-up."))
    const addedSkill = join(paths.rootDir, "skills", "second-fixture")
    await mkdir(addedSkill)
    await writeFile(join(addedSkill, "SKILL.md"), "---\ndescription: second fixture description\n---\nsecond body")
    await writeFile(join(workspace, "AGENTS.md"), "Updated workspace rules.")
    const changed = await resume(activeSession, "Apply the changes.")
    assert.deepEqual(changed.events.slice(0, 4).map((event) => event.type),
      ["context_update", "context_update", "turn/start", "user/message"])
    assert.ok(changed.events.every((event) => event.turn === 3))
    assert.equal(changed.events[0].seq, noChanges.events.at(-1)!.seq + 1)
    assert.equal(changed.requests[0].messages[0].content, enabled.requests[0].messages[0].content)
    assert.ok(changed.requests[0].messages.slice(1).some((message) => message.content.includes("Updated workspace rules.")))
    assert.ok(changed.requests[0].messages.slice(1).some((message) => message.content.includes("second fixture description")))
    assert.deepEqual(JSON.parse(await readFile(contextPath, "utf8")), initialContext)
    assert.equal(await readFile(join(enabled.result.record_directory!, "agents_md.snapshot"), "utf8"), "Updated workspace rules.")
    const unchangedAgain = await resume(activeSession, "One more follow-up.")
    assert.equal(unchangedAgain.events[0].type, "turn/start")
    assert.ok(unchangedAgain.events.every((event) => event.turn === 4))
    const lockedTools = await resume(defaultEvents[0].sessionId, "Use the original tools.")
    assert.deepEqual(lockedTools.requests[0].tools.map((tool) => tool.function.name), ["glob", "read"])
    assert.match((await raw(["continue", "--session-id", activeSession, "--prompt", "bad", "--system-tools", "write"])).stderr, /未知参数/)

    let killActive = () => {}
    let ready!: () => void
    const waiting = new Promise<void>((done) => { ready = done })
    respond = (_body, _attempt, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
      ready()
    }
    const interruptedTurn = raw(["continue", "--session-id", activeSession, "--prompt", "Interrupted turn."], false,
      (kill) => { killActive = kill })
    try {
      await Promise.race([waiting, interruptedTurn.then(({ stderr }) => { throw new Error(stderr) })])
      const concurrent = await raw(["continue", "--session-id", activeSession, "--prompt", "Concurrent turn."])
      assert.equal(concurrent.code, 2, concurrent.stderr)
      assert.match(concurrent.stderr, /正在执行/)
      assert.equal(concurrent.stdout, "")
    } finally { killActive(); await interruptedTurn }
    const recovered = await resume(activeSession, "Recover and continue.")
    assert.deepEqual(recovered.events.slice(0, 4).map((event) => [event.type, event.turn]),
      [["step/end", 5], ["turn/end", 5], ["turn/start", 6], ["user/message", 6]])
    await writeFile(contextPath, "{ invalid JSON")
    const repairedState = await resume(activeSession, "Use the repaired context.")
    assert.equal(repairedState.events[0].type, "turn/start")
    assert.equal(repairedState.events[0].turn, 7)
    assert.equal(JSON.parse(await readFile(contextPath, "utf8")).agentsmd.content, "Updated workspace rules.")
    await writeFile(join(workspace, "AGENTS.md"), initialRules)
    const registryPath = join(paths.rootDir, "skills", "registry.json")
    await writeFile(registryPath, "do-not-touch")
    await run()
    assert.equal(await readFile(registryPath, "utf8"), "do-not-touch")
    await writeFile(join(paths.rootDir, "sessions", "default", "memory.md"), "# MemoryFixturePrivate\n## Detail\n")
    const memory = await run(["--isolate", "skill,mcp"], (_body, attempt, response) => attempt === 1
      ? reply(response, [{ name: "memory_list", args: {} }], "") : reply(response))
    assert.equal(memory.code, 0)
    assert.doesNotMatch(memory.requests[0].messages[0].content, /MemoryFixturePrivate/)
    assert.match(memory.requests[1].messages.at(-1)!.content, /MemoryFixturePrivate/)
    assert.equal(await readFile(registryPath, "utf8"), "do-not-touch")

    const configuredMcp = await createMCPTestServer([testTool("configured_remote")])
    try {
      const configuredServers = [{ name: "configured", enabled: true, transport: "streamable-http" as const, url: configuredMcp.url }]
      await writeMcpServers(paths.configPath, configuredServers)
      const skipped = await run(["--isolate", "skill,memory", "--use-configured-mcp", "false"])
      assert.equal(skipped.code, 0, skipped.stderr)
      assert.ok(skipped.requests[0].tools.some((tool) => tool.function.name === "mcp_list_tools"))
      assert.equal(configuredMcp.state.headers.length, 0)
      const emptyConfig = join(root, "empty-mcp.json")
      await writeFile(emptyConfig, JSON.stringify({ mcpServers: [] }))
      const override = await run(["--isolate", "skill,memory", "--mcp-config", emptyConfig])
      assert.equal(override.code, 0, override.stderr)
      assert.equal(configuredMcp.state.headers.length, 0)
      const connected = await run(["--isolate", "skill,memory"])
      assert.equal(connected.code, 0, connected.stderr)
      assert.ok(configuredMcp.state.headers.length > 0)
      assert.deepEqual(JSON.parse(await readFile(paths.configPath, "utf8")).mcpServers, configuredServers)
    } finally {
      await writeMcpServers(paths.configPath, [])
      await configuredMcp.close()
    }

    for (const allow of [true, false]) {
      let fixture = await createMCPTestServer([testTool("remote")])
      let fixtureClosed = false
      try {
      const mcpFile = join(root, "mcp.json")
      await writeFile(mcpFile, JSON.stringify({ mcpServers: [{ name: "fixture", enabled: true, transport: "streamable-http", url: fixture.url }] }))
      /** @param body 当前模型输入。 @param attempt 模型轮次。 @param response 响应。 */
      const mcpScript: Respond = (body, attempt, response) => {
        assert.equal(body.tools.some((tool) => tool.function.name === "read" || tool.function.name === "tool_search"), false)
        if (attempt === 1) reply(response, [{ name: "mcp_list_tools", args: {} }], "")
        else if (attempt === 2) {
          const name = body.messages.at(-1)!.content.split("\n")[0]
          assert.ok(name.startsWith("mcp_"))
          assert.equal(body.tools.some((tool) => tool.function.name === name), false)
          reply(response, [{ name: "mcp_load_tools", args: { names: [name] } }], "")
        } else if (attempt === 3) {
          const remote = body.tools.find((tool) => tool.function.name.startsWith("mcp_") && !["mcp_list_tools", "mcp_load_tools"].includes(tool.function.name))
          assert.ok(remote, "下一 Step 必须暴露已载入的 MCP 工具")
          reply(response, [{ name: remote.function.name, args: { value: "remote-private-value" } }], "")
        } else reply(response)
      }
      const mcpAllowed = await run(["--isolate", "skill,memory", "--mcp-config", mcpFile, "--use-configured-mcp", "false",
        "--restrict-system-tools", "true", "--system-tools", "mcp_list_tools,mcp_load_tools", ...(allow ? ["--auto-approve-groups", "mcp"] : [])], mcpScript)
      assert.equal(mcpAllowed.code, 0, mcpAllowed.stderr)
      assert.equal(fixture.state.calls.length, allow ? 1 : 0)
      assert.ok(mcpAllowed.stdout.includes("remote-private-value"))
      assert.deepEqual(JSON.parse(await readFile(paths.configPath, "utf8")).mcpServers, [], "本次 MCP 覆盖不得写回全局配置")
      if (allow) {
        const toolName = mcpAllowed.events.flatMap((event) =>
          event.type === "mcp/tools_added" ? event.tools.map(({ entry }) => entry.name) : [])[0]
        assert.ok(toolName)
        const port = Number(new URL(fixture.url).port)
        await fixture.close()
        fixtureClosed = true
        fixture = await createMCPTestServer([testTool("remote"), testTool("new_remote")], true, port)
        fixtureClosed = false
        await writeFile(mcpFile, JSON.stringify({ mcpServers: [] }))
        const continued = await resume(mcpAllowed.result.session_id, "Reuse the remote tool.", (body, attempt, response) => {
          assert.ok(body.tools.some((tool) => tool.function.name === toolName))
          if (attempt === 1) reply(response, [{ name: "mcp_list_tools", args: {} }], "")
          else if (attempt === 2) {
            assert.match(body.messages.at(-1)!.content, new RegExp(toolName))
            assert.doesNotMatch(body.messages.at(-1)!.content, /new_remote/)
            reply(response, [{ name: toolName, args: { value: "second-turn" } }], "")
          } else reply(response)
        })
        assert.equal(fixture.state.calls.length, 1)
        assert.equal(fixture.state.calls[0].arguments?.value, "second-turn")
        assert.equal(continued.events.some((event) => event.type === "mcp/tools_added"), false)
      }
      } finally { if (!fixtureClosed) await fixture.close() }
    }
    const fixture = await createMCPTestServer([testTool("remote")])
    try {
      fixture.state.listDelay = 10000
      const mcpFile = join(root, "mcp-timeout.json")
      await writeFile(mcpFile, JSON.stringify({ mcpServers: [{ name: "fixture", enabled: true, transport: "streamable-http", url: fixture.url }] }))
      const startupTimeout = await run(["--isolate", "skill,memory", "--mcp-config", mcpFile, "--timeout", "1"])
      assert.equal(startupTimeout.code, 124)
      assert.equal(startupTimeout.requests.length, 0)
    } finally { await fixture.close() }

    const hanging: Respond = (_body, _attempt, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders() }
    const timed = await run(["--timeout", "1"], hanging)
    assert.equal(timed.code, 124)
    assert.equal(timed.result.stop_reason, "timeout")
    assert.equal(timed.result.metrics.usage, null)
    const preload = join(root, "signal.cjs")
    // Windows 的 child.kill 会直接终止进程；用真实 CLI 进程中的信号事件验证监听和收尾路径。
    await writeFile(preload, "const write=process.stdout.write; let sent=false; process.stdout.write=function(chunk,...args){ const result=write.call(this,chunk,...args); if(!sent && String(chunk).includes('step/start')){sent=true;setTimeout(()=>process.emit('SIGTERM'),100);} return result; };")
    const interrupted = await run([], hanging, ["--require", preload])
    assert.equal(interrupted.code, 130)
    assert.equal(interrupted.result.stop_reason, "interrupted")

    const shellCase = await run(["--auto-approve-groups", "shell"], (_body, attempt, response) => attempt === 1
      ? reply(response, [{ name: "shell", args: { command: "[Console]::Write('cli-shell-ok')" } }], "") : reply(response))
    assert.equal(shellCase.code, 0)
    assert.equal(shellCase.events.find((event) => event.type === "tool/result")?.result.status, "success")
    assert.match(shellCase.requests[1].messages.at(-1)!.content, /cli-shell-ok/)
    const pidPath = join(root, "shell-pid.txt")
    const shellTimeout = await run(["--timeout", "2", "--auto-approve-groups", "shell"], (_body, _attempt, response) =>
      reply(response, [{ name: "shell", args: { command: `$PID | Set-Content -LiteralPath '${pidPath.replaceAll("'", "''")}'; Start-Sleep -Seconds 30` } }], ""))
    assert.equal(shellTimeout.code, 124)
    const pid = Number((await readFile(pidPath, "utf8")).trim())
    assert.ok(pid > 0)
    assert.throws(() => process.kill(pid, 0), "取消后真实 Shell 进程必须已经释放")
    const terminalPidPath = join(root, "terminal-pid.txt")
    const terminalCase = await run(["--auto-approve-groups", "terminal"], (body, attempt, response) => {
      assert.deepEqual(body.tools.map((tool) => tool.function.name).filter((name) => name.startsWith("terminal_")).sort(), ["terminal_input", "terminal_open"])
      if (attempt === 1) {
        reply(response, [{ name: "terminal_open", args: { command: `$PID | Set-Content -LiteralPath '${terminalPidPath.replaceAll("'", "''")}'` } }], "")
      } else if (attempt === 2) {
        const terminalId = /Terminal ID: (term_[^\s]+)/.exec(body.messages.at(-1)!.content)?.[1]
        assert.ok(terminalId)
        reply(response, [{ name: "terminal_input", args: { terminalId, input: "" } }], "")
      } else reply(response)
    })
    assert.equal(terminalCase.code, 0, terminalCase.stderr)
    assert.deepEqual(terminalCase.events.filter((event) => event.type === "tool/result").map((event) => event.result.status), ["success", "success"])
    const terminalPid = Number((await readFile(terminalPidPath, "utf8")).trim())
    assert.ok(terminalPid > 0)
    assert.throws(() => process.kill(terminalPid, 0), "CLI 收尾后真实 PTY 进程必须已经释放")
    const broken = await raw(["run", "--prompt", "broken stdout", "--workspace", workspace, "--isolate", "skill,memory,mcp"], true)
    assert.equal(broken.code, 1)
    assert.match(broken.stderr, /OUTPUT_FAILED/)
    assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false)
    console.log(`CLI integration: passed (${serial} real process runs)`)
  } finally {
    provider.closeAllConnections()
    await new Promise<void>((done) => provider.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
