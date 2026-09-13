import { getSubmissionDisplayLabels } from '@/modules/reports/submission-query'
import { stageGroupLabel } from '@/modules/reports/workspace-query'
import type { AiScore } from '@/modules/contracts/analysis'
import type { ProjectStageRecord } from '@/modules/projects/stage-domain'
import type { ReportSubmissionCommand } from '@/modules/contracts/report-submission'
import type { ReportSubmissionKind } from '@/modules/reports/submission-domain'
import type { SubmissionComparison } from '@/modules/reports/submission-query'
import type { SubmissionTask } from '@/modules/reports/submission-task-domain'
import type {
  WorkspaceConfirmResponse,
  WorkspaceJobAction,
  WorkspaceOutboxDispatch,
  WorkspaceOverviewStats,
  WorkspaceReportCard,
  WorkspaceStageGroup,
  WorkspaceUploadStatus,
  WorkspaceWorkflow,
} from '@/modules/contracts/submission-workspace'
import type { ReportSubmissionReceipt } from '@/modules/reports/upload-domain'

export {
  WORKSPACE_API,
  WORKSPACE_RETIRED_CODES,
  WORKSPACE_RETIRED_PROJECT_FIELDS,
  isReportSubmissionCommand,
  isReportSubmissionIdempotencyKey,
  isStagePlanEdit,
  isStageProjectCreate,
  isWorkspaceProjectSafeEdit,
  queryProjection,
} from '@/modules/contracts/submission-workspace'

export type {
  ResearchStage,
  WorkspaceCapabilities,
  WorkspaceConfirmResponse,
  WorkspaceCurrentStage,
  WorkspaceErrorBody,
  WorkspaceHistoryResponse,
  WorkspaceJobAction,
  WorkspaceKnowledgeCard,
  WorkspaceNotificationList,
  WorkspaceOutboxDispatch,
  WorkspaceOverview,
  WorkspaceOverviewStats,
  WorkspaceProjectDetail,
  WorkspaceProjectListItem,
  WorkspaceProjectListResponse,
  WorkspaceProjectSafeEdit,
  WorkspaceReportCard,
  WorkspaceReportDetail,
  WorkspaceReportLabels,
  WorkspaceReportListResponse,
  WorkspaceSelection,
  WorkspaceSelectionSource,
  WorkspaceStageGroup,
  WorkspaceStagesResponse,
  WorkspaceTaskProgress,
  WorkspaceTaskResponse,
  WorkspaceUploadStatus,
  WorkspaceWorkflow,
  WorkspaceRetiredCode,
} from '@/modules/contracts/submission-workspace'

export { getSubmissionDisplayLabels }

export const SKIPPED_EMPTY_COPY = '已完成 · 跳过，暂无报告'
const CONFLICT_CODES = new Set([
  'STAGE_COMPLETION_CHANGED',
  'PROJECT_WORKFLOW_CHANGED',
  'PROJECT_PLAN_CHANGED',
])

export type WorkspaceDispatchError = {
  operation: 'analysis' | 'insight'
  code: string
  message: string
}

export type WorkspaceDocumentSource = {
  id: string
  title: string
  fileName: string
  displayLabel?: string
  submittedAt?: string
}

export type WorkspaceStageTokens = {
  planRevision: number
  workflowRevision: number
  completionRevision: number
  completionReportId: string | null
}

export type WorkspaceConfirmConflict = {
  code: string
  error: string
  details?: Record<string, string | number | null>
}

export type WorkspaceSubmitImpact = {
  autoCompletedStages: Array<Pick<ProjectStageRecord, 'id' | 'ordinal' | 'title'> & { hasReports: boolean }>
  supersededCompletionReportId?: string
  nextInProgressStage?: Pick<ProjectStageRecord, 'id' | 'ordinal' | 'title'>
  projectWillComplete: boolean
  targetAlreadyCompleted: boolean
}

