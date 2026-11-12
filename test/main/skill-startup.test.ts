/**
 * 验证启动时为 Global 和所有已登记 Project 补齐并同步 Skill 来源。
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { initializeConfigFiles } from "../../src/main/config-files.ts"
import { insertProjectWorkspace } from "../../src/main/workspace-store.ts"

/**
 * 执行启动补齐、registry 修复和重复初始化验证。
 *
 * @returns 所有启动配置验证完成后兑现的 Promise。
 * @throws AssertionError 启动来源维护不符合预期时抛出；初始化和文件系统错误也会向上传递。
 */
async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "minou-skill-startup-"))
  try {
    const paths = await initializeConfigFiles(profile)
    const projectId = "00000000-0000-4000-8000-000000000001"
    const directory = join(paths.rootDir, "sessions", projectId)
    await mkdir(join(directory, "workspace"), { recursive: true })
    insertProjectWorkspace(paths.workspaceDatabasePath, { id: projectId, version: 1, name: "Skill", updatedAt: "2026-10-18T00:00:00Z", directories: [], sessions: [] })
    await initializeConfigFiles(profile)
    const registryPath = join(directory, "skills", "registry.json")
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { version: 1, skills: [] })
    await mkdir(join(directory, "skills", "no-definition"))
    await writeFile(registryPath, "broken json")
    await initializeConfigFiles(profile)
    const registry = JSON.parse(await readFile(registryPath, "utf8"))
    assert.deepEqual(registry.skills, [{ name: "no-definition", path: join(directory, "skills", "no-definition"), scope: "project", enabled: true }])
    registry.skills[0].enabled = false
    await writeFile(registryPath, JSON.stringify(registry))
    await initializeConfigFiles(profile)
    assert.equal(JSON.parse(await readFile(registryPath, "utf8")).skills[0].enabled, false)
    await assert.rejects(readFile(join(paths.rootDir, "sessions", "default", "skills", "registry.json")), { code: "ENOENT" })
    await rm(directory, { recursive: true })
    await assert.rejects(initializeConfigFiles(profile), /ENOENT/)
    await assert.rejects(readFile(registryPath), { code: "ENOENT" })
    console.log("skill-startup.test.ts: 启动补齐全部来源、损坏重建和 default 边界通过")
  } finally {
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
