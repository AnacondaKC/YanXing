import { runReportInsightAgent } from '@/lib/ai/report-insight-agent'
import { completedCallFromError } from '@/lib/ai/runtime/errors'
import { createModelRuntime } from '@/lib/ai/model-router'
import { retryOnSqliteBusy } from '@/lib/db/checkpoint-retry'
import { createAnalysisEventPublisher, createAnalysisRepository } from '@/lib/db/analysis-repository'
import { completeInsightGenerationWithInsight } from '@/lib/db/repository'
import { ensureReportSourceFile } from '@/worker/report-source'
import type { AnalysisArtifactRecord } from '@/modules/contracts/analysis'
import type { AnalysisJob } from '@/modules/analysis/domain'
import type { AnalysisCallCheckpoint } from '@/modules/analysis/ports'
import type { ReportInsight, ReportInsightOutput } from '@/modules/insights/domain'

const insightCheckpointSchemaVersion = 1
const insightCheckpointPromptVersion = 'report-insight-checkpoint-v1'
type InsightCallDetails = { provider: string; model: string; tokens: number }
type InsightCheckpointPayload = {
  checkpointVersion: typeof insightCheckpointSchemaVersion
  reportVersionId: string
  insight: ReportInsightOutput
  tokens: number
}
type InsightCheckpoint = {
  insight: Omit<ReportInsight, 'id' | 'generatedAt'>
  usage: { tokens: number }
}

export async function processInsightJob(jobId: string, options: { signal?: AbortSignal; leaseOwner?: string } = {}) {
  const repository = createAnalysisRepository(options.leaseOwner)
  const publisher = createAnalysisEventPublisher(options.leaseOwner)
  const job = repository.getJob(jobId)
  if (!job) throw new Error('Unknown job: ' + jobId)
  if (job.type !== 'insight') throw new Error('当前任务不是洞察生成任务。')
  throwIfAborted(options.signal, repository, jobId)

  const checkpoint = loadInsightCheckpoint(job, repository)
  if (checkpoint) {
    throwIfAborted(options.signal, repository, jobId)
    beginInsightJob({ repository, publisher, jobId, signal: options.signal })
    return completeInsightJob({ jobId, checkpoint, leaseOwner: options.leaseOwner, repository, signal: options.signal })
  }

  const source = repository.getReportSource(job.reportVersionId)
  if (!source) throw new Error('报告原始文件不存在，无法提交给 AI。')
  throwIfAborted(options.signal, repository, jobId)
  await ensureReportSourceFile(source.path, options.signal)
  throwIfAborted(options.signal, repository, jobId)
  const promptConfig = repository.getPromptSettings(jobId)?.find((prompt) => prompt.target === 'report_insight')
  if (!promptConfig) throw new Error('任务缺少冻结的洞察提示词配置。')
  const modelRuntime = createModelRuntime('report_insight', repository.getJobModelRuntime(jobId))

  beginInsightJob({ repository, publisher, jobId, signal: options.signal })

  let completedCall: InsightCallDetails | undefined
  let generated: Awaited<ReturnType<typeof runReportInsightAgent>>
  try {
    generated = await runReportInsightAgent({
      promptConfig,
      file: source,
      runtime: modelRuntime,
      signal: options.signal,
      onCallStarted: (details) => {
        repository.markAiCallStarted(jobId, {
          provider: details.provider,
          model: details.model,
          stage: details.stage,
          module: details.module,
          attempt: 1,
        })
      },
      onCallCompleted: (details) => {
        completedCall = details
      },
    })
  } catch (error) {
    await persistFailedInsightUsage({ job, repository, completedCall, error, signal: options.signal })
    throw error
  }

  const call = normalizeCallDetails(generated, completedCall)
  const generatedInsight: ReportInsightOutput = {
    title: generated.title,
    summary: generated.summary,
    readingMinutes: generated.readingMinutes,
    sections: generated.sections,
    html: generated.html,
  }
  const checkpointPayload: InsightCheckpointPayload = {
    checkpointVersion: insightCheckpointSchemaVersion,
    reportVersionId: job.reportVersionId,
    insight: generatedInsight,
    tokens: call.tokens,
  }
  try {
    await persistInsightCheckpoint({
      job,
      repository,
      call,
      artifact: createInsightCheckpointArtifact(job, call, checkpointPayload),
      signal: options.signal,
    })
  } catch (error) {
    await persistFailedInsightUsage({ job, repository, completedCall: call, error, signal: options.signal })
    throw error
  }

  throwIfAborted(options.signal, repository, jobId)
  const insight = toInsightRecord(job, generatedInsight, call)
  completeInsightGenerationWithInsight(jobId, insight, call, options.leaseOwner)
  return repository.getJob(jobId)
}

