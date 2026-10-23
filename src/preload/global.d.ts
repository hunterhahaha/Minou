import type { NiCodePreloadApi } from "./session-api.ts"
import type { NiCodeWindowApi } from "./window-api.ts"

declare global {
  interface Window {
    nicode: NiCodePreloadApi
    /** 独立于业务 IPC 的当前窗口控制入口。 */
    nicodeWindow: NiCodeWindowApi
  }
}

export {}
