/**
 * Session 派生持久化状态的文件实现。
 *
 * Event Log 是事实来源；本文件只创建和修复 `meta.json`、`contextstate.json`、
 * `agents_md.snapshot` 与 `tool_output/`。首次初始化中断按项目负责人确认的规则，
 * 使用恢复当下的 AGENTS.md / Skill / MCP 状态建立基线。
 */

import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { PROTOCOLS } from "../../model/src/types.ts"
import type { ModelRef, UnifiedToolDefinition } from "../../model/src/types.ts"
import type { ContextUpdateEvent, SessionEvent, SkillContextChange, SkillScope } from "./events.ts"

/** 当前 `meta.json` 已确认的持久化结构版本。 */
export const SESSION_META_VERSION = 1 as const

/** `meta.json.sandboxMode` 支持的对话级沙盒模式。 */
export const SANDBOX_MODES = [
  "full-access",
  "sandbox-full-access",
  "sandbox-read-only",
] as const

/** 对话级持久化沙盒模式。 */
export type SandboxMode = (typeof SANDBOX_MODES)[number]

/** 新 Session 创建时使用的默认沙盒模式。 */
export const DEFAULT_SESSION_SANDBOX_MODE: SandboxMode = "sandbox-full-access"

/** `meta.json.usage` 的 V1 派生结构。 */
export interface RealUsage {
  /** 最近一次正常 Agent 请求的完整输入 Token。 */
  inputTokens: number
  /** Session 内累计缓存读取 Token。 */
  cacheHitTokens: number
  /** Session 内累计未缓存输入 Token。 */
  cacheMissTokens: number
  /** 累计缓存命中率；分母为 0 时为 0。 */
  cacheHitRate: number
}

/** `meta.json` 中用于下一 Turn Skill 增量比较的条目。 */
export interface SessionSkillContextEntry {
  name: string
  scope: SkillScope
  enabled: boolean
  estimatedTokens: number
}

/** `meta.json` 中的 Session Skill 比较状态。 */
export interface SessionSkillContextState {
  id: string | null
  entries: SessionSkillContextEntry[]
}

/** 当前已确认的 `meta.json` 字段；其它 Runtime 字段由初始化提供者原样保留。 */
export interface SessionMeta {
  /** `meta.json` 的持久化结构版本。 */
  version: typeof SESSION_META_VERSION
  currentModel: ModelRef
  /** 当前 Session 的工具权限模式；不从全局或 Project 配置继承。 */
  sandboxMode: SandboxMode
  usage: RealUsage
  skills: SessionSkillContextState
  [field: string]: unknown
}

/** `contextstate.json` 的已确认结构。 */
export interface SessionContextState {
  agentsmd: {
    hash: string
    content: string
  }
  skills: {
    id: string
    content: string
  }
  mcp: UnifiedToolDefinition[]
}

/** 恢复当下由 Project / Skill / MCP Runtime 汇总出的初始化基线。 */
export interface CurrentSessionBaseline {
  agentsmd: {
    /** 当前实际参与比较的 AGENTS.md 绝对路径。 */
    path: string
    hash: string
    content: string
  }
  skills: {
    content: string
    entries: SessionSkillContextEntry[]
    /** 按 Skill 名称保存已经过预算处理、可写入增量事件的 description。 */
    descriptions: Record<string, string>
  }
  mcp: UnifiedToolDefinition[]
  /**
   * 尚未在架构文档中固定字段名的其它 meta 状态，例如 Session Loaded MCP Tools。
   * 不得包含 `version`、`currentModel`、`sandboxMode`、`usage` 或 `skills`，这些字段由本模块维护。
   */
  additionalMeta?: Record<string, unknown>
}

/** 文件型 SessionState 创建参数。 */
export interface FileSessionStateOptions {
  /** 当前 SessionState 唯一绑定的 Session ID。 */
  sessionId: string
  /** 当前 Session 目录的绝对路径。 */
  sessionDirectory: string
  /** 从 Event Log 读取尚未窄化的事件；组合实现使用同一个 FileSessionEventLog。 */
  readEvents(): Promise<readonly unknown[]>
  /** 读取恢复当下的 AGENTS.md、Skill、MCP 及其它 Session meta 基线。 */
  resolveCurrentBaseline(): Promise<CurrentSessionBaseline>
  /** 计算 Skill description 的估算 Token，用于重放 Skill 增量。 */
  estimateSkillTokens(description: string): number
}

