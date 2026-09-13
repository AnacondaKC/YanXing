import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, openSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { NativeBackupError } from '@/lib/storage/native-backup-error'
import {
  BACKUP_STAGING_PREFIX,
  RESTORE_STAGING_PREFIX,
  assertExistingAncestorsAreNotSymlinks,
  assertExistingPathIsDirectory,
  isExistError,
  isForbiddenArchiveFileName,
  lstatOrUndefined,
  posixRelativeToRoot,
  resolvePosixChild,
} from '@/lib/storage/native-backup-paths'
import type { NativeBackupFileCollection, NativeBackupFileEntry } from '@/lib/storage/native-backup-manifest'

const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

export async function createBackupStagingDirectory(parent: string) {
  return createExclusiveStagingDirectory(parent, BACKUP_STAGING_PREFIX)
}

export async function createRestoreStagingDirectory(parent: string) {
  return createExclusiveStagingDirectory(parent, RESTORE_STAGING_PREFIX)
}

export async function publishStagedDirectory(input: {
  stagingPath: string
  destination: string
  completionFileName?: string
  afterDestinationCreated?: () => Promise<void>
  afterFirstChildMoved?: () => Promise<void>
}) {
  const occupiedCode = stagingOccupiedCode(input.stagingPath)
  assertExistingAncestorsAreNotSymlinks(input.destination)
  await syncTreeBottomUp(input.stagingPath)
  try {
    await mkdir(input.destination, { mode: DIRECTORY_MODE })
  } catch (error) {
    if (isExistError(error)) throw new NativeBackupError(occupiedCode)
    throw error
  }
  if (input.afterDestinationCreated) await input.afterDestinationCreated()
  const names = orderPublicationNames(await readdir(input.stagingPath), input.completionFileName)
  for (const [index, name] of names.entries()) {
    await rename(join(input.stagingPath, name), join(input.destination, name))
    if (index === 0 && input.afterFirstChildMoved) await input.afterFirstChildMoved()
  }
  await rm(input.stagingPath, { recursive: true, force: true })
  syncPath(input.destination)
  syncPath(dirname(input.destination))
}

function orderPublicationNames(names: string[], completionFileName?: string) {
  if (!completionFileName || !names.includes(completionFileName)) return names
  return [...names.filter((name) => name !== completionFileName), completionFileName]
}

export async function discardStagingDirectory(stagingPath: string) {
  const baseName = stagingPath.split('/').pop() ?? ''
  if (!baseName.startsWith(BACKUP_STAGING_PREFIX) && !baseName.startsWith(RESTORE_STAGING_PREFIX)) {
    throw new NativeBackupError('LAYOUT_INVALID')
  }
  await rm(stagingPath, { recursive: true, force: true })
}

export async function copyCollectionTree(input: {
  sourceRoot: string
  destinationRoot: string
  collection: NativeBackupFileCollection
}): Promise<NativeBackupFileEntry[]> {
  const sourceStat = lstatOrUndefined(input.sourceRoot)
  if (!sourceStat) return []
  if (sourceStat.isSymbolicLink()) throw new NativeBackupError('SYMLINK_REJECTED', input.sourceRoot)
  if (!sourceStat.isDirectory()) throw new NativeBackupError('UNSUPPORTED_FILE_TYPE', input.sourceRoot)
  assertExistingPathIsDirectory(input.sourceRoot)
  await mkdir(input.destinationRoot, { recursive: true, mode: DIRECTORY_MODE })
  const entries: NativeBackupFileEntry[] = []
  await walkAndCopy(input.sourceRoot, input.sourceRoot, input.destinationRoot, input.collection, entries)
  return entries
}

export async function restoreCollectionFiles(input: {
  archiveCollectionRoot: string
  destinationRoot: string
  collection: NativeBackupFileCollection
  expected: NativeBackupFileEntry[]
}) {
  await mkdir(input.destinationRoot, { recursive: true, mode: DIRECTORY_MODE })
  const copied = await copyCollectionTree({
    sourceRoot: input.archiveCollectionRoot,
    destinationRoot: input.destinationRoot,
    collection: input.collection,
  })
  assertFileSetMatches(copied, input.expected.filter((entry) => entry.collection === input.collection))
}

export async function hashRegularFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new NativeBackupError('UNSUPPORTED_FILE_TYPE', path)
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    return { sha256: hash.digest('hex'), sizeBytes: stat.size }
  } finally {
    await handle.close()
  }
}

