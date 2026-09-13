import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatCompletionsError } from '../lib/ai/runtime/errors'
import type { ModelRuntime } from '../lib/ai/model-router'
import type { StructuredModuleAgentInput, StructuredModuleAgentResult } from '../lib/ai/restricted-analysis-agent'
import type { AnalysisArtifactRecord, AnalysisPromptConfig, PageAnalysisArtifact } from '../modules/contracts/analysis'
import type { ReportInsightOutput } from '../modules/insights/domain'
import type { ReportSource } from '../modules/reports/domain'
import type { ReportSubmission } from '../modules/reports/submission-domain'
import { SubmissionTaskError, type SubmissionTask, type SubmissionTaskClaim, type SubmissionTaskResult, type SubmissionTaskSnapshot } from '../modules/reports/submission-task-domain'
import {
  SUBMISSION_TASK_DATA_KEYS,
  IncompleteProviderCallError,
  type SubmissionPreparedDocument,
  type SubmissionProviderCallLedger,
  type SubmissionTaskStore,
  type TaskCallReceipt,
  type TaskDataWrite,
} from '../modules/reports/submission-task-ports'
import { executeSubmissionTask } from '../worker/submission-executor'
import { createAnalysisExecutionRepository, createSubmissionTaskPort } from '../worker/submission-pipeline-repository'
import { runAnalysisExecution } from '../modules/analysis/pipeline'

const now = () => new Date().toISOString()

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
    '词云': Array.from({ length: 50 }, (_, index) => '主题' + String.fromCodePoint(0x4e00 + index)),
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

function createInsightHtml() {
  return '<h1>投资洞察</h1><blockquote>现金流压力仍是主要风险。</blockquote><h2>建议</h2><p>补充压力测试。</p>'
}

function createPrompt(target: AnalysisPromptConfig['target']): AnalysisPromptConfig {
  return {
    target,
    systemPrompt: '系统提示',
    instructionPrompt: '任务提示',
    version: 1,
    updatedAt: now(),
    updatedBy: 'tester',
  }
}

function createFrozen(operation: 'analysis' | 'insight', apiKeyEncrypted: string | null = null): SubmissionTaskSnapshot {
  return {
    prompts: [createPrompt(operation === 'insight' ? 'report_insight' : 'page_analysis')],
    modelRuntime: {
      target: operation === 'insight' ? 'report_insight' : 'page_analysis',
      channelId: 'channel-1',
      channelName: '测试通道',
      channel: 'chat_completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      modelId: 'model-1',
      modelName: 'test-model',
      maxContextCharacters: 8000,
      maxOutputTokens: 1024,
      reasoningEffort: 'low',
      apiKeyEncrypted,
      settingsRevision: 1,
    },
    evaluationContext: {
      projectId: 'project-1',
      projectTitle: '测试课题',
      researchObjective: '识别关键问题',
      researchBackground: '行业现状',
      milestone: {
        id: 'stage-1',
        title: '事实调研',
        targetDate: '2026-06-30',
        workAndExpectedOutcomes: '形成研究依据',
      },
    },
  }
}

function createReport(): ReportSubmission {
  return {
    id: 'report-1',
    projectId: 'project-1',
    stageId: 'stage-1',
    stageVersion: 1,
    submissionSequence: 1,
    submittedAs: 'update',
    title: '投资分析报告',
    fileName: 'report.docx',
    sourceKey: 'reports/report-1.docx',
    fileHash: 'a'.repeat(64),
    sourceSize: 12,
    paragraphCount: 3,
    characterCount: 40,
    submittedBy: 'user-1',
    submittedAt: now(),
    wasFirstStageSubmission: true,
  }
}

function createSource(report: ReportSubmission): ReportSource {
  return {
    path: '/tmp/yanxing-test-storage/' + report.sourceKey,
    fileName: report.fileName,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: report.sourceSize,
    sha256: report.fileHash,
  }
}

function createDocument(): SubmissionPreparedDocument {
  return {
    text: '投资方案与现金流安排。收益评估需要覆盖压力测试。风险缓释措施应可执行。',
    paragraphCount: 3,
    characterCount: 40,
  }
}

