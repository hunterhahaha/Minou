/** MCP 设置页面：整份配置显式保存，运行资源只通过 preload API 管理。 */
import { type FormEvent, useEffect, useRef, useState } from "react"
import { IconPlus, IconRefresh, IconX } from "@tabler/icons-react"
import type { MCPConfig } from "../../runtime/mcp/src/types.ts"
import type { MCPServerSummary } from "../preload/session-api.ts"

/** 多值输入行使用稳定身份，删除前一行不会复用后一行的输入节点。 */
interface ValueRow {
  /** 当前表单行身份，不持久化。 */ id: number
  /** 原样保存的参数或键值。 */ value: string
}
/** 环境变量和请求头共用的表单行。 */
interface PairRow extends ValueRow {
  /** 保存时校验的键。 */ key: string
}
/** 两种传输的编辑草稿；提交时只生成当前传输对应的字段。 */
interface McpDraft {
  /** 配置和连接的身份。 */ name: string
  /** 保存后是否建立连接。 */ enabled: boolean
  /** 当前传输类型。 */ transport: MCPConfig["transport"]
  /** 本地启动命令。 */ command: string
  /** 可选工作目录。 */ cwd: string
  /** 按输入顺序传递的参数。 */ args: ValueRow[]
  /** 本地进程环境变量。 */ env: PairRow[]
  /** 远程 HTTP 地址。 */ url: string
  /** 宿主 Bearer 环境变量名。 */ bearer: string
  /** 静态 HTTP 请求头。 */ headers: PairRow[]
  /** 启动总超时的秒数字符串；空值不持久化。 */ startup: string
  /** 工具超时的秒数字符串；空值不持久化。 */ timeout: string
}

let nextRowId = 0
/**
 * 为键值表单行生成独立身份和初始值。
 *
 * @param value 初始行值。
 * @returns 具有唯一表单身份的新行。
 */
function valueRow(value = ""): ValueRow { return { id: ++nextRowId, value } }

/**
 * 从已保存 MCP 配置构造独立草稿，缺省时使用启用的 stdio 草稿。
 *
 * @param config 已保存配置；省略时创建默认启用的 stdio 草稿。
 * @returns 独立表单草稿。
 */
function draftFromConfig(config?: MCPConfig): McpDraft {
  return {
    name: config?.name ?? "", enabled: config?.enabled ?? true, transport: config?.transport ?? "stdio",
    command: config?.transport === "stdio" ? config.command : "", cwd: config?.transport === "stdio" ? config.cwd ?? "" : "",
    args: config?.transport === "stdio" ? (config.args ?? []).map(valueRow) : [],
    env: config?.transport === "stdio" ? Object.entries(config.env ?? {}).map(([key, value]) => ({ ...valueRow(value), key })) : [],
    url: config?.transport === "streamable-http" ? config.url : "",
    bearer: config?.transport === "streamable-http" ? config.bearer_token_env_var ?? "" : "",
    headers: config?.transport === "streamable-http" ? Object.entries(config.http_headers ?? {}).map(([key, value]) => ({ ...valueRow(value), key })) : [],
    startup: config?.startup_timeout_sec?.toString() ?? "", timeout: config?.tool_timeout_sec?.toString() ?? "",
  }
}

/**
 * 检查键值行，保留值中的空白和空字符串。
 * @param rows 表单中的全部行。
 * @param label 字段错误的显示名称。
 * @param ignoreCase 请求头按大小写不敏感检查重复键。
 * @returns 未配置时为 undefined，否则返回键值对象。
 * @throws Error 键为空或重复。
 */
function parsePairs(rows: PairRow[], label: string, ignoreCase = false): Record<string, string> | undefined {
  const keys = new Set<string>()
  const entries = rows.map((row) => {
    const key = row.key.trim()
    const identity = ignoreCase ? key.toLowerCase() : key
    if (!key) throw new Error(`${label}名称不能为空。`)
    if (keys.has(identity)) throw new Error(`${label}名称不能重复。`)
    keys.add(identity)
    return [key, row.value] as const
  })
  return entries.length ? Object.fromEntries(entries) : undefined
}

