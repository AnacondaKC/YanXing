import type { DatabaseSync } from 'node:sqlite'
import { getAiBudgetSevenDayStartKey, isAiBudgetLimits, isValidAiBudgetLimit, type AiBudgetLimits, type AiBudgetSettings, type AiBudgetSettingsResponse } from '@/lib/ai/budget-settings'
import { runtimeConfig } from '@/lib/config/environment'
import { getDatabase, inImmediateTransaction } from '@/lib/db/client'
import { pageAnalysisModule } from '@/modules/analysis/modules'

export class AiBudgetSettingsRevisionConflictError extends Error {
  constructor(readonly actualRevision: number) {
    super('预算设置已被其他管理员更新，请刷新后重试。')
    this.name = 'AiBudgetSettingsRevisionConflictError'
  }
}

export class AiBudgetSettingsAccessError extends Error {
  constructor() {
    super('需要有效的管理员权限。')
    this.name = 'AiBudgetSettingsAccessError'
  }
}

export function getAiBudgetLimits(database: DatabaseSync = getDatabase()): AiBudgetLimits {
  const { dailyTokens, sevenDayTokens } = getAiBudgetSettings(database)
  return { dailyTokens, sevenDayTokens }
}

export function getAiBudgetSettings(database: DatabaseSync = getDatabase()): AiBudgetSettings {
  const rows = database.prepare(
    'SELECT id, daily_tokens AS dailyTokens, seven_day_tokens AS sevenDayTokens, revision, updated_at AS updatedAt, updated_by AS updatedBy FROM ai_budget_settings LIMIT 2',
  ).all()
  if (rows.length === 0) {
    const { dailyTokens, sevenDayTokens } = runtimeConfig.ai
    const defaults = { dailyTokens, sevenDayTokens }
    if (!isAiBudgetLimits(defaults)) throw new Error('AI 默认预算配置无效。')
    return { ...defaults, revision: 1, updatedAt: null, updatedBy: null }
  }
  const row = rows[0]
  const limits = { dailyTokens: row.dailyTokens, sevenDayTokens: row.sevenDayTokens }
  if (rows.length !== 1 || row.id !== 1 || !isAiBudgetLimits(limits)
    || !isValidAiBudgetLimit(row.revision) || row.revision < 2
    || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))
    || typeof row.updatedBy !== 'string' || !row.updatedBy.trim()) {
    throw new Error('AI 预算设置存储无效。')
  }
  return {
    ...limits,
    revision: row.revision, updatedAt: row.updatedAt, updatedBy: row.updatedBy,
  }
}

export function getAiBudgetUsage(database: DatabaseSync, input: {
  userId: string
  periodKey: string
}): AiBudgetLimits {
  if (typeof input.userId !== 'string' || !input.userId.trim()) throw new Error('AI 预算统计用户无效。')
  const sevenDayStartKey = getAiBudgetSevenDayStartKey(input.periodKey)
  const usage = database.prepare(
    `
    SELECT
      COALESCE(SUM(CASE WHEN period_key = ? THEN tokens ELSE 0 END), 0) AS dailyTokens,
      COALESCE(SUM(tokens), 0) AS sevenDayTokens
    FROM (
      SELECT period_key, CASE WHEN state = 'reserved' THEN reserved_tokens ELSE COALESCE(actual_tokens, reserved_tokens) END AS tokens
      FROM ai_budget_ledger
      WHERE user_id = ? AND state != 'released' AND period_key BETWEEN ? AND ?
    )
    `,
  ).get(input.periodKey, input.userId, sevenDayStartKey, input.periodKey) as unknown as AiBudgetLimits
  if (!usage || Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('AI 预算用量存储无效。')
  }
  return { ...usage }
}

export function getAiBudgetSettingsResponse(userId: string, database: DatabaseSync = getDatabase()): AiBudgetSettingsResponse {
  const periodKey = new Date().toISOString().slice(0, 10)
  const aiConfig = runtimeConfig.ai
  const reservation = {
    analysisTokens: aiConfig.pageAnalysisEstimatedTokens * pageAnalysisModule.maxAttempts,
    insightTokens: aiConfig.insightEstimatedTokens,
  }
  if (!Object.values(reservation).every(isValidAiBudgetLimit)) throw new Error('AI 预算预留配置无效。')
  return {
    settings: getAiBudgetSettings(database),
    usage: getAiBudgetUsage(database, { userId, periodKey }),
    periodKey,
    sevenDayStartKey: getAiBudgetSevenDayStartKey(periodKey),
    reservation,
  }
}

export function saveAiBudgetSettings(input: {
  revision: number
  limits: AiBudgetLimits
  actorId: string
}): AiBudgetSettingsResponse {
  if (!isValidAiBudgetLimit(input.revision) || !isAiBudgetLimits(input.limits)) throw new Error('预算上限与版本必须为正安全整数。')
  return inImmediateTransaction((database) => {
    const actor = database.prepare("SELECT display_name, username FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(input.actorId)
    if (!actor) throw new AiBudgetSettingsAccessError()
    const current = getAiBudgetSettings(database)
    if (current.revision !== input.revision) throw new AiBudgetSettingsRevisionConflictError(current.revision)
    const revision = current.revision + 1
    if (!isValidAiBudgetLimit(revision)) throw new Error('预算设置版本已达到上限。')
    const { dailyTokens, sevenDayTokens } = input.limits
    database.prepare(`
      INSERT INTO ai_budget_settings(id, daily_tokens, seven_day_tokens, revision, updated_at, updated_by)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET daily_tokens = excluded.daily_tokens, seven_day_tokens = excluded.seven_day_tokens,
        revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(dailyTokens, sevenDayTokens, revision, new Date().toISOString(), String(actor.display_name || actor.username))
    return getAiBudgetSettingsResponse(input.actorId, database)
  })
}
