import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { NATIVE_SCHEMA_CHECKSUM, NATIVE_SCHEMA_NAME, REQUIRED_NATIVE_TABLES } from '../lib/db/native-schema'
import { NATIVE_SCHEMA_PUBLIC_MESSAGES } from '../lib/db/native-schema-error'

const directory = await mkdtemp(tmpdir() + '/yanxing-db-baseline-')
const fixturePath = path.join(import.meta.dirname, 'fixtures', 'database-process.ts')
const tsxLoader = import.meta.resolve('tsx')
const expectedNativeTables = [...REQUIRED_NATIVE_TABLES].sort()

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

test('fresh database initializes the native schema identity', async () => {
  const databasePath = path.join(directory, 'fresh.sqlite')
  assert.deepEqual(await Promise.all([runInitialization(databasePath), runInitialization(databasePath)]), ['ok', 'ok'])

  const database = open(databasePath)
  const identity = database.prepare('SELECT name, checksum FROM native_schema_identity WHERE id = 1').get() as { name: string; checksum: string }
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
  const userColumns = database.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  const projectColumns = database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
  const sessionColumns = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
  const brandSettings = database.prepare('SELECT display_text, revision, header_logo, login_watermark FROM brand_settings').get() as Record<string, unknown>
  const budgetObjects = database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%ai_budget%'").all()
  const taskColumns = database.prepare('PRAGMA table_info(submission_tasks)').all().map((column) => column.name)
  const callColumns = database.prepare('PRAGMA table_info(submission_task_calls)').all().map((column) => column.name)
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  const boundRoot = database.prepare('SELECT path FROM submission_storage_root WHERE id = 1').get() as { path: string }
  const counts = {
    channels: (database.prepare('SELECT count(*) AS count FROM ai_model_channels').get() as { count: number }).count,
    models: (database.prepare('SELECT count(*) AS count FROM ai_model_profiles').get() as { count: number }).count,
    assignments: (database.prepare('SELECT count(*) AS count FROM ai_model_assignments').get() as { count: number }).count,
    prompts: (database.prepare('SELECT count(*) AS count FROM ai_prompt_settings').get() as { count: number }).count,
    users: (database.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count,
  }
  database.close()

  assert.equal(identity.name, NATIVE_SCHEMA_NAME)
  assert.equal(identity.checksum, NATIVE_SCHEMA_CHECKSUM)
  assert.deepEqual(tables.map((table) => table.name), expectedNativeTables)
  assert.equal(userColumns.some((column) => column.name === 'avatar'), true)
  assert.equal(projectColumns.some((column) => column.name === 'description'), true)
  assert.equal(projectColumns.some((column) => column.name === 'membership_revision'), true)
  assert.equal(projectColumns.some((column) => column.name === 'stage'), false)
  assert.equal(projectColumns.some((column) => column.name === 'milestones_json'), false)
  assert.equal(sessionColumns.some((column) => column.name === 'last_seen_at'), false)
  assert.equal(tables.some((table) => table.name === 'report_versions'), false)
  assert.equal(tables.some((table) => table.name === 'analysis_jobs'), false)
  assert.equal(tables.some((table) => table.name === 'schema_migrations'), false)
  assert.deepEqual({ ...brandSettings }, { display_text: '研行致远\n产业政策研究团队', revision: 1, header_logo: null, login_watermark: null })
  assert.deepEqual(budgetObjects, [])
  for (const column of ['ai_tokens', 'admission_id']) assert.equal(taskColumns.includes(column), false)
  assert.deepEqual(callColumns, ['job_id', 'attempt', 'provider', 'model', 'lease_token', 'state', 'started_at', 'completed_at'])
  assert.deepEqual(counts, { channels: 1, models: 1, assignments: 2, prompts: 3, users: 0 })
  assert.deepEqual(foreignKeys, [])
  assert.equal(boundRoot.path, path.resolve(path.dirname(databasePath), 'reports'))
})

test('bootstrap refuses foreign or damaged databases instead of adopting them', async () => {
  const untrackedPath = path.join(directory, 'untracked.sqlite')
  const untracked = open(untrackedPath)
  untracked.exec('CREATE TABLE users(id TEXT PRIMARY KEY)')
  untracked.close()
  await assert.rejects(runInitialization(untrackedPath), new RegExp(NATIVE_SCHEMA_PUBLIC_MESSAGES.INCOMPATIBLE_DATABASE))

  const oldLedgerPath = path.join(directory, 'old-ledger.sqlite')
  const oldLedger = open(oldLedgerPath)
  oldLedger.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);')
  oldLedger.close()
  await assert.rejects(runInitialization(oldLedgerPath), new RegExp(NATIVE_SCHEMA_PUBLIC_MESSAGES.LEGACY_DATABASE))
  assert.equal(existsSync(oldLedgerPath + '-wal'), false)
  const oldLedgerAfter = open(oldLedgerPath)
  const journalMode = (oldLedgerAfter.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
  oldLedgerAfter.close()
  assert.equal(journalMode.toLowerCase(), 'delete')

  const tamperedPath = path.join(directory, 'tampered.sqlite')
  assert.equal(await runInitialization(tamperedPath), 'ok')
  const tampered = open(tamperedPath)
  tampered.prepare('UPDATE native_schema_identity SET checksum = ? WHERE id = 1').run('tampered')
  tampered.close()
  await assert.rejects(runInitialization(tamperedPath), new RegExp(NATIVE_SCHEMA_PUBLIC_MESSAGES.IDENTITY_MISMATCH))
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
  const identity = repeated.prepare('SELECT name, checksum FROM native_schema_identity WHERE id = 1').get() as { name: string; checksum: string }
  const userCount = (repeated.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count
  const promptCount = (repeated.prepare('SELECT count(*) AS count FROM ai_prompt_settings').get() as { count: number }).count
  repeated.close()
  assert.equal(identity.name, NATIVE_SCHEMA_NAME)
  assert.equal(identity.checksum, NATIVE_SCHEMA_CHECKSUM)
  assert.equal(userCount, 1)
  assert.equal(promptCount, 3)
})

test('concurrent web and worker initialization leaves one native identity', async () => {
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
  const identityCount = (database.prepare('SELECT count(*) AS count FROM native_schema_identity').get() as { count: number }).count
  const promptCount = (database.prepare('SELECT count(*) AS count FROM ai_prompt_settings').get() as { count: number }).count
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  database.close()
  assert.equal(identityCount, 1)
  assert.equal(promptCount, 3)
  assert.deepEqual(foreignKeys, [])
})
