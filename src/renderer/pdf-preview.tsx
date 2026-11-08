/** 使用随应用打包的 PDF.js 解码资源和 Worker 渲染本地 PDF。 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { AnnotationMode, getDocument, PDFWorker, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist"
import PdfDecoder from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline"

const bundledAssets = import.meta.glob<string>([
  "../../node_modules/pdfjs-dist/cmaps/*.bcmap",
  "../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
  "../../node_modules/pdfjs-dist/wasm/{jbig2,openjpeg,qcms_bg}.wasm",
], { eager: true, import: "default", query: "?url&inline" })

const assetFolders: Readonly<Record<string, string>> = {
  cMapUrl: "cmaps",
  standardFontDataUrl: "standard_fonts",
  wasmUrl: "wasm",
}

/** 只从打包时已知的资源表取字节，兼容桌面 file:// 页面及离线环境。 */
class PdfAssets {
  /**
   * 查找 PDF.js 请求的内置解码资产。
   * @param request 资源类别及 PDF.js 要求的文件名。
   * @returns 新的二进制缓冲区，供 Worker 使用。
   * @throws Error 当请求的资源未打包时抛出。
   */
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array<ArrayBuffer>> {
    const folder = assetFolders[kind]
    const asset = bundledAssets[`../../node_modules/pdfjs-dist/${folder}/${filename}`]
    if (!asset?.startsWith("data:") || !filename || /[/\\]/.test(filename)) {
      throw new Error("缺少 PDF 解码资源")
    }
    const contents = atob(asset.slice(asset.indexOf(",") + 1))
    return Uint8Array.from(contents, (character) => character.charCodeAt(0))
  }
}

/** 单个 PDF 的来源和复用的错误详情。 */
interface PdfPreviewProps {
  name: string
  bytes: Uint8Array<ArrayBuffer>
  renderError(message: string): ReactNode
}

/**
 * 将当前页绘制到有界画布，切换文件时销毁文档任务与专用 Worker。
 * @param props 文件名、原始字节与错误展示回调。
 * @returns 单页预览和翻页控件。
 */
export default function PdfPreview({ name, bytes, renderError }: PdfPreviewProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>()
  const [page, setPage] = useState(1)
  const [paintedPage, setPaintedPage] = useState(0)
  const [error, setError] = useState("")
  const [width, setWidth] = useState(0)
  const pageArea = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let active = true
    let port: Worker | undefined
    let worker: PDFWorker | undefined
    let task: ReturnType<typeof getDocument> | undefined
    let crashed = false
    const stop = () => {
      worker?.destroy()
      port?.terminate()
      worker = undefined
      port = undefined
    }
    try {
      port = new PdfDecoder()
      port.addEventListener("error", () => {
        crashed = true
        stop()
        if (active) setError("PDF 解码进程已停止。")
      }, { once: true })
      worker = PDFWorker.create({ port })
      task = getDocument({
        data: bytes.slice(),
        worker,
        BinaryDataFactory: PdfAssets,
        useWorkerFetch: false,
        disableWorkerRendering: true,
        maxImageSize: 16 * 1024 * 1024,
        canvasMaxAreaInBytes: 32 * 1024 * 1024,
      })
      void task.promise.then(
        (document) => { if (active) setPdf(document) },
        (reason: unknown) => {
          if (!active) return
          setError(reason instanceof Error && reason.name === "PasswordException"
            ? "此 PDF 需要密码。" : "无法打开此 PDF。")
        },
      )
    } catch {
      setError("无法启动 PDF 查看器。")
    }
    return () => {
      active = false
      if (crashed || !task) { stop(); return }
      // Give PDF.js a chance to release the document before terminating a stalled decoder.
      const deadline = window.setTimeout(stop, 1000)
      void task.destroy().catch(() => {}).finally(() => {
        window.clearTimeout(deadline)
        stop()
      })
    }
  }, [bytes])

  useEffect(() => {
    const element = pageArea.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.floor(entry.contentRect.width)
      if (measured > 0) setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [pdf])

  useEffect(() => {
    const surface = canvas.current
    if (!pdf || !width || !surface) return
    let active = true
    let rendering: RenderTask | undefined
    void pdf.getPage(page).then((current) => {
      if (!active) return
      const original = current.getViewport({ scale: 1 })
      const displayScale = Math.min(width / original.width, 1.5)
      const scale = Math.min(displayScale * devicePixelRatio,
        8192 / Math.max(original.width, original.height),
        Math.sqrt(8 * 1024 * 1024 / (original.width * original.height)))
      const viewport = current.getViewport({ scale })
      surface.width = Math.max(1, Math.floor(viewport.width))
      surface.height = Math.max(1, Math.floor(viewport.height))
      surface.style.width = `${Math.max(1, Math.floor(original.width * displayScale))}px`
      rendering = current.render({ canvas: surface, viewport, annotationMode: AnnotationMode.DISABLE })
      return rendering.promise.then(() => { if (active) setPaintedPage(page) })
    }).catch(() => { if (active) setError("无法渲染此 PDF 页面。") })
    return () => {
      active = false
      rendering?.cancel()
    }
  }, [page, pdf, width])

  if (error) return renderError(error)
  if (!pdf) return <p className="file-explorer-message" role="status">正在读取 PDF…</p>
  return <div className="file-explorer-pdf">
    <div className="file-explorer-pdf-controls" aria-label="PDF 分页" role="group">
      <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
      <span aria-live="polite">{page} / {pdf.numPages}</span>
      <button type="button" disabled={page === pdf.numPages} onClick={() => setPage(page + 1)}>下一页</button>
    </div>
    <div className="file-explorer-pdf-page" ref={pageArea}>
      {paintedPage !== page && <p role="status">正在渲染第 {page} 页…</p>}
      <canvas key={page} ref={canvas} aria-label={`${name}，第 ${page} 页`} role="img" hidden={paintedPage !== page} />
    </div>
  </div>
}
