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

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { POST: postAnalysis } = await import('../app/api/reports/[reportId]/analyze/route')
const {
  cancelJob,
  claimNextJob,
  createInsightGenerationJob,
  createProjectForUser,
  createReportJob,
  getCurrentSnapshot,
  getJob,
  getReportInsight,
  startReportAnalysis,
  updateProject,
} = await import('../lib/db/repository')
const { getDatabase } = await import('../lib/db/client')
const { encryptSecret } = await import('../lib/db/settings-crypto')
const { processJob } = await import('../worker/job-processor')
import type { AuthUser } from '../lib/auth/session'
import type { AnalysisPromptConfig, PageAnalysisArtifact } from '../modules/contracts/analysis'
import { PromptBudgetError } from '../lib/ai/prompt-budget'

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

test('processJob repairs omitted mind-map leaves and publishes once without retry or content regeneration', async (context) => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-mindmap-normalization')
  const { report, job } = createReportJob({
    projectId: project.id, fileName: 'mindmap-normalization.docx', source,
    reportId: undefined, milestoneId: 'stage-1', autoAnalyze: true, actor: owner,
  })
  assert.ok(job)
  const worker = 'processor-mindmap-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)

  const expected = createPageAnalysisFixture()
  expected['思维导图']['子节点'] = [
    ...[3, 6, 3, 3].map((count, branch) => ({
      '名称': `分支${branch}`,
      '子节点': Array.from({ length: count }, (_, leaf) => ({ '名称': `结论${branch}-${leaf}`, '子节点': [] })),
    })),
    { '名称': '独立结论', '子节点': [] },
  ]
  const response = JSON.stringify(expected, (key, value) => key === '子节点' && Array.isArray(value) && value.length === 0 ? undefined : value)
  const audit = context.mock.method(console, 'info', () => undefined)
  let providerCalls = 0
  await withMockedFetch(async () => {
    providerCalls += 1
    return chatCompletionResponse(response, 15)
  }, async () => {
    await processJob(job.id, { leaseOwner: worker })
  })

  assert.equal(providerCalls, 1)
  assert.equal(getJob(job.id)?.status, 'completed')
  assert.equal(getJob(job.id)?.aiCallsCompleted, 1)
  assert.equal(budgetLedger(job.id).model_calls_completed, 1)
  assert.equal(budgetLedger(job.id).accounted_tokens, 15)
  const artifacts = getDatabase().prepare('SELECT status, attempt, payload_json FROM analysis_artifacts WHERE job_id = ?').all(job.id) as { status: string; attempt: number; payload_json: string }[]
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].status, 'accepted')
  assert.equal(artifacts[0].attempt, 1)
  const saved = JSON.parse(artifacts[0].payload_json) as PageAnalysisArtifact
  for (const key of ['思维导图', '综合评分', '报告完整度', '报告详情', '热力图', 'AI建议'] as const) {
    assert.deepEqual(saved[key], expected[key])
  }
  const snapshot = getCurrentSnapshot(report.id)
  assert.ok(snapshot)
  assert.equal(snapshot.payload.visualization.mindMap.children.length, 5)
  assert.equal(snapshot.payload.visualization.mindMap.children[1].children.length, 6)
  const events = getDatabase().prepare('SELECT type, message FROM job_events WHERE job_id = ?').all(job.id) as { type: string; message: string }[]
  assert.equal(events.some((event) => ['module_retrying', 'module_failed', 'failed'].includes(event.type)), false)
  assert.ok(events.some((event) => event.type === 'info' && event.message.includes('已自动补齐 16 个')))
  const repairLog = audit.mock.calls.find((call) => call.arguments[0] === '[analysis:mindmap-normalized]')
  assert.ok(repairLog)
  const expectedPaths = [
    ...[3, 6, 3, 3].flatMap((count, branch) => Array.from({ length: count }, (_, leaf) => `/思维导图/子节点/${branch}/子节点/${leaf}/子节点`)),
    '/思维导图/子节点/4/子节点',
  ]
  assert.deepEqual(JSON.parse(String(repairLog.arguments[1])), { jobId: job.id, attempt: 1, count: 16, paths: expectedPaths })
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

