import { randomUUID } from "node:crypto"
import type { UserMessageContent } from "../../runtime/session/src/events.ts"
import type { QueuedMessage } from "../../runtime/session/src/message-queue.ts"

/**
 * 模拟与测试内存日志一起提交的队列。真实 SQLite 事务由持久化测试验证。
 * @returns 可替换 Runtime 队列的夹具，以及日志写入时的出队入口。
 */
export function fakeSessionQueue() {
  const pending: QueuedMessage[] = []
  let paused = false
  return {
    enqueue(input: UserMessageContent, resume = false): string {
      if (resume) paused = false
      const messageId = randomUUID()
      pending.push({ ...structuredClone(input), messageId })
      return messageId
    },
    read(headOnly = false): QueuedMessage[] {
      return structuredClone(headOnly ? paused ? [] : pending.slice(0, 1) : pending)
    },
    pause(): void { paused = true },
    consume(id: string | undefined): void {
      if (id === undefined) return
      if (pending[0]?.messageId !== id) throw new Error("测试队首身份不一致")
      pending.shift()
    },
  }
}
