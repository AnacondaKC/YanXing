import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { installStageReportSchema } from '../lib/db/stage-report-schema'
import { initializeStageWorkflow, type ProjectWorkflow, type StageReportSubmissionResult } from '../modules/projects/stage-domain'
import { planStageReportSubmission } from '../modules/projects/stage-workflow'
import type { ReportSubmissionKind } from '../modules/reports/submission-domain'

const initialTime = '2026-09-01T00:00:00.000Z'
const completionTime = '2026-09-02T00:00:00.000Z'
const backfillTime = '2026-09-03T00:00:00.000Z'

function createFixture() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY);')
  database.exec("INSERT INTO projects VALUES ('project'); INSERT INTO users VALUES ('owner');")
  installStageReportSchema(database)
  const workflow = initializeStageWorkflow({ projectId: 'project', startedAt: initialTime, stages: [
    { id: 'stage-1', title: '开题研究' }, { id: 'stage-2', title: '实地调研' }, { id: 'stage-3', title: '成果形成' },
  ] })
  database.prepare('INSERT INTO project_report_state (project_id, plan_revision, workflow_revision, next_submission_sequence) VALUES (?, ?, ?, ?)')
    .run(workflow.projectId, workflow.planRevision, workflow.workflowRevision, workflow.nextSubmissionSequence)
  for (const stage of workflow.stages) {
    database.prepare('INSERT INTO project_stages (id, project_id, ordinal, title, lifecycle_status, started_at, next_report_version, state_revision, completion_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(stage.id, stage.projectId, stage.ordinal, stage.title, stage.lifecycleStatus, stage.startedAt ?? null, stage.nextReportVersion, stage.stateRevision, stage.completionRevision)
  }
  return { database, workflow }
}

function plannedSubmission(workflow: ProjectWorkflow, input: { reportId: string; stageId: string; kind: ReportSubmissionKind; at: string }) {
  const stage = workflow.stages.find((candidate) => candidate.id === input.stageId)!
  return planStageReportSubmission({ workflow, reportId: input.reportId, stageId: input.stageId,
    reportKind: input.kind, submittedAt: input.at,
    expectedPlanRevision: workflow.planRevision, expectedWorkflowRevision: workflow.workflowRevision,
    expectedCompletionRevision: stage.completionRevision, expectedCompletionReportId: stage.currentCompletionReportId ?? null })
}

function persistPlannedSubmission(database: DatabaseSync, input: {
  plan: StageReportSubmissionResult; reportId: string; stageId: string; kind: ReportSubmissionKind; at: string
}) {
  const { plan, reportId, stageId, kind, at } = input
  database.prepare(
    'INSERT INTO report_submissions (id, project_id, stage_id, stage_version, submission_sequence, submitted_as, title, file_name, source_key, file_hash, source_size, paragraph_count, character_count, submitted_by, submitted_at, was_first_stage_submission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(reportId, plan.workflow.projectId, stageId, plan.allocation.stageVersion, plan.allocation.submissionSequence,
    kind, reportId, reportId + '.pdf', '/prepared/' + reportId, 'same-content-hash', 100, 3, 500, 'owner', at,
    Number(plan.allocation.stageVersion === 1))
  const stages = [...plan.workflow.stages].sort((left, right) => Number(left.lifecycleStatus === 'in_progress') - Number(right.lifecycleStatus === 'in_progress'))
  for (const stage of stages) {
    database.prepare('UPDATE project_stages SET lifecycle_status = ?, started_at = ?, completed_at = ?, completion_reason = ?, current_completion_report_id = ?, next_report_version = ?, state_revision = ?, completion_revision = ? WHERE id = ? AND project_id = ?')
      .run(stage.lifecycleStatus, stage.startedAt ?? null, stage.completedAt ?? null, stage.completionReason ?? null,
        stage.currentCompletionReportId ?? null, stage.nextReportVersion, stage.stateRevision, stage.completionRevision, stage.id, stage.projectId)
  }
  database.prepare('UPDATE project_report_state SET plan_revision = ?, workflow_revision = ?, next_submission_sequence = ?, completed_at = ? WHERE project_id = ?')
    .run(plan.workflow.planRevision, plan.workflow.workflowRevision, plan.workflow.nextSubmissionSequence,
      plan.workflow.completedAt ?? null, plan.workflow.projectId)
}