function loadInsightCheckpoint(
  job: AnalysisJob,
  repository: ReturnType<typeof createAnalysisRepository>,
): InsightCheckpoint | undefined {
  const artifactId = insightCheckpointArtifactId(job.id)
  const artifact = repository.listArtifacts(job.id).find((candidate) => candidate.id === artifactId)
  if (!artifact) return undefined
  if (
    artifact.jobId !== job.id
    || artifact.reportVersionId !== job.reportVersionId
    || artifact.moduleId !== 'report_insight'
    || artifact.schemaVersion !== insightCheckpointSchemaVersion
    || artifact.promptVersion !== insightCheckpointPromptVersion
    || artifact.attempt !== 1
  ) {
    throw new Error('洞察完成检查点与任务不匹配，拒绝重复调用 provider。')
  }
  if (artifact.status === 'failed') {
    throw new Error('洞察失败检查点已落账，拒绝重复调用 provider。')
  }
  if (artifact.status !== 'accepted') {
    throw new Error('洞察完成检查点与任务不匹配，拒绝重复调用 provider。')
  }
  if (!artifact.provider || !artifact.model) {
    throw new Error('洞察完成检查点缺少 provider 信息，拒绝重复调用 provider。')
  }
  if (!isInsightCheckpointPayload(artifact.payload, job.reportVersionId)) {
    throw new Error('洞察完成检查点无效，拒绝重复调用 provider。')
  }
  return {
    insight: {
      reportVersionId: job.reportVersionId,
      ...artifact.payload.insight,
      provider: artifact.provider,
      model: artifact.model,
    },
    usage: { tokens: artifact.payload.tokens },
  }
}

type InsightJobContext = {
  jobId: string
  repository: ReturnType<typeof createAnalysisRepository>
  publisher: ReturnType<typeof createAnalysisEventPublisher>
  signal?: AbortSignal
}

type InsightCompletionContext = {
  jobId: string
  checkpoint: InsightCheckpoint
  leaseOwner: string | undefined
  repository: ReturnType<typeof createAnalysisRepository>
  signal?: AbortSignal
}

function beginInsightJob({ repository, publisher, jobId, signal }: InsightJobContext) {
  throwIfAborted(signal, repository, jobId)
  const updated = repository.updateJob(jobId, { status: 'running', stage: 'validating', stageIndex: 0 })
  if (!updated) throw new Error('任务租约已失效，不能更新洞察阶段。')
  throwIfAborted(signal, repository, jobId)
  publisher.publish({ jobId, type: 'stage', stage: 'validating', message: '正在生成报告洞察。' })
  throwIfAborted(signal, repository, jobId)
}

function completeInsightJob({ jobId, checkpoint, leaseOwner, repository, signal }: InsightCompletionContext) {
  throwIfAborted(signal, repository, jobId)
  completeInsightGenerationWithInsight(jobId, checkpoint.insight, checkpoint.usage, leaseOwner)
  return repository.getJob(jobId)
}

function normalizeCallDetails(
  generated: { provider: string; model: string; tokens: number },
  completedCall?: InsightCallDetails,
): InsightCallDetails {
  return {
    provider: completedCall?.provider ?? generated.provider,
    model: completedCall?.model ?? generated.model,
    tokens: nonNegativeInteger(completedCall?.tokens ?? generated.tokens),
  }
}

async function persistInsightCheckpoint(input: {
  job: AnalysisJob
  repository: ReturnType<typeof createAnalysisRepository>
  call: InsightCallDetails
  artifact: AnalysisArtifactRecord
  signal?: AbortSignal
}) {
  await retryOnSqliteBusy(() => {
    throwIfAborted(input.signal, input.repository, input.job.id)
    input.repository.checkpointAiCall(insightCallCheckpoint(input.job, input.call, input.artifact))
  }, { signal: input.signal })
}

