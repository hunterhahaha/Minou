/** 内置浏览器的跨进程身份、布局及状态契约。 */
export interface WebTagRef {
  sessionId: string
  tagId: string
}

/** Renderer 视口中的 CSS 像素；主进程换算为窗口内容区 DIP。 */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 当前窗口期望显示的网页，或隐藏全部网页。 */
export interface BrowserPresentation {
  revision: number
  active: { ref: WebTagRef; bounds: BrowserBounds } | null
}

/** 网页导航状态，按标签身份回传。 */
export interface WebTagState {
  ref: WebTagRef
  /** 一次性通知前端登记 Chromium 创建的子标签。 */
  opened?: "foreground" | "background"
  /** 网页自行关闭时移除标签。 */
  closed?: true
  url: string
  title: string
  status: "loading" | "ready" | "error"
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

/** 网页实例操作的 IPC 请求。 */
export type BrowserCommand =
  | { action: "create" | "navigate"; ref: WebTagRef; url: string }
  | { action: "close" | "back" | "forward" | "reload"; ref: WebTagRef }
  | { action: "present"; presentation: BrowserPresentation }

export const BROWSER_COMMAND = "browser:command"
export const BROWSER_STATE = "browser:state"

/** 指定项目及其一个已关联的绝对目录。 */
export type FileExplorerSource = { projectId: string; directoryPath: string }

/** 已授权的根目录及仅在发起窗口有效的读取句柄。 */
export interface FileExplorerRoot {
  handle: string
  path: string
  name: string
}

/** 根目录或某个子目录中的单个直属条目。 */
export interface FileExplorerEntry {
  name: string
  kind: "directory" | "file"
}

/** 有界的只读预览结果，包含读取时的文件大小。 */
export type FileExplorerFile = { size: number } & (
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "pdf"; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "unsupported"; reason: "binary" | "size" }
)

/** 文件资源查看器的固定 IPC 通道。 */
export const FILE_EXPLORER_CHANNELS = {
  open: "browser:explorer:open",
  list: "browser:explorer:list",
  read: "browser:explorer:read",
  close: "browser:explorer:close",
} as const

/** 仅允许浏览器面板所需的命令及状态订阅。 */
export interface NiCodeBrowserApi {
  /** 创建网页实例。 @param ref 标签身份 @param url 初始地址 @returns 实例创建结果。 */
  createWebTag(ref: WebTagRef, url: string): Promise<void>
  /** 销毁实例。 @param ref 标签身份 @returns 销毁结果。 */
  closeWebTag(ref: WebTagRef): Promise<void>
  /** 导航至地址。 @param ref 标签身份 @param url 目标地址 @returns 导航命令结果。 */
  navigateWebTag(ref: WebTagRef, url: string): Promise<void>
  /** 后退。 @param ref 标签身份 @returns 导航命令结果。 */
  goBack(ref: WebTagRef): Promise<void>
  /** 前进。 @param ref 标签身份 @returns 导航命令结果。 */
  goForward(ref: WebTagRef): Promise<void>
  /** 刷新或重试。 @param ref 标签身份 @returns 导航命令结果。 */
  reload(ref: WebTagRef): Promise<void>
  /** 更新显示意图。 @param presentation 布局快照 @returns 应用结果。 */
  present(presentation: BrowserPresentation): Promise<void>
  /** 订阅网页状态。 @param listener 状态接收器 @returns 取消订阅函数。 */
  onWebTagState(listener: (state: WebTagState) => void): () => void
  /** 授权查看项目关联目录。 @param source 项目及其关联目录。 @returns 已授权的根目录。 */
  openFileExplorer(source: FileExplorerSource): Promise<FileExplorerRoot>
  /** 枚举直属条目。 @param handle 根目录句柄。 @param relativePath 相对目录，空字符串表示根。 @returns 直属条目。 */
  listExplorerDirectory(handle: string, relativePath: string): Promise<FileExplorerEntry[]>
  /** 读取有界文件预览。 @param handle 根目录句柄。 @param relativePath 相对文件路径。 @returns 元数据及可预览内容。 */
  readExplorerFile(handle: string, relativePath: string): Promise<FileExplorerFile>
  /** 释放目录句柄。 @param handle 根目录句柄。 @returns 释放结果。 */
  closeFileExplorer(handle: string): Promise<void>
}
