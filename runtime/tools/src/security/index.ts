/** 文件工具的沙箱目录判定。审批等待由当前 SessionRuntime 提供。 */
import type { SandboxMode } from "../../../session/src/session-state.ts"
import { isWithinRoot } from "../filesystem/index.ts"

/** SandboxPolicy 对一个文件调用的决定。 */
export type FileAccessDecision = "ALLOW" | "APPROVAL"

/**
 * 按对话沙箱模式、工具和规范路径判定权限。
 * @param mode 当前 Session Meta 的沙箱模式。
 * @param toolName 当前文件工具名称。
 * @param target 已规范化目标路径。
 * @param roots 已规范化允许根目录。
 * @returns 可立即执行或需要审批。
 */
export function fileAccessDecision(
  mode: SandboxMode,
  toolName: "glob" | "grep" | "read" | "write" | "edit",
  target: string,
  roots: readonly string[],
): FileAccessDecision {
  if (mode === "full-access") return "ALLOW"
  const inside = roots.some((root) => isWithinRoot(target, root))
  if (mode === "sandbox-full-access" || mode === "auto") return inside ? "ALLOW" : "APPROVAL"
  return inside && (toolName === "glob" || toolName === "grep" || toolName === "read")
    ? "ALLOW" : "APPROVAL"
}
