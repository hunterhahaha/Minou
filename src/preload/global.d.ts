import type { MinouBrowserApi } from "./browser-api.ts"
import type { MinouPreloadApi } from "./session-api.ts"
import type { MinouWindowApi } from "./window-api.ts"

declare global {
  /**
   * Renderer 全局窗口上由 preload 提供的 Minou 窄接口。
   */
  interface Window {
    minou: MinouPreloadApi
    /** 内置浏览器命令与网页状态订阅。 */
    minouBrowser: MinouBrowserApi
    /** 独立于业务 IPC 的当前窗口控制入口。 */
    minouWindow: MinouWindowApi
  }
}

export {}
