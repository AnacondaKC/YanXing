import { runtimeConfig } from '@/lib/config/environment'
import { createModelRuntime, type ModelRuntime } from '@/lib/ai/model-router'
import { runAnalysisModuleAgent } from '@/lib/ai/restricted-analysis-agent'
import { completedCallFromError } from '@/lib/ai/runtime/errors'
import { runReportInsightAgent } from '@/lib/ai/report-insight-agent'
import type { AnalysisEventPublisher } from '@/modules/analysis/ports'
import { runAnalysisExecution } from '@/modules/analysis/pipeline'
import type { AnalysisArtifactRecord } from '@/modules/contracts/analysis'
import type { ReportInsightOutput } from '@/modules/insights/domain'
import { SubmissionTaskError, type SubmissionTask } from '@/modules/reports/submission-task-domain'
import { IncompleteProviderCallError, type SubmissionTaskPort } from '@/modules/reports/submission-task-ports'

export interface SubmissionExecutorDependencies {
  runModuleAgent?: typeof runAnalysisModuleAgent
  runInsightAgent?: typeof runReportInsightAgent
  createRuntime?: typeof createModelRuntime
}

export async function executeSubmissionTask(input: {
  taskId: string
  port: SubmissionTaskPort
  publisher: AnalysisEventPublisher
  signal?: AbortSignal
  leaseOwner?: string
  dependencies?: SubmissionExecutorDependencies
}): Promise<SubmissionTask> {
  const task = input.port.getTask(input.taskId)
  if (!task) throw new SubmissionTaskError('TASK_NOT_FOUND', '任务不存在。', 404)
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
  if (task.cancelRequested) throw new Error('Analysis cancelled')

  try {
    if (task.operation === 'insight') return await executeInsightTask(task, input)
    return await executeAnalysisTask(task, input)
  } catch (error) {
    failRunningTask(input.port, input.taskId, error)
    throw error
  }
}

function failRunningTask(port: SubmissionTaskPort, taskId: string, error: unknown) {
  if (error instanceof SubmissionTaskError && error.code === 'TASK_LEASE_LOST') return
  if (error instanceof Error && error.message === 'Analysis cancelled') return
  const task = port.getTask(taskId)
  if (!task || task.status !== 'running' || task.cancelRequested) return
  const code = error instanceof SubmissionTaskError && /^[A-Z0-9_]{1,100}$/.test(error.code)
    ? error.code
    : 'WORKER_EXECUTION_FAILED'
  port.failTask(taskId, code)
}

async function executeAnalysisTask(
  task: SubmissionTask,
  input: Parameters<typeof executeSubmissionTask>[0],
): Promise<SubmissionTask> {
  const { taskId, port, publisher, signal, leaseOwner, dependencies } = input
  const frozen = port.getFrozenSnapshots(taskId)
  const pagePrompt = frozen.prompts.find((prompt) => prompt.target === 'page_analysis')
  if (!pagePrompt) throw new SubmissionTaskError('TASK_FREEZE_INVALID', '任务缺少冻结的分析提示词。')
  const accepted = port.listAcceptedArtifacts(taskId).filter((artifact) => artifact.moduleId === 'page_analysis')
  const needsModelCall = accepted.length === 0
  if (needsModelCall) {
    assertProviderCallSafe(port, taskId)
    await verifyReportSource(port, task)
    assertExplicitSettingsEncryptionKey(frozen.modelRuntime.apiKeyEncrypted)
  }
  const documentText = needsModelCall ? port.getDocumentText(task.reportId) : undefined
  await runAnalysisExecution({
    jobId: taskId,
    reportId: task.reportId,
    port,
    publisher,
    signal,
    leaseOwner,
    documentText,
    runModuleAgent: dependencies?.runModuleAgent,
    createRuntime: (target, modelSnapshot) => {
      if (!modelSnapshot) throw new SubmissionTaskError('TASK_FREEZE_INVALID', '任务缺少冻结的模型配置。')
      assertExplicitSettingsEncryptionKey(modelSnapshot.apiKeyEncrypted)
      return (dependencies?.createRuntime ?? createModelRuntime)(target, modelSnapshot)
    },
  })
  const updated = port.getTask(taskId)
  if (!updated) throw new SubmissionTaskError('TASK_NOT_FOUND', '任务不存在。', 404)
  return updated
}

