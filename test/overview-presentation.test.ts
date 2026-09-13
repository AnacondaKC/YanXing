import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import {
  averageDefinedInteger,
  averageDefinedTenth,
  compareReportsBySequence,
  dynamicOverviewSubtitle,
  groupReportsByProject,
  isActiveProject,
  isDefinedScore,
  isQualityRiskProject,
  isReportAnalyzing,
  latestProjectActivity,
  projectLatestLabel,
  qualityBandOf,
  reportCompactLabel,
  reportMatchesLibraryQuery,
  reportStageLabel,
  submissionTrendOf,
  submittedReportCountOf,
} from '../lib/overview-presentation'
import { type WorkspaceOverviewStats, type WorkspaceProjectListItem, type WorkspaceReportCard } from '../lib/workspace-submission'

function card(overrides: Partial<WorkspaceReportCard> = {}): WorkspaceReportCard {
  return {
    id: 'report-1',
    projectId: 'project-1',
    stageId: 'stage-1',
    stageVersion: 1,
    submissionSequence: 1,
    submittedAs: 'update',
    isCurrentCompletion: false,
    isLatestSubmission: true,
    wasFirstStageSubmission: true,
    title: '研究报告',
    fileName: 'report.docx',
    sourceSize: 1024,
    paragraphCount: 12,
    characterCount: 4000,
    submittedBy: 'owner',
    submittedAt: '2026-03-02T00:00:00.000Z',
    labels: {
      stageLabel: '阶段01 · 开题研究',
      reportLabel: '开题研究 V1',
      compactLabel: '阶段01 V1',
      roleLabel: '阶段更新报告',
    },
    capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, analysisAction: 'start', insightAction: 'none', disabledReasons: [] },
    comparison: { status: 'unavailable', reason: 'first_stage_submission' },
    ...overrides,
  }
}

function project(overrides: Partial<WorkspaceProjectListItem> = {}): WorkspaceProjectListItem {
  return {
    id: 'project-1',
    title: '产业政策课题',
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
    submittedReportCount: 1,
    completedStageCount: 0,
    currentStage: { id: 'stage-1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress' },
    ...overrides,
  }
}

const emptyStats: WorkspaceOverviewStats = {
  submittedReportCount: 0,
  completedStageCount: 0,
  totalCharacters: 0,
  knowledgeCount: 0,
  knowledgeCategoryCount: 0,
  weeklyNewReports: 0,
  weeklyNewKnowledge: 0,
  jobStats: { completed: 0, failed: 0, cancelled: 0, running: 0, queued: 0 },
  trends: { submissions: [], characters: [], successRate: [], knowledge: [], averageScore: [], analyzedProjects: [] },
}

test('quality bands treat missing scores as unanalyzed and zero as weak', () => {
  assert.equal(qualityBandOf(undefined), 'unanalyzed')
  assert.equal(qualityBandOf(0), 'weak')
  assert.equal(qualityBandOf(59), 'weak')
  assert.equal(qualityBandOf(60), 'good')
  assert.equal(qualityBandOf(79), 'good')
  assert.equal(qualityBandOf(80), 'excellent')
  assert.equal(isDefinedScore(0), true)
  assert.equal(isDefinedScore(undefined), false)
})

test('averages skip missing scores and keep zero as a valid sample', () => {
  assert.equal(averageDefinedInteger([undefined, undefined]), undefined)
  assert.equal(averageDefinedInteger([0, undefined, 100]), 50)
  assert.equal(averageDefinedInteger([0]), 0)
  assert.equal(averageDefinedTenth([0, undefined, 1]), 0.5)
})

test('native stats ignore legacy version totals and use submissions', () => {
  const stats: WorkspaceOverviewStats = {
    ...emptyStats,
    submittedReportCount: 4,
    trends: { ...emptyStats.trends, submissions: [4, 5] },
  }
  assert.equal(submittedReportCountOf(stats), 4)
  assert.deepEqual(submissionTrendOf(stats), [4, 5])
  assert.equal(submittedReportCountOf(undefined, 0), 0)
  assert.deepEqual(submissionTrendOf(undefined), [])
})

