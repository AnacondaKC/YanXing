import type { ReportSubmissionKind } from '@/modules/reports/submission-domain'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'

export type { ReportSubmissionKind }
export type StageLifecycleStatus = 'not_started' | 'in_progress' | 'completed'
export type StageCompletionReason = 'report_completion' | 'skipped'

export type StageWorkflowErrorCode =
  | 'EMPTY_STAGE_PLAN'
  | 'INVALID_STAGE_PLAN'
  | 'MALFORMED_WORKFLOW'
  | 'INVALID_SUBMISSION'
  | 'INVALID_REPORT_KIND'
  | 'STAGE_NOT_FOUND'
  | 'STAGE_ALREADY_COMPLETED'
  | 'STAGE_COMPLETION_CHANGED'
  | 'PROJECT_PLAN_CHANGED'
  | 'PROJECT_WORKFLOW_CHANGED'
  | 'STAGE_PLAN_FROZEN'
  | 'COUNTER_LIMIT_REACHED'

export interface ProjectStageRecord {
  id: string
  projectId: string
  ordinal: number
  title: string
  description?: string
  plannedStartAt?: string
  plannedEndAt?: string
  lifecycleStatus: StageLifecycleStatus
  startedAt?: string
  completedAt?: string
  completionReason?: StageCompletionReason
  currentCompletionReportId?: string
  nextReportVersion: number
  stateRevision: number
  completionRevision: number
}

export interface ProjectWorkflow {
  projectId: string
  planRevision: number
  workflowRevision: number
  nextSubmissionSequence: number
  completedAt?: string
  stages: readonly ProjectStageRecord[]
}

export interface StagePlanInput {
  id: string
  title: string
  description?: string
  plannedStartAt?: string
  plannedEndAt?: string
}

export interface StageReportSubmissionCommand {
  workflow: ProjectWorkflow
  reportId: string
  stageId: string
  reportKind: ReportSubmissionKind
  submittedAt: string
  expectedPlanRevision: number
  expectedWorkflowRevision: number
  expectedCompletionRevision: number
  expectedCompletionReportId: string | null
}

export interface ReportAllocation {
  stageVersion: number
  submissionSequence: number
}

export type StageWorkflowEvent =
  | {
    type: 'report_submitted'
    stageId: string
    reportId: string
    reportKind: ReportSubmissionKind
    stageVersion: number
    submissionSequence: number
  }
  | { type: 'stage_skipped'; stageId: string; completedAt: string }
  | {
    type: 'stage_completed'
    stageId: string
    reportId: string
    completedAt: string
    reason: 'report_completion'
  }
  | { type: 'stage_opened'; stageId: string; startedAt: string }
  | {
    type: 'completion_superseded'
    stageId: string
    previousReportId: string
    nextReportId: string
  }
  | { type: 'project_completed'; completedAt: string }

export interface StageReportSubmissionResult {
  workflow: ProjectWorkflow
  allocation: ReportAllocation
  events: readonly StageWorkflowEvent[]
  previousCompletionReportId: string | null
}

export const STAGE_FIELD_LIMITS = {
  projectId: PROJECT_FIELD_LIMITS.milestoneId,
  id: PROJECT_FIELD_LIMITS.milestoneId,
  title: PROJECT_FIELD_LIMITS.milestoneTitle,
  description: PROJECT_FIELD_LIMITS.milestoneDescription,
  reportId: PROJECT_FIELD_LIMITS.reportId,
  stages: PROJECT_FIELD_LIMITS.milestones,
} as const

export const INITIAL_STAGE_COUNTER = 1
export const INITIAL_STAGE_REVISION = 0

const IDENTITY_PATTERN = /^[A-Za-z0-9_-]+$/
const LIFECYCLE_STATUSES: ReadonlySet<string> = new Set(['not_started', 'in_progress', 'completed'])
const COMPLETION_REASONS: ReadonlySet<string> = new Set(['report_completion', 'skipped'])

export class StageWorkflowError extends Error {
  constructor(
    readonly code: StageWorkflowErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super(message)
    this.name = 'StageWorkflowError'
  }
}

