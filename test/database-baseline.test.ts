import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

const directory = await mkdtemp(tmpdir() + '/yanxing-db-baseline-')
const fixturePath = path.join(import.meta.dirname, 'fixtures', 'database-process.ts')
const tsxLoader = import.meta.resolve('tsx')
const { databaseMigrations } = await import('../lib/db/migrations')
const EXPECTED_TABLES = [
  'ai_budget_ledger',
  'ai_budget_settings',
  'ai_model_assignments',
  'ai_model_channels',
  'ai_model_profiles',
  'ai_prompt_settings',
  'analysis_artifacts',
  'analysis_jobs',
  'analysis_module_states',
  'analysis_snapshots',
  'brand_settings',
  'job_events',
  'knowledge_items',
  'notifications',
  'project_members',
  'projects',
  'rate_limit_buckets',
  'report_facts',
  'report_insight_reservations',
  'report_insights',
  'report_versions',
  'schema_migrations',
  'sessions',
  'settings_revisions',
  'storage_allocations',
  'storage_reservations',
  'storage_usage',
  'users',
]

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function runInitialization(databasePath: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, fixturePath, 'database-initialization'], {
      cwd: process.cwd(),
      env: { ...process.env, YANXING_DATABASE_PATH: databasePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error('database initialization exited with ' + code + ': ' + stderr))
    })
  })
}

function open(databasePath: string) {
  return new DatabaseSync(databasePath)
}

function createCanonicalLedger(database: DatabaseSync) {
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);')
}

