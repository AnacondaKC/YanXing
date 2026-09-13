import type { AnalysisSnapshot } from '@/modules/analysis/domain'
import type {
  AnalysisCallCheckpoint,
  AnalysisFinalization,
  AnalysisSnapshotWrite,
} from '@/modules/analysis/ports'
import type { AiCallDetails } from '@/lib/ai/call-details'
import type {
  AnalysisArtifactRecord,
  AnalysisModuleState,
  AnalysisStage,
  ReportFacts,
} from '@/modules/contracts/analysis'
import type { ReportInsightOutput } from '@/modules/insights/domain'
import type { ReportSource } from '@/modules/reports/domain'
import type { ReportSubmission } from '@/modules/reports/submission-domain'
import {
  SubmissionTaskError,
  type SubmissionTask,
  type SubmissionTaskClaim,
  type SubmissionTaskResult,
  type SubmissionTaskSnapshot,
} from '@/modules/reports/submission-task-domain'

export interface TaskDataWrite {
  key: string
  value: unknown
}

export interface TaskCallReceipt {
  attempt: number
  provider: string
  model: string
  data?: TaskDataWrite[]
}

export interface SubmissionPreparedDocument {
  text: string
  paragraphCount: number
  characterCount: number
}

export interface SubmissionProviderCallIntent {
  attempt: number
  stage: string
  module: string
  provider?: string
  model?: string
}

export interface SubmissionProviderCallLedger {
  started: number
  completed: number
  openIntent?: SubmissionProviderCallIntent
}

export const SUBMISSION_TASK_DATA_KEYS = {
  facts: 'facts',
  moduleState: (moduleId: string) => 'module_state:' + moduleId,
  artifact: (moduleId: string, attempt: number) => 'artifact:' + moduleId + ':' + String(attempt),
  partialSnapshot: 'snapshot:partial',
  insight: 'insight',
} as const

export const SUBMISSION_TASK_DATA_PREFIX = {
  artifact: 'artifact:',
  moduleState: 'module_state:',
} as const

export interface SubmissionAnalysisPublication {
  snapshot: AnalysisSnapshotWrite
  finalization: AnalysisFinalization
}

export interface SubmissionInsightPublication {
  insight: ReportInsightOutput
  modelCall: {
    provider: string
    model: string
  }
}

export class IncompleteProviderCallError extends SubmissionTaskError {
  constructor(
    readonly jobId: string,
    readonly openIntent: SubmissionProviderCallIntent,
  ) {
    super('AI_CALL_INCOMPLETE', '当前任务有尚未完成的模型调用，已停止本次执行；可重新发起任务。')
    this.name = 'IncompleteProviderCallError'
  }
}

/**
 * Native worker store surface. Matches SubmissionTaskRepository methods the
 * executor may call. Parent DB class can be passed structurally.
 */
export interface SubmissionTaskStore {
  getTask(jobId: string): SubmissionTask | undefined
  getFrozen(jobId: string): SubmissionTaskSnapshot
  getReport(reportId: string): ReportSubmission | undefined
  getSource(reportId: string): ReportSource | undefined
  getDocumentText(reportId: string): SubmissionPreparedDocument
  callLedger(jobId: string): SubmissionProviderCallLedger
  readData(jobId: string, key: string): unknown
  listData(jobId: string, prefix: string): unknown[]
  saveData(claim: SubmissionTaskClaim, data: TaskDataWrite[]): void
  beginCall(claim: SubmissionTaskClaim, input: { attempt: number; provider: string; model: string }): void
  checkpoint(claim: SubmissionTaskClaim, receipt: TaskCallReceipt): void
  settleLateCall(claim: SubmissionTaskClaim, receipt: TaskCallReceipt): void
  progress(claim: SubmissionTaskClaim, input: { stage: AnalysisStage; stageIndex: number }): SubmissionTask
  complete(claim: SubmissionTaskClaim, payload: unknown): SubmissionTaskResult
  fail(claim: SubmissionTaskClaim, code?: string): void
  cancelled(claim: SubmissionTaskClaim): boolean
  recordProgress?(claim: SubmissionTaskClaim, kind: string): void
}

/**
 * Claim-bound execution port. Bridge may close over claim and implement this
 * instead of exposing the raw store. Executor accepts the store and adapts.
 */
export interface SubmissionTaskPort {
  getTask(taskId: string): SubmissionTask | undefined
  getFrozenSnapshots(taskId: string): SubmissionTaskSnapshot
  getReport(reportId: string): ReportSubmission | undefined
  getReportSource(reportId: string): ReportSource | undefined
  getDocumentText(reportId: string): SubmissionPreparedDocument
  getReportFacts(reportId: string): ReportFacts
  saveReportFacts(reportId: string, facts: ReportFacts): boolean
  isReportPublishable(reportId: string): boolean
  getProviderCallLedger(taskId: string): SubmissionProviderCallLedger
  getLatestPartialSnapshot(taskId: string): AnalysisSnapshot | undefined
  listAcceptedArtifacts(taskId: string): AnalysisArtifactRecord[]
  listArtifacts(taskId: string): AnalysisArtifactRecord[]
  listModuleStates(taskId: string): AnalysisModuleState[]
  saveModuleState(taskId: string, state: AnalysisModuleState): void
  saveArtifact(taskId: string, artifact: AnalysisArtifactRecord): void
  saveFailedAttempt(taskId: string, artifact: AnalysisArtifactRecord, state: AnalysisModuleState): void
  markAiCallStarted(taskId: string, details: AiCallDetails): void
  checkpointAiCall(input: AnalysisCallCheckpoint): void
  settleCancelledAiCall(input: AnalysisCallCheckpoint): void
  updateTask(taskId: string, input: { stage?: AnalysisStage; stageIndex?: number }): SubmissionTask | undefined
  failTask(taskId: string, code: string): SubmissionTask | undefined
  isCancellationRequested(taskId: string): boolean
  publishAnalysis(input: SubmissionAnalysisPublication): SubmissionTaskResult
  publishInsight(input: SubmissionInsightPublication): SubmissionTaskResult
  verifySource(file: { sourceKey: string; fileHash: string; sourceSize: number }): Promise<void>
}
