/** 目录选择、Project 创建与关联目录变更的主进程 IPC 测试。 */

import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, parse, resolve, sep } from "node:path"

import { registerProjectIpcHandlers } from "../../src/main/project-ipc.ts"
import type { DirectoryDialogPort } from "../../src/main/project-ipc.ts"
import type { IpcMainHandlePort } from "../../src/main/session-ipc.ts"
import { initializeWorkspaceDatabase, readProjectWorkspace, saveProjectWorkspace } from "../../src/main/workspace-store.ts"
import { PROJECT_IPC_CHANNELS } from "../../src/preload/session-api.ts"
import type { ProjectSummary } from "../../src/preload/session-api.ts"

const UNKNOWN_PROJECT_ID = "00000000-0000-4000-8000-000000000099"

/** 保存测试中的 handler 并模拟 invoke。 */
class FakeIpcMain implements IpcMainHandlePort {
  readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

  /** @param channel 要注册的 channel。 @param listener 对应 handler。 */
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`重复注册：${channel}`)
    this.handlers.set(channel, listener)
  }

  /** @param channel 要调用的 channel。 @param args Renderer 参数。 @returns handler 结果。 */
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`未注册：${channel}`)
    return await handler({}, ...args) as T
  }
}

/** 覆盖选择、创建、变更及错误路径。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-project-ipc-"))
  try {
    const sessionsDirectory = join(root, "sessions")
    const firstDirectory = join(root, "first")
    const secondDirectory = join(root, "second")
    await mkdir(sessionsDirectory)
    await mkdir(firstDirectory)
    await mkdir(secondDirectory)
    const databasePath = join(root, "workspace.sqlite")
    initializeWorkspaceDatabase(databasePath)

    let selection: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
    const dialog: DirectoryDialogPort = {
      showOpenDialog: async (options) => {
        assert.deepEqual(options, { properties: ["openDirectory"] })
        return selection
      },
    }
    const ipc = new FakeIpcMain()
    registerProjectIpcHandlers(ipc, dialog, { rootDir: root, workspaceDatabasePath: databasePath })
    assert.deepEqual([...ipc.handlers.keys()], Object.values(PROJECT_IPC_CHANNELS))
    assert.equal(await ipc.invoke(PROJECT_IPC_CHANNELS.selectDirectory), null)
    selection = { canceled: false, filePaths: [firstDirectory] }
    assert.deepEqual(await ipc.invoke(PROJECT_IPC_CHANNELS.selectDirectory), {
      path: firstDirectory, name: "first",
    })
    const volumeRoot = parse(root).root
    selection = { canceled: false, filePaths: [volumeRoot] }
    assert.deepEqual(await ipc.invoke(PROJECT_IPC_CHANNELS.selectDirectory), {
      path: volumeRoot, name: volumeRoot,
    })

    const empty = await ipc.invoke<ProjectSummary>(PROJECT_IPC_CHANNELS.createProject, " Empty ")
    assert.equal(empty.name, "Empty")
    assert.deepEqual(empty.directories, [])
    assert.deepEqual(empty.sessions, [])
    assert.match(empty.projectId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/)
    assert.equal(new Date(empty.updatedAt).toISOString(), empty.updatedAt)
    assert.equal((await stat(join(sessionsDirectory, empty.projectId, "workspace"))).isDirectory(), true)
    assert.deepEqual(readProjectWorkspace(databasePath, empty.projectId).sessions, [])
    assert.deepEqual(JSON.parse(await readFile(join(sessionsDirectory, empty.projectId, "skills", "registry.json"), "utf8")), { version: 1, skills: [] })

    const project = await ipc.invoke<ProjectSummary>(
      PROJECT_IPC_CHANNELS.createProject, "Project", [firstDirectory, secondDirectory],
    )
    assert.deepEqual(project.directories, [firstDirectory, secondDirectory])
    assert.deepEqual(readProjectWorkspace(databasePath, project.projectId).directories, project.directories)

    const session = {
      id: "session-1", name: "Existing", createdAt: "2026-09-24T01:00:00.000Z",
      updatedAt: "2026-09-24T02:00:00.000Z",
    }
    saveProjectWorkspace(databasePath, {
      version: 1, id: project.projectId, name: project.name,
      updatedAt: "2026-09-24T03:00:00.000Z", directories: project.directories,
      sessions: [session],
    })
    const renamed = await ipc.invoke<ProjectSummary>(PROJECT_IPC_CHANNELS.renameProject, project.projectId, "  Renamed  ")
    assert.equal(renamed.name, "Renamed")
    assert.deepEqual(renamed.directories, project.directories)
    assert.deepEqual(readProjectWorkspace(databasePath, project.projectId).sessions, [session])
    assert.equal(readProjectWorkspace(databasePath, project.projectId).name, "Renamed")
    await assert.rejects(ipc.invoke(PROJECT_IPC_CHANNELS.renameProject, project.projectId, " "), /项目名称/)
    await assert.rejects(ipc.invoke(PROJECT_IPC_CHANNELS.renameProject, UNKNOWN_PROJECT_ID, "Missing"))
    await assert.rejects(ipc.invoke(PROJECT_IPC_CHANNELS.renameProject, "default", "Default"))
    assert.deepEqual(await ipc.invoke(PROJECT_IPC_CHANNELS.addProjectDirectory, project.projectId, firstDirectory), {
      success: false, error: `关联目录已存在：${firstDirectory}`,
    })
    if (process.platform === "win32") {
      const caseVariant = firstDirectory.toUpperCase()
      const result = await ipc.invoke<{ success: boolean }>(
        PROJECT_IPC_CHANNELS.addProjectDirectory, project.projectId, caseVariant,
      )
      assert.equal(result.success, false)
    }
    const thirdDirectory = join(root, "third")
    await mkdir(thirdDirectory)
    assert.deepEqual(await ipc.invoke(PROJECT_IPC_CHANNELS.addProjectDirectory, project.projectId, thirdDirectory), {
      success: true,
    })
    let saved = readProjectWorkspace(databasePath, project.projectId)
    assert.deepEqual(saved.directories, [firstDirectory, secondDirectory, thirdDirectory])
    assert.deepEqual(saved.sessions, [session])
    assert.equal(new Date(saved.updatedAt).toISOString(), saved.updatedAt)
    assert.notEqual(saved.updatedAt, "2026-09-24T03:00:00.000Z")

    await rmdir(secondDirectory)
    assert.deepEqual(await ipc.invoke(PROJECT_IPC_CHANNELS.removeProjectDirectory, project.projectId, secondDirectory), {
      success: true,
    })
    saved = readProjectWorkspace(databasePath, project.projectId)
    assert.deepEqual(saved.directories, [firstDirectory, thirdDirectory])
    assert.deepEqual(saved.sessions, [session])
    assert.deepEqual(await ipc.invoke(PROJECT_IPC_CHANNELS.removeProjectDirectory, project.projectId, secondDirectory), {
      success: false, error: `关联目录不存在：${secondDirectory}`,
    })

    for (const [channel, projectId, directory] of [
      [PROJECT_IPC_CHANNELS.addProjectDirectory, UNKNOWN_PROJECT_ID, thirdDirectory],
      [PROJECT_IPC_CHANNELS.removeProjectDirectory, "default", firstDirectory],
      [PROJECT_IPC_CHANNELS.addProjectDirectory, project.projectId, join(root, "missing")],
      [PROJECT_IPC_CHANNELS.addProjectDirectory, project.projectId, databasePath],
      [PROJECT_IPC_CHANNELS.addProjectDirectory, project.projectId, "relative"],
    ]) {
      const result = await ipc.invoke<{ success: boolean; error?: string }>(channel, projectId, directory)
      assert.equal(result.success, false)
      assert.ok(result.error)
    }
    await assert.rejects(ipc.invoke(PROJECT_IPC_CHANNELS.createProject, " "), /项目名称/)
    await assert.rejects(ipc.invoke(PROJECT_IPC_CHANNELS.createProject, "Invalid", ["relative"]), /绝对路径/)
    await assert.rejects(ipc.invoke(PROJECT_IPC_CHANNELS.createProject, "Duplicate", [firstDirectory, firstDirectory]), /重复/)

    const failed = new FakeIpcMain()
    registerProjectIpcHandlers(failed, dialog, {
      rootDir: root, workspaceDatabasePath: join(root, "missing.sqlite"),
    })
    const before = await readdir(sessionsDirectory)
    await assert.rejects(failed.invoke(PROJECT_IPC_CHANNELS.createProject, "Failure"), /工作区数据库/)
    assert.deepEqual(await readdir(sessionsDirectory), before)
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(root, { recursive: true, force: true })
  }
  console.log("project-ipc.test.ts: Project IPC 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