test('display labels stay stage-qualified instead of fabricated global V', () => {
  const report = card({
    stageVersion: 2,
    submissionSequence: 9,
    labels: {
      stageLabel: '阶段02 · 事实调研',
      reportLabel: '事实调研 V2',
      compactLabel: '阶段02 V2',
      roleLabel: '阶段更新报告',
    },
  })
  assert.equal(reportStageLabel(report), '阶段02 · 事实调研')
  assert.equal(reportCompactLabel(report), '阶段02 V2')
  assert.equal(projectLatestLabel(project({ latestSubmission: report })), '阶段02 V2')
  assert.equal(projectLatestLabel(project()), undefined)
})

test('report groups order by submissionSequence rather than stage version', () => {
  const older = card({ id: 'older', stageVersion: 9, submissionSequence: 1, submittedAt: '2026-03-01T00:00:00.000Z' })
  const newer = card({ id: 'newer', stageVersion: 1, submissionSequence: 4, submittedAt: '2026-03-03T00:00:00.000Z' })
  assert.ok(compareReportsBySequence(newer, older) < 0)
  const grouped = groupReportsByProject({
    reports: [older, newer],
    projects: [project()],
  })
  assert.equal(grouped.length, 1)
  assert.deepEqual(grouped[0].reports.map((item) => item.id), ['newer', 'older'])
})

test('active and quality-risk projects use native stage and score fields', () => {
  assert.equal(isActiveProject(project()), true)
  assert.equal(isActiveProject(project({ currentStage: { id: 'stage-3', ordinal: 3, title: '成果形成', lifecycleStatus: 'completed' } })), false)
  assert.equal(isQualityRiskProject(project({ latestSubmission: card({ aiScore: 0 }) })), true)
  assert.equal(isQualityRiskProject(project({ latestSubmission: card({ aiScore: undefined }) })), false)
  assert.equal(isQualityRiskProject(project({ latestSubmission: card({ aiScore: 80 }) })), false)
})

test('library search keeps original title/file/project matching', () => {
  const report = card({ title: '政策评估', fileName: 'policy.pdf', projectTitle: '产业政策课题' })
  assert.equal(reportMatchesLibraryQuery({ report, search: '政策', projectFilter: 'all', projectTitle: '产业政策课题' }), true)
  assert.equal(reportMatchesLibraryQuery({ report, search: '阶段01', projectFilter: 'all', projectTitle: '产业政策课题' }), false)
  assert.equal(reportMatchesLibraryQuery({ report, search: '', projectFilter: 'project-2', projectTitle: '产业政策课题' }), false)
})

test('activity prefers in-flight analysis and retry without fabricating job status', () => {
  const analyzing = card({
    capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, canCancelAnalysisJob: true, analysisAction: 'view', insightAction: 'none', disabledReasons: ['REPORT_PROCESSING'] },
  })
  assert.equal(isReportAnalyzing(analyzing), true)
  assert.equal(latestProjectActivity(project(), [analyzing]).kind, 'analyzing')
  assert.equal(latestProjectActivity(project(), [analyzing]).detail, '阶段01 V1')

  const failed = card({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, analysisAction: 'retry', insightAction: 'none', disabledReasons: [] } })
  assert.equal(latestProjectActivity(project(), [failed]).kind, 'failed')

  const scored = card({ aiScore: 0, capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, analysisAction: 'rerun', insightAction: 'start', disabledReasons: [] } })
  const analyzed = latestProjectActivity(project({ latestSubmission: scored }), [scored])
  assert.equal(analyzed.kind, 'analyzed')
  assert.equal(analyzed.detail, '0 分')
})

test('overview subtitle keeps original copy and treats zero as a real average', () => {
  assert.match(dynamicOverviewSubtitle({
    runningJobs: 0, queuedJobs: 0, atRiskCount: 0, activeProjectsCount: 2,
    submittedReportCount: 5, weeklyNewReports: 1, averageAiScore: 0,
    hasProjects: true, hasReports: true,
  }), /平均 AI 分析得分为 0 分/)
  assert.match(dynamicOverviewSubtitle({
    runningJobs: 0, queuedJobs: 0, atRiskCount: 0, activeProjectsCount: 2,
    submittedReportCount: 5, weeklyNewReports: 1,
    hasProjects: true, hasReports: true,
  }), /平均 AI 分析得分为 --/)
  assert.match(dynamicOverviewSubtitle({
    runningJobs: 0, queuedJobs: 0, atRiskCount: 0, activeProjectsCount: 3,
    submittedReportCount: 8, weeklyNewReports: 0, averageAiScore: 70,
    hasProjects: true, hasReports: true,
  }), /全库纳管 3 个在研课题与 8 版研报/)
})
