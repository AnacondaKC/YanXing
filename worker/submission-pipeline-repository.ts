import { createReportInsightOutput } from '@/lib/ai/report-insight-agent'
import { createPreparedReportFiles } from '@/lib/documents/prepared-report-files'
import type { AnalysisSnapshot } from '@/modules/analysis/domain'
import { validateModuleOutput, validatePageAnalysisOutput } from '@/modules/analysis/gates'
import { pageAnalysisModule } from '@/modules/analysis/modules'
import type {
  AnalysisCallCheckpoint,
  AnalysisEventPublisher,
  AnalysisSnapshotWrite,
} from '@/modules/analysis/ports'
import { AnalysisStages, type AnalysisArtifactRecord, type AnalysisModuleState, type AnalysisStage } from '@/modules/contracts/analysis'
import { SubmissionTaskError, type SubmissionTask, type SubmissionTaskClaim } from '@/modules/reports/submission-task-domain'
import {
  SUBMISSION_TASK_DATA_KEYS,
  SUBMISSION_TASK_DATA_PREFIX,
  IncompleteProviderCallError,
  type SubmissionAnalysisPublication,
  type SubmissionInsightPublication,
  type SubmissionTaskPort,
  type SubmissionTaskStore,
  type TaskCallReceipt,
  type TaskDataWrite,
} from '@/modules/reports/submission-task-ports'

