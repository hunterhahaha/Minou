/** 三件记忆工具的 Schema、提示词、参数边界与专属 render 测试。 */
import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { MemoryManager } from "../../memory/src/index.ts"
import { createExecuteToolCall, registerMemoryTools, RenderRegistry, ToolRegistry } from "../src/index.ts"
import type { ToolCallContext, ToolResult } from "../src/types.ts"
import { renderMemoryList, renderMemoryRead, renderMemoryWrite } from "../src/render/memory.ts"
import { SessionRuntimeGlobal } from "../../../src/main/session-runtime-global.ts"
import type { ConfigFilePaths } from "../../../src/main/config-files.ts"

/**
 * 按内容块顺序拼接模型可见文本。
 * @param result 工具结果。
 * @returns 模型可见文本。
 */
function text(result: ToolResult): string { return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") }
/**
 * 读取错误结果的稳定错误码，成功结果不返回错误码。
 * @param result 工具结果。
 * @returns 失败错误码，成功时为 undefined。
 */
function code(result: ToolResult): string | undefined { return result.status === "error" ? result.error.code : undefined }

/**
 * 按顺序执行当前文件的断言和已有资源清理流程。
 * @returns 工具契约验证完成。
 * @throws AssertionError 参数检查或结果整理不符合断言预期。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-memory-tools-"))
  try {
    await mkdir(join(root, "sessions", "default"), { recursive: true })
    const manager = new MemoryManager(root, () => new Date("2026-10-09T01:02:03.004Z"))
    const tools = new ToolRegistry(), renders = new RenderRegistry()
    registerMemoryTools(tools, renders, manager)
    assert.deepEqual(tools.listDefinitions().map((item) => item.name), ["memory_list", "memory_read", "memory_write"])
    assert.ok(["memory_list", "memory_read", "memory_write"].every((name) => renders.get(name) !== undefined))
    assert.throws(() => registerMemoryTools(tools, renders, manager), /已|already|重复/)
    const expectedDescription = "Project Memory stores durable knowledge learned\nacross sessions.\n\nSave:\n- User preferences and corrections.\n- Project decisions not evident from code.\n- Important context useful in future sessions.\n\nDo not save:\n- Information already in AGENTS.md.\n- Facts derivable from current code or Git history.\n- Temporary task details.\n\nTreat AGENTS.md as explicit project instructions.\nTreat Memory as historical knowledge that may be stale.\n\nWhen conflicts occur, do not silently override\nAGENTS.md. Verify or ask the user."
    assert.equal(tools.get("memory_write")?.definition.description, expectedDescription)
    const paths: ConfigFilePaths = { rootDir: root, configPath: join(root, "config.json"), providerDatabasePath: join(root, "providers.sqlite"), workspaceDatabasePath: join(root, "workspace.sqlite"), metaDatabasePath: join(root, "meta.sqlite") }
    const global = new SessionRuntimeGlobal(paths, tools, renders)
    for (const definition of global.listToolDefinitions()) {
      const properties = definition.inputSchema.properties as Record<string, unknown>
      assert.equal("callDescription" in properties, false)
      assert.equal("projectId" in properties, false)
      assert.equal("path" in properties, false)
    }
    const readSchema = tools.get("memory_read")!.definition.inputSchema
    assert.deepEqual(readSchema.required, ["sections"])
    assert.deepEqual((readSchema.properties as Record<string, unknown>).limitPerSection, { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
    const execute = createExecuteToolCall(tools, renders)
    const context: ToolCallContext = { projectId: "default", turn: 1, step: 1, blockId: "block", toolCallId: "call", signal: new AbortController().signal }
    const path = join(root, "sessions", "default", "memory.md")
    assert.equal(code(await execute("memory_list", {}, { ...context, projectId: undefined })), "MEMORY_PROJECT_MISSING")
    assert.equal(code(await execute("memory_list", {}, { ...context, projectId: "../outside" })), "MEMORY_PROJECT_INVALID")
    assert.equal(code(await execute("memory_list", { projectId: "default" }, context)), "INVALID_TOOL_ARGUMENTS")
    assert.match(text(await execute("memory_list", {}, context)), /当前没有长期记忆/)
    assert.match(text(await execute("memory_write", { memories: [] }, context)), /成功写入 0 条/)
    await assert.rejects(lstat(path), { code: "ENOENT" })

    const memory = { level1: "偏好", level2: "交流", content: "优先使用中文。" }
    const written = await execute("memory_write", { memories: [memory, { ...memory, content: "用中文解释关键决策。" }] }, context)
    assert.equal(written.status, "success", text(written))
    assert.equal(text(written), "成功写入 2 条长期记忆：\n\n偏好 / 交流\n偏好 / 交流")
    assert.equal(text(written).includes(memory.content), false)
    assert.equal(text(await execute("memory_list", {}, context)), "工具调用成功，当前长期记忆结构如下：\n\n偏好\n  - 交流")
    const read = await execute("memory_read", { sections: [{ level1: "偏好", level2: ["交流", "缺失"] }], limitPerSection: 1 }, context)
    assert.equal(text(read), "偏好 / 交流\n\n[2026-10-09T01:02:03.004Z]\n用中文解释关键决策。\n\n[More memories available in this section.]\n\n偏好 / 缺失\n\n当前分类没有长期记忆。")
    assert.equal((text(await execute("memory_read", { sections: [{ level1: "偏好", level2: ["交流"] }] }, context)).match(/\[2026/g) ?? []).length, 2)
    assert.equal(text(await execute("memory_read", { sections: [] }, context)), "未请求任何记忆分类。")

    const before = await readFile(path, "utf8")
    for (const args of [{}, { memories: null }, { memories: [memory, { ...memory, content: "# 冲突" }] }, { memories: [{ ...memory, extra: true }] }, { memories: [memory], path: path }, { memories: [{ ...memory, createdAt: "model-time" }] }, { memories: [memory], callDescription: 1 }]) {
      assert.equal(code(await execute("memory_write", args, context)), "INVALID_TOOL_ARGUMENTS")
    }
    for (const args of [{}, { sections: null }, { sections: [{ level1: "偏好", level2: "交流" }] }, { sections: [{ level1: "\n", level2: [] }] }, { sections: [], limitPerSection: 0 }, { sections: [], limitPerSection: null }]) {
      assert.equal(code(await execute("memory_read", args, context)), "INVALID_TOOL_ARGUMENTS")
    }
    assert.equal(await readFile(path, "utf8"), before)
    const cancelled = new AbortController(); cancelled.abort()
    for (const [name, args] of [["memory_list", {}], ["memory_read", { sections: [] }], ["memory_write", { memories: [memory] }]] as const) assert.equal(code(await execute(name, args, { ...context, signal: cancelled.signal })), "CANCELLED")
    await writeFile(path, "损坏的文件")
    const failed = await execute("memory_write", { memories: [memory] }, context)
    assert.equal(code(failed), "MEMORY_FORMAT_INVALID")
    assert.match(text(failed), /memory\.md/)
    assert.equal(text(failed).includes(memory.content), false)
    const error = { source: "tool" as const, code: "TEST_ERROR", message: "测试错误", details: { stack: "internal stack" } }
    for (const render of [renderMemoryList, renderMemoryRead, renderMemoryWrite]) {
      const result = render(error)
      assert.equal(result.status, "error")
      assert.equal(text(result), "TEST_ERROR: 测试错误")
    }
    console.log("memory-tools.test.ts: Schema、原文提示词、参数和 render 通过")
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
