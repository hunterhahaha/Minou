/** present 逐项为当前 Turn 已追踪的文件变更写入说明。 */
import { stat } from "node:fs/promises"
import type { AppError } from "../../../error/src/types.ts"
import { canonicalPath } from "../filesystem/index.ts"
import type { ToolExecutionContext } from "../types.ts"

/** 模型提交的文件说明批次；单项内容由业务执行时逐个检查。 */
export interface PresentInput { files: unknown[] }
/** 本次实际写入说明的规范文件路径。 */
export interface PresentResult { presented: string[] }

/**
 * 逐项确认目标仍是普通文件且属于当前 Turn 的写入记录。
 * @param input 已检查整体结构的文件列表。
 * @param context 当前 Turn 的文件追踪器。
 * @returns 成功更新说明的去重路径，保留首次出现顺序。
 */
export async function executePresent(
  input: PresentInput,
  context: ToolExecutionContext<PresentInput>,
): Promise<PresentResult | AppError> {
  const tracker = context.fileRuntime?.tracker
  if (tracker === undefined) return { source: "runtime", code: "FILE_RUNTIME_MISSING", message: "当前 Session 缺少文件变更追踪器" }
  const presented: string[] = []
  for (const item of input.files) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    if (typeof candidate.path !== "string" || typeof candidate.description !== "string") continue
    try {
      const path = await canonicalPath(candidate.path)
      if (!(await stat(path)).isFile()) continue
      if (tracker.describe(path, candidate.description) && !presented.includes(path)) presented.push(path)
    } catch {
      // 第 18.6 节：单项路径无效时继续处理其余文件。
    }
  }
  return { presented }
}
