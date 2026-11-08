/** 只读文件查看器的目录授权与受限读取。 */
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { basename, extname, isAbsolute, join, parse, relative, sep } from "node:path"
import type { IpcMain, WebContents } from "electron"
import { requireProjectId } from "../../runtime/session/src/project-id.ts"
import type { FileReference, MessageFileReference } from "../../runtime/session/src/events.ts"
import { bundledRipgrepPath, runRipgrep } from "../../runtime/tools/src/filesystem/index.ts"
import { FILE_EXPLORER_CHANNELS, type FileExplorerEntry, type FileExplorerFile, type FileExplorerRoot } from "../preload/browser-api.ts"
import { readProjectWorkspace } from "./workspace-store.ts"

const MiB = 1024 * 1024
const imageTypes: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".bmp", "image/bmp"],
  [".avif", "image/avif"], [".ico", "image/x-icon"],
])

/** 已授权的真实目录及其文件系统身份，用于拒绝被替换的根目录。 */
interface DirectoryGrant {
  path: string
  projectId: string
  directoryPath: string
  dev: bigint
  ino: bigint
}

/**
 * 读取配置中根目录的真实路径及文件系统身份。
 * @param projectId 所属项目。
 * @param directoryPath 项目配置中的关联路径。
 * @returns 可用于安全解析的目录授权。
 * @throws Error 当目录不存在或不是目录时抛出。
 */
async function directoryGrant(projectId: string, directoryPath: string): Promise<DirectoryGrant> {
  const path = await realpath(directoryPath)
  const state = await lstat(path, { bigint: true })
  if (!state.isDirectory()) throw new Error("所选路径不是目录")
  return { path, projectId, directoryPath, dev: state.dev, ino: state.ino }
}

/**
 * 判断绝对路径是否处于根内，允许根本身。
 * @param root 基准目录。
 * @param target 待检查路径。
 * @returns 路径是否在根内。
 */
function contains(root: string, target: string): boolean {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep)
}

/**
 * 检查可用于树路径的单个实际文件名。
 * @param name 文件系统名称或请求中的路径片段。
 * @returns 名称是否能无歧义地传入树模型及文件系统。
 */
function isEntryName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name)
    && (process.platform !== "win32" || (!name.includes(":") && !/[. ]$/.test(name)))
}

/**
 * 验证根身份与相对路径，避免沿链接读取，并确认目标类型。
 * @param root 主进程保存的目录授权。
 * @param value 根目录相对路径，目录可带末尾斜杠。
 * @param kind 所需的目标类型。
 * @returns 真实绝对路径及校验时的文件系统状态。
 * @throws Error 当路径越界、失效或与指定类型不符时抛出。
 */
async function resolveEntry(root: DirectoryGrant, value: unknown, kind: FileExplorerEntry["kind"]) {
  if (typeof value !== "string") throw new TypeError("文件路径必须是字符串")
  const path = kind === "directory" && value.endsWith("/") ? value.slice(0, -1) : value
  if ((path === "" && value !== "") || (path === "" && kind === "file")
    || isAbsolute(path) || (path !== "" && !path.split("/").every(isEntryName))) {
    throw new Error("无效的文件资源路径")
  }
  const rootState = await lstat(root.path, { bigint: true })
  if (!rootState.isDirectory() || rootState.dev !== root.dev || rootState.ino !== root.ino
    || relative(root.path, await realpath(root.path)) !== "") {
    throw new Error("根目录已更改，请重新打开文件夹")
  }
  const target = join(root.path, ...path.split("/"))
  const state = await lstat(target, { bigint: true })
  if (kind === "directory" ? !state.isDirectory() : !state.isFile()) {
    throw new Error("文件资源已更改或不支持查看")
  }
  const actual = await realpath(target)
  if (!contains(root.path, actual) || relative(target, actual) !== "") {
    throw new Error("文件资源路径包含链接或超出根目录")
  }
  return { path: actual, state }
}

/**
 * 验证消息中引用的项目、文件及其在原文中的位置，返回规范元数据。
 * @param databasePath 工作区数据库。
 * @param projectId 当前会话所属项目。
 * @param text 完整的首个消息文本块。
 * @param value IPC 附带的引用数组。
 * @returns 可写入用户事件的有序引用。
 * @throws Error 当引用与文本、目录授权或真实文件不一致时抛出。
 */
