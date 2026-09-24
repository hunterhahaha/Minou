/** 目录选择与 Project 配置变更的主进程 IPC。 */

import { randomUUID } from "node:crypto"
import { mkdir, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from "node:path"

import { requireProjectId } from "../../runtime/session/src/project-id.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import type { IpcMainHandlePort } from "./session-ipc.ts"
import { insertProjectWorkspace, readProjectWorkspace, saveProjectWorkspace } from "./workspace-store.ts"
import { PROJECT_IPC_CHANNELS } from "../preload/session-api.ts"
import type { DirectorySelection, ProjectDirectoryResult, ProjectSummary } from "../preload/session-api.ts"

/** Electron 目录选择窗口的最小可测试端口。 */
export interface DirectoryDialogPort {
  /**
   * 打开仅允许选择一个目录的系统窗口。
   * @param options 仅启用目录选择的窗口配置。
   * @returns 用户是否取消及选择的路径。
   */
  showOpenDialog(options: { properties: ["openDirectory"] }): Promise<{
    canceled: boolean
    filePaths: string[]
  }>
}

/**
 * 检查目录是现存的绝对路径，并统一路径的分隔符和尾部分隔符。
 * @param value Renderer 传入的路径。
 * @returns 规范化的绝对目录路径。
 * @throws Error 当路径无效、缺失或不是目录时抛出。
 */
async function requireDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError("关联目录必须是绝对路径")
  }
  const path = normalize(value)
  const state = await stat(path).catch((error: unknown) => {
    throw new Error(`无法检查关联目录：${path}`, { cause: error })
  })
  if (!state.isDirectory()) throw new TypeError(`路径不是目录：${path}`)
  return path
}

/**
 * 使用当前平台的路径大小写规则比较目录。
 * @param path 已规范化的绝对路径。
 * @returns 用于查重的键。
 */
function directoryKey(path: string): string {
  const normalized = normalize(path)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/**
 * 将工作区配置转为现有页面 Project 摘要。
 * @param project 已保存的 Project。
 * @returns 可由 IPC 结构化克隆的页面数据。
 */
function summarizeProject(project: ReturnType<typeof readProjectWorkspace>): ProjectSummary {
  return {
    projectId: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    directories: project.directories,
    sessions: project.sessions.map((session) => ({
      sessionId: session.id,
      name: session.name,
      updatedAt: session.updatedAt,
    })),
  }
}

/**
 * 将 Project 目录操作的异常转换为页面可显示的失败结果。
 * @param operation 一次目录变更。
 * @returns 成功确认或包含原因的失败结果。
 */
async function directoryResult(operation: () => Promise<void>): Promise<ProjectDirectoryResult> {
  try {
    await operation()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 注册目录选择、项目创建和目录关联变更的四个 IPC handler。
 * @param ipcMain 主进程 IPC 注册端口。
 * @param dialog 系统目录选择窗口端口。
 * @param paths 启动时已初始化的配置路径。
 * @throws Error 当 channel 已注册时由 IPC 实现抛出；请求错误由各 handler 处理。
 */
export function registerProjectIpcHandlers(
  ipcMain: IpcMainHandlePort,
  dialog: DirectoryDialogPort,
  paths: Pick<ConfigFilePaths, "rootDir" | "workspaceDatabasePath">,
): void {
  ipcMain.handle(PROJECT_IPC_CHANNELS.selectDirectory, async (): Promise<DirectorySelection | null> => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] })
    if (result.canceled) return null
    const selected = result.filePaths[0]
    if (selected === undefined) throw new Error("目录选择窗口没有返回路径")
    const path = await requireDirectory(selected)
    return { path, name: basename(path) || parse(path).root }
  })

  ipcMain.handle(PROJECT_IPC_CHANNELS.createProject, async (_event, name: unknown, directories?: unknown): Promise<ProjectSummary> => {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("项目名称必须是非空字符串")
    }
    if (directories !== undefined && !Array.isArray(directories)) {
      throw new TypeError("关联目录必须是字符串数组")
    }
    const checkedDirectories: string[] = []
    const seen = new Set<string>()
    for (const value of directories ?? []) {
      const directory = await requireDirectory(value)
      const key = directoryKey(directory)
      if (seen.has(key)) throw new Error(`关联目录重复：${directory}`)
      seen.add(key)
      checkedDirectories.push(directory)
    }

    const projectId = randomUUID()
    const sessionsDirectory = resolve(paths.rootDir, "sessions")
    const projectDirectory = join(sessionsDirectory, projectId)
    let created = false
    try {
      await mkdir(projectDirectory)
      created = true
      await mkdir(join(projectDirectory, "workspace"))
      const project = {
        version: 1 as const,
        id: projectId,
        name: name.trim(),
        updatedAt: new Date().toISOString(),
        directories: checkedDirectories,
        sessions: [],
      }
      insertProjectWorkspace(paths.workspaceDatabasePath, project)
      return summarizeProject(project)
    } catch (error) {
      if (created) {
        if (dirname(resolve(projectDirectory)) !== sessionsDirectory) throw error
        try {
          await rm(projectDirectory, { recursive: true, force: true })
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "项目创建失败，且无法清理项目目录")
        }
      }
      throw error
    }
  })

  ipcMain.handle(PROJECT_IPC_CHANNELS.addProjectDirectory, (_event, projectId: unknown, value: unknown) =>
    directoryResult(async () => {
      if (projectId === "default") throw new TypeError("Project ID 不能是 default")
      const checkedProjectId = requireProjectId(projectId)
      const directory = await requireDirectory(value)
      const project = readProjectWorkspace(paths.workspaceDatabasePath, checkedProjectId)
      if (project.directories.some((item) => directoryKey(item) === directoryKey(directory))) {
        throw new Error(`关联目录已存在：${directory}`)
      }
      saveProjectWorkspace(paths.workspaceDatabasePath, {
        ...project,
        directories: [...project.directories, directory],
        updatedAt: new Date().toISOString(),
      })
    }))

  ipcMain.handle(PROJECT_IPC_CHANNELS.removeProjectDirectory, (_event, projectId: unknown, value: unknown) =>
    directoryResult(async () => {
      if (projectId === "default") throw new TypeError("Project ID 不能是 default")
      const checkedProjectId = requireProjectId(projectId)
      const directory = await requireDirectory(value)
      const project = readProjectWorkspace(paths.workspaceDatabasePath, checkedProjectId)
      const remaining = project.directories.filter((item) => directoryKey(item) !== directoryKey(directory))
      if (remaining.length === project.directories.length) {
        throw new Error(`关联目录不存在：${directory}`)
      }
      saveProjectWorkspace(paths.workspaceDatabasePath, {
        ...project,
        directories: remaining,
        updatedAt: new Date().toISOString(),
      })
    }))
}