function createTask(operation: 'analysis' | 'insight'): SubmissionTask {
  return {
    id: 'task-1',
    reportId: 'report-1',
    projectId: 'project-1',
    actorId: 'user-1',
    operation,
    generation: 1,
    status: 'running',
    stage: 'validating',
    stageIndex: 0,
    attempts: 1,
    cancelRequested: false,
    createdAt: now(),
    updatedAt: now(),
  }
}

function testRuntime(): ModelRuntime {
  return {
    primary: {
      id: 'test-model',
      provider: 'chat_completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      maxContextCharacters: 8000,
      maxOutputTokens: 1024,
      reasoningEffort: 'low',
    },
    apiKey: 'sk-test',
    maxContextCharacters: 8000,
  }
}

type StoredCall = {
  attempt: number
  provider: string
  model: string
  state: 'started' | 'completed'
  leaseToken: string
}

class MemorySubmissionStore implements SubmissionTaskStore {
  taskLease: string
  data = new Map<string, unknown>()
  calls: StoredCall[] = []
  results: SubmissionTaskResult[] = []
  lateSettlements: TaskCallReceipt[] = []
  verifyCalls: Array<{ sourceKey: string; fileHash: string; sourceSize: number }> = []
  contentJsonWrites = 0

  constructor(
    readonly task: SubmissionTask,
    readonly frozen: SubmissionTaskSnapshot,
    readonly report: ReportSubmission,
    readonly source: ReportSource,
    readonly document: SubmissionPreparedDocument,
    readonly claim: SubmissionTaskClaim,
  ) {
    this.taskLease = claim.leaseToken
  }

