/**
 * 处理单条 Skill 元信息的截断，并提供来源身份计算。
 *
 * 对话状态保存在 SessionState，本模块不维护跨 Skill 总预算。
 */
import { resolve } from "node:path"
import type { SkillScope } from "../../session/src/events.ts"
import type { CurrentSessionBaseline } from "../../session/src/session-state.ts"

/**
 * 一个来源目录中已启用、可参与当前对话上下文的 Skill。
 */
export interface EnabledSkill {
  /**
   * Skill 文件夹名，也是工具调用时使用的名称。
   */
  name: string
  /**
   * Skill 文件夹的绝对路径。
   */
  path: string
  /**
   * 由来源目录确定的作用域。
   */
  scope: SkillScope
  /**
   * 从 YAML frontmatter 读取、尚未截断的描述。
   */
  description: string
}

/**
 * 生成区分作用域与绝对路径的来源身份。
 *
 * @param skill 含绝对路径和作用域的 Skill 来源。
 * @returns 按当前平台路径规则规范化后的稳定键。
 */
export function skillSourceKey(skill: { path: string; scope: SkillScope }): string {
  const path = resolve(skill.path)
  return `${skill.scope}:${process.platform === "win32" ? path.toLowerCase() : path}`
}

/**
 * 保留名称并截断描述，使 name + description 的本地估算不超过 500 tokens。
 *
 * @param name 完整文件夹名。
 * @param description 原始描述。
 * @param estimate 现有本地估算器。
 * @returns 截断描述和实际估算开销。
 * @throws Error 估算结果无效或名称本身超过上限。
 */
export function limitSkillDescription(name: string, description: string, estimate: (text: string) => number) {
  /**
   * 使用注入的估算器检查单条 Skill 文本的开销。
   *
   * @param text 待估算的名称与描述文本。
   * @returns 经安全整数检查的本地 Token 数。
   * @throws Error 估算器返回负数或非安全整数时抛出。
   */
  const tokens = (text: string): number => {
    const value = estimate(text)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Skill ${name} 的 Token 估算无效。`)
    return value
  }
  if (tokens(name) > 500) throw new Error(`Skill 名称本身超过 500 tokens：${name}`)
  if (tokens(name + description) <= 500) return { description, estimatedTokens: tokens(name + description) }
  const characters = Array.from(description)
  let low = 0
  let high = characters.length
  let shortened = ""
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate = characters.slice(0, length).join("") + "..."
    if (tokens(name + candidate) <= 500) { shortened = candidate; low = length + 1 }
    else high = length - 1
  }
  return { description: shortened, estimatedTokens: tokens(name + shortened) }
}

/**
 * 生成可保存、比较和注入模型的同一份 Skill 元信息。
 *
 * @param skills 已合并且名称唯一的启用来源。
 * @param estimate 现有本地估算器。
 * @returns 比较记录、格式化内容和截断描述。
 * @throws Error 单条文本不能按估算器限制在 500 tokens 内。
 */
export function buildSkillContext(skills: readonly EnabledSkill[], estimate: (text: string) => number): CurrentSessionBaseline["skills"] {
  const visible = skills.map((skill) => ({ ...skill, ...limitSkillDescription(skill.name, skill.description, estimate) }))
  return {
    entries: visible.map(({ name, path, scope, estimatedTokens }) => ({ name, path, scope, enabled: true, estimatedTokens })),
    descriptions: Object.fromEntries(visible.map(({ name, description }) => [name, description])),
    content: visible.length === 0 ? "" : `<skills>\n${JSON.stringify(visible.map(({ name, scope, description }) => ({ name, scope, description })), null, 2)}\n</skills>`,
  }
}
