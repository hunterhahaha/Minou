/** 工作区 SQLite 配置的创建、读写顺序与事务测试。 */

import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  initializeWorkspaceDatabase,
  readDefaultWorkspace,
  readProjectWorkspace,
  saveDefaultWorkspace,
  saveProjectWorkspace,
} from "../../src/main/workspace-store.ts"
import type { ProjectWorkspace } from "../../src/main/workspace-store.ts"

/** 在临时数据库上完成读写后安全清理。 */
async function withTempDatabase(test: (databasePath: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-workspace-store-"))
  try {
    test(join(directory, "workspace.sqlite"))
  } finally {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(directory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await withTempDatabase((databasePath) => {
    assert.throws(() => readProjectWorkspace(databasePath, 17))
    assert.equal(existsSync(databasePath), false)
    initializeWorkspaceDatabase(databasePath)
    assert.deepEqual(readDefaultWorkspace(databasePath), { version: 1, sessions: [] })
    assert.throws(() => readProjectWorkspace(databasePath, 17), /项目损坏/)

    const sessions = [{
      id: "second", name: "第二个会话",
      createdAt: "2026-09-18T01:00:00.000Z", updatedAt: "2026-09-18T02:00:00.000Z",
    }, {
      id: "first", name: "第一个会话",
      createdAt: "2026-09-17T01:00:00.000Z", updatedAt: "2026-09-18T03:00:00.000Z",
    }]
    const project: ProjectWorkspace = {
      version: 1,
      id: 17,
      name: "NiCode",
      updatedAt: "2026-09-23T01:00:00.000Z",
      directories: ["G:\\code\\NiCode", "D:\\other"],
      sessions,
    }
    saveProjectWorkspace(databasePath, project)
    saveDefaultWorkspace(databasePath, { version: 1, sessions: [sessions[1], sessions[0]] })
    initializeWorkspaceDatabase(databasePath)
    assert.deepEqual(readProjectWorkspace(databasePath, 17), project)
    assert.deepEqual(readDefaultWorkspace(databasePath), {
      version: 1, sessions: [sessions[1], sessions[0]],
    })

    const changed: ProjectWorkspace = {
      ...project, name: "Renamed", updatedAt: "2026-09-23T02:00:00.000Z",
      directories: [project.directories[1]], sessions: [sessions[1]],
    }
    saveProjectWorkspace(databasePath, changed)
    assert.deepEqual(readProjectWorkspace(databasePath, 17), changed)
    assert.throws(() => saveProjectWorkspace(databasePath, {
      ...project, sessions: [{ ...sessions[0], name: null as unknown as string }],
    }))
    assert.deepEqual(readProjectWorkspace(databasePath, 17), changed)
  })
  await withTempDatabase((databasePath) => {
    const db = new DatabaseSync(databasePath)
    try {
      db.exec(`CREATE TABLE workspace_groups (
        group_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
        project_id INTEGER UNIQUE, name TEXT
      ) STRICT`)
      db.prepare(`INSERT INTO workspace_groups (group_id, version, project_id, name)
        VALUES ('17', 1, 17, 'Existing project')`).run()
    } finally {
      db.close()
    }
    initializeWorkspaceDatabase(databasePath)
    const migrated = readProjectWorkspace(databasePath, 17)
    assert.equal(migrated.name, "Existing project")
    assert.equal(new Date(migrated.updatedAt).toISOString(), migrated.updatedAt)
    initializeWorkspaceDatabase(databasePath)
    assert.equal(readProjectWorkspace(databasePath, 17).updatedAt, migrated.updatedAt)
  })
  console.log("workspace-store.test.ts: 工作区 SQLite 断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
