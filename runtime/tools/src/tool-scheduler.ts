/**
 * ToolScheduler：一次工具小轮的串并行调度（第 17 节）。
 *
 * 调度模型是「按模型给出的顺序切轮，逐轮执行」：
 *
 *   拿到有序的 tool_call 数组后从索引 0 开始取：
 *     - 取到的第一个工具是独占工具 → 它单独一轮，本轮不再取别的；
 *     - 取到的是共享只读工具     → 继续往后取，直到取完全部或者遇到独占工具。
 *   一轮内的调用并发执行，一轮全部结束后才开始下一轮。
 *
 * 于是「连续的一段共享只读调用」彼此并发，「独占工具」永远单独占一轮 ——
 * 第 17 节的三条规则（共享可并发、共享运行中独占等待、独占运行中后续共享等待）都由这两句话推出。
 *
 * 切轮由 `planToolRounds` 完成（纯函数），执行由 `runToolCalls` 逐轮驱动；
 * 实际执行仍由调用方注入的 `execute` 完成（第 17 节：Scheduler 只控制调度及调用关联，
 * 所有实际执行均委托统一 execute）。
 *
 * 交出方式：`runToolCalls` 是异步迭代器，一轮之内**谁先完成谁先交出**，调用方收到一个就写一条
 * `tool/result`（第 16.5 节：完成后即可记录，不等待整个 Turn 结束再批量 render）。
 * 代价是交出顺序 = 完成顺序，与 tool_call 的顺序不同 —— 第 8.6 / 11.3 节要求的是
 * `toolCallId` 与调用的配对，与写入顺序无关。
 *
 * 尚未实现（均需要本项目尚未落地的模块，不在本阶段范围内）：
 *   - 审批请求的顺序处理与「审批屏障」（依赖 ApprovalManager，第 21 节）；
 *   - 收到取消信号时由调度器直接为尚未启动的调用产出 `CANCELLED` 结果
 *     （第 16.4、17 节；产出该结果要经过 render，目前由注入的执行入口按取消信号处理）；
 *   - 跨 Step / 跨 Turn 的 Session 级调度状态（第 17 节「ToolScheduler 按 Session 管理执行顺序」）。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 16.4 节（统一 execute 流程）、
 *          第 16.5 节（日志、上下文与 UI）、第 17 节（Tool Scheduler）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 6.4（接调度入口与 tool/result 写入）
 */

import type { ToolResult } from "./types.ts"

/**
 * 共享只读工具（第 17 节「共享只读组」）。
 *
 * 名单照文档抄写。不在名单里的工具一律按独占执行处理，因此动态载入的 MCP Tool 与将来新增的
 * 内置工具默认独占 —— 漏登记只会让调度更保守，不会让有副作用的工具意外并发。
 */
export const SHARED_READ_ONLY_TOOLS = [
  "glob",
  "grep",
  "read",
  "terminal_list",
  "skill_load",
  "memory_list",
  "memory_read",
  "mcp_list_tools",
] as const

const SHARED_READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(SHARED_READ_ONLY_TOOLS)

/** 调度分组（第 17 节）。 */
export type ToolScheduleGroup = "shared" | "exclusive"

/** 判定一个工具属于共享只读组还是独占执行组（第 17 节）。 */
export function toolScheduleGroup(toolName: string): ToolScheduleGroup {
  return SHARED_READ_ONLY_TOOL_SET.has(toolName) ? "shared" : "exclusive"
}

/** 调度器需要从每次调用中知道的最小信息：工具名决定串并行（第 17 节）。 */
export interface SchedulableToolCall {
  toolName: string
}

/** 一次调用的结果，连同原调用一起交出，便于调用方关联 `tool/result`（第 8.6 节）。 */
export interface ToolCallResult<TCall extends SchedulableToolCall> {
  call: TCall
  result: ToolResult
}

/**
 * 把有序的调用切成若干轮。
 *
 * 规则就是文件头那两句：独占工具单独一轮；共享只读工具尽可能多地凑成同一轮。
 * 纯函数，返回的每一轮内部都可以安全并发，轮与轮之间必须串行。
 */
