import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../lib/db/migrate'
import { assertSchemaContract } from '../lib/db/schema-contract'

function createDatabase(context?: TestContext) {
  const database = new DatabaseSync(':memory:')
  context?.after(() => database.close())
  runMigrations(database)
  return database
}

test('schema contract rejects an index with the right name but wrong definition', () => {
  const database = createDatabase()
  database.exec('DROP INDEX idx_report_versions_created_id')
  database.exec('CREATE INDEX idx_report_versions_created_id ON report_versions(id)')
  assert.throws(() => assertSchemaContract(database), /idx_report_versions_created_id definition/)
  database.close()
})

test('schema contract rejects missing table constraints', () => {
  const database = createDatabase()
  database.exec('DROP INDEX idx_rate_limit_buckets_updated')
  database.exec('DROP INDEX idx_rate_limit_buckets_window_started')
  database.exec('ALTER TABLE rate_limit_buckets RENAME TO rate_limit_buckets_original')
  database.exec('CREATE TABLE rate_limit_buckets (bucket_key TEXT, window_started_at INTEGER, count INTEGER, updated_at TEXT)')
  database.exec('DROP TABLE rate_limit_buckets_original')
  database.exec('CREATE INDEX idx_rate_limit_buckets_updated ON rate_limit_buckets(updated_at)')
  database.exec('CREATE INDEX idx_rate_limit_buckets_window_started ON rate_limit_buckets(window_started_at)')
  assert.throws(() => assertSchemaContract(database), /constraint rate_limit_buckets|check rate_limit_buckets/)
  database.close()
})

test('budget settings enforce singleton, integer token limits, revisions and required metadata', (context) => {
  const database = createDatabase(context)
  const insert = database.prepare('INSERT INTO ai_budget_settings VALUES (?, ?, ?, ?, ?, ?)')
  const valid = [1, 100, 700, 2, '2026-05-01T00:00:00.000Z', 'admin']
  for (const column of [1, 2, 3]) {
    for (const value of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) {
      const invalid: Array<string | number | null> = [...valid]
      invalid[column] = value
      assert.throws(() => insert.run(...invalid), /constraint/i)
    }
  }
  assert.throws(() => insert.run(1, 100, 700, 1, valid[4], valid[5]), /constraint/i)
  assert.throws(() => insert.run(2, ...valid.slice(1)), /constraint/i)
  assert.throws(() => insert.run(...valid.slice(0, 4), null, 'admin'), /constraint/i)
  assert.throws(() => insert.run(...valid.slice(0, 5), null), /constraint/i)
  insert.run(1, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, valid[4], valid[5])
  assert.throws(() => insert.run(...valid), /constraint/i)
  assert.doesNotThrow(() => database.prepare('UPDATE ai_budget_settings SET daily_tokens = ?, seven_day_tokens = 1').run(Number.MAX_SAFE_INTEGER))
  assert.doesNotThrow(() => assertSchemaContract(database))
})

test('schema contract rejects weakened budget settings constraints', (context) => {
  const database = createDatabase(context)
  database.exec('ALTER TABLE ai_budget_settings RENAME TO ai_budget_settings_original')
  database.exec('CREATE TABLE ai_budget_settings AS SELECT * FROM ai_budget_settings_original')
  database.exec('DROP TABLE ai_budget_settings_original')
  assert.throws(() => assertSchemaContract(database), /constraint ai_budget_settings|check ai_budget_settings/)
})

for (const table of ['analysis_jobs', 'ai_budget_settings', 'ai_budget_ledger']) {
  test('schema contract rejects unexpected columns on ' + table, (context) => {
    const database = createDatabase(context)
    database.exec('ALTER TABLE ' + table + ' ADD COLUMN unexpected_field INTEGER')
    assert.throws(() => assertSchemaContract(database), new RegExp('table ' + table + ' columns/order'))
  })
}

test('schema contract enforces the user-first token window index', (context) => {
  const database = createDatabase(context)
  database.exec('DROP INDEX idx_ai_budget_ledger_user_period')
  assert.throws(() => assertSchemaContract(database), /index idx_ai_budget_ledger_user_period/)
  database.exec('CREATE INDEX idx_ai_budget_ledger_user_period ON ai_budget_ledger(period_key, user_id, state)')
  assert.throws(() => assertSchemaContract(database), /index idx_ai_budget_ledger_user_period definition/)
})

test('token ledger retains validation, defaults and nullable project tracing', (context) => {
  const database = createDatabase(context)
  const insert = database.prepare(`
    INSERT INTO ai_budget_ledger(id, user_id, operation, period_key, reserved_tokens, state, available_at, expires_at, created_at, updated_at)
    VALUES (?, 'user', ?, '2026-05-01', ?, ?, '', '', '', '')
  `)
  assert.throws(() => insert.run('invalid-operation', 'invalid', 1, 'reserved'), /constraint/i)
  assert.throws(() => insert.run('invalid-state', 'insight', 1, 'invalid'), /constraint/i)
  assert.throws(() => insert.run('invalid-tokens', 'insight', 0, 'reserved'), /constraint/i)
  insert.run('valid', 'insight', 1, 'reserved')
  const row = database.prepare('SELECT * FROM ai_budget_ledger').get()
  assert.equal(row?.project_id, null)
  assert.equal(row?.actual_tokens, null)
  assert.equal(row?.accounted_tokens, 0)
  assert.equal(row?.model_calls_started, 0)
  assert.equal(row?.model_calls_completed, 0)
  for (const column of ['accounted_tokens', 'model_calls_started', 'model_calls_completed']) {
    assert.throws(() => database.exec('UPDATE ai_budget_ledger SET ' + column + ' = -1'), /constraint/i)
  }
  database.exec("UPDATE ai_budget_ledger SET job_id = 'unique-job'")
  insert.run('second', 'analysis', 1, 'reserved')
  assert.throws(() => database.exec("UPDATE ai_budget_ledger SET job_id = 'unique-job' WHERE id = 'second'"), /constraint/i)
})
