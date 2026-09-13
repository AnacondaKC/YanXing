import type { DatabaseSync } from 'node:sqlite'

/** Fresh-schema extension only; no migration or default database initialization. */
export function installSubmissionTaskSchema(database: DatabaseSync): void {
  if (!database.prepare('PRAGMA foreign_keys').get()?.foreign_keys) throw new Error('Task schema requires foreign keys.')
  for (const table of ['report_submissions','report_uploads','report_submission_outbox','report_submission_documents']) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('Task schema requires '+table)
  }
  database.exec('SAVEPOINT submission_task_schema')
  try { database.exec(SUBMISSION_TASK_SCHEMA_SQL); database.exec('RELEASE submission_task_schema') }
  catch (error) {
    try { database.exec('ROLLBACK TO submission_task_schema; RELEASE submission_task_schema') } catch { /* savepoint already gone */ }
    throw error
  }
}

export function assertSubmissionTaskSchema(database: DatabaseSync): void {
  const tables=['submission_task_schema','submission_tasks','submission_task_calls','submission_task_data','submission_task_results','submission_task_dispatches','submission_task_events']
  for(const table of tables) {
    if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('P3 task schema missing or incompatible: '+table)
  }
  if(database.prepare('SELECT version FROM submission_task_schema WHERE id=1').get()?.version!==1) throw new Error('Unsupported P3 task schema version.')
}

const SUBMISSION_TASK_CALLS_SCHEMA_SQL = `
CREATE TABLE submission_task_calls (
  job_id TEXT NOT NULL REFERENCES submission_tasks(id), attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 100),
  provider TEXT NOT NULL, model TEXT NOT NULL, lease_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','completed')),
  started_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY(job_id,attempt),
  CHECK((state='started' AND completed_at IS NULL) OR (state='completed' AND completed_at IS NOT NULL))
);
`

const SUBMISSION_TASK_CALL_TRIGGERS_SQL = `
CREATE TRIGGER submission_call_insert_guard BEFORE INSERT ON submission_task_calls BEGIN
  SELECT RAISE(ABORT,'call_must_start_without_receipt') WHERE NEW.state<>'started' OR NEW.completed_at IS NOT NULL;
  SELECT RAISE(ABORT,'call_not_admitted') WHERE NOT EXISTS(SELECT 1 FROM submission_tasks t WHERE t.id=NEW.job_id AND t.status='running' AND t.cancel_requested=0 AND t.lease_token=NEW.lease_token AND NEW.provider=json_extract(t.frozen_json,'$.modelRuntime.channel') AND NEW.model=json_extract(t.frozen_json,'$.modelRuntime.modelName'));
END;
CREATE TRIGGER submission_call_immutable BEFORE UPDATE ON submission_task_calls BEGIN
  SELECT RAISE(ABORT,'call_identity_immutable') WHERE NEW.job_id IS NOT OLD.job_id OR NEW.attempt IS NOT OLD.attempt OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.lease_token IS NOT OLD.lease_token OR NEW.started_at IS NOT OLD.started_at;
  SELECT RAISE(ABORT,'call_receipt_immutable') WHERE OLD.state='completed' AND (NEW.state IS NOT OLD.state OR NEW.completed_at IS NOT OLD.completed_at);
END;
CREATE TRIGGER submission_call_no_delete BEFORE DELETE ON submission_task_calls BEGIN SELECT RAISE(ABORT,'call_history_required'); END;
`

