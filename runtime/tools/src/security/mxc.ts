import { dirname, join, parse } from "node:path"
import { homedir, release } from "node:os"
import { stat } from "node:fs/promises"
import { finished } from "node:stream/promises"
import { canonicalPath, isWithinRoot } from "../filesystem/index.ts"
import { pathPermission, permissionError, type ToolPermissions } from "./permissions.ts"
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1"

/** 探测后选定的具体 MXC 后端。 */
export type MxcBackend = "processcontainer" | "bubblewrap"

/** 进程启动时确定的隔离范围，PTY 会在进程存续期间保持该范围。 */
export interface MxcProcessAccess {
  /** 经过启动检测的 MXC 后端。 */
  backend: MxcBackend
  /** 当前目录与网络权限；Linux 完全访问时使用用户主目录读写及开放网络。 */
  policy: ToolPermissions
}

/** Windows 的 PowerShell 和控制台进程需要 Win32k；剪贴板与全局输入保持禁用。 */
const windowsUi = { disable: false, clipboard: "none", allowInputInjection: false } as const

/**
 * 确认预期后端可用，再运行一条无副作用的启动探测。
 * @returns 当前平台可启动的后端；不受支持或探测失败时进入受阻模式。
 */
export async function detectMxcBackend(): Promise<MxcBackend | null> {
  const backend = process.platform === "win32" ? "processcontainer" : process.platform === "linux" ? "bubblewrap" : null
  if (!backend || (backend === "processcontainer" && Number(release().split(".")[2]) < 26100)) return null
  try {
    const sdk = await import("@microsoft/mxc-sdk/v1")
    const support = sdk.getPlatformSupport()
    if (!support.isSupported || !support.availableMethods.includes(backend)) return null
    const command = backend === "processcontainer"
      ? `"${join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")}" /D /C echo MinouMXC`
      : "/bin/echo MinouMXC"
    const child = await sdk.spawn({
      containment: backend === "processcontainer" ? { type: backend, config: {} } : { type: backend },
      command,
      ...(backend === "processcontainer" && { ui: windowsUi }),
      timeoutMs: 5000,
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    })
    const output = child.standardOutput
    let stdout = ""
    output?.setEncoding("utf8").on("data", (text: string) => { stdout += text })
    const waiting = child.wait()
    try {
      const [{ exitCode }] = await Promise.all([waiting, output && finished(output, { cleanup: true })])
      return exitCode === 0 && stdout.trim() === "MinouMXC" ? backend : null
    } finally {
      try {
        child.kill()
        await waiting.catch(() => {})
      } finally { child.dispose() }
    }
  } catch (error) {
    console.warn("MXC 启动探测失败，启用受阻模式。", error)
    return null
  }
}

/**
 * 将启动时的路径权限、网络和命令转换成 SDK 请求。
 * @param access 当前调用最终采用的隔离范围。
 * @param executable PowerShell 的绝对路径。
 * @param args 固定选项及已编码的脚本，不含原始命令文本。
 * @param cwd 启动目录。
 * @param terminal 是否创建可交互终端。
 * @returns 可交给 MXC 的一次启动配置。
 * @throws Error 规则无法安全传递给后端或必要路径不可解析。
 */
export async function mxcRequest(access: MxcProcessAccess, executable: string, args: string[], cwd: string, terminal = false): Promise<ContainerRequest> {
  const { backend, policy } = access
  const [runtimePath, workingDirectory] = await Promise.all([canonicalPath(dirname(executable)), canonicalPath(cwd)])
  const rules = policy.paths
  if (pathPermission(rules, workingDirectory) === "DENY") {
    throw permissionError("MXC_CWD_DENIED", "当前权限不允许访问进程工作目录")
  }
  /** Windows 能按绝对路径读取获准子目录，但 PowerShell 进入目录时还需访问祖先路径。 */
  if (backend === "processcontainer" && rules.some(({ path, access: level }) =>
      level === "DENY" && isWithinRoot(workingDirectory, path))) {
    throw permissionError("MXC_CWD_DENIED", "Windows MXC 无法进入上级路径被显式拒绝的工作目录")
  }
  const runtimeAccess = pathPermission(rules, runtimePath)
  if (runtimeAccess === "DENY" && rules.some(({ path }) => isWithinRoot(runtimePath, path))) {
    throw permissionError("MXC_POLICY_UNSUPPORTED", "路径规则禁止读取随附的 PowerShell 目录")
  }
  if (backend === "processcontainer" && rules.some(({ path, access: level }) => level !== "DENY" && parse(path).root === path)) {
    throw permissionError("MXC_POLICY_UNSUPPORTED", "Windows MXC 不支持将卷根目录授权传递到子目录，请申请具体目录")
  }
  /** MXC 可能跳过不存在的挂载或规则，此时拒绝整个启动。 */
  for (const rule of rules) {
    const exists = await stat(rule.path).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (!exists) throw permissionError("MXC_PATH_MISSING", "MXC 授权路径不存在，请选择已有路径：" + rule.path)
    if (await canonicalPath(rule.path) !== rule.path) {
      throw permissionError("PATH_CHANGED", "MXC 启动前授权路径发生变化")
    }
  }
  const address = policy.network ? "allow" : "deny"
  const quote = backend === "processcontainer"
    ? (part: string) => `"${part}"`
    : (part: string) => "'" + part.replaceAll("'", "'\\''") + "'"
  const windows = backend === "processcontainer"
  return {
    containment: windows ? { type: backend, config: {} } : { type: backend },
    ...(windows && { ui: windowsUi }),
    command: [executable, ...args].map(quote).join(" "),
    workingDirectory,
    environment: windows ? {
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      PATH: process.env.Path,
      ...(terminal && { TERM: "xterm-256color" }),
    } : { PATH: process.env.PATH, ...(terminal && { TERM: "xterm-256color" }) },
    filesystem: {
      readwritePaths: rules.filter((rule) => rule.access === "WRITE").map((rule) => rule.path),
      readonlyPaths: [
        ...rules.filter((rule) => rule.access === "READ").map((rule) => rule.path),
        ...(runtimeAccess === "DENY" ? [runtimePath] : []),
      ],
      deniedPaths: rules.filter((rule) => rule.access === "DENY").map((rule) => rule.path),
    },
    network: { egress: { default: address }, ingress: { default: address, hostLoopback: address } },
  }
}
