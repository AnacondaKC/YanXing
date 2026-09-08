import type { DatabaseSync } from 'node:sqlite'
import {
  type AppliedDatabaseMigration,
  type DatabaseMigration,
  databaseMigrations,
} from '@/lib/db/migrations'
import { assertSchemaContract } from '@/lib/db/schema-contract'

const DESTRUCTIVE_RESET_GUIDANCE = '当前版本采用破坏性 schema 重置，不支持历史数据库兼容；请先备份需要保留的数据，停止服务后删除整个运行时 storage 目录（包括数据库、-wal/-shm、backups、reports、knowledge、tmp；若使用 YANXING_DATABASE_PATH，也要删除该路径及同目录运行时文件），再重新初始化。'

/**
 * 执行缺失迁移并校验账本，是唯一的迁移入口。
 * BEGIN IMMEDIATE 保证 Web / Worker 并发启动时只有一个进程真正建表，其余进程等待后读到完整账本直接提交。
 */
export function runMigrations(
  database: DatabaseSync,
  migrations: readonly DatabaseMigration[] = databaseMigrations,
): AppliedDatabaseMigration[] {
  database.exec('BEGIN IMMEDIATE')
  try {
    ensureMigrationLedger(database)
    const applied = readAppliedMigrations(database)
    validateAppliedMigrations(applied, migrations)

    for (const migration of migrations.slice(applied.length)) {
      migration.apply(database)
      database.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, migration.checksum, new Date().toISOString())
    }

    const includesCurrentSchema = databaseMigrations.every((migration, index) => migrations[index]?.version === migration.version)
    if (includesCurrentSchema) assertSchemaContract(database)
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyErrors.length) throw new Error('数据库外键校验失败。')
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
  return readAppliedMigrations(database)
}

/** 迁移账本是 schema 版本的最终依据；globalState 缓存只用于减少查询。 */
export function readSchemaVersion(database: DatabaseSync) {
  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: unknown }
  return Number(row.version) || 0
}

function ensureMigrationLedger(database: DatabaseSync) {
  const exists = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get() as { present?: number } | undefined

  if (!exists) {
    const existingTables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>
    if (existingTables.length) {
      throw new Error('检测到没有绿地迁移账本的现有数据库；' + DESTRUCTIVE_RESET_GUIDANCE)
    }
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)
    return
  }

  if (!hasCanonicalMigrationLedger(database)) {
    throw new Error('检测到旧版或损坏的迁移账本；' + DESTRUCTIVE_RESET_GUIDANCE)
  }

  const appliedCount = (database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: unknown }).count
  if (Number(appliedCount) === 0) {
    const existingTables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
    `).all() as Array<{ name: string }>
    if (existingTables.length) {
      throw new Error('检测到没有来源的空迁移账本；' + DESTRUCTIVE_RESET_GUIDANCE)
    }
  }
}

function hasCanonicalMigrationLedger(database: DatabaseSync) {
  const columns = database.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{ name?: unknown }>
  const names = columns.flatMap((column) => typeof column.name === 'string' ? [column.name] : [])
  const expected = ['version', 'name', 'checksum', 'applied_at']
  return names.length === expected.length && expected.every((name) => names.includes(name))
}

function readAppliedMigrations(database: DatabaseSync): AppliedDatabaseMigration[] {
  return (database.prepare(`
    SELECT version, name, checksum, applied_at
    FROM schema_migrations
    ORDER BY version ASC
  `).all() as Array<{ version: unknown; name: unknown; checksum: unknown; applied_at: unknown }>).map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: String(row.applied_at),
  }))
}

function validateAppliedMigrations(applied: readonly AppliedDatabaseMigration[], migrations: readonly DatabaseMigration[]) {
  if (applied.length > migrations.length) {
    throw new Error('数据库包含当前程序未知的迁移；' + DESTRUCTIVE_RESET_GUIDANCE)
  }
  for (const [index, migration] of applied.entries()) {
    const expected = migrations[index]
    if (!expected || !matchesMigration(migration, expected)) {
      throw new Error('数据库迁移账本校验失败：version ' + migration.version + ' 的名称或 checksum 不匹配；' + DESTRUCTIVE_RESET_GUIDANCE)
    }
  }
}

function matchesMigration(applied: AppliedDatabaseMigration, expected: DatabaseMigration | undefined) {
  if (!expected) return false
  return applied.version === expected.version
    && applied.name === expected.name
    && applied.checksum === expected.checksum
}
