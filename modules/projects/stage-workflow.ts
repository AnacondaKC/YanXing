import type { ReportSubmissionKind } from '@/modules/reports/submission-domain'
import {
  STAGE_FIELD_LIMITS,
  StageWorkflowError,
  assertIsoTimestamp,
  assertValidStageWorkflow,
  cloneProjectWorkflow,
  completionPointer,
  freezeProjectWorkflow,
  incrementStageCounter,
  isIdentity,
  isSafeStageCounter,
  sortProjectStages,
  type ProjectStageRecord,
  type ProjectWorkflow,
  type StageReportSubmissionCommand,
  type StageReportSubmissionResult,
  type StageWorkflowEvent,
} from '@/modules/projects/stage-domain'

export function planStageReportSubmission(command: StageReportSubmissionCommand): StageReportSubmissionResult {
  assertValidStageWorkflow(command.workflow)
  assertSubmissionCommand(command)

  const workflow = cloneProjectWorkflow(command.workflow)
  const stages = sortProjectStages(workflow.stages)
  const targetIndex = stages.findIndex((stage) => stage.id === command.stageId.trim())
  if (targetIndex < 0) throw new StageWorkflowError('STAGE_NOT_FOUND', '所选研究阶段不存在。')

  const target = stages[targetIndex]
  const currentIndex = stages.findIndex((stage) => stage.lifecycleStatus === 'in_progress')
  const action = classifySubmission({ target, reportKind: command.reportKind, targetIndex, currentIndex })
  assertSubmissionTokens({ command, workflow, target, action })

  const stageVersion = target.nextReportVersion
  const submissionSequence = workflow.nextSubmissionSequence
  const nextReportVersion = incrementStageCounter(stageVersion)
  const nextSubmissionSequence = incrementStageCounter(submissionSequence)
  const events: StageWorkflowEvent[] = [{
    type: 'report_submitted',
    stageId: target.id,
    reportId: command.reportId.trim(),
    reportKind: command.reportKind,
    stageVersion,
    submissionSequence,
  }]
  const previousCompletionReportId = completionPointer(target)
  stages[targetIndex] = { ...target, nextReportVersion }

  let progressChanged = false
  if (action === 'backfill_completion') {
    applyCompletionPointer({ stages, targetIndex, reportId: command.reportId.trim(), events, previousCompletionReportId })
  } else {
    progressChanged = skipIncompleteStages({ stages, targetIndex, submittedAt: command.submittedAt, events })
    if (action === 'forward_update' || action === 'current_update') {
      progressChanged = openStage({ stages, index: targetIndex, submittedAt: command.submittedAt, events }) || progressChanged
    } else {
      progressChanged = completeStage({
        stages,
        index: targetIndex,
        reportId: command.reportId.trim(),
        submittedAt: command.submittedAt,
        events,
      }) || progressChanged
      progressChanged = openNextOrCompleteProject({
        stages,
        completedIndex: targetIndex,
        submittedAt: command.submittedAt,
        workflow,
        events,
      }) || progressChanged
    }
  }

  const result = freezeProjectWorkflow({
    ...workflow,
    nextSubmissionSequence,
    workflowRevision: progressChanged ? incrementStageCounter(workflow.workflowRevision) : workflow.workflowRevision,
    stages,
  })
  assertValidStageWorkflow(result)
  return { workflow: result, allocation: { stageVersion, submissionSequence }, events, previousCompletionReportId }
}

type SubmissionAction = 'current_update' | 'forward_update' | 'forward_completion' | 'backfill_completion'

function classifySubmission(input: {
  target: ProjectStageRecord
  reportKind: ReportSubmissionKind
  targetIndex: number
  currentIndex: number
}): SubmissionAction {
  if (input.reportKind !== 'update' && input.reportKind !== 'completion') {
    throw new StageWorkflowError('INVALID_REPORT_KIND', '请选择阶段更新或阶段完结。')
  }
  if (input.target.lifecycleStatus === 'completed') {
    if (input.reportKind === 'update') {
      throw new StageWorkflowError('STAGE_ALREADY_COMPLETED', '已完成阶段不能提交普通更新报告。')
    }
    return 'backfill_completion'
  }
  if (input.reportKind === 'update') return input.targetIndex === input.currentIndex ? 'current_update' : 'forward_update'
  return 'forward_completion'
}

function assertSubmissionTokens(input: {
  command: StageReportSubmissionCommand
  workflow: ProjectWorkflow
  target: ProjectStageRecord
  action: SubmissionAction
}) {
  const { command, workflow, target, action } = input
  if (command.expectedPlanRevision !== workflow.planRevision) {
    throw new StageWorkflowError('PROJECT_PLAN_CHANGED', '研究计划已更新，请刷新后重试。', {
      expectedPlanRevision: command.expectedPlanRevision,
      actualPlanRevision: workflow.planRevision,
    })
  }
  if (isForwardAction(action) && command.expectedWorkflowRevision !== workflow.workflowRevision) {
    throw new StageWorkflowError('PROJECT_WORKFLOW_CHANGED', '课题阶段进度已变化，请刷新后重试。', {
      expectedWorkflowRevision: command.expectedWorkflowRevision,
      actualWorkflowRevision: workflow.workflowRevision,
    })
  }
  if (command.reportKind !== 'completion') return
  const actualPointer = completionPointer(target)
  if (command.expectedCompletionRevision !== target.completionRevision || command.expectedCompletionReportId !== actualPointer) {
    throw new StageWorkflowError('STAGE_COMPLETION_CHANGED', '阶段成果已更新，请确认是否继续补交。', {
      expectedCompletionRevision: command.expectedCompletionRevision,
      actualCompletionRevision: target.completionRevision,
      expectedCompletionReportId: command.expectedCompletionReportId,
      actualCompletionReportId: actualPointer,
    })
  }
}

