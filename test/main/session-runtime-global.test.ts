/** 进程级 Session Runtime 能力的工具定义和启动输入测试。 */

import assert from "node:assert/strict"
import { join } from "node:path"

import { RenderRegistry, ToolRegistry } from "../../runtime/tools/src/index.ts"
import type { ConfigFilePaths } from "../../src/main/config-files.ts"
import { SessionRuntimeGlobal } from "../../src/main/session-runtime-global.ts"

const rootDir = join(process.cwd(), ".minou")
const paths: ConfigFilePaths = {
  rootDir,
  configPath: join(rootDir, "config.json"),
  providerDatabasePath: join(rootDir, "providers.sqlite"),
  workspaceDatabasePath: join(rootDir, "workspace.sqlite"),
  metaDatabasePath: join(rootDir, "meta.sqlite"),
}

/** 确认模型可见 Schema 仅包含业务参数，且返回副本不影响注册表原定义。 */
function testToolDefinitions(): void {
  const tools = new ToolRegistry()
  tools.register({
    kind: "builtin",
    definition: {
      name: "read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    validateArguments: () => ({ success: true, data: { path: "a.txt" } }),
    execute: async () => ({ text: "content" }),
  })

  const global = new SessionRuntimeGlobal(paths, tools, new RenderRegistry())
  const [definition] = global.listToolDefinitions()
  assert.deepEqual(definition.inputSchema, {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  })
  ;(definition.inputSchema.properties as Record<string, unknown>).path = { type: "number" }
  assert.deepEqual(tools.listDefinitions()[0].inputSchema.properties, {
    path: { type: "string" },
  })
}

/** 进程级对象必须在启动时拒绝相对配置根目录。 */
function testRelativeRootDirectory(): void {
  assert.throws(
    () => new SessionRuntimeGlobal(
      { ...paths, rootDir: "relative" },
      new ToolRegistry(),
      new RenderRegistry(),
    ),
    /Project Context 根目录必须是绝对路径/,
  )
}

testToolDefinitions()
testRelativeRootDirectory()
console.log("SessionRuntimeGlobal tests passed")
