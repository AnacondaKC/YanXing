import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { inImmediateTransaction } from '@/lib/db/client'
import { getAiBudgetLimits, getAiBudgetUsage } from '@/lib/db/ai-budget-settings-repository'
import { runtimeConfig } from '@/lib/config/environment'
import type { AiCallDetails } from '@/lib/ai/usage'

export type AiBudgetOperation = 'analysis' | 'insight'

export type AiBudgetInput = {
  userId: string
  projectId?: string | null
  operation: AiBudgetOperation
  jobId?: string
  reportVersionId?: string
  estimatedTokens: number
}

export type AiBudgetReconciliationReport = {
  scanned: number
  released: number
  settled: number
  extended: number
  uncertain: number
  unresolved: number
}

export type AiBudgetReconciliationResult = 'missing' | 'released' | 'settled' | 'uncertain' | 'unchanged'

export class AiBudgetError extends Error {
  constructor(readonly reason: 'budget' | 'queue' | 'reservation') {
    super(reason === 'queue' ? 'AI 任务队列已满，请稍后重试。' : reason === 'budget' ? 'AI 使用预算已用尽，请稍后重试。' : 'AI 预算预留已失效，请重试。')
    this.name = 'AiBudgetError'
  }
}

export function aiBudgetHttpFailure(error: AiBudgetError): {
  body: { error: string; code: string }
  status: number
  headers?: { 'Retry-After': string }
} {
  const isQueueOrBudget = error.reason === 'queue' || error.reason === 'budget'
  return {
    body: {
      error: error.message,
      code: error.reason === 'queue' ? 'AI_QUEUE_FULL' : error.reason === 'budget' ? 'AI_BUDGET_EXCEEDED' : 'AI_BUDGET_RESERVATION_FAILED',
    },
    status: isQueueOrBudget ? 429 : 409,
    ...(isQueueOrBudget ? { headers: { 'Retry-After': '30' } } : {}),
  }
}

let lastReconciliationAt = 0

export function estimateAnalysisBudget(maximumAttempts = 3) {
  const aiConfig = runtimeConfig.ai
  const estimatedTokens = aiConfig.pageAnalysisEstimatedTokens * Math.max(1, Math.trunc(maximumAttempts))
  return { estimatedTokens }
}

export function estimateInsightBudget() {
  const aiConfig = runtimeConfig.ai
  const estimatedTokens = aiConfig.insightEstimatedTokens
  return { estimatedTokens }
}

export function reserveAiBudget(input: AiBudgetInput): string {
  return inImmediateTransaction((database) => reserveAiBudgetInDatabase(database, input))
}

export function reserveAiBudgetInDatabase(database: DatabaseSync, input: AiBudgetInput): string {
  const aiConfig = runtimeConfig.ai
  if (!input.userId || !Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens <= 0) {
    throw new AiBudgetError('reservation')
  }
  const timestamp = new Date().toISOString()
  reconcileAiBudgetsInDatabase(database, timestamp)
  if (input.operation === 'analysis') {
    assertAnalysisQueueCapacity(database, input.userId, input.projectId)
  } else {
    const activeInsights = database.prepare(`
      SELECT COUNT(*) AS count FROM ai_budget_ledger
      WHERE operation = 'insight' AND state IN ('reserved', 'uncertain')
    `).get() as { count?: number } | undefined
    if (Number(activeInsights?.count ?? 0) >= aiConfig.insightQueueLimit) throw new AiBudgetError('queue')
  }

  const periodKey = timestamp.slice(0, 10)
  assertUserTokenCapacity(database, { userId: input.userId, periodKey, estimatedTokens: input.estimatedTokens })

  const id = 'ai-budget-' + randomUUID()
  database.prepare(`
    INSERT INTO ai_budget_ledger(
      id, job_id, report_version_id, user_id, project_id, operation, period_key,
      reserved_tokens, actual_tokens,
      state, available_at, expires_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?, '{}', ?, ?)
  `).run(
    id, input.jobId ?? null, input.reportVersionId ?? null, input.userId, input.projectId ?? null, input.operation, periodKey,
    input.estimatedTokens, timestamp, new Date(Date.now() + aiConfig.reservationTtlMs).toISOString(), timestamp, timestamp,
  )
  return id
}