export function createSubmissionTaskPort(input: {
  tasks: SubmissionTaskStore
  claim: SubmissionTaskClaim
  verifySource?: (file: { sourceKey: string; fileHash: string; sourceSize: number }) => Promise<void>
}): { port: SubmissionTaskPort; publisher: AnalysisEventPublisher } {
  const { tasks, claim } = input
  const jobId = claim.jobId

  const port: SubmissionTaskPort = {
    getTask: (taskId) => {
      assertBoundTaskId(claim, taskId)
      return tasks.getTask(jobId)
    },
    getFrozenSnapshots: (taskId) => {
      requireBoundTask(tasks, claim, taskId)
      return tasks.getFrozen(jobId)
    },
    getReport: (reportId) => {
      requireBoundReport(tasks, claim, reportId)
      return tasks.getReport(reportId)
    },
    getReportSource: (reportId) => {
      requireBoundReport(tasks, claim, reportId)
      return tasks.getSource(reportId)
    },
    getDocumentText: (reportId) => {
      requireBoundReport(tasks, claim, reportId)
      return tasks.getDocumentText(reportId)
    },
    getReportFacts: (reportId) => {
      requireBoundReport(tasks, claim, reportId)
      return readReportFacts(tasks, jobId, reportId)
    },
    saveReportFacts: (reportId, facts) => {
      requireBoundReport(tasks, claim, reportId)
      try {
        tasks.saveData(claim, [{ key: SUBMISSION_TASK_DATA_KEYS.facts, value: facts }])
        return Boolean(tasks.getReport(reportId))
      } catch (error) {
        if (isLeaseLost(error)) return false
        throw error
      }
    },
    isReportPublishable: (reportId) => {
      requireBoundReport(tasks, claim, reportId)
      const report = tasks.getReport(reportId)
      return Boolean(report && !report.deletedAt)
    },
    getProviderCallLedger: (taskId) => {
      requireBoundTask(tasks, claim, taskId)
      return tasks.callLedger(jobId)
    },
    getLatestPartialSnapshot: (taskId) => {
      requireBoundTask(tasks, claim, taskId)
      return toAnalysisSnapshot(tasks.readData(jobId, SUBMISSION_TASK_DATA_KEYS.partialSnapshot))
    },
    listAcceptedArtifacts: (taskId) => {
      requireBoundTask(tasks, claim, taskId)
      return listArtifacts(tasks, jobId).filter((artifact) => artifact.status === 'accepted')
    },
    listArtifacts: (taskId) => {
      requireBoundTask(tasks, claim, taskId)
      return listArtifacts(tasks, jobId)
    },
    listModuleStates: (taskId) => {
      requireBoundTask(tasks, claim, taskId)
      return listModuleStates(tasks, jobId)
    },
    saveModuleState: (taskId, state) => {
      requireBoundTask(tasks, claim, taskId)
      tasks.saveData(claim, [{ key: SUBMISSION_TASK_DATA_KEYS.moduleState(state.moduleId), value: state }])
    },
    saveArtifact: (taskId, artifact) => {
      const task = requireBoundTask(tasks, claim, taskId)
      assertArtifactIdentity(artifact, task)
      tasks.saveData(claim, [{ key: SUBMISSION_TASK_DATA_KEYS.artifact(artifact.moduleId, artifact.attempt), value: artifact }])
    },
    saveFailedAttempt: (taskId, artifact, state) => {
      const task = requireBoundTask(tasks, claim, taskId)
      assertArtifactIdentity(artifact, task)
      tasks.saveData(claim, [
        { key: SUBMISSION_TASK_DATA_KEYS.artifact(artifact.moduleId, artifact.attempt), value: artifact },
        { key: SUBMISSION_TASK_DATA_KEYS.moduleState(state.moduleId), value: state },
      ])
    },
    markAiCallStarted: (taskId, details) => {
      requireBoundTask(tasks, claim, taskId)
      const attempt = details.attempt ?? 1
      const provider = details.provider
      const model = details.model
      if (!provider || !model) throw new SubmissionTaskError('INVALID_CALL_INTENT', '模型调用意图缺少 provider 或 model。')
      if (!Number.isSafeInteger(attempt) || attempt < 1) throw new SubmissionTaskError('INVALID_CALL_INTENT', '模型调用 attempt 无效。')
      try {
        tasks.beginCall(claim, { attempt, provider, model })
      } catch (error) {
        const ledger = tasks.callLedger(jobId)
        if (error instanceof SubmissionTaskError && error.code === 'AI_CALL_INCOMPLETE' && ledger.openIntent) {
          throw new IncompleteProviderCallError(jobId, ledger.openIntent)
        }
        throw error
      }
    },
    checkpointAiCall: (checkpoint) => persistCallReceipt(tasks, claim, checkpoint, false),
    settleCancelledAiCall: (checkpoint) => persistCallReceipt(tasks, claim, checkpoint, true),
    updateTask: (taskId, update) => {
      try {
        const current = requireBoundTask(tasks, claim, taskId)
        const stage = update.stage ?? coerceStage(current.stage)
        const stageIndex = update.stageIndex ?? current.stageIndex
        return tasks.progress(claim, { stage, stageIndex })
      } catch (error) {
        if (isLeaseLost(error)) return undefined
        throw error
      }
    },
    failTask: (taskId, code) => {
      const task = requireBoundTask(tasks, claim, taskId)
      if (task.cancelRequested) return task
      try {
        tasks.fail(claim, code)
        return tasks.getTask(jobId)
      } catch (error) {
        if (isLeaseLost(error)) return undefined
        throw error
      }
    },
    isCancellationRequested: (taskId) => {
      assertBoundTaskId(claim, taskId)
      return Boolean(tasks.getTask(jobId)?.cancelRequested)
    },
    publishAnalysis: (publication) => publishBoundAnalysis(tasks, claim, publication),
    publishInsight: (publication) => publishBoundInsight(tasks, claim, publication),
    verifySource: async (file) => {
      requireBoundTask(tasks, claim, jobId)
      if (input.verifySource) {
        await input.verifySource(file)
        return
      }
      await verifyPreparedSource(tasks, jobId, file)
    },
  }

  const publisher: AnalysisEventPublisher = {
    publish: (type) => {
      try {
        tasks.recordProgress?.(claim, type)
      } catch (error) {
        if (!isLeaseLost(error)) throw error
      }
    },
  }

  return { port, publisher }
}

