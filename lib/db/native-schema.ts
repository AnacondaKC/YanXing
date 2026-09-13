import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_BRAND_DISPLAY_TEXT } from '@/lib/branding'
import { seedInitialAiSettings } from '@/lib/db/initial-ai-settings'
import { NativeSchemaError } from '@/lib/db/native-schema-error'
import { REPORT_UPLOAD_SCHEMA, installReportUploadSchema } from '@/lib/db/report-upload-schema'
import { STAGE_REPORT_SCHEMA_SQL, installStageReportSchema } from '@/lib/db/stage-report-schema'
import { SUBMISSION_TASK_SCHEMA_SQL, assertSubmissionTaskSchema, installSubmissionTaskSchema } from '@/lib/db/submission-task-schema'
import { getReportStorageRoot } from '@/lib/storage/runtime-roots'

export const NATIVE_SCHEMA_NAME = 'yanxing-native-p3'

export const LEGACY_SCHEMA_MARKERS = [
  'schema_migrations',
  'report_versions',
  'report_facts',
  'analysis_jobs',
  'analysis_module_states',
  'analysis_artifacts',
  'analysis_snapshots',
  'job_events',
  'report_insights',
  'report_insight_reservations',
  'ai_budget_ledger',
] as const

export const REQUIRED_NATIVE_TABLES = [
  'users',
  'sessions',
  'projects',
  'project_members',
  'notifications',
  'knowledge_items',
  'ai_model_channels',
  'ai_model_profiles',
  'ai_model_assignments',
  'ai_prompt_settings',
  'storage_usage',
  'storage_reservations',
  'storage_allocations',
  'brand_settings',
  'settings_revisions',
  'rate_limit_buckets',
  'native_schema_identity',
  'project_report_state',
  'project_stages',
  'report_submissions',
  'submission_storage_root',
  'report_uploads',
  'stage_project_audit',
  'report_submission_documents',
  'report_submission_requests',
  'report_submission_audit',
  'report_submission_outbox',
  'submission_task_schema',
  'submission_tasks',
  'submission_task_calls',
  'submission_task_data',
  'submission_task_results',
  'submission_task_dispatches',
  'submission_task_events',
] as const

export const REQUIRED_NATIVE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ['id', 'username', 'display_name', 'password_hash', 'role', 'status', 'avatar', 'created_at', 'updated_at', 'last_login_at'],
  sessions: ['id', 'user_id', 'token_hash', 'csrf_token_hash', 'expires_at', 'created_at'],
  projects: ['id', 'title', 'objective', 'description', 'owner_name', 'membership_revision', 'created_at', 'updated_at'],
  project_members: ['project_id', 'user_id', 'role', 'created_at'],
  notifications: ['id', 'recipient_user_id', 'action', 'actor_user_id', 'actor_name', 'project_id', 'project_title', 'report_id', 'report_title', 'summary', 'detail', 'read_at', 'created_at'],
  knowledge_items: ['id', 'title', 'file_name', 'file_size', 'category', 'description', 'tags_json', 'source_path', 'file_hash', 'uploaded_by', 'uploaded_by_user_id', 'created_at', 'updated_at'],
  brand_settings: ['id', 'display_text', 'header_logo', 'header_logo_mime', 'login_watermark', 'login_watermark_mime', 'revision', 'updated_at', 'updated_by'],
  native_schema_identity: ['id', 'name', 'checksum', 'initialized_at'],
  submission_storage_root: ['id', 'path'],
}

export const REQUIRED_NATIVE_INDEXES = [
  'idx_sessions_expiry',
  'idx_project_members_user',
  'idx_project_members_single_owner',
  'idx_notifications_recipient_created',
  'idx_notifications_recipient_unread',
  'idx_storage_reservations_expiry',
  'idx_storage_allocations_project',
  'idx_storage_allocations_user',
  'idx_knowledge_items_created',
  'idx_knowledge_items_category_created_id',
  'idx_projects_updated_id',
  'idx_ai_model_profiles_channel',
  'idx_rate_limit_buckets_updated',
  'idx_rate_limit_buckets_window_started',
  'uq_project_stages_one_in_progress',
  'uq_project_stages_current_completion_report',
  'uq_report_submissions_one_first_per_stage',
  'idx_report_submissions_source_key',
  'report_uploads_owner_status',
  'report_upload_recovery_due',
  'report_submission_audit_project',
  'report_submission_outbox_ready',
  'one_active_submission_task',
  'submission_tasks_due',
] as const

