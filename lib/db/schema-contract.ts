import type { DatabaseSync } from 'node:sqlite'

type ColumnConstraint = {
  type?: string
  notNull?: boolean
  primaryKey?: number
  defaultValue?: string | null
}

type IndexColumn = { name: string; descending?: boolean }
type IndexContract = {
  name: string
  table: string
  columns: readonly IndexColumn[]
  unique?: boolean
  where?: string
}
type UniqueConstraint = { table: string; columns: readonly string[] }
type ForeignKeyContract = { table: string; from: string; targetTable: string; targetColumn: string; onDelete: string; onUpdate: string }

/** 当前 schema 必须存在的表和列；迁移执行后立即校验。 */
const REQUIRED_SCHEMA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_migrations: ['version', 'name', 'checksum', 'applied_at'],
  users: ['id', 'username', 'display_name', 'password_hash', 'role', 'status', 'avatar', 'created_at', 'updated_at', 'last_login_at'],
  sessions: ['id', 'user_id', 'token_hash', 'csrf_token_hash', 'expires_at', 'created_at'],
  projects: ['id', 'title', 'objective', 'description', 'owner_name', 'membership_revision', 'status', 'stage', 'milestones_json', 'created_at', 'updated_at'],
  project_members: ['project_id', 'user_id', 'role', 'created_at'],
  notifications: ['id', 'recipient_user_id', 'action', 'actor_user_id', 'actor_name', 'project_id', 'project_title', 'report_id', 'report_title', 'summary', 'detail', 'read_at', 'created_at'],
  report_versions: ['id', 'project_id', 'milestone_id', 'delivery_type', 'version', 'title', 'file_name', 'file_hash', 'source_path', 'mime_type', 'source_size', 'paragraph_count', 'character_count', 'previous_character_count', 'parse_status', 'current_analysis_id', 'previous_version_id', 'parse_error', 'created_at', 'source_updated_at'],
  report_facts: ['report_version_id', 'payload_json', 'updated_at'],
  analysis_jobs: ['id', 'report_version_id', 'parent_job_id', 'type', 'status', 'current_stage', 'stage_index', 'attempts', 'cancel_requested', 'lease_owner', 'lease_expires_at', 'latest_partial_snapshot_id', 'prompt_config_json', 'error_message', 'created_at', 'updated_at', 'evaluation_context_json', 'requested_by_user_id', 'available_at', 'priority', 'admission_id', 'last_claimed_at', 'last_retry_at', 'last_retry_reason', 'last_worker_id', 'last_error_code', 'last_error_at', 'terminal_reason', 'terminal_at', 'ai_calls_started', 'ai_calls_completed', 'ai_tokens', 'model_runtime_json'],
  analysis_module_states: ['job_id', 'module_id', 'status', 'attempt', 'max_attempts', 'artifact_id', 'gate_errors_json', 'updated_at'],
  analysis_artifacts: ['id', 'job_id', 'report_version_id', 'module_id', 'schema_version', 'prompt_version', 'attempt', 'status', 'payload_json', 'gate_errors_json', 'provider', 'model', 'created_at', 'accepted_at'],
  analysis_snapshots: ['id', 'job_id', 'report_version_id', 'kind', 'schema_version', 'prompt_version', 'pipeline_version', 'model_calls_json', 'artifacts_json', 'module_states_json', 'payload_json', 'created_at'],
  job_events: ['id', 'job_id', 'type', 'stage', 'module_id', 'errors_json', 'message', 'created_at'],
  report_insights: ['id', 'report_version_id', 'title', 'summary', 'reading_minutes', 'sections_json', 'html', 'provider', 'model', 'generated_at', 'regeneration_count'],
  report_insight_reservations: ['report_version_id', 'owner_token', 'lease_expires_at', 'created_at'],
  knowledge_items: ['id', 'title', 'file_name', 'file_size', 'category', 'description', 'tags_json', 'source_path', 'file_hash', 'uploaded_by', 'uploaded_by_user_id', 'created_at', 'updated_at'],
  ai_model_channels: ['id', 'name', 'channel', 'base_url', 'api_key_encrypted', 'created_at', 'updated_at', 'updated_by'],
  ai_model_profiles: ['id', 'channel_id', 'model_name', 'max_context_characters', 'max_output_tokens', 'reasoning_effort', 'created_at', 'updated_at'],
  ai_model_assignments: ['target', 'model_id', 'updated_at', 'updated_by'],
  ai_prompt_settings: ['target', 'system_prompt', 'instruction_prompt', 'version', 'updated_at', 'updated_by'],
  storage_usage: ['scope_type', 'scope_id', 'used_bytes', 'item_count', 'reserved_bytes', 'reserved_count', 'revision', 'updated_at'],
  storage_reservations: ['id', 'user_id', 'project_id', 'expected_bytes', 'owner_type', 'expires_at', 'state', 'created_at', 'updated_at'],
  storage_allocations: ['owner_type', 'owner_id', 'user_id', 'project_id', 'size_bytes', 'file_hash', 'source_path', 'mime_type', 'created_at', 'updated_at'],
  ai_budget_ledger: ['id', 'job_id', 'report_version_id', 'user_id', 'project_id', 'operation', 'period_key', 'reserved_tokens', 'actual_tokens', 'state', 'available_at', 'expires_at', 'metadata_json', 'created_at', 'updated_at', 'call_started_at', 'call_completed_at', 'model_calls_started', 'model_calls_completed', 'accounted_tokens', 'uncertain_at', 'reconciled_at', 'reconciliation_reason', 'last_provider', 'last_model', 'last_stage', 'last_module', 'last_attempt'],
  ai_budget_settings: ['id', 'daily_tokens', 'seven_day_tokens', 'revision', 'updated_at', 'updated_by'],
  brand_settings: ['id', 'display_text', 'header_logo', 'header_logo_mime', 'login_watermark', 'login_watermark_mime', 'revision', 'updated_at', 'updated_by'],
  settings_revisions: ['scope', 'revision', 'updated_at', 'updated_by'],
  rate_limit_buckets: ['bucket_key', 'window_started_at', 'count', 'updated_at'],
}