function publishBoundAnalysis(tasks: SubmissionTaskStore, claim: SubmissionTaskClaim, publication: SubmissionAnalysisPublication) {
  const task = requireBoundTask(tasks, claim, claim.jobId)
  if (task.cancelRequested) throw new Error('Analysis cancelled')
  if (publication.finalization.status !== 'completed' || !publication.finalization.publishAsCurrent) {
    throw new SubmissionTaskError('QUALITY_GATE_FAILED', '分析未通过质量门禁，拒绝发布。')
  }
  assertSnapshotIdentity(publication.snapshot, task)
  assertAcceptedPageAnalysis(publication.snapshot, task)
  return tasks.complete(claim, { kind: 'analysis', snapshot: publication.snapshot })
}

function publishBoundInsight(tasks: SubmissionTaskStore, claim: SubmissionTaskClaim, publication: SubmissionInsightPublication) {
  const task = requireBoundTask(tasks, claim, claim.jobId)
  if (task.cancelRequested) throw new Error('Analysis cancelled')
  if (!publication.modelCall.provider || !publication.modelCall.model) {
    throw new SubmissionTaskError('INVALID_CALL_INTENT', '洞察发布缺少 provider 或 model。')
  }
  const insight = createReportInsightOutput(publication.insight.html)
  return tasks.complete(claim, {
    kind: 'insight',
    insight,
    provider: publication.modelCall.provider,
    model: publication.modelCall.model,
  })
}

function persistCallReceipt(
  tasks: SubmissionTaskStore,
  claim: SubmissionTaskClaim,
  checkpoint: AnalysisCallCheckpoint,
  forceSettle: boolean,
) {
  const task = requireBoundTask(tasks, claim, checkpoint.jobId)
  assertCheckpointIdentity(checkpoint, task)
  const attempt = checkpoint.details.attempt ?? 1
  const receipt: TaskCallReceipt = {
    attempt,
    provider: checkpoint.details.provider,
    model: checkpoint.details.model,
  }
  const cancelRequested = Boolean(task.cancelRequested)
  if (forceSettle || cancelRequested) {
    tasks.settleLateCall(claim, receipt)
    return
  }
  try {
    tasks.checkpoint(claim, {
      ...receipt,
      data: checkpointData(checkpoint),
    })
  } catch (error) {
    if (isLeaseLost(error)) {
      tasks.settleLateCall(claim, receipt)
      throw error
    }
    throw error
  }
}

function checkpointData(checkpoint: AnalysisCallCheckpoint): TaskDataWrite[] {
  const data: TaskDataWrite[] = [
    {
      key: SUBMISSION_TASK_DATA_KEYS.artifact(checkpoint.artifact.moduleId, checkpoint.artifact.attempt),
      value: checkpoint.artifact,
    },
  ]
  if (checkpoint.state) {
    data.push({ key: SUBMISSION_TASK_DATA_KEYS.moduleState(checkpoint.state.moduleId), value: checkpoint.state })
  }
  if (checkpoint.snapshot) {
    data.push({ key: SUBMISSION_TASK_DATA_KEYS.partialSnapshot, value: checkpoint.snapshot })
  }
  if (checkpoint.artifact.moduleId === 'report_insight' && checkpoint.artifact.status === 'accepted') {
    data.push({ key: SUBMISSION_TASK_DATA_KEYS.insight, value: checkpoint.artifact.payload })
  }
  return data
}

function readReportFacts(tasks: SubmissionTaskStore, jobId: string, reportId: string) {
  const overlay = tasks.readData(jobId, SUBMISSION_TASK_DATA_KEYS.facts)
  if (isReportFacts(overlay)) return overlay
  const report = tasks.getReport(reportId)
  if (!report) return { title: '', paragraphCount: 0, characterCount: 0 }
  return { title: report.title, paragraphCount: report.paragraphCount, characterCount: report.characterCount }
}

