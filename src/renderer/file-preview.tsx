/** 根据主进程返回的内容显示单个文件的只读预览。 */
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react"
import { getFiletypeFromFileName } from "@pierre/diffs"
import { File } from "@pierre/diffs/react"
import type { FileExplorerFile } from "../preload/browser-api.ts"
import { MarkdownContent } from "./markdown-content.tsx"

const PdfPreview = lazy(() => import("./pdf-preview.tsx"))

/** 当前预览的读取结果。 */
type PreviewResult = { file: FileExplorerFile } | { error: string }

/** 正在查看的文件及其当前主题。 */
interface FilePreviewProps {
  handle: string
  path: string
  theme: "light" | "dark"
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
export function FilePreview({ handle, path, theme }: FilePreviewProps) {
  const [result, setResult] = useState<PreviewResult>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void window.nicodeBrowser.readExplorerFile(handle, path).then(
      (file) => { if (active) setResult({ file }) },
      (error: unknown) => { if (active) setResult({ error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { active = false }
  }, [handle, path, attempt])

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