async function persistFailedInsightUsage(input: {
  job: AnalysisJob
  repository: ReturnType<typeof createAnalysisRepository>
  completedCall?: InsightCallDetails
  error: unknown
  signal?: AbortSignal
}) {
  const call = completedCallFromError(input.error) ?? input.completedCall
  if (!call) return
  const artifact = createInsightFailedArtifact(input.job, call, input.error)
  const checkpoint = insightCallCheckpoint(input.job, call, artifact)
  const current = input.repository.getJob(input.job.id)
  if (current && (current.status === 'cancelled' || current.cancelRequested)) {
    input.repository.settleCancelledAiCall(checkpoint)
    return
  }
  try {
    await retryOnSqliteBusy(() => {
      input.repository.checkpointAiCall(checkpoint)
    }, { signal: input.signal })
  } catch (error) {
    const latest = input.repository.getJob(input.job.id)
    if (latest && (latest.status === 'cancelled' || latest.cancelRequested)) {
      input.repository.settleCancelledAiCall(checkpoint)
      return
    }
    throw error
  }
}

function insightCallCheckpoint(
  job: AnalysisJob,
  call: InsightCallDetails,
  artifact: AnalysisArtifactRecord,
): AnalysisCallCheckpoint {
  return {
    jobId: job.id,
    details: {
      provider: call.provider,
      model: call.model,
      stage: 'report_insight',
      module: 'report_insight',
      attempt: 1,
      tokens: call.tokens,
    },
    artifact,
  }
}

function createInsightFailedArtifact(
  job: AnalysisJob,
  call: InsightCallDetails,
  error: unknown,
): AnalysisArtifactRecord {
  return {
    id: insightCheckpointArtifactId(job.id),
    jobId: job.id,
    reportVersionId: job.reportVersionId,
    moduleId: 'report_insight',
    schemaVersion: insightCheckpointSchemaVersion,
    promptVersion: insightCheckpointPromptVersion,
    attempt: 1,
    status: 'failed',
    payload: {
      checkpointVersion: insightCheckpointSchemaVersion,
      reportVersionId: job.reportVersionId,
      failed: true,
      tokens: call.tokens,
    },
    gateErrors: [{
      code: 'MODEL_EXECUTION_FAILED',
      path: '',
      message: error instanceof Error ? error.message : String(error),
    }],
    provider: call.provider,
    model: call.model,
    createdAt: new Date().toISOString(),
  }
}

function createInsightCheckpointArtifact(
  job: AnalysisJob,
  call: InsightCallDetails,
  payload: InsightCheckpointPayload,
): AnalysisArtifactRecord {
  const timestamp = new Date().toISOString()
  return {
    id: insightCheckpointArtifactId(job.id),
    jobId: job.id,
    reportVersionId: job.reportVersionId,
    moduleId: 'report_insight',
    schemaVersion: insightCheckpointSchemaVersion,
    promptVersion: insightCheckpointPromptVersion,
    attempt: 1,
    status: 'accepted',
    payload,
    gateErrors: [],
    provider: call.provider,
    model: call.model,
    createdAt: timestamp,
    acceptedAt: timestamp,
  }
}

function insightCheckpointArtifactId(jobId: string) {
  return 'artifact-' + jobId + '-report_insight-checkpoint'
}

function toInsightRecord(
  job: AnalysisJob,
  output: ReportInsightOutput,
  call: InsightCallDetails,
): Omit<ReportInsight, 'id' | 'generatedAt'> {
  return {
    reportVersionId: job.reportVersionId,
    title: output.title,
    summary: output.summary,
    readingMinutes: output.readingMinutes,
    sections: output.sections,
    html: output.html,
    provider: call.provider,
    model: call.model,
  }
}

function isInsightCheckpointPayload(value: unknown, reportVersionId: string): value is InsightCheckpointPayload {
  if (!isRecord(value) || value.checkpointVersion !== insightCheckpointSchemaVersion || value.reportVersionId !== reportVersionId) return false
  return isInsightOutput(value.insight)
    && nonNegativeIntegerOrUndefined(value.tokens)
}

function isInsightOutput(value: unknown): value is ReportInsightOutput {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.summary !== 'string' || typeof value.html !== 'string') return false
  if (!Number.isSafeInteger(value.readingMinutes) || Number(value.readingMinutes) < 1) return false
  return Array.isArray(value.sections) && value.sections.every((section) => isRecord(section) && typeof section.id === 'string' && typeof section.label === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function nonNegativeIntegerOrUndefined(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  repository: ReturnType<typeof createAnalysisRepository>,
  jobId: string,
) {
  if (signal?.aborted || repository.isCancellationRequested(jobId)) throw new Error('Analysis cancelled')
}
