import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { defaultSelection, stageGroup, stageGroupLabel } from '../modules/reports/workspace-query'
import type { AiScore } from '../modules/contracts/analysis'
import type { ProjectWorkflow, ProjectStageRecord } from '../modules/projects/stage-domain'
import type { SubmissionComparison } from '../modules/reports/submission-query'
import {
  allowedReportKinds,
  analysisActionLabel,
  beginSubmitConfirm,
  buildSubmissionCommand,
  characterDeltaFromComparison,
  classifyCommitFailure,
  describeCommitNetworkError,
  dismissWorkspaceSubmit,
  duplicateSubmitFormError,
  comparisonIsHidden,
  createIdempotencyKey,
  currentStageTokens,
  hasCompletedFullAnalysis,
  idleSubmitPhase,
  isCurrentWorkspaceFetch,
  NATIVE_TASK_EVENT_TYPES,
  planIsFrozen,
  presentAiScore,
  previewSubmissionImpact,
  reduceWorkspaceSubmit,
  refreshSubmissionCommand,
  scoreDeltaFromComparison,
  shouldMintNewIdempotencyKey,
  shouldPreserveSubmitPhase,
  SKIPPED_EMPTY_COPY,
  originProjectIdFromSubmit,
  submitCloseLabel,
  submitCommitEnabled,
  type WorkspaceProjectDetail,
  type WorkspaceReportCard,
  type WorkspaceStageGroup,
} from '../lib/workspace-submission'
import {
  applyWorkspaceAnalysisTask,
  applyWorkspaceReportDetail,
  applyWorkspaceInsightTask,
  createWorkspaceReportReader,
  removeWorkspaceReport,
  refreshWorkspaceProjections,
  emptyWorkspaceReportView,
  selectWorkspaceReport,
} from '../components/workspace-submission-state'
import { isTaskInFlight, reportDeleteBlocked, shouldPollReport } from '../lib/workspace-submission'
import { AiScoreCard } from '../components/insight-cards'
import { DashboardView } from '../components/dashboard-view'
import { parseOverviewStats } from '../lib/workspace-submission-client'
import { parseWorkspaceSearch, buildWorkspaceSearch, encodeWorkspaceUrlState } from '../lib/workspace-url'
import type { SubmissionTask } from '../modules/reports/submission-task-domain'
import { EMPTY_SNAPSHOT } from '../lib/analysis-job-progress'

function stage(overrides: Partial<ProjectStageRecord> & Pick<ProjectStageRecord, 'id' | 'ordinal' | 'title' | 'lifecycleStatus'>): ProjectStageRecord {
  return {
    projectId: 'project-1',
    nextReportVersion: 1,
    stateRevision: 0,
    completionRevision: 0,
    ...overrides,
  }
}

function card(overrides: Partial<WorkspaceReportCard> & Pick<WorkspaceReportCard, 'id' | 'stageId' | 'stageVersion'>): WorkspaceReportCard {
  const labels = overrides.labels ?? {
    stageLabel: '阶段01 · 开题研究',
    reportLabel: '开题研究 V' + overrides.stageVersion,
    compactLabel: '阶段01 V' + overrides.stageVersion,
    roleLabel: overrides.isCurrentCompletion ? '阶段完结报告' : '阶段更新报告',
  }
  return {
    projectId: 'project-1',
    submissionSequence: overrides.submissionSequence ?? overrides.stageVersion,
    submittedAs: overrides.submittedAs ?? 'update',
    isCurrentCompletion: Boolean(overrides.isCurrentCompletion),
    isLatestSubmission: Boolean(overrides.isLatestSubmission),
    wasFirstStageSubmission: Boolean(overrides.wasFirstStageSubmission),
    title: overrides.title ?? '研究报告',
    fileName: overrides.fileName ?? 'report.docx',
    sourceSize: overrides.sourceSize ?? 1024,
    paragraphCount: overrides.paragraphCount ?? 12,
    characterCount: overrides.characterCount ?? 4000,
    submittedBy: 'owner',
    submittedAt: overrides.submittedAt ?? '2026-03-02T00:00:00.000Z',
    labels,
    capabilities: overrides.capabilities ?? { ...EMPTY_WORKSPACE_CAPABILITIES, canSubmitUpdate: true, canSubmitCompletion: true, analysisAction: 'start', insightAction: 'none', disabledReasons: [] },
    comparison: overrides.comparison ?? { status: 'unavailable', reason: 'no_predecessor' },
    ...overrides,
  }
}

function groups(stages: ProjectStageRecord[], reports: WorkspaceReportCard[], canSubmit = true): WorkspaceStageGroup[] {
  return [...stages].sort((left, right) => left.ordinal - right.ordinal).map(stage => stageGroup({
    stage, reports: reports.filter(report => report.stageId === stage.id), canWrite: canSubmit,
  }))
}

function workflowFor(stages: WorkspaceStageGroup[], completed = false): ProjectWorkflow {
  return { projectId: 'project-1', planRevision: 0, workflowRevision: 0, nextSubmissionSequence: 1,
    stages: stages.map(group => group.stage), ...(completed ? { completedAt: '2026-03-02T00:00:00Z' } : {}),
  }
}

test('stage labels pad ordinals and keep names separate from version numbers', () => {
  assert.equal(stageGroupLabel({ ordinal: 1, title: '开题研究' }), '阶段01 · 开题研究')
  assert.equal(stageGroupLabel({ ordinal: 12, title: '成果形成' }), '阶段12 · 成果形成')
  assert.equal(stageGroupLabel({ ordinal: 3, title: '  ' }), '阶段03')
})

test('stage groups stay in plan ordinal and reports sort by stage version descending', () => {
  const assembled = groups([
    stage({ id: 's2', ordinal: 2, title: '调研', lifecycleStatus: 'not_started' }),
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress', currentCompletionReportId: 'r1', nextReportVersion: 3 }),
  ], [
    card({ id: 'r2', stageId: 's1', stageVersion: 2, submissionSequence: 2 }),
    card({ id: 'r1', stageId: 's1', stageVersion: 1, submissionSequence: 1, isCurrentCompletion: true }),
  ])
  assert.deepEqual(assembled.map((item) => item.stage.id), ['s1', 's2'])
  assert.deepEqual(assembled[0].reports.map((item) => item.id), ['r2', 'r1'])
  assert.equal(assembled[0].latestInStageReportId, 'r2')
  assert.equal(assembled[0].currentCompletionReportId, 'r1')
  assert.equal(assembled[1].skippedEmpty, false)
})

test('completed stages without reports render skipped-empty copy and only allow completion resubmission', () => {
  const assembled = groups([
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'completed', completionReason: 'skipped' }),
  ], [])
  assert.equal(assembled[0].skippedEmpty, true)
  assert.equal(SKIPPED_EMPTY_COPY, '已完成 · 跳过，暂无报告')
  assert.deepEqual(allowedReportKinds(assembled[0].stage), ['completion'])
  assert.equal(assembled[0].canSubmitUpdate, false)
  assert.equal(assembled[0].canSubmitCompletion, true)
  const readOnly = stageGroup({ stage: assembled[0].stage, reports: [], canWrite: false })
  assert.equal(readOnly.canSubmitUpdate, false)
  assert.equal(readOnly.canSubmitCompletion, false)
})

test('ADR-11 default selection uses current-stage latest, not prior completion or global latest', () => {
  const current = stage({ id: 's2', ordinal: 2, title: '调研', lifecycleStatus: 'in_progress', nextReportVersion: 2 })
  const prior = stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'completed', currentCompletionReportId: 'c1', nextReportVersion: 2 })
  const corrected = groups([prior, current], [
    card({ id: 'c1', stageId: 's1', stageVersion: 1, submissionSequence: 1, isCurrentCompletion: true }),
    card({ id: 'u1', stageId: 's2', stageVersion: 1, submissionSequence: 2 }),
    card({ id: 'u2', stageId: 's2', stageVersion: 2, submissionSequence: 3, isLatestSubmission: true }),
  ])
  assert.deepEqual(defaultSelection({
    stages: corrected,
    workflow: workflowFor(corrected, false),
  }).selected, { stageId: 's2', reportId: 'u2', source: 'current_stage' })
})

test('empty current stage does not fall back to a prior completion', () => {
  const assembled = groups([
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'completed', currentCompletionReportId: 'c1', nextReportVersion: 2 }),
    stage({ id: 's2', ordinal: 2, title: '调研', lifecycleStatus: 'in_progress' }),
  ], [card({ id: 'c1', stageId: 's1', stageVersion: 1, isCurrentCompletion: true })])
  assert.deepEqual(defaultSelection({
    stages: assembled,
    workflow: workflowFor(assembled, false),
  }).selected, { stageId: 's2', source: 'current_stage' })
})

