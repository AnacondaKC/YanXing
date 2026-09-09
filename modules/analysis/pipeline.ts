import { randomUUID } from 'node:crypto'
import { PromptBudgetError } from '@/lib/ai/prompt-budget'
import { runAnalysisModuleAgent } from '@/lib/ai/restricted-analysis-agent'
import { completedCallFromError } from '@/lib/ai/runtime/errors'
import { extractCachedDocumentText } from '@/lib/documents/document-parser'
import { retryOnSqliteBusy } from '@/lib/db/checkpoint-retry'
import { createModelRuntime, getRetryAfterMs, isRetryableModelError } from '@/lib/ai/model-router'
import { validateModuleOutput, validatePageAnalysisOutput } from '@/modules/analysis/gates'
import { pageAnalysisModule } from '@/modules/analysis/modules'
import { normalizePageMindMapPayload } from '@/modules/analysis/mind-map'
import { buildVisualizationWordCloudItems, completeWordCloudOutput } from '@/modules/analysis/word-cloud'
import type { AnalysisModuleContext } from '@/modules/analysis/module'
import { AnalysisLeaseLostError, type AnalysisCallCheckpoint, type AnalysisEventPublisher, type AnalysisFinalization, type AnalysisPipelineRepository, type AnalysisSnapshotWrite } from '@/modules/analysis/ports'
import type { AnalysisJob, AnalysisSnapshot } from '@/modules/analysis/domain'
import { ANALYSIS_SNAPSHOT_SCHEMA_VERSION, AiScoreDimensions, AnalysisStages, MAX_AI_SUGGESTIONS, MAX_MINDMAP_CHILDREN, MAX_MINDMAP_NODES, RESEARCH_METHODS, ReportCompletenessDimensions, type AiScore, type AnalysisArtifactRecord, type AnalysisModuleId, type AnalysisModuleState, type AnalysisPromptConfig, type AnalysisSnapshotPayload, type AnalysisStage, type AnalysisTrackedModuleId, type GateError, type PageAnalysisArtifact, type PageAnalysisMindMapNode, type ReportCompletenessArtifact, type ReportFacts, type VisualizationArtifact } from '@/modules/contracts/analysis'

export interface PipelineContext {
  jobId: string
  reportVersionId: string
  repository: AnalysisPipelineRepository
  publisher: AnalysisEventPublisher
  signal?: AbortSignal
  leaseOwner?: string
}

