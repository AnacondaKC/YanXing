import type { AiBudgetLimits, AiBudgetSettings } from '@/lib/ai/budget-settings'

export type AiBudgetDraft = Record<keyof AiBudgetLimits, string>
export type AiBudgetFieldErrors = Partial<Record<keyof AiBudgetLimits, string>>
type BudgetValidation = { limits: AiBudgetLimits; errors: AiBudgetFieldErrors } | { limits: null; errors: AiBudgetFieldErrors }

export function parseBudgetTokens(value: string): number | null {
  if (!value || /\D/.test(value)) return null
  const tokens = Number(value)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null
}

export function budgetSettingsToDraft(settings: AiBudgetSettings): AiBudgetDraft {
  return {
    dailyTokens: String(settings.dailyTokens),
    sevenDayTokens: String(settings.sevenDayTokens),
  }
}

export function validateBudgetDraft(draft: AiBudgetDraft): BudgetValidation {
  const dailyTokens = parseBudgetTokens(draft.dailyTokens)
  const sevenDayTokens = parseBudgetTokens(draft.sevenDayTokens)
  const errors: AiBudgetFieldErrors = {}
  const tokenError = '请输入 1 至 9007199254740991 的整数。'
  if (dailyTokens === null) errors.dailyTokens = tokenError
  if (sevenDayTokens === null) errors.sevenDayTokens = tokenError
  if (dailyTokens === null || sevenDayTokens === null) return { limits: null, errors }
  return { limits: { dailyTokens, sevenDayTokens }, errors }
}