async function executeInsightTask(
  task: SubmissionTask,
  input: Parameters<typeof executeSubmissionTask>[0],
): Promise<SubmissionTask> {
  const { taskId, port, publisher, signal, dependencies } = input
  const frozen = port.getFrozenSnapshots(taskId)
  const prompt = frozen.prompts.find((item) => item.target === 'report_insight')
  if (!prompt) throw new SubmissionTaskError('TASK_FREEZE_INVALID', '任务缺少冻结的洞察提示词。')
  const checkpoint = port.listAcceptedArtifacts(taskId).find((artifact) => artifact.moduleId === 'report_insight')
  if (checkpoint) {
    publishInsightFromArtifact(port, task, checkpoint)
    return requireTask(port, taskId)
  }
  assertProviderCallSafe(port, taskId)
  await verifyReportSource(port, task)
  assertExplicitSettingsEncryptionKey(frozen.modelRuntime.apiKeyEncrypted)
  const document = port.getDocumentText(task.reportId)
  const runtime = createInsightRuntime(frozen.modelRuntime, dependencies?.createRuntime)
  port.updateTask(taskId, { stage: 'validating', stageIndex: 0 })
  const runInsight = dependencies?.runInsightAgent ?? runReportInsightAgent
  let generated: Awaited<ReturnType<typeof runReportInsightAgent>> | undefined
  try {
    generated = await runInsight({
      promptConfig: prompt,
      documentText: document.text,
      signal,
      runtime,
      onCallStarted: (details) => {
        port.markAiCallStarted(taskId, { ...details, stage: 'report_insight', module: 'report_insight', attempt: 1 })
      },
    })
  } catch (error) {
    await persistFailedInsightCall(port, task, error)
    throwIfCancelled(port, taskId, signal)
    throw error
  }
  if (!generated) throw new SubmissionTaskError('MODEL_EXECUTION_FAILED', '洞察生成失败。')
  const artifact = insightArtifact(task, generated, 'accepted')
  port.checkpointAiCall({
    jobId: taskId,
    details: {
      provider: generated.provider,
      model: generated.model,
      stage: 'report_insight',
      module: 'report_insight',
      attempt: 1,
    },
    artifact,
  })
  throwIfCancelled(port, taskId, signal)
  const modelCall = insightPublicationModel(port, task, generated)
  port.publishInsight({
    insight: toInsightOutput(generated),
    modelCall,
  })
  publisher.publish('completed')
  return requireTask(port, taskId)
}

function publishInsightFromArtifact(port: SubmissionTaskPort, task: SubmissionTask, artifact: AnalysisArtifactRecord) {
  if (artifact.jobId !== task.id || artifact.reportVersionId !== task.reportId) {
    throw new SubmissionTaskError('TASK_IDENTITY_MISMATCH', '洞察检查点标识与当前任务不一致。')
  }
  const insight = artifact.payload as ReportInsightOutput
  if (!insight?.html) {
    throw new SubmissionTaskError('INSIGHT_CHECKPOINT_INVALID', '洞察检查点缺少可发布内容。')
  }
  port.publishInsight({
    insight: toInsightOutput(insight),
    modelCall: insightPublicationModel(port, task, { provider: artifact.provider, model: artifact.model }),
  })
}

function insightPublicationModel(
  port: SubmissionTaskPort,
  task: SubmissionTask,
  generated: { provider?: string; model?: string },
) {
  const frozen = port.getFrozenSnapshots(task.id)
  const provider = frozen.modelRuntime.channel === 'chat_completions' ? 'chat_completions' : generated.provider
  const model = frozen.modelRuntime.modelName || generated.model
  if (!provider || !model) throw new SubmissionTaskError('INSIGHT_CHECKPOINT_INVALID', '洞察检查点缺少模型身份。')
  return {
    provider,
    model,
  }
}