/** `SessionRepairPorts` 中派生状态部分的文件系统实现。 */
export interface FileSessionState {
  /**
   * 幂等补齐或重建缺失、损坏的 Session 派生文件。
   *
   * @throws Error 当 Session 路径、Event Log 或当前初始化基线无效时抛出。
   */
  initializeSession(): Promise<void>
  /**
   * 在当前 Session 的串行状态队列中重新读取完整 `meta.json`，仅替换
   * `currentModel`，并原子写回全部其它字段。
   *
   * @param model 要保存为下一 Turn 选择的完整模型引用。
   * @throws Error 当模型引用、Session Meta 或原子写入无效时抛出。
   */
  writeCurrentModel(model: ModelRef): Promise<void>
  /**
   * 每次调用都从磁盘重新打开并校验当前 Session 的 `meta.json`。
   *
   * @returns 与解析结果脱离引用关系的当前模型引用。
   * @throws Error 当 Session Meta 缺失、损坏或不可读取时抛出。
   */
  readCurrentModel(): Promise<ModelRef>
  /**
   * 从已校验 Event Log 全量重建 Usage，并修复已提交的 AGENTS.md / Skill 增量。
   * 该方法不修改 Event Log，也不应用未提交的 Summary。
   *
   * @param events 已由 SessionRuntime 完成结构和生命周期校验的事件。
   * @throws Error 当派生文件无法读取、写入或无法按已确认结构解释时抛出。
   */
  repairDerivedState(events: readonly SessionEvent[]): Promise<void>
  /**
   * 读取已有 Session 在下一 Turn 开始前需要比较的 AGENTS.md 快照和 Skill 状态。
   *
   * @returns 与当前磁盘状态脱离引用关系的比较值。
   * @throws Error 当派生状态缺失或结构无效时抛出。
   */
  readContextComparisonState(): Promise<{
    agentsSnapshot: string
    skills: SessionSkillContextState
  }>
}

/** Project 分组目录使用的非负数字身份。 */
export type ProjectId = number

/** Session 目录使用的不含路径分隔符的身份。 */
export type SessionId = string

const EMPTY_USAGE: RealUsage = {
  inputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  cacheHitRate: 0,
}

/**
 * 创建仅绑定到一个 Session 的文件型 SessionState。
 *
 * @param options Session 身份、目录、Event Log 读取器和当前上下文基线提供者。
 * @returns 只初始化和修复该 Session 派生文件的访问器。
 * @throws Error 当 Session ID 非法或 Session 目录不是绝对路径时抛出。
 */
