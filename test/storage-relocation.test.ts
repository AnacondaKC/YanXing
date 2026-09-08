import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { databaseMigrations } from '../lib/db/migrations'
import { initialSchemaSql } from '../lib/db/migrations/0001-initial-schema'
import { addReportSourceUpdatedAtSql } from '../lib/db/migrations/0002-add-report-source-updated-at'
import { dropSessionsLastSeenAtSql } from '../lib/db/migrations/0003-drop-sessions-last-seen-at'
import { addBrandSettingsSql } from '../lib/db/migrations/0004-add-brand-settings'
import { updateDefaultBrandSql } from '../lib/db/migrations/0005-update-default-brand'
import {
  DEFAULT_RELOCATION_DATABASE_PATH,
  DEFAULT_RELOCATION_TARGET_ROOT,
  RELOCATION_OFFLINE_WARNING,
  STORAGE_PATH_RELATIONS,
  StorageRelocationError,
  buildStorageRelocationMappings,
  formatRelocationReport,
  normalizeStoragePathMappings,
  openRelocationDatabase,
  relocateStoragePaths,
} from '../lib/storage/relocate-paths'
import {
  RELOCATION_USAGE,
  parseRelocateStorageArgs,
  resolveRelocationDatabasePath,
  runRelocateStorageCli,
} from '../scripts/relocate-storage'

const timestamp = '2026-01-02T03:04:05.000Z'
const scriptPath = fileURLToPath(new URL('../scripts/relocate-storage.ts', import.meta.url))

function createCompleteDatabase(databasePath?: string) {
  const database = databasePath ? new DatabaseSync(databasePath) : new DatabaseSync(':memory:')
  database.exec(initialSchemaSql)
  database.exec(addReportSourceUpdatedAtSql)
  database.exec(dropSessionsLastSeenAtSql)
  database.exec(addBrandSettingsSql)
  database.exec(updateDefaultBrandSql)
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)
  const insert = database.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
  for (const migration of databaseMigrations) {
    insert.run(migration.version, migration.name, migration.checksum, timestamp)
  }
  seedOwner(database)
  return database
}

function seedOwner(database: DatabaseSync) {
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('user-1', 'user-1', '测试用户', 'hash', 'researcher', timestamp, timestamp)
  database.prepare('INSERT INTO projects(id, title, objective, owner_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('project-1', '测试课题', '', '测试用户', 'not_started', timestamp, timestamp)
}

function insertReport(database: DatabaseSync, input: { id: string; sourcePath: string; version?: number }) {
  database.prepare('INSERT INTO report_versions(id, project_id, version, title, file_name, file_hash, source_path, mime_type, source_size, parse_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.id, 'project-1', input.version ?? 1, input.id, input.id + '.pdf', 'hash-' + input.id, input.sourcePath, 'application/pdf', 4, 'uploaded', timestamp)
}

function insertKnowledge(database: DatabaseSync, input: { id: string; sourcePath: string }) {
  database.prepare('INSERT INTO knowledge_items(id, title, file_name, file_size, category, description, tags_json, source_path, file_hash, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.id, input.id, input.id + '.pdf', 4, 'policy', '', '[]', input.sourcePath, 'hash-' + input.id, 'user-1', timestamp, timestamp)
}

function insertAllocation(database: DatabaseSync, input: { ownerType: string; ownerId: string; sourcePath: string }) {
  database.prepare('INSERT INTO storage_allocations(owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path, mime_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.ownerType, input.ownerId, 'user-1', 'project-1', 4, 'hash-' + input.ownerId, input.sourcePath, 'application/pdf', timestamp, timestamp)
}

function sourcePath(database: DatabaseSync, table: string, id: string) {
  if (table === 'storage_allocations') {
    const row = database.prepare('SELECT source_path FROM storage_allocations WHERE owner_id = ?').get(id) as { source_path: string }
    return row.source_path
  }
  const row = database.prepare('SELECT source_path FROM ' + table + ' WHERE id = ?').get(id) as { source_path: string }
  return row.source_path
}

function writeMappedFile(toRoot: string, relativePath: string) {
  const targetPath = join(toRoot, relativePath)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, 'data')
  return targetPath
}

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'yanxing-relocate-'))
  const fromRoot = join(root, 'old-storage')
  const toRoot = join(root, 'app-storage')
  mkdirSync(toRoot, { recursive: true })
  return { root, fromRoot, toRoot }
}

function relocate(input: { database: DatabaseSync; fromRoot: string; toRoot: string; maps?: { fromRoot: string; toRoot: string }[]; mode?: 'dry-run' | 'apply' }) {
  return relocateStoragePaths({
    database: input.database,
    mappings: buildStorageRelocationMappings({
      fromRoots: [input.fromRoot],
      toRoot: input.toRoot,
      maps: input.maps,
    }),
    mode: input.mode ?? 'apply',
  })
}

