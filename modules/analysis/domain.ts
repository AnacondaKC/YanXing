import type {
  AnalysisArtifactRecord,
  AnalysisJobStatus,
  AnalysisModuleState,
  AnalysisStage,
  AnalysisSnapshotPayload,
} from '@/modules/contracts/analysis'

export interface AnalysisJob {
  id: string
  reportVersionId: string
  type: 'initial' | 'rerun' | 'insight'
  status: AnalysisJobStatus
  stage: AnalysisStage
  stageIndex: number
  attempts: number
  cancelRequested: boolean
  requestedByUserId?: string
  availableAt?: string
  priority?: number
  admissionId?: string
  lastClaimedAt?: string
  lastRetryAt?: string
  lastRetryReason?: string
  lastWorkerId?: string
  lastErrorCode?: string
  lastErrorAt?: string
  terminalReason?: string
  terminalAt?: string
  aiCallsStarted?: number
  aiCallsCompleted?: number
  aiTokens?: number
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export interface AnalysisModelCall {
  provider: string
  model: string
  stage: 'page_analysis'
  module: 'page_analysis'
  tokens: number
}

export interface AnalysisSnapshot {
  id: string
  reportVersionId: string
  schemaVersion: number
  promptVersion: string
  pipelineVersion: string
  modelCalls: AnalysisModelCall[]
  artifacts?: AnalysisArtifactRecord[]
  moduleStates?: AnalysisModuleState[]
  payload: AnalysisSnapshotPayload
  createdAt: string
}