/**
 * 将完整草稿转成现有 MCPConfig，不补可选字段默认值。
 * @param draft 当前表单内容。
 * @param servers 当前页面的有效配置列表。
 * @param originalName 正在编辑的身份；null 为新增。
 * @returns 可交给主进程再次校验的配置。
 * @throws Error 必填项、唯一名称、URL、超时、键值或鉴权冲突无效。
 */
function parseDraft(draft: McpDraft, servers: MCPServerSummary[], originalName: string | null): MCPConfig {
  const name = draft.name.trim()
  if (!name) throw new Error("MCP 名称不能为空。")
  if (servers.some((server) => server.config.name === name && server.config.name !== originalName)) throw new Error("MCP 名称已存在。")
  /**
   * 解析可省略的超时草稿，并检查后端计时器范围。
   *
   * @param value 超时草稿。
   * @returns 有限正数秒或省略值。
   * @throws Error 超出后端计时器范围。
   */
  function seconds(value: string): number | undefined {
    if (!value.trim()) return undefined
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0 || number * 1000 > 2_147_483_647) throw new Error("超时必须是计时器范围内的有限正数秒。")
    return number
  }
  const startup = seconds(draft.startup), timeout = seconds(draft.timeout)
  const base = { name, enabled: draft.enabled, ...(startup === undefined ? {} : { startup_timeout_sec: startup }), ...(timeout === undefined ? {} : { tool_timeout_sec: timeout }) }
  if (draft.transport === "stdio") {
    const command = draft.command.trim()
    if (!command) throw new Error("启动命令不能为空。")
    const env = parsePairs(draft.env, "环境变量")
    return { ...base, transport: "stdio", command, ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      ...(draft.args.length ? { args: draft.args.map((row) => row.value) } : {}), ...(env ? { env } : {}) }
  }
  const url = draft.url.trim()
  try { if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error() } catch { throw new Error("URL 必须是绝对 HTTP(S) 地址。") }
  const headers = parsePairs(draft.headers, "请求头", true)
  const bearer = draft.bearer.trim()
  if (bearer && headers && Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) throw new Error("Bearer 环境变量与 Authorization 请求头不能同时配置。")
  return { ...base, transport: "streamable-http", url, ...(bearer ? { bearer_token_env_var: bearer } : {}), ...(headers ? { http_headers: headers } : {}) }
}

/**
 * 根据 MCP 连接快照生成当前状态说明。
 *
 * @param server 服务器快照。
 * @returns 页面状态说明。
 */
function statusLabel(server: MCPServerSummary): string {
  if (!server.config.enabled && !server.error) return "已禁用"
  return { connecting: "正在连接", connected: "已连接", disconnected: "未连接", error: "连接错误" }[server.status]
}

/** MCP 页面需要统一阻止外层关闭和导航的请求状态。 */
interface McpSettingsProps {
  /** @param busy 配置查询或变更正在进行。 */ onBusyChange: (busy: boolean) => void
}

/**
 * 展示有效配置、运行状态和完整配置表单，所有保存结果以主进程快照为准。
 * @param props 通知设置弹窗请求状态的回调。
 * @returns MCP 管理页面。
 */
