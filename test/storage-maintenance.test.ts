import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { ensureNativeDatabase, installFreshSharedSchema } from '../lib/db/native-schema'
import { NativeSchemaError } from '../lib/db/native-schema-error'
import { isPathWithinRoot } from '../lib/storage/path-containment'
import { runStorageMaintenance } from '../lib/storage/maintenance'
import { consumeStorageReservationInDatabase, StorageQuotaError } from '../lib/storage/quota'

const timestamp = '2026-01-02T03:04:05.000Z'

function createDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON;')
  installFreshSharedSchema(database)
  return database
}

function createNativeMaintenanceDatabase(reportRoot: string) {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON;')
  ensureNativeDatabase({ database, storageRoot: resolve(reportRoot) })
  return database
}

function insertKnowledgeItem(database: DatabaseSync, input: { id: string; userId: string; fileName: string; sourcePath: string; content: string }) {
  database.prepare(`
    INSERT INTO knowledge_items(id, title, file_name, file_size, source_path, file_hash, uploaded_by, uploaded_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.id, input.fileName, Buffer.byteLength(input.content), input.sourcePath, 'hash-' + input.id, input.userId, input.userId, timestamp, timestamp)
}

async function createFile(filePath: string, content: string, mtime: Date) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
  await utimes(filePath, mtime, mtime)
}

async function exists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

test('managed path containment accepts nested files but rejects roots and escapes', () => {
  const root = '/tmp/yanxing-managed-reports'
  assert.equal(isPathWithinRoot(root, join(root, 'report-1', 'source.pdf')), true)
  assert.equal(isPathWithinRoot(root, root), false)
  assert.equal(isPathWithinRoot(root, join(root, '..', 'outside', 'source.pdf')), false)
  assert.equal(isPathWithinRoot(root, join('/tmp', 'yanxing-managed-reports-archive', 'source.pdf')), false)
})

test('reconciles allocations, expires reservations, and preserves referenced files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-maintenance-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  const activePath = join(roots.knowledgeRoot, 'knowledge-live', 'live.pdf')
  const orphanPath = join(roots.reportRoot, 'orphan', 'orphan.pdf')
  const recentPath = join(roots.knowledgeRoot, 'recent', 'recent.pdf')
  const oldDate = new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000)
  const nowDate = new Date(timestamp)
  await createFile(activePath, 'active report', nowDate)
  await createFile(orphanPath, 'orphan report', oldDate)
  await createFile(recentPath, 'recent file', nowDate)

  const database = createDatabase()
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('user-1', 'user-1', '测试用户', 'hash', 'researcher', timestamp, timestamp)
  database.prepare('INSERT INTO projects(id, title, objective, owner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-1', '测试课题', '', '测试用户', timestamp, timestamp)
  database.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('project-1', 'user-1', 'owner', timestamp)
  insertKnowledgeItem(database, { id: 'knowledge-live', userId: 'user-1', fileName: 'live.pdf', sourcePath: activePath, content: 'active report' })
  database.prepare('INSERT INTO storage_allocations(owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path, mime_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('report', 'report-gone', 'user-1', 'project-1', 12, 'hash-gone', orphanPath, 'application/pdf', timestamp, timestamp)
  database.prepare('INSERT INTO storage_reservations(id, user_id, project_id, expected_bytes, owner_type, expires_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('reservation-expired', 'user-1', 'project-1', 99, 'report', '2026-01-01T00:00:00.000Z', 'active', timestamp, timestamp)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('global', 'global', 999, 9, 99, 1, 4, timestamp)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('user', 'user-1', 999, 9, 99, 1, 4, timestamp)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('project', 'project-1', 999, 9, 99, 1, 4, timestamp)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.expiredReservations, 1)
  assert.equal(result.allocationsCreated, 1)
  assert.equal(result.allocationsRemoved, 0)
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(result.orphanFilesSkippedRecent, 1)
  assert.equal(await exists(activePath), true)
  assert.equal(await exists(orphanPath), true)
  assert.equal(await exists(recentPath), true)

  const allocation = database.prepare('SELECT user_id, project_id, size_bytes, source_path FROM storage_allocations WHERE owner_type = ? AND owner_id = ?').get('knowledge', 'knowledge-live') as { user_id: string; project_id: string | null; size_bytes: number; source_path: string }
  assert.equal(allocation.user_id, 'user-1')
  assert.equal(allocation.project_id, null)
  assert.equal(allocation.size_bytes, Buffer.byteLength('active report'))
  assert.equal(allocation.source_path, activePath)
  const retainedReport = database.prepare('SELECT user_id, size_bytes FROM storage_allocations WHERE owner_type = ? AND owner_id = ?').get('report', 'report-gone') as { user_id: string; size_bytes: number }
  assert.equal(retainedReport.user_id, 'user-1')
  assert.equal(retainedReport.size_bytes, 12)
  const globalUsage = database.prepare('SELECT used_bytes, item_count, reserved_bytes, reserved_count FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get('global', 'global') as { used_bytes: number; item_count: number; reserved_bytes: number; reserved_count: number }
  assert.equal(globalUsage.used_bytes, Buffer.byteLength('active report') + 12)
  assert.equal(globalUsage.item_count, 2)
  assert.equal(globalUsage.reserved_bytes, 0)
  assert.equal(globalUsage.reserved_count, 0)
  const reservation = database.prepare('SELECT state FROM storage_reservations WHERE id = ?').get('reservation-expired') as { state: string }
  assert.equal(reservation.state, 'expired')
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('does not delete old files while an owner-type reservation is active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-reservation-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  const orphanPath = join(roots.reportRoot, 'pending', 'pending.pdf')
  await createFile(orphanPath, 'pending upload', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  const database = createDatabase()
  database.prepare('INSERT INTO storage_reservations(id, user_id, project_id, expected_bytes, owner_type, expires_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('reservation-active', 'user-2', 'project-2', 42, 'report', '2026-01-03T00:00:00.000Z', 'active', timestamp, timestamp)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.orphanFilesFound, 0)
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(await exists(orphanPath), true)
  const usage = database.prepare('SELECT reserved_bytes, reserved_count FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get('user', 'user-2') as { reserved_bytes: number; reserved_count: number }
  assert.equal(usage.reserved_bytes, 42)
  assert.equal(usage.reserved_count, 1)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('deletes cache-only extraction sidecars after the source is gone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-sidecar-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  const sidecarPath = join(roots.knowledgeRoot, 'old', 'missing.docx.content.json')
  await createFile(sidecarPath, '{"text":"cached"}', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  await mkdir(roots.reportRoot, { recursive: true })
  await mkdir(roots.temporaryRoot, { recursive: true })
  const database = createDatabase()

  database.prepare("INSERT INTO storage_allocations VALUES ('knowledge','old','user',NULL,1,'hash',?,'text/plain',?,?)").run(join(roots.knowledgeRoot, 'old-record'), timestamp, timestamp)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.scannedFiles, 0)
  assert.equal(result.orphanFilesDeleted, 1)
  assert.equal(await exists(sidecarPath), false)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('keeps extraction sidecars while the source report is protected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-sidecar-live-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  const sourcePath = join(roots.reportRoot, 'live', 'live.docx')
  const sidecarPath = `${sourcePath}.content.json`
  const nowDate = new Date(timestamp)
  await createFile(sourcePath, 'live report', nowDate)
  await createFile(sidecarPath, '{"text":"cached"}', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  const database = createDatabase()
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('user-sidecar', 'user-sidecar', '缓存用户', 'hash', 'researcher', timestamp, timestamp)
  database.prepare('INSERT INTO projects(id, title, objective, owner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-sidecar', '缓存课题', '', '缓存用户', timestamp, timestamp)
  database.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('project-sidecar', 'user-sidecar', 'owner', timestamp)
  insertKnowledgeItem(database, { id: 'knowledge-sidecar', userId: 'user-sidecar', fileName: 'live.docx', sourcePath: sourcePath, content: 'live report' })

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(await exists(sourcePath), true)
  assert.equal(await exists(sidecarPath), true)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('deletes an orphan source and its extraction sidecar together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-sidecar-orphan-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  const sourcePath = join(roots.knowledgeRoot, 'orphan', 'orphan.docx')
  const sidecarPath = `${sourcePath}.content.json`
  const oldDate = new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000)
  await createFile(sourcePath, 'orphan report', oldDate)
  await createFile(sidecarPath, '{"text":"cached"}', oldDate)
  const database = createDatabase()

  database.prepare("INSERT INTO storage_allocations VALUES ('knowledge','old','user',NULL,1,'hash',?,'text/plain',?,?)").run(join(roots.knowledgeRoot, 'old-record'), timestamp, timestamp)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.orphanFilesDeleted, 2)
  assert.equal(await exists(sourcePath), false)
  assert.equal(await exists(sidecarPath), false)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('treats an unused missing root as empty and still reconciles other roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-unused-missing-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge-missing'),
    temporaryRoot: join(directory, 'tmp-missing'),
  }
  const orphanPath = join(roots.reportRoot, 'orphan', 'orphan.pdf')
  await createFile(orphanPath, 'orphan', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  const database = createDatabase()
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('global', 'global', 99, 1, 0, 0, 0, timestamp)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.errors.length, 0)
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(await exists(orphanPath), true)
  const usage = database.prepare('SELECT used_bytes FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get('global', 'global') as { used_bytes: number }
  assert.equal(usage.used_bytes, 0)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('fails closed when a recorded storage root is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-recorded-missing-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge-missing'),
    temporaryRoot: join(directory, 'tmp'),
  }
  const orphanPath = join(roots.reportRoot, 'orphan', 'orphan.pdf')
  await createFile(orphanPath, 'orphan', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  await mkdir(roots.temporaryRoot, { recursive: true })
  const database = createDatabase()
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('user-knowledge', 'user-knowledge', '知识用户', 'hash', 'researcher', timestamp, timestamp)
  database.prepare('INSERT INTO knowledge_items(id, title, file_name, file_size, category, description, tags_json, source_path, file_hash, uploaded_by, uploaded_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('knowledge-1', '资料', 'note.pdf', 4, '资料', '', '[]', join(roots.knowledgeRoot, 'knowledge-1', 'note.pdf'), 'hash-k', '知识用户', 'user-knowledge', timestamp, timestamp)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('global', 'global', 99, 1, 0, 0, 0, timestamp)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(result.allocationsRemoved, 0)
  assert.equal(result.errors.length, 1)
  assert.equal(await exists(orphanPath), true)
  const usage = database.prepare('SELECT used_bytes FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get('global', 'global') as { used_bytes: number }
  assert.equal(usage.used_bytes, 99)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('fails closed when a managed root exists but is not a safe directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-unsafe-root-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge-file'),
    temporaryRoot: join(directory, 'tmp'),
  }
  const orphanPath = join(roots.reportRoot, 'orphan', 'orphan.pdf')
  await createFile(orphanPath, 'orphan', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  await writeFile(roots.knowledgeRoot, 'not a directory')
  await mkdir(roots.temporaryRoot, { recursive: true })
  const database = createDatabase()

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(result.errors.length, 1)
  assert.equal(await exists(orphanPath), true)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('rechecks a business source created after the directory scan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-race-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  const livePath = join(roots.knowledgeRoot, 'race-knowledge', 'source.docx')
  const target = createDatabase()
  target.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('race-user', 'race-user', '竞态用户', 'hash', 'researcher', timestamp, timestamp)
  insertKnowledgeItem(target, { id: 'race-knowledge', userId: 'race-user', fileName: 'source.docx', sourcePath: livePath, content: 'race upload' })
  let injected = false
  const database = new Proxy(target, {
    get(object, property, receiver) {
      if (property === 'exec') {
        return (sql: string) => {
          if (sql === 'BEGIN IMMEDIATE' && !injected) {
            injected = true
            mkdirSync(dirname(livePath), { recursive: true })
            writeFileSync(livePath, 'race upload')
          }
          return object.exec(sql)
        }
      }
      const value = Reflect.get(object, property, receiver)
      return typeof value === 'function' ? value.bind(object) : value
    },
  }) as unknown as DatabaseSync

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(injected, true)
  assert.equal(result.allocationsCreated, 1)
  assert.equal((target.prepare("SELECT source_path FROM storage_allocations WHERE owner_type = 'knowledge' AND owner_id = 'race-knowledge'").get() as { source_path: string }).source_path, livePath)
  assert.equal(await exists(livePath), true)
  target.close()
  await rm(directory, { recursive: true, force: true })
})

test('dry-run rolls back ledger changes and never removes files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-dry-run-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await mkdir(roots.reportRoot, { recursive: true })
  await mkdir(roots.temporaryRoot, { recursive: true })
  const orphanPath = join(roots.knowledgeRoot, 'orphan', 'orphan.pdf')
  await createFile(orphanPath, 'old orphan', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  const database = createDatabase()
  database.prepare('INSERT INTO storage_reservations(id, user_id, project_id, expected_bytes, owner_type, expires_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('reservation-expired-dry', 'user-3', null, 7, 'knowledge', '2026-01-01T00:00:00.000Z', 'active', timestamp, timestamp)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0, dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.expiredReservations, 1)
  assert.equal(result.orphanFilesFound, 1)
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(await exists(orphanPath), true)
  const reservation = database.prepare('SELECT state FROM storage_reservations WHERE id = ?').get('reservation-expired-dry') as { state: string }
  assert.equal(reservation.state, 'active')
  database.close()
  await rm(directory, { recursive: true, force: true })
})


test('does not consume a reservation for a different owner type', () => {
  const database = createDatabase()
  database.prepare('INSERT INTO storage_reservations(id, user_id, project_id, expected_bytes, owner_type, expires_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('reservation-owner-type', 'user-4', null, 10, 'report', '2026-01-03T00:00:00.000Z', 'active', timestamp, timestamp)
  assert.throws(() => consumeStorageReservationInDatabase(database, 'reservation-owner-type', {
    ownerType: 'knowledge',
    ownerId: 'knowledge-1',
    userId: 'user-4',
    projectId: null,
    sizeBytes: 1,
    fileHash: 'hash',
    sourcePath: '/managed/knowledge-1/source.pdf',
    mimeType: 'application/pdf',
  }), StorageQuotaError)
  const reservation = database.prepare('SELECT state FROM storage_reservations WHERE id = ?').get('reservation-owner-type') as { state: string }
  assert.equal(reservation.state, 'active')
  database.close()
})

test('keeps tombstoned formal reports and bills immutable submitted_by', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-tombstone-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  const sourceKey = 'reports/tombstone.docx'
  const sourcePath = join(roots.reportRoot, sourceKey)
  const content = 'tombstone-report-body'
  await createFile(sourcePath, content, new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  const database = createNativeMaintenanceDatabase(roots.reportRoot)
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('submitter', 'submitter', '提交人', 'hash', 'researcher', timestamp, timestamp)
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('owner', 'owner', '课题负责人', 'hash', 'researcher', timestamp, timestamp)
  database.prepare('INSERT INTO projects(id, title, objective, owner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-native', '原生课题', '目标', '课题负责人', timestamp, timestamp)
  database.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('project-native', 'owner', 'owner', timestamp)
  database.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('project-native', 'submitter', 'editor', timestamp)
  database.prepare('INSERT INTO project_report_state(project_id, plan_revision, workflow_revision, next_submission_sequence) VALUES (?, ?, ?, ?)').run('project-native', 0, 0, 2)
  database.prepare('INSERT INTO project_stages(id, project_id, ordinal, title, lifecycle_status, started_at, next_report_version, state_revision, completion_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('stage-1', 'project-native', 1, '研究阶段', 'in_progress', timestamp, 2, 0, 0)
  database.prepare(`INSERT INTO report_submissions(id, project_id, stage_id, stage_version, submission_sequence, submitted_as, title, file_name, source_key, file_hash, source_size, paragraph_count, character_count, submitted_by, submitted_at, was_first_stage_submission, deleted_at, deleted_by, deletion_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'report-tombstone', 'project-native', 'stage-1', 1, 1, 'update', '墓碑报告', 'tombstone.docx', sourceKey, 'hash-tombstone', Buffer.byteLength(content), 1, content.length, 'submitter', timestamp, 1, '2026-01-02T04:00:00.000Z', 'owner', '逻辑删除保留文件',
  )
  database.prepare('INSERT INTO report_submission_documents(report_id, text, mime_type) VALUES (?, ?, ?)').run('report-tombstone', content, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(await exists(sourcePath), true)
  const allocation = database.prepare('SELECT user_id, project_id, size_bytes, source_path FROM storage_allocations WHERE owner_type = ? AND owner_id = ?').get('report', 'report-tombstone') as { user_id: string; project_id: string; size_bytes: number; source_path: string }
  assert.equal(allocation.user_id, 'submitter')
  assert.equal(allocation.project_id, 'project-native')
  assert.equal(allocation.size_bytes, Buffer.byteLength(content))
  assert.equal(allocation.source_path, resolve(sourcePath))
  const usage = database.prepare('SELECT used_bytes, item_count FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get('user', 'submitter') as { used_bytes: number; item_count: number }
  assert.equal(usage.used_bytes, Buffer.byteLength(content))
  assert.equal(usage.item_count, 1)
  const ownerUsage = database.prepare('SELECT used_bytes FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get('user', 'owner') as { used_bytes: number } | undefined
  assert.equal(ownerUsage?.used_bytes ?? 0, 0)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('keeps unknown formal-root files and does not invent report usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-unknown-formal-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  const unknownPath = join(roots.reportRoot, 'quarantine', 'unknown.pdf')
  await createFile(unknownPath, 'unknown formal', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  const database = createNativeMaintenanceDatabase(roots.reportRoot)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(result.allocationsCreated, 0)
  assert.equal(await exists(unknownPath), true)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM storage_allocations WHERE owner_type = 'report'").get()?.count, 0)
  const usage = database.prepare('SELECT used_bytes, item_count FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get('global', 'global') as { used_bytes: number; item_count: number } | undefined
  assert.equal(usage?.used_bytes ?? 0, 0)
  assert.equal(usage?.item_count ?? 0, 0)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

test('native known knowledge permits orphan cleanup but active reservations still protect candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-known-'))
  const roots = { reportRoot: join(directory, 'reports'), knowledgeRoot: join(directory, 'knowledge'), temporaryRoot: join(directory, 'tmp') }
  await Promise.all(Object.values(roots).map((root) => mkdir(root)))
  const database = createNativeMaintenanceDatabase(roots.reportRoot)
  try {
    const known = join(roots.knowledgeRoot, 'known.pdf')
    const orphan = join(roots.knowledgeRoot, 'orphan.pdf')
    const old = new Date(Date.parse(timestamp) - 86400000)
    for (const file of [known, orphan]) await createFile(file, 'data', old)
    database.prepare("INSERT INTO users(id,username,display_name,password_hash,role,created_at,updated_at) VALUES ('user','user','User','hash','researcher',?,?)").run(timestamp, timestamp)
    insertKnowledgeItem(database, { id: 'known', userId: 'user', fileName: 'known.pdf', sourcePath: known, content: 'data' })
    database.prepare("INSERT INTO storage_reservations(id,user_id,expected_bytes,owner_type,expires_at,state,created_at,updated_at) VALUES ('active','user',4,'knowledge','2026-01-03T00:00:00.000Z','active',?,?)").run(timestamp, timestamp)
    const held = await runStorageMaintenance({ database, roots, now: timestamp })
    assert.deepEqual(held.errors, [])
    assert.equal(held.orphanFilesSkippedActiveReservation, 1)
    assert.equal(await exists(orphan), true)
    database.exec("UPDATE storage_reservations SET state='released' WHERE id='active'")
    const cleaned = await runStorageMaintenance({ database, roots, now: timestamp })
    assert.deepEqual(cleaned.errors, [])
    assert.equal(cleaned.orphanFilesDeleted, 1)
    assert.equal(await exists(known), true)
    assert.equal(await exists(orphan), false)
  } finally { database.close(); await rm(directory, { recursive: true, force: true }) }
})

for (const dryRun of [true, false]) {
  test('empty native knowledge ledger refuses ambiguous orphan deletion, dryRun=' + dryRun, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-wrong-knowledge-'))
    const roots = { reportRoot: join(directory, 'reports'), knowledgeRoot: join(directory, 'wrong-knowledge'), temporaryRoot: join(directory, 'tmp') }
    await Promise.all(Object.values(roots).map((root) => mkdir(root)))
    const database = createNativeMaintenanceDatabase(roots.reportRoot)
    try {
      const old = new Date(Date.parse(timestamp) - 86400000)
      const source = join(roots.knowledgeRoot, 'old.pdf')
      const cache = join(roots.knowledgeRoot, 'missing.pdf.content.json')
      const temporary = join(roots.temporaryRoot, 'old.upload')
      const recent = join(roots.knowledgeRoot, 'recent.pdf')
      for (const file of [source, cache, temporary]) await createFile(file, 'keep', old)
      await createFile(recent, 'recent', new Date(timestamp))
      const result = await runStorageMaintenance({ database, roots, now: timestamp, dryRun })
      assert.equal(result.errors.length, 1)
      assert.equal(result.errors[0].path, roots.knowledgeRoot)
      assert.match(result.errors[0].message, /无法确认知识目录归属/)
      for (const file of [source, cache, recent]) assert.equal(await exists(file), true)
      assert.equal(await exists(temporary), dryRun)
      assert.equal(result.orphanFilesDeleted, dryRun ? 0 : 1)
      assert.equal(result.orphanFilesSkippedRecent, dryRun ? 0 : 1)
    } finally { database.close(); await rm(directory, { recursive: true, force: true }) }
  })
}

test('bare empty sqlite still fails on missing maintenance tables without deleting files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-bare-'))
  const roots = { reportRoot: join(directory, 'reports'), knowledgeRoot: join(directory, 'knowledge'), temporaryRoot: join(directory, 'tmp') }
  await Promise.all(Object.values(roots).map((root) => mkdir(root)))
  const database = new DatabaseSync(':memory:')
  try {
    const source = join(roots.knowledgeRoot, 'old.pdf')
    await createFile(source, 'keep', new Date(Date.parse(timestamp) - 86400000))
    await assert.rejects(runStorageMaintenance({ database, roots, now: timestamp }), /no such table/)
    assert.equal(await exists(source), true)
  } finally { database.close(); await rm(directory, { recursive: true, force: true }) }
})

test('refuses a legacy report_versions database without writing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-legacy-refuse-'))
  const roots = {
    reportRoot: join(directory, 'reports'),
    knowledgeRoot: join(directory, 'knowledge'),
    temporaryRoot: join(directory, 'tmp'),
  }
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
  const database = new DatabaseSync(':memory:')
  database.exec("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL); CREATE TABLE report_versions(id TEXT PRIMARY KEY);")
  database.exec("INSERT INTO users(id, username) VALUES ('user-legacy', 'user-legacy')")
  await assert.rejects(
    () => runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 }),
    (error: unknown) => error instanceof NativeSchemaError && error.code === 'LEGACY_DATABASE',
  )
  const user = database.prepare("SELECT username FROM users WHERE id = 'user-legacy'").get() as { username: string }
  assert.equal(user.username, 'user-legacy')
  assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'native_schema_identity'").get(), undefined)
  database.close()
  await rm(directory, { recursive: true, force: true })
})

