/**
 * 验证 skill_load 的参数、实时启用检查、完整正文和结果呈现。
 *
 * 测试通过真实工具注册与执行入口检查成功和错误分支。
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { SkillManager } from "../../skill/src/index.ts"
import { estimateLocalTokens } from "../../../src/main/token-estimator.ts"
import { createExecuteToolCall, registerSkillTools, RenderRegistry, ToolRegistry, toolScheduleGroup } from "../src/index.ts"
import type { ToolCallContext, ToolResult } from "../src/types.ts"

/**
 * 从工具结果中提取失败错误码。
 *
 * @param result 待检查的工具执行结果。
 * @returns 失败时的错误码；成功结果返回 undefined。
 */
function code(result: ToolResult) { return result.status === "error" ? result.error.code : undefined }

/**
 * 执行 skill_load 的工具契约验证。
 *
 * @returns 所有验证完成后兑现的 Promise。
 * @throws AssertionError 工具参数、权限、结果或错误处理不符合预期时抛出；文件系统错误也会向上传递。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-skill-tools-"))
  try {
    await mkdir(join(root, "skills", "review"), { recursive: true })
    const full = `---\ndescription: Review\n---\n${"正文".repeat(10000)}`
    const path = join(root, "skills", "review", "SKILL.md")
    await writeFile(path, full)
    const manager = new SkillManager(root, estimateLocalTokens)
    await manager.resolveSkills("default")
    const tools = new ToolRegistry(), renders = new RenderRegistry()
    registerSkillTools(tools, renders, manager)
    assert.equal(toolScheduleGroup("skill_load"), "shared")
    assert.deepEqual(tools.listDefinitions()[0].inputSchema.required, ["name"])
    assert.throws(() => registerSkillTools(tools, renders, manager), /重复|已/)
    const execute = createExecuteToolCall(tools, renders)
    const context: ToolCallContext = { projectId: "default", turn: 1, step: 1, blockId: "block", toolCallId: "call", signal: new AbortController().signal }
    for (const args of [{}, { name: "" }, { name: 1 }, { name: "review", path }, { name: "review", callDescription: 1 }]) assert.equal(code(await execute("skill_load", args, context)), "INVALID_TOOL_ARGUMENTS")
    assert.equal(code(await execute("skill_load", { name: "review" }, { ...context, projectId: undefined })), "SKILL_PROJECT_INVALID")
    const registryPath = join(root, "skills", "registry.json")
    const before = await readFile(registryPath, "utf8")
    const result = await execute("skill_load", { name: "review", callDescription: "载入审查规则" }, context)
    assert.equal(result.status, "success")
    assert.equal(result.content[0].type, "text")
    assert.ok(JSON.stringify(result.content).includes(full.slice(-100)))
    assert.equal(result.content[0].type === "text" && result.content[0].text, `Skill: review\nScope: global\n\n${full}`)
    assert.equal(await readFile(registryPath, "utf8"), before, "工具全程只读")
    const registry = JSON.parse(before); registry.skills[0].enabled = false
    await writeFile(registryPath, JSON.stringify(registry))
    assert.equal(code(await execute("skill_load", { name: "review" }, context)), "SKILL_DISABLED")
    const missing = await execute("skill_load", { name: "missing" }, context)
    assert.equal(code(missing), "SKILL_NOT_FOUND")
    assert.match(JSON.stringify(missing.content), /Skill not found/)
    const aborted = new AbortController(); aborted.abort()
    assert.equal(code(await execute("skill_load", { name: "review" }, { ...context, signal: aborted.signal })), "CANCELLED")
    registry.skills[0].enabled = true
    await writeFile(registryPath, JSON.stringify(registry))
    await rm(path)
    assert.equal(code(await execute("skill_load", { name: "review" }, context)), "SKILL_NOT_FOUND")
    await mkdir(path)
    assert.equal(code(await execute("skill_load", { name: "review" }, context)), "SKILL_LOAD_FAILED")
    await writeFile(registryPath, "bad json")
    assert.equal(code(await execute("skill_load", { name: "review" }, context)), "SKILL_LOAD_FAILED")
    assert.equal(await readFile(registryPath, "utf8"), "bad json")
    console.log("skill-tools.test.ts: 参数、实时启用检查、取消和完整结果通过")
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
