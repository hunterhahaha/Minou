import { useLayoutEffect, useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent } from "react"

const minimumWidth = 250
const compactWidth = 900
const minimumViewportWidth = 480
const compactMinimumWidth = 190
const workspaceReserve = 480
const boundaryTravel = 16
const frequency = 18

/** 记录本次拖动的起点及最近一次移动，用于松手时延续速度。 */
interface SidebarDrag {
  pointerId: number
  startX: number
  startWidth: number
  position: number
  time: number
  velocity: number
}

/** 管理侧栏开关、当前窗口内的拖动宽度以及宽度动画。
 * @returns 侧栏当前状态、布局引用及分隔线交互处理器。
 */
export function useSidebarLayout() {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [desktopOpen, setDesktopOpen] = useState(true)
  const [compactOpen, setCompactOpen] = useState(false)
  const [preferredWidth, setPreferredWidth] = useState(minimumWidth)
  const [dragging, setDragging] = useState(false)
  const compact = viewportWidth < compactWidth
  const open = compact ? compactOpen : desktopOpen
  const maximum = Math.max(minimumWidth, viewportWidth - workspaceReserve)
  const width = compact
    ? compactMinimumWidth + (minimumWidth - compactMinimumWidth) *
      (Math.max(minimumViewportWidth, viewportWidth) - minimumViewportWidth) / (compactWidth - minimumViewportWidth)
    : Math.min(preferredWidth, maximum)
  const [visible, setVisible] = useState(open)
  const slot = useRef<HTMLDivElement>(null)
  const toggleButton = useRef<HTMLButtonElement>(null)
  const motion = useRef({ position: open ? width : 0, velocity: 0 })
  const drag = useRef<SidebarDrag | null>(null)

  useLayoutEffect(() => {
    let wasCompact = window.innerWidth < compactWidth
    /** 同步窗口宽度，离开窄窗时清除临时展开状态。 */
    function resize(): void {
      const nextWidth = window.innerWidth
      const nextCompact = nextWidth < compactWidth
      if (nextCompact !== wasCompact) {
        drag.current = null
        setDragging(false)
        setCompactOpen(false)
        wasCompact = nextCompact
      }
      setViewportWidth(nextWidth)
    }
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  useLayoutEffect(() => {
    if (!open && slot.current?.contains(document.activeElement)) toggleButton.current?.focus()
    if (open) setVisible(true)
    if (dragging) return

    const target = open ? width : 0
    const initial = motion.current
    const displacement = initial.position - target
    const slope = initial.velocity + frequency * displacement
    const start = performance.now()
    let frame = 0

    /** 解析求解临界阻尼弹簧，使用上一帧的位置和速度衔接反向动画。
     * @param now 当前帧的高精度时间，单位为毫秒。
     */
    function animate(now: number): void {
      const time = Math.max(0, now - start) / 1000
      const decay = Math.exp(-frequency * time)
      const offset = (displacement + slope * time) * decay
      const velocity = (initial.velocity - frequency * slope * time) * decay
      if ((Math.abs(offset) < 0.25 && Math.abs(velocity) < 3) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        writeWidth(target, 0)
        if (!open) setVisible(false)
        return
      }
      writeWidth(Math.max(0, Math.min(maximum + boundaryTravel, target + offset)), velocity)
      frame = requestAnimationFrame(animate)
    }
    animate(start)
    return () => cancelAnimationFrame(frame)
  }, [open, width, maximum, dragging])

  /** 更新侧栏外槽的宽度，避免动画每帧重渲染工作区。
   * @param position 外槽的可见宽度。
   * @param velocity 当前宽度变化速度，单位为像素每秒。
   */
  function writeWidth(position: number, velocity: number): void {
    motion.current = { position, velocity }
    slot.current?.style.setProperty("--sidebar-width", `${position}px`)
  }

  /** 切换当前窗口模式的侧栏，同时结束进行中的拖动。 */
  function toggle(): void {
    drag.current = null
    setDragging(false)
    if (compact) setCompactOpen((current) => !current)
    else setDesktopOpen((current) => !current)
  }

  /** 捕获主指针，记录拖动起点。
   * @param event 分隔线收到的按下事件。
   */
  function startDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!open || compact || !event.isPrimary || event.button !== 0) return
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    const position = motion.current.position
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: position, position, time: event.timeStamp, velocity: 0 }
    setDragging(true)
  }

  /** 根据指针位移调整宽度，边界外仅显示有限的弹性位移。
   * @param event 分隔线收到的移动事件。
   */
  function moveDrag(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const requested = current.startWidth + event.clientX - current.startX
    const bounded = Math.max(minimumWidth, Math.min(maximum, requested))
    const excess = requested - bounded
    const position = bounded + boundaryTravel * excess / (boundaryTravel * 2 + Math.abs(excess))
    const elapsed = Math.max(1, event.timeStamp - current.time)
    current.velocity = Math.max(-1400, Math.min(1400, (position - current.position) * 1000 / elapsed))
    current.position = position
    current.time = event.timeStamp
    writeWidth(position, current.velocity)
  }

  /** 提交边界内的宽度，松手后的弹簧从当前宽度和速度继续。
   * @param event 释放或取消本次拖动的指针事件。
   */
  function finishDrag(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    const position = current.position
    const velocity = event.type === "pointerup" && event.timeStamp - current.time < 80 ? current.velocity : 0
    writeWidth(position, velocity)
    setPreferredWidth(Math.max(minimumWidth, Math.min(maximum, position)))
    setDragging(false)
  }

  /** 支持通过方向键、Home 和 End 调整分隔线。
   * @param event 分隔线收到的按键事件。
   */
  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 48 : 16
    const requested = { ArrowLeft: width - step, ArrowRight: width + step, Home: minimumWidth, End: maximum }[event.key]
    if (requested === undefined) return
    event.preventDefault()
    setPreferredWidth(Math.max(minimumWidth, Math.min(maximum, requested)))
  }

  return { compact, open, visible, width, minimumWidth, maximum, slot, toggleButton, toggle, startDrag, moveDrag, finishDrag, resizeWithKeyboard }
}
