/**
 * Project 工作区数据库、AGENTS.md 与 Skill 固定上下文的实现。
 *
 * 工作区数据库在同步 Runtime 构造边界读取；可能随 Turn 变化的 AGENTS.md 与 Skill
 * 内容由异步 baseline 函数重新读取。Project 基线不读取 Session 的 MCP 载入状态，
 * MCP 定义由 SessionRuntime 在每次模型请求前从 Meta 与全局 Catalog 组合。
 */

import { createHash } from "node:crypto"
import {
  lstatSync,
} from "node:fs"
import {
  lstat,
  readFile,
} from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import type { SkillManager } from "../../runtime/skill/src/index.ts"
import { requireProjectId } from "../../runtime/session/src/project-id.ts"
import type {
  CurrentSessionBaseline,
} from "../../runtime/session/src/session-state.ts"
import { readDefaultWorkspace, readProjectWorkspace } from "./workspace-store.ts"
import type { ProjectWorkspace } from "./workspace-store.ts"

/** Project Context resolver 的固定进程级输入。 */
export interface ProjectContextResolverOptions {
  /** 已初始化的 `.nicode` 绝对目录。 */
  rootDirectory: string
  /**
   * 启动时创建、由 Project Context 复用的共享 Skill 来源管理器。
   */
  skillManager: SkillManager
}

/**
 * 同步读取一个 Project 的身份和路径，并建立其异步 baseline 来源。
 *
 * @param options `.nicode` 根目录与共享 SkillManager。
 * @param projectId IPC 已校验的 UUID 或 default。
 * @returns 当前 Project 的模型可见工作区信息与 baseline 解析函数。
 * @throws Error 当根目录不是绝对路径、Project 目录或 workspace 目录不可用，或数据库中缺少对应项目配置时抛出。
 */
export function resolveProjectContext(
  options: ProjectContextResolverOptions,
  projectId: string,
) {
  if (!isAbsolute(options.rootDirectory)) {
    throw new Error(`Project Context 根目录必须是绝对路径：${options.rootDirectory}`)
  }
  requireProjectId(projectId)

  const projectDirectory = join(options.rootDirectory, "sessions", projectId)
  const workspaceDirectory = join(projectDirectory, "workspace")
  requireDirectorySync(projectDirectory, "Project 配置目录")
  requireDirectorySync(workspaceDirectory, "Project workspace 目录")
  const workspacePath = join(options.rootDirectory, "workspace.sqlite")
  let workspace: Pick<ProjectWorkspace, "id" | "name" | "directories"> | { id: "default"; name: null; directories: string[] }
  if (projectId === "default") {
    readDefaultWorkspace(workspacePath)
    workspace = { id: "default", name: null, directories: [] }
  } else {
    workspace = readProjectWorkspace(workspacePath, projectId)
  }
  const cwd = workspace.directories[0] ?? workspaceDirectory
  const allowedRoots = [workspaceDirectory, ...workspace.directories]
  const agentsMdPath = join(cwd, "AGENTS.md")

  return {
    workspaceInfo: formatWorkspaceInfo(
      workspace,
      projectDirectory,
      workspaceDirectory,
      cwd,
      allowedRoots,
    ),
    resolveCurrentBaseline: async (): Promise<CurrentSessionBaseline> => {
      const [agentsContent, skills] = await Promise.all([
        readOptionalTextFile(agentsMdPath, "AGENTS.md"),
        options.skillManager.resolveSkills(projectId),
      ])
      return {
        agentsmd: {
          path: agentsMdPath,
          hash: hashText(agentsContent),
          content: agentsContent,
        },
        skills,
        mcp: [],
      }
    },
  }
}

/**
 * 生成 ContextBuilder 放入 System Message 的 Project Workspace Info。
 *
 * @param workspace 从数据库读取的 Project/default 配置。
 * @param projectDirectory Project 分组目录。
 * @param workspaceDirectory Project 内置工作目录。
 * @param cwd 当前默认工作目录。
 * @param allowedRoots 当前明确允许的根目录。
 * @returns 带稳定字段名的 JSON 文本块。
 */
function formatWorkspaceInfo(
  workspace: Pick<ProjectWorkspace, "id" | "name" | "directories"> | { id: "default"; name: null; directories: string[] },
  projectDirectory: string,
  workspaceDirectory: string,
  cwd: string,
  allowedRoots: readonly string[],
): string {
  return `<workspace_info>\n${JSON.stringify({
    projectId: workspace.id,
    projectName: workspace.name,
    projectDirectory,
    workspaceDirectory,
    directories: workspace.directories,
    cwd,
    allowedRoots,
  }, null, 2)}\n</workspace_info>`
}

/**
 * 对基线文本计算 SHA-256，用于 AGENTS.md 内容比较。
 *
 * @param content 要计算哈希的完整文本。
 * @returns SHA-256 十六进制字符串。
 */
function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * 同步要求路径为目录。
 *
 * @param path 要检查的绝对路径。
 * @param label 错误中的路径职责。
 * @throws Error 当路径缺失、无法检查或不是目录时抛出。
 */
function requireDirectorySync(path: string, label: string): void {
  let state
  try {
    state = lstatSync(path)
  } catch (error) {
    throw new Error(`无法检查${label}：${path}`, { cause: error })
  }
  if (!state.isDirectory()) throw new Error(`${label}不是目录：${path}`)
}

/**
 * 以 UTF-8 读取文本，在读取失败的错误中保留路径与原始原因。
 *
 * @param filePath 要读取的文件路径。
 * @param label 错误消息中说明文件职责的名称。
 * @returns 文件原始文本。
 * @throws Error 读取失败时包装后传播，由上下文解析入口处理。
 */
async function readTextFile(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    throw new Error(`无法读取${label}：${filePath}`, { cause: error })
  }
}

/**
 * 缺失文件返回空文本；存在时要求普通文件并读取。
 *
 * @param filePath 可缺失的文件路径。
 * @param label 错误消息中的文件职责。
 * @returns 文件文本；不存在时为空字符串。
 * @throws Error 路径类型不符、检查或读取失败时传播。
 */
async function readOptionalTextFile(filePath: string, label: string): Promise<string> {
  const kind = await pathKind(filePath)
  if (kind === "missing") return ""
  if (kind !== "file") throw new Error(`${label}不是普通文件：${filePath}`)
  return readTextFile(filePath, label)
}

/**
 * 通过 lstat 区分缺失、普通文件、目录及其他节点。
 *
 * @param path 要检查的路径。
 * @returns 当前路径类型，仅 ENOENT 被解释为 missing。
 * @throws Error 除 ENOENT 外的路径检查错误包装后传播。
 */
async function pathKind(path: string): Promise<"missing" | "file" | "directory" | "other"> {
  let state
  try {
    state = await lstat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing"
    throw new Error(`无法检查路径：${path}`, { cause: error })
  }
  if (state.isFile()) return "file"
  if (state.isDirectory()) return "directory"
  return "other"
}

/**
 * 检查异常是否为携带 code 属性的 Error，不验证错误码的具体值。
 *
 * @param error 文件操作捕获的未知异常。
 * @returns 值是否符合当前文件系统错误分支需要的形状。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