  expireLease() { this.taskLease = 'other-lease' }
  requestCancel() { this.task.cancelRequested = true; this.task.updatedAt = now() }
  getTask(jobId: string) { return jobId === this.task.id ? this.task : undefined }
  getFrozen(jobId: string) {
    if (jobId !== this.task.id) throw new SubmissionTaskError('TASK_NOT_FOUND', '任务不存在。', 404)
    return this.frozen
  }
  getReport(reportId: string) { return reportId === this.report.id ? this.report : undefined }
  getSource(reportId: string) { return reportId === this.report.id ? this.source : undefined }
  getDocumentText(reportId: string) {
    if (reportId !== this.report.id || this.report.deletedAt) throw new SubmissionTaskError('REPORT_NOT_FOUND', '报告不存在或已撤回。', 404)
    return this.document
  }
  callLedger(jobId: string): SubmissionProviderCallLedger {
    if (jobId !== this.task.id) throw new SubmissionTaskError('TASK_NOT_FOUND', '任务不存在。', 404)
    const open = this.calls.find((call) => call.state === 'started')
    const moduleName = this.task.operation === 'insight' ? 'report_insight' : 'page_analysis'
    return {
      started: this.calls.length,
      completed: this.calls.filter((call) => call.state === 'completed').length,
      openIntent: open ? { attempt: open.attempt, stage: moduleName, module: moduleName, provider: open.provider, model: open.model } : undefined,
    }
  }
  readData(jobId: string, key: string) { return jobId === this.task.id ? this.data.get(key) : undefined }
  listData(jobId: string, prefix: string) {
    if (jobId !== this.task.id) return []
    return [...this.data.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value)
  }
  saveData(claim: SubmissionTaskClaim, data: TaskDataWrite[]) {
    this.requireLive(claim)
    for (const item of data) {
      if (item.key.startsWith('artifact:') && this.data.has(item.key)) continue
      this.data.set(item.key, item.value)
    }
  }
  beginCall(claim: SubmissionTaskClaim, input: { attempt: number; provider: string; model: string }) {
    this.requireLive(claim)
    if (this.calls.some((call) => call.state === 'started')) throw new SubmissionTaskError('AI_CALL_INCOMPLETE', '存在未完成的模型调用。')
    this.calls.push({ ...input, state: 'started', leaseToken: claim.leaseToken })
  }
  checkpoint(claim: SubmissionTaskClaim, receipt: TaskCallReceipt) {
    this.requireLive(claim)
    this.completeCall(claim, receipt)
    if (receipt.data) this.saveData(claim, receipt.data)
  }
  settleLateCall(claim: SubmissionTaskClaim, receipt: TaskCallReceipt) {
    const open = this.calls.find((item) => item.attempt === receipt.attempt && item.state === 'started' && item.leaseToken === claim.leaseToken)
    if (!open) {
      const completed = this.calls.find((item) => item.attempt === receipt.attempt && item.state === 'completed' && item.leaseToken === claim.leaseToken)
      if (completed) return
      throw new SubmissionTaskError('CALL_NOT_FOUND', '找不到对应的模型调用。')
    }
    this.lateSettlements.push(receipt)
    this.completeCall(claim, receipt)
  }
  progress(claim: SubmissionTaskClaim, input: { stage: SubmissionTask['stage']; stageIndex: number }) {
    this.requireLive(claim)
    this.task.stage = input.stage
    this.task.stageIndex = input.stageIndex
    this.task.updatedAt = now()
    return this.task
  }
  complete(claim: SubmissionTaskClaim, payload: unknown) {
    this.requireLive(claim)
    if (this.task.cancelRequested) throw new SubmissionTaskError('TASK_CANCELLED', '任务已请求取消。')
    if (this.callLedger(claim.jobId).openIntent) throw new SubmissionTaskError('AI_CALL_INCOMPLETE', '存在未完成的模型调用。')
    if (this.calls.filter((call) => call.state === 'completed').length < 1) throw new SubmissionTaskError('AI_CALL_INCOMPLETE', '没有已完成的模型调用。')
    if (this.task.status !== 'running') throw new SubmissionTaskError('TASK_TERMINAL_IMMUTABLE', '任务已结束。')
    const result: SubmissionTaskResult = { id: 'result-1', jobId: this.task.id, reportId: this.task.reportId, operation: this.task.operation, generation: this.task.generation, payload, createdAt: now() }
    this.results.push(result)
    this.task.status = 'completed'
    this.task.stage = 'completed'
    this.task.updatedAt = now()
    return result
  }
  fail(claim: SubmissionTaskClaim, code?: string) {
    this.requireLease(claim)
    if (this.task.cancelRequested) { this.task.status = 'cancelled'; this.task.errorCode = 'CANCELLED' }
    else { this.task.status = 'failed'; this.task.errorCode = code }
    this.task.updatedAt = now()
  }
  cancelled(claim: SubmissionTaskClaim) {
    if (this.task.status !== 'running') return true
    if (this.taskLease !== claim.leaseToken) return true
    return this.task.cancelRequested
  }
  recordProgress() {}
  seedOpenIntent() { this.calls.push({ attempt: 1, provider: 'chat_completions', model: 'test-model', state: 'started', leaseToken: this.claim.leaseToken }) }
  seedCompletedCall() { this.calls.push({ attempt: 1, provider: 'chat_completions', model: 'test-model', state: 'completed', leaseToken: this.claim.leaseToken }) }
  seedAcceptedPageAnalysis() {
    const artifact: AnalysisArtifactRecord = {
      id: 'artifact-task-1-page_analysis-1',
      jobId: this.task.id,
      reportVersionId: this.task.reportId,
      moduleId: 'page_analysis',
      schemaVersion: 1,
      promptVersion: 'page-analysis-v1:settings-1',
      attempt: 1,
      status: 'accepted',
      payload: createPageAnalysisFixture(),
      gateErrors: [],
      provider: 'chat_completions',
      model: 'test-model',
      createdAt: now(),
      acceptedAt: now(),
    }
    this.data.set(SUBMISSION_TASK_DATA_KEYS.artifact('page_analysis', 1), artifact)
    this.data.set(SUBMISSION_TASK_DATA_KEYS.moduleState('page_analysis'), { moduleId: 'page_analysis', status: 'accepted', attempt: 1, maxAttempts: 3, artifactId: artifact.id, gateErrors: [], updatedAt: now() })
  }
  seedAcceptedInsight() {
    const insight: ReportInsightOutput = { title: '投资洞察', summary: '现金流压力仍是主要风险。', readingMinutes: 1, sections: [{ id: 'section-1', label: '建议' }], html: createInsightHtml() }
    const artifact: AnalysisArtifactRecord = {
      id: 'artifact-task-1-report_insight-1',
      jobId: this.task.id,
      reportVersionId: this.task.reportId,
      moduleId: 'report_insight',
      schemaVersion: 1,
      promptVersion: 'report-insight-v1',
      attempt: 1,
      status: 'accepted',
      payload: insight,
      gateErrors: [],
      provider: 'chat_completions',
      model: 'test-model',
      createdAt: now(),
      acceptedAt: now(),
    }
    this.data.set(SUBMISSION_TASK_DATA_KEYS.artifact('report_insight', 1), artifact)
    this.data.set(SUBMISSION_TASK_DATA_KEYS.insight, insight)
  }
  private completeCall(claim: SubmissionTaskClaim, receipt: TaskCallReceipt) {
    const call = this.calls.find((item) => item.attempt === receipt.attempt && item.state === 'started' && item.leaseToken === claim.leaseToken)
    if (!call) throw new SubmissionTaskError('CALL_NOT_FOUND', '找不到对应的模型调用。')
    call.state = 'completed'
    call.provider = receipt.provider
    call.model = receipt.model
  }
  private requireLive(claim: SubmissionTaskClaim) {
    this.requireLease(claim)
    if (this.task.cancelRequested) throw new SubmissionTaskError('TASK_LEASE_LOST', '任务租约已失效。')
  }
  private requireLease(claim: SubmissionTaskClaim) {
    if (this.task.status !== 'running' || this.taskLease !== claim.leaseToken) throw new SubmissionTaskError('TASK_LEASE_LOST', '任务租约已失效。')
  }
}

