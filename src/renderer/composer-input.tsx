/** 首页与会话页共用的结构化 Composer。 */
import { Editor, Node, type JSONContent } from "@tiptap/core"
import { EditorState } from "@tiptap/pm/state"
import { StarterKit } from "@tiptap/starter-kit"
import { IconFile } from "@tabler/icons-react"
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { FileReference } from "../../runtime/session/src/events.ts"
import { emptyComposerDocument } from "./composer-message.ts"

const referenceAttributes = {
  projectId: "data-project-id",
  directoryPath: "data-directory-path",
  relativePath: "data-relative-path",
  absolutePath: "data-absolute-path",
  name: "data-file-name",
} as const

/**
 * 从剪贴板 HTML 或点击的 Chip 中读取结构化属性。路径授权仍由主进程检查。
 * @param element 文件引用元素。
 * @returns 完整引用或 null。
 */
function readReference(element: Element): FileReference | null {
  const { projectId, directoryPath, relativePath, absolutePath, name } = referenceAttributes
  const values = [projectId, directoryPath, relativePath, absolutePath, name].map((attribute) => element.getAttribute(attribute))
  const [project, directory, relative, absolute, label] = values
  return project && directory && relative && absolute && label
    ? { projectId: project, directoryPath: directory, relativePath: relative, absolutePath: absolute, name: label }
    : null
}

/** 原子的行内节点，复制到 Composer 外时使用绝对路径。 */
const FileReferenceNode = Node.create({
  name: "fileReference",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return Object.fromEntries(Object.entries(referenceAttributes).map(([key, attribute]) => [key, {
      renderHTML: (attrs: Record<string, string>) => ({ [attribute]: attrs[key] }),
    }]))
  },

  parseHTML() {
    return [{ tag: "button[data-file-reference]", getAttrs: (element) => readReference(element) ?? false }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["button", {
      ...HTMLAttributes, type: "button", class: "file-reference-chip", contenteditable: "false",
      "data-file-reference": "", title: node.attrs.absolutePath,
      "aria-label": "预览 " + node.attrs.name,
    }, node.attrs.name]
  },

  renderText({ node }) { return node.attrs.absolutePath },
})

const extensions = [StarterKit.configure({
  blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false,
  heading: false, horizontalRule: false, italic: false, link: false, listItem: false,
  listKeymap: false, orderedList: false, strike: false, trailingNode: false, underline: false,
}), FileReferenceNode]
const noFiles: readonly FileReference[] = []

/** 光标前可被文件引用替换的文档位置。 */
interface Mention {
  from: number
  to: number
  query: string
}

/**
 * 读取光标所在文本节点末尾的 @ 查询，避免选区和电子邮箱触发。
 * @param editor 当前编辑器。
 * @returns 菜单对应的文本范围，或 null。
 */
function findMention(editor: Editor): Mention | null {
  const { $from, empty } = editor.state.selection
  if (!empty || !$from.nodeBefore?.isText) return null
  const match = /(?:^|[^a-zA-Z0-9._%+@-])@([^@\s]*)$/.exec($from.nodeBefore.text ?? "")
  if (!match) return null
  return { from: $from.pos - match[1].length - 1, to: $from.pos, query: match[1] }
}

/** 父页面持有草稿、发送状态和对应的浏览器标签管理器。 */
interface ComposerInputProps {
  value?: JSONContent
  projectId: string
  label: string
  placeholder: string
  inputRef?: RefObject<HTMLElement | null>
  onChange(document: JSONContent): void
  onSend(): void
  onOpenFile(reference: FileReference): void
}

/** 文件菜单的异步响应绑定查询范围，避免选中旧结果。 */
interface FileSearchResult {
  mention: Mention
  files: FileReference[]
  error?: string
}

/**
 * 挂载 Tiptap，使用原有 Enter 发送与 Shift+Enter 换行，并在光标处提供文件引用。
 * @param props 会话草稿、项目上下文和页面操作。
 * @returns 文本编辑区及当前 @ 查询菜单。
 */
