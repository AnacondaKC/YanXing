import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import {
  installStageReportSchema,
  PROJECT_REPORT_STATE_COLUMNS,
  PROJECT_STAGE_COLUMNS,
  REPORT_SUBMISSION_COLUMNS,
} from '../lib/db/stage-report-schema'

const TIMESTAMP = '2026-06-01T00:00:00.000Z'
const LATER = '2026-06-02T00:00:00.000Z'

function createInstalledDatabase(context: TestContext) {
  const database = new DatabaseSync(':memory:')
  context.after(() => database.close())
  database.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);')
  installStageReportSchema(database)
  return database
}

function createSeededDatabase(context: TestContext) {
  const database = createInstalledDatabase(context)
  seedMinimal(database)
  return database
}

function seedMinimal(database: DatabaseSync, input: { userId?: string; projectId?: string } = {}) {
  const userId = input.userId ?? 'user-1'
  const projectId = input.projectId ?? 'project-1'
  database.prepare('INSERT OR IGNORE INTO users(id) VALUES (?)').run(userId)
  database.prepare('INSERT OR IGNORE INTO projects(id) VALUES (?)').run(projectId)
  database.prepare('INSERT OR IGNORE INTO project_report_state(project_id) VALUES (?)').run(projectId)
}

function tableNames(database: DatabaseSync) {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)
}

function columnNames(database: DatabaseSync, table: string) {
  return (database.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>).map((row) => row.name)
}