export type WorkspaceSubmitPhase =
  | { step: 'idle' }
  | { step: 'configure'; file: File }
  | { step: 'confirm'; file: File; stageId: string; reportKind: ReportSubmissionKind; impact: WorkspaceSubmitImpact }
  | { step: 'preparing'; file: File; stageId: string; reportKind: ReportSubmissionKind; impact: WorkspaceSubmitImpact }
  | { step: 'prepared'; file: File; stageId: string; reportKind: ReportSubmissionKind; impact: WorkspaceSubmitImpact; upload: WorkspaceUploadStatus }
  | { step: 'submitting'; previouslyUncertain?: boolean; file: File; stageId: string; reportKind: ReportSubmissionKind; impact: WorkspaceSubmitImpact; upload: WorkspaceUploadStatus; command: ReportSubmissionCommand; idempotencyKey: string }
  | { step: 'conflict'; file: File; stageId: string; reportKind: ReportSubmissionKind; impact: WorkspaceSubmitImpact; upload: WorkspaceUploadStatus; command: ReportSubmissionCommand; conflict: WorkspaceConfirmConflict; tokensReady: boolean }
  | { step: 'uncertain'; file: File; stageId: string; reportKind: ReportSubmissionKind; impact: WorkspaceSubmitImpact; upload: WorkspaceUploadStatus; command: ReportSubmissionCommand; idempotencyKey: string; error: string }
  | { step: 'acknowledged'; file: File; stageId: string; reportKind: ReportSubmissionKind; impact: WorkspaceSubmitImpact; upload: WorkspaceUploadStatus; command: ReportSubmissionCommand; idempotencyKey: string; receipt: ReportSubmissionReceipt; replayed?: boolean }
  | { step: 'failed'; file: File; stageId?: string; reportKind?: ReportSubmissionKind; error: string; code?: string }

export type WorkspaceSubmitEvent =
  | { type: 'select_file'; file: File }
  | { type: 'configure'; stageId: string; reportKind: ReportSubmissionKind; impact: WorkspaceSubmitImpact }
  | { type: 'prepare_started' }
  | { type: 'prepare_succeeded'; upload: WorkspaceUploadStatus }
  | { type: 'prepare_failed'; error: string; code?: string }
  | { type: 'commit_started'; command: ReportSubmissionCommand; idempotencyKey: string }
  | { type: 'commit_acknowledged'; receipt: ReportSubmissionReceipt; replayed?: boolean }
  | { type: 'commit_conflict'; conflict: WorkspaceConfirmConflict; tokens?: WorkspaceStageTokens; tokensReady: boolean }
  | { type: 'upload_checked'; upload: WorkspaceUploadStatus; code?: string; error: string }
  | { type: 'commit_uncertain'; error: string }
  | { type: 'commit_rejected'; error: string; code?: string }
  | { type: 'conflict_refreshed'; tokens: WorkspaceStageTokens }
  | { type: 'refresh_failed'; error: string }
  | { type: 'reset' }

const COMMITTED_PHASES = new Set(['submitting', 'uncertain', 'acknowledged', 'conflict', 'prepared', 'preparing'])

export function classifyCommitFailure(error: { status?: number; code?: string; previouslyUncertain?: boolean }): 'rejected' | 'conflict' | 'already_committed' | 'reconcile' | 'uncertain' {
  const code = error.code ?? ''
  if (!error.status || error.status >= 500) return 'uncertain'
  if (code === 'UPLOAD_ALREADY_COMMITTED') return 'already_committed'
  // The transaction checks the receipt before stage/workflow tokens, even on replay.
  if (error.status === 409 && shouldMintNewIdempotencyKey(code)) return 'conflict'
  if (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'UPLOAD_ABORTED') return 'reconcile'
  // Other rejections cannot disprove an earlier lost commit response.
  if (error.previouslyUncertain) return 'uncertain'
  if ([401, 403, 404].includes(error.status) || ['UPLOAD_EXPIRED', 'UPLOAD_NOT_READY', 'REPORT_FILE_CHANGED', 'INVALID_SUBMISSION', 'INVALID_REPORT_KIND', 'INVALID_STAGE_PLAN', 'EMPTY_STAGE_PLAN'].includes(code)) return 'rejected'
  return 'uncertain'
}