export async function runAnalysisPipeline(context: PipelineContext): Promise<AnalysisSnapshot> {
  const job = context.repository.getJob(context.jobId)
  const report = context.repository.getReport(context.reportVersionId)
  if (!job || !report) throw new Error('分析任务或报告版本不存在。')
  let facts = context.repository.getReportFacts(context.reportVersionId)
  const reportSource = context.repository.getReportSource(context.reportVersionId)
  if (!reportSource) throw new Error('报告原始文件不存在，无法提交给 AI。')
  const evaluationContext = context.repository.getJobEvaluationContext(context.jobId)
  const frozenPromptSettings = context.repository.getPromptSettings(context.jobId)
  if (!frozenPromptSettings?.length) throw new Error('任务缺少冻结的提示词配置。')
  const promptSettings = new Map<AnalysisTrackedModuleId, AnalysisPromptConfig>(frozenPromptSettings.map((prompt) => [prompt.target, prompt] as const))
  const definition = pageAnalysisModule
  const pagePrompt = getPromptConfig(promptSettings, definition.id)
  const persistedArtifacts = context.repository.listArtifacts(context.jobId)
  const persistedModuleStates = new Map(context.repository.listModuleStates(context.jobId).map((state) => [state.moduleId, state] as const))
  const accepted = new Map<'page_analysis', AnalysisArtifactRecord>(context.repository.listAcceptedArtifacts(context.jobId).filter((artifact) => artifact.moduleId === 'page_analysis' && definition.schemaVersion === artifact.schemaVersion && artifact.promptVersion === artifactPromptVersion(definition, pagePrompt)).map((artifact) => ['page_analysis' as const, artifact]))
  const latestPartial = context.repository.getLatestPartialSnapshotForJob(context.jobId)
  const modelCalls = recoverModelCalls(job, persistedArtifacts, latestPartial?.modelCalls ?? [])
  updateStage(context, 'validating', '正在检查文件并提取报告正文。')
  const needsModelCall = !accepted.has('page_analysis')
  const modelRuntime = needsModelCall ? createModelRuntime('page_analysis', context.repository.getJobModelRuntime(context.jobId)) : undefined
  const extractedDocument = needsModelCall ? await extractCachedDocumentText(reportSource.path, context.signal) : undefined
  if (extractedDocument) {
    facts = buildReportFactsFromExtractedDocument(facts, extractedDocument)
    if (!context.repository.saveAiReportFacts(context.reportVersionId, facts)) throw new Error('报告本地事实保存失败。')
  }
  safePublish(context, { jobId: context.jobId, type: 'info', stage: 'validating', message: needsModelCall ? '报告文件已提取为纯文本，开始生成分析页。' : '已恢复通过门禁的分析页产物，准备发布。' })
  if (needsModelCall) {
    if (!modelRuntime) throw new Error('分析页未解析到模型配置。')
    updateStage(context, 'page_analysis', '正在生成分析页。')
    const persistedState = persistedModuleStates.get('page_analysis')
    const lastFailedArtifact = persistedArtifacts.filter((artifact) => artifact.moduleId === 'page_analysis' && artifact.status === 'failed').sort((left, right) => right.attempt - left.attempt)[0]
    // running/retrying state 只表示即将执行该 attempt，不能视为已消费的重试次数；只有失败 artifact 才能安全恢复计数。
    const completedAttempts = Math.min(definition.maxAttempts, lastFailedArtifact?.attempt ?? 0)
    let previousErrors: GateError[] = lastFailedArtifact?.gateErrors ?? persistedState?.gateErrors ?? []
    if (completedAttempts >= definition.maxAttempts) {
      saveModuleState(context, { moduleId: 'page_analysis', status: 'failed', attempt: completedAttempts, maxAttempts: definition.maxAttempts, artifactId: lastFailedArtifact?.id, gateErrors: previousErrors, updatedAt: now() })
      safePublish(context, { jobId: context.jobId, type: 'module_failed', stage: 'page_analysis', moduleId: 'page_analysis', message: '分析页已达到最大重试次数。', errors: previousErrors })
    } else {
      saveModuleState(context, { moduleId: 'page_analysis', status: 'running', attempt: completedAttempts, maxAttempts: definition.maxAttempts, gateErrors: [], updatedAt: now() })
      safePublish(context, { jobId: context.jobId, type: 'module_started', stage: 'page_analysis', moduleId: 'page_analysis', message: '开始生成分析页。' })
      for (let attempt = completedAttempts + 1; attempt <= definition.maxAttempts; attempt += 1) {
        throwIfCancelled(context)
        let aiCallStartedForAttempt = false
        const moduleContext: AnalysisModuleContext & { attempt: number; previousErrors: GateError[] } = { jobId: context.jobId, reportVersionId: context.reportVersionId, reportFacts: facts, reportSource, evaluationContext, maxContextCharacters: modelRuntime.maxContextCharacters, promptConfig: pagePrompt, attempt, previousErrors }
        saveModuleState(context, { moduleId: 'page_analysis', status: attempt === 1 ? 'running' : 'retrying', attempt, maxAttempts: definition.maxAttempts, gateErrors: previousErrors, updatedAt: now() })
        if (attempt > 1) safePublish(context, { jobId: context.jobId, type: 'module_retrying', stage: 'page_analysis', moduleId: 'page_analysis', message: `分析页根据门禁错误重新生成第 ${attempt} 次。`, errors: previousErrors })
        throwIfCancelled(context)
        let generated: Awaited<ReturnType<typeof runAnalysisModuleAgent>>
        try {
          generated = await runAnalysisModuleAgent({
            moduleId: 'page_analysis',
            prompt: definition.buildPrompt(moduleContext),
            promptConfig: pagePrompt,
            schema: definition.schema,
            documentText: extractedDocument?.text ?? '',
            attempt,
            signal: context.signal,
            runtime: modelRuntime,
            onCallStarted: (details) => {
              context.repository.markAiCallStarted(context.jobId, { ...details, stage: 'page_analysis', module: 'page_analysis', attempt })
              aiCallStartedForAttempt = true
            },
          })
        } catch (error) {
          const billed = billedDetailsFromError(error, attempt)
          if (billed) {
            const errors = toModelFailureErrors(error)
            previousErrors = errors
            const failedArtifact = createFailedArtifact(context, definition, pagePrompt, attempt, errors, billed.provider, billed.model, { error: errors[0]?.message ?? '模型调用失败。' })
            const failedState: AnalysisModuleState = { moduleId: 'page_analysis', status: 'failed', attempt, maxAttempts: definition.maxAttempts, artifactId: failedArtifact.id, gateErrors: errors, updatedAt: now() }
            modelCalls.push(toSnapshotModelCall(billed))
            await checkpointCompletedAttempt(context, facts, accepted, modelCalls, billed, failedArtifact, failedState)
            throwIfCancelled(context)
            safePublish(context, { jobId: context.jobId, type: 'module_failed', stage: 'page_analysis', moduleId: 'page_analysis', message: '分析页执行失败。', errors })
            break
          }
          throwIfCancelled(context)
          const errors = toModelFailureErrors(error)
          previousErrors = errors
          const failedArtifact = createFailedArtifact(context, definition, pagePrompt, attempt, errors, modelRuntime.primary.provider, modelRuntime.primary.id, { error: errors[0]?.message ?? '模型调用失败。' })
          const exhausted = aiCallStartedForAttempt || attempt === definition.maxAttempts || !isRetryableModelError(error)
          if (exhausted) {
            context.repository.saveFailedAttempt(context.jobId, failedArtifact, { moduleId: 'page_analysis', status: 'failed', attempt, maxAttempts: definition.maxAttempts, artifactId: failedArtifact.id, gateErrors: errors, updatedAt: now() })
            safePublish(context, { jobId: context.jobId, type: 'module_failed', stage: 'page_analysis', moduleId: 'page_analysis', message: '分析页执行失败。', errors })
            break
          }
          context.repository.saveArtifact(context.jobId, failedArtifact)
          await retryDelay(attempt, getRetryAfterMs(error), context.signal)
          continue
        }
        const details = toAnalysisCallDetails(generated, attempt)
        modelCalls.push(toSnapshotModelCall(details))
        try {
          throwIfCancelled(context)
          saveModuleState(context, { moduleId: 'page_analysis', status: 'gating', attempt, maxAttempts: definition.maxAttempts, gateErrors: [], updatedAt: now() })
          safePublish(context, { jobId: context.jobId, type: 'module_gating', stage: 'page_analysis', moduleId: 'page_analysis', message: '正在校验并修正分析页格式。' })
          const evaluated = evaluatePageAnalysisOutput(definition, generated.payload, extractedDocument?.text ?? '')
          if ('error' in evaluated) {
            const errors = toOutputFailureErrors(evaluated.error)
            previousErrors = errors
            const failedArtifact = createFailedArtifact(context, definition, pagePrompt, attempt, errors, generated.provider, generated.model, boundedFailedPayload(generated.payload))
            const failedState: AnalysisModuleState = { moduleId: 'page_analysis', status: 'failed', attempt, maxAttempts: definition.maxAttempts, artifactId: failedArtifact.id, gateErrors: errors, updatedAt: now() }
            await checkpointCompletedAttempt(context, facts, accepted, modelCalls, details, failedArtifact, failedState)
            safePublish(context, { jobId: context.jobId, type: 'module_failed', stage: 'page_analysis', moduleId: 'page_analysis', message: '分析页结果校验失败。', errors })
            break
          }
          const { payload: generatedPayload, gate, repairedPaths } = evaluated
          if (repairedPaths.length) reportMindMapRepairs(context, { attempt, paths: repairedPaths })
          if (gate.accepted) {
            const acceptedAt = now()
            const acceptedArtifact: AnalysisArtifactRecord = { id: `artifact-${context.jobId}-page_analysis-${attempt}`, jobId: context.jobId, reportVersionId: context.reportVersionId, moduleId: 'page_analysis', schemaVersion: definition.schemaVersion, promptVersion: artifactPromptVersion(definition, pagePrompt), attempt, status: 'accepted', payload: gate.value, gateErrors: [], provider: generated.provider, model: generated.model, createdAt: acceptedAt, acceptedAt }
            const acceptedState: AnalysisModuleState = { moduleId: 'page_analysis', status: 'accepted', attempt, maxAttempts: definition.maxAttempts, artifactId: acceptedArtifact.id, gateErrors: [], updatedAt: acceptedAt }
            accepted.set('page_analysis', acceptedArtifact)
            await checkpointCompletedAttempt(context, facts, accepted, modelCalls, details, acceptedArtifact, acceptedState)
            safePublish(context, { jobId: context.jobId, type: 'module_accepted', stage: 'page_analysis', moduleId: 'page_analysis', message: '分析页已通过门禁。' })
            publishPartialSnapshotEvent(context)
            break
          }
          previousErrors = gate.errors
          const failedArtifact = createFailedArtifact(context, definition, pagePrompt, attempt, gate.errors, generated.provider, generated.model, boundedFailedPayload(generatedPayload))
          const nextState: AnalysisModuleState = { moduleId: 'page_analysis', status: attempt === definition.maxAttempts ? 'failed' : 'retrying', attempt, maxAttempts: definition.maxAttempts, artifactId: failedArtifact.id, gateErrors: gate.errors, updatedAt: now() }
          await checkpointCompletedAttempt(context, facts, accepted, modelCalls, details, failedArtifact, nextState)
          if (attempt === definition.maxAttempts) {
            safePublish(context, { jobId: context.jobId, type: 'module_failed', stage: 'page_analysis', moduleId: 'page_analysis', message: '分析页达到最大重试次数，已保留门禁错误。', errors: gate.errors })
            break
          }
        } catch (error) {
          if (shouldSettleCancelledUsage(context)) {
            const cancelledArtifact = createFailedArtifact(
              context,
              definition,
              pagePrompt,
              attempt,
              [{ code: 'CANCELLED_AFTER_USAGE', path: '', message: '任务取消后已核销本次 AI 用量，未发布结果。' }],
              generated.provider,
              generated.model,
              boundedFailedPayload(generated.payload),
            )
            context.repository.settleCancelledAiCall({
              jobId: context.jobId,
              details,
              artifact: toFailedSettlementArtifact(cancelledArtifact),
            })
            throwIfCancelled(context)
          }
          throw error
        }
      }
    }
  }
  return finalizeAnalysis(context, facts, accepted, modelCalls)
}