function listArtifacts(tasks: SubmissionTaskStore, jobId: string): AnalysisArtifactRecord[] {
  return tasks.listData(jobId, SUBMISSION_TASK_DATA_PREFIX.artifact).flatMap((value) => {
    const artifact = asArtifact(value)
    return artifact ? [artifact] : []
  })
}

function listModuleStates(tasks: SubmissionTaskStore, jobId: string): AnalysisModuleState[] {
  return tasks.listData(jobId, SUBMISSION_TASK_DATA_PREFIX.moduleState).flatMap((value) => {
    const state = asModuleState(value)
    return state ? [state] : []
  })
}

function toAnalysisSnapshot(value: unknown): AnalysisSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const snapshot = value as AnalysisSnapshotWrite
  if (typeof snapshot.id !== 'string' || typeof snapshot.jobId !== 'string') return undefined
  return {
    id: snapshot.id,
    reportVersionId: snapshot.reportVersionId,
    schemaVersion: snapshot.schemaVersion,
    promptVersion: snapshot.promptVersion,
    pipelineVersion: snapshot.pipelineVersion,
    modelCalls: snapshot.modelCalls,
    artifacts: snapshot.artifacts,
    moduleStates: snapshot.moduleStates,
    payload: snapshot.payload,
    createdAt: snapshot.createdAt,
  }
}

function asArtifact(value: unknown): AnalysisArtifactRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const artifact = value as AnalysisArtifactRecord
  if (typeof artifact.id !== 'string' || typeof artifact.jobId !== 'string' || typeof artifact.moduleId !== 'string') return undefined
  return artifact
}

function asModuleState(value: unknown): AnalysisModuleState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const state = value as AnalysisModuleState
  if (typeof state.moduleId !== 'string' || typeof state.status !== 'string') return undefined
  return state
}

function isReportFacts(value: unknown): value is { title: string; paragraphCount: number; characterCount: number } {
  if (!value || typeof value !== 'object') return false
  const facts = value as { title?: unknown; paragraphCount?: unknown; characterCount?: unknown }
  return typeof facts.title === 'string' && Number.isFinite(facts.paragraphCount) && Number.isFinite(facts.characterCount)
}

function coerceStage(stage: string): AnalysisStage {
  return (AnalysisStages as readonly string[]).includes(stage) ? stage as AnalysisStage : 'validating'
}

function isLeaseLost(error: unknown) {
  return error instanceof SubmissionTaskError && error.code === 'TASK_LEASE_LOST'
}

function assertBoundTaskId(claim: SubmissionTaskClaim, taskId: string) {
  if (taskId !== claim.jobId) throw new SubmissionTaskError('TASK_IDENTITY_MISMATCH', '任务标识与当前租约不一致。')
}

function requireBoundTask(tasks: SubmissionTaskStore, claim: SubmissionTaskClaim, taskId: string) {
  assertBoundTaskId(claim, taskId)
  const task = tasks.getTask(claim.jobId)
  if (!task) throw new SubmissionTaskError('TASK_NOT_FOUND', '任务不存在。', 404)
  if (task.id !== claim.jobId) throw new SubmissionTaskError('TASK_IDENTITY_MISMATCH', '任务标识与当前租约不一致。')
  return task
}

function requireBoundReport(tasks: SubmissionTaskStore, claim: SubmissionTaskClaim, reportId: string) {
  const task = requireBoundTask(tasks, claim, claim.jobId)
  if (reportId !== task.reportId) throw new SubmissionTaskError('TASK_IDENTITY_MISMATCH', '报告标识与当前任务不一致。')
  return task
}

function assertArtifactIdentity(artifact: AnalysisArtifactRecord, task: SubmissionTask) {
  if (artifact.jobId !== task.id || artifact.reportVersionId !== task.reportId) {
    throw new SubmissionTaskError('TASK_IDENTITY_MISMATCH', '产物标识与当前任务不一致。')
  }
}

function assertSnapshotIdentity(snapshot: AnalysisSnapshotWrite, task: SubmissionTask) {
  if (snapshot.jobId !== task.id || snapshot.reportVersionId !== task.reportId) {
    throw new SubmissionTaskError('TASK_IDENTITY_MISMATCH', '分析快照标识与当前任务不一致。')
  }
}

