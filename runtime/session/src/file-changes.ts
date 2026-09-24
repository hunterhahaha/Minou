/** 当前 Turn 内由 write/edit 产生的文件净变化与说明。 */
import { createHash } from "node:crypto"
import { structuredPatch } from "diff"
import type { FileChange, FileDiffHunk } from "./events.ts"

interface Snapshot {
  path: string
  oldBlob: Buffer | null
  newBlob: Buffer | null
  description?: string
}

/** 只追踪文件工具修改的当前 Turn 文件，不持久化原始快照。 */
export class TurnFileChangeTracker {
  private readonly changes = new Map<string, Snapshot>()

  /**
   * 成功写入后更新文件快照；第一次写入保留当时的旧内容。
   * @param path 规范化的绝对文件路径。
   * @param before 本次写入前内容；文件原先不存在时为 null。
   * @param after 成功写入后的完整内容。
   */
  record(path: string, before: Buffer | null, after: Buffer): void {
    const current = this.changes.get(path)
    if (current === undefined) {
      this.changes.set(path, { path, oldBlob: before === null ? null : Buffer.from(before), newBlob: Buffer.from(after) })
    } else {
      current.newBlob = Buffer.from(after)
    }
  }

  /**
   * 为已追踪文件写入模型提供的说明。
   * @param path 规范化的绝对文件路径。
   * @param description 本次文件级说明。
   * @returns 路径已追踪时为 true。
   */
  describe(path: string, description: string): boolean {
    const change = this.changes.get(path)
    if (change === undefined) return false
    change.description = description
    return true
  }

  /**
   * 根据首次修改前与最终内容计算可持久化的净变化。
   * @returns 按首次修改顺序排列、已过滤内容相同文件的事件数据。
   */
  summarize(): FileChange[] {
    const files: FileChange[] = []
    for (const change of this.changes.values()) {
      if (hash(change.oldBlob) === hash(change.newBlob)) continue
      const patch = structuredPatch(
        change.path, change.path,
        change.oldBlob?.toString("utf8") ?? "",
        change.newBlob?.toString("utf8") ?? "",
        undefined, undefined, { context: 3 },
      )
      const hunks: FileDiffHunk[] = patch.hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines,
      }))
      let additions = 0
      let deletions = 0
      for (const hunk of hunks) for (const line of hunk.lines) {
        if (line.startsWith("+")) additions += 1
        else if (line.startsWith("-")) deletions += 1
      }
      files.push({
        path: change.path,
        changeType: change.oldBlob === null ? "created" : change.newBlob === null ? "deleted" : "modified",
        hunks,
        stats: { additions, deletions },
        ...(change.description === undefined ? {} : { description: change.description }),
      })
    }
    return files
  }
}

/** @param content 文件内容或不存在标记。 @returns SHA-256 或 null。 */
function hash(content: Buffer | null): string | null {
  return content === null ? null : createHash("sha256").update(content).digest("hex")
}
