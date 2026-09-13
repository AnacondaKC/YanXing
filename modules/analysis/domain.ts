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
  aiCallsStarted?: number
  aiCallsCompleted?: number
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export interface AnalysisModelCall {
  provider: string
  model: string
  stage: 'page_analysis'
  module: 'page_analysis'
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