function createHarness(operation: 'analysis' | 'insight', apiKeyEncrypted: string | null = null) {
  const task = createTask(operation)
  const claim: SubmissionTaskClaim = { jobId: task.id, leaseToken: 'lease-1' }
  const report = createReport()
  const store = new MemorySubmissionStore(task, createFrozen(operation, apiKeyEncrypted), report, createSource(report), createDocument(), claim)
  const verifySource = async (file: { sourceKey: string; fileHash: string; sourceSize: number }) => { store.verifyCalls.push(file) }
  const created = createSubmissionTaskPort({ tasks: store, claim, verifySource })
  return { store, claim, port: created.port, publisher: created.publisher }
}

async function fakePageAgent(input: StructuredModuleAgentInput, payload: PageAnalysisArtifact = createPageAnalysisFixture()): Promise<StructuredModuleAgentResult> {
  await input.onCallStarted?.({ provider: 'chat_completions', model: 'test-model', module: input.moduleId, attempt: input.attempt })
  return { payload, provider: 'chat_completions', model: 'test-model' }
}

test('analysis success uses frozen runtime, verifies source before provider, and publishes envelope snapshot without previousOverall', async () => {
  const { store, port, publisher } = createHarness('analysis')
  let verifiedBeforeAgent = false
  const result = await executeSubmissionTask({
    taskId: store.task.id,
    port,
    publisher,
    leaseOwner: store.claim.leaseToken,
    dependencies: {
      createRuntime: () => testRuntime(),
      runModuleAgent: async (input) => {
        verifiedBeforeAgent = store.verifyCalls.length === 1
        assert.equal(input.documentText, store.document.text)
        return fakePageAgent(input)
      },
    },
  })
  assert.equal(result.status, 'completed')
  assert.equal(verifiedBeforeAgent, true)
  assert.equal(store.contentJsonWrites, 0)
  assert.equal(store.results.length, 1)
  const payload = store.results[0].payload as { kind: string; snapshot: { payload: { aiScore?: { previousOverall?: number } } } }
  assert.equal(payload.kind, 'analysis')
  assert.equal(payload.snapshot.payload.aiScore?.previousOverall, undefined)
  assert.equal(store.callLedger(store.task.id).completed, 1)
})

