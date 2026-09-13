import type { DatabaseSync } from 'node:sqlite'

/**
 * Greenfield bootstrap for project stages and report submissions.
 * Call {@link installStageReportSchema} on an isolated database that already has
 * `users(id)` and `projects(id)`. This is not a live migration and has no
 * compatibility with report_versions, global version, or previous* fields.
 * Current completion role is derived from project_stages.current_completion_report_id.
 */
export function installStageReportSchema(database: DatabaseSync): void {
  assertRequiredParentTables(database)
  assertForeignKeysEnabled(database)
  database.exec('SAVEPOINT install_stage_report_schema')
  try {
    database.exec(STAGE_REPORT_SCHEMA_SQL)
    database.exec('RELEASE SAVEPOINT install_stage_report_schema')
  } catch (error) {
    try { database.exec('ROLLBACK TO SAVEPOINT install_stage_report_schema') } catch { /* savepoint already gone */ }
    try { database.exec('RELEASE SAVEPOINT install_stage_report_schema') } catch { /* savepoint already gone */ }
    throw error
  }
}

export const PROJECT_REPORT_STATE_COLUMNS = [
  'project_id',
  'plan_revision',
  'workflow_revision',
  'next_submission_sequence',
  'completed_at',
] as const

export const PROJECT_STAGE_COLUMNS = [
  'id',
  'project_id',
  'ordinal',
  'title',
  'description',
  'planned_start_at',
  'planned_end_at',
  'lifecycle_status',
  'started_at',
  'completed_at',
  'completion_reason',
  'current_completion_report_id',
  'next_report_version',
  'state_revision',
  'completion_revision',
] as const

export const REPORT_SUBMISSION_COLUMNS = [
  'id',
  'project_id',
  'stage_id',
  'stage_version',
  'submission_sequence',
  'submitted_as',
  'title',
  'file_name',
  'source_key',
  'file_hash',
  'source_size',
  'paragraph_count',
  'character_count',
  'submitted_by',
  'submitted_at',
  'was_first_stage_submission',
  'first_analysis_succeeded_at',
  'first_insight_succeeded_at',
  'deleted_at',
  'deleted_by',
  'deletion_reason',
] as const

