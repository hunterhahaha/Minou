/** 真实 Session 在配置删除、重连和改名后的模型工具定义同步。 */
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

/** @returns 下一模型请求使用当前 Catalog、contextstate 修复及改名隔离验证完成。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-mcp-reconfigure-"))
  const fixture = await createReloadableServer([testTool("sample")])
  const paths = await initializeConfigFiles(root)
  const global = new SessionRuntimeGlobal(paths, new ToolRegistry(), new RenderRegistry())
  const config: MCPConfig = { name: "remote", enabled: true, transport: "streamable-http", url: fixture.url }
  await global.mcpManager.initialize([config])
  const name = global.mcpManager.listTools()[0].name
  const directory = join(paths.rootDir, "sessions", "default", "reconfigure")
  /** @returns 同一持久化 Session 的新活动实例；每个活动期结束后 Runtime 自动关闭。 */
  const createRuntime = () => new SessionRuntime({ projectGroupId: "default", sessionId: "reconfigure", sessionDirectory: directory,
    databasePath: join(paths.rootDir, "events.sqlite"), metaDatabasePath: paths.metaDatabasePath, systemPrompt: "offline", global })
  let runtime = createRuntime()
  let turn = 0, renamed = ""
  const visible: UnifiedToolDefinition[][] = []
  global.createTurnModelAdapter = async () => {
    const current = ++turn
    let step = 0
    return { contextWindow: 10000, stream: async function* (request) {
      step++
      const definitions = request.tools ?? []
      visible.push(definitions)
      if ((current === 1 || current === 4) && step === 1) {
        assert.equal(definitions.some((tool) => tool.name === name), false)
        yield { type: "block_start", index: 0, blockType: "tool_call" }
        yield { type: "block_end", index: 0, block: { type: "tool_call", toolCallId: `load-${current}`, name: "mcp_load_tools", arguments: { names: [current === 1 ? name : renamed] } } }
        yield { type: "stream_end", completion: "tool_calls" }
      } else {
        if (current === 1) assert.equal(definitions.some((tool) => tool.name === name), true)
        if (current === 2) assert.equal(definitions.some((tool) => tool.name === name), false)
        if (current === 3) {
          const schema = definitions.find((tool) => tool.name === name)!.inputSchema
          assert.equal((schema.properties as Record<string, { type: string }>).value.type, "integer")
        }
        if (current === 4) { assert.equal(definitions.some((tool) => tool.name === name), false); assert.equal(definitions.some((tool) => tool.name === renamed), true) }
        yield { type: "stream_end", completion: "finished" }
      }
    } }
  }
  const model: ModelRef = { providerId: "offline", modelId: "offline", name: "Offline", protocol: "responses" }
  const input = { content: [{ type: "text" as const, text: "check" }], model }
  try {
    const started = await runtime.startNewSession(input)
    await runtime.processMessageQueue(started).completion
    await global.mcpManager.applyConfigurations([])
    runtime = createRuntime()
    await (await runtime.continueSession(input)).completion
    const context = async () => (JSON.parse(await readFile(join(directory, "contextstate.json"), "utf8")) as { mcp: UnifiedToolDefinition[] }).mcp
    assert.deepEqual(await context(), [])
    fixture.state.tools = [{ ...testTool("sample"), inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } }]
    await global.mcpManager.applyConfigurations([config])
    runtime = createRuntime()
    await (await runtime.continueSession(input)).completion
    assert.equal((await context())[0].name, name)
    await global.mcpManager.applyConfigurations([{ ...config, name: "renamed" }])
    renamed = global.mcpManager.listTools()[0].name
    runtime = createRuntime()
    await (await runtime.continueSession(input)).completion
    assert.equal((await context())[0].name, renamed)
    assert.equal(visible.length, 6)
    console.log("mcp-reconfigure.test.ts: Session 下一请求过滤失效工具、更新 Schema、改名隔离与 contextstate 同步通过")
  } finally {
    runtime.close(); await global.disposeProcessTools(); await fixture.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