export async function validateMessageFileReferences(databasePath: string, projectId: string, text: string, value: unknown): Promise<MessageFileReference[]> {
  if (projectId === "default" || !Array.isArray(value) || value.length === 0) throw new Error("无效的项目文件引用")
  const directories = readProjectWorkspace(databasePath, projectId).directories
  const roots = new Map<string, DirectoryGrant>()
  const validated: MessageFileReference[] = []
  let end = 0
  for (const item of value) {
    if (!item || typeof item !== "object" || item.projectId !== projectId || typeof item.directoryPath !== "string" || !directories.includes(item.directoryPath)
      || typeof item.relativePath !== "string" || typeof item.absolutePath !== "string"
      || !Number.isSafeInteger(item.offset) || item.offset < end || !text.startsWith(item.absolutePath, item.offset)) {
      throw new Error("文件引用不属于当前项目或与消息正文不符")
    }
    let root = roots.get(item.directoryPath)
    if (!root) {
      root = await directoryGrant(projectId, item.directoryPath)
      roots.set(item.directoryPath, root)
    }
    const { path } = await resolveEntry(root, item.relativePath, "file")
    if (path !== item.absolutePath) throw new Error("文件引用的绝对路径已更改")
    validated.push({ projectId, directoryPath: root.directoryPath, relativePath: item.relativePath,
      absolutePath: path, name: basename(path), offset: item.offset })
    end = item.offset + path.length
  }
  const current = readProjectWorkspace(databasePath, projectId).directories
  if ([...roots.keys()].some((directory) => !current.includes(directory))) throw new Error("引用文件的目录已取消项目关联")
  return validated
}

/**
 * 从已校验的普通文件读取有界快照，超过上限时仅返回元数据。
 * @param root 文件所属根目录。
 * @param value 文件的根目录相对路径。
 * @param absolutePath 引用保存的绝对路径，存在时必须与当前目标一致。
 * @returns 文本、已知媒体字节或仅含元数据的结果。
 * @throws Error 当文件无法打开、读取或在打开时已替换时抛出。
 */
async function readPreview(root: DirectoryGrant, value: unknown, absolutePath: unknown): Promise<FileExplorerFile> {
  const { path, state } = await resolveEntry(root, value, "file")
  if (absolutePath !== undefined && absolutePath !== path) throw new Error("引用文件的绝对路径已更改")
  const extension = extname(path).toLowerCase()
  const mimeType = imageTypes.get(extension)
  const limit = extension === ".pdf" ? 32 * MiB : mimeType ? 16 * MiB : MiB
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const file = await open(path, flags)
  try {
    const current = await file.stat({ bigint: true })
    if (!current.isFile() || current.dev !== state.dev || current.ino !== state.ino) {
      throw new Error("文件在打开时已更改，请重试")
    }
    const size = Number(current.size)
    if (current.size > BigInt(limit)) return { size, kind: "unsupported", reason: "size" }
    const bytes = new Uint8Array(size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length !== size) throw new Error("文件在读取时已更改，请重试")
    const content = bytes.subarray(0, length)
    if (extension === ".pdf") return { size, kind: "pdf", bytes: content }
    if (mimeType) return { size, kind: "image", mimeType, bytes: content }
    try {
      const encoding = content[0] === 0xff && content[1] === 0xfe ? "utf-16le"
        : content[0] === 0xfe && content[1] === 0xff ? "utf-16be" : "utf-8"
      const text = new TextDecoder(encoding, { fatal: true }).decode(content)
      if (!/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) return { size, kind: "text", text }
    } catch {
      // Invalid Unicode is displayed as an unsupported file.
    }
    return { size, kind: "unsupported", reason: "binary" }
  } finally {
    await file.close()
  }
}

/**
 * 注册可信主窗口使用的文件查看器 IPC。窗口更换主文档时撤销其目录授权。
 * @param ipc 已限制来源的主进程 IPC。
 * @param workspaceDatabasePath 当前工作区数据库。
 * @param rgPath 应用已安装的文件枚举程序路径。
 */
