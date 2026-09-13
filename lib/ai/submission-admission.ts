import type { DatabaseSync } from 'node:sqlite'
import { AiQueueFullError } from '@/lib/ai/queue-policy'
import { createAnalysisPromptPlan } from '@/lib/ai/prompt-budget'
import { isAiPromptTarget, MAX_AI_PROMPT_TEXT_LENGTH } from '@/lib/ai/prompt-defaults'
import { isAiReasoningEffort, isValidMaxContextCharacters, isValidMaxOutputTokens } from '@/lib/ai/runtime-options'
import { runtimeConfig } from '@/lib/config/environment'
import {
  getAiModelRuntimeSnapshotInDatabase,
  getAiPromptSettingsSnapshotInDatabase,
  isAiModelSelectionTarget,
  type AiModelRuntimeSnapshot,
} from '@/lib/db/settings-repository'
import { parseReportEvaluationContext } from '@/modules/analysis/evaluation-context'
import { buildPageAnalysisTaskPrompt } from '@/modules/analysis/prompt'
import type { AnalysisPromptConfig, ReportEvaluationContext } from '@/modules/contracts/analysis'
import type { ReportOperation } from '@/modules/reports/submission-domain'
import { SubmissionTaskError, type SubmissionTaskSnapshot } from '@/modules/reports/submission-task-domain'

const ACTIVE_TASK_STATUSES = "('queued', 'running')"
const REPORT_NOT_FOUND_MESSAGE = '报告不存在，无法启动 AI 任务。'
const PROJECT_MISSING_MESSAGE = '报告所属课题不存在，无法启动 AI 分析。'
const PROJECT_CONTEXT_INCOMPLETE_MESSAGE = '请先补齐研究目标与核心问题、研究背景与说明，以及所属阶段的名称、日期和工作内容与预期成果。'

export function freezeSubmissionTask(input: {
  database: DatabaseSync
  reportId: string
  operation: ReportOperation
}): SubmissionTaskSnapshot {
  const operation = requireOperation(input.operation)
  const evaluationContext = freezeEvaluationContext(input.database, input.reportId)
  const runtimeTarget = operation === 'insight' ? 'report_insight' : 'page_analysis'
  const modelRuntime = getAiModelRuntimeSnapshotInDatabase(input.database, runtimeTarget)
  if (!modelRuntime) {
    const assignment = input.database.prepare('SELECT model_id FROM ai_model_assignments WHERE target = ?').get(runtimeTarget)
    if (assignment?.model_id) throw new Error('已选择的模型配置损坏。')
    throw new SubmissionTaskError('MODEL_NOT_CONFIGURED', (operation === 'insight' ? '报告洞察尚未选择模型。' : '分析页尚未选择模型。') + '请联系管理员配置模型。')
  }
  if (!isNonBlankString(modelRuntime.apiKeyEncrypted)) {
    throw new SubmissionTaskError('MODEL_CREDENTIALS_MISSING', modelRuntime.channelName + ' 尚未配置 API 密钥，请联系管理员配置。')
  }
  const prompts = freezePrompts(input.database, operation)
  assertFrozenPromptCompatibility({ runtime: modelRuntime, prompts, evaluationContext })
  const snapshot = typeSubmissionTaskSnapshot({ prompts, modelRuntime, evaluationContext })
  if (!snapshot) throw new Error('冻结的任务快照无效。')
  return snapshot
}

export function assertSubmissionTaskAdmission(input: {
  database: DatabaseSync
  actorId: string
  projectId: string
  operation: ReportOperation
  reportId: string
}): void {
  const operation = requireOperation(input.operation)
  if (!isNonBlankString(input.actorId)) throw new SubmissionTaskError('UNAUTHENTICATED', '未登录。', 401)
  assertReportForAdmission(input.database, { reportId: input.reportId, projectId: input.projectId })
  if (operation === 'analysis') assertAnalysisQueueCapacity(input.database, input.actorId, input.projectId)
  else assertInsightQueueCapacity(input.database)
}

export function typeSubmissionTaskSnapshot(value: unknown): SubmissionTaskSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.prompts)) return undefined
  const prompts: AnalysisPromptConfig[] = []
  for (const item of value.prompts) {
    const prompt = typePromptConfig(item)
    if (!prompt) return undefined
    prompts.push(prompt)
  }
  const modelRuntime = typeModelRuntimeSnapshot(value.modelRuntime)
  const evaluationContext = parseReportEvaluationContext(value.evaluationContext)
  if (!modelRuntime || !evaluationContext) {
    return undefined
  }
  return { prompts, modelRuntime, evaluationContext }
}

function freezePrompts(database: DatabaseSync, operation: ReportOperation) {
  const prompts = getAiPromptSettingsSnapshotInDatabase(database)
  const frozen = operation === 'insight' ? prompts.filter((prompt) => prompt.target === 'report_insight') : prompts.map((prompt) => ({ ...prompt }))
  for (const prompt of frozen) assertPromptContent(prompt)
  return frozen
}

