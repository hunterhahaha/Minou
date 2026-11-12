/** 启动配置 V2、Provider 数据库初始化与既有文件保留测试。 */

import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { initializeConfigFiles } from "../../src/main/index.ts"
import { readConfigFile, writeMcpServers, writeTeamWakeupConfig } from "../../src/main/config-files.ts"
import { DEFAULT_TEAM_WAKEUP_CONFIG } from "../../runtime/session/src/team-wakeup-config.ts"
import type { ConfigFilePaths } from "../../src/main/index.ts"
import { listProviders, saveProvider } from "../../src/main/provider-store.ts"
import { readDefaultWorkspace, saveDefaultWorkspace } from "../../src/main/workspace-store.ts"
import { listWebSearchProviders, WEB_SEARCH_DATABASE_FILE } from "../../runtime/tools/src/web-search/store.ts"

/** 在独立用户目录运行断言并删除测试数据。 */
async function withTempProfile(test: (profile: string) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "minou-config-"))
  try {
    await test(profile)
  } finally {
    assert.ok(resolve(profile).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(profile, { recursive: true, force: true })
  }
}

/** 验证损坏的 config.json 报错并保留原内容。 */
async function assertInvalidConfig(content: string, errorPart: string): Promise<void> {
  await withTempProfile(async (profile) => {
    const paths = await initializeConfigFiles(profile)
    await writeFile(paths.configPath, content)
    await assert.rejects(initializeConfigFiles(profile), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(paths.configPath))
      assert.ok(error.message.includes(errorPart), error.message)
      return true
    })
    assert.equal(await readFile(paths.configPath, "utf8"), content)
  })
}

const validConfig = {
  version: 2,
  mcpServers: [
    { name: "local", enabled: true, transport: "stdio", command: "server", args: ["--mode", ""] },
    { name: "remote", enabled: false, transport: "streamable-http", url: "https://example.com/mcp" },
  ],
  runtime: { userMessageMode: "insert" },
}