export function isSafeStageCounter(value: unknown, minimum = INITIAL_STAGE_COUNTER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

export function incrementStageCounter(value: number): number {
  const next = value + 1
  if (!Number.isSafeInteger(next)) {
    throw new StageWorkflowError('COUNTER_LIMIT_REACHED', '计数已达到上限，无法再分配。')
  }
  return next
}

export function isStagePlanFrozen(workflow: ProjectWorkflow): boolean {
  return workflow.nextSubmissionSequence > INITIAL_STAGE_COUNTER
    || workflow.stages.some((stage) => stage.nextReportVersion > INITIAL_STAGE_COUNTER)
}

export function completionPointer(stage: Pick<ProjectStageRecord, 'currentCompletionReportId'>): string | null {
  return stage.currentCompletionReportId ?? null
}

export function sortProjectStages(stages: readonly ProjectStageRecord[]): ProjectStageRecord[] {
  return stages.map(cloneProjectStage).sort((left, right) => left.ordinal - right.ordinal)
}

export function cloneProjectStage(stage: ProjectStageRecord): ProjectStageRecord {
  const copy: ProjectStageRecord = {
    id: stage.id,
    projectId: stage.projectId,
    ordinal: stage.ordinal,
    title: stage.title,
    lifecycleStatus: stage.lifecycleStatus,
    nextReportVersion: stage.nextReportVersion,
    stateRevision: stage.stateRevision,
    completionRevision: stage.completionRevision,
  }
  if (stage.description !== undefined) copy.description = stage.description
  if (stage.plannedStartAt !== undefined) copy.plannedStartAt = stage.plannedStartAt
  if (stage.plannedEndAt !== undefined) copy.plannedEndAt = stage.plannedEndAt
  if (stage.startedAt !== undefined) copy.startedAt = stage.startedAt
  if (stage.completedAt !== undefined) copy.completedAt = stage.completedAt
  if (stage.completionReason !== undefined) copy.completionReason = stage.completionReason
  if (stage.currentCompletionReportId !== undefined) copy.currentCompletionReportId = stage.currentCompletionReportId
  return copy
}

export function cloneProjectWorkflow(workflow: ProjectWorkflow): ProjectWorkflow {
  const copy: ProjectWorkflow = {
    projectId: workflow.projectId,
    planRevision: workflow.planRevision,
    workflowRevision: workflow.workflowRevision,
    nextSubmissionSequence: workflow.nextSubmissionSequence,
    stages: workflow.stages.map(cloneProjectStage),
  }
  if (workflow.completedAt !== undefined) copy.completedAt = workflow.completedAt
  return copy
}

export function freezeProjectWorkflow(workflow: ProjectWorkflow): ProjectWorkflow {
  const copy = cloneProjectWorkflow(workflow)
  return Object.freeze({
    ...copy,
    stages: Object.freeze(sortProjectStages(copy.stages).map((stage) => Object.freeze(stage))),
  })
}

function withPlanMetadata(stage: ProjectStageRecord, input: StagePlanInput): ProjectStageRecord {
  const next = cloneProjectStage(stage)
  next.title = input.title.trim()
  const description = optionalDescription(input.description, '阶段说明超过字数限制。')
  const plannedStartAt = optionalPlanDate(input.plannedStartAt, '计划开始日期无效。')
  const plannedEndAt = optionalPlanDate(input.plannedEndAt, '计划完成日期无效。')
  delete next.description
  delete next.plannedStartAt
  delete next.plannedEndAt
  if (description) next.description = description
  if (plannedStartAt) next.plannedStartAt = plannedStartAt
  if (plannedEndAt) next.plannedEndAt = plannedEndAt
  return next
}

export function initializeStageWorkflow(input: {
  projectId: string
  stages: readonly StagePlanInput[]
  startedAt: string
}): ProjectWorkflow {
  const projectId = normalizePlanIdentity(input.projectId, STAGE_FIELD_LIMITS.projectId, '课题编号无效。')
  assertValidStagePlan(input.stages)
  assertIsoTimestamp(input.startedAt, 'INVALID_STAGE_PLAN', '阶段开始时间无效。')

  const stages = input.stages.map((stage, index) => {
    const record = withPlanMetadata({
      id: stage.id.trim(),
      projectId,
      ordinal: index + 1,
      title: stage.title.trim(),
      lifecycleStatus: index === 0 ? 'in_progress' : 'not_started',
      nextReportVersion: INITIAL_STAGE_COUNTER,
      stateRevision: INITIAL_STAGE_REVISION,
      completionRevision: INITIAL_STAGE_REVISION,
    }, stage)
    if (index === 0) record.startedAt = input.startedAt
    return record
  })

  return freezeProjectWorkflow({
    projectId,
    planRevision: INITIAL_STAGE_REVISION,
    workflowRevision: INITIAL_STAGE_REVISION,
    nextSubmissionSequence: INITIAL_STAGE_COUNTER,
    stages,
  })
}

export function assertStagePlanEdit(input: {
  workflow: ProjectWorkflow
  nextStages: readonly StagePlanInput[]
  editedAt: string
}): ProjectWorkflow {
  assertValidStageWorkflow(input.workflow)
  assertIsoTimestamp(input.editedAt, 'INVALID_STAGE_PLAN', '计划编辑时间无效。')
  assertValidStagePlan(input.nextStages)

  const currentIds = sortProjectStages(input.workflow.stages).map((stage) => stage.id)
  const nextIds = input.nextStages.map((stage) => stage.id.trim())
  const structureChanged = currentIds.length !== nextIds.length
    || currentIds.some((id, index) => id !== nextIds[index])

  if (isStagePlanFrozen(input.workflow) && structureChanged) {
    throw new StageWorkflowError('STAGE_PLAN_FROZEN', '已有正式提交后不能增删或重排研究阶段。')
  }

  const planRevision = incrementStageCounter(input.workflow.planRevision)
  if (!structureChanged) {
    const edits = new Map(input.nextStages.map((stage) => [stage.id.trim(), stage]))
    return freezeProjectWorkflow({
      ...cloneProjectWorkflow(input.workflow),
      planRevision,
      stages: sortProjectStages(input.workflow.stages).map((stage) => withPlanMetadata(stage, edits.get(stage.id) ?? stage)),
    })
  }

  return freezeProjectWorkflow({
    ...cloneProjectWorkflow(initializeStageWorkflow({
      projectId: input.workflow.projectId,
      stages: input.nextStages,
      startedAt: input.editedAt,
    })),
    planRevision,
  })
}

export function assertValidStageWorkflow(workflow: ProjectWorkflow): void {
  if (!isRecord(workflow)) throw malformedWorkflow('课题阶段流程无效。')
  const projectId = requireIdentity(workflow.projectId, STAGE_FIELD_LIMITS.projectId, '课题编号无效。')
  if (!Array.isArray(workflow.stages) || workflow.stages.length === 0) throw malformedWorkflow('研究阶段不能为空。')
  if (workflow.stages.length > STAGE_FIELD_LIMITS.stages) {
    throw malformedWorkflow('研究阶段不能超过 ' + STAGE_FIELD_LIMITS.stages + ' 个。')
  }
  if (!isSafeStageCounter(workflow.planRevision, INITIAL_STAGE_REVISION)
    || !isSafeStageCounter(workflow.workflowRevision, INITIAL_STAGE_REVISION)
    || !isSafeStageCounter(workflow.nextSubmissionSequence)) {
    throw malformedWorkflow('流程计数无效。')
  }

  const ids = new Set<string>()
  const ordinals = new Set<number>()
  for (const stage of workflow.stages) assertPersistedStage({ stage, projectId, ids, ordinals })

  const ordered = sortProjectStages(workflow.stages)
  const allocatedReports = ordered.reduce((sum, stage) => sum + (stage.nextReportVersion - INITIAL_STAGE_COUNTER), 0)
  if (allocatedReports !== workflow.nextSubmissionSequence - INITIAL_STAGE_COUNTER) {
    throw malformedWorkflow('课题提交序列与阶段版本分配不一致。')
  }
  const firstActive = ordered.findIndex((stage) => stage.lifecycleStatus !== 'completed')
  if (firstActive === -1) {
    if (!isIsoTimestamp(workflow.completedAt)) throw malformedWorkflow('课题完成时间无效。')
    const latestCompletion = ordered.reduce((latest, stage) => Math.max(latest, Date.parse(stage.completedAt!)), 0)
    if (Date.parse(workflow.completedAt) < latestCompletion) throw malformedWorkflow('课题完成时间早于阶段完成时间。')
    return
  }
  if (workflow.completedAt !== undefined) throw malformedWorkflow('未完成课题不能带有完成时间。')
  if (ordered[firstActive]?.lifecycleStatus !== 'in_progress') {
    throw malformedWorkflow('须先连续完成前序阶段，再保持一个进行中阶段。')
  }
  if (ordered.slice(firstActive + 1).some((stage) => stage.lifecycleStatus !== 'not_started')) {
    throw malformedWorkflow('进行中阶段之后只能是未开始阶段。')
  }
}

export function assertValidStagePlan(stages: readonly StagePlanInput[]): void {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new StageWorkflowError('EMPTY_STAGE_PLAN', '请至少创建一个研究阶段。')
  }
  if (stages.length > STAGE_FIELD_LIMITS.stages) {
    throw new StageWorkflowError('INVALID_STAGE_PLAN', '研究阶段不能超过 ' + STAGE_FIELD_LIMITS.stages + ' 个。')
  }

  const ids = new Set<string>()
  stages.forEach((stage, index) => {
    if (!isRecord(stage)) throw invalidStagePlan('阶段 ' + (index + 1) + ' 无效。')
    const id = typeof stage.id === 'string' ? stage.id.trim() : ''
    const title = typeof stage.title === 'string' ? stage.title.trim() : ''
    if (!isIdentity(id, STAGE_FIELD_LIMITS.id) || ids.has(id)) {
      throw invalidStagePlan('阶段 ' + (index + 1) + ' 的编号为空、过长、格式无效或重复。')
    }
    ids.add(id)
    if (!title) throw invalidStagePlan('请填写阶段 ' + (index + 1) + ' 的阶段名称。')
    if (title.length > STAGE_FIELD_LIMITS.title) throw invalidStagePlan('阶段 ' + (index + 1) + ' 的名称超过字数限制。')
    optionalDescription(stage.description, '阶段 ' + (index + 1) + ' 的工作内容超过字数限制。')
    const plannedStartAt = optionalPlanDate(stage.plannedStartAt, '阶段 ' + (index + 1) + ' 的计划开始日期无效。')
    const plannedEndAt = optionalPlanDate(stage.plannedEndAt, '阶段 ' + (index + 1) + ' 的计划完成日期无效。')
    if (plannedStartAt && plannedEndAt && plannedStartAt > plannedEndAt) {
      throw invalidStagePlan('阶段 ' + (index + 1) + ' 的计划开始日期不能晚于完成日期。')
    }
  })
}