export function shouldPreserveSubmitPhase(phase: WorkspaceSubmitPhase) {
  return phase.step === 'submitting' || phase.step === 'uncertain'
}

export function dismissWorkspaceSubmit(phase: WorkspaceSubmitPhase): WorkspaceSubmitPhase {
  return shouldPreserveSubmitPhase(phase) ? phase : idleSubmitPhase()
}

export function originProjectIdFromSubmit(phase: WorkspaceSubmitPhase) {
  return 'upload' in phase ? phase.upload.projectId : undefined
}

export function submitCommitEnabled(phase: WorkspaceSubmitPhase, currentProjectId?: string) {
  if (phase.step === 'submitting') return false
  const origin = originProjectIdFromSubmit(phase)
  if (origin && currentProjectId && origin !== currentProjectId) return false
  return phase.step === 'prepared' || phase.step === 'uncertain' || (phase.step === 'conflict' && phase.tokensReady)
}

export function submitCloseLabel(phase: WorkspaceSubmitPhase) {
  if (phase.step === 'acknowledged') return '关闭'
  if (shouldPreserveSubmitPhase(phase)) return '稍后确认'
  return '取消'
}

export function describeCommitNetworkError(cause: unknown, fallback = '提交结果未确认。将使用相同幂等键重试，不会重新解析文件。') {
  const message = cause instanceof Error ? cause.message : ''
  if (cause instanceof TypeError || /failed to fetch/i.test(message) || /failed to fetch/i.test(fallback) || message === 'Load failed') {
    return '网络中断，提交结果未确认。请重试同一提交，不要重新上传。'
  }
  return fallback || message || '提交结果未确认。将使用相同幂等键重试，不会重新解析文件。'
}

export function duplicateSubmitFormError(phase: WorkspaceSubmitPhase, error?: string) {
  if (!error) return true
  if (phase.step === 'uncertain') return error === phase.error || phase.error.includes(error) || error.includes(phase.error)
  if (phase.step === 'conflict') return error === phase.conflict.error
  return phase.step === 'acknowledged'
}