function boundedFailedPayload(payload: unknown) {
  const serialized = JSON.stringify(payload) ?? String(payload)
  const maxStoredCharacters = 64 * 1024
  if (serialized.length <= maxStoredCharacters) return payload
  return { truncated: true, originalCharacters: serialized.length, preview: serialized.slice(0, maxStoredCharacters) }
}

function recoverModelCalls(job: AnalysisJob, artifacts: AnalysisArtifactRecord[], existing: AnalysisSnapshot['modelCalls']): AnalysisSnapshot['modelCalls'] {
  const expectedCalls = Math.max(0, Number(job.aiCallsCompleted ?? 0))
  const normalizedExisting = existing.map((call) => ({
    provider: call.provider,
    model: call.model,
    stage: 'page_analysis' as const,
    module: 'page_analysis' as const,
    tokens: call.tokens,
  }))
  if (normalizedExisting.length >= expectedCalls) return normalizedExisting
  const candidate = artifacts
    .filter((artifact) => artifact.status === 'accepted' || artifact.status === 'failed')
    .filter((artifact) => artifact.provider && artifact.model)
    .sort((left, right) => right.attempt - left.attempt)[0]
  if (!candidate) return normalizedExisting
  const missingCalls = expectedCalls - normalizedExisting.length
  const knownTokens = normalizedExisting.reduce((total, call) => total + Math.max(0, Number.isSafeInteger(call.tokens) ? call.tokens : 0), 0)
  const remainingTokens = Math.max(0, (job.aiTokens ?? 0) - knownTokens)
  return [
    ...normalizedExisting,
    ...Array.from({ length: missingCalls }, (_, index) => ({
      provider: candidate.provider!,
      model: candidate.model!,
      stage: 'page_analysis' as const,
      module: 'page_analysis' as const,
      tokens: index === missingCalls - 1 ? remainingTokens : 0,
    })),
  ]
}

