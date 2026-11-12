/** 使用真实临时目录验证管理列表、启停持久化、并发与失败恢复。 */
import assert from "node:assert/strict"
import fs, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { SkillManager, synchronizeSkillSource } from "../src/index.ts"
import type { SkillTarget } from "../src/index.ts"

const PROJECT = "00000000-0000-4000-8000-000000000001"
const GLOBAL: SkillTarget = { scope: "global" }
const LOCAL: SkillTarget = { scope: "project", projectId: PROJECT }

/**
 * 创建有完整描述的技能夹具。
 * @param source 来源目录。
 * @param name 文件夹名。
 * @param description 原样写入 YAML 的描述。
 * @returns 文件写入完成。
 */
async function add(source: string, name: string, description: string): Promise<void> {
  await mkdir(join(source, name), { recursive: true })
  await writeFile(join(source, name, "SKILL.md"), `---\nname: ignored\ndescription: ${JSON.stringify(description)}\n---\n正文`)
}

/** @returns 管理与持久化场景全部完成。 @throws AssertionError 行为不符，或夹具 I/O 失败。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "minou-skill-management-"))
  try {
    const global = join(root, "skills"), local = join(root, "sessions", PROJECT, "skills")
    await mkdir(join(root, "sessions", PROJECT), { recursive: true })
    await add(global, "review", "完整描述".repeat(2000))
    await add(global, "second", "第二个技能")
    await add(local, "review", "项目描述")
    await mkdir(join(global, "broken"))
    const manager = new SkillManager(root, (text) => Math.ceil(text.length / 4))
    const listed = await manager.listSkills(GLOBAL)
    assert.deepEqual(listed.map((entry) => entry.name), ["broken", "review", "second"])
    assert.equal(listed[1].description, "完整描述".repeat(2000), "管理描述不截断")
    assert.match(listed[0].descriptionError!, /SKILL.md/)
    assert.equal(listed[0].description, undefined)
    assert.deepEqual((await manager.listSkills(LOCAL)).map(({ name, scope }) => ({ name, scope })), [{ name: "review", scope: "project" }])
    await manager.setSkillEnabled(GLOBAL, "broken", false)
    assert.equal((await manager.listSkills(GLOBAL))[0].enabled, false, "禁用项仍展示")
    await manager.setSkillEnabled(LOCAL, "review", false)
    assert.equal((await manager.resolveSkills(PROJECT)).entries.some((entry) => entry.name === "review"), false)
    await assert.rejects(manager.loadSkill(PROJECT, "review"), { code: "SKILL_DISABLED" })
    assert.equal((await manager.loadSkill("default", "review")).scope, "global")
    assert.equal((await new SkillManager(root, () => 1).listSkills(LOCAL))[0].enabled, false, "重建管理器后读回持久化状态")
    await manager.setSkillEnabled(LOCAL, "review", true)
    assert.equal((await manager.loadSkill(PROJECT, "review")).scope, "project")

    await Promise.all([
      manager.setSkillEnabled(GLOBAL, "review", false),
      synchronizeSkillSource(global, "global"),
      manager.setSkillEnabled(GLOBAL, "second", false),
      manager.listSkills(GLOBAL),
    ])
    assert.ok((await manager.listSkills(GLOBAL)).every((entry) => !entry.enabled), "扫描及不同技能的并发修改不丢失状态")
    const registryPath = join(global, "registry.json")
    const preserved = await readFile(registryPath, "utf8")
    const originalRename = fs.rename
    try {
      fs.rename = async () => { throw new Error("injected save failure") }
      syncBuiltinESMExports()
      await assert.rejects(manager.setSkillEnabled(GLOBAL, "review", true), /injected save failure/)
      assert.equal((await manager.setSkillEnabled(GLOBAL, "review", false)).enabled, false, "相同状态不写文件")
    } finally { fs.rename = originalRename; syncBuiltinESMExports() }
    assert.equal(await readFile(registryPath, "utf8"), preserved)
    assert.equal((await readdir(global)).some((name) => name.endsWith(".tmp")), false)
    await manager.setSkillEnabled(GLOBAL, "review", true)
    assert.equal((await manager.listSkills(GLOBAL)).find((entry) => entry.name === "review")!.enabled, true, "失败不阻塞后续请求")

    await assert.rejects(manager.setSkillEnabled(GLOBAL, "../review", false), TypeError)
    await assert.rejects(manager.setSkillEnabled(GLOBAL, "missing", false), /已不存在/)
    await assert.rejects(manager.setSkillEnabled(GLOBAL, "review", "false" as unknown as boolean), TypeError)
    await assert.rejects(manager.listSkills({ scope: "project", projectId: "default" }), TypeError)
    await assert.rejects(manager.listSkills({ scope: "project", projectId: "invalid" }), TypeError)
    await rm(join(global, "second"), { recursive: true })
    await assert.rejects(manager.setSkillEnabled(GLOBAL, "second", true))
    await writeFile(registryPath, "invalid")
    await assert.rejects(manager.setSkillEnabled(GLOBAL, "review", false), /配置内容无效/)
    assert.equal(await readFile(registryPath, "utf8"), "invalid", "启停请求不重建损坏配置")
    assert.equal((await manager.listSkills(GLOBAL)).length, 2, "显式列表扫描按既有规则重建")
    console.log("skill management: 单来源列表、描述隔离、启停、并发与失败恢复通过")
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
