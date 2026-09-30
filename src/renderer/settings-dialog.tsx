/** 模型设置弹窗：维护 Provider 基本信息、凭据与所属模型。 */

import { type FormEvent, useEffect, useRef, useState } from "react"
import { IconPlus, IconX } from "@tabler/icons-react"

import type {
  ModelAppend,
  ModelSummary,
  ProviderModelInput,
  ProviderModelUpdate,
  ProviderSummary,
} from "../preload/session-api.ts"
import { PROTOCOLS } from "../../runtime/model/src/types.ts"
import type { Protocol } from "../../runtime/model/src/types.ts"

/** 模型设置弹窗可通知工作区的 Provider 列表变更。 */
interface SettingsDialogProps {
  /** 关闭设置弹窗。 */
  onClose: () => void
  /** 将完整 Provider 列表同步到工作区模型选择器。 */
  onProvidersChange: (providers: ProviderSummary[]) => void
}

/** 新建表单中尚未持久化的模型行。 */
interface ModelDraft {
  /** 当前表单行的稳定身份。 */
  draftId: number
  /** Provider API 请求中使用的模型名称。 */
  name: string
  /** 声明的上下文窗口 Token 数。 */
  contextWindow: string
  /** 单次请求允许的最大输出 Token 数。 */
  maxOutputTokens: string
}

/** 供应商创建表单中的协议显示名称。 */
const protocolLabels: Record<Protocol, string> = {
  anthropic_messages: "Anthropic Messages",
  chat_completions: "Chat Completions",
  responses: "Responses",
}

/** 创建表单模型行使用的临时数字身份。 */
let nextModelDraftId = 0

/**
 * 创建一条显示数据库默认 Token 限制的临时模型行。
 * @returns 名称为空、上下文窗口为 256000、最大输出为 32000 的模型草稿。
 */
function createModelDraft(): ModelDraft {
  nextModelDraftId += 1
  return {
    draftId: nextModelDraftId,
    name: "",
    contextWindow: "256000",
    maxOutputTokens: "32000",
  }
}

/**
 * 将输入框内容解析为正安全整数。
 * @param value 输入框中的字符串。
 * @returns 合法的正安全整数；输入为空、非整数或超出安全范围时为 null。
 */
