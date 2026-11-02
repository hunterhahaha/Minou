/** 新聊天与已有对话共用的模型入口；只展示选项并回传选择，持久化由页面负责。 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { IconArrowLeft, IconCheck, IconChevronDown, IconChevronRight } from "@tabler/icons-react"

/** 模型面板消费的显示选项；身份与数据库模型引用由调用页面映射。 */
export interface ComposerModelOption {
  /** 页面用于定位 Provider 与模型的稳定联合键。 */
  key: string
  /** 模型名称。 */
  name: string
  /** 模型所属供应商的显示名称。 */
  providerName: string
}

/** 模型面板的展示数据与明确选择出口。 */
interface ComposerModelPickerProps {
  /** 可切换的已配置模型。 */
  options: ComposerModelOption[]
  /** 当前模型的联合身份；模型已删除时可能不在 options 中。 */
  selectedKey: string
  /** 当前模型名称；失效模型仍保留原名。 */
  modelName: string
  /** 当前实际选择的推理等级。 */
  /** 当前模型是否支持思考，控制等级入口的可见性。 */
  supportsReasoning: boolean
  reasoningLevel: string
  /** 当前模型支持的等级顺序；空数组禁用等级调整。 */
  reasoningLevels: string[]
  /** 设置正在保存或控制状态尚未就绪时禁用入口。 */
  disabled: boolean
  /** 区分新聊天和已有对话入口的可访问名称。 */
  label: string
  /** 将模型联合键交给页面保存。 */
  onModelChange: (key: string) => void
  /** 将一个有效推理等级交给页面保存。 */
  onReasoningChange: (level: string) => void
}

/**
 * 用单行入口打开模型和推理等级两行菜单，再进入对应选项列表。
 * @param props 页面确认的模型、等级、忙碌状态和两个选择回调。
 * @returns 顶层原生 popover；窗口缩放、滚动及内容变化时重新定位，Escape 恢复入口焦点。
 */
