import type { DatabaseSync } from 'node:sqlite'

export function installReportUploadSchema(database: DatabaseSync): void {
  for (const table of ['users', 'projects', 'project_report_state', 'project_stages', 'report_submissions']) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      throw new Error('Report upload bootstrap requires ' + table)
    }
  }
  if (database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('Report upload bootstrap requires foreign_keys')
  database.exec('SAVEPOINT install_report_upload_schema')
  try {
    database.exec(REPORT_UPLOAD_SCHEMA)
    database.exec('RELEASE SAVEPOINT install_report_upload_schema')
  } catch (error) {
    try { database.exec('ROLLBACK TO SAVEPOINT install_report_upload_schema; RELEASE SAVEPOINT install_report_upload_schema') } catch { /* savepoint already gone */ }
    throw error
  }
}

export const REPORT_UPLOAD_SCHEMA = `
CREATE TABLE submission_storage_root (id INTEGER PRIMARY KEY CHECK(id=1),path TEXT NOT NULL);
CREATE TRIGGER submission_storage_root_no_update BEFORE UPDATE ON submission_storage_root BEGIN SELECT RAISE(ABORT,'submission_storage_root_immutable'); END;
CREATE TRIGGER submission_storage_root_no_delete BEFORE DELETE ON submission_storage_root BEGIN SELECT RAISE(ABORT,'submission_storage_root_immutable'); END;
CREATE TABLE report_uploads (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_report_state(project_id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL CHECK(length(trim(file_name)) > 0),
  status TEXT NOT NULL CHECK(status IN ('receiving','parsing','ready','failed','committed','reclaiming','reclaimed')),
  reservation_id TEXT NOT NULL UNIQUE,
  reserved_bytes INTEGER NOT NULL CHECK(typeof(reserved_bytes)='integer' AND reserved_bytes BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK(julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(created_at)),
  source_key TEXT UNIQUE,
  mime_type TEXT,
  file_hash TEXT,
  source_size INTEGER,
  title TEXT,
  document_text TEXT,
  paragraph_count INTEGER,
  character_count INTEGER,
  report_id TEXT UNIQUE REFERENCES report_submissions(id),
  error_code TEXT,
  recovery_token TEXT,
  recovery_lease_until TEXT,
  recovery_retry_at TEXT,
  recovery_error TEXT,
  reclaimed_at TEXT,
  CHECK((status='reclaiming' AND recovery_token IS NOT NULL AND julianday(recovery_lease_until) IS NOT NULL)
    OR (status<>'reclaiming' AND recovery_token IS NULL AND recovery_lease_until IS NULL)),
  CHECK((status='reclaimed' AND reclaimed_at IS NOT NULL AND julianday(reclaimed_at) IS NOT NULL) OR (status<>'reclaimed' AND reclaimed_at IS NULL)),
  CHECK(status NOT IN ('ready','committed') OR (
    source_key IS NOT NULL AND length(source_key)>0 AND mime_type IS NOT NULL AND length(mime_type)>0
    AND file_hash IS NOT NULL AND length(file_hash)>0 AND title IS NOT NULL AND length(trim(title))>0
    AND source_size IS NOT NULL AND typeof(source_size)='integer' AND source_size BETWEEN 1 AND reserved_bytes
    AND paragraph_count IS NOT NULL AND typeof(paragraph_count)='integer' AND paragraph_count>0
    AND character_count IS NOT NULL AND typeof(character_count)='integer' AND character_count>0
  )),
  CHECK(status<>'ready' OR (document_text IS NOT NULL AND length(trim(document_text))>0)),
  CHECK(status<>'committed' OR document_text IS NULL),
  CHECK((status='committed' AND report_id IS NOT NULL) OR (status<>'committed' AND report_id IS NULL))
);
CREATE INDEX report_uploads_owner_status ON report_uploads(actor_id,project_id,status,expires_at);
CREATE TABLE stage_project_audit (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('project_created','plan_initialized','stage_plan_edited')),
  plan_revision INTEGER NOT NULL CHECK(plan_revision>=0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  UNIQUE(project_id,plan_revision)
);
CREATE TRIGGER stage_project_audit_no_update BEFORE UPDATE ON stage_project_audit BEGIN SELECT RAISE(ABORT,'stage_plan_audit_immutable'); END;
CREATE TRIGGER stage_project_audit_no_delete BEFORE DELETE ON stage_project_audit BEGIN SELECT RAISE(ABORT,'stage_plan_audit_immutable'); END;
CREATE TRIGGER report_uploads_no_delete BEFORE DELETE ON report_uploads BEGIN SELECT RAISE(ABORT,'upload_history_required'); END;
CREATE INDEX report_upload_recovery_due ON report_uploads(status,expires_at,recovery_lease_until,recovery_retry_at);
CREATE TABLE report_submission_documents (
  report_id TEXT NOT NULL PRIMARY KEY REFERENCES report_submissions(id),
  text TEXT NOT NULL CHECK(length(trim(text))>0),
  mime_type TEXT NOT NULL CHECK(length(mime_type)>0)
);
CREATE TABLE report_submission_requests (
  actor_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES project_report_state(project_id),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_digest TEXT NOT NULL,
  upload_id TEXT NOT NULL UNIQUE REFERENCES report_uploads(id),
  report_id TEXT NOT NULL UNIQUE REFERENCES report_submissions(id),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  PRIMARY KEY(actor_id,project_id,idempotency_key)
);
CREATE TABLE report_submission_audit (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_report_state(project_id),
  report_id TEXT NOT NULL REFERENCES report_submissions(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL)
);
CREATE INDEX report_submission_audit_project ON report_submission_audit(project_id,created_at);
CREATE TABLE report_submission_outbox (
  id TEXT NOT NULL PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE REFERENCES report_submissions(id),
  project_id TEXT NOT NULL REFERENCES project_report_state(project_id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK(event_type='report_submitted'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','delivered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts BETWEEN 0 AND 9007199254740991),
  available_at TEXT NOT NULL CHECK(julianday(available_at) IS NOT NULL),
  lease_token TEXT,
  lease_expires_at TEXT,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  CHECK((status='leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at) IS NOT NULL)
    OR (status<>'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK((status='delivered' AND delivered_at IS NOT NULL AND julianday(delivered_at) IS NOT NULL)
    OR (status<>'delivered' AND delivered_at IS NULL))
);
CREATE INDEX report_submission_outbox_ready ON report_submission_outbox(status,available_at,lease_expires_at);
CREATE TRIGGER report_uploads_immutable_identity BEFORE UPDATE ON report_uploads BEGIN
  SELECT RAISE(ABORT,'upload_identity_immutable') WHERE NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.actor_id IS NOT OLD.actor_id OR NEW.file_name IS NOT OLD.file_name OR NEW.reservation_id IS NOT OLD.reservation_id
    OR NEW.reserved_bytes IS NOT OLD.reserved_bytes OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at;
  SELECT RAISE(ABORT,'upload_transition_invalid') WHERE NOT (
    NEW.status=OLD.status OR (OLD.status='receiving' AND NEW.status IN ('parsing','failed'))
    OR (OLD.status='parsing' AND NEW.status IN ('ready','failed')) OR (OLD.status='ready' AND NEW.status IN ('committed','failed'))
    OR (OLD.status IN ('receiving','parsing','ready','failed') AND NEW.status='reclaiming')
    OR (OLD.status='reclaiming' AND NEW.status='reclaimed')
  );
  SELECT RAISE(ABORT,'upload_prepared_content_immutable') WHERE OLD.status IN ('ready','committed','reclaiming','reclaimed') AND (
    NEW.source_key IS NOT OLD.source_key OR NEW.mime_type IS NOT OLD.mime_type OR NEW.file_hash IS NOT OLD.file_hash
    OR NEW.source_size IS NOT OLD.source_size OR NEW.title IS NOT OLD.title OR (NEW.document_text IS NOT OLD.document_text AND NOT (OLD.status='ready' AND NEW.status='committed' AND NEW.document_text IS NULL))
    OR NEW.paragraph_count IS NOT OLD.paragraph_count OR NEW.character_count IS NOT OLD.character_count
  );
  SELECT RAISE(ABORT,'upload_reclaimed_at_immutable') WHERE OLD.reclaimed_at IS NOT NULL AND NEW.reclaimed_at IS NOT OLD.reclaimed_at;
  SELECT RAISE(ABORT,'upload_commit_immutable') WHERE OLD.status='committed' AND (NEW.report_id IS NOT OLD.report_id OR NEW.error_code IS NOT OLD.error_code);
END;
CREATE TRIGGER report_uploads_validate_commit BEFORE UPDATE OF report_id ON report_uploads WHEN NEW.report_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'upload_report_mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM report_submissions WHERE id=NEW.report_id AND project_id=NEW.project_id AND submitted_by=NEW.actor_id
      AND source_key=NEW.source_key AND file_hash=NEW.file_hash AND source_size=NEW.source_size
      AND EXISTS (SELECT 1 FROM report_submission_documents d WHERE d.report_id=NEW.report_id AND d.text=OLD.document_text AND d.mime_type=NEW.mime_type)
  );
END;
CREATE TRIGGER report_submission_requests_identity BEFORE INSERT ON report_submission_requests BEGIN
  SELECT RAISE(ABORT,'submission_receipt_identity_mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM report_uploads u JOIN report_submissions r ON r.id=NEW.report_id
    WHERE u.id=NEW.upload_id AND u.project_id=NEW.project_id AND u.actor_id=NEW.actor_id
      AND u.status='committed' AND u.report_id=NEW.report_id AND r.project_id=NEW.project_id AND r.submitted_by=NEW.actor_id
  );
END;
CREATE TRIGGER report_submission_outbox_identity BEFORE INSERT ON report_submission_outbox BEGIN
  SELECT RAISE(ABORT,'submission_outbox_identity_mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM report_submissions WHERE id=NEW.report_id AND project_id=NEW.project_id AND submitted_by=NEW.actor_id
  );
END;
CREATE TRIGGER report_submission_audit_identity BEFORE INSERT ON report_submission_audit BEGIN
  SELECT RAISE(ABORT,'submission_audit_identity_mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM report_submissions WHERE id=NEW.report_id AND project_id=NEW.project_id AND submitted_by=NEW.actor_id
  );
END;
CREATE TRIGGER report_submission_documents_immutable BEFORE UPDATE ON report_submission_documents BEGIN
  SELECT RAISE(ABORT,'report_document_immutable');
END;
CREATE TRIGGER report_submission_documents_no_delete BEFORE DELETE ON report_submission_documents BEGIN
  SELECT RAISE(ABORT,'report_document_delete_forbidden');
END;
CREATE TRIGGER report_submission_requests_immutable BEFORE UPDATE ON report_submission_requests BEGIN
  SELECT RAISE(ABORT,'submission_receipt_immutable');
END;
CREATE TRIGGER report_submission_requests_no_delete BEFORE DELETE ON report_submission_requests BEGIN
  SELECT RAISE(ABORT,'submission_receipt_delete_forbidden');
END;
CREATE TRIGGER report_submission_audit_immutable BEFORE UPDATE ON report_submission_audit BEGIN
  SELECT RAISE(ABORT,'submission_audit_immutable');
END;
CREATE TRIGGER report_submission_audit_no_delete BEFORE DELETE ON report_submission_audit BEGIN
  SELECT RAISE(ABORT,'submission_audit_delete_forbidden');
END;
CREATE TRIGGER report_submission_outbox_immutable BEFORE UPDATE ON report_submission_outbox BEGIN
  SELECT RAISE(ABORT,'outbox_identity_immutable') WHERE NEW.id IS NOT OLD.id OR NEW.report_id IS NOT OLD.report_id
    OR NEW.project_id IS NOT OLD.project_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.event_type IS NOT OLD.event_type
    OR NEW.payload_json IS NOT OLD.payload_json OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT,'outbox_delivery_immutable') WHERE OLD.status='delivered' AND NEW.status<>'delivered';
  SELECT RAISE(ABORT,'outbox_attempts_regressed') WHERE NEW.attempts<OLD.attempts;
END;
CREATE TRIGGER report_submission_outbox_no_delete BEFORE DELETE ON report_submission_outbox BEGIN
  SELECT RAISE(ABORT,'outbox_delete_forbidden');
END;
`
