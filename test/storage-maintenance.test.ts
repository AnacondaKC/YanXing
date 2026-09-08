import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { initialSchemaSql } from '../lib/db/migrations/0001-initial-schema'
import { isPathWithinRoot } from '../lib/storage/path-containment'
import { runStorageMaintenance } from '../lib/storage/maintenance'
import { consumeStorageReservationInDatabase, StorageQuotaError } from '../lib/storage/quota'

const timestamp = '2026-01-02T03:04:05.000Z'

function createDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec(initialSchemaSql)
  return database
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
  const activePath = join(roots.reportRoot, 'report-live', 'report-live.pdf')
  const orphanPath = join(roots.reportRoot, 'orphan', 'orphan.pdf')
  const recentPath = join(roots.knowledgeRoot, 'recent', 'recent.pdf')
  const oldDate = new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000)
  const nowDate = new Date(timestamp)
  await createFile(activePath, 'active report', nowDate)
  await createFile(orphanPath, 'orphan report', oldDate)
  await createFile(recentPath, 'recent file', nowDate)

  const database = createDatabase()
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('user-1', 'user-1', '测试用户', 'hash', 'researcher', timestamp, timestamp)
  database.prepare('INSERT INTO projects(id, title, objective, owner_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('project-1', '测试课题', '', '测试用户', 'not_started', timestamp, timestamp)
  database.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('project-1', 'user-1', 'owner', timestamp)
  database.prepare('INSERT INTO report_versions(id, project_id, version, title, file_name, file_hash, source_path, mime_type, source_size, parse_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('report-live', 'project-1', 1, 'Live', 'report-live.pdf', 'hash-live', activePath, 'application/pdf', Buffer.byteLength('active report'), 'uploaded', timestamp)
  database.prepare('INSERT INTO storage_allocations(owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path, mime_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('report', 'report-gone', 'user-1', 'project-1', 12, 'hash-gone', orphanPath, 'application/pdf', timestamp, timestamp)
  database.prepare('INSERT INTO storage_reservations(id, user_id, project_id, expected_bytes, owner_type, expires_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('reservation-expired', 'user-1', 'project-1', 99, 'report', '2026-01-01T00:00:00.000Z', 'active', timestamp, timestamp)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('global', 'global', 999, 9, 99, 1, 4, timestamp)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('user', 'user-1', 999, 9, 99, 1, 4, timestamp)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('project', 'project-1', 999, 9, 99, 1, 4, timestamp)

  const result = await runStorageMaintenance({ database, roots, now: timestamp, orphanGraceMs: 0 })
  assert.equal(result.expiredReservations, 1)
  assert.equal(result.allocationsCreated, 1)
  assert.equal(result.allocationsRemoved, 1)
  assert.equal(result.orphanFilesDeleted, 1)
  assert.equal(result.orphanFilesSkippedRecent, 1)
  assert.equal(await exists(activePath), true)
  assert.equal(await exists(orphanPath), false)
  assert.equal(await exists(recentPath), true)

  const allocation = database.prepare('SELECT user_id, project_id, size_bytes, source_path FROM storage_allocations WHERE owner_type = ? AND owner_id = ?').get('report', 'report-live') as { user_id: string; project_id: string; size_bytes: number; source_path: string }
  assert.equal(allocation.user_id, 'user-1')
  assert.equal(allocation.project_id, 'project-1')
  assert.equal(allocation.size_bytes, Buffer.byteLength('active report'))
  assert.equal(allocation.source_path, activePath)
  const globalUsage = database.prepare('SELECT used_bytes, item_count, reserved_bytes, reserved_count FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get('global', 'global') as { used_bytes: number; item_count: number; reserved_bytes: number; reserved_count: number }
  assert.equal(globalUsage.used_bytes, Buffer.byteLength('active report'))
  assert.equal(globalUsage.item_count, 1)
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
  assert.equal(result.orphanFilesFound, 1)
  assert.equal(result.orphanFilesDeleted, 0)
  assert.equal(result.orphanFilesSkippedActiveReservation, 1)
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
  const sidecarPath = join(roots.reportRoot, 'old', 'missing.docx.content.json')
  await createFile(sidecarPath, '{"text":"cached"}', new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000))
  await mkdir(roots.knowledgeRoot, { recursive: true })
  await mkdir(roots.temporaryRoot, { recursive: true })
  const database = createDatabase()

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
  database.prepare('INSERT INTO projects(id, title, objective, owner_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('project-sidecar', '缓存课题', '', '缓存用户', 'not_started', timestamp, timestamp)
  database.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('project-sidecar', 'user-sidecar', 'owner', timestamp)
  database.prepare('INSERT INTO report_versions(id, project_id, version, title, file_name, file_hash, source_path, mime_type, source_size, parse_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('report-sidecar', 'project-sidecar', 1, 'Live', 'live.docx', 'hash-sidecar', sourcePath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.byteLength('live report'), 'uploaded', timestamp)

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
  const sourcePath = join(roots.reportRoot, 'orphan', 'orphan.docx')
  const sidecarPath = `${sourcePath}.content.json`
  const oldDate = new Date(Date.parse(timestamp) - 24 * 60 * 60 * 1000)
  await createFile(sourcePath, 'orphan report', oldDate)
  await createFile(sidecarPath, '{"text":"cached"}', oldDate)
  const database = createDatabase()

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
  assert.equal(result.orphanFilesDeleted, 1)
  assert.equal(await exists(orphanPath), false)
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
  const livePath = join(roots.reportRoot, 'race-report', 'source.docx')
  const target = createDatabase()
  target.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('race-user', 'race-user', '竞态用户', 'hash', 'researcher', timestamp, timestamp)
  target.prepare('INSERT INTO projects(id, title, objective, owner_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('race-project', '竞态课题', '', '竞态用户', 'not_started', timestamp, timestamp)
  target.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('race-project', 'race-user', 'owner', timestamp)
  target.prepare('INSERT INTO report_versions(id, project_id, version, title, file_name, file_hash, source_path, mime_type, source_size, parse_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('race-report', 'race-project', 1, 'Race', 'source.docx', 'race-hash', livePath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 12, 'uploaded', timestamp)
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
  assert.equal((target.prepare("SELECT source_path FROM storage_allocations WHERE owner_type = 'report' AND owner_id = 'race-report'").get() as { source_path: string }).source_path, livePath)
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