export const REQUIRED_NATIVE_TRIGGERS = [
  'project_report_state_protect_invariants',
  'project_stages_protect_invariants',
  'project_stages_validate_completion_pointer_insert',
  'project_stages_validate_completion_pointer_update',
  'report_submissions_forbid_hard_delete',
  'report_submissions_protect_immutable_fields',
  'report_submissions_protect_current_completion',
  'report_submissions_success_monotonic',
  'report_submissions_tombstone_immutable',
  'submission_storage_root_no_update',
  'submission_storage_root_no_delete',
  'stage_project_audit_no_update',
  'stage_project_audit_no_delete',
  'report_uploads_no_delete',
  'report_uploads_immutable_identity',
  'report_uploads_validate_commit',
  'report_submission_requests_identity',
  'report_submission_outbox_identity',
  'report_submission_audit_identity',
  'report_submission_documents_immutable',
  'report_submission_documents_no_delete',
  'report_submission_requests_immutable',
  'report_submission_requests_no_delete',
  'report_submission_audit_immutable',
  'report_submission_audit_no_delete',
  'report_submission_outbox_immutable',
  'report_submission_outbox_no_delete',
  'submission_task_insert_guard',
  'submission_task_immutable',
  'submission_task_no_delete',
  'submission_result_guard',
  'submission_result_no_update',
  'submission_result_no_delete',
  'submission_call_insert_guard',
  'submission_call_immutable',
  'submission_call_no_delete',
  'submission_event_no_update',
  'submission_event_no_delete',
  'submission_dispatch_no_update',
  'submission_dispatch_no_delete',
  'submission_active_task_blocks_delete',
] as const

export type DatabaseSchemaKind = 'empty' | 'native' | 'legacy' | 'incompatible'

export type NativeDatabaseInfo = {
  path: string
  schema: typeof NATIVE_SCHEMA_NAME
  checksum: string
  storageRoot: string
}

export const FRESH_SHARED_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'researcher')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    avatar TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_name TEXT NOT NULL,
    membership_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, user_id)
  );

  CREATE TABLE knowledge_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT '行业研报',
    description TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    source_path TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_by_user_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE ai_model_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel = 'chat_completions'),
    base_url TEXT NOT NULL DEFAULT '',
    api_key_encrypted TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE ai_model_profiles (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES ai_model_channels(id) ON DELETE CASCADE,
    model_name TEXT NOT NULL,
    max_context_characters INTEGER NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('auto', 'low', 'medium', 'high', 'xhigh', 'max')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(channel_id, model_name)
  );

  CREATE TABLE ai_model_assignments (
    target TEXT PRIMARY KEY CHECK (target IN ('page_analysis', 'report_insight')),
    model_id TEXT REFERENCES ai_model_profiles(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE ai_prompt_settings (
    target TEXT PRIMARY KEY CHECK (target IN ('global_system', 'page_analysis', 'report_insight')),
    system_prompt TEXT NOT NULL,
    instruction_prompt TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE storage_usage (
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'user', 'project')),
    scope_id TEXT NOT NULL,
    used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
    reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_type, scope_id)
  );

  CREATE TABLE storage_reservations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('report', 'knowledge')),
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'released', 'expired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE storage_allocations (
    owner_type TEXT NOT NULL CHECK (owner_type IN ('report', 'knowledge')),
    owner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    file_hash TEXT NOT NULL,
    source_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_type, owner_id)
  );

  CREATE TABLE settings_revisions (
    scope TEXT PRIMARY KEY CHECK (scope IN ('models', 'prompts')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE rate_limit_buckets (
    bucket_key TEXT NOT NULL,
    window_started_at INTEGER NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bucket_key, window_started_at)
  );

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN (
      'project_created', 'project_updated', 'project_deleted',
      'report_uploaded', 'report_assigned', 'report_replaced', 'report_deleted',
      'analysis_started', 'analysis_cancelled', 'insight_started'
    )),
    actor_user_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    project_id TEXT,
    project_title TEXT NOT NULL DEFAULT '',
    report_id TEXT,
    report_title TEXT,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE brand_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    display_text TEXT NOT NULL CHECK (length(display_text) BETWEEN 1 AND 60),
    header_logo BLOB,
    header_logo_mime TEXT CHECK (header_logo_mime IN ('image/png', 'image/jpeg', 'image/webp')),
    login_watermark BLOB,
    login_watermark_mime TEXT CHECK (login_watermark_mime IN ('image/png', 'image/jpeg', 'image/webp')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT,
    updated_by TEXT,
    CHECK ((header_logo IS NULL) = (header_logo_mime IS NULL)),
    CHECK ((login_watermark IS NULL) = (login_watermark_mime IS NULL))
  );

  CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX idx_project_members_user ON project_members(user_id, project_id);
  CREATE UNIQUE INDEX idx_project_members_single_owner ON project_members(project_id) WHERE role = 'owner';
  CREATE INDEX idx_notifications_recipient_created ON notifications(recipient_user_id, created_at DESC, id DESC);
  CREATE INDEX idx_notifications_recipient_unread ON notifications(recipient_user_id, read_at, created_at DESC, id DESC);
  CREATE INDEX idx_storage_reservations_expiry ON storage_reservations(state, expires_at);
  CREATE INDEX idx_storage_allocations_project ON storage_allocations(project_id, created_at);
  CREATE INDEX idx_storage_allocations_user ON storage_allocations(user_id, created_at);
  CREATE INDEX idx_knowledge_items_created ON knowledge_items(created_at DESC);
  CREATE INDEX idx_knowledge_items_category_created_id ON knowledge_items(category, created_at DESC, id DESC);
  CREATE INDEX idx_projects_updated_id ON projects(updated_at DESC, id DESC);
  CREATE INDEX idx_ai_model_profiles_channel ON ai_model_profiles(channel_id, created_at, id);
  CREATE INDEX idx_rate_limit_buckets_updated ON rate_limit_buckets(updated_at);
  CREATE INDEX idx_rate_limit_buckets_window_started ON rate_limit_buckets(window_started_at);