function toAnalysisCallDetails(generated: Awaited<ReturnType<typeof runAnalysisModuleAgent>>, attempt: number) {
  if (!Number.isSafeInteger(generated.tokens) || generated.tokens < 0) throw new Error('模型返回的 token usage 无效，无法记录 token 用量。')
  return { provider: generated.provider, model: generated.model, module: 'page_analysis' as const, stage: 'page_analysis' as const, attempt, tokens: generated.tokens }
}

function toSnapshotModelCall(details: ReturnType<typeof toAnalysisCallDetails>): AnalysisSnapshot['modelCalls'][number] {
  return {
    provider: details.provider,
    model: details.model,
    stage: details.stage,
    module: details.module,
    tokens: details.tokens,
  }
}

function evaluatePageAnalysisOutput(definition: typeof pageAnalysisModule, payload: unknown, documentText: string): { payload: unknown; gate: ReturnType<typeof validateModuleOutput>; repairedPaths: string[] } | { error: unknown } {
  try {
    const normalized = normalizePageMindMapPayload(payload)
    const completedPayload = completePageWordCloudPayload(normalized.payload, documentText)
    const gate = validateModuleOutput({ schema: definition.schema, output: completedPayload, extra: validatePageAnalysisOutput })
    return { payload: completedPayload, gate, repairedPaths: normalized.repairedPaths }
  } catch (error) {
    return { error }
  }
}

