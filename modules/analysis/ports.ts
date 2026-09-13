import type { AnalysisJob, AnalysisModelCall, AnalysisSnapshot } from '@/modules/analysis/domain'
import type { AiCallDetails } from '@/lib/ai/call-details'
import type { AiModelRuntimeSnapshot } from '@/lib/db/settings-repository'
import type {
  AnalysisArtifactRecord,
  AnalysisJobEventType,
  AnalysisModuleState,
  AnalysisPromptConfig,
  AnalysisSnapshotPayload,
  AnalysisStage,
  AnalysisTrackedModuleId,
  GateError,
  ReportEvaluationContext,
  ReportFacts,
} from '@/modules/contracts/analysis'
import type { ReportSource } from '@/modules/reports/domain'

export interface AnalysisSnapshotWrite {
  id: string
  jobId: string
  kind: 'partial' | 'final'
  reportVersionId: string
  payload: AnalysisSnapshotPayload
  artifacts: AnalysisArtifactRecord[]
  moduleStates: AnalysisModuleState[]
  modelCalls: AnalysisModelCall[]
  schemaVersion: number
  promptVersion: string
  pipelineVersion: string
  createdAt: string
  leaseOwner?: string
}

export interface AnalysisFinalization {
  status: Extract<AnalysisJob['status'], 'completed' | 'failed'>
  stage: AnalysisStage
  stageIndex: number
  errorMessage?: string
  publishAsCurrent: boolean
}

export class AnalysisLeaseLostError extends Error {
  constructor() {
    super('任务租约已失效。')
    this.name = 'AnalysisLeaseLostError'
  }
}

export interface AnalysisCallCheckpoint {
  jobId: string
  details: AiCallDetails & Required<Pick<AiCallDetails, 'provider' | 'model' | 'stage' | 'module'>>
  artifact: AnalysisArtifactRecord
  state?: AnalysisModuleState
  snapshot?: AnalysisSnapshotWrite
}

export interface AnalysisPreparedDocument {
  text: string
  paragraphCount: number
  characterCount: number
}

export type AnalysisExecutionJob = Pick<AnalysisJob, 'id' | 'status' | 'cancelRequested' | 'aiCallsCompleted'>

export interface AnalysisExecutionRepository {
  getJob(jobId: string): AnalysisExecutionJob | undefined
  getPromptSettings(jobId: string): AnalysisPromptConfig[] | undefined
  getReportFacts(reportId: string): ReportFacts
  getReportSource(reportId: string): ReportSource | undefined
  getJobEvaluationContext(jobId: string): ReportEvaluationContext
  getJobModelRuntime(jobId: string): AiModelRuntimeSnapshot
  saveReportFacts(reportId: string, facts: ReportFacts): boolean
  getDocumentText?(reportId: string): AnalysisPreparedDocument | undefined
  getLatestPartialSnapshotForJob(jobId: string): AnalysisSnapshot | undefined
  listAcceptedArtifacts(jobId: string): AnalysisArtifactRecord[]
  listArtifacts(jobId: string): AnalysisArtifactRecord[]
  listModuleStates(jobId: string): AnalysisModuleState[]
  saveModuleState(jobId: string, state: AnalysisModuleState): void
  saveArtifact(jobId: string, artifact: AnalysisArtifactRecord): void
  saveFailedAttempt(jobId: string, artifact: AnalysisArtifactRecord, state: AnalysisModuleState): void
  markAiCallStarted(jobId: string, details: AiCallDetails): void
  checkpointAiCall(input: AnalysisCallCheckpoint): void
  settleCancelledAiCall(input: AnalysisCallCheckpoint): void
  publishFinalSnapshot(snapshot: AnalysisSnapshotWrite, finalization: AnalysisFinalization): void
  updateJob(jobId: string, input: { status?: AnalysisJob['status']; stage?: AnalysisStage; stageIndex?: number; errorMessage?: string }): AnalysisExecutionJob | undefined
  isCancellationRequested(jobId: string): boolean
}

export interface AnalysisEventPublisher {
  publish(input: {
    jobId: string
    type: AnalysisJobEventType
    stage?: AnalysisStage
    moduleId?: AnalysisTrackedModuleId
    message: string
    errors?: GateError[]
  }): void
}