import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(`${tmpdir()}/yanxing-repo-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'repo-test.sqlite')

const { createOrUpdateUser } = await import('../lib/auth/session')
import type { AnalysisSnapshotWrite } from '../modules/analysis/ports'
import type { AnalysisArtifactRecord, AnalysisModuleState, AnalysisSnapshotPayload, PageAnalysisArtifact } from '../modules/contracts/analysis'
import { ANALYSIS_SNAPSHOT_SCHEMA_VERSION, AiScoreDimensions, AnalysisStages, ReportCompletenessDimensions, RESEARCH_METHODS } from '../modules/contracts/analysis'
import type { AuthUser } from '../lib/auth/session'
import { buildVisualizationWordCloudItems } from '../modules/analysis/word-cloud'
const {
  assignReportMilestone,
  cancelJob,
  claimNextJob,
  completeInsightGenerationWithInsight,
  createProjectForUser,
  createReportJob,
  createRetryJob,
  createInsightGenerationJob,
  deleteProject,
  deleteReportVersion,
  DuplicateReportError,
  getJob,
  getJobModelRuntime,
  getAnalysisJobPromptSettings,
  getJobEvents,
  getLatestJobForReport,
  getLatestPartialSnapshotForJob,
  getOverviewStats,
  getProject,
  getProjectMembersSnapshot,
  getReport,
  getReportDetail,
  getReportInsight,
  getSnapshot,
  isReportInsightGenerating,
  resolveStoredReportEvaluationContext,
  listOverviewActivityReports,
  listProjectsForUser,
  listReportHistory,
  listReports,
  markAnalysisAiCallStarted,
  markReportParsingFailed,
  publishFinalAnalysis,
  pruneJobEvents,
  replaceReportVersionSource,
  publishAnalysisEvent,
  releaseJobLease,
  releaseReportInsightGeneration,
  reserveReportInsightGeneration,
  resetJobEventsPruneClock,
  saveAnalysisSnapshot,
  saveAiReportFacts,
  saveArtifact,
  saveFailedAttempt,
  saveModuleState,
  saveReportInsight,
  settleCancelledAnalysisAiCall,
  startReportAnalysis,
  updateAnalysisJob,
  updateProject,
} = await import('../lib/db/repository')
const { getDatabase } = await import('../lib/db/client')
const { processJob } = await import('../worker/job-processor')
const { getPublicAiPromptSettings, saveAiPromptSettings, restoreAiPromptSettings } = await import('../lib/db/settings-repository')

const now = () => new Date().toISOString()

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function createOwner() {
  return createOrUpdateUser({ username: `owner-${Math.random().toString(36).slice(2, 8)}`, displayName: '负责人', password: 'password-owner-123', role: 'researcher' })
}

function createStagedProject(owner: AuthUser) {
  const project = createProjectForUser({
    title: '仓库测试课题',
    objective: '识别关键问题并形成决策建议',
    description: '围绕行业现状、风险与实施条件开展研究',
    ownerName: owner.displayName,
  }, owner.id)
  updateProject(project.id, {
    milestones: [{ id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' }],
  })
  return project
}

function createSource(sha256: string) {
  return {
    path: path.join(directory, `${sha256}.docx`),
    fileName: `${sha256}.docx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 100,
    sha256,
  }
}