export function createFileSessionState(options: FileSessionStateOptions): FileSessionState {
  validateSessionId(options.sessionId)
  if (!isAbsolute(options.sessionDirectory)) {
    throw new Error(`Session 目录必须是绝对路径：${options.sessionDirectory}`)
  }
  const paths = resolveStatePaths(resolve(options.sessionDirectory))
  const queue = getSessionStateQueue(paths.sessionDirectory)

  /**
   * 在同一 Session 的状态队列内补齐全部派生文件。
   *
   * @throws Error 当路径、当前基线或 Event Log 无法用于初始化时抛出。
   */
  const initializeSession = async (): Promise<void> => {
    await runSerialized(queue, async () => {
      await requireDirectory(paths.sessionDirectory, "Session 目录")

      const [meta, contextState, snapshot] = await Promise.all([
        readOptionalJson(paths.metaPath, isSessionMeta),
        readOptionalJson(paths.contextStatePath, isSessionContextState),
        readOptionalTextFile(paths.agentsSnapshotPath),
      ])
      await ensureDirectory(paths.toolOutputDirectory, "Session Tool Output 目录")

      const needsMeta = meta === undefined
      const needsAgentBaseline = contextState === undefined || snapshot === undefined
      const needsContextState = contextState === undefined
      if (!needsMeta && !needsAgentBaseline && !needsContextState) return

      const baseline = await options.resolveCurrentBaseline()
      validateCurrentBaseline(baseline)
      const rawEvents = await options.readEvents()
      const turnModel = findLastTurnModel(rawEvents, paths.eventsPath)
      const latestSkillEventId = findLatestSkillEventId(rawEvents)

      if (needsMeta) {
        const additionalMeta = baseline.additionalMeta ?? {}
        for (const reserved of ["version", "currentModel", "sandboxMode", "usage", "skills"]) {
          if (reserved in additionalMeta) {
            throw new Error(`当前 Session 基线的 additionalMeta 不得包含保留字段 ${reserved}。`)
          }
        }
        const initialMeta: SessionMeta = {
          ...additionalMeta,
          version: SESSION_META_VERSION,
          currentModel: turnModel,
          sandboxMode: DEFAULT_SESSION_SANDBOX_MODE,
          usage: { ...EMPTY_USAGE },
          skills: {
            id: latestSkillEventId,
            entries: cloneSkillEntries(baseline.skills.entries),
          },
        }
        await atomicWriteJson(paths.metaPath, initialMeta)
      }

      let nextContextState = contextState
      if (needsContextState) {
        nextContextState = {
          agentsmd: {
            hash: baseline.agentsmd.hash,
            content: baseline.agentsmd.content,
          },
          skills: { id: "initial", content: baseline.skills.content },
          mcp: structuredClone(baseline.mcp),
        }
      } else if (needsAgentBaseline) {
        nextContextState = {
          ...contextState,
          agentsmd: {
            hash: baseline.agentsmd.hash,
            content: baseline.agentsmd.content,
          },
        }
      }
      if (nextContextState !== contextState) {
        await atomicWriteJson(paths.contextStatePath, nextContextState)
      }

      if (needsAgentBaseline) {
        await atomicWriteText(paths.agentsSnapshotPath, baseline.agentsmd.content)
      }
    })
  }

  /** 在当前 Session 的共享状态队列中原子更新模型选择。 */
  const writeBoundCurrentModel = async (model: ModelRef): Promise<void> => {
    await writeCurrentModelAtPaths(paths, queue, model)
  }

  /** 在当前 Session 的共享状态队列中从磁盘重新读取模型选择。 */
  const readCurrentModel = async (): Promise<ModelRef> => runSerialized(queue, async () => {
    const meta = await readRequiredJson(paths.metaPath, isSessionMeta, "Session Meta")
    return structuredClone(meta.currentModel)
  })

  /**
   * 在同一 Session 的状态队列内重放权威事件并原子更新派生文件。
   *
   * @param events 已通过 SessionRuntime 校验的 Event Log。
   * @throws Error 当派生文件无效或无法持久化修复结果时抛出。
   */
  const repairDerivedState = async (
    events: readonly SessionEvent[],
  ): Promise<void> => {
    await runSerialized(queue, async () => {
      const meta = await readRequiredJson(paths.metaPath, isSessionMeta, "Session Meta")
      const contextState = await readRequiredJson(
        paths.contextStatePath,
        isSessionContextState,
        "Session Context State",
      )
      const snapshot = await readRequiredTextFile(paths.agentsSnapshotPath, "AGENTS.md 比较快照")

      const nextMeta: SessionMeta = {
        ...meta,
        usage: rebuildUsage(events),
        skills: {
          id: meta.skills.id,
          entries: cloneSkillEntries(meta.skills.entries),
        },
      }
      let nextContextState = contextState
      let nextSnapshot = snapshot

      const latestAgentsUpdate = findLatestAgentsUpdate(events)
      if (latestAgentsUpdate !== undefined) {
        const agentsmd = {
          hash: latestAgentsUpdate.source.hash,
          content: latestAgentsUpdate.source.fullContent,
        }
        if (!isDeepStrictEqual(contextState.agentsmd, agentsmd)) {
          nextContextState = { ...nextContextState, agentsmd }
        }
        nextSnapshot = latestAgentsUpdate.source.fullContent
      }

      const skillEvents = events.filter(isSkillContextUpdate)
      const cursorIndex = nextMeta.skills.id === null
        ? -1
        : skillEvents.findIndex((event) => event.eventId === nextMeta.skills.id)
      let shouldUseCurrentSkillBaseline = nextMeta.skills.id !== null && cursorIndex < 0

      if (!shouldUseCurrentSkillBaseline) {
        for (const event of skillEvents.slice(cursorIndex + 1)) {
          if (!applySkillChanges(nextMeta.skills.entries, event.source.changes, options.estimateSkillTokens)) {
            shouldUseCurrentSkillBaseline = true
            break
          }
          nextMeta.skills.id = event.eventId
        }
      }

      if (shouldUseCurrentSkillBaseline) {
        const baseline = await options.resolveCurrentBaseline()
        validateCurrentBaseline(baseline)
        nextMeta.skills = {
          id: skillEvents.at(-1)?.eventId ?? null,
          entries: cloneSkillEntries(baseline.skills.entries),
        }
      }

      if (!isDeepStrictEqual(meta, nextMeta)) await atomicWriteJson(paths.metaPath, nextMeta)
      if (!isDeepStrictEqual(contextState, nextContextState)) {
        await atomicWriteJson(paths.contextStatePath, nextContextState)
      }
      if (snapshot !== nextSnapshot) await atomicWriteText(paths.agentsSnapshotPath, nextSnapshot)

    })
  }

  /** 在 SessionState 串行队列中读取 Turn 开始增量比较状态。 */
  const readContextComparisonState = async (): Promise<{
    agentsSnapshot: string
    skills: SessionSkillContextState
  }> => runSerialized(queue, async () => {
    const meta = await readRequiredJson(paths.metaPath, isSessionMeta, "Session Meta")
    const agentsSnapshot = await readRequiredTextFile(paths.agentsSnapshotPath, "AGENTS.md 比较快照")
    return {
      agentsSnapshot,
      skills: {
        id: meta.skills.id,
        entries: cloneSkillEntries(meta.skills.entries),
      },
    }
  })

  return {
    initializeSession,
    writeCurrentModel: writeBoundCurrentModel,
    readCurrentModel,
    repairDerivedState,
    readContextComparisonState,
  }
}

