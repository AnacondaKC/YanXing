import type { AnalysisSnapshotPayload, AnalysisStage } from '@/modules/contracts/analysis'
import type { ReportInsightOutput } from '@/modules/insights/domain'
import type { ProjectMemberRole } from '@/modules/projects/domain'
import type { ProjectStageRecord, ProjectWorkflow } from '@/modules/projects/stage-domain'
import { canEditProjectConfiguration } from '@/modules/projects/configuration-policy'
import { canWriteProjectReports } from '@/modules/reports/submission-policy'
import type { UserRole, UserStatus } from '@/modules/users/domain'
import type {
  ReportMutationDecision,
  ReportOperationDecision,
  ReportSubmission,
  ReportWriteContext,
} from '@/modules/reports/submission-domain'
import {
  getSubmissionDisplayLabels,
  type SubmissionComparison,
} from '@/modules/reports/submission-query'
import type { SubmissionTask, SubmissionTaskResult } from '@/modules/reports/submission-task-domain'
import type {
  WorkspaceCapabilities,
  WorkspaceCurrentStage,
  WorkspaceJobAction,
  WorkspaceOutboxDispatch,
  WorkspaceProjectDetail,
  WorkspaceProjectListItem,
  WorkspaceReportCard,
  WorkspaceReportDetail,
  WorkspaceReportLabels,
  WorkspaceSelection,
  WorkspaceSelectionSource,
  WorkspaceStageGroup,
  WorkspaceTaskProgress,
  WorkspaceWorkflow,
} from '@/modules/contracts/submission-workspace'

const STAGE_PAD = 2
const COMPLETION_PROTECTED = 'COMPLETION_REPORT_PROTECTED'
const REPORT_PROCESSING = 'REPORT_PROCESSING'
const WRITE_FORBIDDEN = 'REPORT_WRITE_FORBIDDEN'

export interface WorkspaceActorView {
  id: string
  role: UserRole
  status: UserStatus
  displayName: string
}

export interface WorkspaceProjectRecord {
  id: string
  title: string
  objective: string
  description: string
  ownerId: string
  ownerName: string
  collaboratorNames?: string
  memberRole?: ProjectMemberRole
  createdAt: string
  updatedAt: string
}

export interface WorkspaceReportProjectionInput {
  report: ReportSubmission
  stage: ProjectStageRecord
  latestSubmissionId?: string
  canWrite: boolean
  canEditConfiguration?: boolean
  analysisDecision: ReportOperationDecision
  insightDecision: ReportOperationDecision
  deletionDecision: ReportMutationDecision
  analysisTask?: SubmissionTask
  insightTask?: SubmissionTask
  scores?: { aiScore?: number; completeness?: number }
  analysisResult?: SubmissionTaskResult
  insightResult?: SubmissionTaskResult
  comparison: SubmissionComparison
  projectTitle?: string
}

export interface NativeReportQuery {
  report: ReportSubmission
  labels: WorkspaceReportLabels
  isLatest: boolean
  capabilities: {
    analysis: ReportOperationDecision
    insight: ReportOperationDecision
    deletion: ReportMutationDecision
  }
  tasks: { analysis?: SubmissionTask; insight?: SubmissionTask }
  results: { analysis?: SubmissionTaskResult; insight?: SubmissionTaskResult }
  history: { analysis: SubmissionTaskResult[]; insight: SubmissionTaskResult[] }
  comparison: SubmissionComparison
  dispatch?: WorkspaceOutboxDispatch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function overallScore(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.overall !== 'number' || !Number.isFinite(value.overall)) return undefined
  if (value.overall < 0 || value.overall > 100) return undefined
  return value.overall
}

/** Successful published analysis only. Partial/pre-gate payloads are ignored. */
export function successfulAnalysisSnapshot(payload: unknown): AnalysisSnapshotPayload | undefined {
  if (!isRecord(payload) || payload.kind !== 'analysis' || !isRecord(payload.snapshot)) return undefined
  const data = payload.snapshot.payload
  if (!isRecord(data)) return undefined
  if (overallScore(data.aiScore) === undefined && overallScore(data.reportCompleteness) === undefined) return undefined
  return data as unknown as AnalysisSnapshotPayload
}