for (const kind of ['file', 'sidecar'] as const) {
  for (const change of ['reference', 'reservation', 'replacement', 'source'] as const) {
    if (kind === 'file' && change === 'source') continue
    test('cleanup rechecks ' + kind + ' after concurrent ' + change, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'yanxing-storage-recheck-'))
      const roots = { reportRoot: join(directory, 'reports'), knowledgeRoot: join(directory, 'knowledge'), temporaryRoot: join(directory, 'tmp') }
      const target = createDatabase()
      try {
        await Promise.all(Object.values(roots).map(root => mkdir(root)))
        const sourcePath = join(roots.knowledgeRoot, 'orphan.pdf')
        const candidatePath = kind === 'sidecar' ? sourcePath + '.content.json' : sourcePath
        const old = new Date(Date.parse(timestamp) - 86400000)
        await createFile(candidatePath, 'data', old)
        target.prepare("INSERT INTO storage_allocations VALUES ('knowledge','old','user',NULL,1,'hash',?,'text/plain',?,?)").run(join(roots.knowledgeRoot, 'old-record'), timestamp, timestamp)
        let protectionReads = 0
        const database = new Proxy(target, {
          get(object, property) {
            if (property === 'prepare') return (sql: string) => {
              if (sql === 'SELECT source_path FROM knowledge_items UNION ALL SELECT source_path FROM storage_allocations') {
                protectionReads += 1
                if (protectionReads === (kind === 'file' ? 2 : 3)) {
                  if (change === 'reference') {
                    target.prepare("INSERT INTO storage_allocations VALUES ('knowledge','new','user',NULL,4,'hash',?,'text/plain',?,?)").run(sourcePath, timestamp, timestamp)
                  } else if (change === 'reservation') {
                    target.prepare("INSERT INTO storage_reservations(id,user_id,expected_bytes,owner_type,expires_at,state,created_at,updated_at) VALUES ('new','user',4,'knowledge','2026-01-03T00:00:00.000Z','active',?,?)").run(timestamp, timestamp)
                  } else if (change === 'replacement') {
                    renameSync(candidatePath, candidatePath + '.old')
                    writeFileSync(candidatePath, 'data')
                    utimesSync(candidatePath, old, old)
                  } else {
                    writeFileSync(sourcePath, 'new source')
                  }
                }
              }
              return object.prepare(sql)
            }
            const value = Reflect.get(object, property, object)
            return typeof value === 'function' ? value.bind(object) : value
          },
        })
        const result = await runStorageMaintenance({ database, roots, now: timestamp })
        assert.equal(protectionReads, 3, 'files and sidecars each refresh protection after the initial plan')
        assert.deepEqual(result.errors, [])
        assert.equal(result.orphanFilesDeleted, 0)
        assert.equal(result.orphanFilesSkippedProtected, kind === 'file' && change === 'reference' ? 1 : 0)
        assert.equal(result.orphanFilesSkippedRecent, change === 'replacement' ? 1 : 0)
        assert.equal(result.orphanFilesSkippedActiveReservation, change === 'reservation' ? 1 : 0)
        assert.equal(await exists(candidatePath), true)
      } finally {
        target.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
}