function assertPersistedStage(input: {
  stage: ProjectStageRecord
  projectId: string
  ids: Set<string>
  ordinals: Set<number>
}) {
  const { stage, projectId, ids, ordinals } = input
  if (!isRecord(stage)) throw malformedWorkflow('阶段记录无效。')
  const id = requireIdentity(stage.id, STAGE_FIELD_LIMITS.id, '阶段编号无效。')
  if (ids.has(id)) throw malformedWorkflow('阶段编号重复。')
  ids.add(id)
  if (stage.projectId !== projectId) throw malformedWorkflow('阶段不属于当前课题。')
  if (!isSafeStageCounter(stage.ordinal) || ordinals.has(stage.ordinal)) throw malformedWorkflow('阶段顺序无效或重复。')
  ordinals.add(stage.ordinal)
  if (typeof stage.title !== 'string' || !stage.title.trim() || stage.title.trim().length > STAGE_FIELD_LIMITS.title) {
    throw malformedWorkflow('阶段名称无效。')
  }
  if (stage.description !== undefined && !isValidDescription(stage.description)) throw malformedWorkflow('阶段说明无效。')
  if (!isValidPersistedPlanSchedule(stage)) throw malformedWorkflow('阶段计划排期无效。')
  if (!LIFECYCLE_STATUSES.has(stage.lifecycleStatus)) throw malformedWorkflow('阶段状态无效。')
  if (!isSafeStageCounter(stage.nextReportVersion)
    || !isSafeStageCounter(stage.stateRevision, INITIAL_STAGE_REVISION)
    || !isSafeStageCounter(stage.completionRevision, INITIAL_STAGE_REVISION)) {
    throw malformedWorkflow('阶段计数无效。')
  }

  const pointer = stage.currentCompletionReportId
  if (pointer !== undefined && !isIdentity(pointer, STAGE_FIELD_LIMITS.reportId)) throw malformedWorkflow('阶段完结报告引用无效。')
  if (pointer !== undefined && stage.nextReportVersion < 2) throw malformedWorkflow('完结报告引用与阶段版本计数不一致。')

  if (stage.lifecycleStatus === 'not_started') {
    if (hasProgressFields(stage) || stage.nextReportVersion !== INITIAL_STAGE_COUNTER) {
      throw malformedWorkflow('未开始阶段不能带有进度、成果或已分配版本。')
    }
    return
  }
  if (stage.lifecycleStatus === 'in_progress') {
    if (!isIsoTimestamp(stage.startedAt)) throw malformedWorkflow('进行中阶段缺少开始时间。')
    if (stage.completedAt !== undefined || stage.completionReason !== undefined || pointer !== undefined) {
      throw malformedWorkflow('进行中阶段不能带有完成信息。')
    }
    return
  }
  if (!isIsoTimestamp(stage.completedAt) || !stage.completionReason || !COMPLETION_REASONS.has(stage.completionReason)) {
    throw malformedWorkflow('已完成阶段缺少完成时间或原因。')
  }
  if (stage.startedAt !== undefined && !isIsoTimestamp(stage.startedAt)) throw malformedWorkflow('阶段开始时间无效。')
  if (stage.startedAt !== undefined && Date.parse(stage.completedAt) < Date.parse(stage.startedAt)) {
    throw malformedWorkflow('阶段完成时间早于开始时间。')
  }
  if (stage.completionReason === 'report_completion' && (!isIsoTimestamp(stage.startedAt) || pointer === undefined)) {
    throw malformedWorkflow('报告完结的阶段必须有开始时间和完结报告。')
  }
}