/** 在真正调用 provider 前写入不可逆的 started 标记，防止租约丢失后盲目重试而重复调用。 */
export function markAiBudgetCallStartedForJobInDatabase(database: DatabaseSync, jobId: string, details: AiCallDetails = {}) {
  const timestamp = new Date().toISOString()
  const result = database.prepare(`
    UPDATE ai_budget_ledger
    SET call_started_at = COALESCE(call_started_at, ?),
        model_calls_started = model_calls_started + 1,
        last_provider = COALESCE(?, last_provider),
        last_model = COALESCE(?, last_model),
        last_stage = COALESCE(?, last_stage),
        last_module = COALESCE(?, last_module),
        last_attempt = COALESCE(?, last_attempt),
        updated_at = ?
    WHERE job_id = ? AND state = 'reserved'
  `).run(timestamp, details.provider ?? null, details.model ?? null, details.stage ?? null, details.module ?? null, details.attempt ?? null, timestamp, jobId)
  return Number(result.changes) === 1
}

/** provider 返回后立即记入已知消耗；只有 started 与 completed 数相等才可安全结算。 */
export function recordAiBudgetCallCompletedForJobInDatabase(database: DatabaseSync, jobId: string, details: AiCallDetails) {
  const tokens = details.tokens ?? 0
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new AiBudgetError('reservation')
  const timestamp = new Date().toISOString()
  const result = database.prepare(`
    UPDATE ai_budget_ledger
    SET call_completed_at = ?,
        model_calls_completed = model_calls_completed + 1,
        accounted_tokens = accounted_tokens + ?,
        last_provider = COALESCE(?, last_provider),
        last_model = COALESCE(?, last_model),
        last_stage = COALESCE(?, last_stage),
        last_module = COALESCE(?, last_module),
        last_attempt = COALESCE(?, last_attempt),
        updated_at = ?
    WHERE job_id = ? AND state IN ('reserved', 'uncertain') AND model_calls_completed < model_calls_started
  `).run(timestamp, tokens, details.provider ?? null, details.model ?? null, details.stage ?? null, details.module ?? null, details.attempt ?? null, timestamp, jobId)
  return Number(result.changes) === 1
}

export function touchAiBudgetReservationForJobInDatabase(database: DatabaseSync, jobId: string, timestamp = new Date().toISOString()) {
  const expiresAt = new Date(Date.parse(timestamp) + runtimeConfig.ai.reservationTtlMs).toISOString()
  const result = database.prepare(`
    UPDATE ai_budget_ledger SET expires_at = ?, updated_at = ?
    WHERE job_id = ? AND state = 'reserved'
  `).run(expiresAt, timestamp, jobId)
  return Number(result.changes) === 1
}

export function settleAiBudgetForJobInDatabase(database: DatabaseSync, jobId: string, actualTokens: number) {
  return settleAiBudgetInDatabase(database, { jobId, actualTokens })
}

export function settleAiBudgetInDatabase(database: DatabaseSync, input: { reservationId?: string; jobId?: string; actualTokens: number }) {
  if (!Number.isSafeInteger(input.actualTokens) || input.actualTokens < 0) throw new AiBudgetError('reservation')
  const where = input.reservationId ? 'id = ?' : 'job_id = ?'
  const key = input.reservationId ?? input.jobId
  if (!key) throw new AiBudgetError('reservation')
  const row = database.prepare(`SELECT state, model_calls_started, model_calls_completed, accounted_tokens FROM ai_budget_ledger WHERE ${where}`).get(key) as Record<string, unknown> | undefined
  if (!row || !['reserved', 'uncertain'].includes(String(row.state))) return false
  const state = String(row.state)
  const started = Number(row.model_calls_started ?? 0)
  const completed = Number(row.model_calls_completed ?? 0)
  if (completed < started) return false
  // uncertain 不能仅凭“没有记录调用”被当作已结算；需要人工确认释放，
  // 或者已有闭合的 provider 调用数据才能落 settled。
  if (state === 'uncertain' && completed === 0) return false
  const settledTokens = Math.max(input.actualTokens, Number(row.accounted_tokens ?? 0))
  const timestamp = new Date().toISOString()
  const result = database.prepare(`
    UPDATE ai_budget_ledger
    SET actual_tokens = ?, state = 'settled',
        reconciled_at = ?, reconciliation_reason = 'final_settlement', updated_at = ?
    WHERE ${where} AND state IN ('reserved', 'uncertain')
  `).run(settledTokens, timestamp, timestamp, key)
  return Number(result.changes) === 1
}

