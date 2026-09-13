import type { AnalysisPromptConfig, ReportEvaluationContext, AnalysisStage } from '@/modules/contracts/analysis'
import type { AiModelRuntimeSnapshot } from '@/lib/db/settings-repository'
import type { ReportOperation } from '@/modules/reports/submission-domain'

export interface SubmissionTaskSnapshot {
  prompts: AnalysisPromptConfig[]
  modelRuntime: AiModelRuntimeSnapshot
  evaluationContext: ReportEvaluationContext
}
export interface SubmissionTask {
  id: string
  reportId: string
  projectId: string
  actorId: string
  operation: ReportOperation
  generation: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  stage: AnalysisStage
  stageIndex: number
  attempts: number
  cancelRequested: boolean
  createdAt: string
  updatedAt: string
  errorCode?: string
}
export interface SubmissionTaskClaim { jobId: string; leaseToken: string }
export interface SubmissionTaskResult {
  id: string
  jobId: string
  reportId: string
  operation: ReportOperation
  generation: number
  payload: unknown
  createdAt: string
}
export class SubmissionTaskError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message)
    this.name = 'SubmissionTaskError'
  }
}