export function reduceWorkspaceSubmit(phase: WorkspaceSubmitPhase, event: WorkspaceSubmitEvent): WorkspaceSubmitPhase {
  switch (event.type) {
    case 'reset':
      return shouldPreserveSubmitPhase(phase) ? phase : { step: 'idle' }
    case 'select_file':
      if (COMMITTED_PHASES.has(phase.step)) return phase
      return { step: 'configure', file: event.file }
    case 'configure':
      if (phase.step !== 'configure' && phase.step !== 'confirm') return phase
      return { step: 'confirm', file: phase.file, stageId: event.stageId, reportKind: event.reportKind, impact: event.impact }
    case 'prepare_started':
      if (phase.step !== 'confirm') return phase
      return { step: 'preparing', file: phase.file, stageId: phase.stageId, reportKind: phase.reportKind, impact: phase.impact }
    case 'prepare_succeeded':
      if (phase.step !== 'preparing') return phase
      return { ...phase, step: 'prepared', upload: event.upload }
    case 'prepare_failed':
      if (phase.step !== 'preparing') return phase
      return { step: 'failed', file: phase.file, stageId: phase.stageId, reportKind: phase.reportKind, error: event.error, ...(event.code ? { code: event.code } : {}) }
    case 'commit_started':
      if (phase.step === 'uncertain') return { ...phase, step: 'submitting', previouslyUncertain: true }
      if (phase.step === 'prepared') return { ...phase, step: 'submitting', command: event.command, idempotencyKey: event.idempotencyKey }
      if (phase.step === 'conflict' && phase.tokensReady) return { ...phase, step: 'submitting', command: event.command, idempotencyKey: event.idempotencyKey }
      return phase
    case 'commit_acknowledged':
      if (phase.step !== 'submitting' && phase.step !== 'uncertain') return phase
      return {
        step: 'acknowledged',
        file: phase.file,
        stageId: phase.stageId,
        reportKind: phase.reportKind,
        impact: phase.impact,
        upload: phase.upload,
        command: phase.command,
        idempotencyKey: phase.idempotencyKey,
        receipt: event.receipt,
        ...(event.replayed ? { replayed: true } : {}),
      }
    case 'commit_conflict':
      if (phase.step !== 'submitting' || !shouldMintNewIdempotencyKey(event.conflict.code)) return phase
      return {
        step: 'conflict',
        file: phase.file,
        stageId: phase.stageId,
        reportKind: phase.reportKind,
        impact: phase.impact,
        upload: phase.upload,
        command: event.tokensReady && event.tokens ? refreshSubmissionCommand(phase.command, event.tokens) : phase.command,
        conflict: event.conflict,
        tokensReady: event.tokensReady,
      }
    case 'upload_checked':
      if (phase.step !== 'submitting' || event.upload.id !== phase.upload.id || event.upload.projectId !== phase.upload.projectId || event.upload.reportId) return phase
      if (['failed', 'reclaiming', 'reclaimed'].includes(event.upload.status)) {
        return { step: 'failed', file: phase.file, stageId: phase.stageId, reportKind: phase.reportKind, error: event.error, code: event.code }
      }
      if (event.code === 'IDEMPOTENCY_KEY_REUSED' && event.upload.status === 'ready') {
        return { step: 'conflict', file: phase.file, stageId: phase.stageId, reportKind: phase.reportKind, impact: phase.impact, upload: event.upload, command: phase.command, conflict: { code: event.code, error: event.error }, tokensReady: false }
      }
      return phase
    case 'commit_rejected':
      if (phase.step !== 'submitting' || phase.previouslyUncertain) return phase
      return { step: 'failed', file: phase.file, stageId: phase.stageId, reportKind: phase.reportKind, error: event.error, code: event.code }
    case 'commit_uncertain':
      if (phase.step !== 'submitting') return phase
      return { ...phase, step: 'uncertain', error: event.error }
    case 'conflict_refreshed':
      if (phase.step !== 'conflict') return phase
      return { ...phase, tokensReady: true, command: refreshSubmissionCommand(phase.command, event.tokens) }
    case 'refresh_failed':
      if (phase.step === 'conflict') return { ...phase, tokensReady: false }
      return phase
    default:
      return phase
  }
}

export function formatStageLabel(stage: Pick<ProjectStageRecord, 'ordinal' | 'title'>) {
  return stageGroupLabel(stage)
}

export function allowedReportKinds(stage: Pick<ProjectStageRecord, 'lifecycleStatus'>): ReportSubmissionKind[] {
  return stage.lifecycleStatus === 'completed' ? ['completion'] : ['update', 'completion']
}

export function planIsFrozen(stages: WorkspaceStageGroup[]) {
  return stages.some((group) => group.reports.length > 0 || group.stage.nextReportVersion > 1)
}

export function previewSubmissionImpact(input: {
  stages: Array<Pick<ProjectStageRecord, 'id' | 'ordinal' | 'title' | 'lifecycleStatus' | 'currentCompletionReportId'>>
  targetStageId: string
  reportKind: ReportSubmissionKind
}): WorkspaceSubmitImpact {
  const ordered = [...input.stages].sort((left, right) => left.ordinal - right.ordinal)
  const targetIndex = ordered.findIndex((item) => item.id === input.targetStageId)
  const target = ordered[targetIndex]
  if (!target) {
    return { autoCompletedStages: [], projectWillComplete: false, targetAlreadyCompleted: false }
  }
  const targetAlreadyCompleted = target.lifecycleStatus === 'completed'
  const autoCompletedStages = targetAlreadyCompleted ? []
    : ordered.slice(0, targetIndex).filter((item) => item.lifecycleStatus !== 'completed').map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      title: item.title,
      hasReports: Boolean(item.currentCompletionReportId),
    }))
  const next = targetAlreadyCompleted ? undefined : input.reportKind === 'completion'
    ? ordered.slice(targetIndex + 1).find((item) => item.lifecycleStatus !== 'completed')
    : target.lifecycleStatus === 'not_started' ? target : undefined
  return {
    autoCompletedStages,
    supersededCompletionReportId: input.reportKind === 'completion' ? target.currentCompletionReportId : undefined,
    nextInProgressStage: next ? { id: next.id, ordinal: next.ordinal, title: next.title } : undefined,
    projectWillComplete: !targetAlreadyCompleted && input.reportKind === 'completion' && !next,
    targetAlreadyCompleted,
  }
}

