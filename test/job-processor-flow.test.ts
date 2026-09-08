import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(tmpdir() + '/yanxing-processor-flow-')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'processor-flow.sqlite')
process.env.YANXING_CHAT_COMPLETIONS_API_KEY = 'sk-test-processor-key'
process.env.YANXING_CHAT_COMPLETIONS_MODEL = 'processor-model'
process.env.YANXING_CHAT_COMPLETIONS_BASE_URL = 'http://127.0.0.1:9/v1'

const { createOrUpdateUser } = await import('../lib/auth/session')
const {
  cancelJob,
  claimNextJob,
  createInsightGenerationJob,
  createProjectForUser,
  createReportJob,
  getCurrentSnapshot,
  getJob,
  getReportInsight,
  updateProject,
} = await import('../lib/db/repository')
const { getDatabase } = await import('../lib/db/client')
const { encryptSecret } = await import('../lib/db/settings-crypto')
const { processJob } = await import('../worker/job-processor')
import type { AuthUser } from '../lib/auth/session'
import type { PageAnalysisArtifact } from '../modules/contracts/analysis'

const now = () => new Date().toISOString()

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function createOwner() {
  return createOrUpdateUser({
    username: 'processor-' + Math.random().toString(36).slice(2, 8),
    displayName: '贯通测试负责人',
    password: 'password-processor-123',
    role: 'researcher',
  })
}

function createStagedProject(owner: AuthUser) {
  const project = createProjectForUser({
    title: '工作进程贯通课题',
    objective: '识别关键问题并形成决策建议',
    description: '围绕行业现状、风险与实施条件开展研究',
    ownerName: owner.displayName,
  }, owner.id)
  updateProject(project.id, {
    milestones: [{ id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' }],
  })
  return project
}

function createPageAnalysisFixture(): PageAnalysisArtifact {
  return {
    '综合评分': {
      '研究价值': 80,
      '方法严谨': 75,
      '证据质量': 82,
      '逻辑一致': 78,
      '结论强度': 72,
      '可执行性': 70,
      '主要影响因素': '证据质量影响综合表现',
    },
    '报告详情': {
      '章节': [{ '标题': '正文', '摘要': '分析项目投资方案与现金流安排。' }],
      '完整度结论': '整体完整度良好',
    },
    '报告完整度': {
      '研究目标': 80,
      '方法与数据': 75,
      '证据覆盖': 82,
      '分析结构': 78,
      '结论覆盖': 72,
      '风险与建议': 70,
      '主要缺口': '方法与建议仍需补充验证',
    },
    '思维导图': { '名称': '项目投资分析', '子节点': [{ '名称': '收益', '子节点': [] }, { '名称': '风险', '子节点': [] }] },
    '词云': Array.from({ length: 50 }, (_, index) => `主题${String.fromCodePoint(0x4e00 + index)}`),
    '热力图': [{
      '章节': '正文',
      '文献综述': 100,
      '定性分析': 55,
      '定量建模': 30,
      '案例研究': 0,
      '实地调研': 0,
      '对比分析': 45,
    }],
    'AI建议': ['补充现金流压力测试和风险缓释措施。'],
  }
}

function createRejectedPageAnalysis(): PageAnalysisArtifact {
  const accepted = createPageAnalysisFixture()
  return {
    ...accepted,
    '热力图': accepted['热力图'].map((row) => ({ ...row, '章节': '附录' })),
  }
}

async function createStoredReportSource(sha256: string) {
  const sourceDirectory = path.join(directory, 'stored-reports', sha256)
  const filePath = path.join(sourceDirectory, sha256 + '.docx')
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(filePath, 'stored report')
  const text = '投资方案与现金流安排。收益评估需要覆盖压力测试。风险缓释措施应可执行。'
  await writeFile(filePath + '.content.json', JSON.stringify({
    text,
    paragraphCount: 3,
    characterCount: text.length,
  }))
  return {
    path: filePath,
    fileName: sha256 + '.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 100,
    sha256,
  }
}

function ensureProcessorApiKey() {
  getDatabase().prepare('UPDATE ai_model_channels SET api_key_encrypted = ?').run(encryptSecret('sk-test-processor-key'))
}

function chatCompletionResponse(content: string, tokens = 11) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: tokens },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function withMockedFetch<T>(handler: typeof fetch, run: () => Promise<T>) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

function budgetLedger(jobId: string) {
  return getDatabase().prepare('SELECT state, accounted_tokens, model_calls_started, model_calls_completed FROM ai_budget_ledger WHERE job_id = ?').get(jobId) as {
    state: string
    accounted_tokens: number
    model_calls_started: number
    model_calls_completed: number
  }
}

function restoreRunningLease(jobId: string, workerId: string) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  getDatabase().prepare(`
    UPDATE analysis_jobs
    SET status = 'running', lease_owner = ?, lease_expires_at = ?, terminal_reason = NULL, terminal_at = NULL,
        error_message = NULL, cancel_requested = 0, latest_partial_snapshot_id = NULL, updated_at = ?
    WHERE id = ?
  `).run(workerId, expiresAt, now(), jobId)
}

