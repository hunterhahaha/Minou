/** 记忆工具专属 render，只格式化成功数据或错误，不访问文件或写事件。 */
import type { AppError } from "../../../error/src/types.ts"
import type { MemoryListResult, MemoryReadResult, MemoryWriteResult } from "../../../memory/src/index.ts"
import { renderCommonError } from "../tool-executor.ts"
import type { ToolResult } from "../types.ts"

/**
 * 格式化记忆分类索引，不包含各分类正文。
 * @param result 分类索引或统一错误。
 * @returns 记忆分类索引文本，不包含正文。
 */
export function renderMemoryList(result: MemoryListResult | AppError): ToolResult {
  if ("source" in result) return renderCommonError(result)
  const sections = result.sections.map((section) => [section.level1, ...section.level2.map((title) => `  - ${title}`)].join("\n"))
  return { status: "success", content: [{ type: "text", text: `工具调用成功，当前长期记忆结构如下：\n\n${sections.length === 0 ? "当前没有长期记忆。" : sections.join("\n\n")}` }] }
}

/**
 * 格式化各分类的时间、正文及独立截断提示。
 * @param result 章节记忆或统一错误。
 * @returns 分类、时间、正文及各分类的独立截断提示。
 */
export function renderMemoryRead(result: MemoryReadResult | AppError): ToolResult {
  if ("source" in result) return renderCommonError(result)
  const sections = result.sections.map((section) => [
    `${section.level1} / ${section.level2}`,
    ...(section.memories.length === 0 ? ["当前分类没有长期记忆。"] : section.memories.map((entry) => `[${entry.createdAt}]\n${entry.content}`)),
    ...(section.truncated ? ["[More memories available in this section.]"] : []),
  ].join("\n\n"))
  return { status: "success", content: [{ type: "text", text: sections.length === 0 ? "未请求任何记忆分类。" : sections.join("\n\n") }] }
}

/**
 * 格式化实际写入条数与分类位置，不重复新增正文。
 * @param result 已提交位置与时间或统一错误。
 * @returns 实际写入条数与分类位置，不重复正文。
 */
export function renderMemoryWrite(result: MemoryWriteResult | AppError): ToolResult {
  if ("source" in result) return renderCommonError(result)
  const positions = result.memories.map((entry) => `${entry.level1} / ${entry.level2}`).join("\n")
  return { status: "success", content: [{ type: "text", text: `成功写入 ${result.memories.length} 条长期记忆：${positions.length === 0 ? "" : `\n\n${positions}`}` }] }
}