/** 关键列约束；任务与预算表严格匹配当前字段，其余表允许额外列。 */
const REQUIRED_COLUMN_CONSTRAINTS: Readonly<Record<string, Readonly<Record<string, ColumnConstraint>>>> = {
  schema_migrations: {
    version: { type: 'INTEGER', primaryKey: 1 },
    name: { type: 'TEXT', notNull: true },
    checksum: { type: 'TEXT', notNull: true },
    applied_at: { type: 'TEXT', notNull: true },
  },
  users: {
    username: { type: 'TEXT', notNull: true },
    role: { type: 'TEXT', notNull: true },
    status: { type: 'TEXT', notNull: true, defaultValue: "'active'" },
  },
  projects: {
    membership_revision: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    status: { type: 'TEXT', notNull: true },
    milestones_json: { type: 'TEXT', notNull: true, defaultValue: "'[]'" },
  },
  project_members: {
    project_id: { type: 'TEXT', notNull: true, primaryKey: 1 },
    user_id: { type: 'TEXT', notNull: true, primaryKey: 2 },
    role: { type: 'TEXT', notNull: true },
  },
  notifications: {
    id: { type: 'TEXT', primaryKey: 1 },
    recipient_user_id: { type: 'TEXT', notNull: true },
    action: { type: 'TEXT', notNull: true },
    actor_user_id: { type: 'TEXT', notNull: true },
    actor_name: { type: 'TEXT', notNull: true },
    project_title: { type: 'TEXT', notNull: true, defaultValue: "''" },
    summary: { type: 'TEXT', notNull: true },
    detail: { type: 'TEXT', notNull: true },
  },
  report_versions: {
    project_id: { type: 'TEXT', notNull: true },
    version: { type: 'INTEGER', notNull: true },
    parse_status: { type: 'TEXT', notNull: true },
    paragraph_count: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    character_count: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    source_updated_at: { type: 'TEXT', notNull: true, defaultValue: "''" },
  },
  analysis_jobs: {
    report_version_id: { type: 'TEXT', notNull: true },
    type: { type: 'TEXT', notNull: true },
    status: { type: 'TEXT', notNull: true },
    current_stage: { type: 'TEXT', notNull: true },
    stage_index: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    attempts: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    cancel_requested: { type: 'INTEGER', notNull: true, defaultValue: '0' },
  },
  analysis_module_states: {
    job_id: { type: 'TEXT', notNull: true, primaryKey: 1 },
    module_id: { type: 'TEXT', notNull: true, primaryKey: 2 },
  },
  storage_usage: {
    scope_type: { type: 'TEXT', notNull: true, primaryKey: 1 },
    scope_id: { type: 'TEXT', notNull: true, primaryKey: 2 },
    used_bytes: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    reserved_bytes: { type: 'INTEGER', notNull: true, defaultValue: '0' },
  },
  storage_reservations: {
    id: { type: 'TEXT', primaryKey: 1 },
    user_id: { type: 'TEXT', notNull: true },
    expected_bytes: { type: 'INTEGER', notNull: true },
    owner_type: { type: 'TEXT', notNull: true },
    state: { type: 'TEXT', notNull: true },
  },
  storage_allocations: {
    owner_type: { type: 'TEXT', notNull: true, primaryKey: 1 },
    owner_id: { type: 'TEXT', notNull: true, primaryKey: 2 },
    size_bytes: { type: 'INTEGER', notNull: true },
  },
  ai_budget_ledger: {
    id: { type: 'TEXT', primaryKey: 1 },
    user_id: { type: 'TEXT', notNull: true },
    project_id: { type: 'TEXT', notNull: false },
    operation: { type: 'TEXT', notNull: true },
    period_key: { type: 'TEXT', notNull: true },
    reserved_tokens: { type: 'INTEGER', notNull: true },
    actual_tokens: { type: 'INTEGER', notNull: false },
    state: { type: 'TEXT', notNull: true },
    model_calls_started: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    model_calls_completed: { type: 'INTEGER', notNull: true, defaultValue: '0' },
    accounted_tokens: { type: 'INTEGER', notNull: true, defaultValue: '0' },
  },
  ai_budget_settings: {
    id: { type: 'INTEGER', primaryKey: 1 },
    daily_tokens: { type: 'INTEGER', notNull: true },
    seven_day_tokens: { type: 'INTEGER', notNull: true },
    revision: { type: 'INTEGER', notNull: true },
    updated_at: { type: 'TEXT', notNull: true },
    updated_by: { type: 'TEXT', notNull: true },
  },
  brand_settings: {
    id: { type: 'INTEGER', primaryKey: 1 },
    display_text: { type: 'TEXT', notNull: true },
    revision: { type: 'INTEGER', notNull: true },
  },
  rate_limit_buckets: {
    bucket_key: { type: 'TEXT', notNull: true, primaryKey: 1 },
    window_started_at: { type: 'INTEGER', notNull: true, primaryKey: 2 },
    count: { type: 'INTEGER', notNull: true },
  },
}