function isForwardAction(action: SubmissionAction) {
  return action === 'forward_update' || action === 'forward_completion'
}

function skipIncompleteStages(input: {
  stages: ProjectStageRecord[]
  targetIndex: number
  submittedAt: string
  events: StageWorkflowEvent[]
}) {
  let changed = false
  for (let index = 0; index < input.targetIndex; index += 1) {
    const stage = input.stages[index]
    if (!stage || stage.lifecycleStatus === 'completed') continue
    input.stages[index] = {
      ...stage,
      lifecycleStatus: 'completed',
      completedAt: input.submittedAt,
      completionReason: 'skipped',
      stateRevision: incrementStageCounter(stage.stateRevision),
    }
    input.events.push({ type: 'stage_skipped', stageId: stage.id, completedAt: input.submittedAt })
    changed = true
  }
  return changed
}

function openStage(input: {
  stages: ProjectStageRecord[]
  index: number
  submittedAt: string
  events: StageWorkflowEvent[]
}) {
  const stage = input.stages[input.index]
  if (!stage || stage.lifecycleStatus === 'in_progress') return false
  input.stages[input.index] = {
    ...stage,
    lifecycleStatus: 'in_progress',
    startedAt: input.submittedAt,
    stateRevision: incrementStageCounter(stage.stateRevision),
  }
  input.events.push({ type: 'stage_opened', stageId: stage.id, startedAt: input.submittedAt })
  return true
}

function completeStage(input: {
  stages: ProjectStageRecord[]
  index: number
  reportId: string
  submittedAt: string
  events: StageWorkflowEvent[]
}) {
  const stage = input.stages[input.index]
  if (!stage || stage.lifecycleStatus === 'completed') return false
  input.stages[input.index] = {
    ...stage,
    lifecycleStatus: 'completed',
    startedAt: stage.startedAt ?? input.submittedAt,
    completedAt: input.submittedAt,
    completionReason: 'report_completion',
    currentCompletionReportId: input.reportId,
    completionRevision: incrementStageCounter(stage.completionRevision),
    stateRevision: incrementStageCounter(stage.stateRevision),
  }
  input.events.push({
    type: 'stage_completed',
    stageId: stage.id,
    reportId: input.reportId,
    completedAt: input.submittedAt,
    reason: 'report_completion',
  })
  return true
}

function applyCompletionPointer(input: {
  stages: ProjectStageRecord[]
  targetIndex: number
  reportId: string
  events: StageWorkflowEvent[]
  previousCompletionReportId: string | null
}) {
  const stage = input.stages[input.targetIndex]
  if (!stage) return
  input.stages[input.targetIndex] = {
    ...stage,
    currentCompletionReportId: input.reportId,
    completionRevision: incrementStageCounter(stage.completionRevision),
  }
  if (!input.previousCompletionReportId) return
  input.events.push({
    type: 'completion_superseded',
    stageId: stage.id,
    previousReportId: input.previousCompletionReportId,
    nextReportId: input.reportId,
  })
}

function openNextOrCompleteProject(input: {
  stages: ProjectStageRecord[]
  completedIndex: number
  submittedAt: string
  workflow: ProjectWorkflow
  events: StageWorkflowEvent[]
}) {
  const nextIndex = input.completedIndex + 1
  if (nextIndex < input.stages.length) {
    return openStage({ stages: input.stages, index: nextIndex, submittedAt: input.submittedAt, events: input.events })
  }
  input.workflow.completedAt = input.submittedAt
  input.events.push({ type: 'project_completed', completedAt: input.submittedAt })
  return true
}

function assertSubmissionCommand(command: StageReportSubmissionCommand) {
  requireCommandIdentity(command.reportId, STAGE_FIELD_LIMITS.reportId, '报告编号无效。')
  requireCommandIdentity(command.stageId, STAGE_FIELD_LIMITS.id, '阶段编号无效。')
  assertIsoTimestamp(command.submittedAt, 'INVALID_SUBMISSION', '提交时间无效。')
  if (!isSafeStageCounter(command.expectedPlanRevision, 0)
    || !isSafeStageCounter(command.expectedWorkflowRevision, 0)
    || !isSafeStageCounter(command.expectedCompletionRevision, 0)) {
    throw new StageWorkflowError('INVALID_SUBMISSION', '并发版本令牌无效。')
  }
  if (command.expectedCompletionReportId !== null && !isCommandIdentity(command.expectedCompletionReportId, STAGE_FIELD_LIMITS.reportId)) {
    throw new StageWorkflowError('INVALID_SUBMISSION', '完结报告令牌无效。')
  }
}

function requireCommandIdentity(value: unknown, maxLength: number, message: string) {
  if (!isCommandIdentity(value, maxLength)) throw new StageWorkflowError('INVALID_SUBMISSION', message)
  return value
}

function isCommandIdentity(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() === value && isIdentity(value, maxLength)
}
