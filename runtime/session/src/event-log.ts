/**
 * 基于文件系统的 Session Event Log 访问实现。
 *
 * 本文件只承担开发备忘录第 8、10 节中已经确定的日志职责：读取 `events.jsonl`、
 * 为恢复事件分配身份并追加落盘。派生状态初始化与修复不属于 Event Log。
 */

import { randomUUID } from "node:crypto"
import { appendFile, lstat, readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import type {
  SessionEvent,
  SessionEventInput,
  TurnStartEvent,
  TurnStartEventInput,
  UserMessageEvent,
  UserMessageEventInput,
} from "./events.ts"

/** 文件型 Event Log 创建参数。 */
export interface FileSessionEventLogOptions {
  /** 当前 Event Log 唯一绑定的 Session ID。 */
  sessionId: string
  /** 当前 Session 目录的绝对路径。 */
  sessionDirectory: string
  /** 测试或宿主需要控制时间时使用；默认读取当前系统时间。 */
  now?: () => Date
  /** 测试或宿主需要控制事件 ID 时使用；默认生成 UUID。 */
  createEventId?: () => string
}

/** `SessionRepairPorts` 中 Event Log 部分的文件系统实现。 */
export interface FileSessionEventLog {
  /**
   * 检查 Session 目录与日志文件，并逐行解析 JSONL。
   *
   * @returns 保持日志顺序、尚待上层结构校验的 JSON 值。
   * @throws Error 当目录或日志缺失、目标不是期望类型，或任一行不是有效 JSON 时抛出。
   */
  readEvents(): Promise<readonly unknown[]>
  /**
   * 读取日志最后一个序号，为输入分配事件身份，并用一次 appendFile 追加一行 JSONL。
   * 当前实例绑定的 Session 内，并发追加会严格按调用顺序串行执行。
   *
   * @param event 内容完整但尚未分配事件身份的恢复事件。
   * @returns 已成功追加到日志的完整事件。
   * @throws Error 当日志不可读、末尾事件没有有效 seq，或追加失败时抛出。
   */
  appendEvent(event: SessionEventInput): Promise<SessionEvent>
  /**
   * 为一个新 Turn 连续分配身份，并用一次文件追加提交 `turn/start + user/message`。
   * 新 Session 只允许创建 Turn 1；已有 Session 必须从最后一个已结束 Turn 连续编号。
   *
   * @param events 顺序和 Turn 身份已经由 SessionRuntime 确定的两条事件。
   * @returns 已经成功持久化的完整事件元组。
   * @throws Error 当日志状态与待提交 Turn 不一致，或批量追加失败时抛出。
   */
  appendTurnStartAndUserMessage(
    events: readonly [TurnStartEventInput, UserMessageEventInput],
  ): Promise<readonly [TurnStartEvent, UserMessageEvent]>
}

/** 同一进程内按规范化 Event Log 路径共享的写入队列。 */
const WRITE_TAILS = new Map<string, Promise<void>>()

/**
 * 创建仅绑定到一个 Session 的文件型 Event Log。
 * 调用方应在该 Session 的活动期间复用返回实例，使全部追加共享同一条写入队列。
 *
 * @param options Session 身份、目录及可选的事件身份生成依赖。
 * @returns 只读写该 Session `events.jsonl` 的访问器。
 * @throws Error 当 Session ID 非法或 Session 目录不是绝对路径时抛出。
 */
export function createFileSessionEventLog(options: FileSessionEventLogOptions): FileSessionEventLog {
  validateSessionId(options.sessionId)
  if (!isAbsolute(options.sessionDirectory)) {
    throw new Error(`Session 目录必须是绝对路径：${options.sessionDirectory}`)
  }

  const sessionDirectory = resolve(options.sessionDirectory)
  const eventsPath = join(sessionDirectory, "events.jsonl")
  const now = options.now ?? (() => new Date())
  const createEventId = options.createEventId ?? randomUUID

  return {
    readEvents: async () => {
      await waitForWrites(eventsPath)
      await requireDirectory(sessionDirectory, "Session 目录")
      await requireFile(eventsPath, "Session Event Log")
      return readJsonLines(eventsPath)
    },
    appendEvent: (input) => {
      return runSerializedWrite(eventsPath, async () => {
        await requireDirectory(sessionDirectory, "Session 目录")
        await requireFile(eventsPath, "Session Event Log")

        const values = await readJsonLines(eventsPath)
        const nextSeq = nextSequence(values, eventsPath, 1)
        const [event] = materializeEvents(
          [input],
          options.sessionId,
          nextSeq,
          now,
          createEventId,
          eventsPath,
        )
        const line = serializeEvents([event], eventsPath)

        await appendFile(eventsPath, line, "utf8").catch((error: unknown) => {
          throw new Error(`无法追加 Session Event：${eventsPath}`, { cause: error })
        })
        return event
      })
    },
    appendTurnStartAndUserMessage: (inputs) => runSerializedWrite(eventsPath, async () => {
      await requireDirectory(sessionDirectory, "Session 目录")
      validateTurnBatch(inputs, eventsPath)

      const kind = await pathKind(eventsPath)
      let nextSeq: number
      let create = false
      if (kind === "missing") {
        if (inputs[0].turn !== 1) {
          throw new Error(`无法创建 Session Event Log：首个 Turn 必须为 1（${eventsPath}）。`)
        }
        nextSeq = 1
        create = true
      } else {
        if (kind !== "file") throw new Error(`Session Event Log 不是普通文件：${eventsPath}`)
        const values = await readJsonLines(eventsPath)
        validateNextTurn(values, inputs[0].turn, eventsPath)
        nextSeq = nextSequence(values, eventsPath, 2)
      }

      const written = materializeEvents(
        inputs,
        options.sessionId,
        nextSeq,
        now,
        createEventId,
        eventsPath,
      ) as [TurnStartEvent, UserMessageEvent]
      const content = serializeEvents(written, eventsPath)
      const appendOptions = create
        ? { encoding: "utf8" as const, flag: "ax" }
        : { encoding: "utf8" as const, flag: "a" }
      await appendFile(eventsPath, content, appendOptions).catch((error: unknown) => {
        throw new Error(`无法批量追加 Session Turn 事件：${eventsPath}`, { cause: error })
      })
      return written
    }),
  }
}

/**
 * 在当前 Event Log 的共享队列中串行运行一次写入。
 *
 * @param eventsPath 规范化的 Event Log 路径。
 * @param operation 必须独占当前日志执行的写入操作。
 * @returns 写入操作的结果。
 */
function runSerializedWrite<T>(eventsPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = WRITE_TAILS.get(eventsPath) ?? Promise.resolve()
  const result = previous.then(operation)
  const settled = result.then(() => undefined, () => undefined)
  WRITE_TAILS.set(eventsPath, settled)
  void settled.then(() => {
    if (WRITE_TAILS.get(eventsPath) === settled) WRITE_TAILS.delete(eventsPath)
  })
  return result
}

/** @param eventsPath 要等候较早写入完成的 Event Log 路径。 */
async function waitForWrites(eventsPath: string): Promise<void> {
  await (WRITE_TAILS.get(eventsPath) ?? Promise.resolve())
}

/**
 * 校验 Turn 首批事件的顺序与共同身份。
 *
 * @param events 待提交的固定二元组。
 * @param eventsPath 错误定位使用的 Event Log 路径。
 * @throws Error 当事件类型、Turn 或消息身份不符合提交边界时抛出。
 */
function validateTurnBatch(
  events: readonly [TurnStartEventInput, UserMessageEventInput],
  eventsPath: string,
): void {
  const [start, message] = events
  if (start.type !== "turn/start" || message.type !== "user/message") {
    throw new Error(`Session Turn 批次顺序无效：${eventsPath}`)
  }
  if (!isPositiveSafeInteger(start.turn) || message.turn !== start.turn) {
    throw new Error(`Session Turn 批次编号无效：${eventsPath}`)
  }
  if (
    !isRecord(message.message)
    || message.message.role !== "user"
    || typeof message.message.id !== "string"
    || message.message.id.trim() === ""
  ) {
    throw new Error(`Session Turn 批次的用户消息无效：${eventsPath}`)
  }
}

/**
 * 根据已有日志确认待写 Turn 是最后一个完整 Turn 的连续下一项。
 *
 * @param values 已从 JSONL 读取的日志值。
 * @param turn 待提交的 Turn 编号。
 * @param eventsPath 错误定位使用的 Event Log 路径。
 * @throws Error 当日志为空、上一 Turn 未结束或 Turn 编号不连续时抛出。
 */
function validateNextTurn(values: readonly unknown[], turn: number, eventsPath: string): void {
  if (values.length === 0) throw new Error(`Session Event Log 为空，不能继续 Turn：${eventsPath}`)
  const lastStart = [...values].reverse().find((value) => isRecord(value) && value.type === "turn/start")
  const lastEnd = [...values].reverse().find((value) => isRecord(value) && value.type === "turn/end")
  if (
    !isRecord(lastStart)
    || !isPositiveSafeInteger(lastStart.turn)
    || !isRecord(lastEnd)
    || lastEnd.turn !== lastStart.turn
  ) {
    throw new Error(`上一个 Session Turn 尚未完整结束：${eventsPath}`)
  }
  const expectedTurn = lastStart.turn + 1
  if (turn !== expectedTurn) {
    throw new Error(`Session Turn 编号不连续：期望 ${expectedTurn}，实际 ${turn}（${eventsPath}）。`)
  }

  for (const value of values) {
    if (
      isRecord(value)
      && value.type === "context_update"
      && typeof value.turn === "number"
      && value.turn > lastStart.turn
      && value.turn !== turn
    ) {
      throw new Error(`Session context_update 不属于待提交 Turn ${turn}：${eventsPath}`)
    }
  }
}

/**
 * 计算一批事件可使用的起始序号。
 *
 * @param values 当前日志值。
 * @param eventsPath 错误定位使用的 Event Log 路径。
 * @param count 本次需要分配的事件数量。
 * @returns 第一条新事件应使用的 seq。
 */
function nextSequence(values: readonly unknown[], eventsPath: string, count: number): number {
  const last = values.at(-1)
  if (!isRecord(last) || !isPositiveSafeInteger(last.seq)) {
    throw new Error(`无法追加 Session Event：${eventsPath} 的末尾事件缺少有效 seq。`)
  }
  if (last.seq > Number.MAX_SAFE_INTEGER - count) {
    throw new Error(`无法追加 Session Event：${eventsPath} 的 seq 已达到安全整数上限。`)
  }
  return last.seq + 1
}

/**
 * 为一组事件输入分配连续身份。
 *
 * @param inputs 尚未分配身份的事件。
 * @param sessionId 当前日志绑定的 Session ID。
 * @param firstSeq 第一条事件使用的 seq。
 * @param now 时间来源。
 * @param createEventId 事件 ID 来源。
 * @param eventsPath 错误定位使用的 Event Log 路径。
 * @returns 已经分配完整身份、尚未落盘的事件。
 */
function materializeEvents(
  inputs: readonly SessionEventInput[],
  sessionId: string,
  firstSeq: number,
  now: () => Date,
  createEventId: () => string,
  eventsPath: string,
): SessionEvent[] {
  return inputs.map((input, index) => {
    const eventId = createEventId()
    if (eventId.trim() === "") {
      throw new Error(`无法追加 Session Event：事件 ID 不能为空（${eventsPath}）。`)
    }
    return {
      ...input,
      eventId,
      sessionId,
      seq: firstSeq + index,
      createdAt: now().toISOString(),
    } as SessionEvent
  })
}

/**
 * 在实际写文件前一次性序列化全部事件，避免序列化失败产生半批次。
 *
 * @param events 待持久化事件。
 * @param eventsPath 错误定位使用的 Event Log 路径。
 * @returns 以换行结尾的 JSONL 文本。
 */
function serializeEvents(events: readonly SessionEvent[], eventsPath: string): string {
  try {
    return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  } catch (error) {
    throw new Error(`无法序列化 Session Event：${eventsPath}`, { cause: error })
  }
}

/**
 * 校验绑定到文件访问器的 Session ID。
 *
 * @param sessionId 调用方提供的 Session ID。
 * @throws Error 当 Session ID 为空、包含路径分隔符或为相对目录标记时抛出。
 */
function validateSessionId(sessionId: string): void {
  if (
    sessionId.trim() === ""
    || sessionId === "."
    || sessionId === ".."
    || sessionId.includes("/")
    || sessionId.includes("\\")
  ) {
    throw new Error(`Session ID 必须是不含路径分隔符的非空目录名：${sessionId}`)
  }
}

/**
 * 读取路径当前类型；不存在时返回 `missing`。
 *
 * @param path 待检查路径。
 * @returns 普通文件、目录、其它节点或不存在。
 */
async function pathKind(path: string): Promise<"file" | "directory" | "other" | "missing"> {
  try {
    const stats = await lstat(path)
    if (stats.isFile()) return "file"
    if (stats.isDirectory()) return "directory"
    return "other"
  } catch (error) {
    if (isFileNotFoundError(error)) return "missing"
    throw new Error(`无法检查 Session Event Log：${path}`, { cause: error })
  }
}

/** @returns 未知异常是否表示目标路径不存在。 */
function isFileNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
}

