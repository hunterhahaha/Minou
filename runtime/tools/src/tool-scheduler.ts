/**
 * 按工具名称将一批有序调用切轮，并按轮执行。
 *
 * 连续共享只读调用同轮并发，独占工具单独成轮；整轮结束并交付结果后才开始下一轮。
 * 同轮结果按完成顺序连同原调用交出，异常等待同轮结束后传播。
 * 实际执行、取消和审批由注入的 execute 及其 Session 资源处理，本模块不维护跨批次状态。
 */

import type { ToolResult } from "./types.ts"

/**
 * 共享只读工具。
 *
 * 只有列出的名称按共享只读调度。不在名单里的工具一律按独占执行处理，因此动态载入的 MCP Tool 与将来新增的
 * 内置工具默认独占 —— 漏登记只会让调度更保守，不会让有副作用的工具意外并发。
 */
export const SHARED_READ_ONLY_TOOLS = [
  "glob",
  "grep",
  "read",
  "skill_load",
  "memory_list",
  "memory_read",
  "mcp_list_tools",
  "web_search",
  "web_fetch",
] as const

const SHARED_READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(SHARED_READ_ONLY_TOOLS)

/** 调度分组。 */
export type ToolScheduleGroup = "shared" | "exclusive"

/**
 * 判定一个工具属于共享只读组还是独占执行组。
 * @param toolName 用于确定共享或独占分组的工具名称。
 * @returns 名单内名称返回 shared，其他名称返回 exclusive。
 */
export function toolScheduleGroup(toolName: string): ToolScheduleGroup {
  return SHARED_READ_ONLY_TOOL_SET.has(toolName) ? "shared" : "exclusive"
}

/** 调度器需要从每次调用中知道的最小信息：工具名决定串并行。 */
export interface SchedulableToolCall {
  /** 用于注册、查找或调度的工具名称。 */
  toolName: string
}

/** 一次调用的结果，连同原调用一起交出，便于调用方关联 `tool/result`。 */
export interface ToolCallResult<TCall extends SchedulableToolCall> {
  /** 与结果一起交付的原始工具调用。 */
  call: TCall
  /** 当前调用整理后的统一工具结果。 */
  result: ToolResult
}

/**
 * 把有序的调用切成若干轮。
 *
 * 规则就是文件头那两句：独占工具单独一轮；共享只读工具尽可能多地凑成同一轮。
 * 纯函数，返回的每一轮内部都可以安全并发，轮与轮之间必须串行。
 * @param calls 按模型请求顺序排列的调用，不修改原数组。
 * @returns 保持调用顺序的轮数组；共享连续段同轮，独占各自成轮。
 */
export function planToolRounds<TCall extends SchedulableToolCall>(
  calls: readonly TCall[],
): TCall[][] {
  const rounds: TCall[][] = []
  let index = 0

  while (index < calls.length) {
    const call = calls[index]

    /** 该轮的第一个工具就是独占工具：本轮不再取别的。 */
    if (toolScheduleGroup(call.toolName) === "exclusive") {
      rounds.push([call])
      index += 1
      continue
    }

    /** 共享只读：一直取到取完全部、或者遇到下一个独占工具。 */
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
 * 自己按 `AbortSignal` 处理。
 * @param calls 按模型请求顺序排列的调用，不修改原数组。
 * @param execute 执行单次调用的异步入口，取消和业务失败由其处理。
 * @returns 按轮执行、同轮按完成顺序产出的原调用与工具结果。
 * @throws 执行入口抛出的首个异常在同轮其余调用完成并交付结果后传播；后续轮不启动。
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
 * @param round 当前同轮并发执行的调用集合。
 * @param execute 执行单次调用的异步入口，取消和业务失败由其处理。
 * @returns 当前轮按完成顺序产出的成功结果，消费完成后传播首个执行异常。
 * @throws 执行入口抛出的首个异常在同轮其余调用完成并交付结果后传播；后续轮不启动。
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
   * @param outcome 一次调用已完成的结果或异常。
   */
  function settle(outcome: Outcome<TCall>): void {
    completed.push(outcome)
    pending -= 1
    const resume = wake
    wake = undefined
    resume?.()
  }

  for (const call of round) {
    /** 立即启动、不等待：本轮的调用并发执行。 */
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
      /** 条件检查与设置 wake 之间没有 await，因此不会丢唤醒。 */
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
