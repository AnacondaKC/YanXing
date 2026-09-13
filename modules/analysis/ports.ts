import type { AnalysisJob, AnalysisModelCall } from '@/modules/analysis/domain'
import type { AiCallDetails } from '@/lib/ai/call-details'
import type {
  AnalysisArtifactRecord,
  AnalysisJobEventType,
  AnalysisModuleState,
  AnalysisSnapshotPayload,
  AnalysisStage,
} from '@/modules/contracts/analysis'

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

export interface AnalysisEventPublisher {
  publish(type: AnalysisJobEventType): void
}
