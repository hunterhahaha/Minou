/** Project 使用 UUID 目录身份；default 是唯一的非 UUID 分组。 */
export type ProjectId = string

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * 检查 Project/default 身份是否可作为固定分组键和目录名。
 * @param value 待检查的身份。
 * @returns 值是否为 UUID 或 default。
 */
export function isProjectId(value: unknown): value is ProjectId {
  return value === "default" || (typeof value === "string" && UUID_PATTERN.test(value))
}

/**
 * 要求调用方提供合法 Project/default 身份。
 * @param value 待检查的身份。
 * @returns 已检查的字符串身份。
 * @throws TypeError 当身份不是 UUID 或 default 时抛出。
 */
export function requireProjectId(value: unknown): ProjectId {
  if (!isProjectId(value)) throw new TypeError("projectId 无效：必须是 UUID 或 default")
  return value
}