export function planToolRounds<TCall extends SchedulableToolCall>(
  calls: readonly TCall[],
): TCall[][] {
  const rounds: TCall[][] = []
  let index = 0

  while (index < calls.length) {
    const call = calls[index]

    // 该轮的第一个工具就是独占工具：本轮不再取别的。
    if (toolScheduleGroup(call.toolName) === "exclusive") {
      rounds.push([call])
      index += 1
      continue
    }

    // 共享只读：一直取到取完全部、或者遇到下一个独占工具。
    const round: TCall[] = []
    while (index < calls.length && toolScheduleGroup(calls[index].toolName) === "shared") {
      round.push(calls[index])
      index += 1
    }
    rounds.push(round)
  }

  return rounds
}

/**
 * 按轮执行一批 tool_call，每完成一个就交出 `{ call, result }`。
 *
 * 轮与轮之间严格串行：下一轮的调用在上一轮全部结束、且上一轮的结果都已交出之后才启动。
 * 提前中断消费（不把迭代器读完）时，正在运行的那一轮不会被取消 —— 取消只由 `execute`
 * 自己按 `AbortSignal` 处理（第 14 节）。
 */
export async function* runToolCalls<TCall extends SchedulableToolCall>(
  calls: readonly TCall[],
  execute: (call: TCall) => Promise<ToolResult>,
): AsyncGenerator<ToolCallResult<TCall>> {
  for (const round of planToolRounds(calls)) {
    yield* runRound(round, execute)
  }
}

/** 一轮之内的一次完成；失败也先收下，等本轮结束再抛。 */
type Outcome<TCall extends SchedulableToolCall> =
  | { kind: "result"; call: TCall; result: ToolResult }
  | { kind: "error"; call: TCall; error: unknown }

/**
 * 并发执行一轮：谁先完成谁先交出。
 *
 * 本轮全部结束后才返回；若其中有调用抛错，抛出**第一个**错误（按完成顺序），
 * 之前已交出的结果照常生效。工具失败的正常表达是 `ToolResult`，抛出属于 Turn 级失败。
 */
async function* runRound<TCall extends SchedulableToolCall>(
  round: readonly TCall[],
  execute: (call: TCall) => Promise<ToolResult>,
): AsyncGenerator<ToolCallResult<TCall>> {
  /** 已完成但还没交出的结果，按完成顺序排队。 */
  const completed: Outcome<TCall>[] = []
  /** 本轮还没结束的调用数。 */
  let pending = round.length
  /** 本轮第一个失败的调用；等整轮结束再抛出，避免丢掉同轮其它调用的结果。 */
  let firstError: { error: unknown } | undefined
  let wake: (() => void) | undefined

  /**
   * 收下一次完成：入队 → 减计数 → 唤醒等待中的循环。
   *
   * 三件事按这个顺序做完，被唤醒的一方看到的 `pending` 才一定已经排除了刚完成的调用，
   * 否则会误判为「还有人在跑」而继续等待一个永远不会到来的唤醒。
   */
  function settle(outcome: Outcome<TCall>): void {
    completed.push(outcome)
    pending -= 1
    const resume = wake
    wake = undefined
    resume?.()
  }

  for (const call of round) {
    // 立即启动、不等待：本轮的调用并发执行。
    void (async () => {
      try {
        settle({ kind: "result", call, result: await execute(call) })
      } catch (error) {
        settle({ kind: "error", call, error })
      }
    })()
  }

  while (pending > 0 || completed.length > 0) {
    if (completed.length === 0) {
      // 条件检查与设置 wake 之间没有 await，因此不会丢唤醒。
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      continue
    }

    const outcome = completed.shift()
    if (outcome === undefined) continue

    if (outcome.kind === "error") {
      firstError ??= { error: outcome.error }
      continue
    }

    yield { call: outcome.call, result: outcome.result }
  }

  if (firstError !== undefined) throw firstError.error
}