const REQUIRED_SCHEMA_INDEXES: readonly IndexContract[] = [
  { name: 'idx_sessions_expiry', table: 'sessions', columns: [{ name: 'expires_at' }] },
  { name: 'idx_project_members_user', table: 'project_members', columns: [{ name: 'user_id' }, { name: 'project_id' }] },
  { name: 'idx_project_members_single_owner', table: 'project_members', columns: [{ name: 'project_id' }], unique: true, where: "role = 'owner'" },
  { name: 'idx_notifications_recipient_created', table: 'notifications', columns: [{ name: 'recipient_user_id' }, { name: 'created_at', descending: true }, { name: 'id', descending: true }] },
  { name: 'idx_notifications_recipient_unread', table: 'notifications', columns: [{ name: 'recipient_user_id' }, { name: 'read_at' }, { name: 'created_at', descending: true }, { name: 'id', descending: true }] },
  { name: 'idx_report_versions_project_created', table: 'report_versions', columns: [{ name: 'project_id' }, { name: 'created_at', descending: true }] },
  { name: 'idx_report_versions_project_milestone', table: 'report_versions', columns: [{ name: 'project_id' }, { name: 'milestone_id' }] },
  { name: 'idx_report_versions_created_at', table: 'report_versions', columns: [{ name: 'created_at' }] },
  { name: 'idx_report_versions_created_id', table: 'report_versions', columns: [{ name: 'created_at', descending: true }, { name: 'id', descending: true }] },
  { name: 'idx_report_versions_project_version', table: 'report_versions', columns: [{ name: 'project_id' }, { name: 'version', descending: true }, { name: 'created_at', descending: true }] },
  { name: 'idx_analysis_jobs_claim', table: 'analysis_jobs', columns: [{ name: 'status' }, { name: 'created_at' }] },
  { name: 'idx_analysis_jobs_report', table: 'analysis_jobs', columns: [{ name: 'report_version_id' }, { name: 'created_at', descending: true }] },
  { name: 'idx_analysis_jobs_active_report_type', table: 'analysis_jobs', columns: [{ name: 'report_version_id' }, { name: 'type' }], unique: true, where: "status IN ('queued', 'running')" },
  { name: 'idx_analysis_jobs_updated_at', table: 'analysis_jobs', columns: [{ name: 'updated_at' }] },
  { name: 'idx_analysis_jobs_available', table: 'analysis_jobs', columns: [{ name: 'status' }, { name: 'available_at' }, { name: 'priority', descending: true }, { name: 'created_at' }] },
  { name: 'idx_analysis_jobs_requested_user', table: 'analysis_jobs', columns: [{ name: 'requested_by_user_id' }, { name: 'status' }, { name: 'created_at' }] },
  { name: 'idx_analysis_jobs_terminal', table: 'analysis_jobs', columns: [{ name: 'status' }, { name: 'terminal_reason' }, { name: 'terminal_at' }] },
  { name: 'idx_analysis_artifacts_job_module', table: 'analysis_artifacts', columns: [{ name: 'job_id' }, { name: 'module_id' }, { name: 'status' }] },
  { name: 'idx_analysis_snapshots_report_created', table: 'analysis_snapshots', columns: [{ name: 'report_version_id' }, { name: 'created_at', descending: true }] },
  { name: 'idx_analysis_snapshots_job_kind_created', table: 'analysis_snapshots', columns: [{ name: 'job_id' }, { name: 'kind' }, { name: 'created_at', descending: true }, { name: 'id', descending: true }] },
  { name: 'idx_job_events_job_id_id', table: 'job_events', columns: [{ name: 'job_id' }, { name: 'id' }] },
  { name: 'idx_job_events_created_at', table: 'job_events', columns: [{ name: 'created_at' }] },
  { name: 'idx_storage_reservations_expiry', table: 'storage_reservations', columns: [{ name: 'state' }, { name: 'expires_at' }] },
  { name: 'idx_storage_allocations_project', table: 'storage_allocations', columns: [{ name: 'project_id' }, { name: 'created_at' }] },
  { name: 'idx_storage_allocations_user', table: 'storage_allocations', columns: [{ name: 'user_id' }, { name: 'created_at' }] },
  { name: 'idx_ai_budget_ledger_job', table: 'ai_budget_ledger', columns: [{ name: 'job_id' }], unique: true, where: 'job_id IS NOT NULL' },
  { name: 'idx_ai_budget_ledger_user_period', table: 'ai_budget_ledger', columns: [{ name: 'user_id' }, { name: 'period_key' }, { name: 'state' }] },
  { name: 'idx_ai_budget_ledger_expiry', table: 'ai_budget_ledger', columns: [{ name: 'state' }, { name: 'expires_at' }] },
  { name: 'idx_ai_budget_ledger_reconcile', table: 'ai_budget_ledger', columns: [{ name: 'state' }, { name: 'expires_at' }, { name: 'job_id' }] },
  { name: 'idx_knowledge_items_created', table: 'knowledge_items', columns: [{ name: 'created_at', descending: true }] },
  { name: 'idx_knowledge_items_category_created_id', table: 'knowledge_items', columns: [{ name: 'category' }, { name: 'created_at', descending: true }, { name: 'id', descending: true }] },
  { name: 'idx_projects_updated_id', table: 'projects', columns: [{ name: 'updated_at', descending: true }, { name: 'id', descending: true }] },
  { name: 'idx_ai_model_profiles_channel', table: 'ai_model_profiles', columns: [{ name: 'channel_id' }, { name: 'created_at' }, { name: 'id' }] },
  { name: 'idx_rate_limit_buckets_updated', table: 'rate_limit_buckets', columns: [{ name: 'updated_at' }] },
  { name: 'idx_rate_limit_buckets_window_started', table: 'rate_limit_buckets', columns: [{ name: 'window_started_at' }] },
]

