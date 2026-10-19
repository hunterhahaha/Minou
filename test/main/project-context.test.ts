/**
 * 验证 Project workspace、AGENTS.md 和 Skill 固定上下文解析。
 *
 * Skill 名称取自文件夹，来源 registry 由实际目录扫描同步。
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { SkillManager } from "../../runtime/skill/src/index.ts"
import { resolveProjectContext } from "../../src/main/project-context.ts"
import { estimateLocalTokens } from "../../src/main/token-estimator.ts"
import { initializeWorkspaceDatabase, saveProjectWorkspace } from "../../src/main/workspace-store.ts"

const PROJECT_ID = "00000000-0000-4000-8000-000000000017"

/** 在临时 `.nicode` 根目录运行测试并安全清理。 */
async function withTempRoot(test: (root: string) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "nicode-project-context-"))
  try {
    const root = join(profile, ".nicode")
    await mkdir(join(root, "skills"), { recursive: true })
    await test(root)
  } finally {
    assert.ok(resolve(profile).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(profile, { recursive: true, force: true })
  }
}

/** 建立 Project 分组目录和对应的数据库配置。 */
async function createProject(
  root: string,
  directories: readonly string[] = [],
): Promise<string> {
  const projectDirectory = join(root, "sessions", String(PROJECT_ID))
  await mkdir(join(projectDirectory, "workspace"), { recursive: true })
  const databasePath = join(root, "workspace.sqlite")
  initializeWorkspaceDatabase(databasePath)
  saveProjectWorkspace(databasePath, {
    version: 1,
    id: PROJECT_ID,
    name: "NiCode",
    updatedAt: "2026-09-23T00:00:00.000Z",
    directories: [...directories],
    sessions: [],
  })
  return projectDirectory
}

/**
 * 写入一个文件夹名与 YAML name 不同的 Skill。
 *
 * @param sourceDirectory Skill 来源目录。
 * @param directoryName Skill 文件夹名，也是运行时使用的 Skill 名称。
 * @param name 写入 frontmatter 的 YAML name，用于验证它不决定 Skill 身份。
 * @param description 写入 frontmatter 的 Skill 描述。
 * @returns 文件写入完成后兑现的 Promise。
 * @throws 文件夹或 SKILL.md 无法创建时抛出文件系统异常。
 */
