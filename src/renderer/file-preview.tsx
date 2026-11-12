/** 根据主进程返回的内容显示单个文件的只读预览。 */
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react"
import { getFiletypeFromFileName } from "@pierre/diffs"
import { File } from "@pierre/diffs/react"
import type { FileExplorerFile } from "../preload/browser-api.ts"
import type { FileReference } from "../../runtime/session/src/events.ts"
import { MarkdownContent } from "./markdown-content.tsx"
import "./file-explorer.css"

const PdfPreview = lazy(() => import("./pdf-preview.tsx"))

/** 当前预览的读取结果。 */
type PreviewResult = { file: FileExplorerFile } | { error: string }

/** 正在查看的文件及其当前主题。 */
interface FilePreviewProps {
  handle: string
  path: string
  theme: "light" | "dark"
  /** 引用需要核对的绝对路径；文件树直接使用当前根目录。 */
  absolutePath?: string
}

/**
 * 为引用标签申请现有查看器授权，离开标签或切换文件时释放句柄。
 * @param props 要预览的文件引用及主题。
 * @returns 使用既有文件预览器显示的只读文件。
 */
export function ReferencedFilePreview({ reference, theme }: { reference: FileReference; theme: "light" | "dark" }) {
  const { projectId, directoryPath, relativePath, absolutePath, name } = reference
  const [result, setResult] = useState<{ handle: string } | { error: string }>()
  useEffect(() => {
    let active = true
    let handle: string | undefined
    void window.minouBrowser.openFileExplorer({ projectId, directoryPath }).then(
      (root) => {
        if (!active) void window.minouBrowser.closeFileExplorer(root.handle).catch(console.error)
        else { handle = root.handle; setResult({ handle }) }
      },
      (error: unknown) => { if (active) setResult({ error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => {
      active = false
      if (handle) void window.minouBrowser.closeFileExplorer(handle).catch(console.error)
    }
  }, [projectId, directoryPath])
  return <section className="file-explorer" aria-label="文件预览">
    <header className="file-explorer-header"><div className="file-explorer-heading">
      <h2 title={absolutePath}>{name}</h2>{relativePath.includes("/") && <span title={absolutePath}>{relativePath}</span>}
    </div></header>
    <div className="file-explorer-preview">
      {!result ? <p className="file-explorer-message" role="status">正在打开文件…</p>
        : "error" in result ? <p className="file-explorer-message" role="alert">无法打开文件。{result.error}</p>
          : <FilePreview handle={result.handle} path={relativePath} absolutePath={absolutePath} theme={theme} />}
    </div>
  </section>
}

/**
 * 展示无法预览的文件及其基本信息。
 * @param props 文件名、路径、字节数及用户可见的原因。
 * @returns 预览详情。
 */
function Unavailable({ name, path, size, message }: { name: string; path: string; size: number; message: string }) {
  return <div className="file-explorer-message">
    <p role="status">{message}</p>
    <dl><dt>名称</dt><dd>{name}</dd><dt>路径</dt><dd>{path}</dd>
      <dt>大小</dt><dd>{size.toLocaleString("zh-CN")} 字节</dd></dl>
  </div>
}

/** 将查看组件的渲染错误限制在当前文件。 */
class PreviewBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  /** @returns 触发当前文件的元数据回退。 */
  static getDerivedStateFromError() { return { failed: true } }

  /** @returns 预览正文或文件元数据。 */
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * 为单张栅格图片创建临时 URL，并在卸载时释放。
 * @param props 文件显示路径及图像内容。
 * @returns 图像或解码失败的详情。
 */
function ImagePreview({ name, path, file }: {
  name: string; path: string; file: Extract<FileExplorerFile, { kind: "image" }>
}) {
  const [url, setUrl] = useState("")
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType }))
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])
  if (failed) return <Unavailable name={name} path={path} size={file.size} message="无法显示此图片。" />
  return url ? <div className="file-explorer-image"><img src={url} alt={name} onError={() => setFailed(true)} /></div> : null
}

/**
 * 异步读取选中文件，并将当前结果交给对应查看器。
 * @param props 根句柄、相对路径及高亮主题。
 * @returns 左侧预览正文和读取状态。
 */
export function FilePreview({ handle, path, absolutePath, theme }: FilePreviewProps) {
  const [result, setResult] = useState<PreviewResult>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void window.minouBrowser.readExplorerFile(handle, path, absolutePath).then(
      (file) => { if (active) setResult({ file }) },
      (error: unknown) => { if (active) setResult({ error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { active = false }
  }, [handle, path, absolutePath, attempt])

  if (!result) return <p className="file-explorer-message" role="status">正在读取文件…</p>
  if ("error" in result) return <div className="file-explorer-message" role="alert">
    <p>无法读取文件。{result.error}</p>
    <button type="button" onClick={() => { setResult(undefined); setAttempt(attempt + 1) }}>重试</button>
  </div>

  const file = result.file
  const name = path.split("/").at(-1) ?? path
  switch (file.kind) {
    case "unsupported":
      return <Unavailable name={name} path={path} size={file.size} message={
        file.reason === "size" ? "文件超过预览大小上限。" : "此文件类型无法预览。"
      } />
    case "image":
      return <ImagePreview key={path} name={name} path={path} file={file} />
    case "pdf":
      return <PreviewBoundary fallback={<Unavailable name={name} path={path} size={file.size} message="无法加载 PDF 查看器。" />}>
        <Suspense fallback={<p className="file-explorer-message" role="status">正在加载 PDF 查看器…</p>}>
          <PdfPreview name={name} bytes={file.bytes} renderError={(message) =>
            <Unavailable name={name} path={path} size={file.size} message={message} />} />
        </Suspense>
      </PreviewBoundary>
    case "text": {
      const normalizedName = name.toLowerCase()
      if (/\.(md|markdown|mdown|mkd)$/.test(normalizedName)) {
        return <div className="file-explorer-markdown"><MarkdownContent text={file.text} /></div>
      }
      const originalLanguage = getFiletypeFromFileName(name)
      const lang = originalLanguage === "text" ? getFiletypeFromFileName(normalizedName) : originalLanguage
      if (lang !== "text" && typeof lang === "string") {
        return <PreviewBoundary fallback={<pre className="file-explorer-text">{file.text}</pre>}>
          <File file={{ name, contents: file.text, lang }} options={{ themeType: theme, disableFileHeader: true }} />
        </PreviewBoundary>
      }
      return <pre className="file-explorer-text">{file.text}</pre>
    }
  }
}
