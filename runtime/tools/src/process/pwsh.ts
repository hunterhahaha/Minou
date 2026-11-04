import { accessSync, constants, statSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getCallSites } from "node:util"

/**
 * 定位源码或编译产物对应的内置 PowerShell 7，并在启动前检查文件可执行性。
 * @param executable - 调用方可显式指定的可执行文件绝对路径。
 * @returns 可执行文件的绝对路径。
 * @throws Error - 路径非绝对路径，或目标缺失、不可执行或不是普通文件。
 */
export function resolvePwsh(executable?: string): string {
  // Node 直接运行 TypeScript 测试时以 ESM 加载源码，tsc 产物以 CommonJS 加载。
  const moduleFile = typeof __filename === "string" ? __filename : fileURLToPath(getCallSites(1)[0].scriptName)
  const root = moduleFile.endsWith(".ts") ? "../../../.." : "../../../../.."
  const path = executable ?? resolve(dirname(moduleFile), root, "resources/powershell", process.platform === "win32" ? "pwsh.exe" : "pwsh")
  if (!isAbsolute(path)) throw new Error("PowerShell 7 可执行文件必须使用绝对路径：" + path)
  try {
    if (statSync(path).isFile()) {
      accessSync(path, constants.X_OK)
      return path
    }
  } catch (error) {
    throw new Error("无法使用 PowerShell 7 可执行文件：" + path, { cause: error })
  }
  throw new Error("PowerShell 7 可执行文件不是普通文件：" + path)
}
