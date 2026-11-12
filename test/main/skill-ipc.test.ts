/** Skill IPC 使用真实配置、项目登记与共享管理器验证输入和持久化边界。 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { SkillManager } from "../../runtime/skill/src/index.ts"
import { initializeConfigFiles } from "../../src/main/config-files.ts"
import { registerSkillIpcHandlers } from "../../src/main/skill-ipc.ts"
import { saveProjectWorkspace } from "../../src/main/workspace-store.ts"
import { createSessionApi, SKILL_IPC_CHANNELS } from "../../src/preload/session-api.ts"
import type { IpcMainHandlePort } from "../../src/main/session-ipc.ts"

const PROJECT = "00000000-0000-4000-8000-000000000001"
const MISSING = "00000000-0000-4000-8000-000000000002"

/** 保存真实 handler 并模拟 Renderer 的不可信输入。 */
class FakeIpc implements IpcMainHandlePort {
  /** 已注册的 channel 与其 handler。 */
  readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  /** @param channel 固定 channel。 @param listener 待调用的 handler。 @throws Error 重复注册。 */
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error("重复注册")
    this.handlers.set(channel, listener)
  }
  /** @param channel 固定 channel。 @param args 未知输入。 @returns handler 的结果。 @throws Error handler 拒绝。 */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> { return this.handlers.get(channel)!({}, ...args) }
}

/** @returns 输入校验、隔离、实时生效和失败恢复验证完成。 @throws AssertionError 行为不符。 */
async function main(): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "minou-skill-ipc-"))
  try {
    const paths = await initializeConfigFiles(profile)
    const manager = new SkillManager(paths.rootDir, () => 1)
    const ipc = new FakeIpc()
    registerSkillIpcHandlers(ipc, paths, manager)
    assert.deepEqual([...ipc.handlers.keys()], Object.values(SKILL_IPC_CHANNELS))
    const api = createSessionApi(ipc)
    assert.deepEqual(await api.listSkills({ scope: "global" }), [])
    await mkdir(join(paths.rootDir, "skills", "review"))
    await writeFile(join(paths.rootDir, "skills", "review", "SKILL.md"), "---\ndescription: Global\n---\n正文")
    saveProjectWorkspace(paths.workspaceDatabasePath, { version: 1, id: PROJECT, name: "项目", updatedAt: new Date().toISOString(), directories: [], sessions: [] })
    await mkdir(join(paths.rootDir, "sessions", PROJECT))
    await mkdir(join(paths.rootDir, "sessions", PROJECT, "skills", "review"), { recursive: true })
    const local = { scope: "project" as const, projectId: PROJECT }
    const localList = await api.listSkills(local)
    assert.equal(localList.length, 1)
    assert.equal(localList[0].scope, "project")
    assert.match(localList[0].descriptionError!, /SKILL.md/)
    await api.setSkillEnabled(local, "review", false)
    assert.equal((await api.listSkills(local))[0].enabled, false)
    assert.equal((await api.listSkills({ scope: "global" }))[0].enabled, true)
    await assert.rejects(manager.loadSkill(PROJECT, "review"), { code: "SKILL_DISABLED" })
    assert.equal((await manager.loadSkill("default", "review")).scope, "global")
    const registry = JSON.parse(await readFile(join(paths.rootDir, "sessions", PROJECT, "skills", "registry.json"), "utf8"))
    assert.equal(registry.skills[0].enabled, false)
    for (const invalid of [null, [], {}, { scope: "default" }, { scope: "project", projectId: "default" },
      { scope: "global", path: profile }, { scope: "project", projectId: "../escape" }, { scope: "project", projectId: MISSING }]) {
      await assert.rejects(ipc.invoke(SKILL_IPC_CHANNELS.listSkills, invalid))
      await assert.rejects(ipc.invoke(SKILL_IPC_CHANNELS.setSkillEnabled, invalid, "review", false))
    }
    await assert.rejects(stat(join(paths.rootDir, "sessions", MISSING)), { code: "ENOENT" })
    await assert.rejects(ipc.invoke(SKILL_IPC_CHANNELS.setSkillEnabled, local, "../review", true))
    await assert.rejects(ipc.invoke(SKILL_IPC_CHANNELS.setSkillEnabled, local, "review", "false"))
    await assert.rejects(ipc.invoke(SKILL_IPC_CHANNELS.setSkillEnabled, local, "missing", true))
    await rm(join(paths.rootDir, "sessions", PROJECT), { recursive: true })
    await assert.rejects(api.listSkills(local))
    await assert.rejects(stat(join(paths.rootDir, "sessions", PROJECT)), { code: "ENOENT" })
    console.log("skill-ipc: 来源隔离、登记检查、非法输入、启停持久化及实时权限通过")
  } finally {
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    await rm(profile, { recursive: true, force: true })
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