/**
 * 要求路径当前是普通目录。
 *
 * @param path 要检查的绝对路径。
 * @param label 错误信息中的目标名称。
 * @throws Error 当路径不可访问或不是目录时抛出。
 */
async function requireDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path).catch((error: unknown) => {
    throw new Error(`${label}不存在或无法访问：${path}`, { cause: error })
  })
  if (!stats.isDirectory()) {
    throw new Error(`${label}不是目录：${path}`)
  }
}

/**
 * 要求路径当前是普通文件；符号链接及目录均不作为 Event Log 接受。
 *
 * @param path 要检查的绝对路径。
 * @param label 错误信息中的目标名称。
 * @throws Error 当路径不可访问或不是普通文件时抛出。
 */
async function requireFile(path: string, label: string): Promise<void> {
  const stats = await lstat(path).catch((error: unknown) => {
    throw new Error(`${label}不存在或无法访问：${path}`, { cause: error })
  })
  if (!stats.isFile()) {
    throw new Error(`${label}不是普通文件：${path}`)
  }
}

/**
 * 逐行解析 JSONL；仅允许文件末尾由换行产生的一个空片段。
 *
 * @param eventsPath 要读取的 Event Log 绝对路径。
 * @returns 每个非空日志行解析出的 JSON 值。
 * @throws Error 当文件读取失败、日志中出现空行或某一行不是有效 JSON 时抛出。
 */
async function readJsonLines(eventsPath: string): Promise<unknown[]> {
  const content = await readFile(eventsPath, "utf8").catch((error: unknown) => {
    throw new Error(`无法读取 Session Event Log：${eventsPath}`, { cause: error })
  })
  if (content === "") return []

  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()

  return lines.map((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (line.trim() === "") {
      throw new Error(`Session Event Log 第 ${index + 1} 行为空：${eventsPath}`)
    }
    try {
      return JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`Session Event Log 第 ${index + 1} 行不是有效 JSON：${eventsPath}`, { cause: error })
    }
  })
}

/**
 * 判断未知值是否为非数组对象。
 *
 * @param value 待检查的未知值。
 * @returns 值是否可按字符串字段读取。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 判断未知值是否为正的安全整数。
 *
 * @param value 待检查的未知值。
 * @returns 值是否可用作 Session Event seq。
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