async function writeSkill(
  sourceDirectory: string,
  directoryName: string,
  name: string,
  description: string,
): Promise<void> {
  const directory = join(sourceDirectory, directoryName)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill body.\n`,
  )
}

/** 写入一个来源目录的 Skill registry。 */
async function writeRegistry(
  sourceDirectory: string,
  scope: "global" | "project",
  skills: Array<{ name: string; enabled: boolean }>,
): Promise<void> {
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, "registry.json"), JSON.stringify({
    version: 1,
    skills: skills.map((skill) => ({ ...skill, path: join(sourceDirectory, skill.name), scope })),
  }))
}

/**
 * 验证工作区路径、AGENTS.md、文件夹身份和 Project 覆盖后的完整基线。
 *
 * @returns 所有固定上下文断言完成后兑现的 Promise。
 * @throws 断言失败或临时文件读写失败时抛出。
 */
async function testResolvesWorkspaceAgentsAndSkills(): Promise<void> {
  await withTempRoot(async (root) => {
    const associatedDirectory = join(root, "associated-worktree")
    await mkdir(associatedDirectory)
    await writeFile(join(associatedDirectory, "AGENTS.md"), "Always verify changes.\n")
    const projectDirectory = await createProject(root, [associatedDirectory])

    const globalSkills = join(root, "skills")
    await writeSkill(globalSkills, "review", "yaml-review", "Review every change")
    await writeSkill(globalSkills, "global-only", "yaml-global", "Use the global workflow")
    await writeRegistry(globalSkills, "global", [
      { name: "review", enabled: true },
      { name: "global-only", enabled: true },
    ])

    const projectSkills = join(projectDirectory, "skills")
    await writeSkill(projectSkills, "review", "yaml-project", "Use the project review rules")
    await writeSkill(projectSkills, "disabled", "yaml-disabled", "Do not expose this")
    await writeRegistry(projectSkills, "project", [
      { name: "review", enabled: true },
      { name: "disabled", enabled: false },
    ])

    const context = resolveProjectContext({
      rootDirectory: root,
      skillManager: new SkillManager(root, estimateLocalTokens),
    }, PROJECT_ID)
    assert.ok(context.workspaceInfo.includes(`"cwd": "${associatedDirectory.replaceAll("\\", "\\\\")}"`))
    assert.ok(context.workspaceInfo.includes(`"projectId": "${PROJECT_ID}"`))

    const baseline = await context.resolveCurrentBaseline()
    assert.equal(baseline.agentsmd.path, join(associatedDirectory, "AGENTS.md"))
    assert.equal(baseline.agentsmd.content, "Always verify changes.\n")
    assert.equal(
      baseline.agentsmd.hash,
      createHash("sha256").update("Always verify changes.\n").digest("hex"),
    )
    assert.deepEqual(baseline.skills.entries.slice().sort((a, b) => a.name.localeCompare(b.name)), [{
      name: "review",
      path: join(projectSkills, "review"),
      scope: "project",
      enabled: true,
      estimatedTokens: estimateLocalTokens("reviewUse the project review rules"),
    }, {
      name: "global-only",
      path: join(globalSkills, "global-only"),
      scope: "global",
      enabled: true,
      estimatedTokens: estimateLocalTokens("global-onlyUse the global workflow"),
    }].sort((a, b) => a.name.localeCompare(b.name)))
    assert.deepEqual(baseline.skills.descriptions, {
      review: "Use the project review rules",
      "global-only": "Use the global workflow",
    })
    assert.ok(baseline.skills.content.includes("Use the project review rules"))
    assert.equal(baseline.skills.content.includes("Review every change"), false)
    assert.equal(baseline.skills.content.includes("Do not expose this"), false)
    assert.deepEqual(baseline.mcp, [])
  })
}

/**
 * 验证 Project 中禁用的 Skill 会按文件夹名屏蔽同名 Global Skill。
 *
 * @returns 来源覆盖断言完成后兑现的 Promise。
 * @throws 断言失败或临时文件读写失败时抛出。
 */
async function testProjectDisabledSkillSuppressesGlobal(): Promise<void> {
  await withTempRoot(async (root) => {
    const projectDirectory = await createProject(root)
    await writeSkill(join(root, "skills"), "review", "yaml-global", "Global review")
    await writeRegistry(join(root, "skills"), "global", [{ name: "review", enabled: true }])
    await writeSkill(join(projectDirectory, "skills"), "review", "yaml-project", "Project review")
    await writeRegistry(join(projectDirectory, "skills"), "project", [{ name: "review", enabled: false }])

    const baseline = await resolveProjectContext({
      rootDirectory: root,
      skillManager: new SkillManager(root, estimateLocalTokens),
    }, PROJECT_ID).resolveCurrentBaseline()
    assert.deepEqual(baseline.skills, { content: "", entries: [], descriptions: {} })
    assert.equal(baseline.agentsmd.content, "")
  })
}

/**
 * 验证缺失的 Project 数据库记录报错，损坏的 Skill registry 按目录重建。
 *
 * @returns Project 配置和 Skill registry 断言完成后兑现的 Promise。
 * @throws 断言失败或临时数据库、文件操作失败时抛出。
 */
async function testRejectsInvalidProjectAndSkillConfiguration(): Promise<void> {
  await withTempRoot(async (root) => {
    const projectDirectory = await createProject(root)
    const workspacePath = join(projectDirectory, "workspace.json")
    await writeFile(workspacePath, "旧文件不是有效 JSON")
    const databasePath = join(root, "workspace.sqlite")
    const options = {
      rootDirectory: root,
      skillManager: new SkillManager(root, estimateLocalTokens),
    }
    assert.ok(resolveProjectContext(options, PROJECT_ID).workspaceInfo.includes('"projectName": "NiCode"'))
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare("DELETE FROM workspace_groups WHERE group_id = ?").run(String(PROJECT_ID))
    } finally {
      db.close()
    }
    assert.throws(() => resolveProjectContext(options, PROJECT_ID), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes("项目损坏"))
      assert.ok(error.message.includes(databasePath))
      return true
    })

    saveProjectWorkspace(databasePath, {
      version: 1,
      id: PROJECT_ID,
      name: "NiCode",
      updatedAt: "2026-09-23T00:00:00.000Z",
      directories: [],
      sessions: [],
    })
    assert.equal(await readFile(workspacePath, "utf8"), "旧文件不是有效 JSON")
    const globalSkills = join(root, "skills")
    await writeSkill(globalSkills, "folder-name", "different-yaml-name", "Description")
    await writeFile(join(globalSkills, "registry.json"), "invalid json")
    const repaired = await resolveProjectContext(options, PROJECT_ID).resolveCurrentBaseline()
    assert.equal(repaired.skills.entries[0].name, "folder-name")
    assert.equal(repaired.skills.entries[0].path, join(globalSkills, "folder-name"))
    assert.equal(JSON.parse(await readFile(join(globalSkills, "registry.json"), "utf8")).skills[0].enabled, true)
  })
}

/** 数据库配置存在时仍要求 Project 和内置 workspace 目录可用。 */
async function testRequiresProjectDirectories(): Promise<void> {
  await withTempRoot(async (root) => {
    const projectDirectory = await createProject(root)
    const options = {
      rootDirectory: root,
      skillManager: new SkillManager(root, estimateLocalTokens),
    }
    await rm(join(projectDirectory, "workspace"), { recursive: true })
    assert.throws(() => resolveProjectContext(options, PROJECT_ID), /Project workspace 目录/)
    await rm(projectDirectory, { recursive: true })
    assert.throws(() => resolveProjectContext(options, PROJECT_ID), /Project 配置目录/)
  })
}

/** default 使用内置 workspace 和 Global Skill，不读取 Project Skill。 */
async function testDefaultContext(): Promise<void> {
  await withTempRoot(async (root) => {
    const workspace = join(root, "sessions", "default", "workspace")
    await mkdir(workspace, { recursive: true })
    initializeWorkspaceDatabase(join(root, "workspace.sqlite"))
    await writeSkill(join(root, "skills"), "global-skill", "yaml-global", "Global description")
    await writeRegistry(join(root, "skills"), "global", [{ name: "global-skill", enabled: true }])
    await writeSkill(join(root, "sessions", "default", "skills"), "project-skill", "yaml-project", "Ignore")
    await writeRegistry(join(root, "sessions", "default", "skills"), "project", [
      { name: "project-skill", enabled: true },
    ])
    const context = resolveProjectContext({
      rootDirectory: root, skillManager: new SkillManager(root, estimateLocalTokens),
    }, "default")
    assert.ok(context.workspaceInfo.includes('"projectId": "default"'))
    assert.ok(context.workspaceInfo.includes(`"cwd": "${workspace.replaceAll("\\", "\\\\")}"`))
    const current = await context.resolveCurrentBaseline()
    assert.deepEqual(current.skills.entries.map((entry) => entry.name), ["global-skill"])
    assert.equal(current.skills.content.includes("project-skill"), false)
    assert.equal(current.agentsmd.path, join(workspace, "AGENTS.md"))
  })
}

/** 验证 Token 粗估边界。 */
function testTokenEstimator(): void {
  assert.equal(estimateLocalTokens(""), 0)
  assert.equal(estimateLocalTokens("a"), 1)
  assert.equal(estimateLocalTokens("abcd"), 1)
  assert.equal(estimateLocalTokens("abcde"), 2)
}

/** 依次运行 Project Context 的全部断言。 */
async function main(): Promise<void> {
  await testResolvesWorkspaceAgentsAndSkills()
  await testProjectDisabledSkillSuppressesGlobal()
  await testRejectsInvalidProjectAndSkillConfiguration()
  await testRequiresProjectDirectories()
  await testDefaultContext()
  testTokenEstimator()
  console.log("project-context.test.ts: Project 与 Skill baseline 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