function reportMindMapRepairs(context: PipelineContext, repair: { attempt: number; paths: string[] }) {
  console.info('[analysis:mindmap-normalized]', JSON.stringify({ jobId: context.jobId, attempt: repair.attempt, count: repair.paths.length, paths: repair.paths }))
  safePublish(context, {
    jobId: context.jobId,
    type: 'info',
    stage: 'page_analysis',
    moduleId: 'page_analysis',
    message: `已自动补齐 ${repair.paths.length} 个思维导图叶子节点的空子节点数组，继续校验分析结果。`,
  })
}

function createFailedArtifact(
  context: PipelineContext,
  definition: typeof pageAnalysisModule,
  pagePrompt: AnalysisPromptConfig,
  attempt: number,
  errors: GateError[],
  provider: string,
  model: string,
  payload: unknown,
): AnalysisArtifactRecord {
  return {
    id: `artifact-${context.jobId}-page_analysis-${attempt}`,
    jobId: context.jobId,
    reportVersionId: context.reportVersionId,
    moduleId: 'page_analysis',
    schemaVersion: definition.schemaVersion,
    promptVersion: artifactPromptVersion(definition, pagePrompt),
    attempt,
    status: 'failed',
    payload,
    gateErrors: errors,
    provider,
    model,
    createdAt: now(),
  }
}

async function checkpointCompletedAttempt(
  context: PipelineContext,
  facts: ReportFacts,
  accepted: Map<AnalysisModuleId, AnalysisArtifactRecord>,
  modelCalls: AnalysisSnapshot['modelCalls'],
  details: AnalysisCallCheckpoint['details'],
  artifact: AnalysisArtifactRecord,
  state: AnalysisModuleState,
) {
  const baseSnapshot = createSnapshotWrite(context, facts, accepted, modelCalls, false, replaceModuleState(context, state))
  const snapshotArtifacts = new Map(baseSnapshot.artifacts.map((candidate) => [candidate.id, candidate] as const))
  snapshotArtifacts.set(artifact.id, artifact)
  const snapshot = { ...baseSnapshot, artifacts: [...snapshotArtifacts.values()] }
  try {
    await retryOnSqliteBusy(() => {
      throwIfCancelled(context)
      context.repository.checkpointAiCall({ jobId: context.jobId, details, artifact, state, snapshot })
    }, { signal: context.signal })
  } catch (error) {
    if (shouldSettleCancelledUsage(context)) {
      context.repository.settleCancelledAiCall({
        jobId: context.jobId,
        details,
        artifact: toFailedSettlementArtifact(artifact),
      })
      throwIfCancelled(context)
    }
    throw error
  }
}