function parsePositiveInteger(value: string): number | null {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * 验证并整理单条模型创建草稿。
 * @param draft 等待提交的模型输入框内容。
 * @returns 符合 Provider 创建接口的模型配置；任一必填字段无效时为 null。
 */
function parseModelDraft(draft: Pick<ModelDraft, "name" | "contextWindow" | "maxOutputTokens">): ProviderModelInput | null {
  const name = draft.name.trim()
  const contextWindow = parsePositiveInteger(draft.contextWindow)
  const maxOutputTokens = parsePositiveInteger(draft.maxOutputTokens)
  if (name === "" || contextWindow === null || maxOutputTokens === null) return null
  return { name, contextWindow, maxOutputTokens }
}

/**
 * 检查页面中的 Provider 地址草稿，供创建和字段保存显示校验结果。
 * @param value 地址输入框内容；空值由调用方根据创建或更新契约处理。
 * @returns 去除首尾空格后为带主机的 HTTP(S) 绝对地址时返回 true。
 */
function isHttpURL(value: string): boolean {
  const normalized = value.trim()
  try {
    const parsed = new URL(normalized)
    return /^https?:\/\//i.test(normalized) &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== ""
  } catch {
    return false
  }
}

/**
 * 渲染设置导航、供应商创建页或供应商详情页，并同步当前 Provider 列表。
 * @param props 关闭弹窗与同步工作区模型选项的回调。
 * @returns 模型设置弹窗。
 */
export function SettingsDialog({ onClose, onProvidersChange }: SettingsDialogProps) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const providersRef = useRef<ProviderSummary[]>([])
  const [page, setPage] = useState<"create" | "manage">("create")
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** 同步守住关闭和导航路径，不等待创建状态的下一次渲染。 */
  const creatingRef = useRef(false)

  /**
   * 接收 Provider 或模型创建请求的生命周期，统一控制外层关闭和导航。
   * @param pending 请求进行中时为 true，成功或失败后为 false。
   */
  function handleCreatingChange(pending: boolean): void {
    creatingRef.current = pending
    setCreating(pending)
  }

  /** 请求关闭设置弹窗；创建中的 IPC 完成前保留当前表单。 */
  function requestClose(): void {
    if (!creatingRef.current) onClose()
  }

  /**
   * 更新弹窗与工作区共用的完整 Provider 列表。
   * @param nextProviders 从数据库读取或在已确认写入后得到的 Provider 列表。
   */
  function commitProviders(nextProviders: ProviderSummary[]): void {
    providersRef.current = nextProviders
    setProviders(nextProviders)
    onProvidersChange(nextProviders)
  }

  /**
   * 重新读取 Provider 目录，保留仍存在的选中项。
   * @returns Provider 查询完成后的 Promise。
   */
  async function loadProviders(): Promise<void> {
    setLoadState("loading")
    setLoadError(null)
    try {
      const loaded = await window.nicode.listProviders()
      const nextSelected = loaded.some((provider) => provider.providerId === selectedProviderId)
        ? selectedProviderId
        : loaded[0]?.providerId ?? null
      commitProviders(loaded)
      setSelectedProviderId(nextSelected)
      setPage(loaded.length > 0 ? "manage" : "create")
      setLoadState("ready")
    } catch (error) {
      console.error("加载设置中的供应商失败", error)
      setLoadError("供应商列表加载失败，请重试。")
      setLoadState("error")
    }
  }

  /**
   * 用补丁更新一个 Provider，并把结果同步到弹窗与工作区。
   * @param providerId 要更新的 Provider 身份。
   * @param patch 已保存的 Provider 字段变化。
   */
  function patchProvider(providerId: string, patch: Partial<ProviderSummary>): void {
    const current = providersRef.current
    const next = current.map((provider) => provider.providerId === providerId
      ? { ...provider, ...patch }
      : provider)
    commitProviders(next)
  }

  /**
   * 将新建 Provider 加到目录末尾并打开其详情。
   * @param provider 主进程返回的新 Provider 摘要。
   */
  function handleProviderCreated(provider: ProviderSummary): void {
    const next = [
      ...providersRef.current.filter((entry) => entry.providerId !== provider.providerId),
      provider,
    ]
    commitProviders(next)
    setSelectedProviderId(provider.providerId)
    setPage("manage")
  }

  /**
   * 将已有 Provider 的模型字段更新到页面摘要。
   * @param providerId 模型所属 Provider 身份。
   * @param modelId 要更新的全局模型身份。
   * @param update 已通过主进程写入的模型字段。
   */
  function handleModelSaved(providerId: string, modelId: string, update: ProviderModelUpdate): void {
    const provider = providersRef.current.find((entry) => entry.providerId === providerId)
    if (provider === undefined) return
    patchProvider(providerId, {
      models: provider.models.map((model) => model.modelId === modelId
        ? { ...model, ...update }
        : model),
    })
  }

  /**
   * 把新建模型追加到所属 Provider，保留已有默认模型标记。
   * @param providerId 模型所属 Provider 身份。
   * @param appended 主进程返回的新模型摘要。
   */
  function handleModelCreated(providerId: string, appended: ModelAppend): void {
    const provider = providersRef.current.find((entry) => entry.providerId === providerId)
    if (provider === undefined) return
    const hasDefault = providersRef.current.some((entry) => entry.models.some((model) => model.isDefault))
    const model: ModelSummary = {
      modelId: appended.modelId,
      name: appended.name,
      contextWindow: appended.contextWindow,
      maxOutputTokens: appended.maxOutputTokens,
      isDefault: !hasDefault,
    }
    patchProvider(providerId, { models: [...provider.models, model] })
  }

  useEffect(() => {
    void loadProviders()
  }, [])

  useEffect(() => {
    /** @param event 键盘事件；Escape 在没有创建请求时关闭设置弹窗。 */
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") requestClose()
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [onClose])

  const selectedProvider = providers.find((provider) => provider.providerId === selectedProviderId)

  return <div
    className="settings-dialog-backdrop"
    role="presentation"
    onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}
  >
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" aria-busy={loadState === "loading" || creating}>
      <header className="settings-dialog-header">
        <h2 id="settings-dialog-title">设置</h2>
        <button className="settings-dialog-close" type="button" aria-label="关闭设置" disabled={creating} onClick={requestClose}>
          <IconX size={20} stroke={1.5} aria-hidden="true" />
        </button>
      </header>
      <div className="settings-dialog-body">
        <nav className="settings-dialog-nav" aria-label="设置选项">
          <button className="settings-nav-option settings-nav-option-active" type="button" aria-current="page">
            模型
          </button>
        </nav>
        <section className="settings-dialog-content" aria-label="模型设置">
          {loadState === "loading" && <p className="settings-state" role="status">正在加载供应商…</p>}
          {loadState === "error" && <div className="settings-state settings-state-error" role="alert">
            <span>{loadError}</span>
            <button type="button" className="settings-secondary-button" onClick={() => { void loadProviders() }}>重试</button>
          </div>}
          {loadState === "ready" && page === "create" && <CreateProviderForm
            hasProviders={providers.length > 0}
            onCancel={() => setPage("manage")}
            onCreated={handleProviderCreated}
            onCreatingChange={handleCreatingChange}
          />}
          {loadState === "ready" && page === "manage" && <div className="provider-management">
            <aside className="provider-sidebar" aria-label="供应商列表">
              <div className="provider-sidebar-heading">
                <h3>供应商</h3>
                <button
                  className="settings-icon-button"
                  type="button"
                  aria-label="新增供应商"
                  title="新增供应商"
                  disabled={creating}
                  onClick={() => setPage("create")}
                >
                  <IconPlus size={18} stroke={1.7} aria-hidden="true" />
                </button>
              </div>
              {providers.length === 0
                ? <p className="settings-empty-note">暂无供应商</p>
                : <ul className="provider-list">{providers.map((provider) => <li key={provider.providerId}>
                    <button
                      type="button"
                      className={provider.providerId === selectedProviderId ? "provider-list-item provider-list-item-active" : "provider-list-item"}
                      aria-current={provider.providerId === selectedProviderId ? "true" : undefined}
                      disabled={creating}
                      onClick={() => setSelectedProviderId(provider.providerId)}
                    >
                      <span className="provider-list-name">{provider.name}</span>
                      <span className="provider-list-model-count">{provider.models.length} 个模型</span>
                    </button>
                  </li>)}</ul>}
            </aside>
            <section className="provider-detail-panel" aria-label="供应商详情">
              {selectedProvider === undefined
                ? <div className="settings-empty-detail">
                    <h3>选择供应商</h3>
                    <p>从左侧选择一个供应商，查看连接信息与模型。</p>
                  </div>
                : <ProviderDetail
                    key={selectedProvider.providerId}
                    provider={selectedProvider}
                    onProfileSaved={(name, url) => patchProvider(selectedProvider.providerId, {
                      name,
                      ...(url === "" ? { baseURL: undefined } : { baseURL: url }),
                    })}
                    onModelSaved={(modelId, update) => handleModelSaved(selectedProvider.providerId, modelId, update)}
                    onModelCreated={(model) => handleModelCreated(selectedProvider.providerId, model)}
                    onModelDeleted={loadProviders}
                    onCreatingChange={handleCreatingChange}
                  />}
            </section>
          </div>}
        </section>
      </div>
    </section>
  </div>
}

