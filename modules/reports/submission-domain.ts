import type { AnalysisJobStatus } from '@/modules/contracts/analysis'
import type { ProjectMemberRole } from '@/modules/projects/domain'
import type { UserRole, UserStatus } from '@/modules/users/domain'

export type ReportSubmissionKind = 'update' | 'completion'
export type ReportOperation = 'analysis' | 'insight'

export const MAX_REPORT_OPERATION_SUCCESSES = 3

export interface ReportSubmission {
  readonly id: string
  readonly projectId: string
  readonly stageId: string
  readonly stageVersion: number
  readonly submissionSequence: number
  readonly submittedAs: ReportSubmissionKind
  readonly title: string
  readonly fileName: string
  readonly sourceKey: string
  readonly fileHash: string
  readonly sourceSize: number
  readonly paragraphCount: number
  readonly characterCount: number
  readonly submittedBy: string
  readonly submittedAt: string
  readonly wasFirstStageSubmission: boolean
  readonly firstAnalysisSucceededAt?: string
  readonly firstInsightSucceededAt?: string
  readonly deletedAt?: string
  readonly deletedBy?: string
  readonly deletionReason?: string
}

export type SubmissionIdentity = Pick<ReportSubmission,
  'id' | 'projectId' | 'stageId' | 'stageVersion' | 'submissionSequence' | 'deletedAt'>

export interface ReportActor {
  readonly id: string
  readonly role: UserRole
  readonly status: UserStatus
}

/** Resolved by the server for this actor and project, never taken from request JSON. */
export interface ReportProjectMembership {
  readonly projectId: string
  readonly userId: string
  readonly role: ProjectMemberRole
}

export interface ReportWriteContext {
  readonly actor?: ReportActor
  readonly projectId: string
  readonly membership?: ReportProjectMembership
}

export interface ReportOperationAttempt {
  readonly jobId: string
  readonly status: AnalysisJobStatus
}

export interface ReportOperationHistory {
  readonly successCount: number
  readonly firstSucceededAt?: string
  readonly latestAttempt?: ReportOperationAttempt
}

export type ReportOperationDecision =
  | { kind: 'enqueue'; action: 'start' | 'retry' | 'rerun' }
  | { kind: 'reuse'; jobId: string }
  | { kind: 'denied'; code: ReportAccessDenial }

export type ReportAccessDenial =
  | 'REPORT_WRITE_FORBIDDEN'
  | 'REPORT_NOT_FOUND'
  | 'REPORT_STATE_INVALID'
  | 'HISTORICAL_OPERATION_ALREADY_SUCCEEDED'
  | 'REPORT_OPERATION_SUCCESS_LIMIT'
  | 'COMPLETION_REPORT_PROTECTED'
  | 'REPORT_PROCESSING'

export type ReportMutationDecision =
  | { kind: 'allowed' }
  | { kind: 'denied'; code: ReportAccessDenial }