for (const submittedAs of ['update', 'completion'] as const) {
  test('confirmed first ' + submittedAs + ' report opens analysis and survives URL restoration', () => {
    const completion = submittedAs === 'completion'
    const submitted = card({
      id: 'first-report', stageId: 's1', stageVersion: 1, submittedAs,
      isCurrentCompletion: completion, isLatestSubmission: true, wasFirstStageSubmission: true,
    })
    const assembled = groups([
      stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: completion ? 'completed' : 'in_progress', currentCompletionReportId: completion ? submitted.id : undefined, nextReportVersion: 2 }),
      stage({ id: 's2', ordinal: 2, title: '调研', lifecycleStatus: completion ? 'in_progress' : 'not_started' }),
    ], [submitted])
    const projectSelection = { stages: assembled, workflow: workflowFor(assembled) }
    const receipt = { stageId: submitted.stageId, reportId: submitted.id }
    if (completion) assert.equal(defaultSelection(projectSelection).selected.reportId, undefined)
    const selection = defaultSelection({
      ...projectSelection, requested: { stageId: receipt.stageId, reportId: receipt.reportId },
    }).selected
    assert.deepEqual(selection, { ...receipt, source: 'explicit' })
    const reportView = selectWorkspaceReport(emptyWorkspaceReportView(), {
      selection, report: submitted, latestSubmission: submitted,
    })
    const markup = renderToStaticMarkup(createElement(DashboardView, {
      report: reportView.selectedReport, canManage: true,
      onCancelAnalysis: async () => {}, emptyState: createElement('p', null, '上传首版交付报告'),
    }))
    assert.ok(markup.includes('@container/report-board'))
    assert.doesNotMatch(markup, /上传首版交付报告|研究报告交付引导|本阶段暂无报告/)
    const restored = parseWorkspaceSearch(buildWorkspaceSearch(encodeWorkspaceUrlState({
      view: 'dashboard', projectId: submitted.projectId, selectionSource: selection.source,
      stageId: selection.stageId, reportId: selection.reportId,
    })))
    assert.deepEqual(restored, { view: 'dashboard', projectId: submitted.projectId, ...receipt })
    assert.deepEqual(defaultSelection({
      ...projectSelection, requested: { stageId: restored.stageId, reportId: restored.reportId },
    }).selected, selection)
  })
}

test('completed stage defaults to current completion; skipped empty stays empty', () => {
  const completed = groups([
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'completed', currentCompletionReportId: 'c1', nextReportVersion: 3 }),
  ], [
    card({ id: 'u2', stageId: 's1', stageVersion: 2 }),
    card({ id: 'c1', stageId: 's1', stageVersion: 1, isCurrentCompletion: true }),
  ])
  assert.deepEqual(defaultSelection({
    stages: completed,
    workflow: workflowFor(completed, false),
    requested: { stageId: 's1' },
  }).selected, { stageId: 's1', reportId: 'c1', source: 'explicit' })
  assert.deepEqual(defaultSelection({
    stages: completed,
    workflow: workflowFor(completed, true),
  }).selected, { stageId: 's1', reportId: 'c1', source: 'stage_completion' })
  const skipped = groups([
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'completed', completionReason: 'skipped' }),
  ], [])
  assert.deepEqual(defaultSelection({
    stages: skipped,
    workflow: workflowFor(skipped, false),
    requested: { stageId: 's1' },
  }).selected, { stageId: 's1', source: 'explicit' })
})

test('explicit report selection is distinct from latest submission and current completion', () => {
  const assembled = groups([
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'completed', currentCompletionReportId: 'c1', nextReportVersion: 3 }),
    stage({ id: 's2', ordinal: 2, title: '调研', lifecycleStatus: 'in_progress', nextReportVersion: 2 }),
  ], [
    card({ id: 'c1', stageId: 's1', stageVersion: 1, submissionSequence: 1, isCurrentCompletion: true }),
    card({ id: 'u2', stageId: 's2', stageVersion: 1, submissionSequence: 2, isLatestSubmission: true }),
  ])
  const selected = defaultSelection({
    stages: assembled,
    workflow: workflowFor(assembled, false),
    requested: { reportId: 'c1' },
  }).selected
  assert.deepEqual(selected, { stageId: 's1', reportId: 'c1', source: 'explicit' })

})

test('jumping to a later completion lists auto-completed stages and does not delete existing reports', () => {
  const stages = [
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress', currentCompletionReportId: 'c1', nextReportVersion: 2 }),
    stage({ id: 's2', ordinal: 2, title: '调研', lifecycleStatus: 'not_started' }),
    stage({ id: 's3', ordinal: 3, title: '成果形成', lifecycleStatus: 'not_started' }),
  ]
  const impact = previewSubmissionImpact({ stages, targetStageId: 's3', reportKind: 'completion' })
  assert.deepEqual(impact.autoCompletedStages.map((item) => item.id), ['s1', 's2'])
  assert.equal(impact.autoCompletedStages[0].hasReports, true)
  assert.equal(impact.autoCompletedStages[1].hasReports, false)
  assert.equal(impact.projectWillComplete, true)
  assert.equal(impact.supersededCompletionReportId, undefined)
  const currentCompletion = previewSubmissionImpact({ stages, targetStageId: 's1', reportKind: 'completion' })
  assert.equal(currentCompletion.supersededCompletionReportId, 'c1')
  assert.equal(currentCompletion.nextInProgressStage?.id, 's2')
  assert.equal(currentCompletion.projectWillComplete, false)
  const update = previewSubmissionImpact({ stages, targetStageId: 's1', reportKind: 'update' })
  assert.equal(update.supersededCompletionReportId, undefined)
  assert.equal(update.nextInProgressStage, undefined)
})

test('forward updates preview skipped predecessors and the target becoming current without completing it', () => {
  const stages = [
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress' }),
    stage({ id: 's2', ordinal: 2, title: '调研', lifecycleStatus: 'not_started' }),
    stage({ id: 's3', ordinal: 3, title: '成果形成', lifecycleStatus: 'not_started' }),
  ]
  const impact = previewSubmissionImpact({ stages, targetStageId: 's3', reportKind: 'update' })
  assert.deepEqual(impact.autoCompletedStages.map(item => item.id), ['s1', 's2'])
  assert.equal(impact.nextInProgressStage?.id, 's3')
  assert.equal(impact.projectWillComplete, false)
  assert.equal(impact.targetAlreadyCompleted, false)
  assert.equal(impact.supersededCompletionReportId, undefined)
})

test('backfilling a completed stage never previews progression or completing the project again', () => {
  for (const lifecycleStatus of ['in_progress', 'completed'] as const) {
    const stages = [
      stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'completed', currentCompletionReportId: 'original' }),
      stage({ id: 's2', ordinal: 2, title: '成果形成', lifecycleStatus }),
    ]
    const impact = previewSubmissionImpact({ stages, targetStageId: 's1', reportKind: 'completion' })
    assert.deepEqual(impact.autoCompletedStages, [])
    assert.equal(impact.nextInProgressStage, undefined)
    assert.equal(impact.projectWillComplete, false)
    assert.equal(impact.targetAlreadyCompleted, true)
    assert.equal(impact.supersededCompletionReportId, 'original')
  }
})

test('comparison hides first-stage submissions and omits missing scores', () => {
  const first: SubmissionComparison = { status: 'unavailable', reason: 'first_stage_submission' }
  const missingScore: SubmissionComparison = {
    status: 'available',
    baselineReportId: 'b1',
    baselineStageId: 's1',
    baselineStageVersion: 1,
    characterDelta: 120,
  }
  const cross: SubmissionComparison = {
    status: 'available',
    baselineReportId: 'b1',
    baselineStageId: 's1',
    baselineStageVersion: 2,
    characterDelta: -40,
    scoreDelta: 3,
  }
  assert.equal(comparisonIsHidden(first), true)
  assert.equal(characterDeltaFromComparison(first), undefined)
  assert.equal(characterDeltaFromComparison(missingScore), 120)
  assert.equal(scoreDeltaFromComparison(first), undefined)
  assert.equal(scoreDeltaFromComparison(missingScore), undefined)
  assert.equal(scoreDeltaFromComparison(cross), 3)
})

test('analysis labels follow server capabilities and missing success is not treated as complete', () => {
  assert.equal(analysisActionLabel('start'), '启动分析')
  assert.equal(analysisActionLabel('retry'), '再次分析')
  assert.equal(analysisActionLabel('rerun'), '更新分析')
  assert.equal(analysisActionLabel('none'), undefined)
  const report = card({
    id: 'r1',
    stageId: 's1',
    stageVersion: 1,
    capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, analysisAction: 'view', disabledReason: 'HISTORICAL_OPERATION_ALREADY_SUCCEEDED' },
  })
  assert.equal(hasCompletedFullAnalysis(report), false)
  assert.equal(hasCompletedFullAnalysis({ ...report, aiScore: 88 }), true)
  assert.equal(hasCompletedFullAnalysis({
    ...report,
    capabilities: { ...report.capabilities, analysisAction: 'rerun' },
  }), true)
})

