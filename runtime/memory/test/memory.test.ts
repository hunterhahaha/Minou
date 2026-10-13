/** Markdown 记忆的持久化、分类、排序、并发与失败恢复测试。 */
import assert from "node:assert/strict"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { MemoryManager, validateMemoryContent } from "../src/index.ts"

const PROJECT = "00000000-0000-4000-8000-000000000001"
const TIME = "2026-10-09T01:02:03.004Z"
const entry = { level1: "工具", level2: "文件", content: "用户偏好小步修改。" }
const selection = [{ level1: "工具", level2: ["文件"] }]

/** @returns 正常、错误与恢复路径验证完成。 @throws AssertionError 行为偏离存储契约。 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nicode-memory-"))
  const directory = join(root, "sessions", "default")
  const path = join(directory, "memory.md")
  try {
    await mkdir(directory, { recursive: true })
    await mkdir(join(root, "sessions", PROJECT))
    const manager = new MemoryManager(root, () => new Date(TIME))
    assert.throws(() => new MemoryManager("relative"), /绝对路径/)
    assert.deepEqual(await manager.list("default"), { sections: [] })
    assert.deepEqual(await manager.read("default", selection), { sections: [{ level1: "工具", level2: "文件", memories: [], truncated: false }] })
    assert.deepEqual(await manager.write("default", []), { memories: [] })
    await assert.rejects(lstat(path), { code: "ENOENT" })
    await assert.rejects(manager.list("../outside"), /projectId 无效/)
    await assert.rejects(manager.list("00000000-0000-4000-8000-000000000002"), { code: "MEMORY_PROJECT_UNAVAILABLE" })

    const first = await manager.write("default", [entry, { ...entry, level2: "终端", content: "多行\n正文" }, { level1: "架构", level2: "决策", content: "暂不增加依赖。" }])
    assert.deepEqual(first.memories[0], { level1: "工具", level2: "文件", createdAt: TIME })
    assert.equal("content" in first.memories[0], false)
    assert.match(await readFile(path, "utf8"), /<2026-10-09T01:02:03\.004Z>\n用户偏好小步修改。/)
    assert.deepEqual(await manager.list("default"), { sections: [{ level1: "工具", level2: ["文件", "终端"] }, { level1: "架构", level2: ["决策"] }] })
    assert.deepEqual(await manager.list(PROJECT), { sections: [] })
    const bodies = ["末尾保留空行\n\n", "\n首行为空\n正文", "```md\n# 正文中的标题\n<2026-10-09T01:02:03.004Z>\n```", "~~~\n## 正文\n~~~", "### 三级正文标题\n普通文本"]
    for (const content of bodies) await manager.write("default", [{ ...entry, content }])
    const restored = new MemoryManager(root)
    assert.deepEqual((await restored.read("default", selection)).sections[0].memories.map((item) => item.content), [...bodies].reverse().concat(entry.content))
    await manager.write(PROJECT, [{ ...entry, content: "另一个项目" }])
    assert.equal((await manager.read(PROJECT, selection)).sections[0].memories[0].content, "另一个项目")

    const before = await readFile(path, "utf8")
    for (const content of ["", " \n ", "正文\n# 冲突", "  ## 冲突", "正文\n<2026-10-09T01:02:03.004Z>", "```\n未闭合", "~~~\n未闭合"]) {
      assert.throws(() => validateMemoryContent(content), { code: "INVALID_TOOL_ARGUMENTS" })
      await assert.rejects(manager.write("default", [entry, { ...entry, content }]), { code: "INVALID_TOOL_ARGUMENTS" })
    }
    await assert.rejects(manager.write("default", [{ ...entry, level1: "一级\n分类" }]), { code: "INVALID_TOOL_ARGUMENTS" })
    assert.equal(await readFile(path, "utf8"), before, "整批校验失败不能追加前面的有效记录")

    const external = "# 工具\n\n## 文件\n\n<2026-10-09T10:00:00+08:00>\n较早\n\n<2026-10-09T02:30:00Z>\n较晚\n\n<2026-10-09T02:30:00.000Z>\n同一时刻后追加\n\n## 终端\n\n<2026-10-09T01:00:00Z>\n单条\n"
    await writeFile(path, external.replace(/\n/g, "\r\n"))
    const requested = [{ level1: "工具", level2: ["文件", "终端", "缺失"] }, { level1: "缺失", level2: ["分类"] }]
    const limited = await manager.read("default", requested, 2)
    assert.deepEqual(limited.sections[0].memories.map((item) => item.content), ["同一时刻后追加", "较晚"])
    assert.deepEqual(limited.sections.map((item) => item.truncated), [true, false, false, false])
    assert.equal((await manager.read("default", selection)).sections[0].memories.length, 3)
    assert.equal((await manager.read("default", selection, 3)).sections[0].truncated, false)
    assert.deepEqual(await manager.read("default", []), { sections: [] })
    assert.deepEqual(await manager.read("default", [{ level1: "工具", level2: [] }]), { sections: [] })
    for (const limit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(manager.read("default", selection, limit), { code: "INVALID_TOOL_ARGUMENTS" })

    await Promise.all(Array.from({ length: 12 }, (_, index) => manager.write("default", [{ ...entry, content: `并发 ${index}` }])))
    const concurrent = (await manager.read("default", selection)).sections[0].memories.map((item) => item.content)
    assert.equal(concurrent.length, 15)
    for (let index = 0; index < 12; index += 1) assert.ok(concurrent.includes(`并发 ${index}`))
    const unchanged = await readFile(path, "utf8")
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(manager.list("default", cancelled.signal), { code: "CANCELLED" })
    await assert.rejects(manager.write("default", [entry], cancelled.signal), { code: "CANCELLED" })
    let clockCalls = 0
    const brokenClock = new MemoryManager(root, () => ++clockCalls === 2 ? new Date(NaN) : new Date(TIME))
    await assert.rejects(brokenClock.write("default", [entry, entry]), RangeError)
    assert.equal(await readFile(path, "utf8"), unchanged)
    await brokenClock.write("default", [entry])
    const preCommit = new AbortController()
    const cancellingClock = new MemoryManager(root, () => { preCommit.abort(); return new Date(TIME) })
    const beforeCancel = await readFile(path, "utf8")
    await assert.rejects(cancellingClock.write("default", [entry], preCommit.signal), { code: "CANCELLED" })
    assert.equal(await readFile(path, "utf8"), beforeCancel)
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false)

    if (process.platform === "win32") {
      await chmod(path, 0o444)
      try {
        await assert.rejects(manager.write("default", [entry]), { code: "MEMORY_WRITE_FAILED" })
        assert.equal(await readFile(path, "utf8"), beforeCancel)
        assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false)
      } finally { await chmod(path, 0o666) }
      await manager.write("default", [entry])
    }

    for (const corrupt of ["孤立正文", "## 缺少一级分类", "# 工具\n## 文件\n<2026-02-30T00:00:00Z>\n日期无效", "# 工具\n## 文件\n<2026-10-09T00:00:00Z>\n", "# 工具\n## 文件\n<2026-10-09T00:00:00Z>\n```\n未闭合", "# 工具\n# 工具", "# 工具\n## 文件\n## 文件"]) {
      await writeFile(path, corrupt)
      await assert.rejects(manager.list("default"), { code: "MEMORY_FORMAT_INVALID" })
      await assert.rejects(manager.write("default", [entry]), { code: "MEMORY_FORMAT_INVALID" })
      assert.equal(await readFile(path, "utf8"), corrupt)
    }
    await rm(path)
    await mkdir(path)
    await assert.rejects(manager.read("default", selection), { code: "MEMORY_FILE_INVALID" })
    await assert.rejects(manager.write("default", [entry]), { code: "MEMORY_FILE_INVALID" })
    console.log("memory.test.ts: 持久化、排序、并发与失败恢复通过")
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep), "清理范围必须位于测试临时目录")
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
