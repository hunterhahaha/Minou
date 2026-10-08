/** Assistant 正文与思考内容共用的 Markdown 展示组件。 */
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/** Markdown 展示输入；原始文本由事件投影提供。 */
export interface MarkdownContentProps {
  /** 当前内容块的完整 Markdown 文本，允许为空或仍在流式更新。 */
  text: string
}

/**
 * 将当前文本同步转换为 React Markdown 标签，包含 GFM 表格、任务列表与删除线。
 * 文本变化时重新解析；沿用库默认的 HTML 转义与 URL 处理，不改写来源内容。
 * @param props 原始 Markdown 文本。
 * @returns 使用局部样式容器包裹的 Markdown 内容；空文本生成空容器。
 */
export function MarkdownContent({ text }: MarkdownContentProps) {
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
}
