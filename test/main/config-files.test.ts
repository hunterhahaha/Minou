/** 启动配置的创建、V1 校验及损坏文件保留。 */

import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

import { initializeConfigFiles } from "../../src/main/index.ts"
import type { ConfigFilePaths } from "../../src/main/index.ts"

async function withTempProfile(test: (profile: string) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "nicode-config-"))
  try {
    await test(profile)
  } finally {
    assert.ok(resolve(profile).startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(profile, { recursive: true, force: true })
  }
}

function filePath(paths: ConfigFilePaths, file: "config" | "credentials" | "workspace"): string {
  return file === "config" ? paths.configPath
    : file === "credentials" ? paths.credentialsPath : paths.defaultWorkspacePath
}

async function assertInvalidFile(
  file: "config" | "credentials" | "workspace",
  content: string,
  errorPart: string,
  setup?: (paths: ConfigFilePaths) => Promise<void>,
): Promise<void> {
  await withTempProfile(async (profile) => {
    const paths = await initializeConfigFiles(profile)
    if (setup) await setup(paths)
    const path = filePath(paths, file)
    await writeFile(path, content)
    await assert.rejects(initializeConfigFiles(profile), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(path))
      assert.ok(error.message.includes(errorPart), error.message)
      return true
    })
    assert.equal(await readFile(path, "utf8"), content)
  })
}

const validConfig = {
  version: 1,
  providers: [{
    id: "example",
    name: "Example Provider",
    protocols: {
      chat_completions: { baseURL: "https://api.example.com/v1", defaultHeaders: { "X-Test": "value" } },
    },
    models: [{ id: "coding-model", contextWindow: 128000, maxOutputTokens: 8192, supportsTools: true }],
  }],
  defaultModel: "coding-model",
  mcpServers: [
    { name: "local", enabled: true, transport: "stdio", command: "server", args: ["--mode", ""] },
    { name: "remote", enabled: false, transport: "streamable-http", url: "https://example.com/mcp" },
  ],
  runtime: { userMessageMode: "insert" },
}

