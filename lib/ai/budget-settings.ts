export interface AiBudgetLimits {
  dailyTokens: number
  sevenDayTokens: number
}

export interface AiBudgetSettings extends AiBudgetLimits {
  revision: number
  updatedAt: string | null
  updatedBy: string | null
}

export interface AiBudgetSettingsResponse {
  settings: AiBudgetSettings
  usage: AiBudgetLimits
  periodKey: string
  sevenDayStartKey: string
  reservation: {
    analysisTokens: number
    insightTokens: number
  }
}

export function isValidAiBudgetLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isAiBudgetLimits(value: unknown): value is AiBudgetLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const limits = value as Record<string, unknown>
  const keys = Object.keys(limits)
  return keys.length === 2 && keys.includes('dailyTokens') && keys.includes('sevenDayTokens')
    && isValidAiBudgetLimit(limits.dailyTokens)
    && isValidAiBudgetLimit(limits.sevenDayTokens)
}

const PREVIOUS_DAYS_IN_SEVEN_DAY_WINDOW = 6

export function getAiBudgetSevenDayStartKey(periodKey: string): string {
  const date = new Date(periodKey + 'T00:00:00.000Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodKey) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== periodKey) {
    throw new Error('AI 预算统计日期无效。')
  }
  date.setUTCDate(date.getUTCDate() - PREVIOUS_DAYS_IN_SEVEN_DAY_WINDOW)
  return date.toISOString().slice(0, 10)
}