test('analysis loads repository prepared text when no document is injected', async (context) => {
  const { store, port, publisher } = createHarness('analysis')
  const documentRead = context.mock.method(port, 'getDocumentText')
  await runAnalysisExecution({
    jobId: store.task.id,
    reportId: store.task.reportId,
    repository: createAnalysisExecutionRepository(port, store.task.id),
    publisher,
    createRuntime: () => testRuntime(),
    runModuleAgent: async (input) => {
      assert.equal(input.documentText, store.document.text)
      return fakePageAgent(input)
    },
  })
  assert.equal(documentRead.mock.calls.length, 1)
  assert.equal(store.task.status, 'completed')
  assert.equal(store.results.length, 1)
})

test('analysis rejects missing repository text before runtime or provider without reading a source file', async () => {
  for (const prepared of [undefined, { text: '', paragraphCount: 0, characterCount: 0 }]) {
    const { store, port, publisher } = createHarness('analysis')
    const repository = createAnalysisExecutionRepository(port, store.task.id)
    await assert.rejects(() => runAnalysisExecution({
      jobId: store.task.id,
      reportId: store.task.reportId,
      repository: { ...repository, getDocumentText: () => prepared },
      publisher,
      createRuntime: () => { throw new Error('missing text must fail before runtime creation') },
      runModuleAgent: async () => { throw new Error('missing text must not call provider') },
    }), /报告正文不存在，无法提交给 AI。/)
    assert.equal(store.calls.length, 0)
    assert.equal(store.results.length, 0)
  }
})

test('missing prepared document fails analysis and insight tasks without provider calls or publication', async (context) => {
  for (const operation of ['analysis', 'insight'] as const) {
    const { store, port, publisher } = createHarness(operation)
    context.mock.method(port, 'getDocumentText', () => { throw new SubmissionTaskError('REPORT_NOT_FOUND', '报告正文不存在。', 404) })
    await assert.rejects(() => executeSubmissionTask({
      taskId: store.task.id,
      port,
      publisher,
      dependencies: {
        createRuntime: () => { throw new Error('missing document must fail before runtime creation') },
        runModuleAgent: async () => { throw new Error('missing document must not call analysis provider') },
        runInsightAgent: async () => { throw new Error('missing document must not call insight provider') },
      },
    }), (error: unknown) => error instanceof SubmissionTaskError && error.code === 'REPORT_NOT_FOUND')
    assert.equal(store.task.status, 'failed')
    assert.equal(store.task.errorCode, 'REPORT_NOT_FOUND')
    assert.equal(store.calls.length, 0)
    assert.equal(store.results.length, 0)
    assert.equal(store.verifyCalls.length, 1)
  }
})

test('quality gate failure checkpoints calls and fails without complete', async () => {
  const { store, port, publisher } = createHarness('analysis')
  const result = await executeSubmissionTask({
    taskId: store.task.id,
    port,
    publisher,
    dependencies: {
      createRuntime: () => testRuntime(),
      runModuleAgent: (input) => fakePageAgent(input, createRejectedPageAnalysis()),
    },
  })
  assert.equal(result.status, 'failed')
  assert.equal(store.task.errorCode, 'QUALITY_GATE_FAILED')
  assert.equal(store.results.length, 0)
  assert.equal(store.callLedger(store.task.id).completed, 3)
})

test('open provider intent fails the current task without duplicating a model call', async () => {
  const { store, port, publisher } = createHarness('analysis')
  store.seedOpenIntent()
  let agentCalled = false
  await assert.rejects(
    () => executeSubmissionTask({
      taskId: store.task.id,
      port,
      publisher,
      dependencies: {
        createRuntime: () => testRuntime(),
        runModuleAgent: async (input) => {
          agentCalled = true
          return fakePageAgent(input)
        },
      },
    }),
    (error: unknown) => error instanceof IncompleteProviderCallError,
  )
  assert.equal(agentCalled, false)
  assert.equal(store.task.status, 'failed')
  assert.equal(store.task.errorCode, 'AI_CALL_INCOMPLETE')
  assert.equal(store.verifyCalls.length, 0)
})

