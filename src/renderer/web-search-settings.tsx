/** 搜索服务设置：仅缓存摘要，完整请求和凭据只在当前编辑表单保留。 */
import { type FormEvent, useEffect, useRef, useState } from "react"
import { IconPlus } from "@tabler/icons-react"
import type { WebSearchProviderDefinition, WebSearchProviderSummary } from "../preload/session-api.ts"
import { buildWebSearchProviderInput, readWebSearchProviderParameters } from "../../runtime/tools/src/web-search/provider-template.ts"

/** 搜索页面与外层设置的忙碌保护出口。 */
interface WebSearchSettingsProps {
  /** @param busy 查询或写操作进行中时为 true。 */
  onBusyChange: (busy: boolean) => void
}

/**
 * 呈现预置服务商动态表单、配置列表和启停管理。
 * @param props 外层设置忙碌保护出口。
 * @returns 搜索设置内容；不在浏览器持久化配置或密钥。
 */
export function WebSearchSettings({ onBusyChange }: WebSearchSettingsProps) {
  const [definitions, setDefinitions] = useState<WebSearchProviderDefinition[]>([])
  const [providers, setProviders] = useState<WebSearchProviderSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [detailReady, setDetailReady] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  const busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange
  const definition = definitions.find((entry) => entry.name === name)
  const selected = providers.find((entry) => entry.id === selectedId)

  /** @param value 同步忙碌状态，防止 React 提交前重复请求。 */
  function markBusy(value: boolean): void {
    pending.current = value
    if (alive.current) { setBusy(value); busyCallback.current(value) }
  }

  /**
   * 加载当前记录并从请求还原参数，不把完整请求存入列表。
   * @param id 要编辑的完整身份；null 进入新建。
   * @param catalog 已加载的预置目录。
   * @returns 详情加载结束。
   * @throws Error 服务商缺失、请求或参数无效。
   */
  async function loadDetail(id: string | null, catalog = definitions): Promise<void> {
    setValues({}); setDetailReady(false); setConfirmDelete(false); setSelectedId(id)
    if (id === null) {
      setName(catalog[0]?.name ?? ""); setDetailReady(true)
      return
    }
    const config = await window.minou.getWebSearchProvider(id)
    const entry = catalog.find((item) => item.name === config.name)
    if (!entry) throw new Error("已保存的服务商不在预置目录中。")
    const parameters = readWebSearchProviderParameters(entry, config.requestJson)
    if (!alive.current) return
    setName(config.name)
    setValues(Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])))
    setDetailReady(true)
  }

  /**
   * 首次或重试读取目录和完整摘要；保留现存选中身份。
   * @returns 加载结束，失败显示可重试状态。
   */
  async function reload(): Promise<void> {
    if (pending.current) return
    markBusy(true); setError(null)
    try {
      const [catalog, list] = await Promise.all([window.minou.listWebSearchProviderDefinitions(), window.minou.listWebSearchProviders()])
      if (!alive.current) return
      setDefinitions(catalog); setProviders(list); setStale(false); setReady(true)
      await loadDetail(selectedId && list.some((entry) => entry.id === selectedId) ? selectedId : null, catalog)
    } catch { if (alive.current) setError("搜索配置加载失败，请重试。") }
    finally { markBusy(false) }
  }

  useEffect(() => {
    alive.current = true
    void reload()
    return () => { alive.current = false; busyCallback.current(false) }
  }, [])

  /**
   * 切换详情前清除密钥和旧错误；失败时不展示旧记录的表单。
   * @param id 新选中的配置身份或 null。
   * @returns 选择完成。
   */
  async function choose(id: string | null): Promise<void> {
    if (pending.current || stale) return
    markBusy(true); setError(null)
    try { await loadDetail(id) }
    catch { setError("搜索配置详情加载失败，请重试。") }
    finally { markBusy(false) }
  }

  /**
   * 写入完成后全量刷新摘要和当前详情；刷新失败仅重试查询，不重复写入。
   * @param operation 已确定的单个写操作，返回刷新后应选择的身份。
   * @returns 操作和刷新处理结束。
   */
  async function mutate(operation: () => Promise<string | null>): Promise<void> {
    if (pending.current || stale) return
    markBusy(true); setError(null); setConfirmDelete(false)
    let committed = false
    try {
      const id = await operation()
      committed = true
      setSelectedId(id); setValues({}); setDetailReady(false); setStale(true)
      const list = await window.minou.listWebSearchProviders()
      setProviders(list); setStale(false)
      await loadDetail(id)
    } catch {
      if (committed) { setStale(true); setError("操作已保存，但配置刷新失败。请重试刷新，无需再次保存。") }
      else setError("搜索配置操作失败，请检查填写内容后重试。")
    } finally { markBusy(false) }
  }

  /**
   * 在前端生成最终请求，验证通过后才调用创建或更新 IPC。
   * @param event 表单提交事件。
   */
  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!definition || pending.current || stale) return
    try {
      const input = buildWebSearchProviderInput(definition, values)
      void mutate(async () => {
        if (selectedId) { await window.minou.updateWebSearchProvider(selectedId, input); return selectedId }
        return (await window.minou.createWebSearchProvider(input)).id
      })
    } catch (failure) { setError(failure instanceof Error ? failure.message : "搜索参数无效。") }
  }

  const disabled = busy || stale
  return <div className="web-search-settings" aria-busy={busy}>
    {error && <div className="settings-state settings-state-error" role="alert"><span>{error}</span>
      <button type="button" className="settings-secondary-button" disabled={busy} onClick={() => { void reload() }}>重试刷新</button></div>}
    {!ready ? <p className="settings-state" role="status">{busy ? "正在加载搜索配置…" : "尚未加载搜索配置。"}</p> :
      <div className="provider-management">
        <aside className="provider-sidebar" aria-label="搜索服务商列表">
          <div className="provider-sidebar-heading"><h3>搜索服务商</h3>
            <button type="button" className="settings-icon-button" aria-label="新增搜索服务商" disabled={disabled} onClick={() => { void choose(null) }}><IconPlus size={18} aria-hidden="true" /></button>
          </div>
          {providers.length === 0 ? <p className="settings-empty-note">暂无搜索服务商</p> :
            <ul className="provider-list">{providers.map((provider) => <li key={provider.id}>
              <button type="button" className={`provider-list-item web-search-provider-card${selectedId === provider.id ? " provider-list-item-active" : ""}`}
                aria-current={selectedId === provider.id ? "true" : undefined} disabled={disabled} onClick={() => { void choose(provider.id) }}>
                <span className="provider-list-name">{provider.name}</span>
                <span className="web-search-provider-status" data-enabled={provider.enabled}>{provider.enabled ? "已启用" : "未启用"}</span>
              </button></li>)}</ul>}
        </aside>
        <section className="provider-detail-panel" aria-label="搜索服务商详情">
          {!detailReady ? <p className="settings-state">{busy ? "正在加载详情…" : "请刷新后继续编辑。"}</p> : <>
            <h3>{selectedId ? "编辑搜索服务商" : "新增搜索服务商"}</h3>
            {selected && <div className="web-search-status"><span>{selected.enabled ? "当前已启用" : "当前未启用"}</span>
              <button type="button" className="settings-secondary-button" disabled={disabled} onClick={() => {
                void mutate(async () => { await window.minou.setActiveWebSearchProvider(selected.enabled ? null : selected.id); return selected.id })
              }}>{selected.enabled ? "停用" : "启用"}</button></div>}
            <form onSubmit={submit} className="web-search-form">
              <label className="settings-field"><span>服务商</span>
                <select aria-label="搜索服务商" value={name} disabled={disabled || selectedId !== null} onChange={(event) => { setName(event.target.value); setValues({}); setError(null) }}>
                  {definitions.map((entry) => <option value={entry.name} key={entry.name}>{entry.name}</option>)}
                </select></label>
              {definition?.parameters.map((field) => <label className="settings-field" key={field.key}>
                <span>{field.label}{!field.required && "（可选）"}</span>
                <input aria-label={field.key} type={field.secret ? "password" : field.type === "positiveInteger" ? "number" : "text"}
                  required={field.required} min={field.type === "positiveInteger" ? 1 : undefined} max={field.max} step={field.type === "positiveInteger" ? 1 : undefined}
                  autoComplete={field.secret ? "new-password" : "off"} disabled={disabled} value={values[field.key] ?? ""}
                  placeholder={field.defaultValue === undefined ? undefined : String(field.defaultValue)}
                  onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />
                {field.defaultValue !== undefined && <span className="settings-empty-note">留空使用 {field.defaultValue}{field.max === undefined ? "" : `，最多 ${field.max}`}。</span>}
              </label>)}
              {!definition && <p className="settings-empty-note">暂无可用的预置搜索服务商。</p>}
              <div className="settings-form-footer"><button type="submit" className="settings-primary-button" disabled={disabled || !definition}>{selectedId ? "保存配置" : "创建配置"}</button></div>
              {!selectedId && <p className="settings-empty-note">新建配置默认停用，创建后可手动启用。最多启用一个服务商。</p>}
            </form>
            {selected && <div className="web-search-delete">
              {!confirmDelete ? <button type="button" className="settings-text-button settings-danger-button" disabled={disabled} onClick={() => setConfirmDelete(true)}>删除配置</button> : <>
                <p>确认删除这条 {selected.name} 配置？{selected.enabled && "删除后将没有启用的服务商。"}</p>
                <div className="web-search-actions"><button type="button" className="settings-secondary-button" disabled={disabled} onClick={() => setConfirmDelete(false)}>取消删除</button>
                  <button type="button" className="settings-text-button settings-danger-button" disabled={disabled} onClick={() => {
                    void mutate(async () => { await window.minou.deleteWebSearchProvider(selected.id); return null })
                  }}>确认删除</button></div></>}
            </div>}
          </>}
        </section>
      </div>}
  </div>
}