export function McpSettings({ onBusyChange }: McpSettingsProps) {
  const [servers, setServers] = useState<MCPServerSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<McpDraft>(() => draftFromConfig())
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const current = servers.find((server) => server.config.name === selected)
  let validation: string | null = null
  try { parseDraft(draft, servers, selected) } catch (failure) { validation = (failure as Error).message }

  /**
   * 切换当前编辑的 MCP 项，缺省时初始化新增草稿。
   *
   * @param server 要编辑的项；省略时开始新增。
   */
  function choose(server?: MCPServerSummary): void {
    if (pending.current) return
    setSelected(server?.config.name ?? null)
    setDraft(draftFromConfig(server?.config))
    setError(null)
    setNotice(null)
  }

  /**
   * 执行一次查询或变更；错误保留草稿，并尽力重新读取已持久化状态。
   * @param action 对应的窄化 preload 请求。
   * @param preferred 操作成功后优先选中的名称。
   * @param message 成功提示；连接错误另由当前 Server 的状态说明。
   * @returns 本次请求及页面同步完成。
   */
  async function perform(action: () => Promise<MCPServerSummary[]>, preferred: string | null, message: string | null): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    setNotice(null)
    try {
      const next = await action()
      setServers(next)
      const target = next.find((server) => server.config.name === preferred) ?? next[0]
      setSelected(target?.config.name ?? null)
      setDraft(draftFromConfig(target?.config))
      setNotice(message)
      setLoaded(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "MCP 操作失败，请重试。")
      try { setServers(await window.minou.listMcpServers()); setLoaded(true) } catch { /** 读取失败时保留原快照与草稿。 */ }
    } finally {
      pending.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }

  useEffect(() => { void perform(() => window.minou.listMcpServers(), null, null) }, [])

  /**
   * 提交 MCP 表单并等待后端保存与对应连接尝试。
   *
   * @param event 表单提交事件。
   * @returns 保存及对应连接尝试完成。
   */
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (validation || pending.current) return
    const config = parseDraft(draft, servers, selected)
    await perform(() => selected === null ? window.minou.createMcpServer(config) : window.minou.updateMcpServer(selected, config), config.name, "配置已保存。")
  }

  return <div className="mcp-settings" aria-busy={busy}>
    <div className="mcp-toolbar">
      <h3>MCP 服务器</h3>
      <div className="settings-field-actions">
        <button type="button" className="settings-secondary-button" aria-label="刷新 MCP" disabled={busy} onClick={() => { void perform(() => window.minou.reloadMcpServers(), selected, "已重新加载全部 MCP 连接。") }}>
          <IconRefresh size={15} aria-hidden="true" />{busy ? "处理中…" : "刷新"}
        </button>
        <button type="button" className="settings-primary-button" aria-label="新增 MCP" disabled={busy} onClick={() => choose()}><IconPlus size={15} aria-hidden="true" />新增</button>
      </div>
    </div>
    {error && <p className="mcp-message settings-inline-error" role="alert">{error}</p>}
    {notice && <p className="mcp-message" role="status">{notice}</p>}
    {!loaded && <p className="mcp-message" role="status">{busy ? "正在加载 MCP…" : "列表未加载，可点击刷新重试。"}</p>}
    <div className="mcp-management">
      <aside className="mcp-sidebar" aria-label="MCP 列表">
        {!servers.length && loaded && <p className="settings-empty-note">暂无 MCP 服务器</p>}
        <ul className="provider-list">{servers.map((server) => <li key={server.config.name}>
          <button type="button" className={`provider-list-item${selected === server.config.name ? " provider-list-item-active" : ""}`} aria-current={selected === server.config.name ? "true" : undefined} disabled={busy} onClick={() => choose(server)}>
            <span className="provider-list-name">{server.config.name}</span><span className="provider-list-model-count">{statusLabel(server)} · {server.toolCount} 个工具</span>
          </button>
        </li>)}</ul>
      </aside>
      <section className="mcp-detail" aria-label="MCP 配置">
        <div className="mcp-detail-heading"><h3>{selected === null ? "新增 MCP" : "编辑 MCP"}</h3></div>
        {current && <p className="mcp-connection-state" role={current.error ? "alert" : "status"}>
          {current.error ? `配置已保存，但运行状态异常：${current.error.message}` : `${statusLabel(current)} · ${current.toolCount} 个工具`}
        </p>}
        <form onSubmit={(event) => { void save(event) }} noValidate>
          <fieldset className="mcp-form" disabled={busy || !loaded}>
            <label className="settings-field"><span>名称</span><input aria-label="MCP 名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label className="settings-field"><span>传输类型</span><select aria-label="MCP 传输类型" value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as MCPConfig["transport"] })}><option value="stdio">本地进程（stdio）</option><option value="streamable-http">Streamable HTTP</option></select></label>
            <label className="mcp-enabled"><input type="checkbox" aria-label="启用 MCP" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用此服务器</label>
            {draft.transport === "stdio" ? <>
              <label className="settings-field"><span>启动命令</span><input aria-label="MCP 启动命令" value={draft.command} placeholder="node / npx / 可执行文件路径" onChange={(event) => setDraft({ ...draft, command: event.target.value })} /></label>
              <label className="settings-field"><span>工作目录（可选）</span><input aria-label="MCP 工作目录" value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} /></label>
              <div className="mcp-rows"><div className="mcp-row-heading"><span>启动参数</span><button type="button" className="settings-secondary-button" onClick={() => setDraft({ ...draft, args: [...draft.args, valueRow()] })}>添加参数</button></div>
                {draft.args.map((row, index) => <div className="mcp-value-row" key={row.id}><input aria-label={`启动参数 ${index + 1}`} value={row.value} onChange={(event) => setDraft({ ...draft, args: draft.args.map((entry) => entry.id === row.id ? { ...entry, value: event.target.value } : entry) })} /><button type="button" className="settings-icon-button" aria-label={`删除参数 ${index + 1}`} onClick={() => setDraft({ ...draft, args: draft.args.filter((entry) => entry.id !== row.id) })}><IconX size={16} /></button></div>)}
              </div>
              <PairEditor label="环境变量" rows={draft.env} onChange={(env) => setDraft({ ...draft, env })} />
            </> : <>
              <label className="settings-field"><span>服务器 URL</span><input aria-label="MCP URL" value={draft.url} placeholder="https://example.com/mcp" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
              <label className="settings-field"><span>Bearer 环境变量名（可选）</span><input aria-label="MCP Bearer 环境变量名" value={draft.bearer} placeholder="保存 Token 的宿主环境变量名" onChange={(event) => setDraft({ ...draft, bearer: event.target.value })} /></label>
              <PairEditor label="请求头" rows={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} />
            </>}
            <div className="mcp-timeouts">
              <label className="settings-field"><span>启动超时（秒，可选）</span><input aria-label="MCP 启动超时" inputMode="decimal" placeholder="默认 10" value={draft.startup} onChange={(event) => setDraft({ ...draft, startup: event.target.value })} /></label>
              <label className="settings-field"><span>工具超时（秒，可选）</span><input aria-label="MCP 工具超时" inputMode="decimal" placeholder="默认 60" value={draft.timeout} onChange={(event) => setDraft({ ...draft, timeout: event.target.value })} /></label>
            </div>
            {validation && <p className="settings-inline-error">{validation}</p>}
            <div className="settings-form-footer">
              {selected !== null && <button type="button" className="settings-danger-button" aria-label="删除 MCP" onClick={() => { void perform(() => window.minou.deleteMcpServer(selected), null, "MCP 已删除。") }}>删除</button>}
              <button type="button" className="settings-secondary-button" onClick={() => choose(current)}>取消修改</button>
              <button type="submit" className="settings-primary-button" aria-label="保存 MCP" disabled={validation !== null}>{busy ? "正在保存…" : "保存"}</button>
            </div>
          </fieldset>
        </form>
      </section>
    </div>
  </div>
}

