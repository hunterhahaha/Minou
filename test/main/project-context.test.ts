/** Project workspace、AGENTS.md 与 YAML Skill baseline 的测试。 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createProjectContextResolver } from "../../src/main/project-context.ts"
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

/** 写入一个目录名与 YAML name 无关的 Skill。 */
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
    skills: skills.map((skill) => ({ ...skill, scope })),
  }))
}

/** 验证工作区路径、AGENTS.md、YAML 身份和 Project 覆盖的完整 baseline。 */
async function testResolvesWorkspaceAgentsAndSkills(): Promise<void> {
  await withTempRoot(async (root) => {
    const associatedDirectory = join(root, "associated-worktree")
    await mkdir(associatedDirectory)
    await writeFile(join(associatedDirectory, "AGENTS.md"), "Always verify changes.\n")
    const projectDirectory = await createProject(root, [associatedDirectory])

    const globalSkills = join(root, "skills")
    await writeSkill(globalSkills, "directory-does-not-match", "review", "Review every change")
    await writeSkill(globalSkills, "second-directory", "global-only", "Use the global workflow")
    await writeRegistry(globalSkills, "global", [
      { name: "review", enabled: true },
      { name: "global-only", enabled: true },
    ])

    const projectSkills = join(projectDirectory, "skills")
    await writeSkill(projectSkills, "project-folder", "review", "Use the project review rules")
    await writeSkill(projectSkills, "disabled-folder", "disabled", "Do not expose this")
    await writeRegistry(projectSkills, "project", [
      { name: "review", enabled: true },
      { name: "disabled", enabled: false },
    ])

    const resolver = createProjectContextResolver({
      rootDirectory: root,
      estimateSkillTokens: estimateLocalTokens,
    })
    const context = resolver(PROJECT_ID)
    assert.ok(context.workspaceInfo.includes(`"cwd": "${associatedDirectory.replaceAll("\\", "\\\\")}"`))
    assert.ok(context.workspaceInfo.includes(`"projectId": "${PROJECT_ID}"`))

    const baseline = await context.resolveCurrentBaseline()
    assert.equal(baseline.agentsmd.path, join(associatedDirectory, "AGENTS.md"))
    assert.equal(baseline.agentsmd.content, "Always verify changes.\n")
    assert.equal(
      baseline.agentsmd.hash,
      createHash("sha256").update("Always verify changes.\n").digest("hex"),
    )
    assert.deepEqual(baseline.skills.entries, [{
      name: "review",
      scope: "project",
      enabled: true,
      estimatedTokens: estimateLocalTokens("Use the project review rules"),
    }, {
      name: "global-only",
      scope: "global",
      enabled: true,
      estimatedTokens: estimateLocalTokens("Use the global workflow"),
    }])
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

/** 验证 Project disabled Skill 会按 YAML name 屏蔽同名 Global Skill。 */
async function testProjectDisabledSkillSuppressesGlobal(): Promise<void> {
  await withTempRoot(async (root) => {
    const projectDirectory = await createProject(root)
    await writeSkill(join(root, "skills"), "global-folder", "review", "Global review")
    await writeRegistry(join(root, "skills"), "global", [{ name: "review", enabled: true }])
    await writeSkill(join(projectDirectory, "skills"), "project-folder", "review", "Project review")
    await writeRegistry(join(projectDirectory, "skills"), "project", [{ name: "review", enabled: false }])

    const baseline = await createProjectContextResolver({
      rootDirectory: root,
      estimateSkillTokens: estimateLocalTokens,
    })(PROJECT_ID).resolveCurrentBaseline()
    assert.deepEqual(baseline.skills, { content: "", entries: [], descriptions: {} })
    assert.equal(baseline.agentsmd.content, "")
  })
}

/** 验证缺失数据库记录和 registry 的无效 YAML 引用。 */
async function testRejectsInvalidProjectAndSkillConfiguration(): Promise<void> {
  await withTempRoot(async (root) => {
    const projectDirectory = await createProject(root)
    const workspacePath = join(projectDirectory, "workspace.json")
    await writeFile(workspacePath, "旧文件不是有效 JSON")
    const databasePath = join(root, "workspace.sqlite")
    const resolver = createProjectContextResolver({
      rootDirectory: root,
      estimateSkillTokens: estimateLocalTokens,
    })
    assert.ok(resolver(PROJECT_ID).workspaceInfo.includes('"projectName": "NiCode"'))
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare("DELETE FROM workspace_groups WHERE group_id = ?").run(String(PROJECT_ID))
    } finally {
      db.close()
    }
    assert.throws(() => resolver(PROJECT_ID), (error: unknown) => {
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
    await writeSkill(globalSkills, "unrelated-directory", "actual-yaml-name", "Description")
    await writeRegistry(globalSkills, "global", [{ name: "registry-name", enabled: true }])
    await assert.rejects(
      resolver(PROJECT_ID).resolveCurrentBaseline(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(join(globalSkills, "registry.json")))
        assert.ok(error.message.includes("registry-name"))
        return true
      },
    )
  })
}

/** 数据库配置存在时仍要求 Project 和内置 workspace 目录可用。 */
async function testRequiresProjectDirectories(): Promise<void> {
  await withTempRoot(async (root) => {
    const projectDirectory = await createProject(root)
    const resolver = createProjectContextResolver({
      rootDirectory: root,
      estimateSkillTokens: estimateLocalTokens,
    })
    await rm(join(projectDirectory, "workspace"), { recursive: true })
    assert.throws(() => resolver(PROJECT_ID), /Project workspace 目录/)
    await rm(projectDirectory, { recursive: true })
    assert.throws(() => resolver(PROJECT_ID), /Project 配置目录/)
  })
}

/** default 使用内置 workspace 和 Global Skill，不读取 Project Skill。 */
async function testDefaultContext(): Promise<void> {
  await withTempRoot(async (root) => {
    const workspace = join(root, "sessions", "default", "workspace")
    await mkdir(workspace, { recursive: true })
    initializeWorkspaceDatabase(join(root, "workspace.sqlite"))
    await writeSkill(join(root, "skills"), "global-folder", "global-skill", "Global description")
    await writeRegistry(join(root, "skills"), "global", [{ name: "global-skill", enabled: true }])
    await writeSkill(join(root, "sessions", "default", "skills"), "project-folder", "project-skill", "Ignore")
    await writeRegistry(join(root, "sessions", "default", "skills"), "project", [
      { name: "project-skill", enabled: true },
    ])
    const context = createProjectContextResolver({
      rootDirectory: root, estimateSkillTokens: estimateLocalTokens,
    })("default")
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