export const SUBMISSION_TASK_SCHEMA_SQL = `
CREATE TABLE submission_task_schema (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1));
INSERT INTO submission_task_schema VALUES(1,1);
CREATE TABLE submission_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT NOT NULL REFERENCES report_submissions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK(operation IN ('analysis','insight')),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  stage TEXT NOT NULL DEFAULT 'validating', stage_index INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  frozen_json TEXT NOT NULL CHECK(json_valid(frozen_json)),
  available_at TEXT NOT NULL, lease_token TEXT, lease_until TEXT,
  error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(report_id,operation,generation),
  CHECK((status='running' AND lease_token IS NOT NULL AND julianday(lease_until) IS NOT NULL) OR (status<>'running' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE UNIQUE INDEX one_active_submission_task ON submission_tasks(report_id,operation) WHERE status IN ('queued','running');
CREATE INDEX submission_tasks_due ON submission_tasks(status,available_at,lease_until);
${SUBMISSION_TASK_CALLS_SCHEMA_SQL}
CREATE TABLE submission_task_data (
  job_id TEXT NOT NULL REFERENCES submission_tasks(id), data_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(job_id,data_key)
);
CREATE TABLE submission_task_results (
  id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES submission_tasks(id),
  report_id TEXT NOT NULL REFERENCES report_submissions(id),
  operation TEXT NOT NULL CHECK(operation IN ('analysis','insight')), generation INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL,
  UNIQUE(report_id,operation,generation)
);
CREATE TABLE submission_task_dispatches (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES report_submission_outbox(id),
  job_id TEXT NOT NULL REFERENCES submission_tasks(id)
);
CREATE TABLE submission_task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT REFERENCES submission_tasks(id),
  report_id TEXT NOT NULL REFERENCES report_submissions(id), actor_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER submission_task_insert_guard BEFORE INSERT ON submission_tasks BEGIN
  SELECT RAISE(ABORT,'task_report_mismatch') WHERE NOT EXISTS(SELECT 1 FROM report_submissions WHERE id=NEW.report_id AND project_id=NEW.project_id AND deleted_at IS NULL);
END;
CREATE TRIGGER submission_task_immutable BEFORE UPDATE ON submission_tasks BEGIN
  SELECT RAISE(ABORT,'task_identity_immutable') WHERE NEW.id IS NOT OLD.id OR NEW.report_id IS NOT OLD.report_id OR NEW.project_id IS NOT OLD.project_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.operation IS NOT OLD.operation OR NEW.generation IS NOT OLD.generation OR NEW.frozen_json IS NOT OLD.frozen_json OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT,'task_terminal_immutable') WHERE OLD.status IN ('completed','failed','cancelled') AND NEW.status IS NOT OLD.status;
  SELECT RAISE(ABORT,'task_attempts_regressed') WHERE NEW.attempts<OLD.attempts OR NEW.cancel_requested<OLD.cancel_requested;
  SELECT RAISE(ABORT,'task_success_without_result') WHERE NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM submission_task_results WHERE job_id=NEW.id);
END;
CREATE TRIGGER submission_task_no_delete BEFORE DELETE ON submission_tasks BEGIN SELECT RAISE(ABORT,'task_history_required'); END;
CREATE TRIGGER submission_result_guard BEFORE INSERT ON submission_task_results BEGIN
  SELECT RAISE(ABORT,'result_not_publishable') WHERE NOT EXISTS(
    SELECT 1 FROM submission_tasks t JOIN report_submissions r ON r.id=t.report_id WHERE t.id=NEW.job_id AND t.report_id=NEW.report_id AND t.operation=NEW.operation AND t.generation=NEW.generation AND t.status='running' AND t.cancel_requested=0 AND r.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM submission_tasks newer WHERE newer.report_id=t.report_id AND newer.operation=t.operation AND newer.generation>t.generation));
END;
CREATE TRIGGER submission_result_no_update BEFORE UPDATE ON submission_task_results BEGIN SELECT RAISE(ABORT,'result_immutable'); END;
CREATE TRIGGER submission_result_no_delete BEFORE DELETE ON submission_task_results BEGIN SELECT RAISE(ABORT,'result_history_required'); END;
${SUBMISSION_TASK_CALL_TRIGGERS_SQL}
CREATE TRIGGER submission_event_no_update BEFORE UPDATE ON submission_task_events BEGIN SELECT RAISE(ABORT,'task_audit_immutable'); END;
CREATE TRIGGER submission_event_no_delete BEFORE DELETE ON submission_task_events BEGIN SELECT RAISE(ABORT,'task_audit_immutable'); END;
CREATE TRIGGER submission_dispatch_no_update BEFORE UPDATE ON submission_task_dispatches BEGIN SELECT RAISE(ABORT,'dispatch_immutable'); END;
CREATE TRIGGER submission_dispatch_no_delete BEFORE DELETE ON submission_task_dispatches BEGIN SELECT RAISE(ABORT,'dispatch_immutable'); END;
CREATE TRIGGER submission_active_task_blocks_delete BEFORE UPDATE OF deleted_at ON report_submissions WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
  SELECT RAISE(ABORT,'report_processing') WHERE EXISTS(SELECT 1 FROM submission_tasks WHERE report_id=OLD.id AND status IN ('queued','running'));
END;
`
