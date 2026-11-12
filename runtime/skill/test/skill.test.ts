/**
 * 验证 Skill 来源同步、错误保留、元信息截断和实时读取。
 *
 * 测试使用临时目录与现有本地 Token 估算器，不连接外部服务。
 */
import assert from "node:assert/strict"
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { SkillManager, initializeSkillSource, synchronizeSkillSource, buildSkillContext } from "../src/index.ts"
import { estimateLocalTokens } from "../../../src/main/token-estimator.ts"

const PROJECT = "00000000-0000-4000-8000-000000000001"

/**
 * 在来源目录中写入指定 Skill 文件。
 *
 * @param source Global 或 Project Skill 来源目录。
 * @param name 要创建的 Skill 文件夹名。
 * @param description 写入 YAML frontmatter 的描述。
 * @returns 写入的完整 SKILL.md 文本。
 * @throws 文件夹或 SKILL.md 无法创建时传递文件系统异常。
 */
async function skill(source: string, name: string, description: string): Promise<string> {
  await mkdir(join(source, name), { recursive: true })
  const content = `---\nname: ignored-yaml-name\ndescription: ${JSON.stringify(description)}\n---\n完整正文\n${"body".repeat(1000)}`
  await writeFile(join(source, name, "SKILL.md"), content)
  return content
}

/**
 * 执行本文件内的 Skill 来源和上下文验证。
 *
 * @returns 所有验证完成后兑现的 Promise。
 * @throws AssertionError 行为与 Skill 来源或元信息契约不符时抛出；文件系统错误也会向上传递。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "minou-skill-"))
  try {
    const global = join(root, "skills"), project = join(root, "sessions", PROJECT, "skills")
    await mkdir(join(root, "sessions", PROJECT), { recursive: true })
    await initializeSkillSource(global)
    const registryPath = join(global, "registry.json")
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { version: 1, skills: [] })
    await writeFile(registryPath, "invalid")
    await initializeSkillSource(global)
    assert.equal(await readFile(registryPath, "utf8"), "invalid", "存在检查不解析或覆盖配置")
    const full = await skill(global, "review", "Global description")
    await mkdir(join(global, "no-definition"))
    let registry = await synchronizeSkillSource(global, "global")
    assert.equal(registry.skills.length, 2, "扫描不要求 SKILL.md 合法")
    assert.ok(registry.skills.every((item) => item.enabled))
    registry.skills.find((item) => item.name === "no-definition")!.enabled = false
    registry.skills.find((item) => item.name === "review")!.path = join(root, "outdated", "review")
    await writeFile(registryPath, JSON.stringify(registry))
    registry = await synchronizeSkillSource(global, "global")
    assert.equal(registry.skills.find((item) => item.name === "review")!.path, join(global, "review"))
    const preserved = await readFile(registryPath, "utf8")
    await Promise.all(Array.from({ length: 6 }, () => synchronizeSkillSource(global, "global")))
    assert.equal(await readFile(registryPath, "utf8"), preserved)
    const originalReaddir = fs.readdir
    try {
      fs.readdir = (async () => { throw new Error("injected scan failure") }) as typeof fs.readdir
      syncBuiltinESMExports()
      await assert.rejects(synchronizeSkillSource(global, "global"), /无法同步/)
    } finally { fs.readdir = originalReaddir; syncBuiltinESMExports() }
    assert.equal(await readFile(registryPath, "utf8"), preserved)
    await skill(global, "added", "New description")
    const originalRename = fs.rename
    try {
      fs.rename = async () => { throw new Error("injected save failure") }
      syncBuiltinESMExports()
      await assert.rejects(synchronizeSkillSource(global, "global"), /无法同步/)
    } finally { fs.rename = originalRename; syncBuiltinESMExports() }
    assert.equal(await readFile(registryPath, "utf8"), preserved)
    assert.equal((await fs.readdir(global)).some((name) => name.endsWith(".tmp")), false)
    await rm(join(global, "no-definition"), { recursive: true })
    registry = await synchronizeSkillSource(global, "global")
    assert.deepEqual(registry.skills.map((item) => item.name), ["added", "review"])

    const manager = new SkillManager(root, estimateLocalTokens)
    const globalContext = await manager.resolveSkills("default")
    assert.ok(globalContext.entries.some((entry) => entry.name === "review"))
    assert.equal((await manager.loadSkill("default", "review")).content, full)
    await initializeSkillSource(project)
    await skill(project, "review", "Project description")
    await synchronizeSkillSource(project, "project")
    const projectContext = await manager.resolveSkills(PROJECT)
    assert.equal(projectContext.entries.find((item) => item.name === "review")!.scope, "project")
    const localRegistry = JSON.parse(await readFile(join(project, "registry.json"), "utf8"))
    localRegistry.skills[0].enabled = false
    await writeFile(join(project, "registry.json"), JSON.stringify(localRegistry))
    assert.equal((await manager.resolveSkills(PROJECT)).entries.some((item) => item.name === "review"), false)
    await assert.rejects(manager.loadSkill(PROJECT, "review"), { code: "SKILL_DISABLED" })
    assert.equal((await manager.loadSkill("default", "review")).scope, "global")
    await assert.rejects(manager.loadSkill("default", "../review"), { code: "SKILL_NOT_FOUND" })
    await rm(join(global, "review", "SKILL.md"))
    await assert.rejects(manager.loadSkill("default", "review"), { code: "SKILL_NOT_FOUND" })
    await assert.rejects(manager.resolveSkills("default"), /SKILL.md/)
    await writeFile(join(global, "review", "SKILL.md"), "invalid frontmatter")
    await assert.rejects(manager.resolveSkills("default"), /frontmatter/)
    await writeFile(join(global, "review", "SKILL.md"), "---\ndescription: []\n---\n")
    await assert.rejects(manager.resolveSkills("default"), /description/)
    await assert.rejects(initializeSkillSource(join(root, "missing-parent", "skills")), /ENOENT/)

    const single = buildSkillContext([{ name: "完整名称", path: global, scope: "global", description: "😀".repeat(2000) }], estimateLocalTokens)
    assert.equal(single.entries[0].name, "完整名称")
    assert.ok(single.entries[0].estimatedTokens <= 500)
    assert.ok(single.descriptions["完整名称"].endsWith("..."))
    assert.equal(single.descriptions["完整名称"].includes("\uFFFD"), false)
    const boundary = buildSkillContext([{ name: "a", path: global, scope: "global", description: "b".repeat(1999) }], estimateLocalTokens)
    assert.equal(boundary.descriptions.a.length, 1999)
    const many = buildSkillContext(Array.from({ length: 100 }, (_, i) => ({ name: `skill-${i}`, path: join(global, String(i)), scope: "global" as const, description: "a".repeat(5000) })), estimateLocalTokens)
    assert.equal(many.entries.length, 100)
    assert.equal(many.entries.reduce((sum, item) => sum + item.estimatedTokens, 0), 50000)
    console.log("skill.test.ts: registry 同步、失败保留、来源隔离和单条上限通过")
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