function assertAcceptedPageAnalysis(snapshot: AnalysisSnapshotWrite, task: SubmissionTask) {
  const accepted = snapshot.artifacts.filter((artifact) => artifact.moduleId === 'page_analysis' && artifact.status === 'accepted')
  if (accepted.length !== 1) {
    throw new SubmissionTaskError('QUALITY_GATE_FAILED', '分析未通过质量门禁，拒绝发布。')
  }
  const artifact = accepted[0]
  assertArtifactIdentity(artifact, task)
  if (artifact.schemaVersion !== pageAnalysisModule.schemaVersion) {
    throw new SubmissionTaskError('QUALITY_GATE_FAILED', '分析产物 schema 与当前模块不匹配。')
  }
  if (artifact.gateErrors.length > 0) {
    throw new SubmissionTaskError('QUALITY_GATE_FAILED', '分析未通过质量门禁，拒绝发布。')
  }
  const gate = validateModuleOutput({
    schema: pageAnalysisModule.schema,
    output: artifact.payload,
    extra: validatePageAnalysisOutput,
  })
  if (!gate.accepted) {
    throw new SubmissionTaskError('QUALITY_GATE_FAILED', '分析未通过质量门禁，拒绝发布。')
  }
}

function assertCheckpointIdentity(checkpoint: AnalysisCallCheckpoint, task: SubmissionTask) {
  const attempt = checkpoint.details.attempt ?? 1
  if (checkpoint.jobId !== task.id) {
    throw new SubmissionTaskError('TASK_IDENTITY_MISMATCH', '检查点任务标识与当前租约不一致。')
  }
  assertArtifactIdentity(checkpoint.artifact, task)
  if (!Number.isSafeInteger(attempt) || attempt < 1 || checkpoint.artifact.attempt !== attempt) {
    throw new SubmissionTaskError('INVALID_CALL_INTENT', '检查点 attempt 与产物不一致。')
  }
  if (checkpoint.details.module && checkpoint.artifact.moduleId !== checkpoint.details.module) {
    throw new SubmissionTaskError('INVALID_CALL_INTENT', '检查点 module 与产物不一致。')
  }
  if (!checkpoint.details.provider || !checkpoint.details.model) {
    throw new SubmissionTaskError('INVALID_CALL_INTENT', '检查点缺少 provider 或 model。')
  }
  if (checkpoint.artifact.provider !== checkpoint.details.provider || checkpoint.artifact.model !== checkpoint.details.model) {
    throw new SubmissionTaskError('INVALID_CALL_INTENT', '检查点模型身份与产物不一致。')
  }
}

async function verifyPreparedSource(
  tasks: SubmissionTaskStore,
  jobId: string,
  file: { sourceKey: string; fileHash: string; sourceSize: number },
) {
  const task = tasks.getTask(jobId)
  if (!task) throw new SubmissionTaskError('TASK_NOT_FOUND', '任务不存在。', 404)
  const report = tasks.getReport(task.reportId)
  const source = tasks.getSource(task.reportId)
  if (!report || !source) throw new SubmissionTaskError('REPORT_FILE_CHANGED', '报告原始文件不存在，无法提交给 AI。')
  if (report.sourceKey !== file.sourceKey || report.fileHash !== file.fileHash || report.sourceSize !== file.sourceSize) {
    throw new SubmissionTaskError('REPORT_FILE_CHANGED', '报告原始文件已变化。')
  }
  const prefixLength = source.path.length - file.sourceKey.length
  const storageRoot = trimTrailingSeparator(source.path.slice(0, Math.max(0, prefixLength)))
  await createPreparedReportFiles({ storageRoot }).verify(file)
}

function trimTrailingSeparator(value: string) {
  if (value.endsWith('/') || value.endsWith('\\')) return value.slice(0, -1)
  return value
}
