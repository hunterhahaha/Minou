/**
 * Session Meta 与派生文件的初始化、校验、串行更新和事件恢复。
 *
 * 管理共享 SQLite Meta、contextstate.json、agents_md.snapshot 和 tool_output 目录。
 * 初始化缺失状态时优先使用最近提交 Summary 的基线，否则解析当前来源；
 * 恢复依据已校验事件重建 Usage 和已提交上下文，不修改 Event Log。
 */

import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { PROTOCOLS } from "../../model/src/types.ts"
import type { ModelRef, UnifiedToolDefinition } from "../../model/src/types.ts"
import type { ContextUpdateEvent, SessionEvent, SkillContextChange, SkillScope, SummaryEndEvent } from "./events.ts"
import { INITIAL_SESSION_NAME, readSessionMeta, saveSessionMeta, updateSessionMetaName } from "./meta-store.ts"
import { requireProjectId } from "./project-id.ts"
import { skillSourceKey } from "../../skill/src/context.ts"
import type { ProjectId } from "./project-id.ts"
import type { SessionLoadedMCPTool } from "../../mcp/src/types.ts"

export type { ProjectId } from "./project-id.ts"

/** 当前 Session Meta 已确认的持久化结构版本。 */
export const SESSION_META_VERSION = 2 as const

/** Session Meta sandboxMode 支持的对话级沙盒模式。 */
export const SANDBOX_MODES = [
  "full-access",
  "sandbox-full-access",
  "sandbox-read-only",
] as const

/** 对话级持久化沙盒模式。 */
export type SandboxMode = (typeof SANDBOX_MODES)[number]

/** 对话设置的部分更新；不包含 Usage、Skills 或其他派生状态。 */
export interface SessionSettingsPatch {
  /** 用户设置的对话名称。 */
  name?: string
  /** 后续 Turn 开始时读取的模型。 */
  model?: ModelRef
  /** 后续文件工具检查权限时读取的沙箱模式。 */
  sandboxMode?: SandboxMode
}

/** 新 Session 创建时使用的默认沙盒模式。 */
export const DEFAULT_SESSION_SANDBOX_MODE: SandboxMode = "sandbox-full-access"

/** Session Meta usage 的 V1 派生结构。 */
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

/** Session Meta 中用于下一 Turn Skill 增量比较的条目。 */
export interface SessionSkillContextEntry {
  /**
   * Skill 文件夹名；不同来源可以使用相同名称。
   */
  name: string
  /**
   * 曾载入到当前对话的 Skill 文件夹绝对路径。
   */
  path: string
  /**
   * 该记录对应的 Skill 来源作用域。
   */
  scope: SkillScope
  /**
   * 该来源当前是否处于有效启用集合；禁用后保留历史记录并更新此状态。
   */
  enabled: boolean
  /**
   * 实际注入的 name 与 description 的本地 Token 估算值。
   */
  estimatedTokens: number
}

/**
 * Session 已载入过的 Skill 来源记录及其当前有效状态。
 */
export interface SessionSkillContextState {
  /** 当前基线或比较状态的标识。 */
  id: string | null
  /** 已载入来源的历史记录和当前启用状态。 */
  entries: SessionSkillContextEntry[]
}

/** 当前已确认的 Session Meta 字段；其它 Runtime 字段由初始化提供者原样保留。 */
export interface SessionMeta {
  /** 所属 Project UUID 或 default。 */
  projectId: ProjectId
  /** 当前对话身份。 */
  sessionId: string
  /** 当前对话显示名称。 */
  name: string
  /** Meta 的持久化结构版本。 */
  version: typeof SESSION_META_VERSION
  /** 后续 Turn 启动时读取的持久化模型选择。 */
  currentModel: ModelRef
  /** 当前 Session 的工具权限模式；不从全局或 Project 配置继承。 */
  sandboxMode: SandboxMode
  /** 从已提交正常 Assistant 消息派生的 Session Usage。 */
  usage: RealUsage
  /** 已载入 Skill 来源及增量比较状态。 */
  skills: SessionSkillContextState
  /** MCP 载入身份和预算记录，保存在 additional_meta_json 中。 */
  loadedMcpTools?: SessionLoadedMCPTool[]
  /** 最近同步到 Meta 的载入事件序号。 */
  loadedMcpToolsSeq: number
  [field: string]: unknown
}

/** `contextstate.json` 的已确认结构。 */
export interface SessionContextState {
  /** 固定 AGENTS.md 内容与比较哈希。 */
  agentsmd: {
    hash: string
    content: string
  }
  /** 已载入 Skill 来源及增量比较状态。 */
  skills: {
    id: string
    content: string
  }
  /** 写入派生上下文的 MCP 工具定义。 */
  mcp: UnifiedToolDefinition[]
}