function freezeEvaluationContext(database: DatabaseSync, reportId: string): ReportEvaluationContext {
  if (!isNonBlankString(reportId)) throw new SubmissionTaskError('REPORT_NOT_FOUND', REPORT_NOT_FOUND_MESSAGE, 404)
  const report = database.prepare(
    'SELECT id, project_id AS projectId, stage_id AS stageId, deleted_at AS deletedAt FROM report_submissions WHERE id = ?',
  ).get(reportId) as { projectId?: unknown; stageId?: unknown; deletedAt?: unknown } | undefined
  if (!report || report.deletedAt) throw new SubmissionTaskError('REPORT_NOT_FOUND', REPORT_NOT_FOUND_MESSAGE, 404)
  if (!isNonBlankString(report.projectId)) {
    throw new SubmissionTaskError('PROJECT_CONTEXT_INCOMPLETE', PROJECT_MISSING_MESSAGE)
  }

  const project = database.prepare(
    'SELECT projects.id, projects.title, projects.objective, projects.description FROM projects INNER JOIN project_report_state ON project_report_state.project_id = projects.id WHERE projects.id = ?',
  ).get(report.projectId) as { id?: unknown; title?: unknown; objective?: unknown; description?: unknown } | undefined
  if (!project || !isNonBlankString(project.id) || !isNonBlankString(project.title)) {
    throw new SubmissionTaskError('PROJECT_CONTEXT_INCOMPLETE', PROJECT_MISSING_MESSAGE)
  }

  if (!isNonBlankString(report.stageId)) {
    throw new SubmissionTaskError('REPORT_STAGE_REQUIRED', '请先为该报告选择所属研究阶段。')
  }

  const stages = database.prepare(
    'SELECT id, title, description, planned_end_at AS plannedEndAt FROM project_stages WHERE project_id = ? ORDER BY ordinal ASC',
  ).all(report.projectId) as Array<{
    id?: unknown
    title?: unknown
    description?: unknown
    plannedEndAt?: unknown
  }>
  const stage = stages.find((item) => item.id === report.stageId)
  if (!stage || !isNonBlankString(stage.id)) {
    throw new SubmissionTaskError('REPORT_STAGE_NOT_FOUND', '报告所属研究阶段已不存在，请重新选择阶段。')
  }

  const researchObjective = typeof project.objective === 'string' ? project.objective.trim() : ''
  const researchBackground = typeof project.description === 'string' ? project.description.trim() : ''
  const milestoneTitle = typeof stage.title === 'string' ? stage.title.trim() : ''
  const targetDate = typeof stage.plannedEndAt === 'string' ? stage.plannedEndAt.trim() : ''
  const workAndExpectedOutcomes = typeof stage.description === 'string' ? stage.description.trim() : ''
  if (!researchObjective || !researchBackground || !milestoneTitle || !targetDate || !workAndExpectedOutcomes) {
    throw new SubmissionTaskError(
      'PROJECT_CONTEXT_INCOMPLETE',
      PROJECT_CONTEXT_INCOMPLETE_MESSAGE,
    )
  }

  const context = parseReportEvaluationContext({
    projectId: project.id,
    projectTitle: project.title.trim(),
    researchObjective,
    researchBackground,
    milestone: {
      id: stage.id,
      title: milestoneTitle,
      targetDate,
      workAndExpectedOutcomes,
    },
  })
  if (!context) {
    throw new SubmissionTaskError(
      'PROJECT_CONTEXT_INCOMPLETE',
      PROJECT_CONTEXT_INCOMPLETE_MESSAGE,
    )
  }
  return context
}

function assertFrozenPromptCompatibility(input: {
  runtime: AiModelRuntimeSnapshot
  prompts: AnalysisPromptConfig[]
  evaluationContext: ReportEvaluationContext
}) {
  const prompt = input.prompts.find((candidate) => candidate.target === input.runtime.target)
  if (!prompt) throw new Error('任务缺少冻结的提示词配置。')
  assertPromptContent(prompt)
  const taskPrompt = input.runtime.target === 'page_analysis'
    ? buildPageAnalysisTaskPrompt({
        instructionPrompt: prompt.instructionPrompt,
        evaluationContext: input.evaluationContext,
        reportFacts: { paragraphCount: Number.MAX_SAFE_INTEGER, characterCount: Number.MAX_SAFE_INTEGER },
      })
    : prompt.instructionPrompt
  createAnalysisPromptPlan({
    target: input.runtime.target,
    systemPrompt: prompt.systemPrompt,
    taskPrompt,
    maxContextCharacters: input.runtime.maxContextCharacters,
    modelLabel: input.runtime.modelName,
  })
}

function assertPromptContent(prompt: AnalysisPromptConfig) {
  if (!prompt.systemPrompt.trim()) throw new Error('系统提示词不能为空。')
  if (!prompt.instructionPrompt.trim()) throw new Error('任务提示词不能为空。')
  if (prompt.systemPrompt.length > MAX_AI_PROMPT_TEXT_LENGTH) throw new Error('系统提示词不能超过 ' + MAX_AI_PROMPT_TEXT_LENGTH + ' 个字符。')
  if (prompt.instructionPrompt.length > MAX_AI_PROMPT_TEXT_LENGTH) throw new Error('任务提示词不能超过 ' + MAX_AI_PROMPT_TEXT_LENGTH + ' 个字符。')
}