test('accepted page analysis checkpoint resumes without provider, document read or source verify', async (context) => {
  const { store, port, publisher } = createHarness('analysis')
  const documentRead = context.mock.method(port, 'getDocumentText', () => { throw new Error('resumed analysis must not read document text') })
  store.seedCompletedCall()
  store.seedAcceptedPageAnalysis()
  let agentCalled = false
  const result = await executeSubmissionTask({
    taskId: store.task.id,
    port,
    publisher,
    dependencies: {
      createRuntime: () => { throw new Error('resumed analysis must not decrypt frozen model runtime') },
      runModuleAgent: async (input) => { agentCalled = true; return fakePageAgent(input) },
    },
  })
  assert.equal(result.status, 'completed')
  assert.equal(agentCalled, false)
  assert.equal(documentRead.mock.calls.length, 0)
  assert.equal(store.verifyCalls.length, 0)
})

test('insight success prefers prepared document text and publishes normalized insight envelope', async () => {
  const { store, port, publisher } = createHarness('insight')
  const result = await executeSubmissionTask({
    taskId: store.task.id,
    port,
    publisher,
    dependencies: {
      createRuntime: () => testRuntime(),
      runInsightAgent: async (input) => {
        assert.equal(input.documentText, store.document.text)
        assert.equal('file' in input, false)
        await input.onCallStarted?.({ provider: 'chat_completions', model: 'test-model', stage: 'report_insight', module: 'report_insight' })
        return { title: '投资洞察', summary: '现金流压力仍是主要风险。', readingMinutes: 1, sections: [{ id: 'section-1', label: '建议' }], html: createInsightHtml(), provider: 'chat_completions', model: 'test-model' }
      },
    },
  })
  assert.equal(result.status, 'completed')
  const payload = store.results[0].payload as { kind: string; insight: ReportInsightOutput }
  assert.equal(payload.kind, 'insight')
  assert.equal(payload.insight.html, createInsightHtml())
  assert.equal(store.verifyCalls.length, 1)
})

test('insight validation failure checkpoints completed calls and does not complete', async () => {
  const { store, port, publisher } = createHarness('insight')
  await assert.rejects(() => executeSubmissionTask({
    taskId: store.task.id,
    port,
    publisher,
    dependencies: {
      createRuntime: () => testRuntime(),
      runInsightAgent: async (input) => {
        await input.onCallStarted?.({ provider: 'chat_completions', model: 'test-model' })
        throw new ChatCompletionsError('模型未返回洞察内容。', undefined, undefined, {
          code: 'empty_content',
          retryable: false,
          completed: true,
          provider: 'chat_completions',
          model: 'test-model',
        })
      },
    },
  }))
  assert.equal(store.task.status, 'failed')
  assert.equal(store.task.errorCode, 'MODEL_EXECUTION_FAILED')
  assert.equal(store.results.length, 0)
  assert.equal(store.callLedger(store.task.id).completed, 1)
})

test('cancel while running settles late call instead of failing', async () => {
  const { store, port, publisher } = createHarness('analysis')
  await assert.rejects(() => executeSubmissionTask({
    taskId: store.task.id,
    port,
    publisher,
    dependencies: {
      createRuntime: () => testRuntime(),
      runModuleAgent: async (input) => {
        await input.onCallStarted?.({ provider: 'chat_completions', model: 'test-model', module: input.moduleId, attempt: input.attempt })
        store.requestCancel()
        return { payload: createPageAnalysisFixture(), provider: 'chat_completions', model: 'test-model' }
      },
    },
  }), /Analysis cancelled/)
  assert.equal(store.lateSettlements.length, 1)
  assert.equal(store.task.status, 'running')
  assert.equal(store.task.cancelRequested, true)
  assert.equal(store.results.length, 0)
  assert.equal(store.task.errorCode, undefined)
  assert.equal(store.callLedger(store.task.id).openIntent, undefined)
})