export function registerFileExplorerIpc(
  ipc: Pick<IpcMain, "handle">,
  workspaceDatabasePath: string,
  rgPath?: string,
): void {
  const windows = new WeakMap<WebContents, Map<string, DirectoryGrant>>()
  const registered = new WeakSet<WebContents>()
  const searches = new WeakMap<WebContents, AbortController>()

  ipc.handle(FILE_EXPLORER_CHANNELS.search, async ({ sender }, rawProjectId: unknown, rawQuery: unknown): Promise<FileReference[]> => {
    const projectId = requireProjectId(rawProjectId)
    if (typeof rawQuery !== "string" || rawQuery.length > 4096) throw new TypeError("无效的文件搜索词")
    if (projectId === "default") return []
    searches.get(sender)?.abort()
    const search = new AbortController()
    searches.set(sender, search)
    const signal = AbortSignal.any([search.signal, AbortSignal.timeout(5000)])
    const query = rawQuery.replaceAll("\\", "/").toLowerCase()
    const results = new Map<string, FileReference>()
    let rootCount = 0
    let rootError: unknown
    try {
      for (const directory of readProjectWorkspace(workspaceDatabasePath, projectId).directories) {
        signal.throwIfAborted()
        let root: DirectoryGrant
        try { root = await directoryGrant(projectId, directory) }
        catch (error) { rootError = error; continue }
        rootCount++
        const candidates: string[] = []
        await runRipgrep(rgPath ?? bundledRipgrepPath(process.cwd()), ["--no-config", "--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "--", root.path], signal, (path) => {
          const local = relative(root.path, path).split(sep).join("/")
          if (local.toLowerCase().includes(query)) candidates.push(local)
          return candidates.length < 40
        })
        for (const local of candidates) {
          signal.throwIfAborted()
          try {
            const { path } = await resolveEntry(root, local, "file")
            if (!results.has(path)) results.set(path, { projectId, directoryPath: directory, relativePath: local, absolutePath: path, name: basename(path) })
          } catch { /* 文件在搜索期间失效时跳过。 */ }
          if (results.size >= 30) break
        }
        if (results.size >= 30) break
      }
      if (!rootCount && rootError) throw rootError
      const current = readProjectWorkspace(workspaceDatabasePath, projectId).directories
      return [...results.values()].filter((file) => current.includes(file.directoryPath))
    } catch (error) {
      if (search.signal.aborted) return []
      throw error
    } finally {
      if (searches.get(sender) === search) searches.delete(sender)
    }
  })

  /**
   * 查找发起窗口仍持有的目录授权。
   * @param sender 发起请求的主窗口 WebContents。
   * @param handle 主进程发放的读取句柄。
   * @returns 根目录授权。
   * @throws Error 当句柄不存在或属于其他窗口时抛出。
   */
  function grantFor(sender: WebContents, handle: unknown): DirectoryGrant {
    const grant = typeof handle === "string" ? windows.get(sender)?.get(handle) : undefined
    if (!grant) throw new Error("目录访问已失效，请重新打开文件夹")
    if (!readProjectWorkspace(workspaceDatabasePath, grant.projectId).directories.includes(grant.directoryPath)) {
      if (typeof handle === "string") windows.get(sender)?.delete(handle)
      throw new Error("此目录已取消项目关联")
    }
    return grant
  }

  ipc.handle(FILE_EXPLORER_CHANNELS.open, async ({ sender }, source: unknown): Promise<FileExplorerRoot> => {
    if (source === null || typeof source !== "object" || !("projectId" in source) || !("directoryPath" in source)
      || typeof source.directoryPath !== "string" || !isAbsolute(source.directoryPath)) {
      throw new Error("请提供项目及关联目录")
    }
    const projectId = requireProjectId(source.projectId)
    const selected = source.directoryPath
    const directoryPath = readProjectWorkspace(workspaceDatabasePath, projectId).directories
      .find((directory) => relative(directory, selected) === "")
    if (directoryPath === undefined) throw new Error("只能打开项目关联目录")

    if (!registered.has(sender)) {
      registered.add(sender)
      sender.on("did-start-navigation", (details, _url, isSameDocument, isMainFrame) => {
        if ((details.isMainFrame ?? isMainFrame) && !(details.isSameDocument ?? isSameDocument)) windows.delete(sender)
      })
      sender.on("render-process-gone", () => windows.delete(sender))
      sender.once("destroyed", () => windows.delete(sender))
    }
    let grants = windows.get(sender)
    if (!grants) windows.set(sender, grants = new Map())
    const grant = await directoryGrant(projectId, directoryPath)
    if (windows.get(sender) !== grants) throw new Error("文件夹打开请求已失效")
    if (!readProjectWorkspace(workspaceDatabasePath, projectId).directories.includes(directoryPath)) {
      throw new Error("此目录已取消项目关联")
    }
    const handle = randomUUID()
    grants.set(handle, grant)
    return { handle, path: grant.path, name: basename(grant.path) || parse(grant.path).root }
  })

  ipc.handle(FILE_EXPLORER_CHANNELS.list, async ({ sender }, handle: unknown, value: unknown): Promise<FileExplorerEntry[]> => {
    const root = grantFor(sender, handle)
    const { path } = await resolveEntry(root, value, "directory")
    const entries = await readdir(path, { withFileTypes: true })
    await resolveEntry(root, value, "directory")
    grantFor(sender, handle)
    return entries.flatMap((entry): FileExplorerEntry[] =>
      isEntryName(entry.name) && (entry.isDirectory() || entry.isFile())
        ? [{ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }]
        : [])
  })

  ipc.handle(FILE_EXPLORER_CHANNELS.read, async ({ sender }, handle: unknown, value: unknown, absolutePath: unknown) => {
    const file = await readPreview(grantFor(sender, handle), value, absolutePath)
    grantFor(sender, handle)
    return file
  })
  ipc.handle(FILE_EXPLORER_CHANNELS.close, ({ sender }, handle: unknown) => {
    if (typeof handle === "string") windows.get(sender)?.delete(handle)
  })
}
