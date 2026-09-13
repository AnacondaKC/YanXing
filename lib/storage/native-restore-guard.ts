import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NativeSchemaError } from '@/lib/db/native-schema-error'
import { NativeBackupError } from '@/lib/storage/native-backup-error'
import { assertExistingAncestorsAreNotSymlinks, isExistError, lstatOrUndefined, requireAbsolutePath } from '@/lib/storage/native-backup-paths'

export const RESTORE_INCOMPLETE_MARKER_NAME = '.yanxing-restore-incomplete'
export const BACKUP_COMPLETION_FILE_NAME = 'MANIFEST.json'

export class RestorePublicationInterruptedError extends Error {
  constructor(stage: 'destination-created' | 'first-child-moved') {
    super(stage)
    this.name = 'RestorePublicationInterruptedError'
  }
}

export function restoreIncompleteMarkerPath(runtimeRoot: string) {
  const absoluteRoot = requireAbsolutePath(runtimeRoot, 'runtime-root')
  const identity = createHash('sha256').update(absoluteRoot).digest('hex')
  return join(dirname(absoluteRoot), RESTORE_INCOMPLETE_MARKER_NAME + '-' + identity)
}

export function assertNoIncompleteRestore(databasePath: string) {
  const runtimeRoot = dirname(requireAbsolutePath(databasePath, 'database'))
  if (incompleteRestoreMarkerPresent(runtimeRoot)) throw new NativeSchemaError('RESTORE_INCOMPLETE')
}

export function assertRestoreMarkerAbsent(runtimeRoot: string) {
  if (incompleteRestoreMarkerPresent(runtimeRoot)) throw new NativeBackupError('RESTORE_INCOMPLETE')
}

export function incompleteRestoreMarkerPresent(runtimeRoot: string) {
  const markerPath = restoreIncompleteMarkerPath(runtimeRoot)
  const markerStat = lstatOrUndefined(markerPath)
  return Boolean(markerStat)
}

export async function createRestoreIncompleteMarker(runtimeRoot: string) {
  const markerPath = restoreIncompleteMarkerPath(runtimeRoot)
  assertExistingAncestorsAreNotSymlinks(markerPath)
  const payload = Buffer.from(JSON.stringify({
    format: 'yanxing-restore-incomplete',
    version: 1,
    runtimeRoot: requireAbsolutePath(runtimeRoot, 'runtime-root'),
    createdAt: new Date().toISOString(),
  }) + '\n')
  try {
    const handle = await open(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      let offset = 0
      while (offset < payload.byteLength) {
        const written = await handle.write(payload.subarray(offset))
        offset += written.bytesWritten
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (isExistError(error) || incompleteRestoreMarkerPresent(runtimeRoot)) {
      throw new NativeBackupError('RESTORE_INCOMPLETE')
    }
    throw error
  }
  fsyncDirectory(dirname(markerPath))
  return markerPath
}

export function removeRestoreIncompleteMarker(runtimeRoot: string) {
  const markerPath = restoreIncompleteMarkerPath(runtimeRoot)
  const markerStat = lstatOrUndefined(markerPath)
  if (!markerStat) return
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) throw new NativeBackupError('RESTORE_INCOMPLETE')
  unlinkSync(markerPath)
  fsyncDirectory(dirname(markerPath))
}

function fsyncDirectory(directoryPath: string) {
  const descriptor = openSync(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