function replaceModuleState(context: PipelineContext, state: AnalysisModuleState): AnalysisModuleState[] {
  const states = context.repository.listModuleStates(context.jobId)
  const index = states.findIndex((candidate) => candidate.moduleId === state.moduleId)
  if (index < 0) return [...states, state]
  return states.map((candidate, candidateIndex) => candidateIndex === index ? state : candidate)
}

function publishPartialSnapshotEvent(context: PipelineContext) {
  safePublish(context, { jobId: context.jobId, type: 'snapshot_updated', message: '已发布部分分析快照。' })
}

function toModelFailureErrors(error: unknown): GateError[] {
  if (error instanceof PromptBudgetError) return [{ code: 'PROMPT_CONTEXT_EXCEEDED', path: '/配置/最大上下文', message: error.message, expected: `至少 ${error.requiredCharacters} 字符` }]
  return toFailureErrors('MODEL_EXECUTION_FAILED', error, 'Agent 必须提交合法 JSON。')
}

function toOutputFailureErrors(error: unknown): GateError[] {
  return toFailureErrors('MODEL_OUTPUT_INVALID', error, '模型输出必须通过 JSON、Schema 和结构门禁。')
}

function toFailureErrors(code: string, error: unknown, expected: string): GateError[] {
  return [{ code, path: '/', message: error instanceof Error ? error.message : '模型调用失败。', expected }]
}

function publishSnapshot(context: PipelineContext, facts: ReportFacts, accepted: Map<AnalysisModuleId, AnalysisArtifactRecord>, modelCalls: AnalysisSnapshot['modelCalls']): AnalysisSnapshot {
  const snapshot = createSnapshotWrite(context, facts, accepted, modelCalls, true)
  const publishAsCurrent = accepted.has('page_analysis')
  context.repository.publishFinalSnapshot(snapshot, determineFinalization(snapshot.moduleStates, publishAsCurrent))
  return toAnalysisSnapshot(snapshot)
}

function finalizeAnalysis(context: PipelineContext, facts: ReportFacts, accepted: Map<AnalysisModuleId, AnalysisArtifactRecord>, modelCalls: AnalysisSnapshot['modelCalls']): AnalysisSnapshot {
  updateStage(context, 'quality_gate', '正在汇总并发布最终分析快照。')
  return publishSnapshot(context, facts, accepted, modelCalls)
}

function createSnapshotWrite(context: PipelineContext, facts: ReportFacts, accepted: Map<AnalysisModuleId, AnalysisArtifactRecord>, modelCalls: AnalysisSnapshot['modelCalls'], final: boolean, moduleStates = context.repository.listModuleStates(context.jobId)): AnalysisSnapshotWrite {
  const payload = buildSnapshotPayload(context, facts, accepted)
  return { id: `analysis-${randomUUID()}`, jobId: context.jobId, kind: final ? 'final' : 'partial', reportVersionId: context.reportVersionId, payload, artifacts: Array.from(accepted.values()), moduleStates, modelCalls, schemaVersion: payload.schemaVersion, promptVersion: 'page-analysis-prompts-v1', pipelineVersion: 'page-analysis-pipeline-v1', createdAt: now(), leaseOwner: context.leaseOwner }
}

function toAnalysisSnapshot(snapshot: AnalysisSnapshotWrite): AnalysisSnapshot { return { id: snapshot.id, reportVersionId: snapshot.reportVersionId, schemaVersion: snapshot.schemaVersion, promptVersion: snapshot.promptVersion, pipelineVersion: snapshot.pipelineVersion, modelCalls: snapshot.modelCalls, artifacts: snapshot.artifacts, moduleStates: snapshot.moduleStates, payload: snapshot.payload, createdAt: snapshot.createdAt } }

function determineFinalization(moduleStates: AnalysisModuleState[], publishAsCurrent: boolean): AnalysisFinalization {
  const state = moduleStates.find((candidate) => candidate.moduleId === 'page_analysis')
  const accepted = state?.status === 'accepted'
  const status = accepted ? 'completed' : 'failed'
  return { status, stage: 'completed', stageIndex: AnalysisStages.indexOf('completed'), errorMessage: accepted ? undefined : (state?.gateErrors[0]?.message ?? '分析失败，分析页未通过质量门禁。'), publishAsCurrent: accepted && publishAsCurrent }
}