export const STAGE_REPORT_SCHEMA_SQL = `
CREATE TABLE project_report_state (
  project_id TEXT NOT NULL PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  plan_revision INTEGER NOT NULL DEFAULT 0,
  workflow_revision INTEGER NOT NULL DEFAULT 0,
  next_submission_sequence INTEGER NOT NULL DEFAULT 1,
  completed_at TEXT,
  CONSTRAINT project_report_state_project_id_required CHECK (length(trim(project_id)) > 0),
  CONSTRAINT project_report_state_revisions_range CHECK (
    typeof(plan_revision) = 'integer' AND plan_revision BETWEEN 0 AND 9007199254740991
    AND typeof(workflow_revision) = 'integer' AND workflow_revision BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT project_report_state_next_submission_sequence_range CHECK (
    typeof(next_submission_sequence) = 'integer' AND next_submission_sequence BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT project_report_state_completed_at_timestamp CHECK (
    completed_at IS NULL OR julianday(completed_at) IS NOT NULL
  )
);

CREATE TABLE project_stages (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_report_state(project_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  planned_start_at TEXT,
  planned_end_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'not_started',
  started_at TEXT,
  completed_at TEXT,
  completion_reason TEXT,
  current_completion_report_id TEXT,
  next_report_version INTEGER NOT NULL DEFAULT 1,
  state_revision INTEGER NOT NULL DEFAULT 0,
  completion_revision INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_project_stages_id_project UNIQUE (id, project_id),
  CONSTRAINT uq_project_stages_project_ordinal UNIQUE (project_id, ordinal),
  CONSTRAINT project_stages_id_required CHECK (length(trim(id)) > 0),
  CONSTRAINT project_stages_title_required CHECK (length(trim(title)) > 0),
  CONSTRAINT project_stages_revisions_range CHECK (
    typeof(state_revision) = 'integer' AND state_revision BETWEEN 0 AND 9007199254740991
    AND typeof(completion_revision) = 'integer' AND completion_revision BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT project_stages_counters_range CHECK (
    typeof(ordinal) = 'integer' AND ordinal BETWEEN 1 AND 9007199254740991
    AND typeof(next_report_version) = 'integer' AND next_report_version BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT project_stages_lifecycle_status_allowed CHECK (
    lifecycle_status IN ('not_started', 'in_progress', 'completed')
  ),
  CONSTRAINT project_stages_planned_dates CHECK (
    (planned_start_at IS NULL OR julianday(planned_start_at) IS NOT NULL)
    AND (planned_end_at IS NULL OR julianday(planned_end_at) IS NOT NULL)
    AND (planned_start_at IS NULL OR planned_end_at IS NULL OR (
      julianday(planned_start_at) IS NOT NULL
      AND julianday(planned_end_at) IS NOT NULL
      AND julianday(planned_end_at) >= julianday(planned_start_at)
    ))
  ),
  CONSTRAINT project_stages_lifecycle_invariants CHECK (
    (
      lifecycle_status = 'not_started'
      AND started_at IS NULL
      AND completed_at IS NULL
      AND completion_reason IS NULL
      AND current_completion_report_id IS NULL
    ) OR (
      lifecycle_status = 'in_progress'
      AND started_at IS NOT NULL AND julianday(started_at) IS NOT NULL
      AND completed_at IS NULL
      AND completion_reason IS NULL
      AND current_completion_report_id IS NULL
    ) OR (
      lifecycle_status = 'completed'
      AND completed_at IS NOT NULL AND julianday(completed_at) IS NOT NULL
      AND completion_reason IS NOT NULL
      AND completion_reason IN ('report_completion', 'skipped')
      AND (started_at IS NULL OR (
        julianday(started_at) IS NOT NULL
        AND julianday(completed_at) IS NOT NULL
        AND julianday(completed_at) >= julianday(started_at)
      ))
      AND (
        completion_reason = 'skipped'
        OR (
          completion_reason = 'report_completion'
          AND started_at IS NOT NULL
          AND current_completion_report_id IS NOT NULL
        )
      )
    )
  )
);

CREATE TABLE report_submissions (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  stage_version INTEGER NOT NULL,
  submission_sequence INTEGER NOT NULL,
  submitted_as TEXT NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  paragraph_count INTEGER NOT NULL,
  character_count INTEGER NOT NULL,
  submitted_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TEXT NOT NULL,
  was_first_stage_submission INTEGER NOT NULL,
  first_analysis_succeeded_at TEXT,
  first_insight_succeeded_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  deletion_reason TEXT,
  CONSTRAINT uq_report_submissions_stage_version UNIQUE (stage_id, stage_version),
  CONSTRAINT uq_report_submissions_project_sequence UNIQUE (project_id, submission_sequence),
  CONSTRAINT fk_report_submissions_stage_project
    FOREIGN KEY (stage_id, project_id) REFERENCES project_stages(id, project_id) ON DELETE RESTRICT,
  CONSTRAINT report_submissions_id_required CHECK (length(trim(id)) > 0),
  CONSTRAINT report_submissions_text_required CHECK (
    length(trim(title)) > 0
    AND length(trim(file_name)) > 0
    AND length(trim(source_key)) > 0
    AND length(trim(file_hash)) > 0
  ),
  CONSTRAINT report_submissions_submitted_as_allowed CHECK (submitted_as IN ('update', 'completion')),
  CONSTRAINT report_submissions_counters_range CHECK (
    typeof(stage_version) = 'integer' AND stage_version BETWEEN 1 AND 9007199254740991
    AND typeof(submission_sequence) = 'integer' AND submission_sequence BETWEEN 1 AND 9007199254740991
    AND typeof(source_size) = 'integer' AND source_size BETWEEN 0 AND 9007199254740991
    AND typeof(paragraph_count) = 'integer' AND paragraph_count BETWEEN 0 AND 9007199254740991
    AND typeof(character_count) = 'integer' AND character_count BETWEEN 0 AND 9007199254740991
    AND typeof(was_first_stage_submission) = 'integer' AND was_first_stage_submission IN (0, 1)
  ),
  CONSTRAINT report_submissions_first_matches_version CHECK (
    was_first_stage_submission IS NOT NULL
    AND stage_version IS NOT NULL
    AND was_first_stage_submission = (stage_version = 1)
  ),
  CONSTRAINT report_submissions_submitted_at_timestamp CHECK (julianday(submitted_at) IS NOT NULL),
  CONSTRAINT report_submissions_success_timestamps CHECK (
    (first_analysis_succeeded_at IS NULL OR (
      julianday(first_analysis_succeeded_at) IS NOT NULL
      AND julianday(submitted_at) IS NOT NULL
      AND julianday(first_analysis_succeeded_at) >= julianday(submitted_at)
    ))
    AND (first_insight_succeeded_at IS NULL OR (
      julianday(first_insight_succeeded_at) IS NOT NULL
      AND julianday(submitted_at) IS NOT NULL
      AND julianday(first_insight_succeeded_at) >= julianday(submitted_at)
    ))
  ),
  CONSTRAINT report_submissions_deletion_consistent CHECK (
    (
      deleted_at IS NULL AND deleted_by IS NULL AND deletion_reason IS NULL
    ) OR (
      deleted_at IS NOT NULL AND julianday(deleted_at) IS NOT NULL
      AND julianday(submitted_at) IS NOT NULL
      AND julianday(deleted_at) >= julianday(submitted_at)
      AND deleted_by IS NOT NULL AND length(trim(deleted_by)) > 0
      AND deletion_reason IS NOT NULL AND length(trim(deletion_reason)) > 0
    )
  )
);

CREATE INDEX idx_report_submissions_source_key ON report_submissions(source_key COLLATE BINARY);

CREATE UNIQUE INDEX uq_project_stages_one_in_progress
  ON project_stages(project_id)
  WHERE lifecycle_status = 'in_progress';

CREATE UNIQUE INDEX uq_project_stages_current_completion_report
  ON project_stages(current_completion_report_id)
  WHERE current_completion_report_id IS NOT NULL;

CREATE UNIQUE INDEX uq_report_submissions_one_first_per_stage
  ON report_submissions(stage_id)
  WHERE was_first_stage_submission = 1;

CREATE TRIGGER project_report_state_protect_invariants
BEFORE UPDATE ON project_report_state
BEGIN
  SELECT RAISE(ABORT, 'project_report_state_identity_immutable')
  WHERE NEW.project_id IS NOT OLD.project_id;

  SELECT RAISE(ABORT, 'project_report_state_counters_not_monotonic')
  WHERE NEW.plan_revision < OLD.plan_revision
     OR NEW.workflow_revision < OLD.workflow_revision
     OR NEW.next_submission_sequence < OLD.next_submission_sequence;

  SELECT RAISE(ABORT, 'project_report_state_completion_irreversible')
  WHERE OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at;
END;

CREATE TRIGGER project_stages_protect_invariants
BEFORE UPDATE ON project_stages
BEGIN
  SELECT RAISE(ABORT, 'project_stages_identity_immutable')
  WHERE NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id;

  SELECT RAISE(ABORT, 'project_stages_reopen_forbidden')
  WHERE OLD.lifecycle_status = 'completed' AND NEW.lifecycle_status IS NOT OLD.lifecycle_status;

  SELECT RAISE(ABORT, 'project_stages_progress_regression_forbidden')
  WHERE OLD.lifecycle_status = 'in_progress' AND NEW.lifecycle_status = 'not_started';

  SELECT RAISE(ABORT, 'project_stages_started_at_immutable')
  WHERE OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at;

  SELECT RAISE(ABORT, 'project_stages_completed_at_immutable')
  WHERE OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at;

  SELECT RAISE(ABORT, 'project_stages_completion_reason_immutable')
  WHERE OLD.completion_reason IS NOT NULL AND NEW.completion_reason IS NOT OLD.completion_reason;

  SELECT RAISE(ABORT, 'project_stages_completion_pointer_cannot_clear')
  WHERE OLD.current_completion_report_id IS NOT NULL AND NEW.current_completion_report_id IS NULL;

  SELECT RAISE(ABORT, 'project_stages_counters_not_monotonic')
  WHERE NEW.next_report_version < OLD.next_report_version
     OR NEW.state_revision < OLD.state_revision
     OR NEW.completion_revision < OLD.completion_revision;
END;

CREATE TRIGGER project_stages_validate_completion_pointer_insert
BEFORE INSERT ON project_stages
WHEN NEW.current_completion_report_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project_stages_completion_pointer_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM report_submissions
    WHERE id = NEW.current_completion_report_id
      AND stage_id = NEW.id
      AND project_id = NEW.project_id
      AND submitted_as = 'completion'
      AND deleted_at IS NULL
  );
END;

CREATE TRIGGER project_stages_validate_completion_pointer_update
BEFORE UPDATE ON project_stages
WHEN NEW.current_completion_report_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project_stages_completion_pointer_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM report_submissions
    WHERE id = NEW.current_completion_report_id
      AND stage_id = NEW.id
      AND project_id = NEW.project_id
      AND submitted_as = 'completion'
      AND deleted_at IS NULL
  );
END;

CREATE TRIGGER report_submissions_forbid_hard_delete
BEFORE DELETE ON report_submissions
BEGIN
  SELECT RAISE(ABORT, 'report_submissions_hard_delete_forbidden');
END;

CREATE TRIGGER report_submissions_protect_immutable_fields
BEFORE UPDATE ON report_submissions
BEGIN
  SELECT RAISE(ABORT, 'report_submissions_immutable_attribution')
  WHERE NEW.id IS NOT OLD.id
     OR NEW.project_id IS NOT OLD.project_id
     OR NEW.stage_id IS NOT OLD.stage_id
     OR NEW.stage_version IS NOT OLD.stage_version
     OR NEW.submission_sequence IS NOT OLD.submission_sequence
     OR NEW.submitted_as IS NOT OLD.submitted_as
     OR NEW.submitted_by IS NOT OLD.submitted_by
     OR NEW.submitted_at IS NOT OLD.submitted_at
     OR NEW.was_first_stage_submission IS NOT OLD.was_first_stage_submission;

  SELECT RAISE(ABORT, 'report_submissions_immutable_file')
  WHERE NEW.title IS NOT OLD.title
     OR NEW.file_name IS NOT OLD.file_name
     OR NEW.source_key IS NOT OLD.source_key
     OR NEW.file_hash IS NOT OLD.file_hash
     OR NEW.source_size IS NOT OLD.source_size
     OR NEW.paragraph_count IS NOT OLD.paragraph_count
     OR NEW.character_count IS NOT OLD.character_count;
END;

CREATE TRIGGER report_submissions_protect_current_completion
BEFORE UPDATE ON report_submissions
BEGIN
  SELECT RAISE(ABORT, 'report_submissions_current_completion_protected')
  WHERE OLD.deleted_at IS NULL
    AND NEW.deleted_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM project_stages
      WHERE current_completion_report_id = OLD.id
    );
END;

CREATE TRIGGER report_submissions_success_monotonic
BEFORE UPDATE ON report_submissions
BEGIN
  SELECT RAISE(ABORT, 'report_submissions_success_not_monotonic')
  WHERE (OLD.first_analysis_succeeded_at IS NOT NULL AND NEW.first_analysis_succeeded_at IS NOT OLD.first_analysis_succeeded_at)
     OR (OLD.first_insight_succeeded_at IS NOT NULL AND NEW.first_insight_succeeded_at IS NOT OLD.first_insight_succeeded_at);
END;

CREATE TRIGGER report_submissions_tombstone_immutable
BEFORE UPDATE ON report_submissions
BEGIN
  SELECT RAISE(ABORT, 'report_submissions_tombstone_immutable')
  WHERE OLD.deleted_at IS NOT NULL AND (
    NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.deleted_by IS NOT OLD.deleted_by
    OR NEW.deletion_reason IS NOT OLD.deletion_reason
  );
END;
`

function assertRequiredParentTables(database: DatabaseSync) {
  for (const table of ['users', 'projects'] as const) {
    const columns = database.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name?: unknown }>
    if (!columns.some((column) => column.name === 'id')) {
      throw new Error('installStageReportSchema requires ' + table + '(id); this factory is bootstrap-only and does not create parent tables.')
    }
  }
}

function readForeignKeysEnabled(database: DatabaseSync) {
  const row = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: unknown } | undefined
  return Number(row?.foreign_keys) === 1
}

function assertForeignKeysEnabled(database: DatabaseSync) {
  if (readForeignKeysEnabled(database)) return
  database.exec('PRAGMA foreign_keys = ON')
  if (!readForeignKeysEnabled(database)) {
    throw new Error('installStageReportSchema requires PRAGMA foreign_keys=ON; enabling it is a no-op inside an open transaction.')
  }
}
