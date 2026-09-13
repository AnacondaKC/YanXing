import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STAGE_FIELD_LIMITS,
  StageWorkflowError,
  assertStagePlanEdit,
  assertValidStageWorkflow,
  initializeStageWorkflow,
  isStagePlanFrozen,
  planStageReportSubmission,
  type ProjectWorkflow,
  type StagePlanInput,
  type StageReportSubmissionCommand,
  type StageWorkflowErrorCode,
} from '../modules/projects/stage-workflow'

const STARTED_AT = '2026-03-01T00:00:00.000Z'
const T1 = '2026-03-02T00:00:00.000Z'
const T2 = '2026-03-03T00:00:00.000Z'
const T3 = '2026-03-04T00:00:00.000Z'

function planStages(): StagePlanInput[] {
  return [
    { id: 'stage-1', title: '开题研究', description: '完成开题', plannedStartAt: '2026-03-01', plannedEndAt: '2026-03-15' },
    { id: 'stage-2', title: '调研分析', description: '完成调研', plannedStartAt: '2026-03-16', plannedEndAt: '2026-03-31' },
    { id: 'stage-3', title: '结论交付', description: '完成结题', plannedStartAt: '2026-04-01', plannedEndAt: '2026-04-15' },
  ]
}

function init() {
  return initializeStageWorkflow({ projectId: 'project-1', stages: planStages(), startedAt: STARTED_AT })
}

function submit(workflow: ProjectWorkflow, overrides: Partial<StageReportSubmissionCommand> & Pick<StageReportSubmissionCommand, 'reportId'>) {
  const stageId = overrides.stageId ?? workflow.stages.find((stage) => stage.lifecycleStatus === 'in_progress')?.id
  const stage = workflow.stages.find((item) => item.id === stageId)
  assert.ok(stageId && stage, 'target stage')
  return planStageReportSubmission({
    workflow,
    stageId,
    reportKind: 'update',
    submittedAt: T1,
    expectedPlanRevision: workflow.planRevision,
    expectedWorkflowRevision: workflow.workflowRevision,
    expectedCompletionRevision: stage.completionRevision,
    expectedCompletionReportId: stage.currentCompletionReportId ?? null,
    ...overrides,
    reportId: overrides.reportId,
  })
}

function throwsCode(code: StageWorkflowErrorCode) {
  return (error: unknown) => error instanceof StageWorkflowError && error.code === code
}

function statuses(workflow: ProjectWorkflow) {
  return workflow.stages.map((stage) => stage.lifecycleStatus)
}

test('initialize starts the first stage and rejects an empty plan', () => {
  const workflow = init()
  assert.equal(workflow.planRevision, 0)
  assert.equal(workflow.workflowRevision, 0)
  assert.equal(workflow.nextSubmissionSequence, 1)
  assert.deepEqual(statuses(workflow), ['in_progress', 'not_started', 'not_started'])
  assert.equal(workflow.stages[0]?.startedAt, STARTED_AT)
  assert.equal(workflow.stages[0]?.plannedStartAt, '2026-03-01')
  assert.equal(workflow.stages[2]?.plannedEndAt, '2026-04-15')
  assert.equal(isStagePlanFrozen(workflow), false)
  assert.throws(() => initializeStageWorkflow({ projectId: 'project-1', stages: [], startedAt: STARTED_AT }), throwsCode('EMPTY_STAGE_PLAN'))
})

test('AT-01 current-stage updates keep progress and allocate unused versions', () => {
  const first = submit(init(), { reportId: 'report-1' })
  const second = submit(first.workflow, { reportId: 'report-2', submittedAt: T2 })
  assert.deepEqual(first.allocation, { stageVersion: 1, submissionSequence: 1 })
  assert.deepEqual(second.allocation, { stageVersion: 2, submissionSequence: 2 })
  assert.deepEqual(statuses(second.workflow), ['in_progress', 'not_started', 'not_started'])
  assert.equal(second.workflow.workflowRevision, 0)
  assert.equal(second.workflow.stages[0]?.nextReportVersion, 3)
  assert.equal(second.workflow.nextSubmissionSequence, 3)
  assert.equal(isStagePlanFrozen(second.workflow), true)
})