const REQUIRED_UNIQUE_CONSTRAINTS: readonly UniqueConstraint[] = [
  { table: 'schema_migrations', columns: ['name'] },
  { table: 'users', columns: ['username'] },
  { table: 'sessions', columns: ['token_hash'] },
  { table: 'report_versions', columns: ['project_id', 'version'] },
  { table: 'report_versions', columns: ['project_id', 'file_hash'] },
  { table: 'ai_model_profiles', columns: ['channel_id', 'model_name'] },
  { table: 'report_insights', columns: ['report_version_id'] },
]

const REQUIRED_FOREIGN_KEYS: readonly ForeignKeyContract[] = [
  { table: 'sessions', from: 'user_id', targetTable: 'users', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'notifications', from: 'recipient_user_id', targetTable: 'users', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'project_members', from: 'project_id', targetTable: 'projects', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'project_members', from: 'user_id', targetTable: 'users', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'report_versions', from: 'project_id', targetTable: 'projects', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'report_versions', from: 'previous_version_id', targetTable: 'report_versions', targetColumn: 'id', onDelete: 'SET NULL', onUpdate: 'NO ACTION' },
  { table: 'report_facts', from: 'report_version_id', targetTable: 'report_versions', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'analysis_jobs', from: 'report_version_id', targetTable: 'report_versions', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'analysis_jobs', from: 'parent_job_id', targetTable: 'analysis_jobs', targetColumn: 'id', onDelete: 'SET NULL', onUpdate: 'NO ACTION' },
  { table: 'analysis_module_states', from: 'job_id', targetTable: 'analysis_jobs', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'analysis_artifacts', from: 'job_id', targetTable: 'analysis_jobs', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'analysis_artifacts', from: 'report_version_id', targetTable: 'report_versions', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'analysis_snapshots', from: 'job_id', targetTable: 'analysis_jobs', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'analysis_snapshots', from: 'report_version_id', targetTable: 'report_versions', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'job_events', from: 'job_id', targetTable: 'analysis_jobs', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'report_insights', from: 'report_version_id', targetTable: 'report_versions', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'report_insight_reservations', from: 'report_version_id', targetTable: 'report_versions', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'ai_model_profiles', from: 'channel_id', targetTable: 'ai_model_channels', targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
  { table: 'ai_model_assignments', from: 'model_id', targetTable: 'ai_model_profiles', targetColumn: 'id', onDelete: 'SET NULL', onUpdate: 'NO ACTION' },
]

const REQUIRED_SCHEMA_CHECKS: Readonly<Record<string, readonly string[]>> = {
  users: ["role IN ('admin', 'researcher')", "status IN ('active', 'disabled')"],
  notifications: ["action IN ('project_created', 'project_updated', 'project_deleted', 'report_uploaded', 'report_assigned', 'report_replaced', 'report_deleted', 'analysis_started', 'analysis_cancelled', 'insight_started')"],
  project_members: ["role IN ('owner', 'editor')"],
  report_versions: ["delivery_type IN ('stage', 'final')", "parse_status IN ('uploaded', 'ready', 'failed')"],
  analysis_jobs: ["type IN ('initial', 'rerun', 'insight')", "status IN ('queued', 'running', 'failed', 'cancelled', 'completed')"],
  analysis_module_states: ["module_id IN ('page_analysis', 'report_insight')"],
  analysis_artifacts: ["status IN ('accepted', 'failed')", "module_id IN ('page_analysis', 'report_insight')"],
  analysis_snapshots: ["kind IN ('partial', 'final')"],
  ai_model_channels: ["channel = 'chat_completions'"],
  ai_model_profiles: ["reasoning_effort IN ('auto', 'low', 'medium', 'high', 'xhigh', 'max')"],
  storage_usage: ["scope_type IN ('global', 'user', 'project')", 'used_bytes >= 0', 'reserved_bytes >= 0'],
  storage_reservations: ['expected_bytes > 0', "owner_type IN ('report', 'knowledge')", "state IN ('active', 'consumed', 'released', 'expired')"],
  storage_allocations: ["owner_type IN ('report', 'knowledge')", 'size_bytes > 0'],
  ai_budget_ledger: [
    "operation IN ('analysis', 'insight')",
    "state IN ('reserved', 'settled', 'released', 'uncertain', 'dead_letter')",
    'reserved_tokens > 0',
    'model_calls_started >= 0',
    'model_calls_completed >= 0',
    'accounted_tokens >= 0',
  ],
  ai_budget_settings: [
    'id = 1',
    "typeof(daily_tokens) = 'integer' AND daily_tokens BETWEEN 1 AND 9007199254740991",
    "typeof(seven_day_tokens) = 'integer' AND seven_day_tokens BETWEEN 1 AND 9007199254740991",
    "typeof(revision) = 'integer' AND revision BETWEEN 2 AND 9007199254740991",
  ],
  rate_limit_buckets: ['count >= 0'],
}

/** 校验当前数据库满足 schema 契约；只在迁移执行后调用，不进入常规读写路径。 */
export function assertSchemaContract(database: DatabaseSync) {
  const violations: string[] = []
  for (const [tableName, expectedColumns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    const rows = database.prepare("PRAGMA table_info('" + escapePragmaString(tableName) + "')").all() as Array<{ name?: unknown; type?: unknown; notnull?: unknown; dflt_value?: unknown; pk?: unknown }>
    const actualColumns = rows.flatMap((row) => typeof row.name === 'string' ? [row.name] : [])
    const requiresExactColumns = ['analysis_jobs', 'ai_budget_settings', 'ai_budget_ledger'].includes(tableName)
    if ((requiresExactColumns && actualColumns.length !== expectedColumns.length)
      || expectedColumns.some((columnName, index) => actualColumns[index] !== columnName)) {
      violations.push('table ' + tableName + ' columns/order')
    }
    const constraints = REQUIRED_COLUMN_CONSTRAINTS[tableName]
    for (const [columnName, expected] of Object.entries(constraints ?? {})) {
      const row = rows.find((candidate) => candidate.name === columnName)
      if (!row || !columnMatches(row, expected)) violations.push('constraint ' + tableName + '.' + columnName)
    }
  }

  for (const index of REQUIRED_SCHEMA_INDEXES) {
    const indexRow = database.prepare("PRAGMA index_list('" + escapePragmaString(index.table) + "')").all() as Array<{ name?: unknown; unique?: unknown; partial?: unknown }>
    const actual = indexRow.find((row) => row.name === index.name)
    if (!actual) {
      violations.push('index ' + index.name)
      continue
    }
    const actualTable = database.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index.name) as { tbl_name?: unknown; sql?: unknown } | undefined
    const actualColumns = readIndexColumns(database, index.name)
    const actualWhere = extractWhere(typeof actualTable?.sql === 'string' ? actualTable.sql : '')
    if (actualTable?.tbl_name !== index.table
      || Number(actual.unique) !== (index.unique ? 1 : 0)
      || Number(actual.partial) !== (index.where ? 1 : 0)
      || !sameIndexColumns(actualColumns, index.columns)
      || actualWhere !== (index.where ? normalizeSql(index.where) : undefined)) {
      violations.push('index ' + index.name + ' definition')
    }
  }

  for (const constraint of REQUIRED_UNIQUE_CONSTRAINTS) {
    const indexes = database.prepare("PRAGMA index_list('" + escapePragmaString(constraint.table) + "')").all() as Array<{ name?: unknown; unique?: unknown }>
    const found = indexes.some((index) => Number(index.unique) === 1 && typeof index.name === 'string' && sameIndexColumns(readIndexColumns(database, index.name), constraint.columns.map((name) => ({ name }))))
    if (!found) violations.push('unique ' + constraint.table + '(' + constraint.columns.join(', ') + ')')
  }

  for (const foreignKey of REQUIRED_FOREIGN_KEYS) {
    const keys = database.prepare("PRAGMA foreign_key_list('" + escapePragmaString(foreignKey.table) + "')").all() as Array<{ from?: unknown; table?: unknown; to?: unknown; on_delete?: unknown; on_update?: unknown }>
    const found = keys.some((key) => key.from === foreignKey.from
      && key.table === foreignKey.targetTable
      && key.to === foreignKey.targetColumn
      && normalizeAction(key.on_delete) === foreignKey.onDelete
      && normalizeAction(key.on_update) === foreignKey.onUpdate)
    if (!found) violations.push('foreign key ' + foreignKey.table + '.' + foreignKey.from)
  }

  for (const [tableName, checks] of Object.entries(REQUIRED_SCHEMA_CHECKS)) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { sql?: unknown } | undefined
    const sql = normalizeSql(typeof row?.sql === 'string' ? row.sql : '')
    for (const check of checks) {
      if (!sql.includes(normalizeSql(check))) violations.push('check ' + tableName + ': ' + check)
    }
  }

  if (violations.length) throw new Error('数据库结构校验失败：' + violations.join('、'))
}

