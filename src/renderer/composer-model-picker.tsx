/** 新聊天与已有对话共用的模型入口；只展示选项并回传选择，持久化由页面负责。 */
import { useEffect, useId, useRef, useState } from "react"
import { IconCheck, IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import { preferredReasoningLevel } from "../../runtime/model/src/reasoning.ts"

/** 模型面板消费的显示选项；身份与数据库模型引用由调用页面映射。 */
export interface ComposerModelOption {
  /** 页面用于定位 Provider 与模型的稳定联合键。 */
  key: string
  /** 模型名称。 */
  name: string
  /** 模型所属供应商的显示名称。 */
  providerName: string
  /** 可在模型行旁选择的有效推理等级。 */
  reasoningLevels: readonly string[]
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
  /** 设置正在保存或控制状态尚未就绪时禁用入口。 */
  disabled: boolean
  /** 区分新聊天和已有对话入口的可访问名称。 */
  label: string
  /** 将模型联合键和可选的明确等级交给页面保存。 */
  onModelChange: (key: string, level?: string) => void
  /** 将一个有效推理等级交给页面保存。 */
  onReasoningChange: (level: string) => void
}

/**
 * 打开模型列表，并从支持推理的模型行查看和选择等级。
 * @param props 页面确认的模型、等级、忙碌状态和两个选择回调。
 * @returns 由浏览器锚定入口的顶层原生 popover；Escape 恢复入口焦点。
 */
export function ComposerModelPicker({ options, selectedKey, modelName, supportsReasoning, reasoningLevel, disabled, label, onModelChange, onReasoningChange }: ComposerModelPickerProps) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [flyout, setFlyout] = useState<{ key: string; row: HTMLButtonElement; left: number; top: number } | null>(null)
  const flyoutModel = options.find((model) => model.key === flyout?.key)
  const flyoutLevel = !flyoutModel?.reasoningLevels.length ? undefined : flyoutModel.key === selectedKey
    ? reasoningLevel : preferredReasoningLevel(flyoutModel.reasoningLevels, reasoningLevel)
  useEffect(() => { if (disabled) panel.current?.hidePopover() }, [disabled])
  /** 关闭当前面板；页面负责处理保存失败并保留之前确认的选择。 */
  function close(): void { panel.current?.hidePopover() }
  /** 在模型行旁展示有效等级，必要时将菜单放到行的上方或下方。
   * @param model 当前预览的模型。
   * @param row 对应模型行，用于定位及返回键盘焦点。
   */
  function previewLevels(model: ComposerModelOption, row: HTMLButtonElement): void {
    if (!model.reasoningLevels.length || !panel.current) { setFlyout(null); return }
    const bounds = panel.current.getBoundingClientRect()
    const rowBounds = row.getBoundingClientRect()
    const width = 148
    const height = Math.min(model.reasoningLevels.length * 30 + 10, 240, window.innerHeight - 24)
    const fitsRight = bounds.right + width <= window.innerWidth - 12
    const fitsLeft = bounds.left - width >= 12
    const left = fitsRight ? bounds.right : fitsLeft ? bounds.left - width : bounds.right - width
    const requestedTop = fitsRight || fitsLeft ? rowBounds.top : rowBounds.bottom + height <= window.innerHeight - 12 ? rowBounds.bottom : rowBounds.top - height
    setFlyout({ key: model.key, row, left: Math.max(12, left), top: Math.max(12, Math.min(requestedTop, window.innerHeight - height - 12)) })
  }
  return <div className="selector-anchor composer-model-picker">
    <button ref={trigger} className="selector-trigger model-trigger" type="button" aria-label={label} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={id} disabled={disabled} popoverTarget={id} title={supportsReasoning ? modelName + " · " + reasoningLevel : modelName}>
      <span className="composer-model-name">{modelName}</span>{supportsReasoning && <span className="composer-model-reasoning">{reasoningLevel}</span>}
      <IconChevronDown size={12} className="composer-model-chevron" aria-hidden="true" />
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label="模型与推理设置" className="composer-model-panel"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close() }}
      onPointerLeave={() => { if (!document.activeElement?.closest('.model-level-flyout')) setFlyout(null) }}
      onToggle={(event) => {
        const shown = event.newState === "open"
        setOpen(shown)
        setFlyout(null)
        if (shown) (panel.current?.querySelector<HTMLElement>('.model-menu [aria-checked="true"]') ??
          panel.current?.querySelector<HTMLElement>('.model-menu button'))?.focus()
      }}
      onKeyDown={(event) => {
        const inFlyout = (event.target as HTMLElement).closest('.model-level-flyout')
        if (event.key === "Escape") { event.preventDefault(); close(); trigger.current?.focus() }
        if (inFlyout && event.key === "ArrowLeft") {
          event.preventDefault()
          flyout?.row.focus()
          setFlyout(null)
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const buttons = [...(inFlyout ?? panel.current!).querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')]
            .filter((button) => inFlyout || !button.closest('.model-level-flyout'))
          if (!buttons.length) return
          event.preventDefault()
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : current < 0 ? event.key === "ArrowUp" ? buttons.length - 1 : 0
            : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length
          buttons[next].focus()
        }
      }}>
        <div className="model-panel-heading" aria-hidden="true">模型</div>
        <div className="model-option-list model-menu" role="menu" aria-label="模型选项" onScroll={() => setFlyout(null)}>{options.map((model) => <button type="button" role="menuitemradio" aria-checked={model.key === selectedKey}
          key={model.key} title={model.providerName + " / " + model.name} disabled={disabled}
          aria-haspopup={model.reasoningLevels.length ? "menu" : undefined} aria-expanded={model.reasoningLevels.length ? flyout?.key === model.key : undefined}
          onPointerEnter={(event) => { if (event.pointerType === "mouse") previewLevels(model, event.currentTarget) }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" || !model.reasoningLevels.length) return
            event.preventDefault()
            previewLevels(model, event.currentTarget)
            requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('.model-level-flyout [aria-checked="true"]') ??
              panel.current?.querySelector<HTMLElement>('.model-level-flyout button'))?.focus({ preventScroll: true }))
          }}
          onClick={(event) => {
            const pointerType = (event.nativeEvent as PointerEvent).pointerType
            if (model.reasoningLevels.length && (pointerType === "touch" || pointerType === "pen")) {
              previewLevels(model, event.currentTarget)
              return
            }
            close()
            onModelChange(model.key)
          }}>
          <span><strong>{model.name}</strong><small>{model.providerName}</small></span>{model.key === selectedKey ? <IconCheck size={15} aria-hidden="true" /> : model.reasoningLevels.length > 0 && <IconChevronRight size={13} aria-hidden="true" />}
        </button>)}</div>
        {flyout && flyoutModel && <div className="model-level-flyout model-option-list" role="menu" aria-label={`${flyoutModel.name}推理等级`} style={{ left: flyout.left, top: flyout.top }}>
          {flyoutModel.reasoningLevels.map((level) => <button key={level} type="button" role="menuitemradio" aria-checked={level === flyoutLevel}
            onClick={() => {
              close()
              if (flyoutModel.key !== selectedKey) onModelChange(flyoutModel.key, level)
              else if (level !== reasoningLevel) onReasoningChange(level)
            }}><span>{level}</span>{level === flyoutLevel && <IconCheck size={15} aria-hidden="true" />}</button>)}
        </div>}
        {options.length === 0 && <p className="model-panel-note">暂无可用模型，请在设置中添加。</p>}
    </div>
  </div>
}
