/** 文件工具单次调用使用的真实数据库访问端口。 */
import { join } from "node:path"
import { readSessionMeta } from "../../runtime/session/src/meta-store.ts"
import { SANDBOX_MODES } from "../../runtime/session/src/session-state.ts"
import type { FileAccessState } from "../../runtime/tools/src/file/index.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import { readDefaultWorkspace, readProjectWorkspace } from "./workspace-store.ts"

/**
 * 每次调用按 Project 与 Session 身份重读沙箱模式及关联目录。
 * @param paths 启动时确定的数据库与 `.nicode` 根路径。
 * @param projectId 当前 Project UUID 或 default。
 * @param sessionId 当前 Session 身份。
 * @returns 当前模式及 workspace 加关联目录的允许根目录。
 * @throws Error 数据库缺失、损坏或沙箱模式无效时抛出。
 */
export function loadFileAccessState(
  paths: Pick<ConfigFilePaths, "rootDir" | "metaDatabasePath" | "workspaceDatabasePath">,
  projectId: string,
  sessionId: string,
): FileAccessState {
  const meta = readSessionMeta(paths.metaDatabasePath, projectId, sessionId)
  if (typeof meta !== "object" || meta === null || !("sandboxMode" in meta) ||
      typeof meta.sandboxMode !== "string" || !SANDBOX_MODES.includes(meta.sandboxMode as typeof SANDBOX_MODES[number])) {
    throw new Error(`Session Meta 缺失或沙箱模式无效：${paths.metaDatabasePath}（${projectId}/${sessionId}）`)
  }
  const directories = projectId === "default"
    ? (readDefaultWorkspace(paths.workspaceDatabasePath), [])
    : readProjectWorkspace(paths.workspaceDatabasePath, projectId).directories
  return {
    sandboxMode: meta.sandboxMode as typeof SANDBOX_MODES[number],
    roots: [join(paths.rootDir, "sessions", projectId, "workspace"), ...directories],
  }
}
