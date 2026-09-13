import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'
import type { AnalysisSnapshotPayload, AnalysisStage } from '@/modules/contracts/analysis'
import {
  isStagePlanEdit,
  isStageProjectCreate,
  StagePlanEditSchema,
  StageProjectCreateSchema,
  type StagePlanEdit,
  type StageProjectCreate,
} from '@/modules/projects/stage-project-contract'
import type { ProjectMemberRole } from '@/modules/projects/domain'
import type { ProjectStageRecord, StageLifecycleStatus } from '@/modules/projects/stage-domain'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'
import type { ReportInsightOutput } from '@/modules/insights/domain'
import type { NotificationItem } from '@/modules/notifications/domain'
import {
  isReportSubmissionCommand,
  isReportSubmissionIdempotencyKey,
  type ReportSubmissionCommand,
} from '@/modules/contracts/report-submission'
import type { ReportSubmissionKind } from '@/modules/reports/submission-domain'
import type { SubmissionComparison } from '@/modules/reports/submission-query'
import type { SubmissionTask, SubmissionTaskResult } from '@/modules/reports/submission-task-domain'
import type { ReportSubmissionReceipt, ReportUploadStatus } from '@/modules/reports/upload-domain'
import { queryProjection } from '@/modules/reports/workspace-query'

export {
  isReportSubmissionCommand,
  isReportSubmissionIdempotencyKey,
  isStagePlanEdit,
  isStageProjectCreate,
  queryProjection,
  StagePlanEditSchema,
  StageProjectCreateSchema,
}
export type { ReportSubmissionCommand, ReportSubmissionReceipt, StagePlanEdit, StageProjectCreate, SubmissionComparison }

/** Actual stage domain record. Frontend must not invent legacy Milestone. */
export type ResearchStage = ProjectStageRecord

export const WORKSPACE_API = {
  projects: '/api/projects',
  project: '/api/projects/:projectId',
  stages: '/api/projects/:projectId/stages',
  stageReports: '/api/projects/:projectId/stages/:stageId/reports',
  projectReports: '/api/projects/:projectId/reports',
  projectHistory: '/api/projects/:projectId/reports/history',
  reportUploads: '/api/projects/:projectId/report-uploads',
  reportUpload: '/api/projects/:projectId/report-uploads/:uploadId',
  reports: '/api/reports',
  report: '/api/reports/:reportId',
  reportFile: '/api/reports/:reportId/file',
  reportAnalyze: '/api/reports/:reportId/analyze',
  reportInsight: '/api/reports/:reportId/insight',
  job: '/api/jobs/:jobId',
  jobCancel: '/api/jobs/:jobId/cancel',
  jobRetry: '/api/jobs/:jobId/retry',
  jobEvents: '/api/jobs/:jobId/events',
  notifications: '/api/notifications',
  overview: '/api/overview-stats',
} as const

export type WorkspaceJobAction = 'start' | 'retry' | 'rerun' | 'view' | 'none'
export type WorkspaceSelectionSource = 'current_stage' | 'latest_submission' | 'stage_completion' | 'explicit'

export const WORKSPACE_RETIRED_CODES = {
  REPORT_STAGE_IMMUTABLE: 'REPORT_STAGE_IMMUTABLE',
  REPORT_SOURCE_IMMUTABLE: 'REPORT_SOURCE_IMMUTABLE',
  UPLOAD_PROTOCOL_RETIRED: 'UPLOAD_PROTOCOL_RETIRED',
  PROJECT_FIELD_RETIRED: 'PROJECT_FIELD_RETIRED',
  PROJECT_RETENTION_REQUIRED: 'PROJECT_RETENTION_REQUIRED',
} as const

export type WorkspaceRetiredCode = (typeof WORKSPACE_RETIRED_CODES)[keyof typeof WORKSPACE_RETIRED_CODES]