test('conflict reconfirmation refreshes tokens and mints a new idempotency key', () => {
  const command = buildSubmissionCommand({
    uploadId: 'upload_1',
    stageId: 's1',
    reportKind: 'completion',
    tokens: { planRevision: 1, workflowRevision: 2, completionRevision: 0, completionReportId: 'c1' },
  })
  const refreshed = refreshSubmissionCommand(command, {
    planRevision: 1,
    workflowRevision: 3,
    completionRevision: 1,
    completionReportId: 'c2',
  })
  assert.equal(refreshed.expectedWorkflowRevision, 3)
  assert.equal(refreshed.expectedCompletionReportId, 'c2')
  assert.equal(shouldMintNewIdempotencyKey('STAGE_COMPLETION_CHANGED'), true)
  assert.equal(shouldMintNewIdempotencyKey('PROJECT_WORKFLOW_CHANGED'), true)
  assert.equal(shouldMintNewIdempotencyKey('IDEMPOTENCY_KEY_REUSED'), false)
  assert.equal(shouldMintNewIdempotencyKey('UPLOAD_NOT_READY'), false)
  const key = createIdempotencyKey(18, (size) => Uint8Array.from({ length: size }, (_, index) => index + 10))
  assert.match(key, /^[A-Za-z0-9_-]{16,128}$/)
})