export function successfulInsightOutput(payload: unknown): ReportInsightOutput | undefined {
  if (!isRecord(payload) || payload.kind !== 'insight' || !isRecord(payload.insight)) return undefined
  const insight = payload.insight
  if (typeof insight.title !== 'string' || typeof insight.html !== 'string' || typeof insight.summary !== 'string') return undefined
  if (!Array.isArray(insight.sections) || typeof insight.readingMinutes !== 'number') return undefined
  return insight as unknown as ReportInsightOutput
}

export function scoresFromSuccessfulAnalysis(payload: unknown): { aiScore?: number; completeness?: number } {
  const snapshot = successfulAnalysisSnapshot(payload)
  if (!snapshot) return {}
  return { aiScore: overallScore(snapshot.aiScore), completeness: overallScore(snapshot.reportCompleteness) }
}

export function stagePositionLabel(ordinal: number) {
  return '阶段' + String(ordinal).padStart(STAGE_PAD, '0')
}

export function stageGroupLabel(stage: Pick<ProjectStageRecord, 'ordinal' | 'title'>) {
  const position = stagePositionLabel(stage.ordinal)
  const title = stage.title.trim()
  return !title || title === position ? position : position + ' · ' + title
}

export function workspaceJobAction(decision: ReportOperationDecision): { action: WorkspaceJobAction; jobId?: string; reason?: string } {
  if (decision.kind === 'enqueue') return { action: decision.action }
  if (decision.kind === 'reuse') return { action: 'view', jobId: decision.jobId }
  return { action: 'none', reason: decision.code }
}

function liveTask(task: SubmissionTask | undefined) {
  return task && (task.status === 'queued' || task.status === 'running') ? task : undefined
}

function taskProgress(task: SubmissionTask | undefined): WorkspaceTaskProgress | undefined {
  if (!task) return undefined
  return { stage: task.stage as AnalysisStage, stageIndex: task.stageIndex, status: task.status, cancelRequested: task.cancelRequested }
}

export function workspaceCapabilities(input: {
  canWrite: boolean
  canEditConfiguration?: boolean
  stage: Pick<ProjectStageRecord, 'lifecycleStatus' | 'currentCompletionReportId'>
  reportId: string
  analysisDecision: ReportOperationDecision
  insightDecision: ReportOperationDecision
  deletionDecision: ReportMutationDecision
  analysisTask?: SubmissionTask
  insightTask?: SubmissionTask
}): WorkspaceCapabilities {
  const analysis = workspaceJobAction(input.analysisDecision)
  const insight = workspaceJobAction(input.insightDecision)
  const reasons: string[] = []
  if (!input.canWrite) reasons.push(WRITE_FORBIDDEN)
  if (input.stage.currentCompletionReportId === input.reportId) reasons.push(COMPLETION_PROTECTED)
  if (liveTask(input.analysisTask) || liveTask(input.insightTask)) reasons.push(REPORT_PROCESSING)
  if (input.deletionDecision.kind === 'denied' && !reasons.includes(input.deletionDecision.code)) {
    reasons.push(input.deletionDecision.code)
  }
  if (analysis.reason && !reasons.includes(analysis.reason)) reasons.push(analysis.reason)
  if (insight.reason && !reasons.includes(insight.reason)) reasons.push(insight.reason)
  const capabilities: WorkspaceCapabilities = {
    canSubmitUpdate: input.canWrite && input.stage.lifecycleStatus !== 'completed',
    canSubmitCompletion: input.canWrite,
    canDelete: input.deletionDecision.kind === 'allowed',
    canCancelAnalysisJob: Boolean(input.canWrite && liveTask(input.analysisTask)),
    canCancelInsightJob: Boolean(input.canWrite && liveTask(input.insightTask)),
    canEditPlan: input.canEditConfiguration ?? input.canWrite,
    analysisAction: analysis.action,
    insightAction: insight.action,
    disabledReasons: reasons,
  }
  if (analysis.jobId) capabilities.analysisJobId = analysis.jobId
  if (insight.jobId) capabilities.insightJobId = insight.jobId
  if (reasons[0]) capabilities.disabledReason = reasons[0]
  return capabilities
}