function submit(database: DatabaseSync, workflow: ProjectWorkflow, input: { reportId: string; stageId: string; kind: ReportSubmissionKind; at: string }) {
  const plan = plannedSubmission(workflow, input)
  database.exec('BEGIN IMMEDIATE')
  try {
    persistPlannedSubmission(database, { ...input, plan })
    database.exec('COMMIT')
    return plan.workflow
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

test('P1 relational schema accepts zero-revision initialized workflow and stage allocations', () => {
  const { database, workflow } = createFixture()
  try {
    let next = submit(database, workflow, { reportId: 'r1', stageId: 'stage-1', kind: 'update', at: initialTime })
    next = submit(database, next, { reportId: 'r2', stageId: 'stage-1', kind: 'completion', at: completionTime })
    assert.equal(next.stages[1].lifecycleStatus, 'in_progress')
    assert.deepEqual(database.prepare('SELECT stage_version, submission_sequence FROM report_submissions ORDER BY submission_sequence').all().map((row) => ({ ...row })), [
      { stage_version: 1, submission_sequence: 1 }, { stage_version: 2, submission_sequence: 2 },
    ])
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM project_stages WHERE lifecycle_status = ?').get('in_progress')?.count, 1)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { database.close() }
})

test('P1 completion backfill preserves later active stage and completion history in real SQL', () => {
  const { database, workflow } = createFixture()
  try {
    let next = submit(database, workflow, { reportId: 'r1', stageId: 'stage-1', kind: 'completion', at: completionTime })
    const originalCompletion = next.stages[0].completedAt
    next = submit(database, next, { reportId: 'r2', stageId: 'stage-1', kind: 'completion', at: backfillTime })
    assert.equal(next.stages[0].completedAt, originalCompletion)
    assert.equal(next.stages[0].currentCompletionReportId, 'r2')
    assert.equal(next.stages[1].lifecycleStatus, 'in_progress')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM report_submissions').get()?.count, 2)
    assert.throws(() => database.prepare('UPDATE report_submissions SET deleted_at = ?, deleted_by = ?, deletion_reason = ? WHERE id = ?')
      .run(backfillTime, 'owner', 'wrong upload', 'r2'))
    database.prepare('UPDATE report_submissions SET deleted_at = ?, deleted_by = ?, deletion_reason = ? WHERE id = ?')
      .run(backfillTime, 'owner', 'superseded', 'r1')
    assert.equal(database.prepare('SELECT next_report_version FROM project_stages WHERE id = ?').get('stage-1')?.next_report_version, 3)
  } finally { database.close() }
})

test('P1 jump completion and later skipped-stage backfill preserve irreversible project completion', () => {
  const { database, workflow } = createFixture()
  try {
    let next = submit(database, workflow, { reportId: 'r1', stageId: 'stage-3', kind: 'completion', at: completionTime })
    const completedAt = next.completedAt
    assert.equal(next.stages[0].completionReason, 'skipped')
    next = submit(database, next, { reportId: 'r2', stageId: 'stage-1', kind: 'completion', at: backfillTime })
    assert.equal(next.completedAt, completedAt)
    assert.equal(next.stages[0].completionReason, 'skipped')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM project_stages WHERE lifecycle_status = ?').get('in_progress')?.count, 0)
  } finally { database.close() }
})

test('P1 a failed multi-table write rolls back report, stage pointer, and sequence counters together', () => {
  const { database, workflow } = createFixture()
  try {
    const input = { reportId: 'r1', stageId: 'stage-1', kind: 'completion' as const, at: completionTime }
    const plan = plannedSubmission(workflow, input)
    database.exec("CREATE TEMP TRIGGER injected_failure BEFORE UPDATE ON project_report_state BEGIN SELECT RAISE(ABORT, 'injected final write failure'); END")
    database.exec('BEGIN IMMEDIATE')
    assert.throws(() => persistPlannedSubmission(database, { ...input, plan }), /injected final write failure/)
    database.exec('ROLLBACK')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM report_submissions').get()?.count, 0)
    assert.equal(database.prepare('SELECT current_completion_report_id FROM project_stages WHERE id = ?').get('stage-1')?.current_completion_report_id, null)
    assert.equal(database.prepare('SELECT next_submission_sequence FROM project_report_state').get()?.next_submission_sequence, 1)
    assert.equal(database.prepare('SELECT next_report_version FROM project_stages WHERE id = ?').get('stage-1')?.next_report_version, 1)
    assert.equal(database.prepare('SELECT lifecycle_status FROM project_stages WHERE id = ?').get('stage-2')?.lifecycle_status, 'not_started')
  } finally { database.close() }
})
