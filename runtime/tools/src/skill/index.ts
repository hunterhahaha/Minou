/**
 * 定义并注册 skill_load 工具。
 *
 * 本模块校验工具参数并委托 SkillManager 检查实时启用状态、读取正文。
 */
import { SkillManager } from "../../../skill/src/index.ts"
import { isProjectId } from "../../../session/src/project-id.ts"
import { registerTool, isPlainRecord } from "../tool-registry.ts"
import type { ToolRegistry, RenderRegistry, ToolArgumentValidation } from "../tool-registry.ts"
import type { ToolCallMeta } from "../types.ts"
import { renderSkillLoad } from "../render/skill.ts"

/**
 * skill_load 接受的业务参数；Session 和 Project 身份由 Runtime 提供。
 */
export interface SkillLoadInput extends ToolCallMeta {
  /**
   * Skill 的完整文件夹名，用于匹配当前有效来源。
   */
  name: string
}

/**
 * 成对登记 Skill 读取工具和专属 renderer，不读取来源配置。
 *
 * @param tools 应用工具注册表。
 * @param renders 应用结果整理器注册表。
 * @param manager 应用共享的 Skill 来源管理器。
 * @throws Error 注册表名称冲突或定义无效。
 */
export function registerSkillTools(tools: ToolRegistry, renders: RenderRegistry, manager: SkillManager): void {
  registerTool(tools, renders, {
    kind: "builtin",
    definition: {
      name: "skill_load",
      description: "Load the complete SKILL.md of an enabled Skill by its exact folder name. Project Skills override Global Skills of the same name. Current source configuration is checked on every call.",
      inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"], additionalProperties: false },
    },
    validateArguments: (value): ToolArgumentValidation<SkillLoadInput> => isPlainRecord(value) && Object.keys(value).length === 1 && typeof value.name === "string" && value.name.trim() !== ""
      ? { success: true, data: { name: value.name } }
      : { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message: "skill_load 需要非空 name，且不接受其他业务参数。" } },
    execute: async ({ name }, context) => {
      if (!isProjectId(context.projectId)) return { source: "tool", code: "SKILL_PROJECT_INVALID", message: "Skill 调用缺少有效 Project 身份。" }
      try { return await manager.loadSkill(context.projectId, name, context.signal) }
      catch (error) {
        const code = context.signal.aborted ? "CANCELLED" : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "SKILL_LOAD_FAILED"
        return { source: "tool", code, message: error instanceof Error ? error.message : "Skill 读取失败。" }
      }
    },
    render: renderSkillLoad,
  })
}