test('processJob still rejects malformed mind-map children after bounded retries', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-mindmap-invalid')
  const { report, job } = createReportJob({
    projectId: project.id, fileName: 'mindmap-invalid.docx', source,
    reportId: undefined, milestoneId: 'stage-1', autoAnalyze: true, actor: owner,
  })
  assert.ok(job)
  const worker = 'processor-mindmap-invalid-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)
  const malformed = {
    ...createPageAnalysisFixture(),
    '思维导图': { '名称': '根', '子节点': [{ '名称': '错误类型', '子节点': null }] },
  }
  let providerCalls = 0
  await withMockedFetch(async () => {
    providerCalls += 1
    return chatCompletionResponse(JSON.stringify(malformed), 15)
  }, async () => {
    await processJob(job.id, { leaseOwner: worker })
  })
  assert.equal(providerCalls, 3)
  assert.equal(getJob(job.id)?.status, 'failed')
  assert.equal(getCurrentSnapshot(report.id), undefined)
  assert.equal(budgetLedger(job.id).model_calls_completed, 3)
  assert.equal(budgetLedger(job.id).accounted_tokens, 45)
  const artifacts = getDatabase().prepare('SELECT status, payload_json FROM analysis_artifacts WHERE job_id = ?').all(job.id) as { status: string; payload_json: string }[]
  assert.equal(artifacts.length, 3)
  for (const artifact of artifacts) {
    assert.equal(artifact.status, 'failed')
    assert.deepEqual(JSON.parse(artifact.payload_json)['思维导图'], malformed['思维导图'])
  }
})

test('schema retry feeds the exact nested field path back to the model', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-schema-path')
  const { job } = createReportJob({ projectId: project.id, fileName: 'schema-path.docx', source, reportId: undefined, milestoneId: 'stage-1', autoAnalyze: true, actor: owner })
  assert.ok(job)
  const worker = 'processor-schema-path-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)
  const valid = createPageAnalysisFixture()
  const invalid = { ...valid, '思维导图': { '名称': '根', '子节点': [{ '名称': '分支', '子节点': null }] } }
  let calls = 0
  await withMockedFetch(async (_url, init) => {
    if (calls === 1) {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      const prompt = body.messages.find((message) => message.role === 'user')?.content
      assert.ok(prompt?.includes('修正以下门禁错误：'))
      assert.ok(prompt?.includes('\"path\":\"/思维导图/子节点/0/子节点\"'))
      assert.equal(prompt?.includes('\"path\":\"/\"'), false)
    }
    calls += 1
    return chatCompletionResponse(JSON.stringify(calls === 1 ? invalid : valid), 15)
  }, async () => { await processJob(job.id, { leaseOwner: worker }) })
  assert.equal(calls, 2)
  assert.equal(getJob(job.id)?.status, 'completed')
})