function insertStage(database: DatabaseSync, input: {
  id: string
  projectId?: string
  ordinal: number
  title?: string
  description?: string | null
  plannedStartAt?: string | null
  plannedEndAt?: string | null
  lifecycleStatus?: 'not_started' | 'in_progress' | 'completed'
  startedAt?: string | null
  completedAt?: string | null
  completionReason?: 'report_completion' | 'skipped' | null
  currentCompletionReportId?: string | null
  nextReportVersion?: number
  stateRevision?: number
  completionRevision?: number
}) {
  const lifecycleStatus = input.lifecycleStatus ?? 'not_started'
  const startedAt = input.startedAt !== undefined ? input.startedAt : (lifecycleStatus === 'in_progress' ? TIMESTAMP : null)
  const completedAt = input.completedAt !== undefined ? input.completedAt : (lifecycleStatus === 'completed' ? TIMESTAMP : null)
  const completionReason = input.completionReason !== undefined ? input.completionReason : (lifecycleStatus === 'completed' ? 'skipped' : null)
  database.prepare(`
    INSERT INTO project_stages (
      id, project_id, ordinal, title, description, planned_start_at, planned_end_at,
      lifecycle_status, started_at, completed_at, completion_reason, current_completion_report_id,
      next_report_version, state_revision, completion_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId ?? 'project-1',
    input.ordinal,
    input.title ?? input.id,
    input.description ?? null,
    input.plannedStartAt ?? null,
    input.plannedEndAt ?? null,
    lifecycleStatus,
    startedAt,
    completedAt,
    completionReason,
    input.currentCompletionReportId ?? null,
    input.nextReportVersion ?? 1,
    input.stateRevision ?? 0,
    input.completionRevision ?? 0,
  )
}

function insertReport(database: DatabaseSync, input: {
  id: string
  projectId?: string
  stageId: string
  stageVersion: number
  submissionSequence: number
  submittedAs?: 'update' | 'completion'
  title?: string
  fileName?: string
  sourceKey?: string
  fileHash?: string
  sourceSize?: number
  paragraphCount?: number
  characterCount?: number
  submittedBy?: string
  submittedAt?: string
  wasFirstStageSubmission?: number
  firstAnalysisSucceededAt?: string | null
  firstInsightSucceededAt?: string | null
  deletedAt?: string | null
  deletedBy?: string | null
  deletionReason?: string | null
}) {
  database.prepare(`
    INSERT INTO report_submissions (
      id, project_id, stage_id, stage_version, submission_sequence, submitted_as,
      title, file_name, source_key, file_hash, source_size, paragraph_count, character_count,
      submitted_by, submitted_at, was_first_stage_submission,
      first_analysis_succeeded_at, first_insight_succeeded_at, deleted_at, deleted_by, deletion_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId ?? 'project-1',
    input.stageId,
    input.stageVersion,
    input.submissionSequence,
    input.submittedAs ?? 'update',
    input.title ?? input.id,
    input.fileName ?? input.id + '.md',
    input.sourceKey ?? 'source/' + input.id,
    input.fileHash ?? 'hash-' + input.id,
    input.sourceSize ?? 12,
    input.paragraphCount ?? 1,
    input.characterCount ?? 8,
    input.submittedBy ?? 'user-1',
    input.submittedAt ?? TIMESTAMP,
    input.wasFirstStageSubmission ?? (input.stageVersion === 1 ? 1 : 0),
    input.firstAnalysisSucceededAt ?? null,
    input.firstInsightSucceededAt ?? null,
    input.deletedAt ?? null,
    input.deletedBy ?? null,
    input.deletionReason ?? null,
  )
}

function completeStageWithReport(database: DatabaseSync, input: { stageId: string; reportId: string; completedAt?: string }) {
  database.prepare(`
    UPDATE project_stages
    SET lifecycle_status = 'completed',
        started_at = COALESCE(started_at, ?),
        completed_at = ?,
        completion_reason = 'report_completion',
        current_completion_report_id = ?
    WHERE id = ?
  `).run(TIMESTAMP, input.completedAt ?? TIMESTAMP, input.reportId, input.stageId)
}

function softDelete(database: DatabaseSync, reportId: string) {
  database.prepare(`
    UPDATE report_submissions
    SET deleted_at = ?, deleted_by = 'user-1', deletion_reason = 'withdrawn'
    WHERE id = ?
  `).run(LATER, reportId)
}

test('bootstrap requires parent tables, creates only the three new relations, and has no legacy version columns', (context) => {
  const empty = new DatabaseSync(':memory:')
  context.after(() => empty.close())
  assert.throws(() => installStageReportSchema(empty), /users\(id\)/)
  empty.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  assert.throws(() => installStageReportSchema(empty), /projects\(id\)/)
  empty.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')
  installStageReportSchema(empty)
  assert.deepEqual(tableNames(empty), ['project_report_state', 'project_stages', 'projects', 'report_submissions', 'users'])
  assert.deepEqual(columnNames(empty, 'project_report_state'), [...PROJECT_REPORT_STATE_COLUMNS])
  assert.deepEqual(columnNames(empty, 'project_stages'), [...PROJECT_STAGE_COLUMNS])
  assert.deepEqual(columnNames(empty, 'report_submissions'), [...REPORT_SUBMISSION_COLUMNS])
  const reportColumns = columnNames(empty, 'report_submissions')
  for (const column of ['version', 'previous_version_id', 'previous_character_count', 'current_role', 'milestone_id', 'delivery_type']) {
    assert.equal(reportColumns.includes(column), false)
  }
  const tables = empty.prepare("SELECT name FROM sqlite_master WHERE name IN ('schema_migrations', 'report_versions')").all()
  assert.deepEqual(tables, [])
  empty.prepare('INSERT INTO projects(id) VALUES (?)').run('project-1')
  empty.prepare('INSERT INTO project_report_state(project_id) VALUES (?)').run('project-1')
  const state = empty.prepare('SELECT plan_revision, workflow_revision, next_submission_sequence FROM project_report_state').get() as {
    plan_revision: number
    workflow_revision: number
    next_submission_sequence: number
  }
  assert.equal(state.plan_revision, 0)
  assert.equal(state.workflow_revision, 0)
  assert.equal(state.next_submission_sequence, 1)
  empty.prepare("INSERT INTO project_stages(id, project_id, ordinal, title) VALUES ('stage-1', 'project-1', 1, '开题')").run()
  const stage = empty.prepare('SELECT next_report_version, state_revision, completion_revision FROM project_stages WHERE id = ?').get('stage-1') as {
    next_report_version: number
    state_revision: number
    completion_revision: number
  }
  assert.equal(stage.next_report_version, 1)
  assert.equal(stage.state_revision, 0)
  assert.equal(stage.completion_revision, 0)
})

test('unique ordinal, one in-progress stage, unique stage version and project submission sequence, and composite stage FK', (context) => {
  const database = createSeededDatabase(context)
  seedMinimal(database, { projectId: 'project-2' })
  insertStage(database, { id: 'stage-1', ordinal: 1, lifecycleStatus: 'in_progress' })
  insertStage(database, { id: 'stage-2', ordinal: 2 })
  insertStage(database, { id: 'stage-a', projectId: 'project-2', ordinal: 1, lifecycleStatus: 'in_progress' })
  assert.throws(() => insertStage(database, { id: 'stage-dup', ordinal: 1 }), /UNIQUE constraint failed: project_stages\.project_id, project_stages\.ordinal/)
  assert.throws(() => insertStage(database, { id: 'stage-active', ordinal: 3, lifecycleStatus: 'in_progress' }), /UNIQUE constraint failed: project_stages\.project_id/)
  insertReport(database, { id: 'r1', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, wasFirstStageSubmission: 1 })
  insertReport(database, { id: 'r2', stageId: 'stage-1', stageVersion: 2, submissionSequence: 2 })
  assert.throws(() => insertReport(database, { id: 'r-dup-v', stageId: 'stage-1', stageVersion: 2, submissionSequence: 3 }), /UNIQUE constraint failed: report_submissions\.stage_id, report_submissions\.stage_version/)
  assert.throws(() => insertReport(database, { id: 'r-dup-seq', stageId: 'stage-2', stageVersion: 1, submissionSequence: 1 }), /UNIQUE constraint failed: report_submissions\.project_id, report_submissions\.submission_sequence/)
  assert.throws(() => insertReport(database, { id: 'r-cross', projectId: 'project-2', stageId: 'stage-1', stageVersion: 9, submissionSequence: 9 }), /FOREIGN KEY constraint failed/)
  assert.throws(() => insertReport(database, { id: 'r-user', stageId: 'stage-2', stageVersion: 1, submissionSequence: 3, submittedBy: 'missing' }), /FOREIGN KEY constraint failed/)
})

test('same file hash may identify distinct reports', (context) => {
  const database = createSeededDatabase(context)
  insertStage(database, { id: 'stage-1', ordinal: 1, lifecycleStatus: 'in_progress' })
  insertReport(database, { id: 'r1', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, fileHash: 'same-hash', wasFirstStageSubmission: 1 })
  insertReport(database, { id: 'r2', stageId: 'stage-1', stageVersion: 2, submissionSequence: 2, fileHash: 'same-hash' })
  const rows = database.prepare('SELECT id FROM report_submissions WHERE file_hash = ? ORDER BY id').all('same-hash') as Array<{ id: string }>
  assert.deepEqual(rows.map((row) => row.id), ['r1', 'r2'])
})

test('completion pointer targets one live same-stage completion report and can be replaced', (context) => {
  const database = createSeededDatabase(context)
  insertStage(database, { id: 'stage-1', ordinal: 1, lifecycleStatus: 'in_progress' })
  insertStage(database, { id: 'stage-2', ordinal: 2 })
  insertReport(database, { id: 'c1', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, submittedAs: 'completion', wasFirstStageSubmission: 1 })
  insertReport(database, { id: 'u1', stageId: 'stage-1', stageVersion: 2, submissionSequence: 2, submittedAs: 'update' })
  insertReport(database, { id: 'c2', stageId: 'stage-1', stageVersion: 3, submissionSequence: 3, submittedAs: 'completion' })
  insertReport(database, { id: 'other', stageId: 'stage-2', stageVersion: 1, submissionSequence: 4, submittedAs: 'completion', wasFirstStageSubmission: 1 })
  completeStageWithReport(database, { stageId: 'stage-1', reportId: 'c1' })
  assert.equal(database.prepare('SELECT current_completion_report_id FROM project_stages WHERE id = ?').get('stage-1')?.current_completion_report_id, 'c1')
  database.prepare('UPDATE project_stages SET current_completion_report_id = ? WHERE id = ?').run('c2', 'stage-1')
  assert.equal(database.prepare('SELECT current_completion_report_id FROM project_stages WHERE id = ?').get('stage-1')?.current_completion_report_id, 'c2')
  assert.throws(
    () => database.prepare('UPDATE project_stages SET current_completion_report_id = ? WHERE id = ?').run('u1', 'stage-1'),
    /project_stages_completion_pointer_invalid/,
  )
  assert.throws(
    () => database.prepare('UPDATE project_stages SET current_completion_report_id = ? WHERE id = ?').run('other', 'stage-1'),
    /project_stages_completion_pointer_invalid/,
  )
  assert.throws(
    () => database.prepare('UPDATE project_stages SET current_completion_report_id = NULL WHERE id = ?').run('stage-1'),
    /project_stages_completion_pointer_cannot_clear/,
  )
  assert.throws(() => softDelete(database, 'c2'), /report_submissions_current_completion_protected/)
  softDelete(database, 'c1')
  assert.throws(
    () => database.prepare('UPDATE project_stages SET current_completion_report_id = ? WHERE id = ?').run('c1', 'stage-1'),
    /project_stages_completion_pointer_invalid/,
  )
  assert.throws(
    () => database.prepare('UPDATE project_stages SET current_completion_report_id = ? WHERE id = ?').run('c2', 'stage-2'),
    /project_stages_completion_pointer_invalid/,
  )
})

test('submission attribution, file metadata, and sequence fields are immutable', (context) => {
  const database = createSeededDatabase(context)
  insertStage(database, { id: 'stage-1', ordinal: 1, lifecycleStatus: 'in_progress' })
  insertReport(database, { id: 'r1', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, wasFirstStageSubmission: 1 })
  assert.throws(() => database.exec("UPDATE report_submissions SET submitted_by = 'user-1', stage_id = 'stage-1', project_id = 'project-1', submitted_as = 'completion'"), /report_submissions_immutable_attribution/)
  assert.throws(() => database.exec("UPDATE report_submissions SET stage_version = 2"), /report_submissions_immutable_attribution/)
  assert.throws(() => database.exec("UPDATE report_submissions SET submission_sequence = 9"), /report_submissions_immutable_attribution/)
  assert.throws(() => database.exec("UPDATE report_submissions SET was_first_stage_submission = 0"), /report_submissions_immutable_attribution/)
  assert.throws(() => database.exec("UPDATE report_submissions SET source_key = 'other'"), /report_submissions_immutable_file/)
  assert.throws(() => database.exec("UPDATE report_submissions SET file_hash = 'other'"), /report_submissions_immutable_file/)
  assert.throws(() => database.exec("UPDATE report_submissions SET title = 'changed'"), /report_submissions_immutable_file/)
  assert.throws(() => database.exec("UPDATE report_submissions SET source_size = 99"), /report_submissions_immutable_file/)
})

test('hard deletion is forbidden for live reports and tombstones; counters and versions are not reused', (context) => {
  const database = createSeededDatabase(context)
  insertStage(database, { id: 'stage-1', ordinal: 1, lifecycleStatus: 'in_progress', nextReportVersion: 2 })
  database.exec("UPDATE project_report_state SET next_submission_sequence = 2 WHERE project_id = 'project-1'")
  insertReport(database, { id: 'r1', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, wasFirstStageSubmission: 1 })
  assert.throws(() => database.exec("DELETE FROM report_submissions WHERE id = 'r1'"), /report_submissions_hard_delete_forbidden/)
  softDelete(database, 'r1')
  assert.throws(() => database.exec("DELETE FROM report_submissions WHERE id = 'r1'"), /report_submissions_hard_delete_forbidden/)
  assert.throws(() => insertReport(database, { id: 'r2', stageId: 'stage-1', stageVersion: 1, submissionSequence: 2 }), /UNIQUE constraint failed: report_submissions\.stage_id/)
  assert.throws(() => insertReport(database, { id: 'r2', stageId: 'stage-1', stageVersion: 2, submissionSequence: 1 }), /UNIQUE constraint failed: report_submissions\.project_id, report_submissions\.submission_sequence/)
  assert.throws(() => insertReport(database, { id: 'r2', stageId: 'stage-1', stageVersion: 2, submissionSequence: 2, wasFirstStageSubmission: 1 }), /report_submissions_first_matches_version/)
  insertReport(database, { id: 'r2', stageId: 'stage-1', stageVersion: 2, submissionSequence: 2 })
  database.exec("UPDATE project_stages SET next_report_version = 3 WHERE id = 'stage-1'")
  database.exec("UPDATE project_report_state SET next_submission_sequence = 3 WHERE project_id = 'project-1'")
  assert.throws(() => database.exec("UPDATE project_stages SET next_report_version = 1 WHERE id = 'stage-1'"), /project_stages_counters_not_monotonic/)
  assert.throws(() => database.exec("UPDATE project_report_state SET next_submission_sequence = 2 WHERE project_id = 'project-1'"), /project_report_state_counters_not_monotonic/)
  assert.throws(() => database.exec("UPDATE report_submissions SET deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL WHERE id = 'r1'"), /report_submissions_tombstone_immutable/)
})

test('analysis and insight success timestamps are independent and monotonic', (context) => {
  const database = createSeededDatabase(context)
  insertStage(database, { id: 'stage-1', ordinal: 1, lifecycleStatus: 'in_progress' })
  insertReport(database, { id: 'r1', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, wasFirstStageSubmission: 1 })
  database.exec("UPDATE report_submissions SET first_analysis_succeeded_at = '" + LATER + "' WHERE id = 'r1'")
  database.exec("UPDATE report_submissions SET first_insight_succeeded_at = '" + LATER + "' WHERE id = 'r1'")
  assert.throws(() => database.exec("UPDATE report_submissions SET first_analysis_succeeded_at = NULL WHERE id = 'r1'"), /report_submissions_success_not_monotonic/)
  assert.throws(() => database.exec("UPDATE report_submissions SET first_insight_succeeded_at = '" + TIMESTAMP + "' WHERE id = 'r1'"), /report_submissions_success_not_monotonic/)
  assert.throws(() => database.exec("UPDATE report_submissions SET first_analysis_succeeded_at = '2026-06-03T00:00:00.000Z' WHERE id = 'r1'"), /report_submissions_success_not_monotonic/)
})

test('completed stages cannot reopen and first completion fields stay fixed while skipped stages may later gain a pointer', (context) => {
  const database = createSeededDatabase(context)
  insertStage(database, { id: 'stage-1', ordinal: 1, lifecycleStatus: 'in_progress' })
  insertStage(database, { id: 'stage-2', ordinal: 2, lifecycleStatus: 'completed', completionReason: 'skipped' })
  insertReport(database, { id: 'c1', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, submittedAs: 'completion', wasFirstStageSubmission: 1 })
  completeStageWithReport(database, { stageId: 'stage-1', reportId: 'c1' })
  assert.throws(() => database.exec("UPDATE project_stages SET lifecycle_status = 'in_progress', completed_at = NULL, completion_reason = NULL, current_completion_report_id = NULL WHERE id = 'stage-1'"), /project_stages_reopen_forbidden/)
  assert.throws(() => database.exec("UPDATE project_stages SET lifecycle_status = 'not_started', started_at = NULL, completed_at = NULL, completion_reason = NULL WHERE id = 'stage-2'"), /project_stages_reopen_forbidden/)
  assert.throws(() => database.exec("UPDATE project_stages SET lifecycle_status = 'not_started', started_at = NULL WHERE id = 'stage-1'"), /project_stages_reopen_forbidden/)
  assert.throws(() => database.exec("UPDATE project_stages SET completed_at = '" + LATER + "' WHERE id = 'stage-1'"), /project_stages_completed_at_immutable/)
  assert.throws(() => database.exec("UPDATE project_stages SET completion_reason = 'skipped' WHERE id = 'stage-1'"), /project_stages_completion_reason_immutable/)
  assert.throws(() => database.exec("UPDATE project_stages SET started_at = '" + LATER + "' WHERE id = 'stage-1'"), /project_stages_started_at_immutable/)
  insertReport(database, { id: 'c2', stageId: 'stage-2', stageVersion: 1, submissionSequence: 2, submittedAs: 'completion', wasFirstStageSubmission: 1 })
  database.prepare('UPDATE project_stages SET current_completion_report_id = ? WHERE id = ?').run('c2', 'stage-2')
  const skipped = database.prepare('SELECT completion_reason, completed_at, current_completion_report_id FROM project_stages WHERE id = ?').get('stage-2') as {
    completion_reason: string
    completed_at: string
    current_completion_report_id: string
  }
  assert.equal(skipped.completion_reason, 'skipped')
  assert.equal(skipped.completed_at, TIMESTAMP)
  assert.equal(skipped.current_completion_report_id, 'c2')
  database.exec("UPDATE project_report_state SET completed_at = '" + TIMESTAMP + "' WHERE project_id = 'project-1'")
  assert.throws(() => database.exec("UPDATE project_report_state SET completed_at = NULL WHERE project_id = 'project-1'"), /project_report_state_completion_irreversible/)
})

test('field, range, and date invariants reject invalid values including legacy reason and kind', (context) => {
  const database = createSeededDatabase(context)
  insertStage(database, { id: 'stage-1', ordinal: 1, lifecycleStatus: 'in_progress' })
  assert.throws(() => insertStage(database, { id: 'bad-ordinal', ordinal: 0 }), /project_stages_counters_range/)
  assert.throws(() => insertStage(database, { id: 'bad-title', ordinal: 2, title: '   ' }), /project_stages_title_required/)
  assert.throws(() => insertStage(database, { id: 'bad-dates', ordinal: 2, plannedStartAt: LATER, plannedEndAt: TIMESTAMP }), /project_stages_planned_dates/)
  assert.throws(() => insertStage(database, { id: 'bad-progress', ordinal: 2, lifecycleStatus: 'in_progress', startedAt: null }), /project_stages_lifecycle_invariants/)
  assert.throws(() => insertStage(database, { id: 'migrated', ordinal: 2, lifecycleStatus: 'completed', completionReason: 'migrated' as 'skipped' }), /project_stages_lifecycle_invariants/)
  assert.throws(() => insertStage(database, { id: 'null-reason', ordinal: 2, lifecycleStatus: 'completed', completionReason: null }), /project_stages_lifecycle_invariants/)
  insertStage(database, { id: 'offset-ok', ordinal: 2, plannedStartAt: '2026-06-01T10:00:00+08:00', plannedEndAt: '2026-06-01T03:00:00Z' })
  assert.throws(() => insertStage(database, { id: 'offset-bad', ordinal: 3, plannedStartAt: '2026-06-01T03:00:00Z', plannedEndAt: '2026-06-01T10:00:00+08:00' }), /project_stages_planned_dates/)
  assert.throws(() => insertReport(database, { id: 'bad-kind', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, submittedAs: 'stage' as 'update' }), /report_submissions_submitted_as_allowed/)
  assert.throws(() => insertReport(database, { id: 'bad-size', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, sourceSize: -1 }), /report_submissions_counters_range/)
  assert.throws(() => insertReport(database, { id: 'bad-first', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, wasFirstStageSubmission: 2 }), /report_submissions_counters_range/)
  assert.throws(() => insertReport(database, { id: 'v1-not-first', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, wasFirstStageSubmission: 0 }), /report_submissions_first_matches_version/)
  assert.throws(() => insertReport(database, { id: 'v2-first', stageId: 'stage-1', stageVersion: 2, submissionSequence: 2, wasFirstStageSubmission: 1 }), /report_submissions_first_matches_version/)
  assert.throws(() => insertReport(database, { id: 'bad-hash', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, fileHash: ' ' }), /report_submissions_text_required/)
  assert.throws(() => insertReport(database, { id: 'partial-delete', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, deletedAt: LATER }), /report_submissions_deletion_consistent/)
  insertReport(database, { id: 'ok', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1, wasFirstStageSubmission: 1 })
  assert.throws(() => database.exec("UPDATE report_submissions SET first_analysis_succeeded_at = '2026-05-01T00:00:00.000Z' WHERE id = 'ok'"), /report_submissions_success_timestamps/)
  assert.throws(() => database.exec("UPDATE project_stages SET lifecycle_status = 'not_started', started_at = NULL WHERE id = 'stage-1'"), /project_stages_progress_regression_forbidden/)
  assert.throws(() => database.prepare('INSERT INTO project_report_state(project_id) VALUES (?)').run(null), /NOT NULL/)
  assert.throws(() => database.prepare('INSERT INTO project_stages(id, project_id, ordinal, title) VALUES (?, ?, 4, ?)').run(null, 'project-1', 'x'), /NOT NULL/)
  database.prepare('INSERT INTO projects(id) VALUES (?)').run('project-neg')
  assert.throws(() => database.prepare('INSERT INTO project_report_state(project_id, plan_revision) VALUES (?, ?)').run('project-neg', -1), /project_report_state_revisions_range/)
})

test('install is atomic, requires enabled foreign keys, and does not leave partial DDL', (context) => {
  const conflicting = new DatabaseSync(':memory:')
  context.after(() => conflicting.close())
  conflicting.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE project_report_state (project_id TEXT);')
  assert.throws(() => installStageReportSchema(conflicting), /project_report_state/)
  assert.deepEqual(tableNames(conflicting), ['project_report_state', 'projects', 'users'])

  const transactional = new DatabaseSync(':memory:')
  context.after(() => transactional.close())
  transactional.exec('PRAGMA foreign_keys = OFF')
  transactional.exec('BEGIN')
  transactional.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);')
  assert.throws(() => installStageReportSchema(transactional), /foreign_keys/)
  transactional.exec('ROLLBACK')
  assert.deepEqual(tableNames(transactional), [])
})
