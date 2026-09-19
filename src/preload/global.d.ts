import type { NiCodePreloadApi } from "./session-api.ts"

declare global {
  interface Window {
    nicode: NiCodePreloadApi
  }
}

export {}