/** 键值编辑器的明确输入和草稿更新边界。 */
interface PairEditorProps {
  /** 环境变量或请求头的显示名称。 */ label: string
  /** 当前有序行。 */ rows: PairRow[]
  /** @param rows 更新后的完整行列表。 */ onChange: (rows: PairRow[]) => void
}
/**
 * 展示环境变量或请求头的可增删键值草稿行。
 *
 * @param props 环境变量或请求头的草稿及更新回调。
 * @returns 可增删的键值行编辑器。
 */
function PairEditor({ label, rows, onChange }: PairEditorProps) {
  return <div className="mcp-rows"><div className="mcp-row-heading"><span>{label}</span><button type="button" className="settings-secondary-button" onClick={() => onChange([...rows, { ...valueRow(), key: "" }])}>添加{label}</button></div>
    {rows.map((row, index) => <div className="mcp-pair-row" key={row.id}>
      <input aria-label={`${label} ${index + 1} 名称`} placeholder="名称" value={row.key} onChange={(event) => onChange(rows.map((entry) => entry.id === row.id ? { ...entry, key: event.target.value } : entry))} />
      <input aria-label={`${label} ${index + 1} 值`} placeholder="值（允许为空）" value={row.value} onChange={(event) => onChange(rows.map((entry) => entry.id === row.id ? { ...entry, value: event.target.value } : entry))} />
      <button type="button" className="settings-icon-button" aria-label={`删除${label} ${index + 1}`} onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}><IconX size={16} /></button>
    </div>)}
  </div>
}