test('two-step submit flow keeps prepare separate from confirmation and preserves conflict state', () => {
  const file = new File(['report'], 'report.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const configure = reduceWorkspaceSubmit(idleSubmitPhase(), { type: 'select_file', file })
  assert.equal(configure.step, 'configure')
  const confirm = beginSubmitConfirm({
    file,
    stageId: 's1',
    reportKind: 'completion',
    impact: { autoCompletedStages: [], projectWillComplete: false, targetAlreadyCompleted: false },
  })
  assert.equal(confirm.step, 'confirm')
  const prepared = reduceWorkspaceSubmit({
    step: 'preparing',
    file,
    stageId: 's1',
    reportKind: 'completion',
    impact: confirm.impact,
  }, { type: 'prepare_succeeded', upload: {
    id: 'upload_1',
    projectId: 'project-1',
    status: 'ready',
    fileName: 'report.docx',
    createdAt: '2026-03-02T00:00:00.000Z',
    expiresAt: '2026-03-02T01:00:00.000Z',
    preview: { title: '研究报告', paragraphCount: 12, characterCount: 4000 },
  } })
  assert.ok(prepared.step === 'prepared')
  assert.equal(prepared.step, 'prepared')
  if (prepared.step !== 'prepared') throw new Error('expected prepared')
  const command = buildSubmissionCommand({
    uploadId: prepared.upload.id,
    stageId: 's1',
    reportKind: 'completion',
    tokens: { planRevision: 0, workflowRevision: 0, completionRevision: 0, completionReportId: null },
  })
  const submitting = reduceWorkspaceSubmit(prepared, { type: 'commit_started', command, idempotencyKey: 'submit_key_12345678' })
  assert.equal(submitting.step, 'submitting')
  if (submitting.step !== 'submitting') throw new Error('expected submitting')
  const conflict = reduceWorkspaceSubmit(submitting, {
    type: 'commit_conflict',
    conflict: { code: 'STAGE_COMPLETION_CHANGED', error: '阶段完结报告已变化，请重新确认。' },
    tokens: { planRevision: 0, workflowRevision: 1, completionRevision: 1, completionReportId: 'c9' }, tokensReady: true,
  })
  assert.equal(conflict.step, 'conflict')
  if (conflict.step !== 'conflict') throw new Error('expected conflict')
  assert.equal(conflict.command.expectedCompletionReportId, 'c9')
  assert.equal(conflict.upload.id, 'upload_1')
})

test('plan editing freezes add/reorder after the first formal submission', () => {
  const empty = groups([stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress' })], [])
  const used = groups([
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress', nextReportVersion: 2 }),
  ], [card({ id: 'r1', stageId: 's1', stageVersion: 1 })])
  assert.equal(planIsFrozen(empty), false)
  assert.equal(planIsFrozen(used), true)
})

test('report view state keeps latest, completion and explicit selection independent', () => {
  const latest = card({ id: 'latest', stageId: 's2', stageVersion: 1, isLatestSubmission: true })
  const completion = card({ id: 'done', stageId: 's1', stageVersion: 2, isCurrentCompletion: true })
  let state = emptyWorkspaceReportView()
  state = selectWorkspaceReport(state, { selection: { stageId: 's2', reportId: 'latest', source: 'current_stage' }, report: latest, latestSubmission: latest })
  state = applyWorkspaceReportDetail(state, { report: latest, snapshot: undefined })
  const switched = selectWorkspaceReport(state, { selection: { stageId: 's1', reportId: 'done', source: 'explicit' }, report: completion, latestSubmission: latest })
  assert.equal(switched.selectedReport?.id, 'done')
  assert.equal(switched.latestSubmission?.id, 'latest')
  assert.equal(switched.snapshot, undefined)
  const ignored = applyWorkspaceReportDetail(switched, { report: latest })
  assert.equal(ignored.selectedReport?.id, 'done')
})

test('analysis and insight tasks stay distinct, cancelRequested still blocks delete, and missing jobs are not submission failures', () => {
  const analysis: SubmissionTask = {
    id: 'analysis-1', reportId: 'r1', projectId: 'project-1', actorId: 'owner', operation: 'analysis',
    generation: 1, status: 'running', stage: 'page_analysis', stageIndex: 2, attempts: 1, cancelRequested: true,
    createdAt: '2026-03-02T00:00:00.000Z', updatedAt: '2026-03-02T00:00:01.000Z',
  }
  const insight: SubmissionTask = {
    id: 'insight-1', reportId: 'r1', projectId: 'project-1', actorId: 'owner', operation: 'insight',
    generation: 1, status: 'queued', stage: 'validating', stageIndex: 0, attempts: 0, cancelRequested: false,
    createdAt: '2026-03-02T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z',
  }
  assert.equal(isTaskInFlight(analysis), true)
  assert.equal(reportDeleteBlocked({ canDelete: true, analysisTask: analysis, insightTask: insight }), true)
  assert.equal(reportDeleteBlocked({
    canDelete: true,
    analysisTask: { ...analysis, status: 'cancelled', cancelRequested: false },
    insightTask: { ...insight, status: 'completed' },
  }), false)
  assert.equal(shouldPollReport({ dispatch: { status: 'pending' } }), true)
  assert.equal(shouldPollReport({ dispatch: { status: 'leased' } }), true)
  assert.equal(shouldPollReport({ analysisTask: analysis }), true)
  assert.equal(shouldPollReport({ dispatch: { status: 'published' } }), false)
  assert.equal(shouldPollReport({}), false)
  let state = selectWorkspaceReport(emptyWorkspaceReportView(), {
    selection: { stageId: 's1', reportId: 'r1', source: 'current_stage' },
    report: card({ id: 'r1', stageId: 's1', stageVersion: 1 }),
  })
  state = applyWorkspaceAnalysisTask(state, analysis)
  state = applyWorkspaceReportDetail(state, {
    report: card({ id: 'r1', stageId: 's1', stageVersion: 1 }),
    analysisTask: analysis,
    insightTask: insight,
    outboxPending: false,
    dispatchError: { operation: 'analysis', code: 'BUDGET_EXCEEDED', message: '分析未入队：预算不足。' },
  })
  assert.equal(state.analysisTask?.id, 'analysis-1')
  assert.equal(state.insightTask?.id, 'insight-1')
  assert.equal(state.dispatchError?.code, 'BUDGET_EXCEEDED')
})

test('overview stats ignore legacy totalReportVersions and do not coerce missing scores to zero', () => {
  const stats = parseOverviewStats({
    totalReportVersions: 9,
    submittedReportCount: 4,
    completedStageCount: 2,
    jobStats: { completed: 1, failed: 0, cancelled: 0, running: 0, queued: 0 },
    trends: { versions: [1, 2, 3], submissions: [4, 5] },
  })
  assert.equal(stats.submittedReportCount, 4)
  assert.deepEqual(stats.trends.submissions, [4, 5])
  assert.deepEqual(parseOverviewStats({ submittedReportCount: 1, trends: { versions: [9, 8] } }).trends.submissions, [])
  assert.notEqual(stats.submittedReportCount, 9)
})

test('workspace URLs carry explicit stage selection without a report', () => {
  assert.deepEqual(parseWorkspaceSearch('?view=dashboard&project=project-1&stage=s2'), {
    view: 'dashboard',
    projectId: 'project-1',
    stageId: 's2',
  })
  assert.equal(buildWorkspaceSearch({ view: 'history', projectId: 'project-1', stageId: 's2' }), '?view=history&project=project-1&stage=s2')
})

test('submission tokens use current completion rather than latest submission', () => {
  const assembled = groups([
    stage({ id: 's1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress', currentCompletionReportId: 'c1', nextReportVersion: 3 }),
  ], [
    card({ id: 'u2', stageId: 's1', stageVersion: 2, submissionSequence: 2, isLatestSubmission: true }),
    card({ id: 'c1', stageId: 's1', stageVersion: 1, submissionSequence: 1, isCurrentCompletion: true }),
  ])
  const detail: WorkspaceProjectDetail = {
    project: {
      id: 'project-1',
      title: '课题',
      ownerId: 'owner',
      ownerName: '负责人',
      objective: '研究目标',
      description: '研究说明',
      canManage: true,
      canDelete: false,
      canSubmit: true,
      canEditPlan: true,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      submittedReportCount: 2,
      completedStageCount: 0,
    },
    workflow: { planRevision: 0, workflowRevision: 1, nextSubmissionSequence: 3, currentStageId: 's1' },
    stages: assembled,
    latestSubmission: assembled[0].reports[0],
    currentCompletionByStage: { s1: 'c1' },
    selected: { stageId: 's1', reportId: 'c1', source: 'explicit' },
  }
  assert.equal(detail.latestSubmission?.id, 'u2')
  assert.deepEqual(currentStageTokens(assembled[0], detail.workflow), {
    planRevision: 0,
    workflowRevision: 1,
    completionRevision: 0,
    completionReportId: 'c1',
  })
})

test('live workspace entry is native and does not reintroduce replacement or reassignment', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../components/workspace-app.tsx', import.meta.url), 'utf8')
  assert.match(page, /from '@\/components\/workspace-app'/)
  assert.match(page, /<WorkspaceApp \/>/)
  assert.doesNotMatch(page, /from '@\/components\/dashboard'/)
  assert.doesNotMatch(app, /ReplaceReportDialog|ReportStageAssignmentDialog|onNeedStageAssignment|deliveryType/)
  assert.doesNotMatch(app, /ReportVersion/)
  assert.match(app, /urlHydrated/)
  assert.match(app, /navGeneration/)
  assert.match(app, /fetchWorkspaceReports/)
  assert.match(app, /NATIVE_TASK_EVENT_TYPES/)
  assert.match(app, /addEventListener\(type, invalidate\)/)
  assert.doesNotMatch(app, /urlReady\.current = true/)
  assert.doesNotMatch(app, /source\.onmessage/)
  assert.doesNotMatch(app, /parseJobProgressEvent/)
  assert.doesNotMatch(app, /setLibraryReports\(\[\.\.\.\(overview\.recentReports/)
  const workbench = readFileSync(new URL('../components/research-workbench.tsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../components/dashboard-view.tsx', import.meta.url), 'utf8')
  assert.match(workbench, /查看最近提交/)
  assert.doesNotMatch(workbench, /返回当前成果/)
  assert.match(board, /onReturnToLatestReport=\{onReturnToLatest\}/)
  assert.match(app, /onReturnToLatest=\{detail\.latestSubmission \? \(\) => openReport\(detail\.latestSubmission!\) : undefined\}/)
  assert.equal(isCurrentWorkspaceFetch({ generation: 1, currentGeneration: 2, expectedReportId: 'a', selectedReportId: 'a', fetchedReportId: 'a' }), false)
  assert.equal(isCurrentWorkspaceFetch({ generation: 2, currentGeneration: 2, expectedReportId: 'a', selectedReportId: 'b', fetchedReportId: 'a' }), false)
  assert.equal(isCurrentWorkspaceFetch({ generation: 2, currentGeneration: 2, expectedReportId: 'a', selectedReportId: 'a', fetchedReportId: 'b' }), false)
  assert.equal(isCurrentWorkspaceFetch({ generation: 2, currentGeneration: 2, expectedReportId: 'a', selectedReportId: 'a', fetchedReportId: 'a' }), true)
  assert.ok(NATIVE_TASK_EVENT_TYPES.includes('queued'))
  assert.ok(NATIVE_TASK_EVENT_TYPES.includes('claimed'))
  assert.ok(NATIVE_TASK_EVENT_TYPES.includes('succeeded'))
  assert.ok(NATIVE_TASK_EVENT_TYPES.includes('cancellation_requested'))
})

test('startup callbacks stay stable so auth is not aborted and default navigation stays selected', () => {
  const toast = readFileSync(new URL('../components/use-toast.ts', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../components/workspace-app.tsx', import.meta.url), 'utf8')
  assert.match(toast, /const showNotice = useCallback/)
  assert.match(toast, /const clearNotice = useCallback/)
  assert.match(toast, /\}, \[duration\]/)
  assert.match(app, /void refreshLibrary\(controller\.signal\)[\s\S]{0,80}\}, \[refreshLibrary, refreshProjects, refreshStats\]/)
  assert.match(app, /window\.addEventListener\('popstate', applyLocation\)[\s\S]{0,160}\}, \[loadProject, showNotice\]/)
  assert.doesNotMatch(app, /\}, \[loadProject, showNotice, view/)
  assert.match(app, /const persistUrl = useCallback\([\s\S]*?sameWorkspaceLocation[\s\S]*?\}, \[\]\)/)
  assert.match(app, /const applyFetchedReport = useCallback\([\s\S]*?isCurrentWorkspaceFetch[\s\S]*?\}, \[\]\)/)
  assert.match(app, /if \(!urlHydrated\) return/)
  assert.doesNotMatch(app, /urlReady\.current = true/)
  assert.equal(buildWorkspaceSearch(encodeWorkspaceUrlState({
    view: 'dashboard',
    projectId: 'project-1',
    selectionSource: 'current_stage',
    stageId: 's2',
    reportId: 'r-old',
  })), '?view=dashboard&project=project-1')
})
test('submit reducer keeps exact commit identity on uncertain retry and never reprepares after ack', () => {
  const file = new File(['report'], 'report.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const impact = { autoCompletedStages: [], projectWillComplete: false, targetAlreadyCompleted: false }
  const upload = {
    id: 'upload_1',
    projectId: 'project-1',
    status: 'ready' as const,
    fileName: 'report.docx',
    createdAt: '2026-03-02T00:00:00.000Z',
    expiresAt: '2026-03-02T01:00:00.000Z',
    preview: { title: '研究报告', paragraphCount: 12, characterCount: 4000 },
  }
  let phase = reduceWorkspaceSubmit(idleSubmitPhase(), { type: 'select_file', file })
  phase = reduceWorkspaceSubmit(phase, { type: 'configure', stageId: 's1', reportKind: 'completion', impact })
  phase = reduceWorkspaceSubmit(phase, { type: 'prepare_started' })
  phase = reduceWorkspaceSubmit(phase, { type: 'prepare_succeeded', upload })
  const command = buildSubmissionCommand({
    uploadId: upload.id,
    stageId: 's1',
    reportKind: 'completion',
    tokens: { planRevision: 0, workflowRevision: 0, completionRevision: 0, completionReportId: null },
  })
  const key = 'submit_key_12345678'
  phase = reduceWorkspaceSubmit(phase, { type: 'commit_started', command, idempotencyKey: key })
  assert.equal(phase.step, 'submitting')
  phase = reduceWorkspaceSubmit(phase, { type: 'commit_uncertain', error: 'network down' })
  assert.equal(phase.step, 'uncertain')
  if (phase.step !== 'uncertain') throw new Error('expected uncertain')
  assert.equal(phase.idempotencyKey, key)
  assert.equal(phase.upload.id, 'upload_1')
  const retry = reduceWorkspaceSubmit(phase, { type: 'commit_started', command: { ...command, expectedWorkflowRevision: 99 }, idempotencyKey: 'DIFFERENT_KEY_XXXXXX' })
  assert.equal(retry.step, 'submitting')
  if (retry.step !== 'submitting') throw new Error('expected submitting')
  assert.equal(retry.idempotencyKey, key)
  assert.equal(retry.command.expectedWorkflowRevision, 0)
  assert.equal(reduceWorkspaceSubmit(phase, { type: 'prepare_started' }).step, 'uncertain')
  const receipt = { reportId: 'r1', projectId: 'project-1', stageId: 's1', stageVersion: 1, submissionSequence: 1, submittedAs: 'completion' as const, submittedAt: '2026-03-02T00:00:02.000Z', outboxEventId: 'evt-1' }
  const ack = reduceWorkspaceSubmit(retry, { type: 'commit_acknowledged', receipt })
  const afterRefresh = reduceWorkspaceSubmit(ack, { type: 'refresh_failed', error: 'stats failed' })
  assert.equal(afterRefresh.step, 'acknowledged')
  if (afterRefresh.step !== 'acknowledged') throw new Error('expected acknowledged')
  assert.equal(afterRefresh.receipt.reportId, 'r1')
  assert.equal(afterRefresh, ack)
  assert.equal(reduceWorkspaceSubmit(afterRefresh, { type: 'prepare_started' }).step, 'acknowledged')
  assert.equal(reduceWorkspaceSubmit(afterRefresh, { type: 'select_file', file }).step, 'acknowledged')
  assert.equal(reduceWorkspaceSubmit(afterRefresh, { type: 'commit_started', command, idempotencyKey: 'new_key_abcdefghij' }).step, 'acknowledged')
})

test('conflict without fresh tokens cannot commit and does not fall back to old tokens', () => {
  const file = new File(['report'], 'report.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const prepared = reduceWorkspaceSubmit({
    step: 'preparing', file, stageId: 's1', reportKind: 'completion',
    impact: { autoCompletedStages: [], projectWillComplete: false, targetAlreadyCompleted: false },
  }, { type: 'prepare_succeeded', upload: { id: 'upload_1', projectId: 'project-1', status: 'ready' as const, fileName: 'report.docx', createdAt: '2026-03-02T00:00:00.000Z', expiresAt: '2026-03-02T01:00:00.000Z' } })
  assert.ok(prepared.step === 'prepared')
  const command = buildSubmissionCommand({
    uploadId: prepared.upload.id, stageId: 's1', reportKind: 'completion',
    tokens: { planRevision: 0, workflowRevision: 0, completionRevision: 0, completionReportId: null },
  })
  const submitting = reduceWorkspaceSubmit(prepared, { type: 'commit_started', command, idempotencyKey: 'submit_key_12345678' })
  assert.equal(submitting.step, 'submitting')
  if (submitting.step !== 'submitting') throw new Error('expected submitting')
  const stale = reduceWorkspaceSubmit(submitting, {
    type: 'commit_conflict',
    conflict: { code: 'STAGE_COMPLETION_CHANGED', error: '阶段完结报告已变化。' },
    tokens: { planRevision: 0, workflowRevision: 0, completionRevision: 0, completionReportId: null },
    tokensReady: false,
  })
  assert.equal(stale.step, 'conflict')
  if (stale.step !== 'conflict') throw new Error('expected conflict')
  assert.equal(stale.tokensReady, false)
  assert.equal(stale.command.expectedCompletionReportId, null)
  assert.equal(reduceWorkspaceSubmit(stale, { type: 'commit_started', command, idempotencyKey: 'fresh_key_abcdefgh' }).step, 'conflict')
  const ready = reduceWorkspaceSubmit(stale, { type: 'conflict_refreshed', tokens: { planRevision: 1, workflowRevision: 2, completionRevision: 2, completionReportId: 'c9' } })
  assert.equal(ready.step, 'conflict')
  if (ready.step !== 'conflict') throw new Error('expected conflict')
  assert.equal(ready.tokensReady, true)
  assert.equal(ready.command.expectedCompletionReportId, 'c9')
  const retry = reduceWorkspaceSubmit(ready, { type: 'commit_started', command: ready.command, idempotencyKey: 'fresh_key_abcdefgh' })
  assert.equal(retry.step, 'submitting')
  if (retry.step !== 'submitting') throw new Error('expected submitting')
  assert.equal(retry.idempotencyKey, 'fresh_key_abcdefgh')
  assert.equal(classifyCommitFailure({ status: 409, code: 'STAGE_COMPLETION_CHANGED' }), 'conflict')
  assert.equal(classifyCommitFailure({ status: 500 }), 'uncertain')
  assert.equal(classifyCommitFailure({ status: 0, code: 'NETWORK' }), 'uncertain')
  assert.equal(classifyCommitFailure({ status: 409, code: 'UPLOAD_ALREADY_COMMITTED' }), 'already_committed')
})

test('close and reopen preserve uncertain submission identity and guard success navigation', () => {
  const file = new File(['report'], 'report.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const upload = {
    id: 'upload_1',
    projectId: 'project-1',
    status: 'ready' as const,
    fileName: 'report.docx',
    createdAt: '2026-03-02T00:00:00.000Z',
    expiresAt: '2026-03-02T01:00:00.000Z',
    preview: { title: '研究报告', paragraphCount: 12, characterCount: 4000 },
  }
  const prepared = reduceWorkspaceSubmit({
    step: 'preparing',
    file,
    stageId: 's1',
    reportKind: 'completion',
    impact: { autoCompletedStages: [], projectWillComplete: false, targetAlreadyCompleted: false },
  }, { type: 'prepare_succeeded', upload: upload })
  assert.ok(prepared.step === 'prepared')
  const submitting = reduceWorkspaceSubmit(prepared, {
    type: 'commit_started',
    command: buildSubmissionCommand({
      uploadId: upload.id,
      stageId: 's1',
      reportKind: 'completion',
      tokens: { planRevision: 0, workflowRevision: 0, completionRevision: 0, completionReportId: null },
    }),
    idempotencyKey: 'submit_key_keep',
  })
  assert.equal(submitting.step, 'submitting')
  if (submitting.step !== 'submitting') throw new Error('expected submitting')
  const uncertain = reduceWorkspaceSubmit(submitting, { type: 'commit_uncertain', error: '提交结果未确认。将使用相同幂等键重试，不会重新解析文件。' })
  assert.equal(uncertain.step, 'uncertain')
  if (uncertain.step !== 'uncertain') throw new Error('expected uncertain')
  assert.equal(shouldPreserveSubmitPhase(uncertain), true)
  assert.equal(shouldPreserveSubmitPhase(submitting), true)
  assert.equal(shouldPreserveSubmitPhase(prepared), false)
  assert.equal(dismissWorkspaceSubmit(uncertain), uncertain)
  assert.equal(dismissWorkspaceSubmit(submitting), submitting)
  assert.equal(dismissWorkspaceSubmit(prepared).step, 'idle')
  assert.equal(reduceWorkspaceSubmit(uncertain, { type: 'reset' }), uncertain)
  assert.equal(originProjectIdFromSubmit(uncertain), 'project-1')
  assert.equal(submitCommitEnabled(uncertain, 'project-1'), true)
  assert.equal(submitCommitEnabled(uncertain, 'project-2'), false)
  assert.equal(submitCloseLabel(uncertain), '稍后确认')
  assert.equal(submitCloseLabel(submitting), '稍后确认')
  assert.equal(submitCloseLabel(idleSubmitPhase()), '取消')
  assert.equal(duplicateSubmitFormError(uncertain, uncertain.error), true)
  assert.equal(duplicateSubmitFormError(prepared, '解析失败'), false)
  assert.equal(describeCommitNetworkError(new TypeError('Failed to fetch')), '网络中断，提交结果未确认。请重试同一提交，不要重新上传。')
  assert.equal(describeCommitNetworkError(new Error('boom'), 'Failed to fetch'), '网络中断，提交结果未确认。请重试同一提交，不要重新上传。')
  const retry = reduceWorkspaceSubmit(uncertain, { type: 'commit_started', command: uncertain.command, idempotencyKey: uncertain.idempotencyKey })
  assert.equal(retry.step, 'submitting')
  if (retry.step !== 'submitting') throw new Error('expected submitting')
  assert.equal(retry.idempotencyKey, 'submit_key_keep')
  assert.equal(retry.command, uncertain.command)
  const app = readFileSync(new URL('../components/workspace-app.tsx', import.meta.url), 'utf8')
  const flow = readFileSync(new URL('../components/workspace-submit-flow.tsx', import.meta.url), 'utf8')
  assert.match(app, /onClose={closeSubmit}/)
  assert.doesNotMatch(app, /onSubmit={detail\.project\.canSubmit \? openSubmit : undefined}/)
  assert.match(app, /const generationAtCommit = navGeneration\.current/)
  assert.match(app, /if \(navGeneration\.current === generationAtCommit\)\s*\{\s*setView\(completionReplacement \? 'history' : 'dashboard'\)\s*void loadProject\(originProjectId, \{ stageId, reportId \}, refreshErrorNotice\)/)
  assert.doesNotMatch(app, /setSubmitOpen\(true\); setSubmitPhase\(idleSubmitPhase\(\)\)/)
  assert.match(flow, /submitCloseLabel\(phase\)/)
  assert.match(flow, /正在返回原课题后再确认同一提交/)
})

// 旧快照可能残留 previousOverall：夹具用具名局部扩展类型携带多余字段，断言展示层忽略它，不弱化契约。
type LegacyAiScore = AiScore & { previousOverall: number }
const staleInsightScore: LegacyAiScore = { overall: 88, previousOverall: 12, summary: 'ok', dimensions: [{ id: '证据质量', label: '证据充分', score: 88 }] }

test('score card uses comparison scoreDelta, keeps valid zeros, and hides first-stage or missing baselines', () => {
  const first = { status: 'unavailable' as const, reason: 'first_stage_submission' as const }
  const missing = { status: 'available' as const, baselineReportId: 'b1', baselineStageId: 's1', baselineStageVersion: 1, characterDelta: 10 }
  const zeroDelta = { status: 'available' as const, baselineReportId: 'b1', baselineStageId: 's1', baselineStageVersion: 1, characterDelta: 0, scoreDelta: 0 }
  const up = { status: 'available' as const, baselineReportId: 'b1', baselineStageId: 's1', baselineStageVersion: 1, characterDelta: 8, scoreDelta: 3 }
  assert.equal(scoreDeltaFromComparison(first), undefined)
  assert.equal(scoreDeltaFromComparison(missing), undefined)
  assert.equal(scoreDeltaFromComparison(zeroDelta), 0)
  const zeroWithLegacy: LegacyAiScore = { overall: 0, previousOverall: 12, summary: 'ok', dimensions: [{ id: '证据质量', label: '证据充分', score: 0 }] }
  const presented = presentAiScore(zeroWithLegacy, zeroDelta)
  assert.equal('previousOverall' in presented.score, false)
  assert.equal(presented.score.overall, 0)
  assert.equal(presented.scoreDelta, 0)
  const upWithLegacy: LegacyAiScore = { overall: 88, previousOverall: 80, summary: 'ok', dimensions: [{ id: '证据质量', label: '证据充分', score: 88 }] }
  const hidden = presentAiScore(upWithLegacy, first)
  assert.equal(hidden.scoreDelta, undefined)
  const zeroMarkup = renderToStaticMarkup(createElement(AiScoreCard, { score: presented.score, scoreDelta: presented.scoreDelta, jobStatus: 'completed' }))
  assert.match(zeroMarkup, />0<\/span>/)
  assert.match(zeroMarkup, /0 分/)
  assert.match(zeroMarkup, /较上一版/)
  const missingMarkup = renderToStaticMarkup(createElement(AiScoreCard, { score: staleInsightScore, jobStatus: 'completed' }))
  assert.doesNotMatch(missingMarkup, /较上一版/)
  const board = renderToStaticMarkup(createElement(DashboardView, {
    report: card({ id: 'r2', stageId: 's1', stageVersion: 2, characterCount: 4000, comparison: up, aiScore: 88 }),
    snapshot: {
      schemaVersion: 1,
      reportDetails: { sections: [{ id: 's', title: 't', summary: 'x' }], completenessConclusion: 'ok' },
      reportCompleteness: { overall: 80, dimensions: [], mainGap: '' },
      aiScore: staleInsightScore,
      suggestions: [],
      visualization: { mindMap: { id: 'root', label: '', children: [] }, wordCloud: [], heatmap: { rows: [] } },
    },
    canManage: true,
    onCancelAnalysis: async () => {},
  }))
  assert.match(board, /↑ 3 分/)
  assert.doesNotMatch(board, /↑ 76 分/)
  assert.match(board, /overflow-y-hidden/)
  assert.doesNotMatch(board, /^<div[^>]*overflow-y-auto/)
  const firstWithLegacy: LegacyAiScore = { overall: 70, previousOverall: 0, summary: 'ok', dimensions: [{ id: '证据质量', label: '证据充分', score: 70 }] }
  const firstBoard = renderToStaticMarkup(createElement(DashboardView, {
    report: card({ id: 'r1', stageId: 's1', stageVersion: 1, comparison: first, aiScore: 70 }),
    snapshot: {
      schemaVersion: 1,
      reportDetails: { sections: [{ id: 's', title: 't', summary: 'x' }], completenessConclusion: 'ok' },
      reportCompleteness: { overall: 70, dimensions: [], mainGap: '' },
      aiScore: firstWithLegacy,
      suggestions: [],
      visualization: { mindMap: { id: 'root', label: '', children: [] }, wordCloud: [], heatmap: { rows: [] } },
    },
    canManage: true,
    onCancelAnalysis: async () => {},
  }))
  assert.doesNotMatch(firstBoard, /较上一版/)
  assert.match(board, /@container\/report-board/)
  assert.match(board, /@\[1000px\]\/report-board:grid-cols-\[minmax\(0,1fr\)_350px\]/)
  assert.match(board, /@\[640px\]\/report-board:grid-cols-\[repeat\(2,minmax\(280px,1fr\)\)\]/)
})

for (const viewingHistorical of [false, true]) {
  for (const status of [undefined, 'queued', 'running', 'completed', 'failed', 'cancelled'] as const) {
    test('update report is rendered only outside active analysis with historical=' + viewingHistorical + ' and analysis=' + status, () => {
      const analysisTask: SubmissionTask | undefined = status ? {
        id: 'analysis-1', reportId: 'r1', projectId: 'project-1', actorId: 'owner', operation: 'analysis',
        generation: 1, status, stage: 'page_analysis', stageIndex: 2, attempts: 1, cancelRequested: false,
        createdAt: '2026-03-02T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z',
      } : undefined
      for (const canManage of [false, true]) {
        for (const onUpdateReport of [undefined, () => {}]) {
          const markup = renderToStaticMarkup(createElement(DashboardView, {
            report: card({ id: 'r1', stageId: 's1', stageVersion: 1 }),
            canManage, viewingHistorical, analysisTask, onUpdateReport,
            onCancelAnalysis: async () => {}, onReturnToLatest: () => {},
          }))
          const buttons = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
          const updateButtons = buttons.filter(button => button.replace(/<[^>]+>/g, '') === '更新报告')
          const shouldRenderUpdateReport = Boolean(onUpdateReport) && status !== 'queued' && status !== 'running'
          assert.equal(updateButtons.length, shouldRenderUpdateReport ? 1 : 0)
          if (shouldRenderUpdateReport) {
            assert.match(updateButtons[0], /aria-haspopup="dialog"/)
            assert.doesNotMatch(updateButtons[0], /\sdisabled(?:=|\s|>)/)
          }
        }
      }
    })
  }
}

test('workspace routes only fresh uploads to update dialog and preserves the existing submission flow', () => {
  const app = readFileSync(new URL('../components/workspace-app.tsx', import.meta.url), 'utf8')
  assert.match(app, /onUpdateReport={detail\.project\.canSubmit \? openSubmit : undefined}/)
  assert.match(app, /submitOpen && detail && submitPhase\.step === 'idle' && !completionReplacement \? \(/)
  assert.match(app, /<WorkspaceUpdateReportDialog\s+key={detail\.project\.id}\s+detail={detail}\s+onSubmit={handleReportUpload}\s+onClose={closeSubmit}/)
  assert.match(app, /\) : submitOpen && detail \? \(\s*<WorkspaceSubmitDialog/)
  assert.match(app, /replacementReport={completionReplacement\?\.report}/)
  assert.match(app, /phase={submitPhase}/)
  assert.match(app, /onPrepare={\(\) => void handlePrepare\(\)}/)
  assert.match(app, /onCommit={\(\) => void handleCommit\(\)}/)
  assert.match(app, /<ProjectFirstReportOnboarding\b[^>]*onSubmit={handleReportUpload}/)
  assert.match(app, /onResumeSubmit={hasResumableSubmit\(submitPhase\) \? openSubmit : undefined}/)
  const uploadHandler = app.slice(app.indexOf('function handleReportUpload('), app.indexOf('async function handlePrepare('))
  assert.match(uploadHandler, /if \(preparingProjectIdRef\.current \|\| hasResumableSubmit\(submitPhaseRef\.current\)\) {[\s\S]*?openSubmit\(\)\s+return/)
  assert.match(uploadHandler, /!canSubmitDraft\(detail, draft\)/)
  assert.match(uploadHandler, /setCompletionReplacement\(undefined\)/)
  assert.match(uploadHandler, /beginSubmitConfirm\(\{ \.\.\.draft, impact: previewSubmissionImpact/)
  assert.match(uploadHandler, /updateSubmitPhase\(phase\)\s+setSubmitOpen\(true\)\s+void handlePrepare\(\)/)
  const openSubmit = app.slice(app.indexOf('function openSubmit()'), app.indexOf('function handleReplaceReport('))
  assert.match(openSubmit, /originProjectIdFromSubmit\(submitPhaseRef\.current\) \?\? preparingProjectIdRef\.current/)
  assert.match(openSubmit, /loadProject\(origin\)/)
  assert.doesNotMatch(openSubmit, /idleSubmitPhase|updateSubmitPhase|setCompletionReplacement/)
})

test('report board uses container width not viewport xl for inner columns', () => {
  const source = readFileSync(new URL('../components/dashboard-view.tsx', import.meta.url), 'utf8')
  assert.match(source, /@container\/report-board/)
  assert.match(source, /overflow-y-auto/)
  assert.match(source, /flex-none/)
  assert.match(source, /@\[1000px\]\/report-board:flex-1/)
  assert.match(source, /@\[1000px\]\/report-board:grid-cols-\[minmax\(0,1fr\)_350px\]/)
  assert.match(source, /@\[640px\]\/report-board:grid-cols-\[repeat\(2,minmax\(280px,1fr\)\)\]/)
  assert.doesNotMatch(source, /yx-dashboard-grid/)
  assert.doesNotMatch(source, /xl:grid-cols/)
  assert.doesNotMatch(source, /xl:w-\[350px\]/)
  assert.doesNotMatch(source, /grid min-h-0 min-w-0 flex-1 grid-cols-1/)
})

test('report board does not add dynamic notices above analysis content', () => {
  const source = readFileSync(new URL('../components/dashboard-view.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /dispatchError|insightTask|crossStageNote|comparisonDisclaimer|洞察任务进行中/)
})

test('report board hides transient overflow during its entrance animation', () => {
  const source = readFileSync(new URL('../components/dashboard-view.tsx', import.meta.url), 'utf8')
  assert.match(source, /entering \? 'overflow-y-hidden' : 'overflow-y-auto'/)
})

test('submission success closes the dialog before refreshes start and refresh failures stay non-fatal', () => {
  const app = readFileSync(new URL('../components/workspace-app.tsx', import.meta.url), 'utf8')
  const finish = app.slice(app.indexOf('function finishSubmission('), app.indexOf('try {', app.indexOf('function finishSubmission(')))
  assert.match(finish, /setSubmitOpen\(false\)\s+updateSubmitPhase\(idleSubmitPhase\(\)\)\s+setCompletionReplacement\(undefined\)\s+setSubmitError\(''\)\s+showNotice\(completionReplacement/)
  assert.doesNotMatch(finish, /\bawait\b/)
  assert.match(finish, /navGeneration\.current === generationAtCommit/)
  assert.match(finish, /void loadProject\(originProjectId, \{ stageId, reportId \}, refreshErrorNotice\)\s+\.catch\(\(\) => showNotice\(refreshErrorNotice\)\)/)
  assert.match(finish, /refreshed === false\) showNotice\(refreshErrorNotice\)/)
  const afterRefreshStart = finish.slice(finish.indexOf('void loadProject('))
  assert.doesNotMatch(afterRefreshStart, /setSubmitOpen|updateSubmitPhase|setCompletionReplacement|setSubmitError|showNotice\(completionReplacement|refresh_failed/)
  assert.match(app, /commit_acknowledged[\s\S]{0,120}finishSubmission\(result\.receipt\.reportId, result\.receipt\.stageId\)/)
  assert.match(app, /报告已提交成功，但部分工作区数据刷新失败/)
  const alreadyCommitted = app.slice(app.indexOf("if (classified === 'already_committed'"), app.indexOf('const error = describeCommitNetworkError'))
  assert.match(alreadyCommitted, /if \(committedReportId\) \{\s*finishSubmission\(committedReportId, submitting\.stageId\)\s*return/)
  const stats = app.slice(app.indexOf('const refreshStats = useCallback('), app.indexOf('const refreshLibrary = useCallback('))
  const library = app.slice(app.indexOf('const refreshLibrary = useCallback('), app.indexOf('const applyFetchedReport = useCallback('))
  assert.match(stats, /setLoadError\(''\)\s+return true/)
  assert.match(stats, /return false/)
  assert.match(library, /setLibraryError\(''\)\s+return true/)
  assert.match(library, /return false/)
  const loadProjectStart = app.indexOf('const loadProject = useCallback(')
  const loadProject = app.slice(loadProjectStart, app.indexOf('useEffect(', loadProjectStart))
  assert.match(loadProject, /showNotice\(reportErrorNotice \?\? \(cause instanceof Error/)
  assert.doesNotMatch(app, /工作区尚未刷新/)
})

function pendingSubmission() {
  const file = new File(['report'], 'report.docx')
  const phase = reduceWorkspaceSubmit({
    step: 'preparing', file, stageId: 's1', reportKind: 'completion',
    impact: { autoCompletedStages: [], projectWillComplete: false, targetAlreadyCompleted: false },
  }, { type: 'prepare_succeeded', upload: { id: 'upload_1', projectId: 'project-1', status: 'ready', fileName: file.name, createdAt: '2026-03-02T00:00:00Z', expiresAt: '2026-03-02T01:00:00Z' } })
  assert.ok(phase.step === 'prepared')
  if (phase.step !== 'prepared') throw new Error('expected prepared')
  const command = buildSubmissionCommand({ uploadId: phase.upload.id, stageId: 's1', reportKind: 'completion', tokens: { planRevision: 0, workflowRevision: 0, completionRevision: 0, completionReportId: null } })
  const submitting = reduceWorkspaceSubmit(phase, { type: 'commit_started', command, idempotencyKey: 'original_key_12345678' })
  assert.equal(submitting.step, 'submitting')
  if (submitting.step !== 'submitting') throw new Error('expected submitting')
  return submitting
}

for (const code of ['UPLOAD_EXPIRED', 'UPLOAD_NOT_READY', 'REPORT_FILE_CHANGED', 'INVALID_SUBMISSION']) {
  test(code + ' rejects the first commit but cannot discard a previously unknown commit', () => {
    const submitting = pendingSubmission()
    assert.equal(classifyCommitFailure({ status: 409, code }), 'rejected')
    const rejected = reduceWorkspaceSubmit(submitting, { type: 'commit_rejected', error: code, code })
    assert.equal(rejected.step, 'failed')
    assert.equal('upload' in rejected || 'command' in rejected || 'idempotencyKey' in rejected, false)
    assert.equal(dismissWorkspaceSubmit(rejected).step, 'idle')
    assert.equal(reduceWorkspaceSubmit(rejected, { type: 'select_file', file: submitting.file }).step, 'configure')
    const uncertain = reduceWorkspaceSubmit(submitting, { type: 'commit_uncertain', error: 'lost response' })
    const retry = reduceWorkspaceSubmit(uncertain, { type: 'commit_started', command: submitting.command, idempotencyKey: 'must_not_replace_key' })
    assert.equal(classifyCommitFailure({ status: 409, code, previouslyUncertain: true }), 'uncertain')
    assert.equal(reduceWorkspaceSubmit(retry, { type: 'commit_rejected', error: code, code }), retry)
    assert.equal(reduceWorkspaceSubmit(retry, { type: 'reset' }), retry)
    assert.equal(retry.step === 'submitting' && retry.idempotencyKey, submitting.idempotencyKey)
  })
}

test('unknown authentication failures, conflicts, ambiguous upload errors and server errors retain the key', () => {
  for (const status of [401, 403, 404]) {
    assert.equal(classifyCommitFailure({ status }), 'rejected')
    assert.equal(classifyCommitFailure({ status, previouslyUncertain: true }), 'uncertain')
  }
  for (const code of ['UPLOAD_ABORTED', 'IDEMPOTENCY_KEY_REUSED']) assert.equal(classifyCommitFailure({ status: 409, code }), 'reconcile')
  assert.equal(classifyCommitFailure({ status: 503, code: 'UPLOAD_EXPIRED' }), 'uncertain')
  assert.equal(classifyCommitFailure({ status: 409, code: 'PROJECT_PLAN_CHANGED', previouslyUncertain: true }), 'conflict')
  const submitting = pendingSubmission()
  assert.equal(reduceWorkspaceSubmit(submitting, { type: 'commit_started', command: submitting.command, idempotencyKey: 'double_click_new_key' }), submitting)
})

for (const code of ['STAGE_COMPLETION_CHANGED', 'PROJECT_WORKFLOW_CHANGED', 'PROJECT_PLAN_CHANGED']) {
  test(code + ' resolves a lost response into a refreshable conflict', () => {
    const submitting = pendingSubmission()
    const uncertain = reduceWorkspaceSubmit(submitting, { type: 'commit_uncertain', error: 'lost response' })
    const retry = reduceWorkspaceSubmit(uncertain, { type: 'commit_started', command: submitting.command, idempotencyKey: 'ignored_key' })
    assert.equal(classifyCommitFailure({ status: 409, code, previouslyUncertain: true }), 'conflict')
    const conflict = reduceWorkspaceSubmit(retry, { type: 'commit_conflict', conflict: { code, error: code }, tokensReady: false })
    assert.equal(conflict.step, 'conflict')
    assert.equal(submitCommitEnabled(conflict), false)
    assert.equal(dismissWorkspaceSubmit(conflict).step, 'idle')
    const refreshed = reduceWorkspaceSubmit(conflict, { type: 'conflict_refreshed', tokens: { planRevision: 2, workflowRevision: 3, completionRevision: 4, completionReportId: null } })
    assert.equal(submitCommitEnabled(refreshed), true)
    const next = reduceWorkspaceSubmit(refreshed, { type: 'commit_started', command: 'command' in refreshed ? refreshed.command : submitting.command, idempotencyKey: 'fresh_key_12345678' })
    assert.equal(next.step === 'submitting' && next.idempotencyKey, 'fresh_key_12345678')
  })
}

test('upload reconciliation resolves terminal failures and key collisions without dropping ambiguous identities', () => {
  const original = pendingSubmission()
  const submitting = { ...original, previouslyUncertain: true }
  for (const code of ['UPLOAD_ABORTED', 'UPLOAD_EXPIRED', 'UPLOAD_NOT_READY', 'IDEMPOTENCY_KEY_REUSED']) {
    for (const status of ['failed', 'reclaiming', 'reclaimed'] as const) {
      const checked = reduceWorkspaceSubmit(submitting, { type: 'upload_checked', upload: { ...original.upload, status }, code, error: '上传已取消' })
      assert.equal(checked.step, 'failed')
      assert.equal(dismissWorkspaceSubmit(checked).step, 'idle')
      assert.equal(reduceWorkspaceSubmit(checked, { type: 'select_file', file: original.file }).step, 'configure')
    }
  }
  const collision = reduceWorkspaceSubmit(submitting, { type: 'upload_checked', upload: original.upload, code: 'IDEMPOTENCY_KEY_REUSED', error: '请刷新后重新确认' })
  assert.equal(collision.step, 'conflict')
  assert.equal(submitCommitEnabled(collision), false)
  for (const upload of [original.upload, { ...original.upload, status: 'committed' as const }, { ...original.upload, status: 'failed' as const, reportId: 'existing' }, { ...original.upload, id: 'other', status: 'failed' as const }]) {
    assert.equal(reduceWorkspaceSubmit(submitting, { type: 'upload_checked', upload, code: 'UPLOAD_ABORTED', error: '核对未完成' }), submitting)
  }
  assert.equal(reduceWorkspaceSubmit(submitting, { type: 'commit_conflict', conflict: { code: 'UNKNOWN_CONFLICT', error: 'unknown' }, tokensReady: false }), submitting)
  assert.equal(classifyCommitFailure({ status: 409, code: 'UNKNOWN_CONFLICT', previouslyUncertain: true }), 'uncertain')
  const app = readFileSync(new URL('../components/workspace-app.tsx', import.meta.url), 'utf8')
  assert.match(app, /classified === 'reconcile'/)
  assert.ok(app.includes("classified === 'uncertain' && payload.status && payload.status < 500"))
  assert.ok(app.includes('readWorkspaceUpload(originProjectId, submitting.upload.id)'))
  assert.match(app, /分析任务状态已同步/)
  assert.match(app, /洞察任务状态已同步/)
  assert.doesNotMatch(app, /已进入队列/)
})

function stateTask(overrides: Partial<SubmissionTask> = {}): SubmissionTask {
  return { id: 'analysis-1', reportId: 'r1', projectId: 'project-1', actorId: 'owner', operation: 'analysis', generation: 1, status: 'running', stage: 'validating', stageIndex: 0, attempts: 1, cancelRequested: false, createdAt: '2026-03-02T00:00:00Z', updatedAt: '2026-03-02T00:00:00Z', ...overrides }
}

test('whole stale detail cannot regress generation, terminal, cancellation, capabilities or previous success', () => {
  const report = card({ id: 'r1', stageId: 's1', stageVersion: 1 })
  let state = selectWorkspaceReport(emptyWorkspaceReportView(), { selection: { stageId: 's1', reportId: 'r1', source: 'explicit' }, report })
  const success = { ...EMPTY_SNAPSHOT, visualization: { ...EMPTY_SNAPSHOT.visualization, mindMap: { id: 'root', label: 'Previous success', children: [{ id: 'result', label: 'Retained result', children: [] }] } } }
  state = applyWorkspaceReportDetail(state, { report, snapshot: success })
  const task = stateTask({ generation: 2, cancelRequested: true })
  state = applyWorkspaceAnalysisTask(state, task)
  for (const stale of [stateTask(), { ...task, id: 'other' }, { ...task, cancelRequested: false }, undefined]) {
    assert.equal(applyWorkspaceReportDetail(state, { report: { ...report, capabilities: EMPTY_WORKSPACE_CAPABILITIES }, analysisTask: stale }), state)
  }
  const terminal = applyWorkspaceAnalysisTask(state, { ...task, status: 'completed' })
  assert.equal(applyWorkspaceAnalysisTask(terminal, task), terminal)
  assert.equal(applyWorkspaceReportDetail(terminal, { report, analysisTask: task }), terminal)
  const nextTask = stateTask({ id: 'analysis-3', generation: 3, status: 'queued' })
  const next = applyWorkspaceAnalysisTask(terminal, nextTask)
  assert.equal(next.analysisTask, nextTask)
  assert.equal(next.snapshot, success)
  assert.equal(applyWorkspaceReportDetail(next, { report, analysisTask: { ...nextTask, status: 'failed' }, snapshot: EMPTY_SNAPSHOT }).snapshot, success)
  const recovered = applyWorkspaceAnalysisTask(next, { ...nextTask, status: 'running' })
  assert.equal(applyWorkspaceAnalysisTask(recovered, nextTask).analysisTask?.status, 'queued')
  const insight = stateTask({ id: 'insight-1', operation: 'insight', generation: 1 })
  assert.equal(applyWorkspaceInsightTask(next, insight).analysisTask, nextTask)
})

test('report reader coalesces SSE and poll, fences mutations, and reads pending notifications once', async () => {
  const requests: Array<ReturnType<typeof Promise.withResolvers<number>>> = []
  const applied: number[] = []
  const reader = createWorkspaceReportReader({
    fetch: async () => { const request = Promise.withResolvers<number>(); requests.push(request); return request.promise },
    apply: (_identity, value) => { applied.push(value) }, error: () => assert.fail('unexpected error'),
  })
  const identity = { reportId: 'r1', generation: 1 }
  const first = reader.read(identity)
  assert.equal(reader.read(identity), first)
  assert.equal(reader.read(identity), first)
  assert.equal(requests.length, 1)
  reader.invalidate('r1')
  requests[0].resolve(1)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(requests.length, 2)
  assert.deepEqual(applied, [])
  requests[1].resolve(2)
  await first
  assert.deepEqual(applied, [2])
  reader.dispose()
})

test('out-of-order report reads and aborted navigation cannot overwrite the current selection', async () => {
  const requests = new Map<string, ReturnType<typeof Promise.withResolvers<number>>>()
  const applied: number[] = []
  let selected = 'r1'
  const reader = createWorkspaceReportReader({
    fetch: async (id) => { const request = Promise.withResolvers<number>(); requests.set(id, request); return request.promise },
    apply: (identity, value) => { if (identity.reportId === selected) applied.push(value) }, error: () => assert.fail('unexpected error'),
  })
  const first = reader.read({ reportId: 'r1', generation: 1 })
  selected = 'r2'
  const second = reader.read({ reportId: 'r2', generation: 2 })
  requests.get('r2')!.resolve(2)
  await second
  requests.get('r1')!.resolve(1)
  await first
  assert.deepEqual(applied, [2])
  const abandoned = reader.read({ reportId: 'r2', generation: 2 })
  reader.dispose()
  requests.get('r2')!.resolve(3)
  await abandoned
  assert.deepEqual(applied, [2])
})

test('rejected authoritative detail gets one bounded reread, not an infinite retry loop', async () => {
  let requests = 0
  const reader = createWorkspaceReportReader({ fetch: async () => ++requests, apply: () => false, error: () => assert.fail('unexpected error') })
  await reader.read({ reportId: 'r1', generation: 1 })
  assert.equal(requests, 2)
  reader.dispose()
})

test('deleting selected report clears URL selection only for that report and refresh failures remain independent', async () => {
  const state = selectWorkspaceReport(emptyWorkspaceReportView(), { selection: { stageId: 's1', reportId: 'r1', source: 'explicit' }, report: card({ id: 'r1', stageId: 's1', stageVersion: 1 }) })
  assert.equal(removeWorkspaceReport(state, 'other'), state)
  const removed = removeWorkspaceReport(state, 'r1')
  assert.equal(removed.selectedReport, undefined)
  assert.equal(removed.selection.reportId, undefined)
  assert.equal(buildWorkspaceSearch({ view: 'dashboard', projectId: 'project-1', ...removed.selection }).includes('report='), false)
  const called: string[] = []
  const refreshed = await refreshWorkspaceProjections([
    async () => { called.push('detail'); throw new Error('detail unavailable') },
    async () => { called.push('stats'); return false },
    async () => { called.push('library'); return true },
  ])
  assert.equal(refreshed, false)
  assert.deepEqual(called, ['detail', 'stats', 'library'])
  assert.equal(await refreshWorkspaceProjections([async () => false]), false)
  assert.equal(await refreshWorkspaceProjections([async () => true]), true)
})