function columnMatches(row: { type?: unknown; notnull?: unknown; dflt_value?: unknown; pk?: unknown }, expected: ColumnConstraint) {
  return (expected.type === undefined || String(row.type).toUpperCase() === expected.type.toUpperCase())
    && (expected.notNull === undefined || Number(row.notnull) === (expected.notNull ? 1 : 0))
    && (expected.primaryKey === undefined || Number(row.pk) === expected.primaryKey)
    && (expected.defaultValue === undefined || normalizeDefault(row.dflt_value) === normalizeDefault(expected.defaultValue))
}

function readIndexColumns(database: DatabaseSync, indexName: string): IndexColumn[] {
  const rows = database.prepare("PRAGMA index_xinfo('" + escapePragmaString(indexName) + "')").all() as Array<{ seqno?: unknown; name?: unknown; desc?: unknown; key?: unknown }>
  return rows
    .filter((row) => Number(row.key) === 1 && typeof row.name === 'string')
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((row) => ({ name: String(row.name), descending: Number(row.desc) === 1 }))
}

function sameIndexColumns(actual: readonly IndexColumn[], expected: readonly IndexColumn[]) {
  return actual.length === expected.length && expected.every((column, index) => actual[index]?.name === column.name && Boolean(actual[index]?.descending) === Boolean(column.descending))
}

function extractWhere(sql: string) {
  const normalized = normalizeSql(sql)
  const whereMatch = normalized.match(/\bwhere\b(.*)$/)
  return whereMatch?.[1].trim()
}

function normalizeSql(value: string) {
  return value
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/;$/, '')
}

function normalizeDefault(value: unknown) {
  return value === null || value === undefined ? null : normalizeSql(String(value))
}

function normalizeAction(value: unknown) {
  return String(value ?? '').toUpperCase()
}

function escapePragmaString(value: string) {
  return value.replace(/'/g, "''")
}