test('AT-02 current completion finishes the stage and opens the next', () => {
  const result = submit(init(), { reportId: 'report-c1', reportKind: 'completion' })
  assert.deepEqual(statuses(result.workflow), ['completed', 'in_progress', 'not_started'])
  assert.equal(result.workflow.stages[0]?.completionReason, 'report_completion')
  assert.equal(result.workflow.stages[0]?.currentCompletionReportId, 'report-c1')
  assert.equal(result.workflow.stages[0]?.completedAt, T1)
  assert.equal(result.workflow.stages[1]?.startedAt, T1)
  assert.equal(result.workflow.workflowRevision, 1)
  assert.deepEqual(result.events.map((event) => event.type), ['report_submitted', 'stage_completed', 'stage_opened'])
})

test('AT-03 jump update skips earlier incomplete stages and preserves report refs', () => {
  const updated = submit(init(), { reportId: 'report-keep' })
  const jumped = submit(updated.workflow, { reportId: 'report-s3', stageId: 'stage-3', submittedAt: T2 })
  assert.deepEqual(statuses(jumped.workflow), ['completed', 'completed', 'in_progress'])
  assert.equal(jumped.workflow.stages[0]?.completionReason, 'skipped')
  assert.equal(jumped.workflow.stages[0]?.currentCompletionReportId, undefined)
  assert.equal(jumped.workflow.stages[0]?.nextReportVersion, 2)
  assert.equal(jumped.workflow.stages[1]?.completionReason, 'skipped')
  assert.equal(jumped.workflow.stages[1]?.currentCompletionReportId, undefined)
  assert.equal(jumped.workflow.stages[2]?.lifecycleStatus, 'in_progress')
  assert.deepEqual(jumped.allocation, { stageVersion: 1, submissionSequence: 2 })
})

test('AT-04 jump completion of the last stage completes the project', () => {
  const result = submit(init(), { reportId: 'report-final', reportKind: 'completion', stageId: 'stage-3' })
  assert.deepEqual(statuses(result.workflow), ['completed', 'completed', 'completed'])
  assert.equal(result.workflow.completedAt, T1)
  assert.equal(result.workflow.stages[0]?.completionReason, 'skipped')
  assert.equal(result.workflow.stages[2]?.completionReason, 'report_completion')
  assert.equal(result.workflow.stages[2]?.startedAt, T1)
  assert.equal(result.workflow.stages[2]?.currentCompletionReportId, 'report-final')
  assert.equal(result.workflow.stages.some((stage) => stage.lifecycleStatus === 'in_progress'), false)
})

test('AT-05 completed-stage update is rejected without consuming versions', () => {
  const completed = submit(init(), { reportId: 'report-c1', reportKind: 'completion' })
  const before = JSON.stringify(completed.workflow)
  assert.throws(
    () => submit(completed.workflow, { reportId: 'report-u2', stageId: 'stage-1', reportKind: 'update' }),
    throwsCode('STAGE_ALREADY_COMPLETED'),
  )
  assert.equal(JSON.stringify(completed.workflow), before)
  assert.equal(completed.workflow.stages[0]?.nextReportVersion, 2)
})

test('AT-06 completed-stage completion only replaces the pointer and completion revision', () => {
  const completed = submit(init(), { reportId: 'report-old', reportKind: 'completion', submittedAt: T1 })
  const stageOne = completed.workflow.stages[0]
  assert.ok(stageOne)
  const backfill = submit(completed.workflow, {
    reportId: 'report-new',
    stageId: 'stage-1',
    reportKind: 'completion',
    submittedAt: T3,
    expectedWorkflowRevision: 0,
  })
  const next = backfill.workflow.stages[0]
  assert.ok(next)
  assert.equal(backfill.previousCompletionReportId, 'report-old')
  assert.equal(next.currentCompletionReportId, 'report-new')
  assert.equal(next.completedAt, stageOne.completedAt)
  assert.equal(next.completionReason, 'report_completion')
  assert.equal(next.startedAt, stageOne.startedAt)
  assert.equal(next.stateRevision, stageOne.stateRevision)
  assert.equal(next.completionRevision, stageOne.completionRevision + 1)
  assert.equal(backfill.workflow.workflowRevision, completed.workflow.workflowRevision)
  assert.equal(backfill.workflow.stages[1]?.lifecycleStatus, 'in_progress')
  assert.equal(backfill.events.some((event) => event.type === 'completion_superseded'), true)
})

test('AT-07 skipped stage first completion allocates V1 and keeps skip history', () => {
  const jumped = submit(init(), { reportId: 'report-s3', stageId: 'stage-3' })
  const skippedAt = jumped.workflow.stages[1]?.completedAt
  const backfill = submit(jumped.workflow, { reportId: 'report-s2', stageId: 'stage-2', reportKind: 'completion', submittedAt: T2 })
  const stageTwo = backfill.workflow.stages[1]
  assert.ok(stageTwo)
  assert.deepEqual(backfill.allocation, { stageVersion: 1, submissionSequence: 2 })
  assert.equal(stageTwo.currentCompletionReportId, 'report-s2')
  assert.equal(stageTwo.completionReason, 'skipped')
  assert.equal(stageTwo.completedAt, skippedAt)
  assert.equal(backfill.workflow.stages[2]?.lifecycleStatus, 'in_progress')
  assert.equal(backfill.previousCompletionReportId, null)
})