test('old frozen context fails once without provider usage or rewriting the frozen configuration', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-old-context')
  const { report, job } = createReportJob({ projectId: project.id, fileName: 'old-context.docx', source, reportId: undefined, milestoneId: 'stage-1', autoAnalyze: true, actor: owner })
  assert.ok(job)
  const db = getDatabase()
  const stored = db.prepare('SELECT model_runtime_json, prompt_config_json FROM analysis_jobs WHERE id = ?').get(job.id) as { model_runtime_json: string; prompt_config_json: string }
  const runtime = { ...JSON.parse(stored.model_runtime_json), maxContextCharacters: 8_000, maxOutputTokens: 131_072 }
  const prompts = (JSON.parse(stored.prompt_config_json) as AnalysisPromptConfig[]).map((prompt) => ({ ...prompt, systemPrompt: '研'.repeat(4_500) }))
  const frozenRuntime = JSON.stringify(runtime)
  const frozenPrompts = JSON.stringify(prompts)
  db.prepare('UPDATE analysis_jobs SET model_runtime_json = ?, prompt_config_json = ? WHERE id = ?').run(frozenRuntime, frozenPrompts, job.id)
  const worker = 'processor-old-context-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)
  let calls = 0
  await withMockedFetch(async () => { calls += 1; return chatCompletionResponse('{}', 15) }, async () => { await processJob(job.id, { leaseOwner: worker }) })
  assert.equal(calls, 0)
  assert.equal(getJob(job.id)?.status, 'failed')
  assert.match(getJob(job.id)?.errorMessage ?? '', /至少需要.*上限为 8000/)
  assert.equal(getCurrentSnapshot(report.id), undefined)
  const ledger = budgetLedger(job.id)
  assert.equal(ledger.model_calls_started, 0)
  assert.equal(ledger.model_calls_completed, 0)
  assert.equal(ledger.accounted_tokens, 0)
  const artifacts = db.prepare('SELECT gate_errors_json FROM analysis_artifacts WHERE job_id = ?').all(job.id) as { gate_errors_json: string }[]
  assert.equal(artifacts.length, 1)
  assert.equal(JSON.parse(artifacts[0].gate_errors_json)[0].code, 'PROMPT_CONTEXT_EXCEEDED')
  const after = db.prepare('SELECT model_runtime_json, prompt_config_json FROM analysis_jobs WHERE id = ?').get(job.id) as typeof stored
  assert.equal(after.model_runtime_json === frozenRuntime, true)
  assert.equal(after.prompt_config_json === frozenPrompts, true)
})

test('admission rejects an incompatible saved configuration before queue or budget mutations', async () => {
  ensureProcessorApiKey()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = await createStoredReportSource('processor-admission-context')
  const { report } = createReportJob({ projectId: project.id, fileName: 'admission-context.docx', source, reportId: undefined, milestoneId: 'stage-1', autoAnalyze: false, actor: owner })
  const db = getDatabase()
  const oldPrompts = db.prepare('SELECT target, system_prompt FROM ai_prompt_settings').all() as { target: string; system_prompt: string }[]
  const oldModels = db.prepare('SELECT id, max_context_characters FROM ai_model_profiles').all() as { id: string; max_context_characters: number }[]
  const beforeJobs = db.prepare('SELECT COUNT(*) AS count FROM analysis_jobs').get()
  const beforeBudget = db.prepare('SELECT COUNT(*) AS count FROM ai_budget_ledger').get()
  try {
    db.prepare('UPDATE ai_prompt_settings SET system_prompt = ?').run('研'.repeat(4_500))
    db.prepare('UPDATE ai_model_profiles SET max_context_characters = 8000').run()
    assert.throws(() => startReportAnalysis(report.id, owner), PromptBudgetError)
    const session = createSession(owner.id)
    const response = await postAnalysis(new Request(`http://localhost/api/reports/${report.id}/analyze`, { method: 'POST', headers: { cookie: `${sessionCookieName}=${session.token}` } }), { params: Promise.resolve({ reportId: report.id }) })
    assert.equal(response.status, 409)
    const body = await response.json() as { code: string; requiredCharacters: number; maxContextCharacters: number; error: string }
    assert.equal(body.code, 'prompt_context_exceeded')
    assert.equal(body.maxContextCharacters, 8_000)
    assert.ok(body.requiredCharacters > body.maxContextCharacters)
    assert.match(body.error, /提高最大上下文或缩短提示词/)
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM analysis_jobs').get(), beforeJobs)
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM ai_budget_ledger').get(), beforeBudget)
  } finally {
    for (const row of oldPrompts) db.prepare('UPDATE ai_prompt_settings SET system_prompt = ? WHERE target = ?').run(row.system_prompt, row.target)
    for (const row of oldModels) db.prepare('UPDATE ai_model_profiles SET max_context_characters = ? WHERE id = ?').run(row.max_context_characters, row.id)
  }
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