/**
 * 按全局持久化目录定位 Session，并在该 Session 共用的状态队列中更新模型选择。
 *
 * 该函数使用 `%USERPROFILE%/.nicode/sessions/<projectId>/<sessionId>/meta.json`；
 * 已经持有绑定式 {@link FileSessionState} 的 Runtime 应优先调用实例方法。
 *
 * @param projectId Session 所属 Project 的非负数字身份。
 * @param sessionId Session 目录身份。
 * @param model 要保存的完整模型引用。
 * @throws Error 当 USERPROFILE、身份、模型引用或 Session Meta 无效时抛出。
 */
export async function writeCurrentModel(
  projectId: ProjectId,
  sessionId: SessionId,
  model: ModelRef,
): Promise<void> {
  if (!Number.isSafeInteger(projectId) || projectId < 0) {
    throw new Error(`Project ID 必须是非负安全整数：${projectId}`)
  }
  validateSessionId(sessionId)
  const userProfile = process.env.USERPROFILE
  if (!userProfile || !isAbsolute(userProfile)) {
    throw new Error("USERPROFILE 必须是非空的绝对路径。")
  }
  const paths = resolveStatePaths(resolve(
    userProfile,
    ".nicode",
    "sessions",
    String(projectId),
    sessionId,
  ))
  await writeCurrentModelAtPaths(
    paths,
    getSessionStateQueue(paths.sessionDirectory),
    model,
  )
}

interface SessionStatePaths {
  /** 当前 Session 根目录。 */
  sessionDirectory: string
  /** 当前 Session Event Log；仅用于错误定位。 */
  eventsPath: string
  /** Session 元数据文件。 */
  metaPath: string
  /** Session 固定上下文状态文件。 */
  contextStatePath: string
  /** AGENTS.md 增量比较快照。 */
  agentsSnapshotPath: string
  /** 大型工具输出目录。 */
  toolOutputDirectory: string
}

/**
 * 校验绑定到派生状态访问器的 Session ID。
 *
 * @param sessionId 调用方提供的 Session ID。
 * @throws Error 当 Session ID 为空、为相对目录标记或包含路径分隔符时抛出。
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
 * 由已经绑定并规范化的 Session 目录生成全部派生状态路径。
 *
 * @param sessionDirectory 当前 Session 的绝对目录。
 * @returns 当前 Session 的全部派生状态路径。
 */
function resolveStatePaths(sessionDirectory: string): SessionStatePaths {
  return {
    sessionDirectory,
    eventsPath: join(sessionDirectory, "events.jsonl"),
    metaPath: join(sessionDirectory, "meta.json"),
    contextStatePath: join(sessionDirectory, "contextstate.json"),
    agentsSnapshotPath: join(sessionDirectory, "agents_md.snapshot"),
    toolOutputDirectory: join(sessionDirectory, "tool_output"),
  }
}

/**
 * 从 Event Log 最后一个 `turn/start` 取得派生 meta 的当前模型。
 *
 * @param values 尚未由本模块窄化的 Event Log 值。
 * @param eventsPath Event Log 路径，用于错误定位。
 * @returns 最后一个 Turn 实际采用的模型。
 * @throws Error 当日志没有 `turn/start` 或其模型无效时抛出。
 */
function findLastTurnModel(values: readonly unknown[], eventsPath: string): ModelRef {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (!isRecord(value) || value.type !== "turn/start") continue
    if (!isModelRef(value.model)) {
      throw new Error(`无法初始化 Session Meta：${eventsPath} 的 turn/start.model 无效。`)
    }
    return structuredClone(value.model)
  }
  throw new Error(`无法初始化 Session Meta：${eventsPath} 缺少 turn/start。`)
}

