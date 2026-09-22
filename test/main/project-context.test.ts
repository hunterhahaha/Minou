/** Project workspace、AGENTS.md 与 YAML Skill baseline 的测试。 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

import { createProjectContextResolver } from "../../src/main/project-context.ts"
import { estimateLocalTokens } from "../../src/main/token-estimator.ts"

const PROJECT_ID = 17

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

/** 建立一个符合 V1 的 Project 分组。 */
async function createProject(
  root: string,
  directories: readonly string[] = [],
): Promise<string> {
  const projectDirectory = join(root, "sessions", String(PROJECT_ID))
  await mkdir(join(projectDirectory, "workspace"), { recursive: true })
  await writeFile(join(projectDirectory, "workspace.json"), JSON.stringify({
    version: 1,
    id: PROJECT_ID,
    name: "NiCode",
    directories,
    sessions: [],
  }))
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
    assert.ok(context.workspaceInfo.includes(`"projectId": ${PROJECT_ID}`))

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

/** 验证 workspace 身份错误和 registry 的无效 YAML 引用包含对应文件路径。 */
async function testRejectsInvalidProjectAndSkillConfiguration(): Promise<void> {
  await withTempRoot(async (root) => {
    const projectDirectory = await createProject(root)
    const workspacePath = join(projectDirectory, "workspace.json")
    await writeFile(workspacePath, JSON.stringify({
      version: 1,
      id: PROJECT_ID + 1,
      name: "Wrong",
      directories: [],
      sessions: [],
    }))
    const resolver = createProjectContextResolver({
      rootDirectory: root,
      estimateSkillTokens: estimateLocalTokens,
    })
    assert.throws(() => resolver(PROJECT_ID), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(String(PROJECT_ID)))
      assert.ok(error.message.includes(workspacePath))
      return true
    })

    await writeFile(workspacePath, JSON.stringify({
      version: 1,
      id: PROJECT_ID,
      name: "NiCode",
      directories: [],
      sessions: [],
    }))
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
  testTokenEstimator()
  console.log("project-context.test.ts: Project 与 Skill baseline 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
