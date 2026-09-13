import { MAX_REPORT_OPERATION_SUCCESSES } from '@/modules/reports/submission-domain'
import type {
  ReportMutationDecision,
  ReportOperation,
  ReportOperationDecision,
  ReportOperationHistory,
  ReportWriteContext,
  SubmissionIdentity,
} from '@/modules/reports/submission-domain'

export function canWriteProjectReports(context: ReportWriteContext): boolean {
  const { actor, membership, projectId } = context
  if (!projectId || !actor?.id || actor.status !== 'active') return false
  if (actor.role === 'admin') return true
  return actor.role === 'researcher'
    && membership?.userId === actor.id
    && membership.projectId === projectId
    && membership.role === 'owner'
}

interface OperationAccessInput {
  access: ReportWriteContext
  report: SubmissionIdentity
  latestSubmission?: SubmissionIdentity
  history: ReportOperationHistory
}

export function resolveReportOperationAccess(input: OperationAccessInput): ReportOperationDecision {
  const { access, report, latestSubmission, history } = input
  if (!canWriteProjectReports(access)) return { kind: 'denied', code: 'REPORT_WRITE_FORBIDDEN' }
  if (report.projectId !== access.projectId || report.deletedAt) return { kind: 'denied', code: 'REPORT_NOT_FOUND' }
  if (!isValidLatestSubmission(report, latestSubmission)) return { kind: 'denied', code: 'REPORT_STATE_INVALID' }
  const attempt = history.latestAttempt
  if (attempt?.status === 'queued' || attempt?.status === 'running') {
    return { kind: 'reuse', jobId: attempt.jobId }
  }
  if (history.successCount >= MAX_REPORT_OPERATION_SUCCESSES) {
    return { kind: 'denied', code: 'REPORT_OPERATION_SUCCESS_LIMIT' }
  }
  const hasSucceeded = history.successCount > 0 || Boolean(history.firstSucceededAt) || attempt?.status === 'completed'
  if (report.id !== latestSubmission?.id && hasSucceeded) {
    return { kind: 'denied', code: 'HISTORICAL_OPERATION_ALREADY_SUCCEEDED' }
  }
  if (hasSucceeded) return { kind: 'enqueue', action: 'rerun' }
  return { kind: 'enqueue', action: attempt ? 'retry' : 'start' }
}

function isValidLatestSubmission(report: SubmissionIdentity, latest?: SubmissionIdentity): boolean {
  if (!latest || latest.deletedAt || latest.projectId !== report.projectId) return false
  if (!Number.isSafeInteger(report.submissionSequence) || report.submissionSequence < 1) return false
  if (!Number.isSafeInteger(latest.submissionSequence) || latest.submissionSequence < report.submissionSequence) return false
  if (latest.id === report.id) return latest.submissionSequence === report.submissionSequence
  return latest.submissionSequence > report.submissionSequence
}

interface DeleteAccessInput {
  access: ReportWriteContext
  report: SubmissionIdentity
  stage: { id: string; projectId: string; currentCompletionReportId?: string }
  operations: Readonly<Record<ReportOperation, ReportOperationHistory>>
}

export function resolveReportDeletionAccess(input: DeleteAccessInput): ReportMutationDecision {
  const { access, report, stage, operations } = input
  if (!canWriteProjectReports(access)) return { kind: 'denied', code: 'REPORT_WRITE_FORBIDDEN' }
  if (report.projectId !== access.projectId || report.deletedAt) return { kind: 'denied', code: 'REPORT_NOT_FOUND' }
  if (stage.id !== report.stageId || stage.projectId !== report.projectId) {
    return { kind: 'denied', code: 'REPORT_STATE_INVALID' }
  }
  if (stage.currentCompletionReportId === report.id) return { kind: 'denied', code: 'COMPLETION_REPORT_PROTECTED' }
  const hasActiveTask = Object.values(operations).some(({ latestAttempt }) => latestAttempt?.status === 'queued' || latestAttempt?.status === 'running')
  if (hasActiveTask) return { kind: 'denied', code: 'REPORT_PROCESSING' }
  return { kind: 'allowed' }
}
