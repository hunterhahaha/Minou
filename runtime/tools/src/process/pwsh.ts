import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

/**
 * 解析 PowerShell 7 可执行路径。绝对路径直接返回；文件名按当前 PATH 查找，Windows 下补全 .exe 后缀，不回退到旧 Windows PowerShell。
 * @param executable - 可执行文件名或由调用方提供的绝对路径。
 * @returns 给定绝对路径，或 PATH 中找到的可执行普通文件路径。
 * @throws Error - 文件名无法在 PATH 中找到；绝对路径的存在性由实际启动操作检查。
 */
export function resolvePwsh(executable: string): string {
  if (isAbsolute(executable)) return executable
  const name = process.platform === "win32" && !executable.toLowerCase().endsWith(".exe") ? executable + ".exe" : executable
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue
    const path = join(directory.replace(/^"|"$/g, ""), name)
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path } catch { }
  }
  throw new Error("没有找到 PowerShell 7 可执行文件：" + executable)
}
