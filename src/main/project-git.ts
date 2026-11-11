import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"

import type { ProjectGitBranchState, ProjectGitSwitchResult } from "../preload/session-api.ts"

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER_BYTES = 1024 * 1024

/** 非 Git 目录或未配置目录时返回的空分支状态。 */
export const NON_GIT_BRANCH_STATE: ProjectGitBranchState = {
  isGitRepo: false,
  currentBranch: null,
  branches: [],
}

type GitCommandResult =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string; stdout: string; message: string }

/**
 * 在指定项目目录执行一条非交互式 Git 命令。
 * @param directory 目标项目工作目录。
 * @param args 传给 `git` 可执行文件的参数列表。
 * @param readOnly 为 true 时启用 `GIT_OPTIONAL_LOCKS=0`，避免只读查询等待或写入索引锁。
 * @returns 命令输出或结构化的失败详情，不直接向外抛出子进程异常。
 */
function runGitCommand(directory: string, args: string[], readOnly: boolean): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LC_ALL: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
    }
    if (readOnly) {
      env.GIT_OPTIONAL_LOCKS = "0"
    }
    execFile(
      "git",
      args,
      {
        cwd: directory,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: "utf8",
        env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout: stdout ?? "" })
          return
        }
        resolve({
          ok: false,
          stderr: stderr ?? "",
          stdout: stdout ?? "",
          message: error.message,
        })
      },
    )
  })
}

async function isExistingDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory()
  } catch {
    return false
  }
}

async function isGitWorkTree(directory: string): Promise<boolean> {
  if (!(await isExistingDirectory(directory))) {
    return false
  }
  const result = await runGitCommand(directory, ["rev-parse", "--is-inside-work-tree"], true)
  return result.ok && result.stdout.trim() === "true"
}

function validateBranchName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Git 分支名称必须是字符串")
  }
  const branch = value.trim()
  if (branch.length === 0) {
    throw new Error("Git 分支名称不能为空")
  }
  if (branch.startsWith("-") || /[\0\r\n]/.test(branch)) {
    throw new Error(`无效的 Git 分支名称：${branch}`)
  }
  return branch
}

/**
 * 读取指定目录的 Git 工作树状态、当前分支与本地分支列表。
 * @param directory Project 的主关联目录路径。
 * @returns 非 Git 工作树或目录不存在时返回 `isGitRepo: false`；游离 HEAD 时 `currentBranch` 为 `null`；刚 `git init` 的未提交仓库也会包含初始分支。
 */
export async function inspectProjectGitBranches(directory: string): Promise<ProjectGitBranchState> {
  if (!(await isGitWorkTree(directory))) {
    return NON_GIT_BRANCH_STATE
  }
  const [headResult, refsResult] = await Promise.all([
    runGitCommand(directory, ["symbolic-ref", "--short", "-q", "HEAD"], true),
    runGitCommand(directory, ["-c", "core.quotePath=false", "for-each-ref", "--sort=refname", "--format=%(refname:short)", "refs/heads"], true),
  ])
  const currentBranch = headResult.ok && headResult.stdout.trim().length > 0
    ? headResult.stdout.trim()
    : null
  const refBranches = refsResult.ok
    ? refsResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    : []
  const branches = currentBranch !== null && !refBranches.includes(currentBranch)
    ? [currentBranch, ...refBranches]
    : refBranches
  return {
    isGitRepo: true,
    currentBranch,
    branches,
  }
}

/**
 * 在指定目录执行 `git switch -- <branch>` 切换当前分支，并返回最新分支状态。
 * @param directory Project 的主关联目录路径。
 * @param branchValue 待切换的本地分支名称。
 * @returns 切换成功后的最新分支状态，或失败原因（如工作区未提交冲突、分支不存在、目录非 Git 仓库）。
 */
export async function switchProjectGitBranch(directory: string, branchValue: unknown): Promise<ProjectGitSwitchResult> {
  let branch: string
  try {
    branch = validateBranchName(branchValue)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!(await isExistingDirectory(directory))) {
    return { success: false, error: `关联目录不可用：${directory}` }
  }
  if (!(await isGitWorkTree(directory))) {
    return { success: false, error: "当前项目目录不是 Git 仓库" }
  }
  const switched = await runGitCommand(directory, ["switch", "--", branch], false)
  if (!switched.ok) {
    const error = [switched.stderr.trim(), switched.stdout.trim(), switched.message].find((text) => text.length > 0)
      ?? "切换 Git 分支失败"
    return { success: false, error }
  }
  return {
    success: true,
    branchState: await inspectProjectGitBranches(directory),
  }
}