/**
 * 找出日志中最后一条 Skill 增量事件的 ID。
 *
 * @param values 尚未由本模块窄化的 Event Log 值。
 * @returns 最后一条 Skill 增量的事件 ID；不存在时返回 null。
 */
function findLatestSkillEventId(values: readonly unknown[]): string | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (!isRecord(value) || value.type !== "context_update" || !isRecord(value.source)) continue
    if (value.source.type === "skill" && typeof value.eventId === "string" && value.eventId.trim() !== "") {
      return value.eventId
    }
  }
  return null
}

/**
 * 按 seq 顺序从权威 `assistant/message.usage` 全量重建 meta.usage。
 *
 * 缺失缓存字段按项目负责人确认的规则作为 0；Compression Usage 不进入该结构。
 *
 * @param events 已通过 SessionRuntime 校验的 Event Log。
 * @returns 可覆盖写入 `meta.json` 的四项 Usage 派生统计。
 */
function rebuildUsage(events: readonly SessionEvent[]): RealUsage {
  const usage: RealUsage = { ...EMPTY_USAGE }
  for (const event of events) {
    if (event.type !== "assistant/message" || event.usage === undefined) continue
    // 项目负责人于 2026-09-19 明确：厂商未报告的缓存字段在此派生统计中按 0 处理。
    const cacheReadTokens = event.usage.cacheReadTokens ?? 0
    const cacheWriteTokens = event.usage.cacheWriteTokens ?? 0
    usage.inputTokens = event.usage.inputTokens + cacheReadTokens + cacheWriteTokens
    usage.cacheHitTokens += cacheReadTokens
    usage.cacheMissTokens += event.usage.inputTokens
  }
  const total = usage.cacheHitTokens + usage.cacheMissTokens
  usage.cacheHitRate = total === 0 ? 0 : usage.cacheHitTokens / total
  return usage
}

/**
 * 找出最后一条已提交的 AGENTS.md 增量。
 *
 * @param events 已通过 SessionRuntime 校验的事件。
 * @returns 最后一条 AGENTS.md 增量；不存在时返回 undefined。
 */
function findLatestAgentsUpdate(
  events: readonly SessionEvent[],
): (ContextUpdateEvent & { source: Extract<ContextUpdateEvent["source"], { type: "agents_md" }> }) | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === "context_update" && event.source.type === "agents_md") {
      return event as ContextUpdateEvent & {
        source: Extract<ContextUpdateEvent["source"], { type: "agents_md" }>
      }
    }
  }
  return undefined
}

/**
 * 判断事件是否为 Skill 上下文增量。
 *
 * @param event 待判断的 Session 事件。
 * @returns 事件是否为 Skill `context_update`。
 */
function isSkillContextUpdate(
  event: SessionEvent,
): event is ContextUpdateEvent & { source: Extract<ContextUpdateEvent["source"], { type: "skill" }> } {
  return event.type === "context_update" && event.source.type === "skill"
}

/**
 * 把一条已提交 Skill 增量幂等应用到 meta 条目。
 *
 * @param entries 当前 `meta.skills.entries`；成功时原地推进。
 * @param changes Event Log 中已经提交的 Skill changes。
 * @param estimateSkillTokens Skill description 的 Token 估算器。
 * @returns 全部 change 均可由现有信息应用时返回 true；缺少 enabled/disabled 目标时返回 false。
 */
function applySkillChanges(
  entries: SessionSkillContextEntry[],
  changes: readonly SkillContextChange[],
  estimateSkillTokens: (description: string) => number,
): boolean {
  for (const change of changes) {
    const index = entries.findIndex((entry) => entry.name === change.name)
    switch (change.type) {
      case "new": {
        const entry = skillEntryFromDescription(change.name, change.scope, change.description, estimateSkillTokens)
        if (index < 0) entries.push(entry)
        else entries[index] = entry
        break
      }
      case "replaced": {
        const entry = skillEntryFromDescription(change.name, change.toScope, change.description, estimateSkillTokens)
        if (index < 0) entries.push(entry)
        else entries[index] = entry
        break
      }
      case "enabled":
        if (index < 0) return false
        entries[index] = { ...entries[index], enabled: true }
        break
      case "disabled":
        if (index < 0) return false
        entries[index] = { ...entries[index], enabled: false }
        break
    }
  }
  return true
}