test('AT-12 concurrent completion tokens including null conflict before mutation', () => {
  const first = submit(init(), { reportId: 'report-a', reportKind: 'completion' })
  assert.equal(first.previousCompletionReportId, null)
  assert.throws(
    () => submit(first.workflow, {
      reportId: 'report-b',
      stageId: 'stage-1',
      reportKind: 'completion',
      expectedCompletionRevision: 0,
      expectedCompletionReportId: null,
    }),
    throwsCode('STAGE_COMPLETION_CHANGED'),
  )
})

test('AT-13 forward commands check workflow revision; current updates and backfill do not', () => {
  const firstUpdate = submit(init(), { reportId: 'report-u1' })
  const secondUpdate = submit(firstUpdate.workflow, {
    reportId: 'report-u2',
    submittedAt: T2,
    expectedWorkflowRevision: 0,
  })
  assert.equal(secondUpdate.workflow.workflowRevision, 0)

  const completion = submit(secondUpdate.workflow, { reportId: 'report-c1', reportKind: 'completion', submittedAt: T2 })
  assert.throws(
    () => submit(completion.workflow, { reportId: 'report-late', stageId: 'stage-1', reportKind: 'update', submittedAt: T3 }),
    throwsCode('STAGE_ALREADY_COMPLETED'),
  )

  const jumped = submit(init(), { reportId: 'report-j2', stageId: 'stage-2' })
  assert.throws(
    () => submit(jumped.workflow, {
      reportId: 'report-j3',
      stageId: 'stage-3',
      expectedWorkflowRevision: 0,
    }),
    throwsCode('PROJECT_WORKFLOW_CHANGED'),
  )

  const backfill = submit(completion.workflow, {
    reportId: 'report-c2',
    stageId: 'stage-1',
    reportKind: 'completion',
    submittedAt: T3,
    expectedWorkflowRevision: 0,
  })
  assert.equal(backfill.workflow.workflowRevision, completion.workflow.workflowRevision)
  assert.equal(backfill.workflow.stages[1]?.lifecycleStatus, 'in_progress')
})

test('malformed workflows are rejected and inputs stay immutable', () => {
  const workflow = init()
  const snapshot = JSON.stringify(workflow)
  Object.freeze(workflow)
  Object.freeze(workflow.stages)
  workflow.stages.forEach((stage) => Object.freeze(stage))
  submit(workflow, { reportId: 'report-1' })
  assert.equal(JSON.stringify(workflow), snapshot)

  const parsed = JSON.parse(snapshot) as ProjectWorkflow
  assert.throws(
    () => assertValidStageWorkflow({ ...parsed, stages: [...parsed.stages, { ...parsed.stages[0]! }] }),
    throwsCode('MALFORMED_WORKFLOW'),
  )
  assert.throws(
    () => assertValidStageWorkflow({
      ...parsed,
      stages: parsed.stages.map((stage, index) => index === 2 ? { ...stage, lifecycleStatus: 'in_progress', startedAt: T1 } : stage),
    }),
    throwsCode('MALFORMED_WORKFLOW'),
  )
  assert.throws(
    () => assertValidStageWorkflow({
      ...parsed,
      stages: parsed.stages.map((stage, index) => index === 1 ? { ...stage, projectId: 'other' } : stage),
    }),
    throwsCode('MALFORMED_WORKFLOW'),
  )
})

test('plan and counter limits use existing ceilings', () => {
  assert.equal(STAGE_FIELD_LIMITS.stages, 12)
  const tooMany = Array.from({ length: 13 }, (_, index) => ({ id: 'stage-' + (index + 1), title: '阶段' + (index + 1) }))
  assert.throws(
    () => initializeStageWorkflow({ projectId: 'project-1', stages: tooMany, startedAt: STARTED_AT }),
    throwsCode('INVALID_STAGE_PLAN'),
  )
  assert.throws(
    () => initializeStageWorkflow({
      projectId: 'project-1',
      stages: [{ id: 'stage-1', title: '题'.repeat(STAGE_FIELD_LIMITS.title + 1) }],
      startedAt: STARTED_AT,
    }),
    throwsCode('INVALID_STAGE_PLAN'),
  )

  const base = JSON.parse(JSON.stringify(init())) as ProjectWorkflow
  const saturated = {
    ...base,
    nextSubmissionSequence: Number.MAX_SAFE_INTEGER,
    stages: base.stages.map((stage, index) => index === 0 ? { ...stage, nextReportVersion: Number.MAX_SAFE_INTEGER } : stage),
  }
  assert.throws(() => submit(saturated, { reportId: 'report-overflow' }), throwsCode('COUNTER_LIMIT_REACHED'))
})

