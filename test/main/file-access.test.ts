/** 文件工具每次从真实 Meta 与 Workspace 数据库读取沙箱范围。 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { initializeSessionMetaDatabase } from "../../runtime/session/src/meta-store.ts"
import { initializeWorkspaceDatabase, saveProjectWorkspace } from "../../src/main/workspace-store.ts"
import { loadFileAccessState } from "../../src/main/file-access.ts"

const PROJECT_ID = "00000000-0000-4000-8000-000000000041"
const SESSION_ID = "session-1"

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-file-access-"))
  try {
    const nicode = join(root, ".nicode")
    await mkdir(join(nicode, "sessions", PROJECT_ID, "workspace"), { recursive: true })
    await mkdir(join(nicode, "sessions", "default", "workspace"), { recursive: true })
    const paths = {
      rootDir: nicode,
      metaDatabasePath: join(nicode, "meta.sqlite"),
      workspaceDatabasePath: join(nicode, "workspace.sqlite"),
    }
    initializeSessionMetaDatabase(paths.metaDatabasePath)
    initializeWorkspaceDatabase(paths.workspaceDatabasePath)
    const first = join(root, "first")
    const second = join(root, "second")
    saveProjectWorkspace(paths.workspaceDatabasePath, {
      version: 1, id: PROJECT_ID, name: "Project", updatedAt: "2026-09-24T00:00:00Z",
      directories: [first], sessions: [],
    })
    const db = new DatabaseSync(paths.metaDatabasePath)
    try {
      db.prepare(`INSERT INTO session_meta
        (project_id, session_id, name, version, current_model_json, sandbox_mode_json,
         usage_json, skills_json, additional_meta_json)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
        PROJECT_ID, SESSION_ID, "Session", JSON.stringify({ providerId: "p", protocol: "responses", modelId: "m", name: "Model" }),
        JSON.stringify("sandbox-full-access"), JSON.stringify({}), JSON.stringify({}), JSON.stringify({}),
      )
      db.prepare(`INSERT INTO session_meta
        (project_id, session_id, name, version, current_model_json, sandbox_mode_json,
         usage_json, skills_json, additional_meta_json)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
        "default", SESSION_ID, "Default Session", JSON.stringify({ providerId: "p", protocol: "responses", modelId: "m", name: "Model" }),
        JSON.stringify("full-access"), JSON.stringify({}), JSON.stringify({}), JSON.stringify({}),
      )
    } finally { db.close() }
    assert.deepEqual(loadFileAccessState(paths, PROJECT_ID, SESSION_ID), {
      sandboxMode: "sandbox-full-access",
      roots: [join(nicode, "sessions", PROJECT_ID, "workspace"), first],
    })
    saveProjectWorkspace(paths.workspaceDatabasePath, {
      version: 1, id: PROJECT_ID, name: "Project", updatedAt: "2026-09-24T00:01:00Z",
      directories: [second], sessions: [],
    })
    const update = new DatabaseSync(paths.metaDatabasePath)
    try {
      update.prepare("UPDATE session_meta SET sandbox_mode_json = ? WHERE project_id = ? AND session_id = ?")
        .run(JSON.stringify("sandbox-read-only"), PROJECT_ID, SESSION_ID)
    } finally { update.close() }
    assert.deepEqual(loadFileAccessState(paths, PROJECT_ID, SESSION_ID), {
      sandboxMode: "sandbox-read-only",
      roots: [join(nicode, "sessions", PROJECT_ID, "workspace"), second],
    })
    assert.throws(() => loadFileAccessState(paths, PROJECT_ID, "missing"), /Meta 缺失/)
    assert.deepEqual(loadFileAccessState(paths, "default", SESSION_ID), {
      sandboxMode: "full-access",
      roots: [join(nicode, "sessions", "default", "workspace")],
    })
  } finally { await rm(root, { recursive: true, force: true }) }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
