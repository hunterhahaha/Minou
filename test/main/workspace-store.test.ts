/** V1 工作区数据库的 UUID Project 与 default 读写测试。 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  initializeWorkspaceDatabase, listProjectWorkspaces, readDefaultWorkspace,
  readProjectWorkspace, saveDefaultWorkspace, saveProjectWorkspace, insertProjectWorkspace,
} from "../../src/main/workspace-store.ts"

const FIRST_ID = "00000000-0000-4000-8000-000000000017"
const SECOND_ID = "00000000-0000-4000-8000-000000000018"

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nicode-workspace-store-"))
  try {
    const path = join(directory, "workspace.sqlite")
    initializeWorkspaceDatabase(path)
    initializeWorkspaceDatabase(path)
    assert.deepEqual(readDefaultWorkspace(path), { version: 1, sessions: [] })
    assert.deepEqual(listProjectWorkspaces(path), [])
    assert.throws(() => readProjectWorkspace(path, FIRST_ID), /项目损坏/)

    const session = {
      id: "session-1", name: "新对话", createdAt: "2026-09-24T00:00:00Z",
      updatedAt: "2026-09-24T00:00:00Z",
    }
    const first = {
      version: 1 as const, id: FIRST_ID, name: "First", updatedAt: "2026-09-24T01:00:00Z",
      directories: ["G:\\code\\NiCode"], sessions: [session],
    }
    const second = {
      version: 1 as const, id: SECOND_ID, name: "Second", updatedAt: "2026-09-24T02:00:00Z",
      directories: [], sessions: [],
    }
    saveProjectWorkspace(path, first)
    saveProjectWorkspace(path, second)
    assert.throws(() => insertProjectWorkspace(path, { ...first, name: "Conflict" }), /工作区数据库操作失败/)
    assert.equal(readProjectWorkspace(path, FIRST_ID).name, "First")
    saveDefaultWorkspace(path, { version: 1, sessions: [session] })
    assert.deepEqual(readProjectWorkspace(path, FIRST_ID), first)
    assert.deepEqual(readDefaultWorkspace(path), { version: 1, sessions: [session] })
    assert.deepEqual(listProjectWorkspaces(path), [second, first])

    const renamed = { ...first, name: "Renamed", updatedAt: "2026-09-24T03:00:00Z" }
    saveProjectWorkspace(path, renamed)
    assert.deepEqual(listProjectWorkspaces(path), [renamed, second])
    saveProjectWorkspace(path, {
      ...renamed, updatedAt: "2026-09-24T11:00:00+08:00",
      sessions: [{ ...session, createdAt: "2026-09-24T08:00:00+08:00",
        updatedAt: "2026-09-24T08:00:00+08:00" }],
    })
    const utc = readProjectWorkspace(path, FIRST_ID)
    assert.equal(utc.updatedAt, "2026-09-24T03:00:00.000Z")
    assert.equal(utc.sessions[0].createdAt, "2026-09-24T00:00:00.000Z")
    assert.equal(utc.sessions[0].updatedAt, "2026-09-24T00:00:00.000Z")
    assert.throws(() => saveProjectWorkspace(path, { ...first, updatedAt: "2026-09-24T01:00:00" }), /带时区/)
    saveDefaultWorkspace(path, { version: 1, sessions: [{
      ...session, createdAt: "2026-09-24T08:00:00+08:00", updatedAt: "2026-09-24T08:00:00+08:00",
    }] })
    assert.equal(readDefaultWorkspace(path).sessions[0].createdAt, "2026-09-24T00:00:00.000Z")
    assert.throws(() => saveProjectWorkspace(path, { ...first, id: "default" }), /不能是 default/)
    assert.throws(() => saveProjectWorkspace(path, { ...first, id: "17" }), /projectId 无效/)
    assert.throws(() => readProjectWorkspace(path, "../other"), /projectId 无效/)

    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const columns = db.prepare("PRAGMA table_info(workspace_groups)").all() as Array<{ name: string }>
      assert.equal(columns.some((column) => column.name === "project_id"), false)
      assert.ok(columns.some((column) => column.name === "group_id"))
    } finally {
      db.close()
    }
  } finally {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(directory, { recursive: true, force: true })
  }
  console.log("workspace-store.test.ts: UUID Project 工作区断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