export function reportCard(input: WorkspaceReportProjectionInput): WorkspaceReportCard {
  const scores = input.scores ?? scoresFromSuccessfulAnalysis(input.analysisResult?.payload)
  const labels = getSubmissionDisplayLabels({ stage: input.stage, report: input.report })
  const card: WorkspaceReportCard = {
    id: input.report.id,
    projectId: input.report.projectId,
    stageId: input.report.stageId,
    stageVersion: input.report.stageVersion,
    submissionSequence: input.report.submissionSequence,
    title: input.report.title,
    fileName: input.report.fileName,
    sourceSize: input.report.sourceSize,
    paragraphCount: input.report.paragraphCount,
    characterCount: input.report.characterCount,
    submittedAs: input.report.submittedAs,
    submittedAt: input.report.submittedAt,
    submittedBy: input.report.submittedBy,
    wasFirstStageSubmission: input.report.wasFirstStageSubmission,
    isCurrentCompletion: input.stage.currentCompletionReportId === input.report.id,
    isLatestSubmission: input.latestSubmissionId === input.report.id,
    labels,
    capabilities: workspaceCapabilities({
      canWrite: input.canWrite,
      canEditConfiguration: input.canEditConfiguration,
      stage: input.stage,
      reportId: input.report.id,
      analysisDecision: input.analysisDecision,
      insightDecision: input.insightDecision,
      deletionDecision: input.deletionDecision,
      analysisTask: input.analysisTask,
      insightTask: input.insightTask,
    }),
    comparison: input.comparison,
  }
  if (input.projectTitle) card.projectTitle = input.projectTitle
  if (scores.aiScore !== undefined) card.aiScore = scores.aiScore
  if (scores.completeness !== undefined) card.completeness = scores.completeness
  return card
}

export function reportDetail(input: WorkspaceReportProjectionInput & {
  history: { analysis: SubmissionTaskResult[]; insight: SubmissionTaskResult[] }
  dispatch?: WorkspaceOutboxDispatch
}): WorkspaceReportDetail {
  const card = reportCard(input)
  const snapshot = successfulAnalysisSnapshot(input.analysisResult?.payload)
  const insight = successfulInsightOutput(input.insightResult?.payload)
  const detail: WorkspaceReportDetail = {
    ...card,
    analysisTask: input.analysisTask,
    insightTask: input.insightTask,
    job: input.analysisTask,
    progress: {
      analysis: taskProgress(input.analysisTask),
      insight: taskProgress(input.insightTask),
    },
    history: input.history,
  }
  if (snapshot) detail.snapshot = snapshot
  if (insight) detail.insight = insight
  if (input.dispatch) {
    detail.dispatch = input.dispatch
    if (input.dispatch.status === 'pending' || input.dispatch.status === 'leased') detail.outboxPending = true
    if (input.dispatch.errorCode) {
      detail.dispatchError = { operation: 'analysis', code: input.dispatch.errorCode, message: input.dispatch.errorCode }
    }
  }
  return detail
}

export function reportDetailFromNative(input: NativeReportQuery & {
  stage: ProjectStageRecord
  canWrite: boolean
  canEditConfiguration?: boolean
  projectTitle?: string
}): WorkspaceReportDetail {
  return reportDetail({
    report: input.report,
    stage: input.stage,
    latestSubmissionId: input.isLatest ? input.report.id : undefined,
    canWrite: input.canWrite,
    canEditConfiguration: input.canEditConfiguration,
    analysisDecision: input.capabilities.analysis,
    insightDecision: input.capabilities.insight,
    deletionDecision: input.capabilities.deletion,
    analysisTask: input.tasks.analysis,
    insightTask: input.tasks.insight,
    analysisResult: input.results.analysis,
    insightResult: input.results.insight,
    comparison: input.comparison,
    projectTitle: input.projectTitle,
    history: input.history,
    dispatch: input.dispatch,
  })
}

export function currentStageFromWorkflow(workflow: ProjectWorkflow): ProjectStageRecord | undefined {
  const inProgress = workflow.stages.find((stage) => stage.lifecycleStatus === 'in_progress')
  if (inProgress) return inProgress
  if (workflow.completedAt) return [...workflow.stages].sort((left, right) => right.ordinal - left.ordinal)[0]
  return workflow.stages.find((stage) => stage.lifecycleStatus === 'not_started') ?? workflow.stages[0]
}