function hasProgressFields(stage: ProjectStageRecord) {
  return stage.startedAt !== undefined
    || stage.completedAt !== undefined
    || stage.completionReason !== undefined
    || stage.currentCompletionReportId !== undefined
}

function normalizePlanIdentity(value: string, maxLength: number, message: string) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!isIdentity(normalized, maxLength)) throw new StageWorkflowError('INVALID_STAGE_PLAN', message)
  return normalized
}

function requireIdentity(value: unknown, maxLength: number, message: string) {
  if (typeof value !== 'string' || !isIdentity(value, maxLength)) throw malformedWorkflow(message)
  return value
}

function optionalPlanDate(value: unknown, message: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidStagePlan(message)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (!isPlanDate(trimmed)) throw invalidStagePlan(message)
  return trimmed
}

function optionalDescription(value: unknown, message: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidStagePlan(message)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > STAGE_FIELD_LIMITS.description) throw invalidStagePlan(message)
  return trimmed
}

function isValidDescription(value: string) {
  return value.trim() === value && value.length > 0 && value.length <= STAGE_FIELD_LIMITS.description
}

function isValidPersistedPlanSchedule(stage: ProjectStageRecord) {
  const start = stage.plannedStartAt
  const end = stage.plannedEndAt
  if (start !== undefined && !isPlanDate(start)) return false
  if (end !== undefined && !isPlanDate(end)) return false
  return !(start && end && start > end)
}

function isPlanDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
}

export function assertIsoTimestamp(value: unknown, code: StageWorkflowErrorCode, message: string) {
  if (!isIsoTimestamp(value)) throw new StageWorkflowError(code, message)
}

export function isIdentity(value: string, maxLength: number) {
  return IDENTITY_PATTERN.test(value) && value.length <= maxLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformedWorkflow(message: string) {
  return new StageWorkflowError('MALFORMED_WORKFLOW', message)
}

function invalidStagePlan(message: string) {
  return new StageWorkflowError('INVALID_STAGE_PLAN', message)
}