/**
 * 由事件中的 description 生成可持久化 Skill 比较条目。
 *
 * @param name Skill 名称。
 * @param scope Skill 当前来源作用域。
 * @param description 用于估算 Token 的描述。
 * @param estimateSkillTokens 调用 Context TokenEstimator 的注入函数。
 * @returns 启用状态的 Skill 比较条目。
 * @throws Error 当估算结果不是非负安全整数时抛出。
 */
function skillEntryFromDescription(
  name: string,
  scope: SkillScope,
  description: string,
  estimateSkillTokens: (description: string) => number,
): SessionSkillContextEntry {
  const estimatedTokens = estimateSkillTokens(description)
  if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) {
    throw new Error(`Skill ${name} 的 estimatedTokens 必须是非负安全整数。`)
  }
  return { name, scope, enabled: true, estimatedTokens }
}

/**
 * 校验初始化提供者返回的当前基线，避免把无效派生状态写入磁盘。
 *
 * @param baseline Project / Skill / MCP Runtime 汇总的当前状态。
 * @throws Error 当任一已确认字段不符合持久化结构时抛出。
 */
function validateCurrentBaseline(baseline: CurrentSessionBaseline): void {
  if (
    !isRecord(baseline)
    || !isAgentsState(baseline.agentsmd)
    || !isAbsolute(baseline.agentsmd.path)
  ) {
    throw new Error("当前 Session 基线的 agentsmd 无效。")
  }
  if (
    !isRecord(baseline.skills)
    || typeof baseline.skills.content !== "string"
    || !isSkillEntries(baseline.skills.entries)
    || !isRecord(baseline.skills.descriptions)
    || !baseline.skills.entries.every((entry) =>
      typeof baseline.skills.descriptions[entry.name] === "string"
    )
  ) {
    throw new Error("当前 Session 基线的 skills 无效。")
  }
  if (!Array.isArray(baseline.mcp) || !baseline.mcp.every(isUnifiedToolDefinition)) {
    throw new Error("当前 Session 基线的 mcp 无效。")
  }
  if (baseline.additionalMeta !== undefined && !isRecord(baseline.additionalMeta)) {
    throw new Error("当前 Session 基线的 additionalMeta 无效。")
  }
}

/**
 * 读取可修复 JSON 文件；缺失、非法 JSON 或结构不符均返回 undefined。
 *
 * @param path 派生 JSON 文件路径。
 * @param validate 对应持久化结构的类型守卫。
 * @returns 有效对象；文件缺失或内容损坏时返回 undefined。
 * @throws Error 当路径不是普通文件或读取失败时抛出。
 */
async function readOptionalJson<T>(path: string, validate: (value: unknown) => value is T): Promise<T | undefined> {
  const kind = await pathKind(path)
  if (kind === "missing") return undefined
  if (kind !== "file") throw new Error(`Session 派生状态不是普通文件：${path}`)
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    throw new Error(`无法读取 Session 派生状态：${path}`, { cause: error })
  }
  try {
    const value = JSON.parse(content) as unknown
    return validate(value) ? value : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * 读取修复阶段必须存在且结构有效的 JSON 文件。
 *
 * @param path 派生 JSON 文件路径。
 * @param validate 对应持久化结构的类型守卫。
 * @param label 错误信息中的状态名称。
 * @returns 已通过结构检查的对象。
 * @throws Error 当文件缺失、不可读或结构无效时抛出。
 */
async function readRequiredJson<T>(
  path: string,
  validate: (value: unknown) => value is T,
  label: string,
): Promise<T> {
  const value = await readOptionalJson(path, validate)
  if (value === undefined) throw new Error(`${label} 缺失或结构无效：${path}`)
  return value
}

/**
 * 读取可修复文本文件；缺失返回 undefined，非普通文件拒绝。
 *
 * @param path 派生文本文件路径。
 * @returns 文件内容；缺失时返回 undefined。
 * @throws Error 当路径不是普通文件或读取失败时抛出。
 */
async function readOptionalTextFile(path: string): Promise<string | undefined> {
  const kind = await pathKind(path)
  if (kind === "missing") return undefined
  if (kind !== "file") throw new Error(`Session 派生状态不是普通文件：${path}`)
  return readFile(path, "utf8")
}

/**
 * 读取修复阶段必须存在的文本文件。
 *
 * @param path 派生文本文件路径。
 * @param label 错误信息中的状态名称。
 * @returns 文件原文。
 * @throws Error 当文件缺失、不是普通文件或读取失败时抛出。
 */
async function readRequiredTextFile(path: string, label: string): Promise<string> {
  const value = await readOptionalTextFile(path)
  if (value === undefined) throw new Error(`${label} 缺失：${path}`)
  return value
}

/**
 * 确保路径存在且为目录；缺失时递归创建。
 *
 * @param path 目标目录路径。
 * @param label 错误信息中的目录名称。
 * @throws Error 当现有路径不是目录或创建失败时抛出。
 */
async function ensureDirectory(path: string, label: string): Promise<void> {
  const kind = await pathKind(path)
  if (kind === "missing") {
    await mkdir(path, { recursive: true })
    return
  }
  if (kind !== "directory") throw new Error(`${label}不是目录：${path}`)
}

/**
 * 要求路径当前是普通目录。
 *
 * @param path 目标目录路径。
 * @param label 错误信息中的目录名称。
 * @throws Error 当路径缺失或不是目录时抛出。
 */
async function requireDirectory(path: string, label: string): Promise<void> {
  if (await pathKind(path) !== "directory") throw new Error(`${label}不存在或不是目录：${path}`)
}

/**
 * 原子写入格式化 JSON，并以换行结尾。
 *
 * @param path 目标 JSON 文件路径。
 * @param value 可序列化的派生状态。
 * @throws Error 当序列化或写入失败时抛出。
 */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 在同目录写临时文件后原子替换目标文件。
 *
 * @param path 目标文件路径。
 * @param content 要完整写入的文本。
 * @throws Error 当临时文件写入或替换失败时抛出。
 */
async function atomicWriteText(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" })
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw new Error(`无法原子写入 Session 派生状态：${path}`, { cause: error })
  }
}