function assertReportForAdmission(database: DatabaseSync, input: { reportId: string; projectId: string }) {
  if (!isNonBlankString(input.reportId) || !isNonBlankString(input.projectId)) {
    throw new SubmissionTaskError('REPORT_NOT_FOUND', REPORT_NOT_FOUND_MESSAGE, 404)
  }
  const report = database.prepare(
    'SELECT project_id AS projectId, deleted_at AS deletedAt FROM report_submissions WHERE id = ?',
  ).get(input.reportId) as { projectId?: unknown; deletedAt?: unknown } | undefined
  if (!report || report.deletedAt || report.projectId !== input.projectId) {
    throw new SubmissionTaskError('REPORT_NOT_FOUND', REPORT_NOT_FOUND_MESSAGE, 404)
  }
}

function assertAnalysisQueueCapacity(database: DatabaseSync, actorId: string, projectId: string) {
  const { globalQueueLimit, userQueueLimit, projectQueueLimit } = runtimeConfig.ai
  if (countActiveTasks(database, 'analysis') >= globalQueueLimit) throw new AiQueueFullError()
  if (countActiveTasks(database, 'analysis', { actorId }) >= userQueueLimit) throw new AiQueueFullError()
  if (countActiveTasks(database, 'analysis', { projectId }) >= projectQueueLimit) throw new AiQueueFullError()
}

function assertInsightQueueCapacity(database: DatabaseSync) {
  if (countActiveTasks(database, 'insight') >= runtimeConfig.ai.insightQueueLimit) throw new AiQueueFullError()
}

function countActiveTasks(database: DatabaseSync, operation: ReportOperation, filter: { actorId?: string; projectId?: string } = {}) {
  if (filter.actorId) {
    return countRows(
      database,
      'SELECT COUNT(*) AS count FROM submission_tasks WHERE status IN ' + ACTIVE_TASK_STATUSES + ' AND operation = ? AND actor_id = ?',
      [operation, filter.actorId],
    )
  }
  if (filter.projectId) {
    return countRows(
      database,
      'SELECT COUNT(*) AS count FROM submission_tasks WHERE status IN ' + ACTIVE_TASK_STATUSES + ' AND operation = ? AND project_id = ?',
      [operation, filter.projectId],
    )
  }
  return countRows(
    database,
    'SELECT COUNT(*) AS count FROM submission_tasks WHERE status IN ' + ACTIVE_TASK_STATUSES + ' AND operation = ?',
    [operation],
  )
}

function countRows(database: DatabaseSync, sql: string, params: Array<string | number>) {
  const row = database.prepare(sql).get(...params) as { count?: unknown } | undefined
  const count = Number(row?.count ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('AI 任务计数无效。')
  return count
}

function requireOperation(value: unknown): ReportOperation {
  if (value === 'analysis' || value === 'insight') return value
  throw new Error('任务类型无效。')
}

function typePromptConfig(value: unknown): AnalysisPromptConfig | undefined {
  if (!isRecord(value) || !isAiPromptTarget(value.target) || !isNonBlankString(value.systemPrompt) || !isNonBlankString(value.instructionPrompt)) {
    return undefined
  }
  if (typeof value.updatedAt !== 'string' || typeof value.updatedBy !== 'string') return undefined
  if (!Number.isInteger(value.version) || Number(value.version) <= 0) return undefined
  return {
    target: value.target,
    systemPrompt: value.systemPrompt,
    instructionPrompt: value.instructionPrompt,
    version: Number(value.version),
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
  }
}

function typeModelRuntimeSnapshot(value: unknown): AiModelRuntimeSnapshot | undefined {
  if (!isRecord(value) || !isAiModelSelectionTarget(value.target) || value.channel !== 'chat_completions') return undefined
  if (!isNonBlankString(value.channelId) || !isNonBlankString(value.channelName) || typeof value.baseUrl !== 'string') return undefined
  if (!isNonBlankString(value.modelId) || !isNonBlankString(value.modelName) || !isAiReasoningEffort(value.reasoningEffort)) return undefined
  if (!isValidMaxContextCharacters(value.maxContextCharacters) || !isValidMaxOutputTokens(value.maxOutputTokens)) return undefined
  if (!Number.isSafeInteger(value.settingsRevision) || Number(value.settingsRevision) <= 0) return undefined
  if (value.apiKeyEncrypted !== null && typeof value.apiKeyEncrypted !== 'string') return undefined
  return {
    target: value.target,
    channelId: value.channelId,
    channelName: value.channelName,
    channel: value.channel,
    baseUrl: value.baseUrl,
    apiKeyEncrypted: value.apiKeyEncrypted,
    modelId: value.modelId,
    modelName: value.modelName,
    maxContextCharacters: value.maxContextCharacters,
    maxOutputTokens: value.maxOutputTokens,
    reasoningEffort: value.reasoningEffort,
    settingsRevision: Number(value.settingsRevision),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}