export function ComposerModelPicker({ options, selectedKey, modelName, supportsReasoning, reasoningLevel, reasoningLevels, disabled, label, onModelChange, onReasoningChange }: ComposerModelPickerProps) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<"menu" | "reasoning" | "models">("menu")
  useEffect(() => {
    if (!supportsReasoning && page === "reasoning") {
      setPage("menu")
      requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[data-model-setting="models"]')?.focus())
    }
  }, [supportsReasoning, page])
  const levelValid = reasoningLevels.includes(reasoningLevel)
  useEffect(() => { if (disabled) panel.current?.hidePopover() }, [disabled])
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return
    /** 将面板限制在窗口内，优先放在输入框上方；不依赖可滚动祖先的裁切区域。 */
    function position(): void {
      const popup = panel.current, button = trigger.current
      if (!popup || !button) return
      const rect = button.getBoundingClientRect()
      const width = popup.getBoundingClientRect().width
      const height = popup.getBoundingClientRect().height
      popup.style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + "px"
      popup.style.top = Math.max(12, Math.min(rect.top - height - 10, window.innerHeight - height - 12)) + "px"
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(panel.current)
    window.addEventListener("resize", position)
    window.addEventListener("scroll", position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", position)
      window.removeEventListener("scroll", position, true)
    }
  }, [open])
  /** 关闭当前面板；页面负责处理保存失败并保留之前确认的选择。 */
  function close(): void { panel.current?.hidePopover() }
  /**
   * 切换菜单页面并聚焦当前选项；返回主菜单时恢复对应行的焦点。
   * @param next 要展示的菜单或选项列表。
   * @param returnTo 返回主菜单时应聚焦的入口行。
   */
  function showPage(next: "menu" | "reasoning" | "models", returnTo?: "reasoning" | "models"): void {
    setPage(next)
    requestAnimationFrame(() => {
      const target = next === "menu" ? panel.current?.querySelector<HTMLElement>(`[data-model-setting="${returnTo ?? "models"}"]`)
        : panel.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? panel.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
      target?.focus({ preventScroll: true })
    })
  }
  return <div className="selector-anchor composer-model-picker">
    <button ref={trigger} className="selector-trigger model-trigger" type="button" aria-label={label} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={id} disabled={disabled} popoverTarget={id} title={supportsReasoning ? modelName + " · " + reasoningLevel : modelName}>
      <span className="composer-model-name">{modelName}</span>{supportsReasoning && <span className="composer-model-reasoning">{reasoningLevel}</span>}
      <IconChevronDown size={12} className="composer-model-chevron" aria-hidden="true" />
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label="模型与推理设置" className="composer-model-panel"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close() }}
      onToggle={(event) => {
        const shown = event.newState === "open"
        setOpen(shown)
        if (shown) {
          showPage("menu")
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); close(); trigger.current?.focus() }
        if (page !== "menu" && event.key === "ArrowLeft") { event.preventDefault(); showPage("menu", page) }
        if (page === "menu" && event.key === "ArrowRight") {
          const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="menuitem"]')
          if (button) { event.preventDefault(); button.click() }
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')]
          if (!buttons.length) return
          event.preventDefault()
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : current < 0 ? event.key === "ArrowUp" ? buttons.length - 1 : 0
            : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length
          buttons[next].focus()
        }
      }}>
      {page === "menu" ? <div className="model-settings-menu" role="menu" aria-label="模型与推理选项">
        <button type="button" className="model-setting-row" role="menuitem" aria-haspopup="menu" aria-label="切换模型" data-model-setting="models" onClick={() => showPage("models")}>
          <span className="model-setting-label">模型</span><span className="model-setting-value">{modelName}</span><IconChevronRight size={13} aria-hidden="true" />
        </button>
        {supportsReasoning && <button type="button" className="model-setting-row" role="menuitem" aria-haspopup="menu" aria-label="设置推理等级" data-model-setting="reasoning" onClick={() => showPage("reasoning")}>
          <span className="model-setting-label">推理等级</span><span className="model-setting-value">{reasoningLevel}{!levelValid && "（已失效）"}</span><IconChevronRight size={13} aria-hidden="true" />
        </button>}
      </div> : page === "reasoning" && supportsReasoning ? <>
        <button type="button" className="model-panel-back" aria-label="返回模型与推理菜单" onClick={() => showPage("menu", "reasoning")}><IconArrowLeft size={15} aria-hidden="true" />推理等级</button>
        <div className="model-option-list reasoning-menu" role="menu" aria-label="推理等级选项">{reasoningLevels.map((level) =>
          <button type="button" role="menuitemradio" aria-checked={level === reasoningLevel} disabled={disabled} key={level} onClick={() => { close(); if (level !== reasoningLevel) onReasoningChange(level) }}>
            <span>{level}</span>{level === reasoningLevel && <IconCheck size={15} aria-hidden="true" />}
          </button>)}</div>
        {reasoningLevels.length === 0 && <p className="model-panel-note">当前模型不可用，请切换模型。</p>}
      </> : <>
        <button type="button" className="model-panel-back" aria-label="返回模型与推理菜单" onClick={() => showPage("menu", "models")}><IconArrowLeft size={15} aria-hidden="true" />模型</button>
        <div className="model-option-list model-menu" role="menu" aria-label="模型选项">{options.map((model) => <button type="button" role="menuitemradio" aria-checked={model.key === selectedKey}
          key={model.key} title={model.providerName + " / " + model.name} disabled={disabled} onClick={() => { close(); onModelChange(model.key) }}>
          <span><strong>{model.name}</strong><small>{model.providerName}</small></span>{model.key === selectedKey && <IconCheck size={15} aria-hidden="true" />}
        </button>)}</div>
        {options.length === 0 && <p className="model-panel-note">暂无可用模型，请在设置中添加。</p>}
      </>}
    </div>
  </div>
}