export function markAiBudgetUncertain(reservationId: string, reason = 'provider_outcome_unknown') {
  return inImmediateTransaction((database) => {
    const timestamp = new Date().toISOString()
    const result = database.prepare(`
      UPDATE ai_budget_ledger
      SET state = 'uncertain', uncertain_at = COALESCE(uncertain_at, ?), reconciliation_reason = ?, updated_at = ?
      WHERE id = ? AND state IN ('reserved', 'uncertain')
    `).run(timestamp, reason, timestamp, reservationId)
    return Number(result.changes) === 1
  })
}

export function markAiBudgetUncertainForJobInDatabase(database: DatabaseSync, jobId: string, reason = 'job_execution_unknown') {
  const timestamp = new Date().toISOString()
  const result = database.prepare(`
    UPDATE ai_budget_ledger
    SET state = 'uncertain', uncertain_at = COALESCE(uncertain_at, ?), reconciliation_reason = ?, updated_at = ?
    WHERE job_id = ? AND state IN ('reserved', 'uncertain')
  `).run(timestamp, reason, timestamp, jobId)
  return Number(result.changes) === 1
}

/** 只有确认 provider 未产生调用或 token 用量时，才允许释放 uncertain。 */
export function releaseUncertainAiBudgetReservation(reservationId: string, reason = 'operator_confirmed_no_token_usage') {
  return inImmediateTransaction((database) => {
    const timestamp = new Date().toISOString()
    const result = database.prepare(`
      UPDATE ai_budget_ledger SET state = 'released', reconciled_at = ?, reconciliation_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'uncertain'
    `).run(timestamp, reason, timestamp, reservationId)
    return Number(result.changes) === 1
  })
}

/** 根据已记录的调用计数，把终态任务的 reserved/uncertain 账本安全收敛到 settled 或 released。 */
export function reconcileAiBudgetForJobInDatabase(database: DatabaseSync, jobId: string, reason = 'job_terminal_reconciliation'): AiBudgetReconciliationResult {
  const row = database.prepare(`
    SELECT state, model_calls_started, model_calls_completed, accounted_tokens
    FROM ai_budget_ledger WHERE job_id = ?
  `).get(jobId) as Record<string, unknown> | undefined
  if (!row) return 'missing'
  const state = String(row.state)
  if (state === 'released' || state === 'settled' || state === 'dead_letter') return 'unchanged'
  const started = Number(row.model_calls_started ?? 0)
  const completed = Number(row.model_calls_completed ?? 0)
  const timestamp = new Date().toISOString()
  if (started > completed) {
    database.prepare(`
      UPDATE ai_budget_ledger SET state = 'uncertain', uncertain_at = COALESCE(uncertain_at, ?), reconciliation_reason = ?, updated_at = ?
      WHERE job_id = ? AND state IN ('reserved', 'uncertain')
    `).run(timestamp, reason + ':in_flight_call', timestamp, jobId)
    return 'uncertain'
  }
  if (completed > 0) {
    database.prepare(`
      UPDATE ai_budget_ledger SET state = 'settled', actual_tokens = ?,
        reconciled_at = ?, reconciliation_reason = ?, updated_at = ?
      WHERE job_id = ? AND state IN ('reserved', 'uncertain')
    `).run(Number(row.accounted_tokens ?? 0), timestamp, reason, timestamp, jobId)
    return 'settled'
  }
  if (state === 'reserved') {
    database.prepare(`
      UPDATE ai_budget_ledger SET state = 'released', reconciled_at = ?, reconciliation_reason = ?, updated_at = ?
      WHERE job_id = ? AND state = 'reserved'
    `).run(timestamp, reason, timestamp, jobId)
    return 'released'
  }
  return 'unchanged'
}

/**
 * 预算维护只释放明确没有 provider 调用的 reservation；未知结果永远保留为 uncertain，
 * 直到调用计数已闭合或人工明确对账，避免过早释放后重试造成重复调用。
 */
export function reconcileAiBudgets(at: Date | string = new Date()): AiBudgetReconciliationReport {
  const timestamp = typeof at === 'string' ? at : at.toISOString()
  return inImmediateTransaction((database) => reconcileAiBudgetsInDatabase(database, timestamp))
}

export function reconcileAiBudgetsIfDue(atMs = Date.now()) {
  if (atMs - lastReconciliationAt < runtimeConfig.ai.reconciliationIntervalMs) return undefined
  const report = reconcileAiBudgets(new Date(atMs))
  lastReconciliationAt = atMs
  return report
}