export async function copyRegularFile(source: string, destination: string) {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const sourceStat = await sourceHandle.stat()
    if (!sourceStat.isFile()) throw new NativeBackupError('UNSUPPORTED_FILE_TYPE', source)
    await mkdir(dirname(destination), { recursive: true, mode: DIRECTORY_MODE })
    const destinationHandle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE)
    try {
      const hash = createHash('sha256')
      let copiedBytes = 0
      for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
        const bytes = toBytes(chunk)
        hash.update(bytes)
        await writeAll(destinationHandle, bytes)
        copiedBytes += bytes.byteLength
      }
      const afterStat = await sourceHandle.stat()
      if (!afterStat.isFile() || afterStat.size !== sourceStat.size || copiedBytes !== sourceStat.size) {
        throw new NativeBackupError('UNSUPPORTED_FILE_TYPE', source)
      }
      await destinationHandle.sync()
      return { sha256: hash.digest('hex'), sizeBytes: copiedBytes }
    } finally {
      await destinationHandle.close()
    }
  } finally {
    await sourceHandle.close()
  }
}

export function syncPath(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export async function syncTreeBottomUp(root: string) {
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink()) throw new NativeBackupError('SYMLINK_REJECTED', root)
  if (rootStat.isDirectory()) {
    const names = await readdir(root)
    for (const name of names) await syncTreeBottomUp(join(root, name))
    syncPath(root)
    return
  }
  if (!rootStat.isFile()) throw new NativeBackupError('UNSUPPORTED_FILE_TYPE', root)
  syncPath(root)
}

function assertFileSetMatches(actual: NativeBackupFileEntry[], expected: NativeBackupFileEntry[]) {
  if (actual.length !== expected.length) throw new NativeBackupError('TAMPERED_ARCHIVE')
  const expectedByPath = new Map(expected.map((entry) => [entry.collection + ':' + entry.relativePath, entry]))
  for (const entry of actual) {
    const matched = expectedByPath.get(entry.collection + ':' + entry.relativePath)
    if (!matched || matched.sha256 !== entry.sha256 || matched.sizeBytes !== entry.sizeBytes) {
      throw new NativeBackupError('TAMPERED_ARCHIVE')
    }
  }
}

async function walkAndCopy(
  collectionRoot: string,
  currentDirectory: string,
  destinationRoot: string,
  collection: NativeBackupFileCollection,
  entries: NativeBackupFileEntry[],
) {
  const dirents = await readdir(currentDirectory, { withFileTypes: true })
  for (const dirent of dirents) {
    const sourcePath = join(currentDirectory, dirent.name)
    const sourceStat = lstatOrUndefined(sourcePath)
    if (!sourceStat) throw new NativeBackupError('SOURCE_MISSING', sourcePath)
    if (sourceStat.isSymbolicLink() || dirent.isSymbolicLink()) throw new NativeBackupError('SYMLINK_REJECTED', sourcePath)
    if (isForbiddenArchiveFileName(dirent.name)) throw new NativeBackupError('MASTER_KEY_FORBIDDEN', dirent.name)
    if (sourceStat.isDirectory()) {
      await walkAndCopy(collectionRoot, sourcePath, destinationRoot, collection, entries)
      continue
    }
    if (!sourceStat.isFile()) throw new NativeBackupError('UNSUPPORTED_FILE_TYPE', sourcePath)
    const relativePath = posixRelativeToRoot(collectionRoot, sourcePath)
    const destination = resolvePosixChild(destinationRoot, relativePath)
    const copied = await copyRegularFile(sourcePath, destination)
    entries.push({ collection, relativePath, sha256: copied.sha256, sizeBytes: copied.sizeBytes })
  }
}

async function createExclusiveStagingDirectory(parent: string, prefix: string) {
  assertExistingPathIsDirectory(parent)
  const stagingPath = join(parent, prefix + randomUUID())
  assertExistingAncestorsAreNotSymlinks(stagingPath)
  await mkdir(stagingPath, { mode: DIRECTORY_MODE })
  return stagingPath
}

function stagingOccupiedCode(stagingPath: string): 'TARGET_OCCUPIED' | 'DESTINATION_EXISTS' {
  const baseName = stagingPath.split('/').pop() ?? ''
  return baseName.startsWith(RESTORE_STAGING_PREFIX) ? 'TARGET_OCCUPIED' : 'DESTINATION_EXISTS'
}

async function writeAll(handle: FileHandle, chunk: Uint8Array) {
  let offset = 0
  while (offset < chunk.byteLength) {
    const written = await handle.write(chunk.subarray(offset))
    offset += written.bytesWritten
  }
}

function toBytes(chunk: string | Buffer | Uint8Array) {
  return typeof chunk === 'string' ? Buffer.from(chunk) : chunk
}
