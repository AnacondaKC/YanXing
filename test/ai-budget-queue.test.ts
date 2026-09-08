import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(tmpdir() + '/yanxing-budget-')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'budget-test.sqlite')

const { migrateDatabase, getDatabase } = await import('../lib/db/client')
const { createOrUpdateUser } = await import('../lib/auth/session')
const {
  cancelJob,
  claimNextJob,
  createProjectForUser,
  createReportJob,
  updateProject,
  deleteProject,
  deleteReportVersion,
  failAnalysisJob,
  getJob,
  getJobEvents,
  markAnalysisAiCallStarted,
  recordAnalysisAiCallCompleted,
  releaseJobLease,
  updateAnalysisJob,
} = await import('../lib/db/repository')
const {
  markAiBudgetUncertain,
  reconcileAiBudgetForJobInDatabase,
  reconcileAiBudgets,
  reconcileAiBudgetsIfDue,
  releaseUncertainAiBudgetReservation,
  settleAiBudgetForJobInDatabase,
} = await import('../lib/ai/budget')

migrateDatabase()
const now = () => new Date().toISOString()

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function createOwner() {
  return createOrUpdateUser({ username: 'budget-owner-' + Math.random().toString(36).slice(2, 9), displayName: '预算测试负责人', password: 'password-budget-123', role: 'researcher' })
}

