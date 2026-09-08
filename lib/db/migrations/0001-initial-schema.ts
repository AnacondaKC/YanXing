import type { DatabaseSync } from 'node:sqlite'
import { seedInitialAiSettings } from '@/lib/db/initial-ai-settings'

/** 全新数据库的唯一初始结构；不包含历史迁移的兼容列、回填或修复逻辑。 */
export const initialSchemaSql = `  CREATE TABLE IF NOT EXISTS users (
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

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_name TEXT NOT NULL,
    membership_revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'at_risk', 'completed')),
    stage TEXT NOT NULL DEFAULT '开题中',
    milestones_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS report_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id TEXT,
    delivery_type TEXT CHECK (delivery_type IN ('stage', 'final')),
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    source_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    source_size INTEGER NOT NULL,
    paragraph_count INTEGER NOT NULL DEFAULT 0,
    character_count INTEGER NOT NULL DEFAULT 0,
    previous_character_count INTEGER,
    parse_status TEXT NOT NULL CHECK (parse_status IN ('uploaded', 'ready', 'failed')),
    current_analysis_id TEXT,
    previous_version_id TEXT REFERENCES report_versions(id) ON DELETE SET NULL,
    parse_error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, version),
    UNIQUE(project_id, file_hash)
  );

  CREATE TABLE IF NOT EXISTS report_facts (
    report_version_id TEXT PRIMARY KEY REFERENCES report_versions(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id TEXT PRIMARY KEY,
    report_version_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
    parent_job_id TEXT REFERENCES analysis_jobs(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('initial', 'rerun', 'insight')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'cancelled', 'completed')),
    current_stage TEXT NOT NULL,
    stage_index INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at TEXT,
    latest_partial_snapshot_id TEXT,
    prompt_config_json TEXT NOT NULL DEFAULT '[]',
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    evaluation_context_json TEXT,
    requested_by_user_id TEXT NOT NULL DEFAULT '',
    available_at TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    admission_id TEXT,
    last_claimed_at TEXT,
    last_retry_at TEXT,
    last_retry_reason TEXT,
    last_worker_id TEXT,
    last_error_code TEXT,
    last_error_at TEXT,
    terminal_reason TEXT,
    terminal_at TEXT,
    ai_calls_started INTEGER NOT NULL DEFAULT 0 CHECK (ai_calls_started >= 0),
    ai_calls_completed INTEGER NOT NULL DEFAULT 0 CHECK (ai_calls_completed >= 0),
    ai_tokens INTEGER NOT NULL DEFAULT 0 CHECK (ai_tokens >= 0),
    model_runtime_json TEXT
  );

  CREATE TABLE IF NOT EXISTS analysis_module_states (
    job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    module_id TEXT NOT NULL CHECK (module_id IN ('page_analysis', 'report_insight')),
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    artifact_id TEXT,
    gate_errors_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY(job_id, module_id)
  );

  CREATE TABLE IF NOT EXISTS analysis_artifacts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    report_version_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
    module_id TEXT NOT NULL CHECK (module_id IN ('page_analysis', 'report_insight')),
    schema_version INTEGER NOT NULL,
    prompt_version TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'failed')),
    payload_json TEXT,
    gate_errors_json TEXT NOT NULL DEFAULT '[]',
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    accepted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS analysis_snapshots (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    report_version_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('partial', 'final')),
    schema_version INTEGER NOT NULL,
    prompt_version TEXT NOT NULL,
    pipeline_version TEXT NOT NULL,
    model_calls_json TEXT NOT NULL,
    artifacts_json TEXT NOT NULL,
    module_states_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    stage TEXT,
    module_id TEXT,
    errors_json TEXT NOT NULL DEFAULT '[]',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS report_insights (
    id TEXT PRIMARY KEY,
    report_version_id TEXT NOT NULL UNIQUE REFERENCES report_versions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    reading_minutes INTEGER NOT NULL,
    sections_json TEXT NOT NULL,
    html TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    regeneration_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS report_insight_reservations (
    report_version_id TEXT PRIMARY KEY REFERENCES report_versions(id) ON DELETE CASCADE,
    owner_token TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_items (
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

  CREATE TABLE IF NOT EXISTS ai_model_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel = 'chat_completions'),
    base_url TEXT NOT NULL DEFAULT '',
    api_key_encrypted TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_model_profiles (
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

  CREATE TABLE IF NOT EXISTS ai_model_assignments (
    target TEXT PRIMARY KEY CHECK (target IN ('page_analysis', 'report_insight')),
    model_id TEXT REFERENCES ai_model_profiles(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_prompt_settings (
    target TEXT PRIMARY KEY CHECK (target IN ('global_system', 'page_analysis', 'report_insight')),
    system_prompt TEXT NOT NULL,
    instruction_prompt TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS storage_usage (
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

  CREATE TABLE IF NOT EXISTS storage_reservations (
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

  CREATE TABLE IF NOT EXISTS storage_allocations (
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

  CREATE TABLE IF NOT EXISTS ai_budget_ledger (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    report_version_id TEXT,
    user_id TEXT NOT NULL,
    project_id TEXT,
    operation TEXT NOT NULL CHECK (operation IN ('analysis', 'insight')),
    period_key TEXT NOT NULL,
    reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
    actual_tokens INTEGER,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'uncertain', 'dead_letter')),
    available_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    call_started_at TEXT,
    call_completed_at TEXT,
    model_calls_started INTEGER NOT NULL DEFAULT 0 CHECK (model_calls_started >= 0),
    model_calls_completed INTEGER NOT NULL DEFAULT 0 CHECK (model_calls_completed >= 0),
    accounted_tokens INTEGER NOT NULL DEFAULT 0 CHECK (accounted_tokens >= 0),
    uncertain_at TEXT,
    reconciled_at TEXT,
    reconciliation_reason TEXT,
    last_provider TEXT,
    last_model TEXT,
    last_stage TEXT,
    last_module TEXT,
    last_attempt INTEGER
  );

  CREATE TABLE IF NOT EXISTS ai_budget_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    daily_tokens INTEGER NOT NULL CHECK (typeof(daily_tokens) = 'integer' AND daily_tokens BETWEEN 1 AND 9007199254740991),
    seven_day_tokens INTEGER NOT NULL CHECK (typeof(seven_day_tokens) = 'integer' AND seven_day_tokens BETWEEN 1 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 2 AND 9007199254740991),
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings_revisions (
    scope TEXT PRIMARY KEY CHECK (scope IN ('models', 'prompts')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT NOT NULL,
    window_started_at INTEGER NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bucket_key, window_started_at)
  );

  CREATE TABLE IF NOT EXISTS notifications (
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

  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id, project_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_single_owner ON project_members(project_id) WHERE role = 'owner';
  CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(recipient_user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications(recipient_user_id, read_at, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_report_versions_project_created ON report_versions(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_report_versions_project_milestone ON report_versions(project_id, milestone_id);
  CREATE INDEX IF NOT EXISTS idx_report_versions_created_at ON report_versions(created_at);
  CREATE INDEX IF NOT EXISTS idx_report_versions_created_id ON report_versions(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_report_versions_project_version ON report_versions(project_id, version DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_analysis_jobs_claim ON analysis_jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_analysis_jobs_report ON analysis_jobs(report_version_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_jobs_active_report_type ON analysis_jobs(report_version_id, type) WHERE status IN ('queued', 'running');
  CREATE INDEX IF NOT EXISTS idx_analysis_jobs_updated_at ON analysis_jobs(updated_at);
  CREATE INDEX IF NOT EXISTS idx_analysis_jobs_available ON analysis_jobs(status, available_at, priority DESC, created_at);
  CREATE INDEX IF NOT EXISTS idx_analysis_jobs_requested_user ON analysis_jobs(requested_by_user_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_analysis_jobs_terminal ON analysis_jobs(status, terminal_reason, terminal_at);
  CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_job_module ON analysis_artifacts(job_id, module_id, status);
  CREATE INDEX IF NOT EXISTS idx_analysis_snapshots_report_created ON analysis_snapshots(report_version_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_analysis_snapshots_job_kind_created ON analysis_snapshots(job_id, kind, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_job_events_job_id_id ON job_events(job_id, id);
  CREATE INDEX IF NOT EXISTS idx_job_events_created_at ON job_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_storage_reservations_expiry ON storage_reservations(state, expires_at);
  CREATE INDEX IF NOT EXISTS idx_storage_allocations_project ON storage_allocations(project_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_storage_allocations_user ON storage_allocations(user_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_budget_ledger_job ON ai_budget_ledger(job_id) WHERE job_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_ai_budget_ledger_user_period ON ai_budget_ledger(user_id, period_key, state);
  CREATE INDEX IF NOT EXISTS idx_ai_budget_ledger_expiry ON ai_budget_ledger(state, expires_at);
  CREATE INDEX IF NOT EXISTS idx_ai_budget_ledger_reconcile ON ai_budget_ledger(state, expires_at, job_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_items_created ON knowledge_items(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_knowledge_items_category_created_id ON knowledge_items(category, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_projects_updated_id ON projects(updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_model_profiles_channel ON ai_model_profiles(channel_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_updated ON rate_limit_buckets(updated_at);
  CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_window_started ON rate_limit_buckets(window_started_at);
`

/** 在迁移事务内创建最终业务结构，并写入首次运行的 AI 默认配置。 */
export function applyInitialSchema(database: DatabaseSync) {
  database.exec(initialSchemaSql)
  seedInitialAiSettings(database)
}
