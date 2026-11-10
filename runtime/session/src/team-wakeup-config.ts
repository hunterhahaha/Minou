/** Team 成员共享的黑板唤醒参数，时间以秒计。 */
export interface TeamWakeupConfig {
  /** 发布与回到 idle 时，未读数需严格超过此值。 */
  unreadThreshold: number
  /** 空闲轮询间隔。 */
  pollingInterval: number
  /** 普通唤醒与达到提醒阈值后的 Mention 最短间隔。 */
  wakeupCooldown: number
  /** 达到该次数后，唤醒会提示调用 unread。 */
  unconsumedWakeupAlertThreshold: number
}

/** 首次配置使用的唤醒参数。 */
export const DEFAULT_TEAM_WAKEUP_CONFIG: Readonly<TeamWakeupConfig> = Object.freeze({
  unreadThreshold: 3, pollingInterval: 60, wakeupCooldown: 60, unconsumedWakeupAlertThreshold: 2,
})

/** 各唤醒参数的最小整数值，供文件、IPC 和表单使用。 */
export const TEAM_WAKEUP_MINIMUMS: Readonly<TeamWakeupConfig> = Object.freeze({
  unreadThreshold: 0, pollingInterval: 30, wakeupCooldown: 30, unconsumedWakeupAlertThreshold: 0,
})

/**
 * 检查完整的唤醒配置及各字段的整数边界。
 * @param value 来自配置文件、IPC 或表单的值。
 * @returns 是否包含且仅包含四个合法字段。
 */
export function isTeamWakeupConfig(value: unknown): value is TeamWakeupConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  const fields = Object.keys(TEAM_WAKEUP_MINIMUMS) as Array<keyof TeamWakeupConfig>
  const config = value as Record<string, unknown>
  return keys.length === fields.length && fields.every((key) => {
    const field = config[key]
    return Object.hasOwn(config, key) && typeof field === "number" &&
      Number.isSafeInteger(field) && field >= TEAM_WAKEUP_MINIMUMS[key]
  })
}
