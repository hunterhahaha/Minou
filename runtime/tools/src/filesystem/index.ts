/** 文件工具共用的绝对路径、目录边界和 ripgrep 进程设施。 */
import { spawn } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"

/** 相对路径是文件工具参数错误。 */
export const ABSOLUTE_PATH_REQUIRED = "ABSOLUTE_PATH_REQUIRED"

/**
 * 规范化工具给定的绝对路径，解析现有路径的符号链接。
 * 写入不存在的路径时解析最近的现有父目录，再拼接尚未创建的部分。
 * @param input 工具参数中的绝对路径。
 * @returns 规范化的真实目标路径。
 * @throws Error 路径相对、存在不可访问节点或路径解析失败时抛出。
 */
export async function canonicalPath(input: string): Promise<string> {
  if (!isAbsolute(input)) {
    const error = new Error(`文件路径必须是绝对路径：${input}`)
    Object.assign(error, { code: ABSOLUTE_PATH_REQUIRED })
    throw error
  }
  const absolute = resolve(input)
  const missing: string[] = []
  let current = absolute
  while (true) {
    try {
      await lstat(current)
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
      continue
    }
    const base = await realpath(current)
    return resolve(base, ...missing.reverse())
  }
}

/**
 * 判断规范目标是否位于某个规范根目录内，包含根目录本身。
 * @param target 已规范化目标。
 * @param root 已规范化根目录。
 * @returns 目标处于根目录内时为 true。
 */
export function isWithinRoot(target: string, root: string): boolean {
  const part = relative(root, target)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

/**
 * 将应用依赖中的平台 ripgrep 二进制定位为真实文件路径。
 * @param applicationRoot 含 package.json 和生产依赖的应用根目录。
 * @returns 当前平台的 rg 可执行文件绝对路径。
 * @throws Error 平台包未安装或二进制文件不可用时抛出。
 */
export function bundledRipgrepPath(applicationRoot: string): string {
  const requireFromApp = createRequire(join(applicationRoot, "package.json"))
  const wrapper = requireFromApp.resolve("@vscode/ripgrep")
  const requireFromWrapper = createRequire(wrapper)
  const binary = process.platform === "win32" ? "rg.exe" : "rg"
  return requireFromWrapper.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${binary}`)
}

/**
 * 启动随应用安装的 ripgrep，按行消费输出，达到上限时终止子进程。
 * @param rgPath ripgrep 二进制路径。
 * @param arguments_ 不经 Shell 的参数数组。
 * @param signal 本次工具调用的取消信号。
 * @param onLine 输出行处理器；返回 false 表示已取得足够结果。
 * @returns 是否由处理器主动截断。
 * @throws Error 进程启动失败、ripgrep 报错或调用取消时抛出。
 */
export async function runRipgrep(
  rgPath: string,
  arguments_: string[],
  signal: AbortSignal,
  onLine: (line: string) => boolean,
): Promise<boolean> {
  if (signal.aborted) throw abortError()
  const child = spawn(rgPath, arguments_, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  const closed = new Promise<number | null>((done) => child.once("close", done))
  let truncated = false
  let stderr = ""
  let failure: unknown
  const abort = () => child.kill()
  signal.addEventListener("abort", abort, { once: true })
  child.on("error", (error) => { failure = error })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!onLine(line)) {
        truncated = true
        child.kill()
        break
      }
    }
    const code = await closed
    if (signal.aborted) throw abortError()
    if (failure !== undefined) throw failure
    if (!truncated && code !== 0 && code !== 1) {
      throw new Error(`ripgrep 执行失败（${code}）：${stderr.trim()}`)
    }
    return truncated
  } finally {
    signal.removeEventListener("abort", abort)
    lines.close()
    if (child.exitCode === null) child.kill()
  }
}

/**
 * 构造可被统一取消识别函数识别的错误。
 * @returns 与统一取消识别兼容的错误。
 */
function abortError(): Error {
  return Object.assign(new Error("工具调用已取消"), { name: "AbortError" })
}

/**
 * 检查异常是否为带字符串 code 的 Error。
 * @param error 文件系统异常。
 * @returns 是否含 Node 错误码。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
