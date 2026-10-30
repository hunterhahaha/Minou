/**
 * 整理 skill_load 的可见结果，不读取目录或修改 Skill 状态。
 */
import type { AppError } from "../../../error/src/types.ts"
import type { SkillLoadResult } from "../../../skill/src/index.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolResult } from "../types.ts"

/**
 * 将 Skill 读取结果呈现为完整正文或明确错误。
 * @param result 完整 Skill 数据或统一错误对象。
 * @returns 错误信息、未找到提示或包含完整正文的成功结果。
 */
export function renderSkillLoad(result: SkillLoadResult | AppError): ToolResult {
  if ("source" in result) {
    if (result.code === "SKILL_NOT_FOUND") return { status: "error", error: result, content: [{ type: "text", text: `Skill not found.\n${result.message}` }] }
    return renderCommonError(result)
  }
  return { status: "success", content: [{ type: "text", text: `Skill: ${result.name}\nScope: ${result.scope}\n\n${result.content}` }] }
}
