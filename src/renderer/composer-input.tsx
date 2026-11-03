/** 首页与对话页共用的内容自适应输入框，不持有草稿或发送状态。 */
import { useLayoutEffect, useRef, type RefObject, type TextareaHTMLAttributes } from "react"

/** 受控输入属性，保留原页面的输入法与发送事件处理。 */
interface ComposerInputProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows" | "ref" | "value"> {
  /** 当前页面已经持有的草稿。 */
  value: string
  /** 可选的外部焦点入口。 */
  inputRef?: RefObject<HTMLTextAreaElement | null>
}

/**
 * 空内容从一行开始，按文本实际高度增长；到 CSS 上限后只在输入框内滚动。
 * @param props 受控草稿、既有事件回调和可选焦点引用。
 * @returns 禁止手动拉伸的单行起始 textarea；清空或宽度变化时重新计算高度。
 */
export function ComposerInput({ inputRef, value, ...props }: ComposerInputProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null)
  const ref = inputRef ?? internalRef
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    let width = node.clientWidth
    /**
     * 根据受控文本更新输入区域的 DOM 高度。
     *
     * @returns 仅更新 DOM 尺寸，不触发 React 草稿变更。
     */
    function resize(): void {
      if (!node) return
      const limit = Number.parseFloat(getComputedStyle(node).maxHeight) || 200
      node.style.height = "0px"
      const naturalHeight = node.scrollHeight
      node.style.height = `${Math.min(naturalHeight, limit)}px`
      node.style.overflowY = naturalHeight > limit ? "auto" : "hidden"
    }
    resize()
    let frame = 0
    const observer = new ResizeObserver(() => {
      const nextWidth = node.clientWidth
      if (nextWidth === 0 || nextWidth === width) return
      width = nextWidth
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (node.clientWidth > 0) resize() })
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [ref, value])
  return <textarea {...props} ref={ref} rows={1} value={value} />
}