/**
 * 渲染供应商及其待创建模型的表单。
 * @param props 创建成功、返回列表与通知外层请求状态的回调。
 * @returns 可提交 Provider、协议和模型列表的表单。
 */
function CreateProviderForm({
  hasProviders,
  onCancel,
  onCreated,
  onCreatingChange,
}: {
  hasProviders: boolean
  onCancel: () => void
  onCreated: (provider: ProviderSummary) => void
  onCreatingChange: (creating: boolean) => void
}) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [protocol, setProtocol] = useState<Protocol | "">("")
  const [models, setModels] = useState<ModelDraft[]>([createModelDraft()])
  const [creating, setCreating] = useState(false)
  /** 同步阻止同一次创建操作的重复提交。 */
  const creatingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const parsedModels = models.map(parseModelDraft)
  const urlValid = isHttpURL(url)
  const formValid = name.trim() !== "" && urlValid && apiKey.trim() !== "" &&
    protocol !== "" && parsedModels.every((model) => model !== null)

  /**
   * 更新一条未提交模型行的输入。
   * @param draftId 模型草稿身份。
   * @param update 本次输入变化。
   */
  function updateModelDraft(draftId: number, update: Partial<ModelDraft>): void {
    setModels((current) => current.map((model) => model.draftId === draftId
      ? { ...model, ...update }
      : model))
  }

  /**
   * 调用 Provider 创建接口，并在成功后进入供应商详情页。
   * @param event 创建表单提交事件。
   * @returns Provider 创建完成后的 Promise。
   */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!formValid || creatingRef.current) return

    creatingRef.current = true
    setCreating(true)
    onCreatingChange(true)
    setError(null)
    try {
      const provider = await window.nicode.createProvider(
        name.trim(),
        apiKey,
        protocol,
        url.trim(),
        parsedModels as ProviderModelInput[],
      )
      onCreated(provider)
    } catch (cause) {
      console.error("创建供应商失败", cause)
      setError("创建供应商失败，请检查连接信息后重试。")
    } finally {
      creatingRef.current = false
      setCreating(false)
      onCreatingChange(false)
    }
  }

  return <div className="provider-create-page">
    <div className="settings-page-heading">
      <div>
        <p className="settings-eyebrow">模型</p>
        <h3>创建供应商</h3>
        <p>填写连接信息，并添加要使用的模型。</p>
      </div>
      {hasProviders && <button className="settings-secondary-button" type="button" disabled={creating}
        onClick={() => { if (!creatingRef.current) onCancel() }}>返回供应商列表</button>}
    </div>
    <form className="provider-create-form" onSubmit={(event) => { void submit(event) }}>
      <div className="provider-form-grid">
        <label className="settings-field">
          <span>供应商名称</span>
          <input
            type="text"
            autoFocus
            autoComplete="off"
            placeholder="例如：OpenAI"
            value={name}
            disabled={creating}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>协议</span>
          <select value={protocol} disabled={creating} onChange={(event) => setProtocol(event.target.value as Protocol | "")}>
            <option value="">请选择协议</option>
            {PROTOCOLS.map((entry) => <option key={entry} value={entry}>{protocolLabels[entry]}</option>)}
          </select>
        </label>
        <label className="settings-field settings-field-wide">
          <span>URL</span>
          <input
            type="url"
            autoComplete="url"
            placeholder="https://api.example.com/v1"
            value={url}
            disabled={creating}
            onChange={(event) => setUrl(event.target.value)}
          />
          {url.trim() !== "" && !urlValid && <span className="settings-inline-error">请输入有效的 HTTP 或 HTTPS 绝对地址。</span>}
        </label>
        <label className="settings-field settings-field-wide">
          <span>API Key</span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="输入供应商 API Key"
            value={apiKey}
            disabled={creating}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      </div>

      <section className="create-models-section" aria-labelledby="create-models-title">
        <div className="settings-section-heading">
          <div>
            <h4 id="create-models-title">模型</h4>
            <p>上下文窗口和最大输出使用 Token 数。</p>
          </div>
          <button
            className="settings-secondary-button"
            type="button"
            disabled={creating}
            onClick={() => setModels((current) => [...current, createModelDraft()])}
          >
            <IconPlus size={16} stroke={1.7} aria-hidden="true" />
            添加模型
          </button>
        </div>
        {models.length === 0
          ? <p className="settings-empty-note">还没有添加模型。</p>
          : <div className="create-model-list">{models.map((model, index) => <div className="create-model-row" key={model.draftId}>
              <div className="create-model-row-heading">
                <span>模型 {index + 1}</span>
                <button
                  className="settings-text-button"
                  type="button"
                  disabled={creating}
                  aria-label={"移除模型 " + (index + 1)}
                  onClick={() => setModels((current) => current.filter((entry) => entry.draftId !== model.draftId))}
                >
                  移除
                </button>
              </div>
              <div className="model-input-grid">
                <label className="settings-field settings-field-wide">
                  <span>模型名称</span>
                  <input
                    type="text"
                    placeholder="例如：gpt-4.1"
                    value={model.name}
                    disabled={creating}
                    onChange={(event) => updateModelDraft(model.draftId, { name: event.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>最大上下文</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={model.contextWindow}
                    disabled={creating}
                    onChange={(event) => updateModelDraft(model.draftId, { contextWindow: event.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>最大输出</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={model.maxOutputTokens}
                    disabled={creating}
                    onChange={(event) => updateModelDraft(model.draftId, { maxOutputTokens: event.target.value })}
                  />
                </label>
              </div>
            </div>)}</div>}
      </section>

      {error !== null && <p className="settings-inline-error" role="alert">{error}</p>}
      <footer className="settings-form-footer">
        <button className="settings-primary-button" type="submit" disabled={!formValid || creating}>
          {creating ? "正在创建…" : "创建供应商"}
        </button>
      </footer>
    </form>
  </div>
}

/**
 * 维护已有 Provider 的字段草稿；点击保存后才更新连接信息或 API Key。
 * @param props 当前 Provider、保存结果及通知外层创建状态的回调。
 * @returns 供应商详情表单及关联模型配置。
 */
function ProviderDetail({
  provider,
  onProfileSaved,
  onModelSaved,
  onModelCreated,
  onModelDeleted,
  onCreatingChange,
}: {
  provider: ProviderSummary
  onProfileSaved: (name: string, url: string) => void
  onModelSaved: (modelId: string, update: ProviderModelUpdate) => void
  onModelCreated: (model: ModelAppend) => void
  onModelDeleted: () => Promise<void>
  onCreatingChange: (creating: boolean) => void
}) {
  const [name, setName] = useState(provider.name)
  const [url, setUrl] = useState(provider.baseURL ?? "")
  const [apiKey, setApiKey] = useState("")
  const [profileState, setProfileState] = useState<"saved" | "saving" | "error">("saved")
  const [profileError, setProfileError] = useState<string | null>(null)
  const [apiKeyState, setApiKeyState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [newModelDialogOpen, setNewModelDialogOpen] = useState(false)
  const lastSavedProfile = useRef({ name: provider.name, url: provider.baseURL ?? "" })
  const [savingProfileField, setSavingProfileField] = useState<"name" | "url" | null>(null)
  const nameDirty = name !== lastSavedProfile.current.name
  const urlDirty = url !== lastSavedProfile.current.url
  const urlValid = url.trim() === "" || isHttpURL(url)

  /**
   * 保存指定字段，另一个字段使用已保存值，避免提交尚未确认的草稿。
   * @param field 本次点击保存的供应商字段。
   * @returns 请求完成后的 Promise；失败保留草稿并展示可重试的错误。
   */
  async function saveProfileField(field: "name" | "url"): Promise<void> {
    if (profileState === "saving") return
    const snapshot = {
      name: field === "name" ? name.trim() : lastSavedProfile.current.name,
      url: field === "url" ? url.trim() : lastSavedProfile.current.url,
    }
    if (snapshot.name === "") return

    setProfileState("saving")
    setSavingProfileField(field)
    setProfileError(null)
    try {
      await window.nicode.updateProvider(provider.providerId, snapshot.name, snapshot.url)
      lastSavedProfile.current = snapshot
      if (field === "name") setName(snapshot.name)
      else setUrl(snapshot.url)
      onProfileSaved(snapshot.name, snapshot.url)
      setProfileState("saved")
    } catch (error) {
      console.error("更新供应商信息失败", error)
      setProfileError("供应商信息保存失败，请点击保存重试。")
      setProfileState("error")
    } finally {
      setSavingProfileField(null)
    }
  }

  /**
   * 点击保存后写入新 API Key；成功清空输入，失败保留草稿供重试。
   * @returns API Key 请求完成后的 Promise；空输入或正在保存时不发起请求。
   */
  async function saveApiKey(): Promise<void> {
    if (apiKey.trim() === "" || apiKeyState === "saving") return

    setApiKeyState("saving")
    try {
      await window.nicode.updateApiKey(provider.providerId, apiKey)
      setApiKey("")
      setApiKeyState("saved")
    } catch (error) {
      console.error("更新供应商 API Key 失败", error)
      setApiKeyState("error")
    }
  }

  return <div className="provider-detail">
    <div className="provider-detail-heading" inert={newModelDialogOpen}>
      <div>
        <p className="settings-eyebrow">供应商详情</p>
        <h3>{provider.name}</h3>
      </div>
      <span className="provider-protocol-badge">{protocolLabels[provider.protocol]}</span>
    </div>

    <div className="provider-detail-form" inert={newModelDialogOpen}>
      <label className="settings-field">
        <span>供应商名称</span>
        <input
          type="text"
          aria-label="供应商名称"
          autoComplete="off"
          disabled={profileState === "saving"}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {nameDirty && <div className="settings-field-actions">
          <button className="settings-primary-button" type="button" aria-label="保存供应商名称"
            disabled={name.trim() === "" || profileState === "saving"}
            onClick={() => { void saveProfileField("name") }}>
            {savingProfileField === "name" ? "正在保存…" : "保存"}
          </button>
          <button className="settings-secondary-button" type="button" aria-label="取消供应商名称修改"
            disabled={profileState === "saving"}
            onClick={() => { setName(lastSavedProfile.current.name); setProfileError(null); setProfileState("saved") }}>
            取消
          </button>
        </div>}
        {nameDirty && name.trim() === "" && <span className="settings-inline-error">供应商名称不能为空。</span>}
      </label>
      <label className="settings-field">
        <span>URL</span>
        <input
          type="url"
          aria-label="供应商 URL"
          autoComplete="url"
          disabled={profileState === "saving"}
          value={url}
          placeholder="https://api.example.com/v1"
          onChange={(event) => setUrl(event.target.value)}
        />
        {urlDirty && <div className="settings-field-actions">
          <button className="settings-primary-button" type="button" aria-label="保存供应商 URL"
            disabled={profileState === "saving" || !urlValid}
            onClick={() => { void saveProfileField("url") }}>
            {savingProfileField === "url" ? "正在保存…" : "保存"}
          </button>
          <button className="settings-secondary-button" type="button" aria-label="取消供应商 URL 修改"
            disabled={profileState === "saving"}
            onClick={() => { setUrl(lastSavedProfile.current.url); setProfileError(null); setProfileState("saved") }}>
            取消
          </button>
        </div>}
        {urlDirty && !urlValid && <span className="settings-inline-error">请输入有效的 HTTP 或 HTTPS 绝对地址。</span>}
      </label>
      <label className="settings-field">
        <span>API Key</span>
        <input
          type="password"
          aria-label="供应商 API Key"
          autoComplete="new-password"
          value={apiKey}
          placeholder="留空表示不显示当前 Key"
          disabled={apiKeyState === "saving"}
          onChange={(event) => { setApiKey(event.target.value); setApiKeyState("idle") }}
        />
        {apiKey !== "" && <div className="settings-field-actions">
          <button className="settings-primary-button" type="button" aria-label="保存 API Key"
            disabled={apiKey.trim() === "" || apiKeyState === "saving"}
            onClick={() => { void saveApiKey() }}>
            {apiKeyState === "saving" ? "正在保存…" : "保存"}
          </button>
          <button className="settings-secondary-button" type="button" aria-label="取消 API Key 修改"
            disabled={apiKeyState === "saving"}
            onClick={() => { setApiKey(""); setApiKeyState("idle") }}>
            取消
          </button>
        </div>}
        <span className="settings-field-hint" role={apiKeyState === "error" ? "alert" : "status"}>
          {apiKeyState === "saving" ? "正在保存 API Key…" :
            apiKeyState === "saved" ? "API Key 已更新。" :
              apiKeyState === "error" ? "API Key 保存失败，请重试。" :
                "输入新 Key 后点击保存；此处不会显示已保存的 Key。"}
        </span>
      </label>
      <div className="provider-profile-status" role={profileError === null ? "status" : "alert"}>
        {profileError ?? (profileState === "saving" ? "正在保存供应商信息…" :
          profileState === "error" ? "供应商信息保存失败。" : "修改后点击字段旁的保存按钮，取消可恢复已保存的值。")}
      </div>
    </div>

    <section className="provider-models-section" aria-labelledby="provider-models-title" inert={newModelDialogOpen}>
      <div className="settings-section-heading">
        <div>
          <h4 id="provider-models-title">关联模型</h4>
          <p>修改后点击保存；取消仅恢复对应字段。</p>
        </div>
        <button className="settings-secondary-button" type="button" onClick={() => setNewModelDialogOpen(true)}>
          <IconPlus size={16} stroke={1.7} aria-hidden="true" />
          新建模型
        </button>
      </div>
      {provider.models.length === 0
        ? <p className="settings-empty-note">该供应商还没有模型。</p>
        : <div className="provider-model-list">{provider.models.map((model) => <ModelEditor
            key={model.modelId}
            providerId={provider.providerId}
            model={model}
            onModelSaved={onModelSaved}
            onDeleted={onModelDeleted}
          />)}</div>}
    </section>
    {newModelDialogOpen && <CreateModelDialog
      provider={provider}
      onClose={() => setNewModelDialogOpen(false)}
      onCreated={(model) => {
        onModelCreated(model)
        setNewModelDialogOpen(false)
      }}
      onCreatingChange={onCreatingChange}
    />}
  </div>
}

/**
 * 为现有模型维护名称与 Token 限制草稿，仅在点击字段保存时调用更新接口。
 * @param props Provider、模型身份及更新和删除回调。
 * @returns 支持按字段保存、取消及模型删除的配置卡片。
 */
function ModelEditor({
  providerId,
  model,
  onModelSaved,
  onDeleted,
}: {
  providerId: string
  model: ModelSummary
  onModelSaved: (modelId: string, update: ProviderModelUpdate) => void
  onDeleted: () => Promise<void>
}) {
  const [name, setName] = useState(model.name)
  const [contextWindow, setContextWindow] = useState(String(model.contextWindow))
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(model.maxOutputTokens))
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved")
  const [savingField, setSavingField] = useState<"name" | "contextWindow" | "maxOutputTokens" | null>(null)
  const [deleting, setDeleting] = useState(false)
  const lastSaved = useRef({
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  })
  const nameDirty = name !== lastSaved.current.name
  const contextDirty = contextWindow !== String(lastSaved.current.contextWindow)
  const outputDirty = maxOutputTokens !== String(lastSaved.current.maxOutputTokens)
  const contextValid = parsePositiveInteger(contextWindow) !== null
  const outputValid = parsePositiveInteger(maxOutputTokens) !== null
  const busy = saveState === "saving" || deleting

  /**
   * 校验并提交指定模型字段，成功后更新该字段的已保存值和页面摘要。
   * @param field 本次点击保存的字段，其他字段草稿不包含在请求中。
   * @returns 请求完成后的 Promise；无效输入或操作进行中不发请求，失败保留草稿。
   */
  async function saveModelField(field: "name" | "contextWindow" | "maxOutputTokens"): Promise<void> {
    if (busy) return
    const value = field === "name" ? name.trim()
      : parsePositiveInteger(field === "contextWindow" ? contextWindow : maxOutputTokens)
    if (value === "" || value === null) return
    const update: ProviderModelUpdate = field === "name" ? { name: String(value) }
      : { [field]: Number(value) }
    setSaveState("saving")
    setSavingField(field)
    try {
      await window.nicode.updateModel({ providerId, modelId: model.modelId }, update)
      lastSaved.current = { ...lastSaved.current, ...update }
      if (field === "name") setName(String(value))
      else if (field === "contextWindow") setContextWindow(String(value))
      else setMaxOutputTokens(String(value))
      onModelSaved(model.modelId, update)
      setSaveState("saved")
    } catch (error) {
      console.error("更新模型配置失败", error)
      setSaveState("error")
    } finally {
      setSavingField(null)
    }
  }

  /**
   * 删除当前模型；父页面随后重读 Provider 目录以刷新默认模型标记。
   * @returns 删除完成后的 Promise。
   */
  async function deleteCurrentModel(): Promise<void> {
    if (deleting) return
    setDeleting(true)
    try {
      const reference = { providerId, modelId: model.modelId }
      await window.nicode.deleteModel(reference)
      await onDeleted()
    } catch (error) {
      console.error("删除模型失败", error)
      setSaveState("error")
    } finally {
      setDeleting(false)
    }
  }

  return <article className="provider-model-editor">
    <div className="provider-model-editor-heading">
      <div>
        <h5>{model.name}</h5>
        {model.isDefault && <span className="default-model-badge">默认模型</span>}
      </div>
      <button
        className="settings-text-button settings-danger-button"
        type="button"
        disabled={busy}
        onClick={() => { void deleteCurrentModel() }}
      >
        {deleting ? "正在删除…" : "删除"}
      </button>
    </div>
    <div className="model-input-grid">
      <label className="settings-field settings-field-wide">
        <span>模型名称</span>
        <input type="text" aria-label="模型名称" disabled={busy} value={name} onChange={(event) => setName(event.target.value)} />
        {nameDirty && <div className="settings-field-actions">
          <button className="settings-primary-button" type="button" aria-label="保存模型名称"
            disabled={busy || name.trim() === ""} onClick={() => { void saveModelField("name") }}>
            {savingField === "name" ? "正在保存…" : "保存"}
          </button>
          <button className="settings-secondary-button" type="button" aria-label="取消模型名称修改"
            disabled={busy} onClick={() => { setName(lastSaved.current.name); setSaveState("saved") }}>
            取消
          </button>
        </div>}
        {nameDirty && name.trim() === "" && <span className="settings-inline-error">模型名称不能为空。</span>}
      </label>
      <label className="settings-field">
        <span>最大上下文</span>
        <input
          type="number"
          aria-label="最大上下文"
          min={1}
          step={1}
          inputMode="numeric"
          disabled={busy}
          value={contextWindow}
          onChange={(event) => setContextWindow(event.target.value)}
        />
        {contextDirty && <div className="settings-field-actions">
          <button className="settings-primary-button" type="button" aria-label="保存最大上下文"
            disabled={busy || !contextValid} onClick={() => { void saveModelField("contextWindow") }}>
            {savingField === "contextWindow" ? "正在保存…" : "保存"}
          </button>
          <button className="settings-secondary-button" type="button" aria-label="取消最大上下文修改"
            disabled={busy} onClick={() => { setContextWindow(String(lastSaved.current.contextWindow)); setSaveState("saved") }}>
            取消
          </button>
        </div>}
        {contextDirty && !contextValid && <span className="settings-inline-error">最大上下文必须为正整数。</span>}
      </label>
      <label className="settings-field">
        <span>最大输出</span>
        <input
          type="number"
          aria-label="最大输出"
          min={1}
          step={1}
          inputMode="numeric"
          disabled={busy}
          value={maxOutputTokens}
          onChange={(event) => setMaxOutputTokens(event.target.value)}
        />
        {outputDirty && <div className="settings-field-actions">
          <button className="settings-primary-button" type="button" aria-label="保存最大输出"
            disabled={busy || !outputValid} onClick={() => { void saveModelField("maxOutputTokens") }}>
            {savingField === "maxOutputTokens" ? "正在保存…" : "保存"}
          </button>
          <button className="settings-secondary-button" type="button" aria-label="取消最大输出修改"
            disabled={busy} onClick={() => { setMaxOutputTokens(String(lastSaved.current.maxOutputTokens)); setSaveState("saved") }}>
            取消
          </button>
        </div>}
        {outputDirty && !outputValid && <span className="settings-inline-error">最大输出必须为正整数。</span>}
      </label>
    </div>
    <p className={saveState === "error" ? "model-save-status model-save-status-error" : "model-save-status"} role={saveState === "error" ? "alert" : "status"}>
      {saveState === "saving" ? "正在保存…" :
        saveState === "error" ? "模型操作失败，请重试。" :
          nameDirty || contextDirty || outputDirty ? "有未保存的修改。" : "已保存"}
    </p>
  </article>
}

/**
 * 在嵌套弹窗中创建单个模型并把主进程生成的身份交给 Provider 详情页。
 * @param props 当前 Provider 与创建、关闭、通知外层请求状态的回调。
 * @returns 新建模型表单弹窗。
 */
function CreateModelDialog({
  provider,
  onClose,
  onCreated,
  onCreatingChange,
}: {
  provider: ProviderSummary
  onClose: () => void
  onCreated: (model: ModelAppend) => void
  onCreatingChange: (creating: boolean) => void
}) {
  const [name, setName] = useState("")
  const [contextWindow, setContextWindow] = useState("256000")
  const [maxOutputTokens, setMaxOutputTokens] = useState("32000")
  const [creating, setCreating] = useState(false)
  /** 请求发出前同步上锁，保证 Escape 和重复提交使用同一个进行中状态。 */
  const creatingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const parsed = parseModelDraft({ name, contextWindow, maxOutputTokens })

  /**
   * 创建模型后由 Provider 详情页追加并展示新模型。
   * @param event 模型创建表单提交事件。
   * @returns 模型创建完成后的 Promise。
   */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (parsed === null || creatingRef.current) return

    creatingRef.current = true
    setCreating(true)
    onCreatingChange(true)
    setError(null)
    try {
      const created = await window.nicode.createModel(provider.providerId, parsed)
      onCreated(created)
    } catch (cause) {
      console.error("创建模型失败", cause)
      setError("创建模型失败，请检查模型信息后重试。")
    } finally {
      creatingRef.current = false
      setCreating(false)
      onCreatingChange(false)
    }
  }

  useEffect(() => {
    /** @param event Escape 只处理当前模型弹窗；创建中保留表单并阻止外层关闭。 */
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!creatingRef.current) onClose()
    }
    window.addEventListener("keydown", closeOnEscape, true)
    return () => window.removeEventListener("keydown", closeOnEscape, true)
  }, [onClose])

  return <div
    className="new-model-dialog-backdrop"
    role="presentation"
    onMouseDown={(event) => { if (event.target === event.currentTarget && !creatingRef.current) onClose() }}
  >
    <section className="new-model-dialog" role="dialog" aria-modal="true" aria-labelledby="new-model-title" aria-busy={creating}>
      <header className="new-model-dialog-header">
        <div>
          <p className="settings-eyebrow">{provider.name}</p>
          <h3 id="new-model-title">新建模型</h3>
        </div>
        <button className="settings-dialog-close" type="button" aria-label="关闭" disabled={creating} onClick={onClose}>
          <IconX size={19} stroke={1.5} aria-hidden="true" />
        </button>
      </header>
      <form className="new-model-form" onSubmit={(event) => { void submit(event) }}>
        <label className="settings-field">
          <span>模型名称</span>
          <input
            type="text"
            autoFocus
            placeholder="例如：gpt-4.1"
            value={name}
            disabled={creating}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="model-input-grid">
          <label className="settings-field">
            <span>最大上下文</span>
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={contextWindow}
              disabled={creating}
              onChange={(event) => setContextWindow(event.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>最大输出</span>
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={maxOutputTokens}
              disabled={creating}
              onChange={(event) => setMaxOutputTokens(event.target.value)}
            />
          </label>
        </div>
        {error !== null && <p className="settings-inline-error" role="alert">{error}</p>}
        <footer className="settings-form-footer">
          <button className="settings-secondary-button" type="button" disabled={creating} onClick={onClose}>取消</button>
          <button className="settings-primary-button" type="submit" disabled={parsed === null || creating}>
            {creating ? "正在创建…" : "创建模型"}
          </button>
        </footer>
      </form>
    </section>
  </div>
}
