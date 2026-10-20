/** 单个 Global / Project Skill 来源的管理 IPC，不缓存来源配置。 */
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import type { SkillManager, SkillTarget } from "../../runtime/skill/src/index.ts"
import { requireProjectId } from "../../runtime/session/src/project-id.ts"
import { SKILL_IPC_CHANNELS } from "../preload/session-api.ts"
import type { ConfigFilePaths } from "./config-files.ts"
import type { IpcMainHandlePort } from "./session-ipc.ts"
import { readProjectWorkspace } from "./workspace-store.ts"

/**
 * 注册按来源读取技能与保存启停的两个 handler；注册时不扫描或读取技能。
 * @param ipcMain 主进程 handler 注册端口。
 * @param paths 可信配置根目录及项目登记数据库路径。
 * @param manager 应用启动时创建的共享 SkillManager。
 * @throws Error channel 重复注册；请求输入、项目损坏及持久化错误由 handler 传给页面。
 */
export function registerSkillIpcHandlers(
  ipcMain: IpcMainHandlePort,
  paths: Pick<ConfigFilePaths, "rootDir" | "workspaceDatabasePath">,
  manager: SkillManager,
): void {
  /**
   * 检查 Renderer 传入的来源身份，项目必须已登记且父目录真实存在。
   * @param value 尚未信任的 IPC 输入，不允许指定来源路径。
   * @returns 使用可信根目录解析来源所需的身份。
   * @throws TypeError 结构或身份无效；Error 项目未登记或项目目录损坏。
   */
  async function requireTarget(value: unknown): Promise<SkillTarget> {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("scope" in value)) throw new TypeError("Skill 管理作用域无效")
    if (value.scope === "global" && Object.keys(value).length === 1) return { scope: "global" }
    if (value.scope !== "project" || Object.keys(value).length !== 2 || !("projectId" in value) || value.projectId === "default") throw new TypeError("Skill 管理作用域无效")
    const projectId = requireProjectId(value.projectId)
    readProjectWorkspace(paths.workspaceDatabasePath, projectId)
    const directory = join(paths.rootDir, "sessions", projectId)
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Project 配置目录不是普通目录：${directory}`)
    return { scope: "project", projectId }
  }

  ipcMain.handle(SKILL_IPC_CHANNELS.listSkills, async (_event, target: unknown) => manager.listSkills(await requireTarget(target)))
  ipcMain.handle(SKILL_IPC_CHANNELS.setSkillEnabled, async (_event, target: unknown, name: unknown, enabled: unknown) => {
    if (typeof name !== "string" || typeof enabled !== "boolean") throw new TypeError("Skill 名称或启用状态无效")
    return manager.setSkillEnabled(await requireTarget(target), name, enabled)
  })
}
