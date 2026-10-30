/**
 * 使用内存 Buffer 验证 Turn 文件净变化，不修改示例路径中的真实文件。
 *
 * 覆盖多次修改的合并、说明覆盖、多 hunk 统计、撤销变化和新建空文件。
 */
import assert from "node:assert/strict"
import { TurnFileChangeTracker } from "../src/file-changes.ts"

/**
 * 依次验证文件净变化、说明和 diff 统计的内存断言。
 * @throws Error 断言或临时存储操作失败时传播，由测试入口报告失败。
 */
function main(): void {
  const tracker = new TurnFileChangeTracker()
  const old = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
  const middle = old.replace("line 2", "changed 2")
  const next = middle.replace("line 23", "changed 23")
  tracker.record("C:\\project\\file.txt", Buffer.from(old), Buffer.from(middle))
  tracker.record("C:\\project\\file.txt", Buffer.from(middle), Buffer.from(next))
  assert.equal(tracker.describe("C:\\project\\file.txt", "first"), true)
  assert.equal(tracker.describe("C:\\project\\file.txt", "last"), true)
  assert.equal(tracker.describe("C:\\project\\other.txt", "unknown"), false)
  const files = tracker.summarize()
  assert.equal(files.length, 1)
  assert.equal(files[0].changeType, "modified")
  assert.equal(files[0].description, "last")
  assert.equal(files[0].hunks.length, 2)
  assert.deepEqual(files[0].stats, { additions: 2, deletions: 2 })

  const reverted = new TurnFileChangeTracker()
  reverted.record("C:\\project\\file.txt", Buffer.from(old), Buffer.from(next))
  reverted.record("C:\\project\\file.txt", Buffer.from(next), Buffer.from(old))
  assert.deepEqual(reverted.summarize(), [])
  const created = new TurnFileChangeTracker()
  created.record("C:\\project\\empty.txt", null, Buffer.alloc(0))
  assert.equal(created.summarize()[0].changeType, "created")
  console.log("file-changes.test.ts: Turn 文件净变化断言通过")
}

main()