function buildReportFactsFromExtractedDocument(baseFacts: ReportFacts, extracted: { paragraphCount: number; characterCount: number }): ReportFacts { return { ...baseFacts, paragraphCount: extracted.paragraphCount, characterCount: extracted.characterCount } }

function buildSnapshotPayload(context: PipelineContext, facts: ReportFacts, accepted: Map<AnalysisModuleId, AnalysisArtifactRecord>): AnalysisSnapshotPayload {
  const basePayload = createEmptyPayload(facts)
  const page = accepted.get('page_analysis')?.payload as PageAnalysisArtifact | undefined
  if (!page) return basePayload
  const report = context.repository.getReport(context.reportVersionId)
  const previousPayload = report?.previousVersionId ? context.repository.getCurrentSnapshot(report.previousVersionId)?.payload : undefined
  const previousOverall = readCompletePreviousOverall(previousPayload)
  return { schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION, reportDetails: { sections: page['报告详情']['章节'].map((section, index) => ({ id: `section-${index + 1}`, title: section['标题'], summary: section['摘要'] })), completenessConclusion: page['报告详情']['完整度结论'] }, reportCompleteness: buildCompleteness(page), aiScore: buildAiScore(page, previousOverall), suggestions: page['AI建议'].slice(0, MAX_AI_SUGGESTIONS).map((detail, index) => ({ id: `suggestion-${index + 1}`, detail })), visualization: { mindMap: buildMindMap(page['思维导图']), wordCloud: buildVisualizationWordCloudItems(page['词云']), heatmap: { rows: page['热力图'].map((row, index) => ({ id: `heatmap-${index + 1}`, label: row['章节'], values: RESEARCH_METHODS.map((method) => row[method.label]) })) } } }
}

function readCompletePreviousOverall(payload: AnalysisSnapshotPayload | undefined) {
  if (!payload || payload.schemaVersion !== ANALYSIS_SNAPSHOT_SCHEMA_VERSION) return undefined
  const dimensions = payload.aiScore?.dimensions
  if (!Array.isArray(dimensions) || dimensions.length !== AiScoreDimensions.length) return undefined
  const expectedIds = new Set(AiScoreDimensions.map((dimension) => dimension.id))
  if (dimensions.some((dimension) => !expectedIds.has(dimension.id as typeof AiScoreDimensions[number]['id']) || !Number.isFinite(dimension.score) || dimension.score < 0 || dimension.score > 100)) return undefined
  return Number.isFinite(payload.aiScore.overall) && payload.aiScore.overall >= 0 && payload.aiScore.overall <= 100
    ? payload.aiScore.overall
    : undefined
}

function buildAiScore(page: PageAnalysisArtifact, previousOverall: number | undefined): AiScore {
  const dimensions = AiScoreDimensions.map((dimension) => ({ id: dimension.id, label: dimension.label, score: page['综合评分'][dimension.id] }))
  return { overall: averageScores(dimensions.map((dimension) => dimension.score)), previousOverall, summary: page['综合评分']['主要影响因素'], dimensions }
}

function buildCompleteness(page: PageAnalysisArtifact): ReportCompletenessArtifact {
  const dimensions = ReportCompletenessDimensions.map((dimension) => ({ id: dimension.id, label: dimension.label, score: page['报告完整度'][dimension.id] }))
  return { overall: averageScores(dimensions.map((dimension) => dimension.score)), mainGap: page['报告完整度']['主要缺口'], dimensions }
}

function averageScores(scores: number[]) { return scores.length ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length) : 0 }

function buildMindMap(root: PageAnalysisMindMapNode): VisualizationArtifact['mindMap'] { return normalizeMindMapNode(root, 'mindmap-root', { count: 0 }) }

function normalizeMindMapNode(node: PageAnalysisMindMapNode, id: string, state: { count: number }): VisualizationArtifact['mindMap'] {
  state.count += 1
  const remaining = Math.max(0, MAX_MINDMAP_NODES - state.count)
  const children = node['子节点'].slice(0, Math.min(MAX_MINDMAP_CHILDREN, remaining)).map((child, index) => normalizeMindMapNode(child, `${id}-${index + 1}`, state))
  return { id, label: node['名称'], children }
}