test('lease expiry after known provider response records completion without publishing or failing', async () => {
  const { store, port, publisher } = createHarness('analysis')
  await assert.rejects(
    () => executeSubmissionTask({
      taskId: store.task.id,
      port,
      publisher,
      dependencies: {
        createRuntime: () => testRuntime(),
        runModuleAgent: async (input) => {
          await input.onCallStarted?.({ provider: 'chat_completions', model: 'test-model', module: input.moduleId, attempt: input.attempt })
          store.expireLease()
          return { payload: createPageAnalysisFixture(), provider: 'chat_completions', model: 'test-model' }
        },
      },
    }),
    (error: unknown) => error instanceof SubmissionTaskError && error.code === 'TASK_LEASE_LOST',
  )
  assert.equal(store.lateSettlements.length, 1)
  assert.equal(store.task.status, 'running')
  assert.equal(store.results.length, 0)
  assert.equal(store.callLedger(store.task.id).openIntent, undefined)
})

test('encrypted frozen runtime without explicit settings key fails closed before provider', async () => {
  const previous = process.env.YANXING_SETTINGS_ENCRYPTION_KEY
  delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY
  try {
    const { store, port, publisher } = createHarness('analysis', 'v2:cipher')
    let runtimeCalled = false
    await assert.rejects(
      () => executeSubmissionTask({
        taskId: store.task.id,
        port,
        publisher,
        dependencies: {
          createRuntime: () => { runtimeCalled = true; return testRuntime() },
        },
      }),
      (error: unknown) => error instanceof SubmissionTaskError && error.code === 'SETTINGS_ENCRYPTION_KEY_MISSING',
    )
    assert.equal(runtimeCalled, false)
    assert.equal(store.task.status, 'failed')
    assert.equal(store.task.errorCode, 'SETTINGS_ENCRYPTION_KEY_MISSING')
    assert.equal(store.verifyCalls.length, 1)
  } finally {
    if (previous === undefined) delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY
    else process.env.YANXING_SETTINGS_ENCRYPTION_KEY = previous
  }
})

test('claim-bound port rejects foreign task and report identities', () => {
  const { port } = createHarness('analysis')
  assert.throws(() => port.getTask('task-other'), (error: unknown) => error instanceof SubmissionTaskError && error.code === 'TASK_IDENTITY_MISMATCH')
  assert.throws(() => port.getReport('report-other'), (error: unknown) => error instanceof SubmissionTaskError && error.code === 'TASK_IDENTITY_MISMATCH')
})

test('publishAnalysis requires completed quality-gated snapshot bound to the claimed task', () => {
  const { store, port } = createHarness('analysis')
  store.seedCompletedCall()
  store.seedAcceptedPageAnalysis()
  assert.throws(
    () => port.publishAnalysis({
      snapshot: {
        id: 'analysis-1',
        jobId: store.task.id,
        kind: 'final',
        reportVersionId: store.task.reportId,
        payload: { schemaVersion: 1 } as never,
        artifacts: [],
        moduleStates: [],
        modelCalls: [],
        schemaVersion: 1,
        promptVersion: 'page-analysis-prompts-v1',
        pipelineVersion: 'page-analysis-pipeline-v1',
        createdAt: now(),
      },
      finalization: { status: 'failed', stage: 'completed', stageIndex: 3, publishAsCurrent: false },
    }),
    (error: unknown) => error instanceof SubmissionTaskError && error.code === 'QUALITY_GATE_FAILED',
  )
  assert.equal(store.results.length, 0)
})

test('publishAnalysis does not complete without a finished provider call', () => {
  const { store, port } = createHarness('analysis')
  store.seedAcceptedPageAnalysis()
  const artifact = store.data.get(SUBMISSION_TASK_DATA_KEYS.artifact('page_analysis', 1)) as AnalysisArtifactRecord
  assert.throws(
    () => port.publishAnalysis({
      snapshot: {
        id: 'analysis-1',
        jobId: store.task.id,
        kind: 'final',
        reportVersionId: store.task.reportId,
        payload: { schemaVersion: 1 } as never,
        artifacts: [artifact],
        moduleStates: [],
        modelCalls: [],
        schemaVersion: 1,
        promptVersion: 'page-analysis-prompts-v1',
        pipelineVersion: 'page-analysis-pipeline-v1',
        createdAt: now(),
      },
      finalization: { status: 'completed', stage: 'completed', stageIndex: 3, publishAsCurrent: true },
    }),
    (error: unknown) => error instanceof SubmissionTaskError && error.code === 'AI_CALL_INCOMPLETE',
  )
  assert.equal(store.results.length, 0)
  assert.equal(store.task.status, 'running')
})