/** 恢复当下由 Project / Skill / MCP Runtime 汇总出的初始化基线。 */
export interface CurrentSessionBaseline {
  /** 固定 AGENTS.md 内容与比较哈希。 */
  agentsmd: {
    /** 当前实际参与比较的 AGENTS.md 绝对路径。 */
    path: string
    hash: string
    content: string
  }
  /** 已载入 Skill 来源及增量比较状态。 */
  skills: {
    content: string
    entries: SessionSkillContextEntry[]
    /** 按 Skill 名称保存已经过预算处理、可写入增量事件的 description。 */
    descriptions: Record<string, string>
  }
  /** 写入派生上下文的 MCP 工具定义。 */
  mcp: UnifiedToolDefinition[]
  /**
   * 基线提供者补充的 Meta 状态，例如 MCP 工具载入记录。
   * 不得包含身份、名称、版本或其它由本模块维护的 Meta 字段。
   */
  additionalMeta?: Record<string, unknown>
}

/** 文件型 SessionState 创建参数。 */
export interface FileSessionStateOptions {
  /** 当前 Session 所属 Project UUID 或 default。 */
  projectId: ProjectId
  /** 当前 SessionState 唯一绑定的 Session ID。 */
  sessionId: string
  /** 当前 Session 目录的绝对路径。 */
  sessionDirectory: string
  /** 共享 Event Log 数据库绝对路径，仅用于定位初始化错误。 */
  databasePath: string
  /** 所有 Session 共用的 Meta 数据库绝对路径。 */
  metaDatabasePath: string
  /**
   * 从 Event Log 读取尚未窄化的事件；组合实现使用同一个 FileSessionEventLog。
   * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
   */
  readEvents(): Promise<readonly unknown[]>
  /**
   * 读取恢复当下的 AGENTS.md、Skill、MCP 及其它 Session meta 基线。
   * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
   */
  resolveCurrentBaseline(): Promise<CurrentSessionBaseline>
  /**
   * 计算 name 与 description 的本地估算，用于重放已提交 Skill 增量。
   * @param description 事件中记录的 Skill 名称与截断描述。
   * @returns 本地估算器返回的 Token 数。
   */
  estimateSkillTokens(description: string): number
}

/** `SessionRepairPorts` 中派生状态部分的文件系统实现。 */
export interface FileSessionState {
  /**
   * 读取当前 Session 的持久化状态。
   * @returns 从 Meta 读取最近正常 Agent 请求的完整输入 Token；不包括压缩 Usage。
   * @throws Error Meta 不可读或无效。
   */
  readAgentInputTokens(): Promise<number>
  /**
   * 按权威 assistant/message Usage 幂等同步 Meta，仅替换 usage，不修改其他派生状态。
   * @returns Meta 已包含全部已提交正常 Usage 后解析；重复调用不会重复累计。
   * @throws Error 日志或 Meta 读写失败；事件仍为恢复依据，调用方应终止当前 Turn。
   */
  synchronizeUsage(): Promise<void>
  /**
   * 读取持久化的固定 Skill 内容，供普通 Turn 继续使用同一上下文基线。
   * @returns 从 Session Context State 重读并复制的 Skill 固定内容。
   * @throws Error 状态文件无效或无法读取时抛出。
   */
  readSkillBaseline(): Promise<SessionContextState["skills"]>
  /**
   * 按当前有效来源静默更新已载入记录的 enabled 状态。
   * @param current 已完成目录同步和来源合并的当前 Skill 条目。
   * @returns Meta 状态保存完成后兑现的 Promise；没有变化时不写入。
   * @throws Error 输入状态无效，或 Meta 读取、写入失败时抛出。
   */
  synchronizeSkillStatus(current: readonly SessionSkillContextEntry[]): Promise<void>
  /**
   * 重新读取来源并保存完整 Skill 基线；不提交 Summary 或决定其 checkpoint。
   * @returns 同步并保存的完整 Skill 元信息。
   * @throws Error 来源、已有派生状态或保存失败；调用方负责在合适的完整重载边界调用。
   */
  reloadSkills(): Promise<CurrentSessionBaseline["skills"]>
  /**
   * 读取当前 Session 的持久化状态。
   * @returns 从 Meta 重读并校验的 MCP 载入记录。
   * @throws Error 状态损坏或不可读取。
   */
  readLoadedMCPTools(): Promise<SessionLoadedMCPTool[]>
  /**
   * 在 Session 串行边界先保存 Meta，再原子更新 contextstate.mcp。
   * @param tools 完整载入状态。
   * @param throughSeq 当前有效 Catalog 的定义。
   * @throws Error 校验或写入失败；已提交的 Meta 用于下次同步恢复定义。
   * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
   */
  writeLoadedMCPTools(tools: SessionLoadedMCPTool[], throughSeq?: number): Promise<void>
  /**
   * 幂等补齐或重建缺失、损坏的 Session 派生文件。
   * @throws Error 当 Session 路径、Event Log 或当前初始化基线无效时抛出。
   * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
   */
  initializeSession(): Promise<void>
  /**
   * 在当前 Session 的串行状态队列中重新读取 Meta，仅替换当前模型。
   * @param model 要保存为下一 Turn 选择的完整模型引用。
   * @throws Error 当模型引用、Session Meta 或原子写入无效时抛出。
   * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
   */
  writeCurrentModel(model: ModelRef): Promise<void>
  /**
   * 每次调用都从数据库重新读取并校验当前 Session 的 Meta。
   * @returns 与解析结果脱离引用关系的当前模型引用。
   * @throws Error 当 Session Meta 缺失、损坏或不可读取时抛出。
   */
  readCurrentModel(): Promise<ModelRef>
  /**
   * 读取当前 Session 的持久化状态。
   * @returns 从 Meta 重读并复制的对话名称及设置；Meta 不可读时抛出。
   */
  readSettings(): Promise<Pick<SessionMeta, "name" | "currentModel" | "sandboxMode">>
  /**
   * 在共享状态队列中原子修改指定设置，保留其余 Meta 字段。
   * @param patch 至少指定模型或沙箱模式的更新。
   * @throws Error 当更新或已有 Meta 无效，或数据库写入失败时抛出。
   * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
   */
  writeSettings(patch: SessionSettingsPatch): Promise<void>
  /**
   * 从已校验 Event Log 全量重建 Usage，并修复已提交的 AGENTS.md / Skill 增量。
   * 该方法不修改 Event Log，也不应用未提交的 Summary。
   * @param events 已由 SessionRuntime 完成结构和生命周期校验的事件。
   * @throws Error 当派生文件无法读取、写入或无法按已确认结构解释时抛出。
   * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
   */
  repairDerivedState(events: readonly SessionEvent[]): Promise<void>
  /**
   * 读取已有 Session 在下一 Turn 开始前需要比较的 AGENTS.md 快照和 Skill 状态。
   * @returns 与当前磁盘状态脱离引用关系的比较值。
   * @throws Error 当派生状态缺失或结构无效时抛出。
   */
  readContextComparisonState(): Promise<{
    agentsSnapshot: string
    skills: SessionSkillContextState
  }>
}

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
 * @param options Session 身份、目录、Event Log 读取器和当前上下文基线提供者。
 * @returns 只初始化和修复该 Session 派生文件的访问器。
 * @throws Error 当 Session ID 非法或 Session 目录不是绝对路径时抛出。
 */