async function persistFailedInsightCall(port: SubmissionTaskPort, task: SubmissionTask, error: unknown) {
  const completed = completedCallFromError(error)
  if (!completed) return
  const artifact = insightArtifact(task, {
    provider: completed.provider,
    model: completed.model,
    title: '',
    summary: '',
    readingMinutes: 1,
    sections: [],
    html: '',
  }, 'failed')
  const details = {
    provider: completed.provider,
    model: completed.model,
    stage: 'report_insight',
    module: 'report_insight',
    attempt: 1,
  }
  if (port.isCancellationRequested(task.id)) {
    port.settleCancelledAiCall({ jobId: task.id, details, artifact })
    return
  }
  port.checkpointAiCall({ jobId: task.id, details, artifact })
  port.failTask(task.id, 'MODEL_EXECUTION_FAILED')
}

function insightArtifact(
  task: SubmissionTask,
  generated: { provider: string; model: string } & Partial<ReportInsightOutput>,
  status: 'accepted' | 'failed',
): AnalysisArtifactRecord {
  return {
    id: 'artifact-' + task.id + '-report_insight-1',
    jobId: task.id,
    reportVersionId: task.reportId,
    moduleId: 'report_insight',
    schemaVersion: 1,
    promptVersion: 'report-insight-v1',
    attempt: 1,
    status,
    payload: status === 'accepted' ? toInsightOutput(generated as ReportInsightOutput) : { error: '洞察生成失败。' },
    gateErrors: status === 'failed' ? [{ code: 'INSIGHT_INVALID', path: '/', message: '洞察未通过校验。' }] : [],
    provider: generated.provider,
    model: generated.model,
    createdAt: new Date().toISOString(),
    acceptedAt: status === 'accepted' ? new Date().toISOString() : undefined,
  }
}

function toInsightOutput(value: ReportInsightOutput): ReportInsightOutput {
  return {
    title: value.title,
    summary: value.summary,
    readingMinutes: value.readingMinutes,
    sections: value.sections,
    html: value.html,
  }
}

function assertProviderCallSafe(port: SubmissionTaskPort, taskId: string) {
  const ledger = port.getProviderCallLedger(taskId)
  if (ledger.openIntent) throw new IncompleteProviderCallError(taskId, ledger.openIntent)
}

function assertExplicitSettingsEncryptionKey(apiKeyEncrypted: string | null | undefined) {
  if (!apiKeyEncrypted) return
  if (!runtimeConfig.settingsEncryptionKey) {
    throw new SubmissionTaskError(
      'SETTINGS_ENCRYPTION_KEY_MISSING',
      '任务冻结了加密模型密钥，但未配置 YANXING_SETTINGS_ENCRYPTION_KEY，拒绝回退到本地密钥文件。',
      500,
    )
  }
}

function createInsightRuntime(
  frozen: ReturnType<SubmissionTaskPort['getFrozenSnapshots']>['modelRuntime'],
  createRuntime: SubmissionExecutorDependencies['createRuntime'],
): ModelRuntime {
  const factory = createRuntime ?? createModelRuntime
  return factory('report_insight', frozen)
}

async function verifyReportSource(port: SubmissionTaskPort, task: SubmissionTask) {
  const report = port.getReport(task.reportId)
  if (!report || report.deletedAt) throw new SubmissionTaskError('REPORT_NOT_FOUND', '报告不存在或已撤回。', 404)
  await port.verifySource({ sourceKey: report.sourceKey, fileHash: report.fileHash, sourceSize: report.sourceSize })
}

function throwIfCancelled(port: SubmissionTaskPort, taskId: string, signal?: AbortSignal) {
  if (signal?.aborted || port.isCancellationRequested(taskId)) throw new Error('Analysis cancelled')
}

function requireTask(port: SubmissionTaskPort, taskId: string) {
  const task = port.getTask(taskId)
  if (!task) throw new SubmissionTaskError('TASK_NOT_FOUND', '任务不存在。', 404)
  return task
}
