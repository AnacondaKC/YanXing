import {
  failAnalysisJob,
  getCurrentSnapshot,
  getLatestPartialSnapshotForJob,
  getAnalysisJobPromptSettings,
  getJob,
  getReport,
  getJobEvaluationContext,
  getJobModelRuntime,
  getReportFacts,
  getReportSource,
  markReportParsingFailed,
  saveAiReportFacts,
  listAcceptedArtifacts,
  isJobCancellationRequested,
  listArtifacts,
  listModuleStates,
  markAnalysisAiCallStarted,
  checkpointAnalysisAiCall,
  settleCancelledAnalysisAiCall,
  publishAnalysisEvent,
  publishFinalAnalysis,
  saveArtifact,
  saveFailedAttempt,
  saveModuleState,
  updateAnalysisJob,
} from '@/lib/db/repository'
import { AnalysisLeaseLostError, type AnalysisPipelineRepository, type AnalysisEventPublisher } from '@/modules/analysis/ports'

export function createAnalysisRepository(leaseOwner?: string): AnalysisPipelineRepository {
  return {
    getJob,
    getPromptSettings: getAnalysisJobPromptSettings,
    getReport,
    getReportFacts,
    getReportSource,
    getJobEvaluationContext,
    getJobModelRuntime,
    saveAiReportFacts: (reportVersionId, facts) => saveAiReportFacts(reportVersionId, facts, leaseOwner),
    markReportParsingFailed: (reportVersionId, message) => markReportParsingFailed(reportVersionId, message, leaseOwner),
    getCurrentSnapshot,
    getLatestPartialSnapshotForJob,
    listAcceptedArtifacts,
    listArtifacts,
    listModuleStates,
    saveModuleState: (jobId, state) => saveModuleState(jobId, state, leaseOwner),
    saveArtifact: (jobId, artifact) => saveArtifact(jobId, artifact, leaseOwner),
    saveFailedAttempt: (jobId, artifact, state) => saveFailedAttempt(jobId, artifact, state, leaseOwner),
    markAiCallStarted: (jobId, details) => markAnalysisAiCallStarted(jobId, details, leaseOwner),
    checkpointAiCall: (input) => checkpointAnalysisAiCall({
      ...input,
      snapshot: input.snapshot && leaseOwner !== undefined
        ? { ...input.snapshot, leaseOwner: input.snapshot.leaseOwner ?? leaseOwner }
        : input.snapshot,
    }, leaseOwner),
    settleCancelledAiCall: (input) => settleCancelledAnalysisAiCall({
      ...input,
      snapshot: undefined,
      state: undefined,
    }),
    publishFinalSnapshot: (snapshot, finalization) => publishFinalAnalysis(leaseOwner === undefined ? snapshot : { ...snapshot, leaseOwner }, finalization),
    updateJob: (jobId, input) => updateAnalysisJob(jobId, input, leaseOwner),
    failJob: (jobId, message) => failAnalysisJob(jobId, message, leaseOwner),
    isCancellationRequested: (jobId) => isJobCancellationRequested(jobId, leaseOwner),
  }
}

export function createAnalysisEventPublisher(leaseOwner?: string): AnalysisEventPublisher {
  return {
    publish: (input) => {
      const { jobId, ...event } = input
      try {
        const published = publishAnalysisEvent(jobId, event, leaseOwner)
        if (!published && leaseOwner !== undefined) throw new AnalysisLeaseLostError()
      } catch (error) {
        if (error instanceof AnalysisLeaseLostError) throw error
        // 事件是通知，不得回滚已经提交的业务状态；客户端会通过权威 GET 收敛。
      }
    },
  }
}