async function createStoredSource(sha256: string) {
  const sourceDirectory = path.join(directory, 'stored-reports', sha256)
  const source = {
    ...createSource(sha256),
    path: path.join(sourceDirectory, `${sha256}.docx`),
  }
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(source.path, 'stored report')
  return source
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

function snapshotPayloadFromPage(page: PageAnalysisArtifact): AnalysisSnapshotPayload {
  return {
    schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
    reportDetails: {
      sections: page['报告详情']['章节'].map((section, index) => ({ id: `section-${index + 1}`, title: section['标题'], summary: section['摘要'] })),
      completenessConclusion: page['报告详情']['完整度结论'],
    },
    reportCompleteness: {
      overall: 76,
      dimensions: ReportCompletenessDimensions.map((dimension, index) => ({ id: dimension.id, label: dimension.id, score: 76 + index })),
      mainGap: page['报告完整度']['主要缺口'],
    },
    aiScore: {
      overall: 76,
      summary: page['综合评分']['主要影响因素'],
      dimensions: AiScoreDimensions.map((dimension, index) => ({ id: dimension.id, label: dimension.label, score: 76 + index })),
    },
    suggestions: page['AI建议'].map((detail, index) => ({ id: `suggestion-${index + 1}`, detail })),
    visualization: {
      mindMap: { id: 'mindmap-root', label: page['思维导图']['名称'], children: page['思维导图']['子节点'].map((child, index) => ({ id: `mindmap-root-${index + 1}`, label: child['名称'], children: [] })) },
      wordCloud: buildVisualizationWordCloudItems(page['词云']),
      heatmap: { rows: page['热力图'].map((row, index) => ({ id: `heatmap-${index + 1}`, label: row['章节'], values: RESEARCH_METHODS.map((method) => row[method.label]) })) },
    },
  }
}

function acceptedPageMaps(jobId: string, reportVersionId: string, promptVersion = 'page-analysis-v1:settings-1') {
  const artifact: AnalysisArtifactRecord = {
    id: `artifact-${jobId}-page-analysis-1`,
    jobId,
    reportVersionId,
    moduleId: 'page_analysis',
    schemaVersion: 1,
    promptVersion,
    attempt: 1,
    status: 'accepted',
    payload: createPageAnalysisFixture(),
    gateErrors: [],
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    createdAt: now(),
    acceptedAt: now(),
  }
  const state: AnalysisModuleState = {
    moduleId: 'page_analysis',
    status: 'accepted',
    attempt: 1,
    maxAttempts: 3,
    artifactId: artifact.id,
    gateErrors: [],
    updatedAt: now(),
  }
  return { artifact, state };
}

function createCanonicalSnapshotWrite(jobId: string, reportVersionId: string, worker: string, promptVersion = 'page-analysis-v1:settings-1'): AnalysisSnapshotWrite {
  const { artifact, state } = acceptedPageMaps(jobId, reportVersionId, promptVersion);
  const page = artifact.payload as PageAnalysisArtifact;
  return {
    id: `analysis-${jobId}`,
    jobId,
    kind: 'final',
    reportVersionId,
    payload: snapshotPayloadFromPage(page),
    artifacts: [artifact],
    moduleStates: [state],
    modelCalls: [{ provider: 'deepseek', model: 'deepseek-v4-flash', stage: 'page_analysis', module: 'page_analysis', tokens: 1_000 }],
    schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
    promptVersion: 'page-analysis-prompts-v1',
    pipelineVersion: 'page-analysis-pipeline-v1',
    createdAt: now(),
    leaseOwner: worker,
  };
}

function claimThenPublishCanonical(reportId: string, jobId: string, worker?: string): AnalysisSnapshotWrite {
  const leaseOwner = worker ?? `worker-${Math.random().toString(36).slice(2, 8)}`;
  assert.equal(claimNextJob(leaseOwner, 60_000)?.id, jobId);
  const snapshot = createCanonicalSnapshotWrite(jobId, reportId, leaseOwner);
  const artifact = snapshot.artifacts[0]!;
  const state = snapshot.moduleStates[0]!;
  saveArtifact(jobId, artifact, leaseOwner)
  saveModuleState(jobId, state, leaseOwner)
  publishFinalAnalysis(snapshot, {
    status: 'completed',
    stage: 'completed',
    stageIndex: AnalysisStages.indexOf('completed'),
    publishAsCurrent: true,
  });
  return snapshot;
}

function createPartialSnapshot(jobId: string, reportVersionId: string, leaseOwner?: string): AnalysisSnapshotWrite {
  const page = createPageAnalysisFixture();
  return {
    id: `partial-${jobId}-${Math.random().toString(36).slice(2)}`,
    jobId,
    kind: 'partial',
    reportVersionId,
    payload: snapshotPayloadFromPage(page),
    artifacts: [],
    moduleStates: [],
    modelCalls: [],
    schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
    promptVersion: 'page-analysis-prompts-v1',
    pipelineVersion: 'page-analysis-pipeline-v1',
    createdAt: now(),
    leaseOwner,
  };
}

function insightRecord(reportVersionId: string, overrides: Partial<{ title: string; summary: string }> = {}) {
  return {
    reportVersionId,
    title: overrides.title ?? '五分钟洞察',
    summary: overrides.summary ?? '这是一份用于验证洞察持久化行为的测试摘要。',
    readingMinutes: 5,
    sections: [{ id: 'conclusion', label: '核心结论' }, { id: 'evidence', label: '关键证据' }, { id: 'actions', label: '行动事项' }],
    html: '<article><section id="conclusion">结论</section><section id="evidence">证据</section><section id="actions">行动</section></article>',
    provider: 'deepseek',
    model: 'test-model',
  };
}

test('project mutations recheck current authorization and reject stale revisions', () => {
  const owner = createOwner()
  const project = createProjectForUser({ title: '授权检查课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const first = updateProject(project.id, { title: '第一次更新' }, { actor: owner, expectedUpdatedAt: project.updatedAt })
  assert.equal(first?.title, '第一次更新')
  assert.throws(
    () => updateProject(project.id, { title: '过期更新' }, { actor: owner, expectedUpdatedAt: '1970-01-01T00:00:00.000Z' }),
    /已被其他操作更新/,
  )
  getDatabase().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(owner.id)
  assert.throws(() => updateProject(project.id, { title: '无权更新' }, { actor: owner }), /权限已变更/)
})

test('report milestone is persisted, reassignable, and drives the latest evaluation context', () => {
  const owner = createOwner()
  const project = createProjectForUser({
    title: '评价上下文课题',
    objective: '识别核心研究问题并形成决策依据',
    description: '围绕行业现状、风险与实施条件开展研究',
    ownerName: owner.displayName,
  }, owner.id)
  updateProject(project.id, {
    milestones: [
      { id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '完成资料收集并形成事实清单', status: 'in_progress' },
      { id: 'stage-2', title: '成果形成', targetDate: '2026-09-30', description: '完成结论验证并交付决策建议', status: 'not_started' },
    ],
  })

  const created = createReportJob({
    projectId: project.id,
    fileName: '阶段报告.docx',
    source: createSource('milestone-context-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
    deliveryType: 'stage',
  }).report
  const retained = createReportJob({
    projectId: project.id,
    fileName: '留存阶段报告.docx',
    source: createSource('milestone-retained-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
    deliveryType: 'stage',
  }).report
  assert.equal(created.milestoneId, 'stage-1')
  assert.equal(created.deliveryType, 'stage')
  const afterUpload = getProject(project.id)!
  assert.equal(afterUpload.milestones[0].status, 'completed')
  assert.equal(afterUpload.milestones[1].status, 'in_progress')
  assert.deepEqual(afterUpload.milestones[0].reportIds, [retained.id, created.id])
  assert.equal(getReport(created.id)?.milestoneId, 'stage-1')
  assert.equal(resolveStoredReportEvaluationContext(created.id).context?.milestone.title, '事实调研')

  updateProject(project.id, {
    objective: '更新后的研究目标',
    description: '更新后的研究背景',
    milestones: getProject(project.id)!.milestones.map((milestone) => milestone.id === 'stage-1'
      ? { ...milestone, description: '更新后的阶段工作与预期成果' }
      : milestone),
  })
  const latestContext = resolveStoredReportEvaluationContext(created.id)
  assert.equal(latestContext.context?.researchObjective, '更新后的研究目标')
  assert.equal(latestContext.context?.milestone.workAndExpectedOutcomes, '更新后的阶段工作与预期成果')

  const reassigned = assignReportMilestone(created.id, 'stage-2')
  assert.equal(reassigned?.milestoneId, 'stage-2')
  const updatedProject = getProject(project.id)!
  assert.equal(updatedProject.milestones[0].reportIds?.includes(created.id), false)
  assert.equal(updatedProject.milestones[1].reportIds?.includes(created.id), true)
  assert.equal(updatedProject.milestones[1].status, 'completed')

  updateProject(project.id, {
    milestones: updatedProject.milestones.map((milestone) => ({ ...milestone, reportIds: [] })),
  })
  assert.equal(getReport(created.id)?.milestoneId, undefined)
  assert.throws(() => assignReportMilestone(created.id, 'missing-stage'), /不存在/)
})

test('analysis jobs freeze prompt settings at creation time', () => {
  const owner = createOwner()
  const firstProject = createStagedProject(owner)
  const first = createReportJob({
    projectId: firstProject.id,
    fileName: 'prompt-freeze-first.docx',
    source: createSource('prompt-freeze-first-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const firstPrompts = getAnalysisJobPromptSettings(first.job!.id)
  assert.ok(firstPrompts)
  assert.equal(firstPrompts.length, 2)
  assert.equal('prompt_config_json' in getJob(first.job!.id)!, false)

  const current = getPublicAiPromptSettings()
  saveAiPromptSettings({
    systemPrompt: current.systemPrompt.systemPrompt,
    prompts: current.prompts.map(({ target, instructionPrompt }) => ({
      target,
      instructionPrompt: target === 'page_analysis' ? '冻结测试的新任务提示词。' : instructionPrompt,
    })),
  }, 'test-admin')
  try {
    const secondProject = createStagedProject(owner)
    const second = createReportJob({
      projectId: secondProject.id,
      fileName: 'prompt-freeze-second.docx',
      source: createSource('prompt-freeze-second-hash'),
      reportId: undefined,
      milestoneId: 'stage-1',
      autoAnalyze: true,
    })
    assert.equal(getAnalysisJobPromptSettings(first.job!.id)?.find((prompt) => prompt.target === 'page_analysis')?.instructionPrompt, firstPrompts.find((prompt) => prompt.target === 'page_analysis')?.instructionPrompt)
    assert.equal(getAnalysisJobPromptSettings(second.job!.id)?.find((prompt) => prompt.target === 'page_analysis')?.instructionPrompt, '冻结测试的新任务提示词。')
    // 排队任务继续使用冻结配置；模型配置也已冻结到任务。
    const queued = getJob(first.job!.id)
    assert.equal(queued?.status, 'queued')
    assert.equal(getAnalysisJobPromptSettings(first.job!.id)?.find((prompt) => prompt.target === 'page_analysis')?.version, 1)
  } finally {
    restoreAiPromptSettings(undefined, 'test-admin')
  }
})

test('duplicate report content is rejected with the existing version', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = createSource('duplicate-hash-1')
  const first = createReportJob({
    projectId: project.id,
    fileName: 'a.docx',
    source: source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  assert.throws(
    () => createReportJob({
      projectId: project.id,
      fileName: 'a-copy.docx',
      source: source,
      reportId: undefined,
      milestoneId: 'stage-1',
      autoAnalyze: true,
    }),
    (error: unknown) => error instanceof DuplicateReportError && error.report.id === first.report.id,
  )
  // 不同项目允许相同内容。
  const otherProject = createStagedProject(owner)
  assert.ok(createReportJob({
    projectId: otherProject.id,
    fileName: 'a.docx',
    source: source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  }).report.id)
})

test('report history combines version facts with published analysis metrics', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const first = createReportJob({
    projectId: project.id,
    fileName: 'history-v1.docx',
    source: createSource('history-v1-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  saveAiReportFacts(first.report.id, { title: '历史版本一', paragraphCount: 12, characterCount: 8_420 })
  claimThenPublishCanonical(first.report.id, first.job!.id)

  const firstProjectSummary = listProjectsForUser(owner).find((item) => item.id === project.id)?.latestReport
  assert.deepEqual(firstProjectSummary, {
    version: 1,
    aiScore: 76,
    completeness: 76,
    characterCount: 8_420,
  })

  const second = createReportJob({
    projectId: project.id,
    fileName: 'history-v2.pdf',
    source: createSource('history-v2-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  saveAiReportFacts(second.report.id, { title: '历史版本二', paragraphCount: 16, characterCount: 10_200 })

  const history = listReportHistory(project.id, { limit: 100, offset: 0 })
  assert.equal(history.length, 2)
  assert.equal(history[0]?.report.id, second.report.id)
  assert.equal(history[0]?.report.characterCount, 10_200)
  assert.equal(history[0]?.aiScore, undefined)
  assert.equal(history[0]?.completeness, undefined)
  assert.equal(history[1]?.report.id, first.report.id)
  assert.equal(history[1]?.aiScore, 76)
  assert.equal(history[1]?.completeness, 76)

  assert.deepEqual(listProjectsForUser(owner).find((item) => item.id === project.id)?.latestReport, {
    version: 2,
    aiScore: undefined,
    completeness: undefined,
    characterCount: 10_200,
  })
})

test('deleting a report version reconnects history and removes only its data and file', async () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const firstSource = await createStoredSource('delete-version-v1')
  const secondSource = await createStoredSource('delete-version-v2')
  const thirdSource = await createStoredSource('delete-version-v3')
  const first = createReportJob({
    projectId: project.id,
    fileName: 'delete-v1.docx',
    source: firstSource,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  saveAiReportFacts(first.report.id, { title: '版本一', paragraphCount: 10, characterCount: 1_000 })
  const second = createReportJob({
    projectId: project.id,
    fileName: 'delete-v2.docx',
    source: secondSource,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  saveAiReportFacts(second.report.id, { title: '版本二', paragraphCount: 20, characterCount: 2_000 })
  const third = createReportJob({
    projectId: project.id,
    fileName: 'delete-v3.docx',
    source: thirdSource,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  saveAiReportFacts(third.report.id, { title: '版本三', paragraphCount: 30, characterCount: 3_000 })

  assert.equal(await deleteReportVersion(second.report.id), true)
  assert.equal(getReport(second.report.id), undefined)
  assert.deepEqual(listReports(project.id).map((report) => report.version), [3, 1])
  assert.equal(getReport(third.report.id)?.previousVersionId, first.report.id)
  assert.equal(getReport(third.report.id)?.previousCharacterCount, 1_000)
  // 外部路径不是应用托管对象，删除报告只能清理受管目录，避免递归删除任意目录。
  await access(path.dirname(secondSource.path))
  await access(path.dirname(firstSource.path))
  await access(path.dirname(thirdSource.path))

  assert.equal(await deleteReportVersion(third.report.id), true)
  assert.equal(listReports(project.id)[0]?.id, first.report.id)
  assert.equal(await deleteReportVersion(first.report.id), true)
  assert.deepEqual(listReports(project.id), [])
  assert.equal(await deleteReportVersion('report-does-not-exist'), false)
})

test('deleting a project releases report storage allocations in the same transaction', async () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const source = createSource('project-allocation-hash')
  const { report } = createReportJob({
    projectId: project.id,
    fileName: 'allocated.docx',
    source: source,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  getDatabase().prepare('INSERT INTO storage_allocations(owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path, mime_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('report', report.id, owner.id, project.id, 100, source.sha256, source.path, source.mimeType, report.createdAt, report.createdAt)

  assert.equal(await deleteProject(project.id), true)
  assert.equal(getProject(project.id), undefined)
  assert.equal(getDatabase().prepare('SELECT 1 FROM storage_allocations WHERE owner_type = ? AND owner_id = ?').get('report', report.id), undefined)
})

test('missing report source marks parsing failed and does not remain retryable', async () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'missing.docx',
    source: createSource('missing-source-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  assert.ok(job)
  assert.equal(claimNextJob('missing-source-worker', 60_000)?.id, job.id)

  await assert.rejects(
    () => processJob(job.id, { leaseOwner: 'missing-source-worker' }),
    /原始文件不存在/,
  )
  const failedReport = getReport(report.id)
  assert.equal(failedReport?.parseStatus, 'failed')
  assert.match(failedReport?.parseError ?? '', /原始文件不存在/)
  assert.equal(getJob(job.id)?.status, 'failed')
})

test('insight processor failures are handled by the job processor guard', async () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'missing-insight.docx',
    source: createSource('missing-insight-source-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  const insightJob = createInsightGenerationJob(uploaded.report.id, owner)
  const leaseOwner = 'missing-insight-worker'
  assert.equal(claimNextJob(leaseOwner, 60_000)?.id, insightJob.id)

  await assert.rejects(
    () => processJob(insightJob.id, { leaseOwner }),
    /原始文件不存在/,
  )
  assert.equal(getJob(insightJob.id)?.status, 'failed')
  assert.notEqual(getReport(uploaded.report.id)?.parseStatus, 'failed')
  assert.equal(getJobEvents(insightJob.id).at(-1)?.type, 'failed')
})

test('claim lease, expiry recovery, and double-claim exclusion', async () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { job } = createReportJob({
    projectId: project.id,
    fileName: 'claim.docx',
    source: createSource('claim-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })

  const claimed = claimNextJob('worker-1', 60_000)
  assert.equal(claimed?.id, job.id)
  assert.equal(claimed?.status, 'running')
  assert.equal(claimed?.attempts, 1)
  const row = getDatabase().prepare('SELECT lease_owner, lease_expires_at FROM analysis_jobs WHERE id = ?').get(job.id) as { lease_owner: string; lease_expires_at: string }
  assert.equal(row.lease_owner, 'worker-1')
  assert.ok(row.lease_expires_at > now())

  // 被持有期间其他 Worker 无法领取。
  assert.equal(claimNextJob('worker-2', 60_000), undefined)

  // 租约过期后被其他 Worker 回收并重新领取。
  getDatabase().prepare('UPDATE analysis_jobs SET lease_expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), job.id)
  assert.equal(claimNextJob('worker-2', 60_000), undefined)
  getDatabase().prepare('UPDATE analysis_jobs SET available_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), job.id)
  const recovered = claimNextJob('worker-2', 60_000)
  assert.equal(recovered?.id, job.id)
  assert.equal(recovered?.attempts, 2)
  const recoveredRow = getDatabase().prepare('SELECT lease_owner FROM analysis_jobs WHERE id = ?').get(job.id) as { lease_owner: string }
  assert.equal(recoveredRow.lease_owner, 'worker-2')
})

test('lease release stops requeueing after the maximum recovery attempts', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { job } = createReportJob({
    projectId: project.id,
    fileName: 'release-limit.docx',
    source: createSource('release-limit-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  getDatabase().prepare('UPDATE analysis_jobs SET attempts = 4 WHERE id = ?').run(job.id)
  assert.equal(claimNextJob('worker-limit', 60_000)?.attempts, 5)
  assert.equal(releaseJobLease(job.id, 'worker-limit'), true)
  assert.equal(getJob(job.id)?.status, 'failed')
  assert.equal(claimNextJob('worker-other', 60_000), undefined)
  assert.equal(getJobEvents(job.id).at(-1)?.type, 'failed')
})

test('stale workers cannot write after another worker reclaims the lease', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'lease-fence.docx',
    source: createSource('lease-fence-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })

  assert.equal(claimNextJob('worker-a', 60_000)?.id, job.id)
  getDatabase().prepare('UPDATE analysis_jobs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id)
  assert.equal(claimNextJob('worker-b', 60_000), undefined)
  getDatabase().prepare('UPDATE analysis_jobs SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id)
  assert.equal(claimNextJob('worker-b', 60_000)?.id, job.id)

  // 陈旧 worker 的写入被守卫拒绝：落空即抛错（防止流水线带着丢失的状态继续烧钱）。
  assert.throws(() => saveModuleState(job.id, {
    moduleId: 'page_analysis',
    status: 'accepted',
    attempt: 1,
    maxAttempts: 3,
    gateErrors: [],
    updatedAt: now(),
  }, 'worker-a'), /任务已停止/)
  const module = getDatabase().prepare("SELECT status FROM analysis_module_states WHERE job_id = ? AND module_id = 'page_analysis'").get(job.id) as { status: string }
  assert.equal(module.status, 'pending')

  assert.throws(() => saveArtifact(job.id, {
    id: 'stale-artifact',
    jobId: job.id,
    reportVersionId: report.id,
    moduleId: 'page_analysis',
    schemaVersion: 1,
    promptVersion: 'lease-fence-test',
    attempt: 1,
    status: 'accepted',
    payload: {},
    gateErrors: [],
    createdAt: now(),
    acceptedAt: now(),
  }, 'worker-a'), /任务已停止/)
  const artifactCount = getDatabase().prepare('SELECT COUNT(*) AS count FROM analysis_artifacts WHERE job_id = ?').get(job.id) as { count: number }
  assert.equal(artifactCount.count, 0)

  assert.throws(
    () => completeInsightGenerationWithInsight(job.id, insightRecord(report.id, { title: '迟到洞察' }), { tokens: 1 }, 'worker-a'),
    /不是洞察生成任务/,
  )
  assert.equal(getReportInsight(report.id), undefined)

  assert.equal(saveAiReportFacts(report.id, { title: '陈旧标题', paragraphCount: 1, characterCount: 1 }, 'worker-a'), undefined)
  updateAnalysisJob(job.id, { stage: 'page_analysis' }, 'worker-a')
  assert.equal(getJob(job.id)?.stage, 'validating')

  const staleSnapshot = { ...createPartialSnapshot(job.id, report.id), leaseOwner: 'worker-a' }
  assert.throws(() => saveAnalysisSnapshot(staleSnapshot), /任务已停止/)
  assert.equal(getSnapshot(staleSnapshot.id), undefined)
})

test('stale workers cannot complete an insight job after another worker reclaims the lease', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'insight-lease-fence.docx',
    source: createSource('insight-lease-fence-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  const insightJob = createInsightGenerationJob(uploaded.report.id, owner)
  assert.equal(insightJob.type, 'insight')
  assert.equal(claimNextJob('worker-a', 60_000)?.id, insightJob.id)
  getDatabase().prepare('UPDATE analysis_jobs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), insightJob.id)
  assert.equal(claimNextJob('worker-b', 60_000), undefined)
  getDatabase().prepare('UPDATE analysis_jobs SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), insightJob.id)
  assert.equal(claimNextJob('worker-b', 60_000)?.id, insightJob.id)

  assert.throws(
    () => completeInsightGenerationWithInsight(insightJob.id, insightRecord(uploaded.report.id, { title: '迟到洞察' }), { tokens: 1 }, 'worker-a'),
    /任务已停止/,
  )
  assert.equal(getReportInsight(uploaded.report.id), undefined)
  assert.equal(getJob(insightJob.id)?.status, 'running')
  assert.equal(getJobEvents(insightJob.id).some((event) => event.type === 'completed'), false)
  const held = getDatabase().prepare('SELECT lease_owner FROM analysis_jobs WHERE id = ?').get(insightJob.id) as { lease_owner: string }
  assert.equal(held.lease_owner, 'worker-b')

  completeInsightGenerationWithInsight(insightJob.id, insightRecord(uploaded.report.id, { title: '接管后洞察' }), { tokens: 4 }, 'worker-b')
  assert.equal(getReportInsight(uploaded.report.id)?.title, '接管后洞察')
  assert.equal(getJob(insightJob.id)?.status, 'completed')
})

test('expired insight lease rejects the original worker before another claim', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'insight-expired-lease.docx',
    source: createSource('insight-expired-lease-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  const insightJob = createInsightGenerationJob(uploaded.report.id, owner)
  assert.equal(insightJob.type, 'insight')
  assert.equal(claimNextJob('worker-a', 60_000)?.id, insightJob.id)
  getDatabase().prepare('UPDATE analysis_jobs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), insightJob.id)

  assert.throws(
    () => completeInsightGenerationWithInsight(insightJob.id, insightRecord(uploaded.report.id, { title: '过期洞察' }), { tokens: 1 }, 'worker-a'),
    /任务已停止/,
  )
  assert.equal(getReportInsight(uploaded.report.id), undefined)
  assert.equal(getJob(insightJob.id)?.status, 'running')
  const held = getDatabase().prepare('SELECT lease_owner FROM analysis_jobs WHERE id = ?').get(insightJob.id) as { lease_owner: string | null }
  assert.equal(held.lease_owner, 'worker-a')
})

test('artifacts cannot be attached to a report different from their claimed job', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const first = createReportJob({
    projectId: project.id,
    fileName: 'artifact-first.docx',
    source: createSource('artifact-first-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const second = createReportJob({
    projectId: project.id,
    fileName: 'artifact-second.docx',
    source: createSource('artifact-second-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'cancelled' WHERE id = ?").run(second.job!.id)
  assert.equal(claimNextJob('artifact-worker', 60_000)?.id, first.job!.id)

  // 跨报告挂载产物被守卫拒绝：写入落空现在直接抛错（比静默 no-op 更严格）。
  assert.throws(() => saveArtifact(first.job!.id, {
    id: 'cross-report-artifact',
    jobId: first.job!.id,
    reportVersionId: second.report.id,
    moduleId: 'page_analysis',
    schemaVersion: 1,
    promptVersion: 'cross-report-test',
    attempt: 1,
    status: 'accepted',
    payload: createPageAnalysisFixture(),
    gateErrors: [],
    createdAt: now(),
    acceptedAt: now(),
  }, 'artifact-worker'), /任务已停止/)

  const count = getDatabase().prepare('SELECT COUNT(*) AS count FROM analysis_artifacts WHERE job_id = ?').get(first.job!.id) as { count: number }
  assert.equal(count.count, 0)

  // 相同产物 ID 已属于其他任务时，更新也必须保持原归属，不能借冲突覆盖跨任务数据。
  const sharedArtifactId = 'shared-artifact-id'
  getDatabase().prepare(`
    INSERT INTO analysis_artifacts (
      id, job_id, report_version_id, module_id, schema_version, prompt_version, attempt,
      status, payload_json, gate_errors_json, provider, model, created_at, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sharedArtifactId,
    second.job!.id,
    second.report.id,
    'page_analysis',
    1,
    'collision-test',
    1,
    'accepted',
    JSON.stringify(createPageAnalysisFixture()),
    '[]',
    'deepseek',
    'test-model',
    now(),
    now(),
  )
  assert.throws(() => saveArtifact(first.job!.id, {
    id: sharedArtifactId,
    jobId: first.job!.id,
    reportVersionId: first.report.id,
    moduleId: 'page_analysis',
    schemaVersion: 1,
    promptVersion: 'collision-test',
    attempt: 1,
    status: 'accepted',
    payload: createPageAnalysisFixture(),
    gateErrors: [],
    createdAt: now(),
    acceptedAt: now(),
  }, 'artifact-worker'), /任务已停止/)
  const preserved = getDatabase().prepare('SELECT job_id, report_version_id FROM analysis_artifacts WHERE id = ?').get(sharedArtifactId) as { job_id: string; report_version_id: string }
  assert.equal(preserved.job_id, second.job!.id)
  assert.equal(preserved.report_version_id, second.report.id)
})

test('cancel stops queued and running jobs and cannot be undone', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)

  // 排队中取消。
  const queued = createReportJob({
    projectId: project.id,
    fileName: 'cancel-queued.docx',
    source: createSource('cancel-hash-1'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const cancelledQueued = cancelJob(queued.job!.id)
  assert.equal(cancelledQueued?.status, 'cancelled')
  assert.equal(claimNextJob('worker-1', 60_000), undefined) // 取消的任务不再被领取

  // 运行中取消。
  const running = createReportJob({
    projectId: project.id,
    fileName: 'cancel-running.docx',
    source: createSource('cancel-hash-2'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  claimNextJob('worker-1', 60_000)
  const cancelledRunning = cancelJob(running.job!.id)
  assert.equal(cancelledRunning?.status, 'cancelled')
  assert.equal(getJob(running.job!.id)?.status, 'cancelled')

  // 终态任务再次取消保持原状态。
  const again = cancelJob(running.job!.id)
  assert.equal(again?.status, 'cancelled')
})

function retryParent(jobId: string) {
  return getDatabase().prepare('SELECT parent_job_id FROM analysis_jobs WHERE id = ?').get(jobId) as { parent_job_id: string | null } | undefined
}

test('retry jobs are only created from terminal states and deduplicated', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { job } = createReportJob({
    projectId: project.id,
    fileName: 'retry.docx',
    source: createSource('retry-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })

  // 非终态不能重试。
  assert.throws(() => createRetryJob(job.id), /只有终态任务可以重新执行/)

  getDatabase().prepare("UPDATE analysis_jobs SET status = 'failed', error_message = '测试失败' WHERE id = ?").run(job.id)
  const retry = createRetryJob(job.id)
  assert.equal(retry?.type, 'rerun')
  assert.equal(retry?.status, 'queued')
  assert.equal(retryParent(retry!.id)?.parent_job_id, job.id)
  assert.equal(getJob(retry!.id)?.status, 'queued')

  // 已有排队中的重试任务时复用，不重复创建。
  const again = createRetryJob(job.id)
  assert.equal(again?.id, retry?.id)

  // 嵌套重试处于活动状态时，从更早的初始任务重新发起也必须复用它。
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(retry!.id)
  const nestedRetry = createRetryJob(retry!.id)
  assert.equal(nestedRetry?.status, 'queued')
  assert.equal(createRetryJob(job.id)?.id, nestedRetry?.id)
  const activeCount = getDatabase().prepare("SELECT COUNT(*) AS count FROM analysis_jobs WHERE report_version_id = ? AND status IN ('queued', 'running')").get(job.reportVersionId) as { count: number }
  assert.equal(activeCount.count, 1)

  // 活动任务结束后才能创建新的重试。
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(nestedRetry!.id)
  const secondRetry = createRetryJob(job.id)
  assert.equal(retryParent(secondRetry!.id)?.parent_job_id, job.id)
  assert.notEqual(secondRetry?.id, retry?.id)

  // 已完成多次分析后仍可继续创建重试任务。
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(secondRetry!.id)
  const fourthRetry = createRetryJob(job.id)
  assert.equal(fourthRetry?.type, 'rerun')
  assert.equal(retryParent(fourthRetry!.id)?.parent_job_id, job.id)

  // 失败或取消也不会阻止后续人工重试。
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'cancelled' WHERE id = ?").run(fourthRetry!.id)
  const afterCancellation = createRetryJob(fourthRetry!.id)
  assert.equal(afterCancellation?.type, 'rerun')
  assert.equal(retryParent(afterCancellation!.id)?.parent_job_id, fourthRetry!.id)
})

test('manual reanalysis keeps creating rerun jobs without nested transactions', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'manual-rerun.docx',
    source: createSource('manual-rerun-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })

  claimThenPublishCanonical(report.id, job.id)
  const first = startReportAnalysis(report.id)
  assert.equal(first?.job.type, 'rerun')
  assert.equal(retryParent(first!.job.id)?.parent_job_id, job.id)

  getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(first!.job.id)
  const second = startReportAnalysis(report.id)
  assert.equal(second?.job.type, 'rerun')

  getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(second!.job.id)
  const third = startReportAnalysis(report.id)
  assert.equal(third?.job.type, 'rerun')

  getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(third!.job.id)
  const fourth = startReportAnalysis(report.id)
  assert.equal(fourth?.job.type, 'rerun')
})

test('changing evaluation context starts a fresh analysis epoch', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'new-epoch.docx',
    source: createSource('new-epoch-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  claimThenPublishCanonical(report.id, job.id)
  let sourceJobId = job.id
  for (let index = 0; index < 3; index += 1) {
    const retry = createRetryJob(sourceJobId)!
    getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(retry.id)
    sourceJobId = retry.id
  }
  updateProject(project.id, { objective: '新的评价目标' }, { invalidateAnalysis: true })
  const fresh = startReportAnalysis(report.id)
  assert.equal(fresh?.job.type, 'initial')
  assert.equal(retryParent(fresh!.job.id)?.parent_job_id, null)
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'cancelled' WHERE id = ?").run(fresh!.job.id)
  const retryWithoutFinal = startReportAnalysis(report.id)
  assert.equal(retryWithoutFinal?.job.type, 'initial')
  assert.equal(retryParent(retryWithoutFinal!.job.id)?.parent_job_id, null)
})





test('partial snapshots stay isolated to the active retry job', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'partial-retry.docx',
    source: createSource('partial-retry-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })

  assert.equal(claimNextJob('partial-worker', 60_000)?.id, job.id)
  const staleSnapshot = createPartialSnapshot(job.id, report.id, 'partial-worker')
  saveAnalysisSnapshot(staleSnapshot)
  assert.equal(getLatestPartialSnapshotForJob(job.id)?.id, staleSnapshot.id)

  getDatabase().prepare("UPDATE analysis_jobs SET status = 'failed' WHERE id = ?").run(job.id)
  const retry = createRetryJob(job.id)
  assert.ok(retry)
  assert.equal(getLatestPartialSnapshotForJob(retry.id), undefined)

  assert.equal(claimNextJob('partial-worker-retry', 60_000)?.id, retry.id)
  const retrySnapshot = createPartialSnapshot(retry.id, report.id, 'partial-worker-retry')
  saveAnalysisSnapshot(retrySnapshot)
  assert.equal(getLatestPartialSnapshotForJob(retry.id)?.id, retrySnapshot.id)
})

test('parse status follows document parsing, not analysis completeness', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'status.docx',
    source: createSource('status-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const stored = getDatabase().prepare('SELECT parse_status FROM report_versions WHERE id = ?').get(report.id) as { parse_status: string }
  assert.equal(stored.parse_status, 'uploaded')

  // 解析成功（AI 事实落地）→ ready。
  const saved = saveAiReportFacts(report.id, {
    title: 'AI 标题',
    paragraphCount: 10,
    characterCount: 100,
  })
  assert.equal(saved?.parseStatus, 'ready')

  // 分析失败不会改写已完成的文档解析状态，历史页据 latestJobStatus 呈现分析失败。
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'failed' WHERE id = ?").run(job.id)
  const historyReport = listReports(project.id).find((item) => item.id === report.id)
  assert.equal(historyReport?.parseStatus, 'ready')
  assert.equal(historyReport?.latestJobStatus, 'failed')

  // 仅文档解析错误会标记 parse_status 为 failed。
  markReportParsingFailed(report.id, '正文提取失败')
  const failed = getDatabase().prepare('SELECT parse_status, parse_error FROM report_versions WHERE id = ?').get(report.id) as { parse_status: string; parse_error: string }
  assert.equal(failed.parse_status, 'failed')
  assert.equal(failed.parse_error, '正文提取失败')
})

test('final snapshot publication commits current analysis and job status together', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const live = createReportJob({
    projectId: project.id,
    fileName: 'final.docx',
    source: createSource('final-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  assert.equal(claimNextJob('final-worker', 60_000)?.id, live.job!.id)

  const snapshot = createCanonicalSnapshotWrite(live.job!.id, live.report.id, 'final-worker')
  const artifact = snapshot.artifacts[0]!;
  const state = snapshot.moduleStates[0]!;
  saveArtifact(live.job!.id, artifact, 'final-worker')
  saveModuleState(live.job!.id, state, 'final-worker')
  publishFinalAnalysis(snapshot, {
    status: 'completed',
    stage: 'completed',
    stageIndex: AnalysisStages.indexOf('completed'),
    publishAsCurrent: true,
  })
  assert.equal(getJob(live.job!.id)?.status, 'completed')
  assert.equal(getReport(live.report.id)?.currentAnalysisId, snapshot.id)
  assert.equal(getSnapshot(snapshot.id)?.id, snapshot.id)
  assert.ok(getReport(live.report.id)?.hasCompletedFullAnalysis)

  const cancelled = createReportJob({
    projectId: project.id,
    fileName: 'cancelled-final.docx',
    source: createSource('cancelled-final-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  assert.equal(claimNextJob('final-worker', 60_000)?.id, cancelled.job!.id)
  cancelJob(cancelled.job!.id)
  const blockedSnapshot = createCanonicalSnapshotWrite(cancelled.job!.id, cancelled.report.id, 'final-worker')
  assert.throws(
    () => publishFinalAnalysis(blockedSnapshot, {
      status: 'completed',
      stage: 'completed',
      stageIndex: AnalysisStages.indexOf('completed'),
      publishAsCurrent: true,
    }),
    /任务已停止|任务租约已失效/,
  )
  assert.equal(getReport(cancelled.report.id)?.currentAnalysisId, undefined)
  assert.equal(getSnapshot(blockedSnapshot.id), undefined)
})

test('final publication preserves the report-owned insight across analysis reruns', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'automatic-insight.docx',
    source: createSource('automatic-insight-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  assert.equal(claimNextJob('automatic-insight-worker', 60_000)?.id, job.id)
  const snapshot = createCanonicalSnapshotWrite(job.id, report.id, 'automatic-insight-worker')
  const artifact = snapshot.artifacts[0]!;
  const state = snapshot.moduleStates[0]!;
  saveArtifact(job.id, artifact, 'automatic-insight-worker')
  saveModuleState(job.id, state, 'automatic-insight-worker')
  publishFinalAnalysis(snapshot, {
    status: 'completed',
    stage: 'completed',
    stageIndex: AnalysisStages.indexOf('completed'),
    publishAsCurrent: true,
  })
  const originalInsight = saveReportInsight(insightRecord(report.id, { title: '自动生成洞察', summary: '这是一份只属于报告正文版本的洞察摘要。' }))

  assert.equal(getJob(job.id)?.status, 'completed')
  assert.equal(getReport(report.id)?.currentAnalysisId, snapshot.id)
  assert.equal(getReportInsight(report.id)?.id, originalInsight.id)

  // 完整分析重试只更新分析页指针，不删除或替换报告正文洞察。
  const rerun = createRetryJob(job.id)!
  const rerunSnapshot = claimThenPublishCanonical(report.id, rerun.id, 'analysis-rerun-worker')
  assert.equal(getReport(report.id)?.currentAnalysisId, rerunSnapshot.id)
  const preservedInsight = getReportInsight(report.id)!
  assert.equal(preservedInsight.id, originalInsight.id)
  assert.equal(preservedInsight.html, originalInsight.html)
  assert.equal(preservedInsight.generatedAt, originalInsight.generatedAt)
  assert.equal(preservedInsight.regenerationCount, originalInsight.regenerationCount)
  const regeneratedInsight = saveReportInsight(insightRecord(report.id, { title: '手动重生成洞察', summary: '重新生成后的摘要。' }))
  assert.equal(regeneratedInsight.regenerationCount, 1)

  updateProject(project.id, { objective: '已经变化的研究目标' })
  assert.throws(() => createRetryJob(rerun.id), /评价背景已变化/)
})

test('report insight generation is reserved once and persists by report body version', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'insight.docx',
    source: createSource('insight-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  claimThenPublishCanonical(report.id, job.id)
  assert.equal(reserveReportInsightGeneration(report.id), true)
  assert.equal(isReportInsightGenerating(report.id), true)
  assert.equal(reserveReportInsightGeneration(report.id), false)
  releaseReportInsightGeneration(report.id)
  assert.equal(isReportInsightGenerating(report.id), false)
  assert.equal(reserveReportInsightGeneration(report.id), true)
  releaseReportInsightGeneration(report.id)

  const saved = saveReportInsight(insightRecord(report.id))
  assert.equal(getReportInsight(report.id)?.id, saved.id)

  // 分析页更新后，报告正文洞察仍然属于同一报告版本。
  const rerun = startReportAnalysis(report.id)!.job
  const rerunSnapshot = claimThenPublishCanonical(report.id, rerun.id)
  assert.equal(getReport(report.id)?.currentAnalysisId, rerunSnapshot.id)
  assert.equal(getReportInsight(report.id)?.id, saved.id)
  assert.equal(getReportInsight(report.id)?.html, saved.html)
  assert.equal(saveReportInsight(insightRecord(report.id)).regenerationCount, 1)
})

test('overview stats exclude insight-only placeholder scores and return compact activity rows', () => {
  const owner = createOwner()
  const project = createProjectForUser({
    title: '概览统计课题',
    objective: '验证紧凑统计',
    description: '占位快照不能冒充完整评分',
    ownerName: owner.displayName,
  }, owner.id)
  updateProject(project.id, {
    milestones: [{ id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' }],
  })
  const statsBefore = getOverviewStats()
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'overview.docx',
    source: createSource('overview-stats-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })

  const stats = getOverviewStats()
  assert.equal(stats.totalReportVersions, statsBefore.totalReportVersions + 1)
  assert.equal(stats.weeklyNewReports, statsBefore.weeklyNewReports + 1)
  assert.deepEqual(stats.trends.averageScore, statsBefore.trends.averageScore)
  assert.deepEqual(stats.trends.analyzedProjects, statsBefore.trends.analyzedProjects)
  const activity = listOverviewActivityReports().filter((item) => item.projectId === project.id)
  assert.equal(activity.length, 1)
  assert.equal(activity[0]?.id, uploaded.report.id)
  assert.equal(activity[0]?.aiScore, undefined)
})

test('replacing a report keeps createdAt and records sourceUpdatedAt for activity', async () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const original = await createStoredSource('replace-created-at-original')
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'created-september.docx',
    source: original,
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  const createdAt = '2026-09-01T08:00:00.000Z'
  getDatabase().prepare('UPDATE report_versions SET created_at = ?, source_updated_at = ? WHERE id = ?').run(createdAt, createdAt, uploaded.report.id)
  getDatabase().prepare('DELETE FROM analysis_jobs WHERE report_version_id = ?').run(uploaded.report.id)
  const versionCount = getDatabase().prepare('SELECT COUNT(*) AS count FROM report_versions WHERE project_id = ?').get(project.id) as { count: number }

  const replacement = await createStoredSource('replace-created-at-updated')
  const replaced = await replaceReportVersionSource(uploaded.report.id, 'updated-october.docx', replacement)
  assert.ok(replaced)
  assert.equal(replaced.report.id, uploaded.report.id)
  assert.equal(replaced.report.version, uploaded.report.version)
  assert.equal(replaced.report.createdAt, createdAt)
  assert.ok(replaced.report.sourceUpdatedAt > createdAt)
  assert.equal(replaced.report.fileName, 'updated-october.docx')
  const afterCount = getDatabase().prepare('SELECT COUNT(*) AS count FROM report_versions WHERE project_id = ?').get(project.id) as { count: number }
  assert.equal(afterCount.count, versionCount.count)

  const activity = listOverviewActivityReports().filter((item) => item.projectId === project.id)
  assert.equal(activity.length, 1)
  assert.equal(activity[0]?.id, uploaded.report.id)
  assert.equal(activity[0]?.createdAt, createdAt)
  assert.equal(activity[0]?.sourceUpdatedAt, replaced.report.sourceUpdatedAt)
  getDatabase().prepare('DELETE FROM analysis_jobs WHERE report_version_id = ?').run(uploaded.report.id)
})

test('report insight generation and full analysis are independent', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'independent.docx',
    source: createSource('insight-analysis-independent'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  assert.equal(getReport(uploaded.report.id)?.currentAnalysisId, undefined)

  assert.equal(reserveReportInsightGeneration(uploaded.report.id), true)
  const started = startReportAnalysis(uploaded.report.id)
  assert.ok(started?.job)
  releaseReportInsightGeneration(uploaded.report.id)

  const insightJob = createInsightGenerationJob(uploaded.report.id, owner)
  assert.equal(insightJob.type, 'insight')
  assert.equal(getReport(uploaded.report.id)?.currentAnalysisId, undefined)
  cancelJob(insightJob.id)
  cancelJob(started!.job.id)
})

test('insight jobs enqueue on the worker queue without replacing analysis progress', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'insight-queue.docx',
    source: createSource('insight-queue-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  claimThenPublishCanonical(report.id, job.id)

  const insightJob = createInsightGenerationJob(report.id, owner)
  assert.equal(insightJob.type, 'insight')
  assert.equal(insightJob.status, 'queued')
  assert.equal(isReportInsightGenerating(report.id), true)
  assert.equal(getLatestJobForReport(report.id)?.id, job.id)
  assert.equal(getLatestJobForReport(report.id)?.type, 'initial')
  const rerun = startReportAnalysis(report.id)
  assert.equal(rerun?.job.type, 'rerun')
  assert.equal(getLatestJobForReport(report.id)?.id, rerun?.job.id)
  assert.throws(() => createInsightGenerationJob(report.id, owner), /洞察正在生成/)

  cancelJob(insightJob.id)
  assert.equal(isReportInsightGenerating(report.id), false)
  cancelJob(rerun!.job.id)
})

test('cancelled insight job rejects late provider results atomically', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'insight-cancel.docx',
    source: createSource('insight-cancel-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  claimThenPublishCanonical(report.id, job.id)

  const insightJob = createInsightGenerationJob(report.id, owner)
  const leaseOwner = 'insight-cancel-worker'
  assert.equal(claimNextJob(leaseOwner, 60_000)?.id, insightJob.id)
  cancelJob(insightJob.id)

  // 取消后 provider 迟到的结果在一个带守卫的事务中被整体拒绝：
  // 洞察行不写入、任务保持取消、无 completed 事件。
  assert.throws(() => completeInsightGenerationWithInsight(insightJob.id, insightRecord(report.id), { tokens: 10 }, leaseOwner), /任务已停止/)
  assert.equal(getReportInsight(report.id), undefined)
  assert.equal(getJob(insightJob.id)?.status, 'cancelled')
  assert.equal(getJobEvents(insightJob.id).at(-1)?.type, 'cancelled')
})

test('cancelled insight job still records complete provider usage without publishing', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'insight-cancel-usage.docx',
    source: createSource('insight-cancel-usage-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  claimThenPublishCanonical(report.id, job.id)

  const insightJob = createInsightGenerationJob(report.id, owner)
  const leaseOwner = 'insight-cancel-usage-worker'
  assert.equal(claimNextJob(leaseOwner, 60_000)?.id, insightJob.id)
  const runtime = getJobModelRuntime(insightJob.id)
  markAnalysisAiCallStarted(insightJob.id, {
    provider: runtime.channel,
    model: runtime.modelName,
    stage: 'report_insight',
    module: 'report_insight',
    attempt: 1,
  }, leaseOwner)
  cancelJob(insightJob.id)

  settleCancelledAnalysisAiCall({
    jobId: insightJob.id,
    details: {
      provider: runtime.channel,
      model: runtime.modelName,
      stage: 'report_insight',
      module: 'report_insight',
      attempt: 1,
      tokens: 12,
    },
    artifact: {
      id: 'artifact-' + insightJob.id + '-report_insight-checkpoint',
      jobId: insightJob.id,
      reportVersionId: report.id,
      moduleId: 'report_insight',
      schemaVersion: 1,
      promptVersion: 'report-insight-checkpoint-v1',
      attempt: 1,
      status: 'failed',
      payload: {
        checkpointVersion: 1,
        reportVersionId: report.id,
        failed: true,
        tokens: 12,
      },
      gateErrors: [{ code: 'MODEL_EXECUTION_FAILED', path: '', message: 'cancelled after usage' }],
      provider: runtime.channel,
      model: runtime.modelName,
      createdAt: now(),
    },
  })

  const settled = getJob(insightJob.id)
  assert.equal(settled?.status, 'cancelled')
  assert.equal(settled?.aiCallsCompleted, 1)
  assert.equal(settled?.aiTokens, 12)
  assert.equal(getReportInsight(report.id), undefined)
  const ledger = getDatabase().prepare('SELECT state, accounted_tokens, model_calls_started, model_calls_completed FROM ai_budget_ledger WHERE job_id = ?').get(insightJob.id) as {
    state: string
    accounted_tokens: number
    model_calls_started: number
    model_calls_completed: number
  }
  assert.equal(ledger.model_calls_started, 1)
  assert.equal(ledger.model_calls_completed, 1)
  assert.equal(ledger.accounted_tokens, 12)
  assert.equal(ledger.state, 'settled')
})

test('report deletion is blocked while report-scoped insight generation holds a lease', async () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'delete-insight.docx',
    source: createSource('delete-insight-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })

  assert.equal(reserveReportInsightGeneration(uploaded.report.id), true)
  await assert.rejects(() => deleteReportVersion(uploaded.report.id), /洞察正在生成/)
  assert.ok(getReport(uploaded.report.id))
  releaseReportInsightGeneration(uploaded.report.id)
  const insightJob = createInsightGenerationJob(uploaded.report.id, owner)
  await assert.rejects(() => deleteReportVersion(uploaded.report.id), /洞察正在生成/)
  cancelJob(insightJob.id)
  assert.equal(await deleteReportVersion(uploaded.report.id), true)
})

test('start analysis stays available until the page_analysis module is accepted', () => {
  const owner = createOwner()
  const project = createStagedProject(owner)
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'partial.docx',
    source: createSource('partial-full-analysis-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })
  assert.equal(getReport(uploaded.report.id)?.hasCompletedFullAnalysis, false)

  const insightJob = createInsightGenerationJob(uploaded.report.id, owner)
  assert.equal(insightJob.type, 'insight')
  // 洞察任务不会创建占位分析快照，也不会改写分析页 current 指针。
  assert.equal(getReport(uploaded.report.id)?.currentAnalysisId, undefined)
  assert.equal(getReport(uploaded.report.id)?.hasCompletedFullAnalysis, false)
  cancelJob(insightJob.id)

  const afterInsight = startReportAnalysis(uploaded.report.id)
  assert.equal(afterInsight?.job.type, 'initial')
  cancelJob(afterInsight!.job.id)
  assert.equal(getReport(uploaded.report.id)?.hasCompletedFullAnalysis, false)

  const full = createReportJob({
    projectId: project.id,
    fileName: 'complete.docx',
    source: createSource('complete-full-analysis-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  claimThenPublishCanonical(full.report.id, full.job!.id)
  assert.equal(getReport(full.report.id)?.hasCompletedFullAnalysis, true)
})

test('canonical snapshot reader rejects cross-report pointers and non-accepted runs', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const first = createReportJob({
    projectId: project.id,
    fileName: 'canonical-first.docx',
    source: createSource('canonical-first-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const published = claimThenPublishCanonical(first.report.id, first.job!.id)
  assert.equal(getReport(first.report.id)?.hasCompletedFullAnalysis, true)

  const second = createReportJob({
    projectId: project.id,
    fileName: 'canonical-second.docx',
    source: createSource('canonical-second-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  // 跨报告指针：把版本二的 current_analysis_id 指向版本一的快照。
  getDatabase().prepare('UPDATE report_versions SET current_analysis_id = ? WHERE id = ?').run(published.id, second.report.id)
  assert.equal(getReport(second.report.id)?.hasCompletedFullAnalysis, false)

  // 仅 partial 快照或有状态缺失的快照也不构成完整分析。
  assert.equal(claimNextJob('canonical-second-worker', 60_000)?.id, second.job!.id)
  const partial = createPartialSnapshot(second.job!.id, second.report.id, 'canonical-second-worker')
  saveAnalysisSnapshot(partial)
  assert.equal(getReport(second.report.id)?.hasCompletedFullAnalysis, false)
  assert.equal(getLatestPartialSnapshotForJob(second.job!.id)?.id, partial.id)
})

test('job events are pruned after the retention window', () => {
  resetJobEventsPruneClock()
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { job } = createReportJob({
    projectId: project.id,
    fileName: 'prune.docx',
    source: createSource('prune-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })

  publishAnalysisEvent(job.id, { type: 'info', message: '近期事件' })
  publishAnalysisEvent(job.id, { type: 'info', message: '历史事件' })
  const events = getJobEvents(job.id)
  assert.equal(events.length, 3) // 创建任务时的排队事件 + 上面两条
  getDatabase().prepare('UPDATE job_events SET created_at = ? WHERE message = ?')
    .run(new Date(Date.now() - 100 * 86_400_000).toISOString(), '历史事件')

  pruneJobEvents()
  const remaining = getJobEvents(job.id)
  assert.equal(remaining.some((event) => event.message === '历史事件'), false)
  assert.equal(remaining.some((event) => event.message === '近期事件'), true)
  assert.ok(remaining.some((event) => event.message.includes('持久化队列')))
})

test('updating collaborators does not demote the persisted owner', () => {
  const owner = createOwner()
  const collaborator = createOrUpdateUser({
    username: `collab-${Math.random().toString(36).slice(2, 8)}`,
    displayName: '协作者',
    password: 'password-collab-123',
    role: 'researcher',
  })
  const project = createProjectForUser({
    title: '成员更新课题',
    objective: '',
    description: '',
    ownerName: owner.displayName,
  }, owner.id)

  updateProject(project.id, { collaboratorIds: [owner.id, collaborator.id] })
  const withOwnerInList = getProjectMembersSnapshot(project.id)!
  assert.equal(withOwnerInList.members.find((member) => member.userId === owner.id)?.role, 'owner')
  assert.equal(withOwnerInList.members.find((member) => member.userId === collaborator.id)?.role, 'editor')
  assert.equal(withOwnerInList.members.filter((member) => member.role === 'owner').length, 1)

  updateProject(project.id, { collaboratorIds: [] })
  const ownerOnly = getProjectMembersSnapshot(project.id)!
  assert.deepEqual(ownerOnly.members.map((member) => [member.userId, member.role]), [[owner.id, 'owner']])
})

test('assigning a stage report keeps later stages complete when a final remains', () => {
  const owner = createOwner()
  const project = createProjectForUser({
    title: '终稿保留课题',
    objective: '识别关键问题并形成决策建议',
    description: '围绕行业现状、风险与实施条件开展研究',
    ownerName: owner.displayName,
  }, owner.id)
  updateProject(project.id, {
    milestones: [
      { id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' },
      { id: 'stage-2', title: '分析验证', targetDate: '2026-08-30', description: '完成交叉验证', status: 'not_started' },
      { id: 'stage-3', title: '成果形成', targetDate: '2026-09-30', description: '完成结论验证并交付决策建议', status: 'not_started' },
    ],
  })
  const first = createReportJob({
    projectId: project.id,
    fileName: '阶段一.docx',
    source: createSource('final-remain-stage-1'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
    deliveryType: 'stage',
  }).report
  const second = createReportJob({
    projectId: project.id,
    fileName: '阶段二.docx',
    source: createSource('final-remain-stage-2'),
    reportId: undefined,
    milestoneId: 'stage-2',
    autoAnalyze: false,
    deliveryType: 'stage',
  }).report
  createReportJob({
    projectId: project.id,
    fileName: '终稿.docx',
    source: createSource('final-remain-final'),
    reportId: undefined,
    milestoneId: 'stage-3',
    autoAnalyze: false,
    deliveryType: 'final',
  })
  assert.deepEqual(getProject(project.id)!.milestones.map((milestone) => milestone.status), ['completed', 'completed', 'completed'])

  assignReportMilestone(second.id, 'stage-1', 'stage')
  const afterMove = getProject(project.id)!
  assert.equal(getReport(first.id)?.milestoneId, 'stage-1')
  assert.equal(getReport(second.id)?.milestoneId, 'stage-1')
  assert.deepEqual(afterMove.milestones.map((milestone) => milestone.status), ['completed', 'completed', 'completed'])
  assert.equal(afterMove.milestones[0].reportIds?.includes(second.id), true)
  assert.equal(afterMove.milestones[1].reportIds?.includes(second.id), false)
})

test('published analysis events reuse the inserted createdAt', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { job } = createReportJob({
    projectId: project.id,
    fileName: 'clock.docx',
    source: createSource('clock-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const original = Date.prototype.toISOString
  let seq = 0
  Date.prototype.toISOString = function toISOString() {
    seq += 1
    return '2026-01-01T00:00:' + String(seq).padStart(2, '0') + '.000Z'
  }
  try {
    const published = publishAnalysisEvent(job.id, { type: 'info', message: '时钟对齐' })
    const stored = getJobEvents(job.id).find((event) => event.message === '时钟对齐')
    assert.ok(published)
    assert.ok(stored)
    assert.equal(published.createdAt, stored.createdAt)
    assert.equal(published.createdAt, '2026-01-01T00:00:01.000Z')
  } finally {
    Date.prototype.toISOString = original
  }
})

test('getReportDetail reuses the current snapshot for full-analysis decoration', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const uploaded = createReportJob({
    projectId: project.id,
    fileName: 'detail.docx',
    source: createSource('detail-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const before = getReportDetail(uploaded.report.id)
  assert.ok(before)
  assert.equal(before.snapshot, undefined)
  assert.equal(before.report.hasCompletedFullAnalysis, false)
  claimThenPublishCanonical(uploaded.report.id, uploaded.job!.id)
  const after = getReportDetail(uploaded.report.id)
  assert.ok(after?.snapshot)
  assert.equal(after.report.hasCompletedFullAnalysis, true)
})

test('failed attempt writes roll back when module state persistence fails', () => {
  getDatabase().prepare('DELETE FROM analysis_jobs').run()
  const owner = createOwner()
  const project = createStagedProject(owner)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'failed-attempt.docx',
    source: createSource('failed-attempt-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const worker = 'failed-attempt-worker'
  assert.equal(claimNextJob(worker, 60_000)?.id, job.id)
  const artifact = {
    id: 'failed-attempt-artifact',
    jobId: job.id,
    reportVersionId: report.id,
    moduleId: 'page_analysis' as const,
    schemaVersion: 1,
    promptVersion: 'failed-attempt',
    attempt: 1,
    status: 'failed' as const,
    payload: { error: '模型调用失败。' },
    gateErrors: [],
    createdAt: now(),
  }
  const state = {
    moduleId: 'page_analysis' as const,
    status: 'failed' as const,
    attempt: 1,
    maxAttempts: 3,
    artifactId: artifact.id,
    gateErrors: [],
    updatedAt: now(),
  }
  getDatabase().exec(`
    CREATE TEMP TRIGGER fail_module_insert BEFORE INSERT ON analysis_module_states
    BEGIN SELECT RAISE(ABORT, 'forced module state failure');
    END;
    CREATE TEMP TRIGGER fail_module_update BEFORE UPDATE ON analysis_module_states
    BEGIN SELECT RAISE(ABORT, 'forced module state failure');
    END;
  `)
  try {
    assert.throws(() => saveFailedAttempt(job.id, artifact, state, worker), /forced module state failure/)
    const artifactCount = getDatabase().prepare('SELECT COUNT(*) AS count FROM analysis_artifacts WHERE job_id = ?').get(job.id) as { count: number }
    const module = getDatabase().prepare("SELECT status FROM analysis_module_states WHERE job_id = ? AND module_id = 'page_analysis'").get(job.id) as { status: string }
    assert.equal(artifactCount.count, 0)
    assert.equal(module.status, 'pending')
  } finally {
    getDatabase().exec('DROP TRIGGER IF EXISTS fail_module_insert; DROP TRIGGER IF EXISTS fail_module_update;')
  }
  saveFailedAttempt(job.id, artifact, state, worker)
  const saved = getDatabase().prepare('SELECT status FROM analysis_artifacts WHERE id = ?').get(artifact.id) as { status: string }
  const module = getDatabase().prepare("SELECT status FROM analysis_module_states WHERE job_id = ? AND module_id = 'page_analysis'").get(job.id) as { status: string }
  assert.equal(saved.status, 'failed')
  assert.equal(module.status, 'failed')
})