test('timestamps and plan dates survive submissions and schedule edits', () => {
  const workflow = init()
  const updated = submit(workflow, { reportId: 'report-1' })
  assert.equal(updated.workflow.stages[0]?.startedAt, STARTED_AT)
  assert.equal(updated.workflow.stages[0]?.plannedStartAt, '2026-03-01')
  assert.equal(updated.workflow.stages[1]?.plannedEndAt, '2026-03-31')
  assert.equal(updated.workflow.stages[0]?.description, '完成开题')

  const relabeled = assertStagePlanEdit({
    workflow: updated.workflow,
    editedAt: T2,
    nextStages: [
      { id: 'stage-1', title: '开题修订', description: '修订说明', plannedStartAt: '2026-03-02', plannedEndAt: '2026-03-20' },
      { id: 'stage-2', title: '调研分析', description: '完成调研', plannedStartAt: '2026-03-21', plannedEndAt: '2026-04-01' },
      { id: 'stage-3', title: '结论交付', plannedStartAt: '2026-04-02', plannedEndAt: '2026-04-20' },
    ],
  })
  assert.equal(relabeled.stages[0]?.title, '开题修订')
  assert.equal(relabeled.stages[0]?.plannedStartAt, '2026-03-02')
  assert.equal(relabeled.stages[0]?.description, '修订说明')
  assert.equal(relabeled.stages[2]?.description, undefined)
  assert.equal(relabeled.planRevision, 1)
  assert.equal(relabeled.stages[0]?.lifecycleStatus, 'in_progress')

  const afterEdit = submit(relabeled, { reportId: 'report-2', submittedAt: T2 })
  assert.equal(afterEdit.workflow.stages[0]?.plannedStartAt, '2026-03-02')
  assert.equal(afterEdit.workflow.stages[0]?.title, '开题修订')
  assert.equal(afterEdit.workflow.stages[0]?.startedAt, STARTED_AT)

  assert.throws(
    () => assertStagePlanEdit({
      workflow: afterEdit.workflow,
      editedAt: T3,
      nextStages: [
        { id: 'stage-2', title: '调研分析' },
        { id: 'stage-1', title: '开题修订' },
        { id: 'stage-3', title: '结论交付' },
      ],
    }),
    throwsCode('STAGE_PLAN_FROZEN'),
  )

  const reordered = assertStagePlanEdit({
    workflow: init(),
    editedAt: T2,
    nextStages: [
      { id: 'stage-3', title: '结论交付', plannedStartAt: '2026-04-01', plannedEndAt: '2026-04-15' },
      { id: 'stage-1', title: '开题研究', plannedStartAt: '2026-03-01', plannedEndAt: '2026-03-15' },
    ],
  })
  assert.deepEqual(reordered.stages.map((stage) => stage.id), ['stage-3', 'stage-1'])
  assert.equal(reordered.stages[0]?.lifecycleStatus, 'in_progress')
  assert.equal(reordered.stages[0]?.plannedStartAt, '2026-04-01')

  const completed = submit(init(), { reportId: 'report-c1', reportKind: 'completion' })
  const relabeledCompleted = assertStagePlanEdit({
    workflow: completed.workflow,
    editedAt: T2,
    nextStages: planStages().map((stage) => stage.id === 'stage-1' ? { ...stage, title: '开题更名' } : stage),
  })
  assert.throws(
    () => submit(relabeledCompleted, {
      reportId: 'report-stale',
      stageId: 'stage-1',
      reportKind: 'completion',
      expectedPlanRevision: completed.workflow.planRevision,
    }),
    throwsCode('PROJECT_PLAN_CHANGED'),
  )
  const refreshed = submit(relabeledCompleted, { reportId: 'report-fresh', stageId: 'stage-1', reportKind: 'completion', submittedAt: T2 })
  assert.equal(refreshed.workflow.stages[0]?.currentCompletionReportId, 'report-fresh')
  assert.equal(refreshed.workflow.stages[0]?.title, '开题更名')
})
