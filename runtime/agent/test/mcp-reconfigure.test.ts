import { splitSystemMessage } from "../../model/src/shared.ts"
/**
 * 通过本地 MCP 测试服务验证配置变化后的 Session 工具定义同步。
 *
 * 在服务删除、重新连接和改名后继续同一 Session，检查旧定义按历史回放，
 * 同名重新载入刷新后续请求并能按新 Schema 执行，且原始快照保持不变。
 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { SessionRuntime } from "../src/session-runtime.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import { initializeConfigFiles } from "../../../src/main/config-files.ts"
import { ToolRegistry, RenderRegistry } from "../../tools/src/index.ts"
import { createReloadableServer } from "../../mcp/test/reloadable-server.ts"
import { testTool } from "../../mcp/test/helpers.ts"
import type { MCPConfig } from "../../mcp/src/types.ts"
import type { ModelRef, UnifiedToolDefinition } from "../../model/src/types.ts"
import type { SessionEvent } from "../../session/src/events.ts"

/**
 * 启动本地 MCP 测试服务，验证删除、重连及改名后的工具定义并释放临时资源。
 *
 * @returns 下一模型请求使用当前 Catalog、contextstate 修复及改名隔离验证完成。
 * @throws Error 断言或场景执行失败时向上传播，测试入口记录错误并设置失败退出码。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-mcp-reconfigure-"))
  const fixture = await createReloadableServer([testTool("sample")])
  const paths = await initializeConfigFiles(root)
  const global = new SessionRuntimeGlobal(paths, new ToolRegistry(), new RenderRegistry())
  const config: MCPConfig = { name: "remote", enabled: true, transport: "streamable-http", url: fixture.url }
  await global.mcpManager.initialize([config])
  const name = global.mcpManager.listTools()[0].name
  const directory = join(paths.rootDir, "sessions", "default", "reconfigure")
  /**
   * 为同一持久化 Session 创建新的活动实例，模型脚本与全局能力由当前场景共用。
   * @returns 绑定测试 Session 目录和数据库的新 Runtime。
   * @throws Error Runtime 构造失败时抛出，调用方负责释放场景资源。
   */
  const createRuntime = () => new SessionRuntime({ projectGroupId: "default", sessionId: "reconfigure", sessionDirectory: directory,
    databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "offline", global })
  let runtime = createRuntime()
  let turn = 0, renamed = ""
  const visible: UnifiedToolDefinition[][] = []
  global.createTurnModelAdapter = async () => {
    const current = ++turn
    let step = 0
    return { contextWindow: 128000, maxOutputTokens: 4096, stream: async function* (request) {
      step++
      const definitions = splitSystemMessage(request).tools
      visible.push(definitions)
      if ((current === 1 || current === 3 || current === 4) && step === 1) {
        assert.equal(definitions.some((tool) => tool.name === name), current !== 1)
        if (current === 3) assert.equal((definitions.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, { type: string }>).value.type, "string")
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: `load-${current}`, name: "mcp_load_tools", arguments: { names: [current === 4 ? renamed : name] } } }
        yield { type: "stream_end", completion: "tool_calls" }
      } else if (current === 3 && step === 2) {
        const schema = definitions.find((tool) => tool.name === name)!.inputSchema
        assert.equal((schema.properties as Record<string, { type: string }>).value.type, "integer")
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: "updated-schema", name, arguments: { value: 42 } } }
        yield { type: "stream_end", completion: "tool_calls" }
      } else {
        if (current === 1) assert.equal(definitions.some((tool) => tool.name === name), true)
        if (current === 2) assert.equal(definitions.some((tool) => tool.name === name), true)
        if (current === 3) {
          const schema = definitions.find((tool) => tool.name === name)!.inputSchema
          assert.equal((schema.properties as Record<string, { type: string }>).value.type, "integer")
        }
        if (current === 4) { assert.equal(definitions.some((tool) => tool.name === name), false); assert.equal(definitions.some((tool) => tool.name === renamed), true) }
        yield { type: "stream_end", completion: "finished" }
      }
    } }
  }
  const model: ModelRef = { providerId: "offline", modelId: "offline", name: "Offline", protocol: "responses", reasoningLevel: "medium" }
  const input = { content: [{ type: "text" as const, text: "check" }], model, sandboxMode: "full-access" as const }
  try {
    const started = await runtime.startNewSession(input)
    await runtime.processMessageQueue(started).completion
    await global.mcpManager.applyConfigurations([])
    runtime = createRuntime()
    await (await runtime.continueSession(input)).completion
    /**
     * 从派生文件重新读取当前 Session 的 MCP 定义，不使用内存缓存。
     * @returns 已写入 contextstate 的 MCP 定义。
     * @throws Error 文件读取或 JSON 解析失败时拒绝，由当前场景报告。
     */
    const context = async () => (JSON.parse(await readFile(join(directory, "contextstate.json"), "utf8")) as { mcp: UnifiedToolDefinition[] }).mcp
    assert.deepEqual(await context(), [])
    fixture.state.tools = [{ ...testTool("sample"), inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } }]
    await global.mcpManager.applyConfigurations([config])
    runtime = createRuntime()
    await (await runtime.continueSession(input)).completion
    assert.equal(fixture.state.calls, 1, "新 Schema 参数应到达 MCP 服务")
    const events = await runtime.readEvents() as SessionEvent[]
    const additions = events.filter((event) => event.type === "mcp/tools_added")
    assert.deepEqual(additions.map((event) => (event.tools[0].definition.inputSchema.properties as Record<string, { type: string }>).value.type), ["string", "integer"])
    const result = events.find((event) => event.type === "tool/result" && event.toolCallId === "updated-schema")
    assert.ok(result?.type === "tool/result" && result.result.status === "success")
    assert.deepEqual(await context(), [])
    await global.mcpManager.applyConfigurations([{ ...config, name: "renamed" }])
    renamed = global.mcpManager.listTools()[0].name
    runtime = createRuntime()
    await (await runtime.continueSession(input)).completion
    assert.deepEqual(await context(), [])
    assert.equal(visible.length, 8)
    console.log("mcp-reconfigure.test.ts: 同名 Schema 刷新、实际执行、历史快照与重启恢复通过")
  } finally {
    runtime.close(); await global.disposeProcessTools(); await fixture.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
