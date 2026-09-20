/**
 * 基于文件系统的 Session Event Log 访问实现。
 *
 * 本文件只承担开发备忘录第 8、10 节中已经确定的日志职责：读取 `events.jsonl`、
 * 为恢复事件分配身份并追加落盘。派生状态初始化与修复不属于 Event Log。
 */

import { randomUUID } from "node:crypto"
import { appendFile, lstat, readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import type { SessionEvent, SessionEventInput } from "./events.ts"

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
}

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
  let appendTail = Promise.resolve()

  return {
    readEvents: async () => {
      await requireDirectory(sessionDirectory, "Session 目录")
      await requireFile(eventsPath, "Session Event Log")
      return readJsonLines(eventsPath)
    },
    appendEvent: (input) => {
      const operation = appendTail.then(async () => {
        await requireDirectory(sessionDirectory, "Session 目录")
        await requireFile(eventsPath, "Session Event Log")

        const values = await readJsonLines(eventsPath)
        const last = values.at(-1)
        if (!isRecord(last) || !isPositiveSafeInteger(last.seq)) {
          throw new Error(`无法追加 Session Event：${eventsPath} 的末尾事件缺少有效 seq。`)
        }
        if (last.seq === Number.MAX_SAFE_INTEGER) {
          throw new Error(`无法追加 Session Event：${eventsPath} 的 seq 已达到安全整数上限。`)
        }

        const eventId = createEventId()
        if (eventId.trim() === "") {
          throw new Error(`无法追加 Session Event：事件 ID 不能为空（${eventsPath}）。`)
        }

        const event = {
          ...input,
          eventId,
          sessionId: options.sessionId,
          seq: last.seq + 1,
          createdAt: now().toISOString(),
        } as SessionEvent

        let line: string
        try {
          line = `${JSON.stringify(event)}\n`
        } catch (error) {
          throw new Error(`无法序列化 Session Event：${eventsPath}`, { cause: error })
        }

        await appendFile(eventsPath, line, "utf8").catch((error: unknown) => {
          throw new Error(`无法追加 Session Event：${eventsPath}`, { cause: error })
        })
        return event
      })
      appendTail = operation.then(() => undefined, () => undefined)
      return operation
    },
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