function reconcileAiBudgetsInDatabase(database: DatabaseSync, timestamp: string): AiBudgetReconciliationReport {
  const report: AiBudgetReconciliationReport = { scanned: 0, released: 0, settled: 0, extended: 0, uncertain: 0, unresolved: 0 }
  const rows = database.prepare(`
    SELECT ledger.id, ledger.job_id, ledger.state, ledger.expires_at,
      job.status AS job_status
    FROM ai_budget_ledger ledger
    LEFT JOIN analysis_jobs job ON job.id = ledger.job_id
    WHERE ledger.state IN ('reserved', 'uncertain')
  `).all() as Array<Record<string, unknown>>
  report.scanned = rows.length
  const timestampMs = Date.parse(timestamp)
  for (const row of rows) {
    const state = String(row.state)
    const jobId = typeof row.job_id === 'string' ? row.job_id : undefined
    const jobStatus = typeof row.job_status === 'string' ? row.job_status : undefined
    const hasTerminalJob = !jobId || !jobStatus || ['completed', 'failed', 'cancelled'].includes(jobStatus)
    if (state === 'uncertain') {
      if (!jobId || !hasTerminalJob) {
        report.unresolved += 1
        continue
      }
      const result = reconcileAiBudgetForJobInDatabase(database, jobId, 'maintenance_reconciliation')
      if (result === 'settled') report.settled += 1
      else if (result === 'released') report.released += 1
      else { report.uncertain += 1; report.unresolved += 1 }
      continue
    }
    if (hasTerminalJob) {
      if (!jobId) {
        const expiresAt = typeof row.expires_at === 'string' ? Date.parse(row.expires_at) : Number.NaN
        if (Number.isFinite(expiresAt) && expiresAt <= timestampMs) {
          const changed = database.prepare(`
            UPDATE ai_budget_ledger SET state = 'uncertain', uncertain_at = COALESCE(uncertain_at, ?),
              reconciliation_reason = 'reservation_expired_without_job', updated_at = ?
            WHERE id = ? AND state = 'reserved'
          `).run(timestamp, timestamp, String(row.id))
          if (Number(changed.changes) === 1) report.uncertain += 1
        } else {
          report.unresolved += 1
        }
        continue
      }
      const result = reconcileAiBudgetForJobInDatabase(database, jobId, 'terminal_job_reconciliation')
      if (result === 'settled') report.settled += 1
      else if (result === 'released') report.released += 1
      else if (result === 'uncertain') { report.uncertain += 1; report.unresolved += 1 }
      continue
    }
    const expiresAt = typeof row.expires_at === 'string' ? Date.parse(row.expires_at) : Number.NaN
    if (Number.isFinite(expiresAt) && expiresAt <= timestampMs && jobId) {
      if (touchAiBudgetReservationForJobInDatabase(database, jobId, timestamp)) report.extended += 1
    }
  }
  return report
}

function assertAnalysisQueueCapacity(database: DatabaseSync, userId: string, projectId?: string | null) {
  const { globalQueueLimit, userQueueLimit, projectQueueLimit } = runtimeConfig.ai
  const global = database.prepare(`
    SELECT COUNT(*) AS count FROM analysis_jobs
    WHERE status IN ('queued', 'running') AND type IN ('initial', 'rerun')
  `).get() as { count?: number } | undefined
  if (Number(global?.count ?? 0) >= globalQueueLimit) throw new AiBudgetError('queue')
  const user = database.prepare(`
    SELECT COUNT(*) AS count FROM analysis_jobs
    WHERE status IN ('queued', 'running') AND type IN ('initial', 'rerun') AND requested_by_user_id = ?
  `).get(userId) as { count?: number } | undefined
  if (Number(user?.count ?? 0) >= userQueueLimit) throw new AiBudgetError('queue')
  if (projectId) {
    const project = database.prepare(`
      SELECT COUNT(*) AS count
      FROM analysis_jobs
      INNER JOIN report_versions ON report_versions.id = analysis_jobs.report_version_id
      WHERE analysis_jobs.status IN ('queued', 'running') AND analysis_jobs.type IN ('initial', 'rerun') AND report_versions.project_id = ?
    `).get(projectId) as { count?: number } | undefined
    if (Number(project?.count ?? 0) >= projectQueueLimit) throw new AiBudgetError('queue')
  }
}

function assertUserTokenCapacity(database: DatabaseSync, input: { userId: string; periodKey: string; estimatedTokens: number }) {
  const limits = getAiBudgetLimits(database)
  const usage = getAiBudgetUsage(database, input)
  if (usage.dailyTokens + input.estimatedTokens > limits.dailyTokens
    || usage.sevenDayTokens + input.estimatedTokens > limits.sevenDayTokens) {
    throw new AiBudgetError('budget')
  }
}