`

const IDENTITY_TABLE_SQL = `
  CREATE TABLE native_schema_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    initialized_at TEXT NOT NULL
  );
`

const SCHEMA_CHECKSUM_SEPARATOR = String.fromCharCode(10)

export const NATIVE_SCHEMA_CHECKSUM = createHash('sha256')
  .update(FRESH_SHARED_SCHEMA_SQL)
  .update(SCHEMA_CHECKSUM_SEPARATOR)
  .update(IDENTITY_TABLE_SQL)
  .update(SCHEMA_CHECKSUM_SEPARATOR)
  .update(DEFAULT_BRAND_DISPLAY_TEXT)
  .update(SCHEMA_CHECKSUM_SEPARATOR)
  .update(STAGE_REPORT_SCHEMA_SQL)
  .update(SCHEMA_CHECKSUM_SEPARATOR)
  .update(REPORT_UPLOAD_SCHEMA)
  .update(SCHEMA_CHECKSUM_SEPARATOR)
  .update(SUBMISSION_TASK_SCHEMA_SQL)
  .digest('hex')

export function listUserTables(database: DatabaseSync) {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}

export function tableExists(database: DatabaseSync, name: string) {
  const row = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name) as { present?: number } | undefined
  return row !== undefined
}

export function classifyDatabaseSchema(database: DatabaseSync): DatabaseSchemaKind {
  const tables = new Set(listUserTables(database))
  if (tables.size === 0) return 'empty'
  if (LEGACY_SCHEMA_MARKERS.some((name) => tables.has(name))) return 'legacy'
  if (!tables.has('native_schema_identity')) return 'incompatible'
  return 'native'
}

export function installFreshSharedSchema(database: DatabaseSync) {
  database.exec(FRESH_SHARED_SCHEMA_SQL)
}

export function readNativeIdentity(database: DatabaseSync) {
  if (!tableExists(database, 'native_schema_identity')) return undefined
  const row = database.prepare(
    'SELECT name, checksum, initialized_at FROM native_schema_identity WHERE id = 1',
  ).get() as { name?: unknown; checksum?: unknown; initialized_at?: unknown } | undefined
  if (!row || typeof row.name !== 'string' || typeof row.checksum !== 'string') return undefined
  return {
    name: row.name,
    checksum: row.checksum,
    initializedAt: typeof row.initialized_at === 'string' ? row.initialized_at : '',
  }
}

export function readBoundStorageRoot(database: DatabaseSync) {
  if (!tableExists(database, 'submission_storage_root')) return undefined
  const row = database.prepare('SELECT path FROM submission_storage_root WHERE id = 1').get() as { path?: unknown } | undefined
  return typeof row?.path === 'string' && row.path.length > 0 ? row.path : undefined
}

export function assertNativeSchema(input: { database: DatabaseSync; storageRoot: string }) {
  const kind = classifyDatabaseSchema(input.database)
  if (kind === 'legacy') throw new NativeSchemaError('LEGACY_DATABASE')
  if (kind !== 'native') throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
  const identity = readNativeIdentity(input.database)
  if (!identity || identity.name !== NATIVE_SCHEMA_NAME) {
    throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
  }
  if (identity.checksum !== NATIVE_SCHEMA_CHECKSUM) {
    throw new NativeSchemaError('IDENTITY_MISMATCH')
  }
  for (const name of REQUIRED_NATIVE_TABLES) {
    if (!tableExists(input.database, name)) throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
  }
  assertNativeStructure(input.database)
  const boundRoot = readBoundStorageRoot(input.database)
  if (boundRoot !== resolve(input.storageRoot)) {
    throw new NativeSchemaError('STORAGE_ROOT_MISMATCH')
  }
  assertSubmissionTaskSchema(input.database)
}

function listSqliteObjectNames(database: DatabaseSync, type: 'index' | 'trigger') {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'",
  ).all(type) as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function assertNativeStructure(database: DatabaseSync) {
  for (const [table, columns] of Object.entries(REQUIRED_NATIVE_COLUMNS)) {
    const present = new Set(
      (database.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>).map((column) => column.name),
    )
    for (const column of columns) {
      if (!present.has(column)) throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
    }
  }
  const indexes = listSqliteObjectNames(database, 'index')
  for (const name of REQUIRED_NATIVE_INDEXES) {
    if (!indexes.has(name)) throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
  }
  const triggers = listSqliteObjectNames(database, 'trigger')
  for (const name of REQUIRED_NATIVE_TRIGGERS) {
    if (!triggers.has(name)) throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
  }
}

export function ensureNativeDatabase(input: { database: DatabaseSync; storageRoot: string }) {
  const kind = classifyDatabaseSchema(input.database)
  if (kind === 'legacy') throw new NativeSchemaError('LEGACY_DATABASE')
  if (kind === 'incompatible') throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
  if (kind === 'native') {
    assertNativeSchema(input)
    return
  }
  initializeEmptyDatabase(input)
}

function initializeEmptyDatabase(input: { database: DatabaseSync; storageRoot: string }) {
  input.database.exec('BEGIN IMMEDIATE')
  try {
    const kind = classifyDatabaseSchema(input.database)
    if (kind === 'native') {
      input.database.exec('COMMIT')
      assertNativeSchema(input)
      return
    }
    if (kind !== 'empty') {
      if (kind === 'legacy') throw new NativeSchemaError('LEGACY_DATABASE')
      throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
    }
    installNativeSchema(input)
    const foreignKeys = input.database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeys.length > 0) throw new NativeSchemaError('INCOMPATIBLE_DATABASE')
    input.database.exec('COMMIT')
  } catch (error) {
    try { input.database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}

function installNativeSchema(input: { database: DatabaseSync; storageRoot: string }) {
  installFreshSharedSchema(input.database)
  seedBrandSettings(input.database)
  seedInitialAiSettings(input.database)
  installStageReportSchema(input.database)
  installReportUploadSchema(input.database)
  bindSubmissionStorageRoot(input)
  installSubmissionTaskSchema(input.database)
  stampNativeIdentity(input.database)
  assertSubmissionTaskSchema(input.database)
}

function seedBrandSettings(database: DatabaseSync) {
  database.prepare(
    'INSERT INTO brand_settings(id, display_text, revision) VALUES (1, ?, 1)',
  ).run(DEFAULT_BRAND_DISPLAY_TEXT)
}

function bindSubmissionStorageRoot(input: { database: DatabaseSync; storageRoot: string }) {
  input.database.prepare(
    'INSERT INTO submission_storage_root(id, path) VALUES (1, ?)',
  ).run(resolve(input.storageRoot))
}

function stampNativeIdentity(database: DatabaseSync) {
  database.exec(IDENTITY_TABLE_SQL)
  database.prepare(
    'INSERT INTO native_schema_identity(id, name, checksum, initialized_at) VALUES (1, ?, ?, ?)',
  ).run(NATIVE_SCHEMA_NAME, NATIVE_SCHEMA_CHECKSUM, new Date().toISOString())
}

export function nativeDatabaseInfo(path: string): NativeDatabaseInfo {
  return {
    path,
    schema: NATIVE_SCHEMA_NAME,
    checksum: NATIVE_SCHEMA_CHECKSUM,
    storageRoot: getReportStorageRoot(),
  }
}
