/** 设置弹窗内的 Team 唤醒配置。 */
import { type FormEvent, useEffect, useRef, useState } from "react"
import { isTeamWakeupConfig, TEAM_WAKEUP_MINIMUMS, type TeamWakeupConfig } from "../../runtime/session/src/team-wakeup-config.ts"

/** 表单字段按唤醒判断、轮询、冷却和提醒的顺序呈现。 */
const fields = [
  { key: "unreadThreshold", label: "未读帖子阈值", hint: "未读数超过此值时，检查是否唤醒空闲成员。" },
  { key: "pollingInterval", label: "轮询间隔（秒）", hint: "空闲成员定期检查未读帖子的间隔，至少 30 秒。" },
  { key: "wakeupCooldown", label: "唤醒冷却（秒）", hint: "两次普通唤醒之间的最短间隔，至少 30 秒。" },
  { key: "unconsumedWakeupAlertThreshold", label: "连续未消费提醒阈值", hint: "达到此次数后，下次唤醒会提示成员读取未读帖子。" },
] as const

/**
 * 编辑全局 Team 唤醒参数，以主进程保存结果为准。
 * @param props.onBusyChange 保存期间保护弹窗关闭和分区切换。
 * @returns 团队协作设置内容。
 */
export function TeamSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [config, setConfig] = useState<TeamWakeupConfig>()
  const [draft, setDraft] = useState<Partial<Record<keyof TeamWakeupConfig, string>>>({})
  const [loadError, setLoadError] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [saveStatus, setSaveStatus] = useState<"saving" | "saved" | "error">()
  const savingRef = useRef(false)

  useEffect(() => {
    let active = true
    void window.nicode.getTeamWakeupConfig().then((value) => {
      if (active) setConfig(value)
    }).catch(() => {
      if (active) setLoadError(true)
    })
    return () => { active = false }
  }, [loadAttempt])

  const parsed = config && Object.fromEntries(fields.map(({ key }) => {
    const text = draft[key]
    return [key, text === undefined ? config[key] : text.trim() === "" ? NaN : Number(text)]
  }))
  const valid = isTeamWakeupConfig(parsed)
  const changed = valid && fields.some(({ key }) => parsed[key] !== config?.[key])
  const saving = saveStatus === "saving"

  /**
   * 提交有效草稿，保存失败时保留输入。
   * @param event 表单提交事件。
   * @returns 保存结果已反映到表单后解析。
   */
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!valid || !changed || savingRef.current) return
    savingRef.current = true
    onBusyChange(true)
    setSaveStatus("saving")
    try {
      const saved = await window.nicode.setTeamWakeupConfig(parsed)
      setConfig(saved)
      setDraft({})
      setSaveStatus("saved")
    } catch {
      setSaveStatus("error")
    } finally {
      savingRef.current = false
      onBusyChange(false)
    }
  }

  return <section className="settings-dialog-content settings-form-page" aria-label="团队协作设置" aria-busy={saving || (!config && !loadError)}>
    <div className="settings-page-heading">
      <div><h3>团队协作</h3><p>设置空闲成员何时检查黑板并恢复工作。配置适用于所有工作会话。</p></div>
    </div>
    {loadError && <div className="settings-state settings-state-error" role="alert">
      <span>无法读取团队唤醒设置。</span>
      <button className="settings-secondary-button" type="button" onClick={() => { setLoadError(false); setLoadAttempt((attempt) => attempt + 1) }}>重试</button>
    </div>}
    {!config && !loadError && <p className="settings-state" role="status">正在读取团队唤醒设置…</p>}
    {config && <form className="desktop-settings-form" onSubmit={(event) => void save(event)}>
      {fields.map(({ key, label, hint }) => <label className="settings-field" key={key}>
        <span>{label}</span>
        <input name={key} type="number" min={TEAM_WAKEUP_MINIMUMS[key]} step={1} required disabled={saving}
          aria-describedby={`team-wakeup-${key}`} value={draft[key] ?? String(config[key])}
          onChange={(event) => {
            const value = event.currentTarget.value
            setDraft((current) => ({ ...current, [key]: value }))
            setSaveStatus(undefined)
          }} />
        <span id={`team-wakeup-${key}`} className="settings-field-hint">{hint}</span>
      </label>)}
      {!valid && <p className="project-dialog-error" role="alert">请填写符合各字段下限的整数。</p>}
      {saveStatus === "error" && <p className="project-dialog-error" role="alert">无法保存团队唤醒设置，请重试。</p>}
      {saveStatus === "saved" && <p className="settings-field-hint" role="status">已保存并应用。</p>}
      <div className="settings-form-footer">
        <button className="settings-primary-button" type="submit" disabled={saving || !changed}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </form>}
  </section>
}