export function workspaceWorkflow(workflow: ProjectWorkflow): WorkspaceWorkflow {
  const current = currentStageFromWorkflow(workflow)
  const result: WorkspaceWorkflow = {
    planRevision: workflow.planRevision,
    workflowRevision: workflow.workflowRevision,
    nextSubmissionSequence: workflow.nextSubmissionSequence,
  }
  if (workflow.completedAt) result.completedAt = workflow.completedAt
  if (current) result.currentStageId = current.id
  return result
}

export function workspaceCurrentStage(stage: ProjectStageRecord): WorkspaceCurrentStage {
  return { id: stage.id, ordinal: stage.ordinal, title: stage.title, lifecycleStatus: stage.lifecycleStatus }
}

export function stageGroup(input: {
  stage: ProjectStageRecord
  reports: WorkspaceReportCard[]
  canWrite: boolean
}): WorkspaceStageGroup {
  const reports = [...input.reports].sort((left, right) => right.stageVersion - left.stageVersion)
  const skippedEmpty = input.stage.lifecycleStatus === 'completed'
    && input.stage.completionReason === 'skipped'
    && reports.length === 0
  const group: WorkspaceStageGroup = {
    stage: input.stage,
    stageLabel: stageGroupLabel(input.stage),
    skippedEmpty,
    reports,
    canSubmitUpdate: input.canWrite && input.stage.lifecycleStatus !== 'completed',
    canSubmitCompletion: input.canWrite,
  }
  if (reports[0]) group.latestInStageReportId = reports[0].id
  if (input.stage.currentCompletionReportId) group.currentCompletionReportId = input.stage.currentCompletionReportId
  return group
}

export function defaultSelection(input: {
  workflow: ProjectWorkflow
  stages: WorkspaceStageGroup[]
  latestSubmission?: WorkspaceReportCard
  requested?: { stageId?: string; reportId?: string; source?: WorkspaceSelectionSource }
}): { selected: WorkspaceSelection; selectedCard?: WorkspaceReportCard } {
  const cards = input.stages.flatMap((group) => group.reports)
  const requestedReport = input.requested?.reportId ? cards.find((card) => card.id === input.requested?.reportId) : undefined
  if (requestedReport) {
    return { selected: { stageId: requestedReport.stageId, reportId: requestedReport.id, source: 'explicit' }, selectedCard: requestedReport }
  }
  const requestedStage = input.requested?.stageId
    ? input.stages.find((group) => group.stage.id === input.requested?.stageId)
    : undefined
  if (requestedStage) return selectionForStage(requestedStage, input.requested?.source ?? 'explicit')
  if (input.requested?.source === 'latest_submission' && input.latestSubmission) {
    return {
      selected: { stageId: input.latestSubmission.stageId, reportId: input.latestSubmission.id, source: 'latest_submission' },
      selectedCard: input.latestSubmission,
    }
  }
  const current = currentStageFromWorkflow(input.workflow)
  const currentGroup = current ? input.stages.find((group) => group.stage.id === current.id) : input.stages[0]
  if (!currentGroup) {
    return { selected: { stageId: input.workflow.stages[0]?.id ?? '', source: 'current_stage' } }
  }
  return selectionForStage(currentGroup, 'current_stage')
}

function selectionForStage(group: WorkspaceStageGroup, source: WorkspaceSelectionSource): { selected: WorkspaceSelection; selectedCard?: WorkspaceReportCard } {
  const completion = group.currentCompletionReportId
    ? group.reports.find((card) => card.id === group.currentCompletionReportId)
    : undefined
  if (group.stage.lifecycleStatus === 'completed' && completion) {
    const selected: WorkspaceSelection = { stageId: group.stage.id, reportId: completion.id, source: source === 'explicit' ? 'explicit' : 'stage_completion' }
    return { selected, selectedCard: completion }
  }
  const latest = group.reports[0]
  if (latest) {
    const selected: WorkspaceSelection = { stageId: group.stage.id, reportId: latest.id, source }
    return { selected, selectedCard: latest }
  }
  return { selected: { stageId: group.stage.id, source } }
}