/**
 * 获取路径种类；不存在与其它访问错误分开处理。
 *
 * @param path 要检查的路径。
 * @returns 缺失、普通文件、目录或其它文件系统对象。
 * @throws Error 当路径检查因 ENOENT 以外原因失败时抛出。
 */
async function pathKind(path: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const stats = await lstat(path)
    if (stats.isFile()) return "file"
    if (stats.isDirectory()) return "directory"
    return "other"
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing"
    throw new Error(`无法检查 Session 派生状态：${path}`, { cause: error })
  }
}

/** 按规范化 Session 目录保存跨访问器共享的派生状态队列。 */
const SESSION_STATE_QUEUES = new Map<string, SerializedQueue>()

/**
 * 取得同一 Session 目录唯一的进程内状态队列。
 *
 * @param sessionDirectory 已规范化或可规范化的绝对 Session 目录。
 * @returns 同一路径的绑定访问器和全局写入口共用的串行队列。
 */
function getSessionStateQueue(sessionDirectory: string): SerializedQueue {
  const key = resolve(sessionDirectory)
  let queue = SESSION_STATE_QUEUES.get(key)
  if (queue === undefined) {
    queue = { tail: Promise.resolve() }
    SESSION_STATE_QUEUES.set(key, queue)
  }
  return queue
}

/**
 * 重新读取完整 Session Meta，只替换模型选择后原子写回。
 *
 * @param paths 已绑定 Session 的派生状态路径。
 * @param queue 该 Session 唯一的状态串行队列。
 * @param model 调用方要持久化的完整模型引用。
 * @throws Error 当模型引用或现有 Session Meta 无效，或写入失败时抛出。
 */
async function writeCurrentModelAtPaths(
  paths: SessionStatePaths,
  queue: SerializedQueue,
  model: ModelRef,
): Promise<void> {
  if (!isModelRef(model)) throw new Error("currentModel 必须是有效的 ModelRef。")
  const nextModel = structuredClone(model)
  await runSerialized(queue, async () => {
    const meta = await readRequiredJson(paths.metaPath, isSessionMeta, "Session Meta")
    await atomicWriteJson(paths.metaPath, {
      ...meta,
      currentModel: nextModel,
    })
  })
}

/**
 * 同一 Session 目录的所有 SessionState 访问器共用的串行队列。
 */
interface SerializedQueue {
  /** 最近一次派生状态操作完成（无论成功或失败）后的队尾。 */
  tail: Promise<void>
}

/**
 * 在当前 Session 上串行执行派生状态文件操作。
 *
 * @param queue 当前对话目录对应的唯一进程内队列。
 * @param operation 获得当前 Session 写入权后执行的操作。
 * @returns 操作返回值。
 */
function runSerialized<T>(queue: SerializedQueue, operation: () => Promise<T>): Promise<T> {
  const result = queue.tail.then(operation)
  queue.tail = result.then(() => undefined, () => undefined)
  return result
}

