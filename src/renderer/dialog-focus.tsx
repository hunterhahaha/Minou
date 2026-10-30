/** 弹窗的键盘焦点边界；不处理业务关闭或请求中的保护规则。 */
import { useEffect, type RefObject } from "react"

/**
 * 打开时聚焦弹窗，限制 Tab 在最上层弹窗内移动，关闭后恢复原入口焦点。
 * @param ref 当前弹窗的根节点。
 * @param active 条件渲染之外的弹窗开启状态。
 * @returns 无返回值；卸载时移除监听并尽可能恢复焦点。
 */
export function useDialogFocus<T extends HTMLElement>(ref: RefObject<T | null>, active = true): void {
  useEffect(() => {
    if (!active || !ref.current) return
    const dialog = ref.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    /**
     * 查询当前弹窗内可见且可操作的焦点目标。
     *
     * @returns 当前弹窗内可操作且可见的焦点目标。
     */
    function targets(): HTMLElement[] {
      return [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex="0"]')]
        .filter((node) => !node.matches(':disabled, [aria-hidden="true"]') && node.getClientRects().length > 0)
    }
    const frame = requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>("[data-dialog-autofocus]")
      if (!dialog.contains(document.activeElement)) (preferred && !preferred.matches(":disabled") ? preferred : targets()[0] ?? dialog).focus()
    })
    /**
     * 在当前最上层弹窗内处理 Tab 焦点循环，保留嵌套弹窗的独立焦点边界。
     *
     * @param event 仅在最上层弹窗拦截 Tab，嵌套弹窗各自管理焦点。
     */
    function trap(event: KeyboardEvent): void {
      const dialogs = document.querySelectorAll('[aria-modal="true"]')
      if (event.key !== "Tab" || dialogs[dialogs.length - 1] !== dialog) return
      const nodes = targets()
      const first = nodes[0] ?? dialog
      const last = nodes[nodes.length - 1] ?? dialog
      if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault()
        const destination = event.shiftKey ? last : first
        destination.focus()
      }
    }
    document.addEventListener("keydown", trap)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("keydown", trap)
      if (previous?.isConnected) previous.focus()
    }
  }, [active, ref])
}