function createEmptyPayload(facts: ReportFacts): AnalysisSnapshotPayload { return { schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION, reportDetails: { sections: [], completenessConclusion: '等待报告详情分析完成。' }, reportCompleteness: { overall: 0, dimensions: [], mainGap: '等待报告完整度分析完成。' }, aiScore: { overall: 0, summary: '等待综合评分模块完成。', dimensions: [] }, suggestions: [], visualization: createEmptyVisualization(facts) } }

function createEmptyVisualization(facts: ReportFacts): VisualizationArtifact { return { mindMap: { id: 'root', label: facts.title, children: [] }, wordCloud: [], heatmap: { rows: [] } } }

function completePageWordCloudPayload(payload: unknown, documentText: string): unknown {
  if (!isRecord(payload) || !Array.isArray(payload['词云']) || !payload['词云'].every((word) => typeof word === 'string')) return payload
  const completed = completeWordCloudOutput({ words: payload['词云'] }, documentText)
  if (!isRecord(completed) || !Array.isArray(completed.words)) return payload
  return { ...payload, '词云': completed.words }
}

function saveModuleState(context: PipelineContext, state: AnalysisModuleState) { context.repository.saveModuleState(context.jobId, state) }

function updateStage(context: PipelineContext, stage: AnalysisStage, message: string) {
  throwIfCancelled(context)
  const updated = context.repository.updateJob(context.jobId, { status: 'running', stage, stageIndex: AnalysisStages.indexOf(stage) })
  if (!updated) throw new Error('任务租约已失效，不能更新分析阶段。')
  safePublish(context, { jobId: context.jobId, type: 'stage', stage, message })
}

function throwIfCancelled(context: PipelineContext) { if (context.signal?.aborted || context.repository.isCancellationRequested(context.jobId)) throw new Error('Analysis cancelled') }

function getPromptConfig(settings: ReadonlyMap<AnalysisTrackedModuleId, AnalysisPromptConfig>, target: AnalysisTrackedModuleId) { const prompt = settings.get(target); if (!prompt) throw new Error(`缺少 ${target} 模块的提示词配置。`); return prompt }

function artifactPromptVersion(definition: { promptVersion: string }, promptConfig?: AnalysisPromptConfig) { return `${definition.promptVersion}:settings-${promptConfig?.version ?? 1}` }

export async function retryDelay(attempt: number, retryAfterMs = 0, signal?: AbortSignal) {
  const base = Math.min(10_000, 1_000 * 2 ** Math.max(0, attempt - 1))
  const jitter = Math.floor(Math.random() * 250)
  const milliseconds = Math.max(base, retryAfterMs) + jitter
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Analysis cancelled')); return }
    const onAbort = () => { clearTimeout(timer); reject(new Error('Analysis cancelled')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function safePublish(context: PipelineContext, input: Parameters<AnalysisEventPublisher['publish']>[0]) {
  try {
    context.publisher.publish(input)
  } catch (error) {
    if (error instanceof AnalysisLeaseLostError || context.repository.isCancellationRequested(context.jobId)) throw error
    // 事件仅用于进度通知；核心状态由带租约的持久化操作保证。
  }
}

function billedDetailsFromError(error: unknown, attempt: number) {
  const billed = completedCallFromError(error)
  if (!billed) return undefined
  return {
    provider: billed.provider,
    model: billed.model,
    module: 'page_analysis' as const,
    stage: 'page_analysis' as const,
    attempt,
    tokens: billed.tokens,
  }
}

function toFailedSettlementArtifact(artifact: AnalysisArtifactRecord): AnalysisArtifactRecord {
  if (artifact.status === 'failed') return { ...artifact, acceptedAt: undefined }
  return {
    ...artifact,
    status: 'failed',
    acceptedAt: undefined,
    gateErrors: artifact.gateErrors.length
      ? artifact.gateErrors
      : [{ code: 'CANCELLED_AFTER_USAGE', path: '', message: '任务取消后已核销本次 AI 用量，未发布结果。' }],
  }
}

function shouldSettleCancelledUsage(context: PipelineContext) {
  const job = context.repository.getJob(context.jobId)
  return Boolean(job && (job.status === 'cancelled' || job.cancelRequested))

}

function now() { return new Date().toISOString() }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