test('tracks the three persistent source_path relations', () => {
  assert.deepEqual(STORAGE_PATH_RELATIONS.map((relation) => relation.table), [
    'report_versions',
    'knowledge_items',
    'storage_allocations',
  ])
})

test('defaults --to to /app/storage and database to docker sqlite path', () => {
  assert.equal(DEFAULT_RELOCATION_TARGET_ROOT, '/app/storage')
  assert.equal(DEFAULT_RELOCATION_DATABASE_PATH, '/app/storage/yanxing.sqlite')
  assert.deepEqual(
    buildStorageRelocationMappings({ fromRoots: ['/old/storage'] }),
    [{ fromRoot: '/old/storage', toRoot: '/app/storage' }],
  )
  assert.equal(resolveRelocationDatabasePath({}), DEFAULT_RELOCATION_DATABASE_PATH)
})

test('parses relocate CLI flags including advertised nested --map', () => {
  const parsed = parseRelocateStorageArgs([
    '--from', '/old/storage',
    '--to', '/app/storage',
    '--map', '/old/knowledge=/app/storage/knowledge',
    '--database', '/app/storage/yanxing.sqlite',
    '--apply',
  ])
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.values.fromRoots, ['/old/storage'])
  assert.equal(parsed.values.toRoot, '/app/storage')
  assert.deepEqual(parsed.values.maps, [{ fromRoot: '/old/knowledge', toRoot: '/app/storage/knowledge' }])
  assert.equal(parsed.values.database, '/app/storage/yanxing.sqlite')
  assert.equal(parsed.values.apply, true)
})

test('rejects unknown CLI flags, missing values, and --apply values', () => {
  assert.match(parseRelocateStorageArgs(['--mode=production']).error || '', /未知参数/)
  assert.match(parseRelocateStorageArgs(['--from']).error || '', /缺少值/)
  assert.match(parseRelocateStorageArgs(['--apply=true']).error || '', /不接受值/)
  assert.match(parseRelocateStorageArgs(['--map', 'noseconds']).error || '', /OLD=NEW/)
})

test('rejects overlapping source roots and no-op mappings, but allows nested target roots', () => {
  assert.throws(() => normalizeStoragePathMappings([{ fromRoot: '/old/storage', toRoot: '/old/storage' }]), /空操作/)
  assert.throws(() => normalizeStoragePathMappings([
    { fromRoot: '/old/storage', toRoot: '/app/storage' },
    { fromRoot: '/old/storage/reports', toRoot: '/app/storage/reports' },
  ]), /源根不能相同或互相嵌套/)
  assert.throws(() => normalizeStoragePathMappings([{ fromRoot: '/old/storage/../storage', toRoot: '/app/storage' }]), /路径遍历/)
  const nestedTargets = normalizeStoragePathMappings([
    { fromRoot: '/old/storage', toRoot: '/app/storage' },
    { fromRoot: '/old/knowledge', toRoot: '/app/storage/knowledge' },
  ])
  assert.equal(nestedTargets.length, 2)
  assert.equal(nestedTargets[1].toRoot, '/app/storage/knowledge')
})