/** 运行启动配置的正常与错误路径。 */
async function main(): Promise<void> {
  await withTempProfile(async (profile) => {
    const paths: ConfigFilePaths = await initializeConfigFiles(profile)
    assert.deepEqual(paths, {
      rootDir: join(profile, ".minou"),
      configPath: join(profile, ".minou", "config.json"),
      providerDatabasePath: join(profile, ".minou", "providers.sqlite"),
      workspaceDatabasePath: join(profile, ".minou", "workspace.sqlite"),
      metaDatabasePath: join(profile, ".minou", "meta.sqlite"),
    })
    for (const directory of [
      paths.rootDir,
      join(paths.rootDir, "skills"),
      join(paths.rootDir, "sessions"),
      join(paths.rootDir, "logs"),
      join(paths.rootDir, "sessions", "default"),
      join(paths.rootDir, "sessions", "default", "workspace"),
    ]) assert.equal((await stat(directory)).isDirectory(), true)
    assert.equal((await stat(join(paths.rootDir, "events.sqlite"))).isFile(), true)
    assert.equal((await stat(paths.metaDatabasePath)).isFile(), true)
    const searchDatabasePath = join(paths.rootDir, WEB_SEARCH_DATABASE_FILE)
    assert.equal((await stat(searchDatabasePath)).isFile(), true)
    assert.deepEqual(listWebSearchProviders(searchDatabasePath), [])
    assert.deepEqual(JSON.parse(await readFile(paths.configPath, "utf8")), {
      version: 2, mcpServers: [], runtime: { userMessageMode: "queue" },
      teamWakeup: DEFAULT_TEAM_WAKEUP_CONFIG,
    })
    assert.equal((await stat(paths.providerDatabasePath)).isFile(), true)
    assert.deepEqual(listProviders(paths.providerDatabasePath), [])
    assert.deepEqual(readDefaultWorkspace(paths.workspaceDatabasePath), { version: 1, sessions: [] })

    const credentialsPath = join(paths.rootDir, "credentials.json")
    const oldWorkspacePath = join(paths.rootDir, "sessions", "default", "workspace.json")
    await assert.rejects(stat(credentialsPath), { code: "ENOENT" })
    await assert.rejects(stat(oldWorkspacePath), { code: "ENOENT" })
    await writeFile(credentialsPath, "invalid legacy credentials")
    await writeFile(oldWorkspacePath, "legacy workspace content")

    const configContent = `${JSON.stringify(validConfig)}\n`
    await writeFile(paths.configPath, configContent)
    saveProvider(paths.providerDatabasePath, { id: "example", name: "Example", protocol: "responses", type: "custom" })
    const defaultWorkspace = { version: 1 as const, sessions: [{
      id: "session_1", name: "配置讨论",
      createdAt: "2026-09-18T01:00:00.000Z", updatedAt: "2026-09-18T10:00:00+08:00",
    }] }
    saveDefaultWorkspace(paths.workspaceDatabasePath, defaultWorkspace)

    assert.deepEqual(await initializeConfigFiles(profile), paths)
    const initialized = await readFile(paths.configPath, "utf8")
    assert.deepEqual(JSON.parse(initialized), { ...validConfig, teamWakeup: DEFAULT_TEAM_WAKEUP_CONFIG })
    await initializeConfigFiles(profile)
    assert.equal(await readFile(paths.configPath, "utf8"), initialized)
    const nextMcp = [{ name: "another", enabled: false, transport: "stdio" as const, command: "server" }]
    const nextTeam = { ...DEFAULT_TEAM_WAKEUP_CONFIG, pollingInterval: 30 }
    await Promise.all([writeMcpServers(paths.configPath, nextMcp), writeTeamWakeupConfig(paths.configPath, nextTeam)])
    assert.deepEqual(await readConfigFile(paths.configPath), { ...validConfig, mcpServers: nextMcp, teamWakeup: nextTeam })
    await assert.rejects(writeTeamWakeupConfig(paths.configPath, { ...nextTeam, pollingInterval: 29 }), /Team 唤醒配置/)
    assert.deepEqual((await readConfigFile(paths.configPath)).teamWakeup, nextTeam)
    assert.equal(await readFile(credentialsPath, "utf8"), "invalid legacy credentials")
    assert.equal(await readFile(oldWorkspacePath, "utf8"), "legacy workspace content")
    assert.equal(listProviders(paths.providerDatabasePath)[0].id, "example")
    assert.deepEqual(readDefaultWorkspace(paths.workspaceDatabasePath), {
      ...defaultWorkspace,
      sessions: [{ ...defaultWorkspace.sessions[0], updatedAt: "2026-09-18T02:00:00.000Z" }],
    })
  })

  await assertInvalidConfig("", "不是有效的 JSON")
  await assertInvalidConfig("null", "顶层必须是对象")
  await assertInvalidConfig("{}", "config.version")
  await assertInvalidConfig('{"version":1,"providers":[],"mcpServers":[],"runtime":{"userMessageMode":"queue"}}', "旧版配置不会自动迁移")
  await assertInvalidConfig(JSON.stringify({ ...validConfig, providers: [] }), "config.providers 不是 V2 字段")
  await assertInvalidConfig(JSON.stringify({ ...validConfig, defaultModel: "old" }), "config.defaultModel 不是 V2 字段")
  await assertInvalidConfig(JSON.stringify({ ...validConfig, runtime: { userMessageMode: "other" } }), "userMessageMode")
  for (const teamWakeup of [null, { ...DEFAULT_TEAM_WAKEUP_CONFIG, pollingInterval: 29 },
    { ...DEFAULT_TEAM_WAKEUP_CONFIG, unreadThreshold: 0.5 }, { ...DEFAULT_TEAM_WAKEUP_CONFIG, extra: 1 }]) {
    await assertInvalidConfig(JSON.stringify({ ...validConfig, teamWakeup }), "config.teamWakeup")
  }
  await assertInvalidConfig(JSON.stringify({ ...validConfig, mcpServers: [{ name: "x", enabled: true, transport: "stdio" }] }), ".command")
  await assertInvalidConfig(JSON.stringify({ ...validConfig, apiKey: "secret" }), "config.apiKey 不是 V2 字段")

  await withTempProfile(async (profile) => {
    const occupiedPath = join(profile, ".minou", "config.json")
    await mkdir(occupiedPath, { recursive: true })
    await assert.rejects(initializeConfigFiles(profile), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(occupiedPath))
      return true
    })
    assert.equal((await stat(occupiedPath)).isDirectory(), true)
  })
  await assert.rejects(initializeConfigFiles("relative-profile"), /USERPROFILE/)
  await withTempProfile(async (profile) => {
    const paths = await initializeConfigFiles(profile)
    await rm(paths.metaDatabasePath)
    await mkdir(paths.metaDatabasePath)
    await assert.rejects(initializeConfigFiles(profile), /Session Meta 数据库不是普通文件/)
  })
  await withTempProfile(async (profile) => {
    const paths = await initializeConfigFiles(profile)
    await rm(paths.metaDatabasePath)
    await writeFile(paths.metaDatabasePath, "not sqlite")
    await assert.rejects(initializeConfigFiles(profile))
    assert.equal(await readFile(paths.metaDatabasePath, "utf8"), "not sqlite")
  })
  await withTempProfile(async (profile) => {
    const paths = await initializeConfigFiles(profile)
    const db = new DatabaseSync(paths.metaDatabasePath)
    try {
      db.exec("DROP TABLE session_meta")
      db.exec("CREATE TABLE session_meta (project_id TEXT)")
    } finally {
      db.close()
    }
    await assert.rejects(initializeConfigFiles(profile), /表结构无效/)
  })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