export function createFileSessionState(options: FileSessionStateOptions): FileSessionState {
  requireProjectId(options.projectId)
  validateSessionId(options.sessionId)
  if (!isAbsolute(options.sessionDirectory)) {
    throw new Error(`Session 目录必须是绝对路径：${options.sessionDirectory}`)
  }
  if (!isAbsolute(options.databasePath)) {
    throw new Error(`Session Event Log 数据库必须是绝对路径：${options.databasePath}`)
  }
  if (!isAbsolute(options.metaDatabasePath)) {
    throw new Error(`Session Meta 数据库必须是绝对路径：${options.metaDatabasePath}`)
  }
  const paths = resolveStatePaths(
    resolve(options.sessionDirectory), resolve(options.databasePath), resolve(options.metaDatabasePath),
    options.projectId, options.sessionId,
  )
  const queue = getSessionStateQueue(paths.sessionDirectory)

  /**
   * 首次初始化和显式完整重载共用的 Skill 保存流程；调用方持有 Session 队列。
   *
   * @param meta 本次重新读取或初始化的 Meta。
   * @param state 当前或新建的固定上下文状态。
   * @param skills 已同步、合并和截断的 Skill 基线。
   * @throws Error SQLite 或文件保存失败；重试此流程可幂等完成。
   */
  const saveSkillBaseline = async (meta: SessionMeta, state: SessionContextState, skills: CurrentSessionBaseline["skills"]): Promise<void> => {
    saveSessionMeta(paths.metaDatabasePath, { ...meta, skills: { id: meta.skills.id, entries: cloneSkillEntries(skills.entries) } })
    await atomicWriteJson(paths.contextStatePath, { ...state, skills: { ...state.skills, content: skills.content } })
  }

  /**
   * 在同一 Session 的状态队列内补齐全部派生文件。
   *
   * @throws Error 当路径、当前基线或 Event Log 无法用于初始化时抛出。
   */
  const initializeSession = async (): Promise<void> => {
    await runSerialized(queue, async () => {
      await requireDirectory(paths.sessionDirectory, "Session 目录")

      const [rawMeta, contextState, snapshot] = await Promise.all([
        Promise.resolve(readSessionMeta(paths.metaDatabasePath, paths.projectId, paths.sessionId)),
        readOptionalJson(paths.contextStatePath, isSessionContextState),
        readOptionalTextFile(paths.agentsSnapshotPath),
      ])
      const meta = isSessionMeta(rawMeta, paths.projectId, paths.sessionId) ? rawMeta : undefined
      await ensureDirectory(paths.toolOutputDirectory, "Session Tool Output 目录")

      const needsMeta = meta === undefined
      const needsAgentBaseline = contextState === undefined || snapshot === undefined
      const needsContextState = contextState === undefined
      if (!needsMeta && !needsAgentBaseline && !needsContextState) return

      const rawEvents = await options.readEvents()
      const summary = rawEvents.filter((event) => isRecord(event) && event.type === "summary/end").at(-1) as SummaryEndEvent | undefined
      const baseline: CurrentSessionBaseline = summary === undefined
        ? await options.resolveCurrentBaseline()
        : summary.baseline
      validateCurrentBaseline(baseline)
      const turnModel = findLastTurnModel(rawEvents, paths.eventsPath)
      const latestSkillEventId = summary === undefined ? findLatestSkillEventId(rawEvents)
        : findLatestSkillEventId(rawEvents.filter((event) => isRecord(event) && typeof event.seq === "number" && event.seq > summary.throughEventSeq)) ?? summary.eventId

      let nextMeta = meta
      if (needsMeta) {
        const additionalMeta = baseline.additionalMeta ?? {}
        for (const reserved of ["projectId", "sessionId", "name", "version", "currentModel", "sandboxMode", "usage", "skills", "loadedMcpToolsSeq"]) {
          if (reserved in additionalMeta) {
            throw new Error(`当前 Session 基线的 additionalMeta 不得包含保留字段 ${reserved}。`)
          }
        }
        const initialMeta: SessionMeta = {
          ...additionalMeta,
          projectId: paths.projectId,
          sessionId: paths.sessionId,
          name: INITIAL_SESSION_NAME,
          version: SESSION_META_VERSION,
          currentModel: turnModel,
          sandboxMode: DEFAULT_SESSION_SANDBOX_MODE,
          usage: { ...EMPTY_USAGE },
          skills: {
            id: latestSkillEventId,
            entries: cloneSkillEntries(baseline.skills.entries),
          },
          loadedMcpTools: (additionalMeta.loadedMcpTools as SessionLoadedMCPTool[] | undefined) ?? [],
          loadedMcpToolsSeq: 0,
        }
        nextMeta = initialMeta
      }

      let nextContextState = contextState
      if (needsContextState) {
        nextContextState = {
          agentsmd: {
            hash: baseline.agentsmd.hash,
            content: baseline.agentsmd.content,
          },
          skills: { id: summary?.eventId ?? "initial", content: baseline.skills.content },
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
      if (needsMeta || needsContextState) {
        await saveSkillBaseline(nextMeta!, nextContextState!, baseline.skills)
      } else if (nextContextState !== contextState) {
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
    const meta = readRequiredMeta(paths)
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
      const meta = readRequiredMeta(paths)
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

      const loaded = new Map((meta.loadedMcpTools ?? []).map((entry) => [entry.name, entry]))
      for (const event of events) {
        if (event.seq <= meta.loadedMcpToolsSeq) continue
        if (event.type === "mcp/tools_removed") {
          for (const name of event.toolNames) loaded.delete(name)
        } else if (event.type === "mcp/tools_added") {
          for (const { entry } of event.tools) loaded.set(entry.name, entry)
        } else continue
        nextMeta.loadedMcpToolsSeq = event.seq
      }
      if (nextMeta.loadedMcpToolsSeq !== meta.loadedMcpToolsSeq) nextMeta.loadedMcpTools = [...loaded.values()]

      const summary = events.filter((event) => event.type === "summary/end").at(-1)
      const effectiveEvents = summary === undefined ? events : events.filter((event) => event.seq > summary.throughEventSeq)
      if (summary !== undefined) {
        nextContextState = {
          ...contextState,
          mcp: structuredClone(summary.baseline.mcp),
          agentsmd: { hash: summary.baseline.agentsmd.hash, content: summary.baseline.agentsmd.content },
          skills: { id: summary.eventId, content: summary.baseline.skills.content },
        }
        nextSnapshot = summary.baseline.agentsmd.content
        nextMeta.skills = { id: summary.eventId, entries: cloneSkillEntries(summary.baseline.skills.entries) }
      }

      const latestAgentsUpdate = findLatestAgentsUpdate(effectiveEvents)
      if (latestAgentsUpdate !== undefined) {
        const agentsmd = {
          hash: latestAgentsUpdate.source.hash,
          content: latestAgentsUpdate.source.fullContent,
        }
        if (!isDeepStrictEqual(nextContextState.agentsmd, agentsmd)) {
          nextContextState = { ...nextContextState, agentsmd }
        }
        nextSnapshot = latestAgentsUpdate.source.fullContent
      }

      const skillEvents = effectiveEvents.filter(isSkillContextUpdate)
      const cursorIndex = nextMeta.skills.id === null
        ? -1
        : skillEvents.findIndex((event) => event.eventId === nextMeta.skills.id)
      const shouldUseCurrentSkillBaseline = nextMeta.skills.id !== null && cursorIndex < 0 && nextMeta.skills.id !== summary?.eventId

      if (!shouldUseCurrentSkillBaseline) {
        for (const event of skillEvents.slice(cursorIndex + 1)) {
          applySkillChanges(nextMeta.skills.entries, event.source.changes, options.estimateSkillTokens)
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

      if (!isDeepStrictEqual(meta, nextMeta)) saveSessionMeta(paths.metaDatabasePath, nextMeta)
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
    const meta = readRequiredMeta(paths)
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
    readAgentInputTokens: () => runSerialized(queue, async () => readRequiredMeta(paths).usage.inputTokens),
    synchronizeUsage: () => runSerialized(queue, async () => {
      const usage = rebuildUsage(await options.readEvents() as SessionEvent[])
      const meta = readRequiredMeta(paths)
      if (!isDeepStrictEqual(meta.usage, usage)) saveSessionMeta(paths.metaDatabasePath, { ...meta, usage })
    }),
    readSkillBaseline: () => runSerialized(queue, async () => {
      const state = await readRequiredJson(paths.contextStatePath, isSessionContextState, "Session Context State")
      return structuredClone(state.skills)
    }),
    synchronizeSkillStatus: (current) => runSerialized(queue, async () => {
      if (!isSkillEntries(current)) throw new Error("当前 Skill 来源状态无效。")
      const active = new Set(current.filter((entry) => entry.enabled).map(skillSourceKey))
      const meta = readRequiredMeta(paths)
      const entries = meta.skills.entries.map((entry) => ({ ...entry, enabled: active.has(skillSourceKey(entry)) }))
      if (!isDeepStrictEqual(entries, meta.skills.entries)) saveSessionMeta(paths.metaDatabasePath, { ...meta, skills: { ...meta.skills, entries } })
    }),
    reloadSkills: () => runSerialized(queue, async () => {
      const baseline = await options.resolveCurrentBaseline()
      validateCurrentBaseline(baseline)
      const meta = readRequiredMeta(paths)
      const state = await readRequiredJson(paths.contextStatePath, isSessionContextState, "Session Context State")
      await saveSkillBaseline(meta, state, baseline.skills)
      return structuredClone(baseline.skills)
    }),
    initializeSession,
    readLoadedMCPTools: () => runSerialized(queue, async () => {
      const tools = readRequiredMeta(paths).loadedMcpTools ?? []
      if (!isLoadedMCPTools(tools)) throw new Error(`Session MCP 状态无效：${paths.metaDatabasePath}`)
      return structuredClone(tools)
    }),
    writeLoadedMCPTools: async (tools, throughSeq) => {
      if (!isLoadedMCPTools(tools)) throw new Error("Session MCP 更新无效。")
      const nextTools = structuredClone(tools)
      await runSerialized(queue, async () => {
        const meta = readRequiredMeta(paths)
        const next = { ...meta, loadedMcpTools: nextTools, loadedMcpToolsSeq: throughSeq ?? meta.loadedMcpToolsSeq }
        if (!isDeepStrictEqual(meta, next)) saveSessionMeta(paths.metaDatabasePath, next)
      })
    },
    writeCurrentModel: writeBoundCurrentModel,
    readCurrentModel,
    /** @returns 在当前 Session 串行状态边界内重读名称、模型与权限的脱离引用副本。 @throws Error Meta 缺失或损坏。 */
    readSettings: () => runSerialized(queue, async () => {
      const meta = readRequiredMeta(paths)
      return structuredClone({ name: meta.name, currentModel: meta.currentModel, sandboxMode: meta.sandboxMode })
    }),
    /** @param patch 名称、模型与权限的部分更新；串行重读 Meta 后只改指定字段。 @throws Error patch 无效或 Meta 写入失败。 */
    writeSettings: async (patch) => {
      if ((patch.name === undefined && patch.model === undefined && patch.sandboxMode === undefined) ||
          (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.trim() === "")) ||
          (patch.model !== undefined && !isModelRef(patch.model)) ||
          (patch.sandboxMode !== undefined && !isSandboxMode(patch.sandboxMode))) {
        throw new Error("Session 设置更新无效。")
      }
      const update = structuredClone(patch)
      await runSerialized(queue, async () => {
        const meta = readRequiredMeta(paths)
        if (update.model !== undefined || update.sandboxMode !== undefined) {
          saveSessionMeta(paths.metaDatabasePath, {
            ...meta,
            currentModel: update.model ?? meta.currentModel,
            sandboxMode: update.sandboxMode ?? meta.sandboxMode,
          })
        }
        if (update.name !== undefined) {
          updateSessionMetaName(paths.metaDatabasePath, meta.projectId, meta.sessionId, update.name.trim())
        }
      })
    },
    repairDerivedState,
    readContextComparisonState,
  }
}

/**
 * 检查 MCP 身份和预算记录，不根据持久化条目推断连接可用性。
 * @param value 从 Meta 读取或即将提交的数组。
 * @returns 身份唯一且估算值、时间戳有效时为 true。
 */
export function isLoadedMCPTools(value: unknown): value is SessionLoadedMCPTool[] {
  if (!Array.isArray(value)) return false
  const names = new Set<string>()
  return value.every((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.startsWith("mcp_") || names.has(entry.name)
      || typeof entry.serverId !== "string" || entry.serverId.length === 0 || typeof entry.originalToolName !== "string" || entry.originalToolName.length === 0
      || !Number.isSafeInteger(entry.estimatedTokens) || (entry.estimatedTokens as number) < 0
      || !Number.isSafeInteger(entry.lastCalledAt) || (entry.lastCalledAt as number) < 0) return false
    names.add(entry.name)
    return true
  })
}

/**
 * 按全局持久化目录定位 Session，并在该 Session 共用的状态队列中更新模型选择。
 *
 * 该函数使用 `%USERPROFILE%/.nicode/meta.sqlite`；
 * 已经持有绑定式 {@link FileSessionState} 的 Runtime 应优先调用实例方法。
 * @param projectId Session 所属 Project UUID 或 default。
 * @param sessionId Session 目录身份。
 * @param model 要保存的完整模型引用。
 * @throws Error 当 USERPROFILE、身份、模型引用或 Session Meta 无效时抛出。
 * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
 */
export async function writeCurrentModel(
  projectId: ProjectId,
  sessionId: SessionId,
  model: ModelRef,
): Promise<void> {
  requireProjectId(projectId)
  validateSessionId(sessionId)
  const userProfile = process.env.USERPROFILE
  if (!userProfile || !isAbsolute(userProfile)) {
    throw new Error("USERPROFILE 必须是非空的绝对路径。")
  }
  const paths = resolveStatePaths(resolve(
    userProfile,
    ".nicode",
    "sessions",
    projectId,
    sessionId,
  ), resolve(userProfile, ".nicode", "events.sqlite"),
  resolve(userProfile, ".nicode", "meta.sqlite"), projectId, sessionId)
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
  /** 共享 Session Meta 数据库。 */
  metaDatabasePath: string
  /** 当前分组身份。 */
  projectId: ProjectId
  /** 当前 Session 身份。 */
  sessionId: string
  /** Session 固定上下文状态文件。 */
  contextStatePath: string
  /** AGENTS.md 增量比较快照。 */
  agentsSnapshotPath: string
  /** 大型工具输出目录。 */
  toolOutputDirectory: string
}

/**
 * 校验绑定到派生状态访问器的 Session ID。
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
 * @param sessionDirectory 当前 Session 的绝对目录。
 * @param databasePath 共享 Event Log 数据库的绝对路径。
 * @param metaDatabasePath 共享 Meta 数据库的绝对路径。
 * @param projectId 当前分组身份。
 * @param sessionId 当前对话身份。
 * @returns 当前 Session 的全部派生状态路径。
 */
function resolveStatePaths(
  sessionDirectory: string, databasePath: string, metaDatabasePath: string,
  projectId: ProjectId, sessionId: string,
): SessionStatePaths {
  return {
    sessionDirectory,
    eventsPath: databasePath,
    metaDatabasePath,
    projectId,
    sessionId,
    contextStatePath: join(sessionDirectory, "contextstate.json"),
    agentsSnapshotPath: join(sessionDirectory, "agents_md.snapshot"),
    toolOutputDirectory: join(sessionDirectory, "tool_output"),
  }
}

/**
 * 从 Event Log 最后一个 `turn/start` 取得派生 meta 的当前模型。
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
 * @param events 已通过 SessionRuntime 校验的 Event Log。
 * @returns 可覆盖写入 Session Meta 的四项 Usage 派生统计。
 */
function rebuildUsage(events: readonly SessionEvent[]): RealUsage {
  const usage: RealUsage = { ...EMPTY_USAGE }
  for (const event of events) {
    if (event.type !== "assistant/message" || event.usage === undefined) continue
    /** 项目负责人于 2026-09-19 明确：厂商未报告的缓存字段在此派生统计中按 0 处理。 */
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
 * @param event 待判断的 Session 事件。
 * @returns 事件是否为 Skill `context_update`。
 */
function isSkillContextUpdate(
  event: SessionEvent,
): event is ContextUpdateEvent & { source: Extract<ContextUpdateEvent["source"], { type: "skill" }> } {
  return event.type === "context_update" && event.source.type === "skill"
}

/**
 * 按来源身份幂等补入已提交新增记录，不从磁盘重读描述或覆盖历史状态。
 * @param entries 本次 Meta 条目副本，成功时原地追加。
 * @param changes 已提交事件内的新增来源。
 * @param estimateSkillTokens 现有本地文本估算器。
 * @throws Error 事件来源字段或估算开销无效，不使用当前文件替换损坏历史。
 */
function applySkillChanges(entries: SessionSkillContextEntry[], changes: readonly SkillContextChange[], estimateSkillTokens: (text: string) => number): void {
  for (const change of changes) {
    if (!isRecord(change) || change.type !== "new" || !isNonEmptyString(change.name) ||
        typeof change.path !== "string" || !isAbsolute(change.path) ||
        (change.scope !== "global" && change.scope !== "project") || typeof change.description !== "string") {
      throw new Error("已提交 Skill 增量记录无效。")
    }
    const entry = skillEntryFromDescription(change.name, change.path, change.scope, change.description, estimateSkillTokens)
    if (!entries.some((existing) => skillSourceKey(existing) === skillSourceKey(entry))) entries.push(entry)
  }
}

/**
 * 从事件中的原始来源和已截断描述生成记录。
 * @param name 文件夹名。
 * @param path Skill 文件夹绝对路径。
 * @param scope 来源作用域。
 * @param description 当时真正注入模型的描述。
 * @param estimateSkillTokens 本地估算器。
 * @returns 启用的来源记录。
 * @throws Error name + description 估算不是 0 到 500 的安全整数。
 */
function skillEntryFromDescription(name: string, path: string, scope: SkillScope, description: string, estimateSkillTokens: (text: string) => number): SessionSkillContextEntry {
  const estimatedTokens = estimateSkillTokens(name + description)
  if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0 || estimatedTokens > 500) throw new Error(`Skill ${name} 的 estimatedTokens 无效。`)
  return { name, path, scope, enabled: true, estimatedTokens }
}

/**
 * 校验来源同步或 Summary 保存的完整基线，避免把无效派生状态写入磁盘。
 * @param baseline Project / Skill / MCP Runtime 汇总的当前状态。
 * @throws Error 当任一已确认字段不符合持久化结构时抛出。
 */
export function validateCurrentBaseline(baseline: CurrentSessionBaseline): void {
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
  if (baseline.additionalMeta && "loadedMcpTools" in baseline.additionalMeta && !isLoadedMCPTools(baseline.additionalMeta.loadedMcpTools)) {
    throw new Error("当前 Session 基线的 loadedMcpTools 无效。")
  }
}

/**
 * 读取可修复 JSON 文件；缺失、非法 JSON 或结构不符均返回 undefined。
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
 * @param path 目标目录路径。
 * @param label 错误信息中的目录名称。
 * @throws Error 当现有路径不是目录或创建失败时抛出。
 * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
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
 * @param path 目标目录路径。
 * @param label 错误信息中的目录名称。
 * @throws Error 当路径缺失或不是目录时抛出。
 * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
 */
async function requireDirectory(path: string, label: string): Promise<void> {
  if (await pathKind(path) !== "directory") throw new Error(`${label}不存在或不是目录：${path}`)
}

/**
 * 原子写入格式化 JSON，并以换行结尾。
 * @param path 目标 JSON 文件路径。
 * @param value 可序列化的派生状态。
 * @throws Error 当序列化或写入失败时抛出。
 * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
 */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 在同目录写临时文件后原子替换目标文件。
 * @param path 目标文件路径。
 * @param content 要完整写入的文本。
 * @throws Error 当临时文件写入或替换失败时抛出。
 * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
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
 * @param paths 已绑定 Session 的派生状态路径。
 * @param queue 该 Session 唯一的状态串行队列。
 * @param model 调用方要持久化的完整模型引用。
 * @throws Error 当模型引用或现有 Session Meta 无效，或写入失败时抛出。
 * @returns 当前操作完成后的结果；异步写入等待提交完成后解析。
 */
async function writeCurrentModelAtPaths(
  paths: SessionStatePaths,
  queue: SerializedQueue,
  model: ModelRef,
): Promise<void> {
  if (!isModelRef(model)) throw new Error("currentModel 必须是有效的 ModelRef。")
  const nextModel = structuredClone(model)
  await runSerialized(queue, async () => {
    const meta = readRequiredMeta(paths)
    saveSessionMeta(paths.metaDatabasePath, {
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
 * @param entries 待复制的 Skill 条目。
 * @returns 与输入脱离引用关系的新数组。
 */
function cloneSkillEntries(entries: readonly SessionSkillContextEntry[]): SessionSkillContextEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

/**
 * 校验当前 Session Meta 的身份和结构。
 * @param value 待检查的 JSON 值。
 * @param projectId 当前分组身份。
 * @param sessionId 当前对话身份。
 * @returns 值是否包含有效 currentModel、usage 与 skills。
 */
function isSessionMeta(value: unknown, projectId: ProjectId, sessionId: string): value is SessionMeta {
  return isRecord(value)
    && value.projectId === projectId
    && value.sessionId === sessionId
    && typeof value.name === "string" && value.name.trim() !== ""
    && value.version === SESSION_META_VERSION
    && isModelRef(value.currentModel)
    && isSandboxMode(value.sandboxMode)
    && isRealUsage(value.usage)
    && isSessionSkillContextState(value.skills)
    && typeof value.loadedMcpToolsSeq === "number"
    && Number.isSafeInteger(value.loadedMcpToolsSeq) && value.loadedMcpToolsSeq >= 0
}

/**
 * 读取修复阶段必须存在且有效的 Session Meta。
 * @param paths 已绑定的 Session 数据库路径和身份。
 * @returns 已校验的 Session Meta。
 * @throws Error 当记录缺失或结构无效时抛出。
 */
function readRequiredMeta(paths: SessionStatePaths): SessionMeta {
  const value = readSessionMeta(paths.metaDatabasePath, paths.projectId, paths.sessionId)
  if (!isSessionMeta(value, paths.projectId, paths.sessionId)) {
    throw new Error(`Session Meta 缺失或结构无效：${paths.metaDatabasePath}（${paths.projectId}/${paths.sessionId}）`)
  }
  return value
}

/**
 * 校验 `contextstate.json` 的完整结构。
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
 * @param value 待检查的 JSON 值。
 * @returns 值是否为当前版本支持的对话级沙盒模式。
 */
function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value)
}

/**
 * 校验 Session Skill 比较状态。
 * @param value 待检查的 JSON 值。
 * @returns 值是否含有效事件游标和无重复 Skill 条目。
 */
function isSessionSkillContextState(value: unknown): value is SessionSkillContextState {
  return isRecord(value)
    && (value.id === null || isNonEmptyString(value.id))
    && isSkillEntries(value.entries)
}

/**
 * 校验 Skill 载入条目及来源身份唯一性，允许不同来源同名。
 * @param value 待检查的 JSON 值。
 * @returns 值是否为有效 Skill 条目数组。
 */
function isSkillEntries(value: unknown): value is SessionSkillContextEntry[] {
  if (!Array.isArray(value)) return false
  const sources = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry) || !isNonEmptyString(entry.name) || typeof entry.path !== "string" || !isAbsolute(entry.path) ||
        (entry.scope !== "global" && entry.scope !== "project") || typeof entry.enabled !== "boolean" ||
        !Number.isSafeInteger(entry.estimatedTokens) || (entry.estimatedTokens as number) < 0 || (entry.estimatedTokens as number) > 500) return false
    const key = skillSourceKey(entry as unknown as SessionSkillContextEntry)
    if (sources.has(key)) return false
    sources.add(key)
  }
  return true
}

/**
 * 校验 AGENTS.md 固定上下文状态。
 * @param value 待检查的 JSON 值。
 * @returns 值是否同时包含 hash 与原文。
 */
function isAgentsState(value: unknown): value is SessionContextState["agentsmd"] {
  return isRecord(value) && isNonEmptyString(value.hash) && typeof value.content === "string"
}

/**
 * 校验持久化 MCP 工具定义所需的统一字段。
 * @param value 待检查的 JSON 值。
 * @returns 值是否为有效 UnifiedToolDefinition。
 */
export function isUnifiedToolDefinition(value: unknown): value is UnifiedToolDefinition {
  return isRecord(value)
    && isNonEmptyString(value.name)
    && (value.description === undefined || typeof value.description === "string")
    && isRecord(value.inputSchema)
}

/**
 * 校验持久化模型引用。
 * @param value 待检查的 JSON 值。
 * @returns 值是否为受支持协议的 ModelRef。
 */
function isModelRef(value: unknown): value is ModelRef {
  return isRecord(value)
    && isNonEmptyString(value.providerId)
    && isNonEmptyString(value.modelId)
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.reasoningLevel)
    && (PROTOCOLS as readonly unknown[]).includes(value.protocol)
}

/**
 * 判断值是否为有限非负数。
 * @param value 待检查的值。
 * @returns 值是否可用于 Usage 统计。
 */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/**
 * 判断值是否为非空字符串。
 * @param value 待检查的值。
 * @returns 值是否为去除首尾空白后仍非空的字符串。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * 判断值是否为非数组对象。
 * @param value 待检查的值。
 * @returns 值是否可按字符串字段读取。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 判断异常是否带有 Node.js 错误码。
 * @param value 捕获到的未知异常。
 * @returns 异常是否可按 NodeJS.ErrnoException 读取。
 */
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}