/**
 * 深拷贝 Skill 条目，避免修改初始化提供者或已解析对象。
 *
 * @param entries 待复制的 Skill 条目。
 * @returns 与输入脱离引用关系的新数组。
 */
function cloneSkillEntries(entries: readonly SessionSkillContextEntry[]): SessionSkillContextEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

/**
 * 校验 `meta.json` 的当前已确认字段。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否包含有效 currentModel、usage 与 skills。
 */
function isSessionMeta(value: unknown): value is SessionMeta {
  return isRecord(value)
    && value.version === SESSION_META_VERSION
    && isModelRef(value.currentModel)
    && isSandboxMode(value.sandboxMode)
    && isRealUsage(value.usage)
    && isSessionSkillContextState(value.skills)
}

/**
 * 校验 `contextstate.json` 的完整结构。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否为有效 SessionContextState。
 */
function isSessionContextState(value: unknown): value is SessionContextState {
  return isRecord(value)
    && isAgentsState(value.agentsmd)
    && isRecord(value.skills)
    && typeof value.skills.id === "string"
    && typeof value.skills.content === "string"
    && Array.isArray(value.mcp)
    && value.mcp.every(isUnifiedToolDefinition)
}

/**
 * 校验 `meta.usage` 的四项有限非负统计。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否为有效 RealUsage。
 */
function isRealUsage(value: unknown): value is RealUsage {
  return isRecord(value)
    && isNonNegativeNumber(value.inputTokens)
    && isNonNegativeNumber(value.cacheHitTokens)
    && isNonNegativeNumber(value.cacheMissTokens)
    && isNonNegativeNumber(value.cacheHitRate)
    && value.cacheHitRate <= 1
}

/**
 * 校验 Session 持久化的沙盒模式。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否为当前版本支持的对话级沙盒模式。
 */
function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value)
}

/**
 * 校验 Session Skill 比较状态。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否含有效事件游标和无重复 Skill 条目。
 */
function isSessionSkillContextState(value: unknown): value is SessionSkillContextState {
  return isRecord(value)
    && (value.id === null || isNonEmptyString(value.id))
    && isSkillEntries(value.entries)
}

/**
 * 校验 Skill 比较条目数组及名称唯一性。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否为有效 Skill 条目数组。
 */
function isSkillEntries(value: unknown): value is SessionSkillContextEntry[] {
  if (!Array.isArray(value)) return false
  const names = new Set<string>()
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !isNonEmptyString(entry.name)
      || (entry.scope !== "global" && entry.scope !== "project")
      || typeof entry.enabled !== "boolean"
      || !Number.isSafeInteger(entry.estimatedTokens)
      || (entry.estimatedTokens as number) < 0
      || names.has(entry.name)
    ) return false
    names.add(entry.name)
  }
  return true
}

/**
 * 校验 AGENTS.md 固定上下文状态。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否同时包含 hash 与原文。
 */
function isAgentsState(value: unknown): value is SessionContextState["agentsmd"] {
  return isRecord(value) && isNonEmptyString(value.hash) && typeof value.content === "string"
}

/**
 * 校验持久化 MCP 工具定义所需的统一字段。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否为有效 UnifiedToolDefinition。
 */
function isUnifiedToolDefinition(value: unknown): value is UnifiedToolDefinition {
  return isRecord(value)
    && isNonEmptyString(value.name)
    && (value.description === undefined || typeof value.description === "string")
    && isRecord(value.inputSchema)
}

/**
 * 校验持久化模型引用。
 *
 * @param value 待检查的 JSON 值。
 * @returns 值是否为受支持协议的 ModelRef。
 */
function isModelRef(value: unknown): value is ModelRef {
  return isRecord(value)
    && isNonEmptyString(value.providerId)
    && isNonEmptyString(value.modelId)
    && (PROTOCOLS as readonly unknown[]).includes(value.protocol)
}

/**
 * 判断值是否为有限非负数。
 *
 * @param value 待检查的值。
 * @returns 值是否可用于 Usage 统计。
 */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/**
 * 判断值是否为非空字符串。
 *
 * @param value 待检查的值。
 * @returns 值是否为去除首尾空白后仍非空的字符串。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * 判断值是否为非数组对象。
 *
 * @param value 待检查的值。
 * @returns 值是否可按字符串字段读取。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 判断异常是否带有 Node.js 错误码。
 *
 * @param value 捕获到的未知异常。
 * @returns 异常是否可按 NodeJS.ErrnoException 读取。
 */
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}
