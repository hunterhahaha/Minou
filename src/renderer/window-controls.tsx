/** 顶部栏的自绘窗口按钮，关闭行为由主进程的桌面偏好决定。 */
import { useEffect, useState } from "react"
import { IconMinus, IconSquare, IconSquares, IconX } from "@tabler/icons-react"
import type { WindowState } from "../preload/window-api.ts"

/**
 * 读取并订阅当前窗口状态；按钮通过独立窗口 API 操作，不接触业务状态。
 * @returns 最小化、最大化/还原和关闭按钮，以及窗口操作失败提示。
 */
export function WindowControls() {
  const [state, setState] = useState<WindowState>({ maximized: false })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let mounted = true
    let receivedUpdate = false
    const unsubscribe = window.nicodeWindow.onStateChanged((next) => { receivedUpdate = true; setState(next) })
    void window.nicodeWindow.getState().then((next) => { if (mounted && !receivedUpdate) setState(next) }).catch(() => { if (mounted) setError("无法读取窗口状态") })
    return () => { mounted = false; unsubscribe() }
  }, [])
  /**
   * 执行用户触发的窗口操作，并保留失败后的重试入口。
   *
   * @param action 用户触发的窗口操作。
   * @returns 操作完成；失败时保留可重试的按钮。
   */
  async function operate(action: "minimize" | "maximize" | "close"): Promise<void> {
    setError(null)
    try {
      if (action === "minimize") await window.nicodeWindow.minimize()
      else if (action === "close") await window.nicodeWindow.close()
      else setState(await window.nicodeWindow.toggleMaximize())
    } catch { setError("窗口操作失败，请重试") }
  }
  return <div className="window-controls" aria-label="窗口控制">
    {error && <span className="window-control-error" role="alert">{error}</span>}
    <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => void operate("minimize")}><IconMinus size={15} stroke={1.4} /></button>
    <button type="button" aria-label={state.maximized ? "还原窗口" : "最大化窗口"} title={state.maximized ? "还原" : "最大化"} onClick={() => void operate("maximize")}>{state.maximized ? <IconSquares size={14} stroke={1.4} /> : <IconSquare size={13} stroke={1.4} />}</button>
    <button className="window-close" type="button" aria-label="关闭窗口" title="关闭窗口" onClick={() => void operate("close")}><IconX size={16} stroke={1.4} /></button>
  </div>
}