function clearPublishedAnalysis(jobId: string, reportId: string) {
  getDatabase().prepare('UPDATE report_versions SET current_analysis_id = NULL WHERE id = ?').run(reportId)
  getDatabase().prepare('DELETE FROM analysis_snapshots WHERE job_id = ?').run(jobId)
}

test('processJob publishes a complete analysis and recovers from a lost snapshot without another provider call', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-analysis-success')
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'processor-analysis.docx',
    source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    actor: owner,
  })
  assert.ok(job)
  const worker = 'processor-analysis-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)

  let providerCalls = 0
  const payload = createPageAnalysisFixture()
  await withMockedFetch(async () => {
    providerCalls += 1
    return chatCompletionResponse(JSON.stringify(payload), 15)
  }, async () => {
    await processJob(job.id, { leaseOwner: worker })
  })
  assert.equal(providerCalls, 1)
  assert.equal(getJob(job.id)?.status, 'completed')
  assert.equal(getJob(job.id)?.aiCallsCompleted, 1)
  assert.equal(getJob(job.id)?.aiTokens, 15)
  assert.ok(getCurrentSnapshot(report.id))
  const settled = budgetLedger(job.id)
  assert.equal(settled.state, 'settled')
  assert.equal(settled.model_calls_completed, 1)
  assert.equal(settled.accounted_tokens, 15)

  clearPublishedAnalysis(job.id, report.id)
  restoreRunningLease(job.id, worker)
  await withMockedFetch(async () => {
    providerCalls += 1
    return chatCompletionResponse(JSON.stringify(payload), 15)
  }, async () => {
    await processJob(job.id, { leaseOwner: worker })
  })
  assert.equal(providerCalls, 1)
  assert.equal(getJob(job.id)?.status, 'completed')
  assert.ok(getCurrentSnapshot(report.id))
  assert.equal(budgetLedger(job.id).model_calls_completed, 1)
})

test('processJob retries a gate failure then publishes the accepted analysis', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-analysis-retry')
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'processor-retry.docx',
    source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    actor: owner,
  })
  assert.ok(job)
  const worker = 'processor-retry-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)

  const payloads = [createRejectedPageAnalysis(), createPageAnalysisFixture()]
  let providerCalls = 0
  await withMockedFetch(async () => {
    const payload = payloads[providerCalls] ?? payloads.at(-1)
    providerCalls += 1
    return chatCompletionResponse(JSON.stringify(payload), 9)
  }, async () => {
    await processJob(job.id, { leaseOwner: worker })
  })
  assert.equal(providerCalls, 2)
  assert.equal(getJob(job.id)?.status, 'completed')
  assert.equal(getJob(job.id)?.aiCallsCompleted, 2)
  assert.equal(getJob(job.id)?.aiTokens, 22)
  assert.ok(getCurrentSnapshot(report.id))
  const ledger = budgetLedger(job.id)
  assert.equal(ledger.state, 'settled')
  assert.equal(ledger.model_calls_started, 2)
  assert.equal(ledger.model_calls_completed, 2)
})

