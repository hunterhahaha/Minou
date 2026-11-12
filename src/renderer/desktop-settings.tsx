/** 设置弹窗内的桌面关闭偏好表单。 */
import { type FormEvent, useEffect, useRef, useState } from "react"
import { isCloseBehavior, type CloseBehavior, type CloseSettings } from "../preload/window-api.ts"

/**
 * 读取和保存桌面关闭偏好，保存失败后保留表单选择。
 * @param props.onBusyChange 保存期间保护外层弹窗和分区切换。
 * @returns 通用设置分区内容。
 */
export function DesktopSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [settings, setSettings] = useState<CloseSettings | null>(null)
  const [behavior, setBehavior] = useState<CloseBehavior>("tray")
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [loadingAttempt, setLoadingAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    let active = true
    void window.minouWindow.getCloseSettings().then((value) => {
      if (!active) return
      setSettings(value)
      setBehavior(value.behavior)
    }).catch(() => {
      if (active) setLoadError(true)
    })
    return () => { active = false }
  }, [loadingAttempt])

  /**
   * 提交当前选择，等待主进程确认持久化成功。
   * @param event 设置表单的提交事件。
   * @returns 保存或展示错误完成后的 Promise。
   */
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!settings || behavior === settings.behavior || savingRef.current) return
    savingRef.current = true
    onBusyChange(true)
    setSaving(true)
    setSaveError(false)
    try {
      const value = await window.minouWindow.setCloseBehavior(behavior)
      setSettings(value)
      setBehavior(value.behavior)
    } catch {
      setSaveError(true)
    } finally {
      savingRef.current = false
      setSaving(false)
      onBusyChange(false)
    }
  }

  return <section className="settings-dialog-content settings-form-page" aria-label="通用设置" aria-busy={saving || (!settings && !loadError)}>
    <div className="settings-page-heading"><h3>通用</h3></div>
    {loadError && <div className="settings-state settings-state-error" role="alert">
      <span>无法读取窗口关闭设置。</span>
      <button className="settings-secondary-button" type="button" onClick={() => { setLoadError(false); setLoadingAttempt((attempt) => attempt + 1) }}>重试</button>
    </div>}
    {!settings && !loadError && <p className="settings-state" role="status">正在读取窗口关闭设置…</p>}
    {settings && <form className="desktop-settings-form" onSubmit={(event) => void save(event)}>
      <label className="settings-field">
        <span>关闭窗口时</span>
        <select value={behavior} disabled={saving} aria-describedby="desktop-close-hint" onChange={(event) => {
          if (isCloseBehavior(event.currentTarget.value)) setBehavior(event.currentTarget.value)
          setSaveError(false)
        }}>
          <option value="tray">关闭到托盘</option>
          <option value="quit">退出 Minou</option>
        </select>
        <span id="desktop-close-hint" className="settings-field-hint">
          {behavior === "quit" ? "关闭窗口时结束 Minou 及后台任务。"
            : settings.backgroundAction === "hide" ? "关闭窗口后仍在后台运行，可从系统托盘恢复。"
              : "当前环境会最小化窗口，保留任务栏入口。"}
        </span>
      </label>
      {saveError && <p className="project-dialog-error" role="alert">无法保存窗口关闭设置，请重试。</p>}
      <div className="settings-form-footer">
        <button className="settings-primary-button" type="submit" disabled={saving || behavior === settings.behavior}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </form>}
  </section>
}