export function ComposerInput(props: ComposerInputProps) {
  const { projectId, inputRef, label, placeholder, value } = props
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor>(null)
  const published = useRef(value)
  const [mention, setMention] = useState<Mention | null>(null)
  const dismissed = useRef<Mention>(null)
  const [result, setResult] = useState<FileSearchResult>()
  const [active, setActive] = useState(0)
  const listId = useId()
  const settled = result?.mention === mention
  const files = settled ? result.files : noFiles
  const current = useRef({ ...props, mention, files, active, settled })
  useLayoutEffect(() => { current.current = { ...props, mention, files, active, settled } })

  /**
   * 用一个原子节点和空格替换当前 @ 查询，保持后续输入的位置。
   * @param reference 选中的已验证文件。
   */
  function insertReference(reference: FileReference): void {
    const editor = editorRef.current
    if (!editor || editor.view.composing) return
    const range = findMention(editor)
    const expected = current.current.mention
    if (!range || range.from !== expected?.from || range.to !== expected.to || range.query !== expected.query) return
    editor.chain().focus().insertContentAt(range, [
      { type: "fileReference", attrs: reference },
      { type: "text", text: " " },
    ]).run()
    setMention(null)
  }

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    let compositionFrame = 0

    /**
     * 只跟踪当前编辑位置。Escape 关闭后，同一查询在光标或文本变化前保持关闭。
     * @param editor 当前编辑器实例。
     */
    function updateMention(editor: Editor): void {
      const { dom, composing } = editor.view
      const next = dom.ownerDocument.activeElement === dom && !composing ? findMention(editor) : null
      const previous = dismissed.current
      if (next && previous?.from === next.from && previous.to === next.to && previous.query === next.query) return
      dismissed.current = null
      setMention((existing) => existing?.from === next?.from && existing?.to === next?.to && existing?.query === next?.query ? existing : next)
    }

    const editor = new Editor({
      element,
      extensions,
      content: published.current ?? emptyComposerDocument,
      coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: "\n" } },
      editorProps: {
        attributes: { class: "composer-editor", role: "textbox", "aria-multiline": "true", "aria-label": label },
        handleDOMEvents: {
          keydown(view, event) {
            // 组合输入由 Chromium 处理，跳过编辑器快捷键而不取消原生按键。
            return event.isComposing || view.composing || event.keyCode === 229
          },
          compositionend() {
            cancelAnimationFrame(compositionFrame)
            compositionFrame = requestAnimationFrame(() => updateMention(editor))
            return false
          },
          click(_view, event) {
            const chip = event.target instanceof Element && event.target.closest("button[data-file-reference]")
            const reference = chip ? readReference(chip) : null
            if (!reference || reference.projectId !== projectId) return false
            current.current.onOpenFile(reference)
            return true
          },
        },
        handleKeyDown(view, event) {
          if (event.target !== view.dom) return false
          const { mention, files, active, settled } = current.current
          if (mention && event.key === "Escape") {
            dismissed.current = mention
            setMention(null)
            event.stopPropagation()
            return true
          }
          if (mention && files.length && (event.key === "ArrowDown" || event.key === "ArrowUp")
            && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            setActive((index) => (index + (event.key === "ArrowDown" ? 1 : files.length - 1)) % files.length)
            return true
          }
          if (event.key !== "Enter" || event.shiftKey) return false
          if (mention && files[active]) insertReference(files[active])
          else if (!mention || projectId === "default" || settled) current.current.onSend()
          return true
        },
      },
      onTransaction({ editor }) { updateMention(editor) },
      onUpdate({ editor }) {
        published.current = editor.getJSON()
        current.current.onChange(published.current)
      },
      onBlur() { setMention(null) },
    })
    editorRef.current = editor
    if (inputRef) inputRef.current = editor.view.dom
    return () => {
      cancelAnimationFrame(compositionFrame)
      if (inputRef) inputRef.current = null
      editorRef.current = null
      editor.destroy()
    }
  }, [inputRef, label, projectId])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor || value === published.current) return
    published.current = value
    const { schema, plugins } = editor.state
    editor.view.updateState(EditorState.create({ schema, plugins, doc: schema.nodeFromJSON(value ?? emptyComposerDocument) }))
    dismissed.current = null
    setMention(null)
  }, [value])

  useEffect(() => {
    setActive(0)
    if (!mention || projectId === "default") return
    let latest = true
    const timer = setTimeout(() => {
      void window.minouBrowser.searchProjectFiles(projectId, mention.query).then(
        (files) => { if (latest) setResult({ mention, files }) },
        (error: unknown) => { if (latest) setResult({ mention, files: [], error: error instanceof Error ? error.message : String(error) }) },
      )
    }, 100)
    return () => { latest = false; clearTimeout(timer) }
  }, [mention, projectId])

  useLayoutEffect(() => {
    const dom = editorRef.current?.view.dom
    if (!dom) return
    dom.setAttribute("aria-placeholder", placeholder)
    if (mention) dom.setAttribute("aria-controls", listId)
    else dom.removeAttribute("aria-controls")
    if (files[active]) {
      const id = listId + "-" + active
      dom.setAttribute("aria-activedescendant", id)
      document.getElementById(id)?.scrollIntoView({ block: "nearest" })
    } else dom.removeAttribute("aria-activedescendant")
  }, [active, files, listId, mention, placeholder])

  const empty = !value?.content?.some((block) => block.content?.length) && (value?.content?.length ?? 1) === 1
  return <div className="composer-input">
    <div ref={host} data-empty={empty} data-placeholder={placeholder} />
    {mention && <div className="composer-file-menu">
      <div id={listId} role="listbox" aria-label="项目文件">
        {files.map((file, index) => <button key={file.absolutePath} id={listId + "-" + index} role="option" aria-selected={index === active}
          type="button" tabIndex={-1} title={file.absolutePath} onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(index)} onClick={() => insertReference(file)}>
          <IconFile size={16} aria-hidden="true" /><span><strong>{file.name}</strong>
            <small>{[file.directoryPath.split(/[/\\]/).filter(Boolean).at(-1), ...file.relativePath.split("/").slice(0, -1)].filter(Boolean).join("/")}</small></span>
        </button>)}
      </div>
      {!files.length && <p role="status" title={result?.mention === mention ? result.error : undefined}>
        {projectId === "default" ? "当前对话没有关联目录" : result?.mention !== mention ? "正在查找文件…"
          : result.error ? "无法搜索项目文件" : "没有找到匹配的文件"}
      </p>}
    </div>}
  </div>
}
