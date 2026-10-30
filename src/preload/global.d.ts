import type { NiCodePreloadApi } from "./session-api.ts"
import type { NiCodeWindowApi } from "./window-api.ts"

declare global {
  /**
   * Renderer 全局窗口上由 preload 提供的 NiCode 窄接口。
   */
  interface Window {
    nicode: NiCodePreloadApi
    /** 独立于业务 IPC 的当前窗口控制入口。 */
    nicodeWindow: NiCodeWindowApi
  }
}

export {}
