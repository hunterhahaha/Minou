/** 资源查看器标签的树模型、选中文件与分栏状态。 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { FileTree, useFileTree } from "@pierre/trees/react"
import type { FileTreeDirectoryHandle } from "@pierre/trees"
import { IconFile, IconFolder, IconLayoutSidebarRight, IconLayoutSidebarRightCollapse } from "@tabler/icons-react"
import type { FileExplorerRoot } from "../preload/browser-api.ts"
import { FilePreview } from "./file-preview.tsx"
import "./file-explorer.css"

/** 单个已打开的文件资源查看器。 */
interface FileExplorerViewerProps {
  projectId: string
  directories: readonly string[]
  theme: "light" | "dark"
}

/** 预览绑定文件及授予它的根目录句柄。 */
interface SelectedFile {
  directory: string
  handle: string
  path: string
}

/**
 * 渲染项目的只读双栏，切换关联目录时保留分栏状态。
 * @param props 项目、当前关联目录及主题。
 * @returns 左侧文件内容与独立的右侧树面板。
 */
export default function FileExplorerViewer({ projectId, directories, theme }: FileExplorerViewerProps) {
  const [preferredDirectory, setPreferredDirectory] = useState("")
  const directory = directories.includes(preferredDirectory) ? preferredDirectory : directories[0]
  const [selectedFile, setSelectedFile] = useState<SelectedFile>()
  const file = selectedFile?.directory === directory ? selectedFile : undefined
  const [expanded, setExpanded] = useState(true)
  const [preferredWidth, setPreferredWidth] = useState(264)
  const [availableWidth, setAvailableWidth] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; x: number; width: number }>(null)
  const panelId = useId()
  useLayoutEffect(() => {
    setSelectedFile(undefined)
    setPreferredDirectory(directory ?? "")
  }, [directory])

  useEffect(() => {
    const element = body.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setAvailableWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const splitSpace = Math.max(0, availableWidth - 8)
  const minimum = Math.min(152, Math.floor(splitSpace * 0.32))
  const minimumPreviewWidth = Math.min(240, Math.ceil(splitSpace * 0.55))
  const maximum = Math.min(480, splitSpace - minimumPreviewWidth)
  const treeWidth = Math.max(minimum, Math.min(maximum, preferredWidth))
  const panelAction = expanded ? "收起文件树" : "展开文件树"
  const name = file?.path.split("/").at(-1)
  const names = directories.map(directoryName)

  return <section className="file-explorer" aria-label="文件资源查看器">
    <header className="file-explorer-header">
      <div className="file-explorer-heading">
        {file && <IconFile size={16} aria-hidden="true" />}
        <h2 title={file?.path || directory}>{name || "文件预览"}</h2>
        {file?.path.includes("/") && <span title={file.path}>{file.path}</span>}
      </div>
      <button type="button" aria-controls={panelId} aria-expanded={expanded} aria-label={panelAction} title={panelAction}
        onClick={() => setExpanded(!expanded)}>
        {expanded ? <IconLayoutSidebarRightCollapse size={17} /> : <IconLayoutSidebarRight size={17} />}
      </button>
    </header>
    <div className="file-explorer-body" ref={body}>
      <section className="file-explorer-preview" aria-label="文件预览">
        {file ? <FilePreview key={file.path} handle={file.handle} path={file.path} theme={theme} />
          : <div className="file-explorer-empty"><IconFile size={28} stroke={1.4} aria-hidden="true" />
            <p>{directory ? "从文件树选择要查看的文件" : "项目尚未关联文件夹"}</p></div>}
      </section>
      <div className="file-explorer-divider" role="separator" tabIndex={0} hidden={!expanded}
        aria-label="调整文件树宽度" aria-controls={panelId} aria-orientation="vertical"
        aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={treeWidth}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointer: event.pointerId, x: event.clientX, width: treeWidth }
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointer !== event.pointerId) return
          setPreferredWidth(Math.max(minimum, Math.min(maximum, drag.current.width + drag.current.x - event.clientX)))
        }}
        onLostPointerCapture={() => { drag.current = null }}
        onKeyDown={(event) => {
          const width = event.key === "ArrowLeft" ? treeWidth + 16
            : event.key === "ArrowRight" ? treeWidth - 16
              : event.key === "Home" ? minimum : event.key === "End" ? maximum : undefined
          if (width === undefined) return
          event.preventDefault()
          setPreferredWidth(Math.max(minimum, Math.min(maximum, width)))
        }} />
      <aside className="file-explorer-sidebar" id={panelId} aria-label="文件树" hidden={!expanded} style={{ width: treeWidth }}>
        <div className="file-explorer-root" title={directory}>
          <IconFolder size={16} aria-hidden="true" />
          {directories.length > 1
            ? <select aria-label="项目关联文件夹" value={directory} onChange={(event) => setPreferredDirectory(event.target.value)}>
              {directories.map((path, index) => <option key={path} value={path} title={path}>
                {names.indexOf(names[index]) === names.lastIndexOf(names[index]) ? names[index] : path}
              </option>)}
            </select>
            : <h3>{directory ? directoryName(directory) : "项目文件夹"}</h3>}
        </div>
        {directory && <ProjectDirectory key={directory} projectId={projectId} directory={directory} onSelect={setSelectedFile} />}
      </aside>
    </div>
  </section>
}