test('fresh database initializes the complete final schema and applied migrations', async () => {
  const databasePath = path.join(directory, 'fresh.sqlite')
  assert.deepEqual(await Promise.all([runInitialization(databasePath), runInitialization(databasePath)]), ['ok', 'ok'])

  const database = open(databasePath)
  const migrations = database.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all() as Array<Record<string, unknown>>
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
  const jobColumns = database.prepare('PRAGMA table_info(analysis_jobs)').all() as Array<{ name: string }>
  const promptColumns = database.prepare('PRAGMA table_info(ai_prompt_settings)').all() as Array<{ name: string }>
  const insightColumns = database.prepare('PRAGMA table_info(report_insights)').all() as Array<{ name: string }>
  const reservationColumns = database.prepare('PRAGMA table_info(report_insight_reservations)').all() as Array<{ name: string }>
  const budgetColumns = database.prepare('PRAGMA table_info(ai_budget_settings)').all() as Array<{ name: string }>
  const brandColumns = database.prepare('PRAGMA table_info(brand_settings)').all() as Array<{ name: string }>
  const brandSettings = database.prepare('SELECT display_text, revision, header_logo, login_watermark FROM brand_settings').get() as Record<string, unknown>
  const budgetCount = database.prepare('SELECT count(*) AS count FROM ai_budget_settings').get()?.count
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as Array<{ name: string }>
  const channelSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_model_channels'").get() as { sql: string }
  const profileSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_model_profiles'").get() as { sql: string }
  const artifactSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analysis_artifacts'").get() as { sql: string }
  const counts = {
    channels: (database.prepare('SELECT count(*) AS count FROM ai_model_channels').get() as { count: number }).count,
    models: (database.prepare('SELECT count(*) AS count FROM ai_model_profiles').get() as { count: number }).count,
    assignments: (database.prepare('SELECT count(*) AS count FROM ai_model_assignments').get() as { count: number }).count,
    prompts: (database.prepare('SELECT count(*) AS count FROM ai_prompt_settings').get() as { count: number }).count,
    users: (database.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count,
  }
  const assignments = database.prepare('SELECT target FROM ai_model_assignments ORDER BY target').all() as Array<{ target: string }>
  const prompts = database.prepare('SELECT target FROM ai_prompt_settings ORDER BY target').all() as Array<{ target: string }>
  const settingsRevisions = database.prepare('SELECT scope, revision FROM settings_revisions ORDER BY scope').all() as Array<{ scope: string; revision: number }>
  const sessionColumns = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
  database.close()

  assert.deepEqual(migrations.map((row) => row.version), [1, 2, 3, 4, 5])
  assert.equal(migrations[0]?.name, '0001-initial-schema')
  assert.equal(migrations[1]?.name, '0002-add-report-source-updated-at')
  assert.equal(migrations[2]?.name, '0003-drop-sessions-last-seen-at')
  assert.equal(migrations[3]?.name, '0004-add-brand-settings')
  assert.equal(migrations[4]?.name, '0005-update-default-brand')
  assert.equal(sessionColumns.some((column) => column.name === 'last_seen_at'), false)
  assert.match(String(migrations[0]?.checksum), /^[0-9a-f]{64}$/)
  assert.match(String(migrations[1]?.checksum), /^[0-9a-f]{64}$/)
  assert.match(String(migrations[2]?.checksum), /^[0-9a-f]{64}$/)
  assert.match(String(migrations[3]?.checksum), /^[0-9a-f]{64}$/)
  assert.match(String(migrations[4]?.checksum), /^[0-9a-f]{64}$/)
  assert.equal(typeof migrations[0]?.applied_at, 'string')
  assert.deepEqual(tables.map((table) => table.name), EXPECTED_TABLES)
  assert.equal(indexes.some((index) => index.name === 'idx_report_versions_created_at'), true)
  assert.equal(indexes.some((index) => index.name === 'idx_knowledge_items_created_at'), false)
  assert.equal(indexes.some((index) => index.name === 'idx_knowledge_items_created'), true)
  assert.equal(indexes.some((index) => index.name === 'idx_analysis_jobs_active_report'), false)
  assert.equal(indexes.some((index) => index.name === 'idx_analysis_jobs_active_report_type'), true)
  assert.equal(indexes.some((index) => index.name === 'idx_rate_limit_buckets_window_started'), true)
  assert.deepEqual(jobColumns.map((column) => column.name), [
    'id', 'report_version_id', 'parent_job_id', 'type', 'status', 'current_stage', 'stage_index', 'attempts',
    'cancel_requested', 'lease_owner', 'lease_expires_at', 'latest_partial_snapshot_id', 'prompt_config_json',
    'error_message', 'created_at', 'updated_at', 'evaluation_context_json', 'requested_by_user_id', 'available_at',
    'priority', 'admission_id', 'last_claimed_at', 'last_retry_at', 'last_retry_reason', 'last_worker_id',
    'last_error_code', 'last_error_at', 'terminal_reason', 'terminal_at', 'ai_calls_started', 'ai_calls_completed',
    'ai_tokens', 'model_runtime_json',
  ])
  assert.ok(indexes.some((index) => index.name === 'idx_ai_budget_ledger_user_period'))
  assert.deepEqual(budgetColumns.map((column) => column.name), [
    'id', 'daily_tokens', 'seven_day_tokens', 'revision', 'updated_at', 'updated_by',
  ])
  assert.deepEqual(brandColumns.map((column) => column.name), [
    'id', 'display_text', 'header_logo', 'header_logo_mime', 'login_watermark', 'login_watermark_mime', 'revision', 'updated_at', 'updated_by',
  ])
  assert.deepEqual({ ...brandSettings }, { display_text: '研行致远\n产业政策研究团队', revision: 1, header_logo: null, login_watermark: null })
  assert.equal(budgetCount, 0)
  assert.deepEqual(promptColumns.map((column) => column.name), [
    'target', 'system_prompt', 'instruction_prompt', 'version', 'updated_at', 'updated_by',
  ])
  assert.deepEqual(insightColumns.map((column) => column.name), [
    'id', 'report_version_id', 'title', 'summary', 'reading_minutes', 'sections_json', 'html', 'provider', 'model', 'generated_at', 'regeneration_count',
  ])
  assert.deepEqual(reservationColumns.map((column) => column.name), [
    'report_version_id', 'owner_token', 'lease_expires_at', 'created_at',
  ])
  assert.doesNotMatch(channelSql.sql, /json_mode/)
  assert.doesNotMatch(profileSql.sql, /json_mode/)
  assert.match(artifactSql.sql, /module_id IN \('page_analysis', 'report_insight'\)/)
  assert.deepEqual(assignments.map((row) => row.target), ['page_analysis', 'report_insight'])
  assert.deepEqual(prompts.map((row) => row.target), ['global_system', 'page_analysis', 'report_insight'])
  assert.deepEqual(settingsRevisions.map((row) => ({ scope: row.scope, revision: row.revision })), [
    { scope: 'models', revision: 1 },
    { scope: 'prompts', revision: 1 },
  ])
  assert.deepEqual(counts, { channels: 1, models: 1, assignments: 2, prompts: 3, users: 0 })
  assert.deepEqual(foreignKeys, [])
})

test('0005 updates only the untouched default brand text', async () => {
  const { applyAddBrandSettings } = await import('../lib/db/migrations/0004-add-brand-settings')
  const { applyUpdateDefaultBrand } = await import('../lib/db/migrations/0005-update-default-brand')
  const untouched = open(':memory:')
  const customized = open(':memory:')
  try {
    applyAddBrandSettings(untouched)
    applyUpdateDefaultBrand(untouched)
    assert.equal(untouched.prepare('SELECT display_text FROM brand_settings').get()?.display_text, '研行致远\n产业政策研究团队')

    applyAddBrandSettings(customized)
    customized.prepare('UPDATE brand_settings SET display_text = ?, revision = 2, updated_at = ?, updated_by = ? WHERE id = 1')
      .run('自定义品牌', '2026-01-01T00:00:00.000Z', '管理员')
    applyUpdateDefaultBrand(customized)
    assert.equal(customized.prepare('SELECT display_text FROM brand_settings').get()?.display_text, '自定义品牌')
  } finally {
    untouched.close()
    customized.close()
  }
})

test('0003 drops last_seen_at while keeping existing session rows', async () => {
  const { applyInitialSchema } = await import('../lib/db/migrations/0001-initial-schema')
  const { runMigrations } = await import('../lib/db/migrate')
  const databasePath = path.join(directory, 'session-forward.sqlite')
  const database = open(databasePath)
  createCanonicalLedger(database)
  applyInitialSchema(database)
  const v1 = databaseMigrations[0]
  database.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(v1.version, v1.name, v1.checksum, '2026-01-01T00:00:00.000Z')
  database.prepare(`
    INSERT INTO users(id, username, display_name, password_hash, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('user-1', 'alice', 'Alice', 'hash', 'researcher', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  database.prepare(`
    INSERT INTO sessions(id, user_id, token_hash, csrf_token_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('session-1', 'user-1', 'token-hash', 'csrf-hash', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  runMigrations(database)
  const columns = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
  const session = database.prepare('SELECT id, created_at FROM sessions WHERE id = ?').get('session-1') as { id: string; created_at: string }
  const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
  database.close()
  assert.equal(columns.some((column) => column.name === 'last_seen_at'), false)
  assert.equal(session.id, 'session-1')
  assert.equal(session.created_at, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(versions.map((row) => Number(row.version)), [1, 2, 3, 4, 5])
})

test('bootstrap refuses foreign or damaged databases instead of adopting them', async () => {
  const untrackedPath = path.join(directory, 'untracked.sqlite')
  const untracked = open(untrackedPath)
  untracked.exec('CREATE TABLE users(id TEXT PRIMARY KEY)')
  untracked.close()
  await assert.rejects(runInitialization(untrackedPath), /没有绿地迁移账本/)

  const oldLedgerPath = path.join(directory, 'old-ledger.sqlite')
  const oldLedger = open(oldLedgerPath)
  oldLedger.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);')
  oldLedger.close()
  await assert.rejects(runInitialization(oldLedgerPath), /旧版或损坏的迁移账本/)

  const tamperedPath = path.join(directory, 'tampered.sqlite')
  assert.equal(await runInitialization(tamperedPath), 'ok')
  const tampered = open(tamperedPath)
  tampered.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('tampered')
  tampered.close()
  await assert.rejects(runInitialization(tamperedPath), /迁移账本校验失败/)

  const oldV1Path = path.join(directory, 'old-v1.sqlite')
  const oldV1 = open(oldV1Path)
  createCanonicalLedger(oldV1)
  oldV1.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(1, '0001-initial-schema', 'old-v1-checksum', '2026-01-01T00:00:00.000Z')
  oldV1.close()
  await assert.rejects(runInitialization(oldV1Path), /破坏性 schema 重置/)

  const unknownMigrationPath = path.join(directory, 'unknown-migration.sqlite')
  const unknownMigration = open(unknownMigrationPath)
  createCanonicalLedger(unknownMigration)
  for (const migration of databaseMigrations) {
    unknownMigration.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(migration.version, migration.name, migration.checksum, '2026-01-01T00:00:00.000Z')
  }
  unknownMigration.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(databaseMigrations.length + 1, '0006-old-history', 'old-history-checksum', '2026-01-02T00:00:00.000Z')
  unknownMigration.close()
  await assert.rejects(runInitialization(unknownMigrationPath), /未知的迁移.*破坏性 schema 重置/)

  const emptyLedgerPath = path.join(directory, 'empty-ledger.sqlite')
  const emptyLedger = open(emptyLedgerPath)
  createCanonicalLedger(emptyLedger)
  emptyLedger.exec('CREATE TABLE users(id TEXT PRIMARY KEY)')
  emptyLedger.close()
  await assert.rejects(runInitialization(emptyLedgerPath), /没有来源的空迁移账本/)
  const afterFailure = open(emptyLedgerPath)
  const usersTable = afterFailure.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()
  const ledgerCount = (afterFailure.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count
  afterFailure.close()
  assert.notEqual(usersTable, undefined)
  assert.equal(ledgerCount, 0)
})

test('repeated initialization stays idempotent and preserves data', async () => {
  const databasePath = path.join(directory, 'idempotent.sqlite')
  assert.equal(await runInitialization(databasePath), 'ok')

  const database = open(databasePath)
  database.exec('PRAGMA foreign_keys = ON;')
  database.prepare(`
    INSERT INTO users(id, username, display_name, password_hash, role, status, created_at, updated_at)
    VALUES ('user-idempotent', 'idempotent', '幂等用户', 'hash', 'admin', 'active', ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString())
  database.close()

  assert.equal(await runInitialization(databasePath), 'ok')
  const repeated = open(databasePath)
  const migrationCount = (repeated.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count
  const userCount = (repeated.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count
  const promptCount = (repeated.prepare('SELECT count(*) AS count FROM ai_prompt_settings').get() as { count: number }).count
  repeated.close()
  assert.equal(migrationCount, databaseMigrations.length)
  assert.equal(userCount, 1)
  assert.equal(promptCount, 3)
})

test('concurrent web and worker initialization leaves one committed ledger', async () => {
  const databasePath = path.join(directory, 'concurrent.sqlite')
  assert.deepEqual(
    (await Promise.all([
      runInitialization(databasePath),
      runInitialization(databasePath),
      runInitialization(databasePath),
    ])).sort(),
    ['ok', 'ok', 'ok'],
  )

  const database = new DatabaseSync(databasePath)
  const migrationCount = (database.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count
  const promptCount = (database.prepare('SELECT count(*) AS count FROM ai_prompt_settings').get() as { count: number }).count
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  database.close()
  assert.equal(migrationCount, databaseMigrations.length)
  assert.equal(promptCount, 3)
  assert.deepEqual(foreignKeys, [])
})

test('hot update with a higher target version applies pending migrations automatically', async () => {
  const databasePath = path.join(directory, 'hot-reload.sqlite')
  assert.equal(await runInitialization(databasePath), 'ok')

  const { runMigrations, readSchemaVersion } = await import('../lib/db/migrate')
  const migrationsModule = await import('../lib/db/migrations')
  type MigrationList = typeof migrationsModule.databaseMigrations
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA busy_timeout = 5000;')

  const currentVersion = Math.max(...migrationsModule.databaseMigrations.map((migration) => migration.version))
  assert.equal(readSchemaVersion(database), currentVersion)
  const nextVersion = currentVersion + 1
  const nextCodeMigrations: MigrationList = [
    ...migrationsModule.databaseMigrations,
    {
      version: nextVersion,
      name: '000' + String(nextVersion) + '-test-hot-reload',
      checksum: 'test-only-checksum',
      apply(target) {
        target.exec("ALTER TABLE projects ADD COLUMN hot_reload_probe TEXT NOT NULL DEFAULT ''")
      },
    },
  ]

  runMigrations(database, nextCodeMigrations)
  assert.equal(readSchemaVersion(database), nextVersion)
  const columns = database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
  assert.ok(columns.some((column) => column.name === 'hot_reload_probe'))

  runMigrations(database, nextCodeMigrations)
  assert.equal(readSchemaVersion(database), nextVersion)
  const ledger = (database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string }>)
    .map((row) => ({ version: Number(row.version), name: String(row.name) }))
  assert.deepEqual(ledger, [
    ...migrationsModule.databaseMigrations.map((migration) => ({ version: migration.version, name: migration.name })),
    { version: nextVersion, name: '000' + String(nextVersion) + '-test-hot-reload' },
  ])
  database.close()
})
