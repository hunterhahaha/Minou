/** 设置中的技能管理页面；列表字典由 Workspace 持有，页面只在查看或显式刷新时读取。 */
import { useEffect, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"
import { IconRefresh, IconSparkles } from "@tabler/icons-react"
import type { ProjectSummary, SkillSummary, SkillTarget } from "../preload/session-api.ts"

/** 单个作用域的已加载列表及查询状态；skills 为空数组时仍为有效缓存。 */
export interface SkillCacheEntry {
  /** 当前查询状态；失败不会触发自动重试。 */
  status: "loading" | "ready" | "error"
  /** 最近一次成功的完整来源列表；首次加载前省略。 */
  skills?: SkillSummary[]
  /** 最近一次列表请求失败的原因。 */
  error?: string
}

/** Workspace 生命周期内保留的来源字典，键为 global 或 project:<UUID>。 */
export type SkillCache = Record<string, SkillCacheEntry>

/** 页面消费已有项目摘要和来源字典，不自行查询项目列表。 */
export interface SkillSettingsProps {
  /** 工作区已经持有的项目查询结果。 */
  projects: { status: "loading" } | { status: "error" } | { status: "ready"; value: ProjectSummary[] }
  /** 重试工作区项目摘要加载，不读取技能。 */
  onReloadProjects: () => void
  /** 工作区持有的技能来源字典。 */
  skillsByScope: SkillCache
  /** 以函数更新方式合并当前来源，避免覆盖其他缓存。 */
  onSkillsChange: Dispatch<SetStateAction<SkillCache>>
  /** 通知外层保护请求期间的导航和关闭。 @param busy 有请求正在执行时为 true。 */
  onBusyChange: (busy: boolean) => void
}

/**
 * 渲染单个来源的技能列表、按需读取与持久化启停开关。
 * @param props 工作区摘要、持久缓存及忙碌状态出口。
 * @returns 技能管理页面，默认查看 Global，描述错误保留条目管理能力。
 */
export function SkillSettings({ projects, onReloadProjects, skillsByScope, onSkillsChange, onBusyChange }: SkillSettingsProps) {
  const [scopeKey, setScopeKey] = useState("global")
  const [busy, setBusy] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const pending = useRef<Promise<void> | null>(null)
  const cache = skillsByScope[scopeKey]
  const target: SkillTarget = scopeKey === "global" ? { scope: "global" } : { scope: "project", projectId: scopeKey.slice("project:".length) }

  /**
   * 读取当前作用域；重复请求共享 Promise，已有缓存和已显示的失败不自动重查。
   * @param refresh 显式刷新或重试时忽略缓存。
   * @returns 请求结束或缓存命中后完成；错误保存在对应字典项供页面处理。
   */
  function load(refresh = false): Promise<void> {
    if (pending.current) return pending.current
    if (!refresh && Object.hasOwn(skillsByScope, scopeKey)) return Promise.resolve()
    setBusy(true)
    onBusyChange(true)
    setOperationError(null)
    onSkillsChange((previous) => ({ ...previous, [scopeKey]: { ...previous[scopeKey], status: "loading", error: undefined } }))
    const request = (async () => {
      try {
        const skills = await window.minou.listSkills(target)
        onSkillsChange((previous) => ({ ...previous, [scopeKey]: { status: "ready", skills } }))
      } catch (error) {
        onSkillsChange((previous) => ({ ...previous, [scopeKey]: { ...previous[scopeKey], status: "error", error: error instanceof Error ? error.message : String(error) } }))
      } finally {
        pending.current = null
        setBusy(false)
        onBusyChange(false)
      }
    })()
    pending.current = request
    return request
  }

  /**
   * 提交目标状态，后端确认成功才替换缓存条目的登记字段。
   * @param entry 当前显示的技能来源条目。
   * @param enabled 用户选择的目标状态。
   * @returns 保存及缓存同步结束；失败显示原因并保留原状态。
   */
  function save(entry: SkillSummary, enabled: boolean): Promise<void> {
    if (pending.current) return pending.current
    setBusy(true)
    onBusyChange(true)
    setOperationError(null)
    const request = (async () => {
      try {
        const saved = await window.minou.setSkillEnabled(target, entry.name, enabled)
        onSkillsChange((previous) => ({ ...previous, [scopeKey]: {
          ...previous[scopeKey],
          skills: previous[scopeKey].skills!.map((item) => item.name === saved.name ? { ...item, ...saved } : item),
        } }))
      } catch (error) {
        setOperationError(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        pending.current = null
        setBusy(false)
        onBusyChange(false)
      }
    })()
    pending.current = request
    return request
  }

  /** 缓存变化只触发显示更新；只有进入新的作用域时执行首次查看检查。 */
  useEffect(() => { void load() }, [scopeKey])

  return <div className="skill-settings" aria-busy={busy}>
    <div className="skill-toolbar">
      <h3>技能</h3>
      <button type="button" className="settings-secondary-button" aria-label="刷新技能" disabled={busy} onClick={() => { void load(true) }}>
        <IconRefresh size={15} aria-hidden="true" />刷新
      </button>
    </div>
    <label className="settings-field skill-scope"><span>作用域</span>
      <select aria-label="技能作用域" value={scopeKey} disabled={busy} onChange={(event) => { if (!pending.current) { setOperationError(null); setScopeKey(event.target.value) } }}>
        <option value="global">全局</option>
        {projects.status === "ready" && projects.value.map((project) => <option key={project.projectId} value={`project:${project.projectId}`}>{project.name}</option>)}
      </select>
    </label>
    {projects.status === "loading" && <p className="settings-field-hint" role="status">正在加载项目列表，全局技能仍可管理。</p>}
    {projects.status === "error" && <div className="skill-message" role="alert"><span>项目列表加载失败，全局技能仍可管理。</span><button type="button" className="settings-secondary-button" disabled={busy} onClick={onReloadProjects}>重试项目列表</button></div>}
    {operationError && <p className="settings-inline-error" role="alert">{operationError}</p>}
    {cache?.error && <div className="skill-message settings-inline-error" role="alert"><span>{cache.error}</span><button type="button" className="settings-secondary-button" aria-label="重试加载技能" disabled={busy} onClick={() => { void load(true) }}>重试</button></div>}
    {(!cache || cache.status === "loading") && <p className="settings-field-hint" role="status">正在加载技能…</p>}
    {cache?.skills?.length === 0 && <div className="settings-illustrated-empty"><IconSparkles size={30} stroke={1.3} aria-hidden="true" /><strong>此作用域暂无技能。</strong></div>}
    <ul className="skill-list" aria-label="技能列表">{cache?.skills?.map((entry) => <li className="skill-entry" key={entry.name}>
      <span className="skill-entry-icon" aria-hidden="true"><IconSparkles size={19} stroke={1.5} /></span><div className="skill-entry-content">
        <h4>{entry.name}</h4>
        {entry.description !== undefined && <p className="skill-description">{entry.description}</p>}
        {entry.descriptionError && <p className="settings-inline-error skill-description" role="alert">{entry.descriptionError}</p>}
        <p className="skill-path">{entry.path}</p>
      </div>
      <label className="skill-enabled"><input type="checkbox" role="switch" aria-label={`启用技能 ${entry.name}`} checked={entry.enabled} disabled={busy} onChange={(event) => { void save(entry, event.target.checked) }} /><span>{entry.enabled ? "已启用" : "已禁用"}</span></label>
    </li>)}</ul>
  </div>
}