async function main(): Promise<void> {
  await withTempProfile(async (profile) => {
    const paths = await initializeConfigFiles(profile)
    assert.deepEqual(paths, {
      rootDir: join(profile, ".nicode"),
      configPath: join(profile, ".nicode", "config.json"),
      credentialsPath: join(profile, ".nicode", "credentials.json"),
      defaultWorkspacePath: join(profile, ".nicode", "sessions", "default", "workspace.json"),
    })
    for (const directory of [
      paths.rootDir,
      join(paths.rootDir, "skills"),
      join(paths.rootDir, "sessions"),
      join(paths.rootDir, "logs"),
      join(paths.rootDir, "sessions", "default"),
      join(paths.rootDir, "sessions", "default", "workspace"),
    ]) assert.equal((await stat(directory)).isDirectory(), true)
    assert.deepEqual(JSON.parse(await readFile(paths.configPath, "utf8")), {
      version: 1, providers: [], mcpServers: [], runtime: { userMessageMode: "queue" },
    })
    assert.deepEqual(JSON.parse(await readFile(paths.credentialsPath, "utf8")), {})
    assert.deepEqual(JSON.parse(await readFile(paths.defaultWorkspacePath, "utf8")), {
      version: 1, sessions: [],
    })

    const configContent = `${JSON.stringify(validConfig)}\n`
    const credentialsContent = '{"providers":[{"providerId":"example","apiKey":"secret"}]}\n'
    const workspaceContent = '{"version":1,"sessions":[{"id":"session_1","name":"配置讨论","createdAt":"2026-09-18T01:00:00.000Z","updatedAt":"2026-09-18T10:00:00+08:00"}]}\n'
    await writeFile(paths.configPath, configContent)
    await writeFile(paths.credentialsPath, credentialsContent)
    await writeFile(paths.defaultWorkspacePath, workspaceContent)
    assert.deepEqual(await initializeConfigFiles(profile), paths)
    assert.equal(await readFile(paths.configPath, "utf8"), configContent)
    assert.equal(await readFile(paths.credentialsPath, "utf8"), credentialsContent)
    assert.equal(await readFile(paths.defaultWorkspacePath, "utf8"), workspaceContent)

    await rm(paths.credentialsPath)
    await rm(paths.defaultWorkspacePath)
    await initializeConfigFiles(profile)
    assert.equal(await readFile(paths.configPath, "utf8"), configContent)
    assert.deepEqual(JSON.parse(await readFile(paths.credentialsPath, "utf8")), {})
    assert.deepEqual(JSON.parse(await readFile(paths.defaultWorkspacePath, "utf8")), { version: 1, sessions: [] })

  })

  await assertInvalidFile("config", "", "不是有效的 JSON")
  await assertInvalidFile("credentials", "{", "不是有效的 JSON")
  await assertInvalidFile("workspace", "[]", "顶层必须是对象")
  await assertInvalidFile("config", "null", "顶层必须是对象")
  await assertInvalidFile("config", "{}", "config.version")
  await assertInvalidFile("workspace", "{}", "workspace.version")
  await assertInvalidFile("config", '{"version":2,"providers":[],"mcpServers":[],"runtime":{"userMessageMode":"queue"}}', "config.version")
  await assertInvalidFile("config", JSON.stringify({ ...validConfig, defaultModel: "missing" }), "config.defaultModel")
  await assertInvalidFile("config", JSON.stringify({ ...validConfig, providers: [validConfig.providers[0], validConfig.providers[0]] }), ".id 重复")
  await assertInvalidFile("config", JSON.stringify({ ...validConfig, providers: [validConfig.providers[0], {
    ...validConfig.providers[0], id: "second", models: [{ id: "coding-model" }],
  }] }), ".id 重复")
  await assertInvalidFile("config", JSON.stringify({ ...validConfig, providers: [{ ...validConfig.providers[0], models: [{ id: "coding-model", providerId: "example" }] }] }), "providerId 不是 V1 字段")
  await assertInvalidFile("config", JSON.stringify({ ...validConfig, providers: [{ ...validConfig.providers[0], protocols: { invalid: {} } }] }), "不是支持的协议")
  await assertInvalidFile("config", JSON.stringify({ ...validConfig, runtime: { userMessageMode: "other" } }), "userMessageMode")
  await assertInvalidFile("config", JSON.stringify({ ...validConfig, mcpServers: [{ name: "x", enabled: true, transport: "stdio" }] }), ".command")
  await assertInvalidFile("config", JSON.stringify({ ...validConfig, apiKey: "secret" }), "apiKey 不是 V1 字段")
  await assertInvalidFile("credentials", '{"providers":[{"providerId":"missing","apiKey":"secret"}]}', "未引用已配置的 Provider")
  await assertInvalidFile("credentials", '{"providers":[{"providerId":"example","apiKey":"secret"},{"providerId":"example","apiKey":"second"}]}', "providerId 重复", async (paths) => {
    await writeFile(paths.configPath, JSON.stringify(validConfig))
  })
  await assertInvalidFile("workspace", '{"version":1,"sessions":[{"id":"s","name":"Session","createdAt":"2026-09-18","updatedAt":"2026-09-18T02:25:00Z"}]}', "createdAt")
  await assertInvalidFile("workspace", '{"version":1,"sessions":[{"id":"s","name":"Session","createdAt":"2026-02-30T01:00:00Z","updatedAt":"2026-09-18T02:25:00Z"}]}', "createdAt")
  await assertInvalidFile("workspace", '{"version":1,"sessions":[],"skills":{}}', "skills 不是 V1 字段")

  await withTempProfile(async (profile) => {
    const occupiedPath = join(profile, ".nicode", "config.json")
    await mkdir(occupiedPath, { recursive: true })
    await assert.rejects(initializeConfigFiles(profile), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(occupiedPath))
      return true
    })
    assert.equal((await stat(occupiedPath)).isDirectory(), true)
  })
  await assert.rejects(initializeConfigFiles("relative-profile"), /USERPROFILE/)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
