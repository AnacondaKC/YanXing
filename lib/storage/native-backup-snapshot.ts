import { existsSync, unlinkSync } from 'node:fs'
import { backup, DatabaseSync } from 'node:sqlite'
import { isNativeSchemaError } from '@/lib/db/native-schema-error'
import { assertNativeSchema } from '@/lib/db/native-schema'
import { NativeBackupError, type NativeBackupErrorCode } from '@/lib/storage/native-backup-error'
import { assertBackupQuiescent } from '@/lib/storage/native-backup-quiescence'

const FENCE_TIMEOUT_MS = 250
const BACKUP_PAGE_RATE = 1_000_000
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

export async function withQuiescentSqliteFence<T>(input: {
  databasePath: string
  storageRoot: string
  whileHeld: (reader: DatabaseSync) => Promise<T>
}): Promise<T> {
  const writer = openSqlite(input.databasePath, false)
  try {
    beginImmediateOrThrow(writer)
    try {
      assertNativeSchemaForBackup(writer, input.storageRoot)
      assertBackupQuiescent(writer)
      const reader = openSqlite(input.databasePath, true)
      try {
        const result = await input.whileHeld(reader)
        assertBackupQuiescent(writer)
        return result
      } finally {
        reader.close()
      }
    } finally {
      try { writer.exec('ROLLBACK') } catch { /* transaction already closed */ }
    }
  } finally {
    writer.close()
  }
}

export async function snapshotSqliteToFile(input: { reader: DatabaseSync; destinationFile: string; storageRoot: string }) {
  await backup(input.reader, input.destinationFile, { rate: BACKUP_PAGE_RATE })
  const snapshot = openSqlite(input.destinationFile, false)
  try {
    snapshot.exec('PRAGMA foreign_keys = ON')
    assertNativeSchemaForBackup(snapshot, input.storageRoot)
    assertSqliteIntegrity(snapshot)
    snapshot.exec('PRAGMA journal_mode = DELETE')
    return readPageCount(snapshot)
  } finally {
    snapshot.close()
    removeSqliteSidecar(input.destinationFile)
  }
}

export function openSqlite(path: string, readOnly: boolean) {
  const database = new DatabaseSync(path, { readOnly, timeout: FENCE_TIMEOUT_MS })
  try {
    if (!readOnly) database.exec('PRAGMA busy_timeout = ' + FENCE_TIMEOUT_MS)
    database.exec('PRAGMA foreign_keys = ON')
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

export function assertSqliteIntegrity(database: DatabaseSync) {
  const integrity = database.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: unknown }>
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new NativeBackupError('INTEGRITY_FAILED')
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeys.length > 0) throw new NativeBackupError('INTEGRITY_FAILED')
}

export function assertNativeSchemaForBackup(database: DatabaseSync, storageRoot: string) {
  try {
    assertNativeSchema({ database, storageRoot })
  } catch (error) {
    if (isNativeSchemaError(error)) throw new NativeBackupError(error.code as NativeBackupErrorCode)
    throw error
  }
}

function beginImmediateOrThrow(database: DatabaseSync) {
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch (error) {
    if (isBusyLockError(error)) throw new NativeBackupError('LOCK_UNAVAILABLE')
    throw error
  }
}

function readPageCount(database: DatabaseSync) {
  const row = database.prepare('PRAGMA page_count').get() as { page_count?: unknown } | undefined
  const pageCount = Number(row?.page_count)
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new NativeBackupError('INTEGRITY_FAILED')
  return pageCount
}

function removeSqliteSidecar(databasePath: string) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = databasePath + suffix
    if (existsSync(sidecar)) unlinkSync(sidecar)
  }
}

function isBusyLockError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const errcode = 'errcode' in error ? Number((error as { errcode: unknown }).errcode) : Number.NaN
  if (errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED) return true
  const code = 'code' in error ? String((error as { code: unknown }).code) : ''
  if (code.includes('BUSY') || code.includes('LOCKED')) return true
  return error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(error.message)
}