test('publishAnalysis rejects a snapshot bound to another task', () => {
  const { store, port } = createHarness('analysis')
  store.seedCompletedCall()
  store.seedAcceptedPageAnalysis()
  const artifact = store.data.get(SUBMISSION_TASK_DATA_KEYS.artifact('page_analysis', 1)) as AnalysisArtifactRecord
  assert.throws(
    () => port.publishAnalysis({
      snapshot: {
        id: 'analysis-1',
        jobId: 'task-other',
        kind: 'final',
        reportVersionId: store.task.reportId,
        payload: { schemaVersion: 1 } as never,
        artifacts: [artifact],
        moduleStates: [],
        modelCalls: [],
        schemaVersion: 1,
        promptVersion: 'page-analysis-prompts-v1',
        pipelineVersion: 'page-analysis-pipeline-v1',
        createdAt: now(),
      },
      finalization: { status: 'completed', stage: 'completed', stageIndex: 3, publishAsCurrent: true },
    }),
    (error: unknown) => error instanceof SubmissionTaskError && error.code === 'TASK_IDENTITY_MISMATCH',
  )
  assert.equal(store.results.length, 0)
  assert.equal(store.task.status, 'running')
})

test('publishInsight revalidates html and does not complete empty content', () => {
  const { store, port } = createHarness('insight')
  store.seedCompletedCall()
  assert.throws(
    () => port.publishInsight({ insight: { title: 'x', summary: 'y', readingMinutes: 1, sections: [], html: '   ' }, modelCall: { provider: 'chat_completions', model: 'test-model' } }),
    (error: unknown) => error instanceof Error && /未返回洞察内容/.test(error.message),
  )
  assert.equal(store.results.length, 0)
  assert.equal(store.task.status, 'running')
})

test('insight cancel after provider response records completion without publishing', async () => {
  const { store, port, publisher } = createHarness('insight')
  await assert.rejects(() => executeSubmissionTask({
    taskId: store.task.id,
    port,
    publisher,
    dependencies: {
      createRuntime: () => testRuntime(),
      runInsightAgent: async (input) => {
        await input.onCallStarted?.({ provider: 'chat_completions', model: 'test-model', stage: 'report_insight', module: 'report_insight' })
        store.requestCancel()
        return { title: '投资洞察', summary: '现金流压力仍是主要风险。', readingMinutes: 1, sections: [{ id: 'section-1', label: '建议' }], html: createInsightHtml(), provider: 'chat_completions', model: 'test-model' }
      },
    },
  }), /Analysis cancelled/)
  assert.equal(store.lateSettlements.length, 1)
  assert.equal(store.task.status, 'running')
  assert.equal(store.task.cancelRequested, true)
  assert.equal(store.results.length, 0)
  assert.equal(store.callLedger(store.task.id).openIntent, undefined)
})

test('insight resume publishes frozen model identity without document read or source verify', async (context) => {
  const { store, port, publisher } = createHarness('insight')
  const documentRead = context.mock.method(port, 'getDocumentText', () => { throw new Error('resumed insight must not read document text') })
  store.seedCompletedCall()
  store.seedAcceptedInsight()
  let agentCalled = false
  const result = await executeSubmissionTask({
    taskId: store.task.id,
    port,
    publisher,
    dependencies: {
      createRuntime: () => { throw new Error('resumed insight must not decrypt frozen model runtime') },
      runInsightAgent: async () => { agentCalled = true; throw new Error('resumed insight must not call provider') },
    },
  })
  assert.equal(result.status, 'completed')
  assert.equal(agentCalled, false)
  assert.equal(documentRead.mock.calls.length, 0)
  assert.equal(store.verifyCalls.length, 0)
  const payload = store.results[0].payload as { kind: string; provider: string; model: string }
  assert.equal(payload.kind, 'insight')
  assert.equal(payload.provider, 'chat_completions')
  assert.equal(payload.model, 'test-model')
})