export function projectListItem(input: {
  project: WorkspaceProjectRecord
  workflow?: ProjectWorkflow
  canWrite: boolean
  canEditConfiguration?: boolean
  submittedReportCount: number
  completedStageCount: number
  latestSubmission?: WorkspaceReportCard
}): WorkspaceProjectListItem {
  const current = input.workflow ? currentStageFromWorkflow(input.workflow) : undefined
  const item: WorkspaceProjectListItem = {
    id: input.project.id,
    ownerId: input.project.ownerId,
    title: input.project.title,
    objective: input.project.objective,
    description: input.project.description,
    ownerName: input.project.ownerName,
    memberRole: input.project.memberRole,
    canManage: input.canEditConfiguration ?? input.canWrite,
    canDelete: false,
    canSubmit: input.canWrite,
    canEditPlan: input.canEditConfiguration ?? input.canWrite,
    createdAt: input.project.createdAt,
    updatedAt: input.project.updatedAt,
    submittedReportCount: input.submittedReportCount,
    completedStageCount: input.completedStageCount,
  }
  if (input.project.collaboratorNames) item.collaboratorNames = input.project.collaboratorNames
  if (current) item.currentStage = workspaceCurrentStage(current)
  if (input.latestSubmission) item.latestSubmission = input.latestSubmission
  return item
}

export function projectDetail(input: {
  project: WorkspaceProjectRecord
  workflow: ProjectWorkflow
  stages: WorkspaceStageGroup[]
  canWrite: boolean
  canEditConfiguration?: boolean
  latestSubmission?: WorkspaceReportCard
  selectedReport?: WorkspaceReportDetail
  requested?: { stageId?: string; reportId?: string; source?: WorkspaceSelectionSource }
}): WorkspaceProjectDetail {
  const currentCompletionByStage: Record<string, string> = {}
  for (const group of input.stages) {
    if (group.currentCompletionReportId) currentCompletionByStage[group.stage.id] = group.currentCompletionReportId
  }
  const selection = defaultSelection({
    workflow: input.workflow,
    stages: input.stages,
    latestSubmission: input.latestSubmission,
    requested: input.requested,
  })
  const detail: WorkspaceProjectDetail = {
    project: projectListItem({
      project: input.project,
      workflow: input.workflow,
      canWrite: input.canWrite,
      canEditConfiguration: input.canEditConfiguration,
      submittedReportCount: input.stages.reduce((total, group) => total + group.reports.length, 0),
      completedStageCount: input.stages.filter((group) => group.stage.lifecycleStatus === 'completed').length,
      latestSubmission: input.latestSubmission,
    }),
    workflow: workspaceWorkflow(input.workflow),
    stages: input.stages,
    currentCompletionByStage,
    selected: selection.selected,
  }
  if (input.latestSubmission) detail.latestSubmission = input.latestSubmission
  if (input.selectedReport) detail.selectedReport = input.selectedReport
  return detail
}

export function writeContext(input: { actor: WorkspaceActorView; projectId: string; membershipRole?: ProjectMemberRole }): ReportWriteContext {
  if (!input.membershipRole) return { actor: input.actor, projectId: input.projectId }
  return { actor: input.actor, projectId: input.projectId, membership: { projectId: input.projectId, userId: input.actor.id, role: input.membershipRole } }
}

export function actorCanEditConfiguration(input: { actor: WorkspaceActorView; projectId: string; membershipRole?: ProjectMemberRole }): boolean {
  return canEditProjectConfiguration(writeContext(input))
}

export function actorCanWrite(input: { actor: WorkspaceActorView; projectId: string; membershipRole?: ProjectMemberRole }) {
  return canWriteProjectReports(writeContext(input))
}

export const queryProjection = {
  projectListItem,
  projectDetail,
  reportCard,
  reportDetail,
  reportDetailFromNative,
  stageGroup,
  workspaceCapabilities,
  workspaceWorkflow,
  defaultSelection,
  successfulAnalysisSnapshot,
  successfulInsightOutput,
  actorCanWrite,
}
