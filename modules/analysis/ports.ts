import type { AnalysisJob, AnalysisModelCall } from '@/modules/analysis/domain'
import type { AiCallDetails } from '@/lib/ai/usage'
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
import type { ReportSource, ReportVersion } from '@/modules/reports/domain'

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
  details: AiCallDetails & Required<Pick<AiCallDetails, 'provider' | 'model' | 'stage' | 'module' | 'tokens'>>
  artifact: AnalysisArtifactRecord
  state?: AnalysisModuleState
  snapshot?: AnalysisSnapshotWrite
}

export interface AnalysisPipelineRepository {
  getJob(jobId: string): AnalysisJob | undefined
  getPromptSettings(jobId: string): AnalysisPromptConfig[] | undefined
  getReport(reportVersionId: string): ReportVersion | undefined
  getReportFacts(reportVersionId: string): ReportFacts
  getReportSource(reportVersionId: string): ReportSource | undefined
  getJobEvaluationContext(jobId: string): ReportEvaluationContext
  getJobModelRuntime(jobId: string): AiModelRuntimeSnapshot
  saveAiReportFacts(reportVersionId: string, facts: ReportFacts): ReportVersion | undefined
  markReportParsingFailed(reportVersionId: string, message: string): ReportVersion | undefined
  getCurrentSnapshot(reportVersionId: string): { id: string; payload: AnalysisSnapshotPayload } | undefined
  getLatestPartialSnapshotForJob(jobId: string): import('@/modules/analysis/domain').AnalysisSnapshot | undefined
  listAcceptedArtifacts(jobId: string): AnalysisArtifactRecord[]
  listArtifacts(jobId: string): AnalysisArtifactRecord[]
  listModuleStates(jobId: string): AnalysisModuleState[]
  saveModuleState(jobId: string, state: AnalysisModuleState): void
  saveArtifact(jobId: string, artifact: AnalysisArtifactRecord): void
  saveFailedAttempt(jobId: string, artifact: AnalysisArtifactRecord, state: AnalysisModuleState): void
  markAiCallStarted(jobId: string, details: Omit<AiCallDetails, 'tokens'>): void
  checkpointAiCall(input: AnalysisCallCheckpoint): void
  settleCancelledAiCall(input: AnalysisCallCheckpoint): void
  publishFinalSnapshot(snapshot: AnalysisSnapshotWrite, finalization: AnalysisFinalization): void
  updateJob(jobId: string, input: { status?: AnalysisJob['status']; stage?: AnalysisStage; stageIndex?: number; errorMessage?: string }): AnalysisJob | undefined
  failJob(jobId: string, message: string): AnalysisJob | undefined
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