function createJob() {
  const owner = createOwner()
  const project = createProjectForUser({ title: '预算测试课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  updateProject(project.id, {
    objective: '识别关键问题并形成决策建议',
    description: '围绕行业现状、风险与实施条件开展研究',
    milestones: [{ id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' }],
  })
  const source = {
    path: path.join(directory, 'source-' + Math.random().toString(36).slice(2) + '.docx'),
    fileName: 'budget.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 100,
    sha256: 'budget-hash-' + Math.random().toString(36).slice(2),
  }
  const created = createReportJob({
    projectId: project.id,
    fileName: source.fileName,
    source: source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    deliveryType: undefined,
    actor: owner,
  })
  assert.ok(created.job)
  return { owner, job: created.job, project }
}

test('expired leases schedule exponential backoff before reclaim', () => {
  const { job, owner } = createJob()
  assert.equal(claimNextJob('budget-worker-a', 60_000)?.id, job.id)
  getDatabase().prepare('UPDATE analysis_jobs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id)
  assert.equal(claimNextJob('budget-worker-b', 60_000), undefined)
  const delayed = getDatabase().prepare('SELECT status, attempts, available_at, last_retry_reason FROM analysis_jobs WHERE id = ?').get(job.id) as { status: string; attempts: number; available_at: string; last_retry_reason: string }
  assert.equal(delayed.status, 'queued')
  assert.equal(delayed.attempts, 1)
  assert.equal(delayed.last_retry_reason, 'lease_expired')
  assert.ok(Date.parse(delayed.available_at) > Date.now())
  getDatabase().prepare('UPDATE analysis_jobs SET available_at = ? WHERE id = ?').run(now(), job.id)
  assert.equal(claimNextJob('budget-worker-b', 60_000)?.attempts, 2)
  assert.equal(cancelJob(job.id, owner)?.status, 'cancelled')
})

test('exhausted attempts become explicit dead letters', () => {
  const { job, owner } = createJob()
  getDatabase().prepare('UPDATE analysis_jobs SET attempts = 4 WHERE id = ?').run(job.id)
  assert.equal(claimNextJob('budget-worker-limit', 60_000)?.attempts, 5)
  assert.equal(releaseJobLease(job.id, 'budget-worker-limit'), true)
  const terminal = getJob(job.id)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.terminalReason, 'dead_letter')
  assert.ok(terminal?.terminalAt)
  assert.equal(getJobEvents(job.id).at(-1)?.type, 'failed')
  assert.equal(cancelJob(job.id, owner)?.status, 'failed')
})

test('cancellation releases a pre-call reservation', () => {
  const { job, owner } = createJob()
  const before = getDatabase().prepare('SELECT state FROM ai_budget_ledger WHERE job_id = ?').get(job.id) as { state: string }
  assert.equal(before.state, 'reserved')
  assert.equal(cancelJob(job.id, owner)?.status, 'cancelled')
  const after = getDatabase().prepare('SELECT state, reconciliation_reason FROM ai_budget_ledger WHERE job_id = ?').get(job.id) as { state: string; reconciliation_reason: string }
  assert.equal(after.state, 'released')
  assert.equal(after.reconciliation_reason, 'job_cancelled')
})

test('in-flight AI calls stay uncertain and are never reclaimed automatically', () => {
  const { job, owner } = createJob()
  assert.equal(claimNextJob('budget-worker-ai', 60_000)?.id, job.id)
  markAnalysisAiCallStarted(job.id, { provider: 'test', model: 'test-model', stage: 'page_analysis', module: 'page_analysis', attempt: 1 }, 'budget-worker-ai')
  getDatabase().prepare('UPDATE analysis_jobs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id)
  assert.equal(claimNextJob('budget-worker-reclaimer', 60_000), undefined)
  const terminal = getJob(job.id)
  assert.equal(terminal?.status, 'failed')
  assert.equal(terminal?.terminalReason, 'dead_letter')
  const ledger = getDatabase().prepare('SELECT state, model_calls_started, model_calls_completed FROM ai_budget_ledger WHERE job_id = ?').get(job.id) as { state: string; model_calls_started: number; model_calls_completed: number }
  assert.equal(ledger.state, 'uncertain')
  assert.equal(ledger.model_calls_started, 1)
  assert.equal(ledger.model_calls_completed, 0)
  assert.equal(cancelJob(job.id, owner)?.status, 'failed')
})

test('known completed calls reconcile exactly once', () => {
  const { job, owner } = createJob()
  assert.equal(claimNextJob('budget-worker-known', 60_000)?.id, job.id)
  markAnalysisAiCallStarted(job.id, { provider: 'test', model: 'test-model', stage: 'page_analysis', module: 'page_analysis', attempt: 1 }, 'budget-worker-known')
  recordAnalysisAiCallCompleted(job.id, { provider: 'test', model: 'test-model', stage: 'page_analysis', module: 'page_analysis', attempt: 1, tokens: 123 }, 'budget-worker-known')
  assert.equal(failAnalysisJob(job.id, 'known failure', 'budget-worker-known')?.status, 'failed')
  const ledger = getDatabase().prepare('SELECT state, actual_tokens FROM ai_budget_ledger WHERE job_id = ?').get(job.id) as { state: string; actual_tokens: number }
  assert.equal(ledger.state, 'settled')
  assert.equal(ledger.actual_tokens, 123)
  assert.equal(reconcileAiBudgetForJobInDatabase(getDatabase(), job.id, 'repeat'), 'unchanged')
  assert.equal(cancelJob(job.id, owner)?.status, 'failed')
})

function openBudgetLedgerIds() {
  return (getDatabase().prepare("SELECT id FROM ai_budget_ledger WHERE state IN ('reserved', 'uncertain') ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id)
}

test('final settlement is idempotent and uncertain release remains explicit', () => {
  const first = createJob()
  assert.ok(first.job.admissionId)
  assert.equal(settleAiBudgetForJobInDatabase(getDatabase(), first.job.id, 7), true)
  assert.equal(settleAiBudgetForJobInDatabase(getDatabase(), first.job.id, 99), false)
  const settled = getDatabase().prepare('SELECT state, actual_tokens FROM ai_budget_ledger WHERE id = ?').get(first.job.admissionId) as { state: string; actual_tokens: number }
  assert.equal(settled.state, 'settled')
  assert.equal(settled.actual_tokens, 7)
  assert.equal(markAiBudgetUncertain(first.job.admissionId!), false)

  const second = createJob()
  const reservation = second.job.admissionId!
  assert.equal(markAiBudgetUncertain(reservation), true)
  const openIds = openBudgetLedgerIds()
  assert.ok(openIds.includes(reservation))
  const report = reconcileAiBudgets(new Date(Date.now() + 1_000))
  assert.equal(report.scanned, openIds.length)
  assert.equal(getDatabase().prepare('SELECT state FROM ai_budget_ledger WHERE id = ?').get(reservation)?.state, 'uncertain')
  assert.ok(report.uncertain >= 1)
  assert.ok(report.unresolved >= 1)
  assert.equal(releaseUncertainAiBudgetReservation(reservation), true)
  assert.equal(getDatabase().prepare('SELECT state FROM ai_budget_ledger WHERE id = ?').get(reservation)?.state, 'released')
  assert.equal(cancelJob(second.job.id, second.owner)?.status, 'cancelled')
})

test('terminal job updates persist observability and reconcile no-call budgets', () => {
  const { job, owner } = createJob()
  const worker = 'budget-worker-update'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)
  const updated = updateAnalysisJob(job.id, { status: 'completed', stage: 'completed', stageIndex: 9, errorMessage: 'manual terminal update' }, worker)
  assert.equal(updated?.status, 'completed')
  assert.equal(updated?.terminalReason, 'completed')
  assert.ok(updated?.terminalAt)
  assert.equal(updated?.lastErrorCode, 'job_update')
  assert.equal(updated?.errorMessage, 'manual terminal update')
  assert.equal(getDatabase().prepare('SELECT state FROM ai_budget_ledger WHERE job_id = ?').get(job.id)?.state, 'released')
  assert.equal(cancelJob(job.id, owner)?.status, 'completed')
})

test('report deletion reconciles associated job budgets before cascade', async () => {
  const { job, owner, project } = createJob()
  const report = getDatabase().prepare('SELECT id FROM report_versions WHERE id = ?').get(job.reportVersionId) as { id: string }
  assert.equal(report.id, job.reportVersionId)
  assert.equal(await deleteReportVersion(report.id, { actor: owner }), true)
  assert.equal(getDatabase().prepare('SELECT state FROM ai_budget_ledger WHERE job_id = ?').get(job.id)?.state, 'released')
  assert.equal(getDatabase().prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id) !== undefined, true)
})

test('project deletion reconciles associated job budgets before cascade', async () => {
  const { job, project } = createJob()
  assert.equal(getDatabase().prepare('SELECT state FROM ai_budget_ledger WHERE job_id = ?').get(job.id)?.state, 'reserved')
  assert.equal(await deleteProject(project.id), true)
  const ledger = getDatabase().prepare('SELECT state, reconciliation_reason FROM ai_budget_ledger WHERE job_id = ?').get(job.id) as { state: string; reconciliation_reason: string }
  assert.equal(ledger.state, 'released')
  assert.equal(ledger.reconciliation_reason, 'project_deleted')
})

test('reconciliation clock advances only after a successful pass', () => {
  createJob()
  getDatabase().exec('PRAGMA query_only = ON')
  try {
    assert.throws(() => reconcileAiBudgetsIfDue(1_000_000))
  } finally {
    getDatabase().exec('PRAGMA query_only = OFF')
  }
  const report = reconcileAiBudgetsIfDue(1_000_001)
  assert.ok(report)
  assert.equal(reconcileAiBudgetsIfDue(1_000_002), undefined)
})

test('terminal job event insert failure rolls back the status change', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const { job } = createJob()
  const worker = 'budget-worker-event-full'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)
  getDatabase().exec(`CREATE TEMP TRIGGER fail_terminal_job_events BEFORE INSERT ON job_events WHEN NEW.type = 'failed' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;`)
  try {
    assert.throws(() => failAnalysisJob(job.id, 'disk full', worker), /disk is full/)
    assert.equal(getJob(job.id)?.status, 'running')
  } finally {
    getDatabase().exec('DROP TRIGGER IF EXISTS fail_terminal_job_events')
  }
})
