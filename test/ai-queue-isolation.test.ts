import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = await mkdtemp(tmpdir() + '/yanxing-queue-isolation-')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'queue-isolation.sqlite')
process.env.YANXING_AI_USER_QUEUE_LIMIT = '1'

const { migrateDatabase, getDatabase } = await import('../lib/db/client')
const { createOrUpdateUser } = await import('../lib/auth/session')
const {
  AiBudgetError,
  estimateAnalysisBudget,
  reserveAiBudget,
} = await import('../lib/ai/budget')
const { createProjectForUser, createReportJob, updateProject, cancelJob } = await import('../lib/db/repository')

migrateDatabase()

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function createOwner() {
  return createOrUpdateUser({ username: 'queue-owner-' + Math.random().toString(36).slice(2, 8), displayName: '队列测试负责人', password: 'password-queue-123', role: 'researcher' })
}

function createStagedProject(owner: ReturnType<typeof createOwner>) {
  const project = createProjectForUser({
    title: '队列隔离课题',
    objective: '识别关键问题并形成决策建议',
    description: '围绕行业现状、风险与实施条件开展研究',
    ownerName: owner.displayName,
  }, owner.id)
  updateProject(project.id, {
    milestones: [{ id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' }],
  })
  return project;
}

test('analysis queue capacity counts full-analysis jobs only and leaves insight slots free', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const first = createReportJob({
    projectId: project.id,
    fileName: 'queue-first.docx',
    source: {
      path: path.join(directory, 'queue-first.docx'),
      fileName: 'queue-first.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'queue-first-hash',
    },
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    deliveryType: undefined,
    actor: owner,
  })
  // 用户级 analysis 队列已满（限制 1）；第二条完整分析被拒绝。
  assert.throws(() => createReportJob({
    projectId: project.id,
    fileName: 'queue-second.docx',
    source: {
      path: path.join(directory, 'queue-second.docx'),
      fileName: 'queue-second.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'queue-second-hash',
    },
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    deliveryType: undefined,
    actor: owner,
  }), (error: unknown) => error instanceof AiBudgetError && error.reason === 'queue')
  // 但 insight 队列独立：洞察预留不受 analysis 队列限制。
  const insightAdmission = reserveAiBudget({
    userId: owner.id,
    projectId: project.id,
    operation: 'insight',
    estimatedTokens: 100,
  })
  assert.ok(insightAdmission)
  assert.equal(first.job?.status, 'queued')
  // 清理：取消分析任务，释放预算。
  cancelJob(first.job!.id)
})

test('insight reservation does not consume the analysis queue', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const admission = reserveAiBudget({
    userId: owner.id,
    projectId: project.id,
    operation: 'insight',
    estimatedTokens: 100,
  })
  assert.ok(admission)
  // analysis 队列仍为空，可以正常入队完整分析。
  const analysis = createReportJob({
    projectId: project.id,
    fileName: 'queue-analysis.docx',
    source: {
      path: path.join(directory, 'queue-analysis.docx'),
      fileName: 'queue-analysis.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'queue-analysis-hash',
    },
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    deliveryType: undefined,
    actor: owner,
  })
  assert.ok(analysis.job)
  cancelJob(analysis.job!.id)
})

test('analysis budget estimates attempts per page-analysis contract', () => {
  const previousPerAttempt = process.env.YANXING_AI_PAGE_ANALYSIS_ESTIMATED_TOKENS
  try {
    delete process.env.YANXING_AI_PAGE_ANALYSIS_ESTIMATED_TOKENS
    const fallback = estimateAnalysisBudget(3)
    assert.equal(estimateAnalysisBudget(1).estimatedTokens, 100_000)
    assert.equal(fallback.estimatedTokens, 100_000 * 3)

    process.env.YANXING_AI_PAGE_ANALYSIS_ESTIMATED_TOKENS = '200000'
    const perAttempt = estimateAnalysisBudget(3)
    assert.equal(perAttempt.estimatedTokens, 600_000)
  } finally {
    if (previousPerAttempt === undefined) delete process.env.YANXING_AI_PAGE_ANALYSIS_ESTIMATED_TOKENS
    else process.env.YANXING_AI_PAGE_ANALYSIS_ESTIMATED_TOKENS = previousPerAttempt
  }
})

function snapshotAdmissionState(projectId: string, userId: string) {
  const database = getDatabase()
  return {
    reports: database.prepare('SELECT id, file_name, source_path FROM report_versions WHERE project_id = ? ORDER BY id').all(projectId),
    jobs: database.prepare(`
      SELECT id, report_version_id, status, admission_id
      FROM analysis_jobs
      WHERE report_version_id IN (SELECT id FROM report_versions WHERE project_id = ?)
      ORDER BY id
    `).all(projectId),
    ledgers: database.prepare('SELECT id, job_id, reserved_tokens, actual_tokens, state FROM ai_budget_ledger WHERE user_id = ? AND project_id = ? ORDER BY id').all(userId, projectId),
    allocations: database.prepare('SELECT owner_type, owner_id, size_bytes, source_path FROM storage_allocations WHERE project_id = ? ORDER BY owner_id').all(projectId),
    usage: database.prepare(`
      SELECT scope_type, scope_id, used_bytes, item_count, reserved_bytes
      FROM storage_usage
      WHERE (scope_type = 'user' AND scope_id = ?) OR (scope_type = 'project' AND scope_id = ?)
      ORDER BY scope_type, scope_id
    `).all(userId, projectId),
    reservations: database.prepare('SELECT id, expected_bytes, state FROM storage_reservations WHERE user_id = ? AND project_id = ? ORDER BY id').all(userId, projectId),
  }
}

test('full analysis enqueue rejects when the analysis queue is exhausted', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const first = createReportJob({
    projectId: project.id,
    fileName: 'exhaust-first.docx',
    source: {
      path: path.join(directory, 'exhaust-first.docx'),
      fileName: 'exhaust-first.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'exhaust-first-hash',
    },
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    deliveryType: undefined,
    actor: owner,
  })
  assert.ok(first.job)
  const baseline = snapshotAdmissionState(project.id, owner.id)
  const secondInput = {
    projectId: project.id,
    fileName: 'exhaust-second.docx',
    source: {
      path: path.join(directory, 'exhaust-second.docx'),
      fileName: 'exhaust-second.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'exhaust-second-hash',
    },
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    deliveryType: undefined,
    actor: owner,
  }
  assert.throws(
    () => createReportJob(secondInput),
    (error: unknown) => error instanceof AiBudgetError && error.reason === 'queue',
  )
  assert.deepEqual(snapshotAdmissionState(project.id, owner.id), baseline)
  cancelJob(first.job!.id)
  const retry = createReportJob(secondInput)
  assert.ok(retry.job)
  assert.equal(retry.job?.status, 'queued')
  cancelJob(retry.job!.id)
})
