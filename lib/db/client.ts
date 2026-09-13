import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { getDatabasePath } from '@/lib/db/database-path'
import {
  assertNativeSchema,
  ensureNativeDatabase,
  nativeDatabaseInfo,
  NATIVE_SCHEMA_CHECKSUM,
  readNativeIdentity,
  type NativeDatabaseInfo,
} from '@/lib/db/native-schema'
import { getReportStorageRoot } from '@/lib/storage/runtime-roots'
import { assertNoIncompleteRestore } from '@/lib/storage/native-restore-guard'

export {
  NativeSchemaError,
  NATIVE_SCHEMA_ERROR_CODES,
  isNativeSchemaError,
  publicNativeSchemaFailure,
} from '@/lib/db/native-schema-error'

type DatabaseGlobal = typeof globalThis & {
  __yanxingDatabase?: DatabaseSync
  __yanxingDatabasePath?: string
  __yanxingNativeChecksum?: string
}

const databaseGlobal = globalThis as DatabaseGlobal
const SQLITE_BUSY = 5
const BUSY_TIMEOUT_MS = 5000
const WAL_BUSY_ATTEMPTS = 20

/**
 * Unique database connection for Web, Worker, auth, and settings.
 * Empty files are initialized to the native schema. Legacy or mixed files are refused without writes.
 */
export function getDatabase() {
  return openEnsuredDatabase()
}

/** Explicit startup/CLI entry: initialize an empty database or validate the native schema. */
export function migrateDatabase(): NativeDatabaseInfo {
  const database = openEnsuredDatabase()
  const storageRoot = getReportStorageRoot()
  assertNativeSchema({ database, storageRoot })
  return nativeDatabaseInfo(getDatabasePath())
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

function openEnsuredDatabase() {
  const databasePath = getDatabasePath()
  assertNoIncompleteRestore(databasePath)
  const cachedDatabase = databaseGlobal.__yanxingDatabase
  if (cachedDatabase) {
    if (databaseGlobal.__yanxingDatabasePath !== databasePath) {
      throw new Error('进程运行期间不能切换 YANXING_DATABASE_PATH；请重启进程。')
    }
    ensureCachedNativeSchema(cachedDatabase)
    return cachedDatabase
  }

  mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MS })
  try {
    database.exec('PRAGMA busy_timeout = ' + BUSY_TIMEOUT_MS + ';')
    database.exec('PRAGMA foreign_keys = ON;')
    const storageRoot = getReportStorageRoot()
    ensureNativeDatabase({ database, storageRoot })
    enableWal(database)
    databaseGlobal.__yanxingDatabase = database
    databaseGlobal.__yanxingDatabasePath = databasePath
    databaseGlobal.__yanxingNativeChecksum = NATIVE_SCHEMA_CHECKSUM
    return database
  } catch (error) {
    try { database.close() } catch { /* refused connections must not stay cached */ }
    throw error
  }
}

function ensureCachedNativeSchema(database: DatabaseSync) {
  const identity = readNativeIdentity(database)
  if (databaseGlobal.__yanxingNativeChecksum === NATIVE_SCHEMA_CHECKSUM && identity?.checksum === NATIVE_SCHEMA_CHECKSUM) {
    return
  }
  assertNativeSchema({ database, storageRoot: getReportStorageRoot() })
  databaseGlobal.__yanxingNativeChecksum = NATIVE_SCHEMA_CHECKSUM
}

function enableWal(database: DatabaseSync) {
  executeWithBusyRetry(() => {
    database.exec('PRAGMA journal_mode = WAL;')
  })
}

const busyRetrySignal = new Int32Array(new SharedArrayBuffer(4))

function executeWithBusyRetry(operation: () => void) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      operation()
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'errcode' in error ? Number(error.errcode) : undefined
      if (code !== SQLITE_BUSY || attempt >= WAL_BUSY_ATTEMPTS) throw error
      Atomics.wait(busyRetrySignal, 0, 0, 50 * (attempt + 1))
    }
  }
}
