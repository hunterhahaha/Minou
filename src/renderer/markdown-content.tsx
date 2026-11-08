/** Assistant 正文的 Markdown 展示组件；过程详情由页面直接展示原文。 */
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/** Markdown 展示输入；原始文本由事件投影提供。 */
export interface MarkdownContentProps {
  /** 当前内容块的完整 Markdown 文本，允许为空或仍在流式更新。 */
  text: string
  /** 在当前对话的内置浏览器打开绝对 HTTP(S) 地址。 */
  onOpenWeb?(url: string): void
}

const fileComponents = {
  a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
}

/**
 * 将当前文本同步转换为 React Markdown 标签，包含 GFM 表格、任务列表与删除线。
 * 未提供网页打开回调时，以静态方式预览本地文件，保留链接文字与图片说明。
 * @param props 原始 Markdown 文本与网页打开回调。
 * @returns 使用局部样式容器包裹的 Markdown 内容；空文本生成空容器。
 */
export function MarkdownContent({ text, onOpenWeb }: MarkdownContentProps) {
  return <div className="markdown-content" onClick={(event) => {
    if (!onOpenWeb || event.defaultPrevented || !(event.target instanceof Element)) return
    const href = event.target.closest("a[href]")?.getAttribute("href")
    const url = href ? URL.parse(href) : null
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return
    event.preventDefault()
    onOpenWeb(url.href)
  }}><ReactMarkdown remarkPlugins={[remarkGfm]} components={onOpenWeb ? undefined : fileComponents}>{text}</ReactMarkdown></div>
}