export interface WorkspaceReportLabels {
  stageLabel: string
  reportLabel: string
  compactLabel: string
  roleLabel: string
  completionLabel?: string
}

export interface WorkspaceTaskProgress {
  stage: AnalysisStage
  stageIndex: number
  status: SubmissionTask['status']
  cancelRequested: boolean
}

export interface WorkspaceCapabilities {
  canSubmitUpdate: boolean
  canSubmitCompletion: boolean
  canDelete: boolean
  canCancelAnalysisJob: boolean
  canCancelInsightJob: boolean
  canEditPlan: boolean
  analysisAction: WorkspaceJobAction
  insightAction: WorkspaceJobAction
  analysisJobId?: string
  insightJobId?: string
  disabledReason?: string
  disabledReasons: string[]
}

export interface WorkspaceOutboxDispatch {
  status: string
  errorCode?: string
  availableAt?: string
}

export interface WorkspaceReportCard {
  id: string
  projectId: string
  projectTitle?: string
  stageId: string
  stageVersion: number
  submissionSequence: number
  title: string
  fileName: string
  sourceSize: number
  paragraphCount: number
  characterCount: number
  submittedAs: ReportSubmissionKind
  submittedAt: string
  submittedBy: string
  wasFirstStageSubmission: boolean
  isCurrentCompletion: boolean
  isLatestSubmission: boolean
  labels: WorkspaceReportLabels
  aiScore?: number
  completeness?: number
  capabilities: WorkspaceCapabilities
  comparison: SubmissionComparison
}

export interface WorkspaceReportDetail extends WorkspaceReportCard {
  /** Latest successful analysis payload only. Never a partial pre-gate snapshot or synthetic zero. */
  snapshot?: AnalysisSnapshotPayload
  insight?: ReportInsightOutput
  analysisTask?: SubmissionTask
  insightTask?: SubmissionTask
  /** Alias of analysisTask for single-job reuse views. Cancel/retry must use analysisTask/insightTask. */
  job?: SubmissionTask
  progress: {
    analysis?: WorkspaceTaskProgress
    insight?: WorkspaceTaskProgress
  }
  history: {
    analysis: SubmissionTaskResult[]
    insight: SubmissionTaskResult[]
  }
  dispatch?: WorkspaceOutboxDispatch
  outboxPending?: boolean
  dispatchError?: { operation: 'analysis' | 'insight'; code: string; message: string }
}

export interface WorkspaceStageGroup {
  stage: ResearchStage
  stageLabel: string
  skippedEmpty: boolean
  reports: WorkspaceReportCard[]
  latestInStageReportId?: string
  currentCompletionReportId?: string
  canSubmitUpdate: boolean
  canSubmitCompletion: boolean
}

export interface WorkspaceWorkflow {
  planRevision: number
  workflowRevision: number
  nextSubmissionSequence: number
  completedAt?: string
  currentStageId?: string
}

export interface WorkspaceCurrentStage {
  id: string
  ordinal: number
  title: string
  lifecycleStatus: StageLifecycleStatus
}

export interface WorkspaceProjectListItem {
  id: string
  ownerId: string
  title: string
  objective: string
  description: string
  ownerName: string
  collaboratorNames?: string
  memberRole?: ProjectMemberRole
  canManage: boolean
  canDelete: false
  canSubmit: boolean
  canEditPlan: boolean
  createdAt: string
  updatedAt: string
  currentStage?: WorkspaceCurrentStage
  submittedReportCount: number
  completedStageCount: number
  latestSubmission?: WorkspaceReportCard
}

export interface WorkspaceSelection {
  stageId: string
  reportId?: string
  source: WorkspaceSelectionSource
}

export interface WorkspaceProjectDetail {
  project: WorkspaceProjectListItem
  workflow: WorkspaceWorkflow
  stages: WorkspaceStageGroup[]
  latestSubmission?: WorkspaceReportCard
  currentCompletionByStage: Record<string, string>
  selected: WorkspaceSelection
  selectedReport?: WorkspaceReportDetail
}