export function comparisonIsHidden(comparison: SubmissionComparison) {
  return comparison.status === 'unavailable' && comparison.reason === 'first_stage_submission'
}

export function characterDeltaFromComparison(comparison: SubmissionComparison) {
  return comparison.status === 'available' ? comparison.characterDelta : undefined
}

export function scoreDeltaFromComparison(comparison: SubmissionComparison) {
  return comparison.status === 'available' ? comparison.scoreDelta : undefined
}

export const NATIVE_TASK_EVENT_TYPES = [
  'queued',
  'claimed',
  'progress',
  'succeeded',
  'failed',
  'cancelled',
  'cancellation_requested',
] as const

export function isCurrentWorkspaceFetch(input: {
  generation: number
  currentGeneration: number
  expectedReportId?: string
  selectedReportId?: string
  fetchedReportId?: string
}) {
  if (input.generation !== input.currentGeneration) return false
  if (input.expectedReportId && input.selectedReportId !== input.expectedReportId) return false
  if (input.expectedReportId && input.fetchedReportId && input.fetchedReportId !== input.expectedReportId) return false
  return true
}

export function presentAiScore(score: AiScore, comparison: SubmissionComparison): { score: AiScore; scoreDelta?: number } {
  const presented: AiScore = { overall: score.overall, summary: score.summary, dimensions: score.dimensions }
  const scoreDelta = scoreDeltaFromComparison(comparison)
  return scoreDelta === undefined ? { score: presented } : { score: presented, scoreDelta }
}

export function analysisActionLabel(action: WorkspaceJobAction) {
  if (action === 'start') return '启动分析'
  if (action === 'retry') return '再次分析'
  if (action === 'rerun') return '更新分析'
  if (action === 'view') return '查看分析'
  return undefined
}

export function insightActionLabel(action: WorkspaceJobAction) {
  if (action === 'start') return '生成洞察'
  if (action === 'retry') return '再次生成洞察'
  if (action === 'rerun') return '更新洞察'
  if (action === 'view') return '查看洞察'
  return undefined
}

export function hasCompletedFullAnalysis(report: Pick<WorkspaceReportCard, 'aiScore' | 'capabilities'>) {
  return report.aiScore !== undefined || report.capabilities.analysisAction === 'rerun'
}

export function isTaskInFlight(task?: Pick<SubmissionTask, 'status' | 'cancelRequested'>) {
  if (!task) return false
  return task.status === 'queued' || task.status === 'running'
}

export function dispatchInFlight(dispatch?: WorkspaceOutboxDispatch) {
  return dispatch?.status === 'pending' || dispatch?.status === 'leased'
}

export function shouldPollReport(input: {
  dispatch?: WorkspaceOutboxDispatch
  outboxPending?: boolean
  analysisTask?: Pick<SubmissionTask, 'status' | 'cancelRequested'>
  insightTask?: Pick<SubmissionTask, 'status' | 'cancelRequested'>
}) {
  return Boolean(input.outboxPending) || dispatchInFlight(input.dispatch) || isTaskInFlight(input.analysisTask) || isTaskInFlight(input.insightTask)
}

export function reportDeleteBlocked(input: {
  canDelete: boolean
  analysisTask?: Pick<SubmissionTask, 'status' | 'cancelRequested'>
  insightTask?: Pick<SubmissionTask, 'status' | 'cancelRequested'>
}) {
  // An outbox intent is not an active task; the server fences admission against deletion.
  return !input.canDelete || isTaskInFlight(input.analysisTask) || isTaskInFlight(input.insightTask)
}