test('apply rewrites all three tables; dry-run rolls back', () => {
  const workspace = createWorkspace()
  try {
    const reportRel = 'reports/report-live/live.pdf'
    const knowledgeRel = 'knowledge/item-1/item.pdf'
    writeMappedFile(workspace.toRoot, reportRel)
    writeMappedFile(workspace.toRoot, knowledgeRel)
    const oldReport = join(workspace.fromRoot, reportRel)
    const oldKnowledge = join(workspace.fromRoot, knowledgeRel)
    const database = createCompleteDatabase()
    insertReport(database, { id: 'report-live', sourcePath: oldReport })
    insertKnowledge(database, { id: 'item-1', sourcePath: oldKnowledge })
    insertAllocation(database, { ownerType: 'report', ownerId: 'report-live', sourcePath: oldReport })
    insertAllocation(database, { ownerType: 'knowledge', ownerId: 'item-1', sourcePath: oldKnowledge })

    const preview = relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot, mode: 'dry-run' })
    assert.equal(preview.committed, false)
    assert.equal(preview.rewritten, 4)
    assert.equal(sourcePath(database, 'report_versions', 'report-live'), oldReport)
    assert.equal(sourcePath(database, 'knowledge_items', 'item-1'), oldKnowledge)
    assert.match(formatRelocationReport(preview), /干跑/)
    assert.match(formatRelocationReport(preview), new RegExp(RELOCATION_OFFLINE_WARNING))

    const applied = relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot, mode: 'apply' })
    assert.equal(applied.committed, true)
    assert.equal(applied.rewritten, 4)
    assert.equal(sourcePath(database, 'report_versions', 'report-live'), join(workspace.toRoot, reportRel))
    assert.equal(sourcePath(database, 'knowledge_items', 'item-1'), join(workspace.toRoot, knowledgeRel))
    assert.equal(sourcePath(database, 'storage_allocations', 'report-live'), join(workspace.toRoot, reportRel))
    assert.equal(sourcePath(database, 'storage_allocations', 'item-1'), join(workspace.toRoot, knowledgeRel))

    const again = relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot, mode: 'apply' })
    assert.equal(again.rewritten, 0)
    assert.equal(again.alreadyRelocated, 4)
    database.close()
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('preserves unmatched external paths, reports extra roots, and relocates them with nested --map', () => {
  const workspace = createWorkspace()
  try {
    const reportRel = 'reports/report-live/live.pdf'
    const knowledgeRel = 'k1/item.pdf'
    writeMappedFile(workspace.toRoot, reportRel)
    const knowledgeTo = join(workspace.toRoot, 'knowledge')
    mkdirSync(knowledgeTo, { recursive: true })
    writeMappedFile(knowledgeTo, knowledgeRel)
    const oldReport = join(workspace.fromRoot, reportRel)
    const oldKnowledgeRoot = join(workspace.root, 'old-knowledge')
    const oldKnowledge = join(oldKnowledgeRoot, knowledgeRel)
    const database = createCompleteDatabase()
    insertReport(database, { id: 'report-live', sourcePath: oldReport })
    insertKnowledge(database, { id: 'item-1', sourcePath: oldKnowledge })
    insertAllocation(database, { ownerType: 'report', ownerId: 'report-live', sourcePath: oldReport })

    assert.throws(() => relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot, mode: 'apply' }), (error: unknown) => {
      assert.ok(error instanceof StorageRelocationError)
      assert.match(error.message, /请增加 --from 或 --map/)
      assert.equal(error.report?.unmatched, 1)
      assert.equal(sourcePath(database, 'report_versions', 'report-live'), oldReport)
      assert.equal(sourcePath(database, 'knowledge_items', 'item-1'), oldKnowledge)
      return true
    })

    const applied = relocate({
      database,
      fromRoot: workspace.fromRoot,
      toRoot: workspace.toRoot,
      maps: [{ fromRoot: oldKnowledgeRoot, toRoot: knowledgeTo }],
      mode: 'apply',
    })
    assert.equal(applied.rewritten, 3)
    assert.equal(sourcePath(database, 'report_versions', 'report-live'), join(workspace.toRoot, reportRel))
    assert.equal(sourcePath(database, 'knowledge_items', 'item-1'), join(knowledgeTo, knowledgeRel))
    assert.equal(sourcePath(database, 'storage_allocations', 'report-live'), join(workspace.toRoot, reportRel))
    database.close()
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('rejects path traversal, sibling prefixes, missing targets, directories, and escaping symlinks', () => {
  const workspace = createWorkspace()
  try {
    const database = createCompleteDatabase()
    const traversalPath = workspace.fromRoot + '/reports/../outside/file.pdf'
    insertReport(database, { id: 'escape', sourcePath: traversalPath })
    assert.throws(() => relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot }), /路径遍历/)
    assert.equal(sourcePath(database, 'report_versions', 'escape'), traversalPath)

    database.prepare('DELETE FROM report_versions').run()
    const siblingOld = join(workspace.root, 'old-storage-backup', 'reports', 'r1', 'a.pdf')
    insertReport(database, { id: 'sibling', sourcePath: siblingOld })
    assert.throws(() => relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot }), /请增加 --from 或 --map/)
    assert.equal(sourcePath(database, 'report_versions', 'sibling'), siblingOld)

    database.prepare('DELETE FROM report_versions').run()
    const missingOld = join(workspace.fromRoot, 'reports', 'missing', 'a.pdf')
    insertReport(database, { id: 'missing', sourcePath: missingOld })
    assert.throws(() => relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot }), /目标文件不存在/)

    database.prepare('DELETE FROM report_versions').run()
    const dirRel = 'reports/dir-target/file.pdf'
    mkdirSync(join(workspace.toRoot, dirRel), { recursive: true })
    insertReport(database, { id: 'directory', sourcePath: join(workspace.fromRoot, dirRel) })
    assert.throws(() => relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot }), /不是常规文件/)

    database.prepare('DELETE FROM report_versions').run()
    const outside = join(workspace.root, 'outside.pdf')
    writeFileSync(outside, 'secret')
    const linkRel = 'reports/link-target/file.pdf'
    mkdirSync(dirname(join(workspace.toRoot, linkRel)), { recursive: true })
    symlinkSync(outside, join(workspace.toRoot, linkRel))
    insertReport(database, { id: 'symlink', sourcePath: join(workspace.fromRoot, linkRel) })
    assert.throws(() => relocate({ database, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot }), /不是常规文件/)
    database.close()
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('does not migrate, seed, or reset when the ledger or checksum is unsafe', () => {
  const workspace = createWorkspace()
  try {
    writeMappedFile(workspace.toRoot, 'reports/r1/a.pdf')
    const oldPath = join(workspace.fromRoot, 'reports/r1/a.pdf')

    const incomplete = new DatabaseSync(':memory:')
    incomplete.exec(initialSchemaSql)
    seedOwner(incomplete)
    insertReport(incomplete, { id: 'report-live', sourcePath: oldPath })
    assert.throws(() => relocate({ database: incomplete, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot }), /schema_migrations|迁移/)
    const tables = incomplete.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migrations', 'brand_settings')").all() as Array<{ name: string }>
    assert.deepEqual(tables, [])
    assert.equal(sourcePath(incomplete, 'report_versions', 'report-live'), oldPath)
    incomplete.close()

    const tampered = createCompleteDatabase()
    insertReport(tampered, { id: 'report-live', sourcePath: oldPath })
    tampered.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('deadbeef')
    assert.throws(() => relocate({ database: tampered, fromRoot: workspace.fromRoot, toRoot: workspace.toRoot }), /checksum/)
    assert.equal(sourcePath(tampered, 'report_versions', 'report-live'), oldPath)
    tampered.close()
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('rejects destination collisions from distinct source paths', () => {
  const workspace = createWorkspace()
  try {
    writeMappedFile(workspace.toRoot, 'file.pdf')
    const database = createCompleteDatabase()
    const fromA = join(workspace.root, 'old-a')
    const fromB = join(workspace.root, 'old-b')
    insertReport(database, { id: 'report-a', sourcePath: join(fromA, 'file.pdf') })
    insertKnowledge(database, { id: 'item-b', sourcePath: join(fromB, 'file.pdf') })
    assert.throws(() => relocateStoragePaths({
      database,
      mappings: [
        { fromRoot: fromA, toRoot: workspace.toRoot },
        { fromRoot: fromB, toRoot: workspace.toRoot },
      ],
      mode: 'apply',
    }), /同一目标/)
    assert.equal(sourcePath(database, 'report_versions', 'report-a'), join(fromA, 'file.pdf'))
    database.close()
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('openRelocationDatabase refuses missing files and does not create them', () => {
  const workspace = createWorkspace()
  try {
    const missing = join(workspace.root, 'missing.sqlite')
    assert.throws(() => openRelocationDatabase(missing), /不存在/)
    assert.equal(existsSync(missing), false)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('CLI help and apply work via exported runner and node --import tsx', () => {
  const helpIo = { stdout: '', stderr: '', log(message: string) { this.stdout += message + '\n' }, error(message: string) { this.stderr += message + '\n' } }
  assert.equal(runRelocateStorageCli(['--help'], helpIo), 0)
  assert.match(helpIo.stdout, /--from OLD_STORAGE_ROOT/)
  assert.match(helpIo.stdout, /Web 与 Worker/)
  assert.match(RELOCATION_USAGE, /不会执行迁移/)

  const missingFrom = { stdout: '', stderr: '', log(message: string) { this.stdout += message + '\n' }, error(message: string) { this.stderr += message + '\n' } }
  assert.equal(runRelocateStorageCli([], missingFrom), 1)
  assert.match(missingFrom.stderr, /必须提供 --from/)

  const workspace = createWorkspace()
  try {
    const relative = 'reports/r1/a.pdf'
    writeMappedFile(workspace.toRoot, relative)
    const databasePath = join(workspace.root, 'yanxing.sqlite')
    const database = createCompleteDatabase(databasePath)
    insertReport(database, { id: 'report-live', sourcePath: join(workspace.fromRoot, relative) })
    database.close()

    const io = { stdout: '', stderr: '', log(message: string) { this.stdout += message + '\n' }, error(message: string) { this.stderr += message + '\n' } }
    const code = runRelocateStorageCli([
      '--from', workspace.fromRoot,
      '--to', workspace.toRoot,
      '--database', databasePath,
      '--apply',
    ], io)
    assert.equal(code, 0, io.stderr)
    assert.match(io.stdout, /已提交/)
    const verify = new DatabaseSync(databasePath, { readOnly: true })
    assert.equal(sourcePath(verify, 'report_versions', 'report-live'), join(workspace.toRoot, relative))
    verify.close()

    const spawned = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), scriptPath, '--help'], {
      encoding: 'utf8',
      env: process.env,
      timeout: 20_000,
    })
    assert.equal(spawned.status, 0, spawned.stderr)
    assert.match(spawned.stdout, /--from OLD_STORAGE_ROOT/)
    assert.match(spawned.stdout, /Web 与 Worker/)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})