test('processJob settles analysis usage after cancel without publishing a snapshot', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-analysis-cancel')
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'processor-cancel.docx',
    source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    actor: owner,
  })
  assert.ok(job)
  const worker = 'processor-cancel-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)

  await withMockedFetch(async () => {
    cancelJob(job.id)
    return chatCompletionResponse(JSON.stringify(createPageAnalysisFixture()), 13)
  }, async () => {
    await assert.rejects(() => processJob(job.id, { leaseOwner: worker }), /Analysis cancelled/)
  })
  assert.equal(getJob(job.id)?.status, 'cancelled')
  assert.equal(getJob(job.id)?.aiCallsCompleted, 1)
  assert.equal(getJob(job.id)?.aiTokens, 13)
  assert.equal(getCurrentSnapshot(report.id), undefined)
  const ledger = budgetLedger(job.id)
  assert.equal(ledger.state, 'settled')
  assert.equal(ledger.accounted_tokens, 13)
})

test('processJob publishes insight once and recovers the checkpoint without another provider call', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-insight-success')
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'processor-insight.docx',
    source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
    actor: owner,
  })
  const insightJob = createInsightGenerationJob(uploaded.report.id, owner)
  const worker = 'processor-insight-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, insightJob.id)

  let providerCalls = 0
  const markdown = '# 五分钟洞察\n\n这是用于贯通测试的洞察正文，覆盖结论与建议。'
  await withMockedFetch(async () => {
    providerCalls += 1
    return chatCompletionResponse(markdown, 21)
  }, async () => {
    await processJob(insightJob.id, { leaseOwner: worker })
  })
  assert.equal(providerCalls, 1)
  assert.equal(getJob(insightJob.id)?.status, 'completed')
  assert.equal(getJob(insightJob.id)?.aiTokens, 21)
  assert.equal(getReportInsight(uploaded.report.id)?.title, '五分钟洞察')
  assert.equal(budgetLedger(insightJob.id).state, 'settled')

  getDatabase().prepare('DELETE FROM report_insights WHERE report_version_id = ?').run(uploaded.report.id)
  restoreRunningLease(insightJob.id, worker)
  await withMockedFetch(async () => {
    providerCalls += 1
    return chatCompletionResponse(markdown, 21)
  }, async () => {
    await processJob(insightJob.id, { leaseOwner: worker })
  })
  assert.equal(providerCalls, 1)
  assert.equal(getJob(insightJob.id)?.status, 'completed')
  assert.equal(getReportInsight(uploaded.report.id)?.title, '五分钟洞察')
  assert.equal(budgetLedger(insightJob.id).model_calls_completed, 1)
})

test('processJob settles insight usage after cancel without publishing the article', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-insight-cancel')
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'processor-insight-cancel.docx',
    source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
    actor: owner,
  })
  const insightJob = createInsightGenerationJob(uploaded.report.id, owner)
  const worker = 'processor-insight-cancel-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, insightJob.id)

  await withMockedFetch(async () => {
    cancelJob(insightJob.id)
    return chatCompletionResponse('# 取消后洞察\n\n这段内容不应发布。', 13)
  }, async () => {
    await assert.rejects(() => processJob(insightJob.id, { leaseOwner: worker }), /Analysis cancelled/)
  })
  assert.equal(getJob(insightJob.id)?.status, 'cancelled')
  assert.equal(getJob(insightJob.id)?.aiCallsCompleted, 1)
  assert.equal(getReportInsight(uploaded.report.id), undefined)
  const ledger = budgetLedger(insightJob.id)
  assert.equal(ledger.state, 'settled')
  assert.equal(ledger.accounted_tokens, 13)
})