export interface WorkspacePage<T> {
  total: number
  limit: number
  offset: number
  hasMore: boolean
  items: T[]
}

export interface WorkspaceProjectListResponse extends Omit<WorkspacePage<WorkspaceProjectListItem>, 'items'> {
  projects: WorkspaceProjectListItem[]
}

export interface WorkspaceReportListResponse extends Omit<WorkspacePage<WorkspaceReportCard>, 'items'> {
  reports: WorkspaceReportCard[]
}

export interface WorkspaceHistoryResponse {
  currentStageId?: string
  latestSubmissionReportId?: string
  currentCompletionByStage: Record<string, string>
  groups: WorkspaceStageGroup[]
  timeline: WorkspaceReportCard[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface WorkspaceStagesResponse {
  workflow: WorkspaceWorkflow
  stages: WorkspaceStageGroup[]
  latestSubmissionReportId?: string
  currentCompletionByStage: Record<string, string>
}

export interface WorkspaceUploadStatus {
  id: string
  projectId: string
  status: ReportUploadStatus
  fileName: string
  createdAt: string
  expiresAt: string
  reportId?: string
  errorCode?: string
  preview?: { title: string; paragraphCount: number; characterCount: number }
}

export interface WorkspaceConfirmResponse {
  receipt: ReportSubmissionReceipt
  replayed: boolean
}

export interface WorkspaceTaskResponse {
  job: SubmissionTask
}

export interface WorkspaceKnowledgeCard {
  id: string
  title: string
  fileName: string
  fileSize: number
  category: string
  description: string
  tags: string[]
  uploadedBy: string
  canDelete: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkspaceOverviewStats {
  submittedReportCount: number
  totalCharacters: number
  knowledgeCount: number
  knowledgeCategoryCount: number
  weeklyNewReports: number
  weeklyNewKnowledge: number
  completedStageCount: number
  jobStats: { completed: number; failed: number; cancelled: number; running: number; queued: number }
  trends: {
    submissions: number[]
    characters: number[]
    successRate: number[]
    knowledge: number[]
    averageScore: number[]
    analyzedProjects: number[]
  }
}

export interface WorkspaceOverview {
  stats: WorkspaceOverviewStats
  recentReports: WorkspaceReportCard[]
  activityReports: WorkspaceReportCard[]
  recentKnowledge: WorkspaceKnowledgeCard[]
}

export interface WorkspaceNotificationList {
  notifications: NotificationItem[]
  total: number
  unreadCount: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface WorkspaceErrorBody {
  error: string
  code: string
}

export const WorkspaceProjectSafeEditSchema = Type.Object({
  expectedUpdatedAt: Type.String({ minLength: 1, maxLength: 40 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: PROJECT_FIELD_LIMITS.title })),
  objective: Type.Optional(Type.String({ minLength: 1, maxLength: PROJECT_FIELD_LIMITS.objective })),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: PROJECT_FIELD_LIMITS.description })),
}, { additionalProperties: false })

export type WorkspaceProjectSafeEdit = Static<typeof WorkspaceProjectSafeEditSchema>

export function isWorkspaceProjectSafeEdit(value: unknown): value is WorkspaceProjectSafeEdit {
  return Value.Check(WorkspaceProjectSafeEditSchema, value) && Number.isFinite(Date.parse(value.expectedUpdatedAt))
}

export const WORKSPACE_RETIRED_PROJECT_FIELDS = [
  'milestones',
  'ownerId',
  'collaboratorIds',
  'progress',
  'stage',
  'status',
  'reportIds',
] as const

export const WorkspaceReportDeleteSchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false })

export type WorkspaceReportDelete = Static<typeof WorkspaceReportDeleteSchema>

export function isWorkspaceReportDelete(value: unknown): value is WorkspaceReportDelete {
  return Value.Check(WorkspaceReportDeleteSchema, value)
}