/** 获取可读的目录名称。 @param path 配置中的目录。 @returns 最后一段路径或根名称。 */
function directoryName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).at(-1) || path
}

/**
 * 管理当前关联目录的读取授权，离开目录时释放句柄。
 * @param props 项目身份、当前目录和选中文件回调。
 * @returns 授权状态或该目录的文件树。
 */
function ProjectDirectory({ projectId, directory, onSelect }: {
  projectId: string; directory: string; onSelect(file: SelectedFile): void
}) {
  const [root, setRoot] = useState<FileExplorerRoot>()
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    let handle: string | undefined
    /** 关闭已经发放的目录句柄。 */
    const release = () => {
      if (handle) void window.nicodeBrowser.closeFileExplorer(handle).catch(console.error)
    }
    void window.nicodeBrowser.openFileExplorer({ projectId, directoryPath: directory }).then((result) => {
      handle = result.handle
      if (current) setRoot(result)
      else release()
    }, (cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      current = false
      release()
    }
  }, [projectId, directory, attempt])

  if (root) return <DirectoryTree root={root} directory={directory} onSelect={onSelect} />
  if (error) return <div className="file-explorer-tree-errors">
    <p role="alert" title={error}>无法打开 {directoryName(directory)}</p>
    <button type="button" onClick={() => { setError(""); setAttempt(attempt + 1) }}>重试</button>
  </div>
  return <p className="file-explorer-tree-status" role="status">正在打开文件夹…</p>
}

/**
 * 通过单个已授权根目录维护一个增量文件树。
 * @param props 读取句柄、配置中的目录及文件选择回调。
 * @returns 文件树和局部读取状态。
 */
function DirectoryTree({ root, directory, onSelect }: {
  root: FileExplorerRoot; directory: string; onSelect(file: SelectedFile): void
}) {
  const [loading, setLoading] = useState(0)
  const [emptyRoot, setEmptyRoot] = useState(false)
  const [errors, setErrors] = useState(new Map<string, string>())
  const mounted = useRef(false)
  const pending = useRef(new Set<string>())
  const loaded = useRef(new Set<string>())
  const unopened = useRef(new Set<string>())
  const { model } = useFileTree({
    paths: [],
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
    onSelectionChange(paths) {
      const path = paths[0]
      if (paths.length === 1 && path && !path.endsWith("/")) onSelect({ directory, handle: root.handle, path })
    },
  })

  /**
   * 读取一个目录的直属条目，并将新路径添加到原树模型。
   * @param branch 带尾斜杠的树路径，空字符串表示根目录。
   */
  const load = useCallback((branch: string): void => {
    if (pending.current.has(branch) || loaded.current.has(branch)) return
    pending.current.add(branch)
    unopened.current.delete(branch)
    setLoading(pending.current.size)
    setErrors((current) => {
      if (!current.has(branch)) return current
      const next = new Map(current)
      next.delete(branch)
      return next
    })
    void window.nicodeBrowser.listExplorerDirectory(root.handle, branch).then((entries) => {
      if (!mounted.current) return
      const additions = entries.map(({ name, kind }) => {
        const path = branch + name + (kind === "directory" ? "/" : "")
        return { type: "add" as const, path }
      })
      if (additions.length) model.batch(additions)
      for (const { path } of additions) {
        if (path.endsWith("/")) unopened.current.add(path)
      }
      loaded.current.add(branch)
      if (branch === "") setEmptyRoot(entries.length === 0)
    }).catch((error: unknown) => {
      if (!mounted.current) return
      const message = error instanceof Error ? error.message : String(error)
      setErrors((current) => new Map(current).set(branch, message))
    }).finally(() => {
      pending.current.delete(branch)
      if (mounted.current) setLoading(pending.current.size)
    })
  }, [model, root.handle])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = model.subscribe(() => {
      // Native tree interactions focus the directory before toggling it.
      const item = model.getFocusedItem()
      if (!item?.isDirectory()) return
      const path = item.getPath()
      if (unopened.current.has(path) && (item as FileTreeDirectoryHandle).isExpanded()) load(path)
    })
    load("")
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [load, model])

  return <>
    {loading > 0 && <p className="file-explorer-tree-status" role="status">正在读取目录…</p>}
    {emptyRoot && <p className="file-explorer-tree-status">此文件夹为空。</p>}
    {errors.size > 0 && <div className="file-explorer-tree-errors">
      {[...errors].map(([path, error]) => <div key={path}>
        <p role="alert" title={error}>无法读取 {path || root.name}</p>
        <button type="button" aria-label={`重试读取 ${path || root.name}`} onClick={() => load(path)}>重试</button>
      </div>)}
    </div>}
    <FileTree className="file-explorer-tree" model={model} />
  </>
}