export function currentStageTokens(group: WorkspaceStageGroup, workflow: Pick<WorkspaceWorkflow, 'planRevision' | 'workflowRevision'>): WorkspaceStageTokens {
  return {
    planRevision: workflow.planRevision,
    workflowRevision: workflow.workflowRevision,
    completionRevision: group.stage.completionRevision,
    completionReportId: group.currentCompletionReportId ?? null,
  }
}

export function buildSubmissionCommand(input: {
  uploadId: string
  stageId: string
  reportKind: ReportSubmissionKind
  tokens: WorkspaceStageTokens
}): ReportSubmissionCommand {
  return {
    uploadId: input.uploadId,
    stageId: input.stageId,
    reportKind: input.reportKind,
    expectedPlanRevision: input.tokens.planRevision,
    expectedWorkflowRevision: input.tokens.workflowRevision,
    expectedCompletionRevision: input.tokens.completionRevision,
    expectedCompletionReportId: input.tokens.completionReportId,
  }
}

export function refreshSubmissionCommand(command: ReportSubmissionCommand, tokens: WorkspaceStageTokens): ReportSubmissionCommand {
  return {
    ...command,
    expectedPlanRevision: tokens.planRevision,
    expectedWorkflowRevision: tokens.workflowRevision,
    expectedCompletionRevision: tokens.completionRevision,
    expectedCompletionReportId: tokens.completionReportId,
  }
}

export function shouldMintNewIdempotencyKey(code: string) {
  return CONFLICT_CODES.has(code)
}

export function createIdempotencyKey(byteLength = 18, random: (size: number) => Uint8Array = defaultRandomBytes) {
  const size = Math.min(96, Math.max(12, Math.floor(byteLength)))
  const bytes = random(size)
  let encoded = ''
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  for (const value of bytes) encoded += alphabet[value % 64]
  return encoded.length >= 16 ? encoded.slice(0, 128) : (encoded + 'idempotency_pad').slice(0, 16)
}

function defaultRandomBytes(size: number) {
  const bytes = new Uint8Array(size)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
    return bytes
  }
  for (let index = 0; index < size; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return bytes
}

export function idleSubmitPhase(): WorkspaceSubmitPhase {
  return { step: 'idle' }
}

export function beginSubmitConfirm(input: {
  file: File
  stageId: string
  reportKind: ReportSubmissionKind
  impact: WorkspaceSubmitImpact
}): Extract<WorkspaceSubmitPhase, { step: 'confirm' }> {
  return { step: 'confirm', ...input }
}

export function beginSubmitCommit(input: {
  phase: Extract<WorkspaceSubmitPhase, { step: 'prepared' | 'conflict' | 'uncertain' }>
  command: ReportSubmissionCommand
  idempotencyKey: string
}): Extract<WorkspaceSubmitPhase, { step: 'submitting' }> {
  const next = reduceWorkspaceSubmit(input.phase, { type: 'commit_started', command: input.command, idempotencyKey: input.idempotencyKey })
  if (next.step !== 'submitting') throw new Error('commit cannot start until tokens are ready or the same request is retried')
  return next
}

export function emptyOverviewStats(): WorkspaceOverviewStats {
  return {
    submittedReportCount: 0,
    totalCharacters: 0,
    knowledgeCount: 0,
    knowledgeCategoryCount: 0,
    weeklyNewReports: 0,
    weeklyNewKnowledge: 0,
    completedStageCount: 0,
    jobStats: { completed: 0, failed: 0, cancelled: 0, running: 0, queued: 0 },
    trends: { submissions: [], characters: [], successRate: [], knowledge: [], averageScore: [], analyzedProjects: [] },
  }
}

export function documentSourceFromReport(report: WorkspaceReportCard): WorkspaceDocumentSource {
  return {
    id: report.id,
    title: report.title,
    fileName: report.fileName,
    displayLabel: report.labels.compactLabel,
    submittedAt: report.submittedAt,
  }
}

export type { WorkspaceConfirmResponse as ConfirmReceipt }
