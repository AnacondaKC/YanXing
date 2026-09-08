import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { getDatabasePath } from '@/lib/db/database-path'
import { databaseMigrations } from '@/lib/db/migrations'
import { readSchemaVersion, runMigrations } from '@/lib/db/migrate'

type DatabaseGlobal = typeof globalThis & {
  __yanxingDatabase?: DatabaseSync
  __yanxingDatabasePath?: string
  __yanxingSchemaVersion?: number
  __yanxingSchemaChecksum?: string
  __yanxingMigrationHeadStatement?: ReturnType<DatabaseSync['prepare']>
}

const databaseGlobal = globalThis as DatabaseGlobal

/**
 * 唯一的数据库连接入口：Web、Worker、认证和模型设置都从这里取得同一个全局连接。
 * 每次访问都会读取账本头；版本或 checksum 变化时重新执行完整迁移校验，避免热更新缓存绕过校验。
 */
export function getDatabase() {
  const database = openDatabase()
  ensureCachedDatabaseSchema(database)
  return database
}

/** 在 Web / Worker 启动前由管理脚本显式执行；每次调用都会校验账本和 schema。 */
export function migrateDatabase() {
  const database = openDatabase()
  const version = validateDatabaseSchema(database)
  return {
    path: getDatabasePath(),
    version,
    migrations: databaseMigrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
    })),
  }
}

export function inImmediateTransaction<T>(operation: (database: DatabaseSync) => T): T {
  const database = getDatabase()
  try {
    database.exec('BEGIN IMMEDIATE')
    const result = operation(database)
    database.exec('COMMIT')
    return result
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}

function ensureCachedDatabaseSchema(database: DatabaseSync) {
  const expectedMigration = getExpectedMigration()
  const storedMigration = readStoredMigrationHead(database)
  const cacheMatches = databaseGlobal.__yanxingSchemaVersion === expectedMigration.version
    && databaseGlobal.__yanxingSchemaChecksum === expectedMigration.checksum
  const ledgerMatches = storedMigration?.version === expectedMigration.version
    && storedMigration.checksum === expectedMigration.checksum
  if (cacheMatches && ledgerMatches) return storedMigration.version
  return applyDatabaseMigrations(database, expectedMigration)
}

function validateDatabaseSchema(database: DatabaseSync) {
  return applyDatabaseMigrations(database, getExpectedMigration())
}

function applyDatabaseMigrations(database: DatabaseSync, expectedMigration: typeof databaseMigrations[number]) {
  runMigrations(database)
  const version = readSchemaVersion(database)
  databaseGlobal.__yanxingSchemaVersion = version
  databaseGlobal.__yanxingSchemaChecksum = expectedMigration.checksum
  return version
}

function getExpectedMigration() {
  const expectedMigration = databaseMigrations.at(-1)
  if (!expectedMigration) throw new Error('数据库迁移清单为空。')
  return expectedMigration
}

function readStoredMigrationHead(database: DatabaseSync) {
  try {
    const statement = databaseGlobal.__yanxingMigrationHeadStatement
      ?? database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version DESC LIMIT 1')
    databaseGlobal.__yanxingMigrationHeadStatement = statement
    const row = statement.get() as { version?: unknown; checksum?: unknown } | undefined
    if (!row) return { version: 0, checksum: '' }
    return { version: Number(row.version) || 0, checksum: typeof row.checksum === 'string' ? row.checksum : '' }
  } catch {
    databaseGlobal.__yanxingMigrationHeadStatement = undefined
    return undefined
  }
}

function openDatabase() {
  const databasePath = getDatabasePath()
  const cachedDatabase = databaseGlobal.__yanxingDatabase
  if (cachedDatabase) {
    if (databaseGlobal.__yanxingDatabasePath !== databasePath) {
      throw new Error('进程运行期间不能切换 YANXING_DATABASE_PATH；请重启进程。')
    }
    return cachedDatabase
  }

  mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath, { timeout: 5000 })
  database.exec('PRAGMA busy_timeout = 5000;')
  executeWithBusyRetry(() => database.exec('PRAGMA journal_mode = WAL;'))
  database.exec('PRAGMA foreign_keys = ON;')
  databaseGlobal.__yanxingDatabase = database
  databaseGlobal.__yanxingDatabasePath = databasePath
  databaseGlobal.__yanxingMigrationHeadStatement = undefined
  return database
}

const busyRetrySignal = new Int32Array(new SharedArrayBuffer(4))

function executeWithBusyRetry(operation: () => void) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      operation()
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'errcode' in error ? Number(error.errcode) : undefined
      if (code !== 5 || attempt >= 20) throw error
      Atomics.wait(busyRetrySignal, 0, 0, 50 * (attempt + 1))
    }
  }
}
