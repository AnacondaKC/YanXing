import { lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runtimeConfig } from '@/lib/config/environment'
import { NativeBackupError } from '@/lib/storage/native-backup-error'
import { isPathWithinRoot } from '@/lib/storage/path-containment'

export const REPORTS_DIRECTORY_NAME = 'reports'
export const KNOWLEDGE_DIRECTORY_NAME = 'knowledge'
export const BRANDING_DIRECTORY_NAME = 'branding'
export const TEMPORARY_DIRECTORY_NAME = 'tmp'
export const LOCAL_SETTINGS_KEY_FILE_NAME = '.settings-key'
export const BACKUP_STAGING_PREFIX = '.yanxing-backup-staging-'
export const RESTORE_STAGING_PREFIX = '.yanxing-restore-staging-'

export type NativeBackupLayout = {
  databasePath: string
  databaseFileName: string
  runtimeRoot: string
  storageRoot: string
  knowledgeRoot: string
  brandingRoot: string
  temporaryRoot: string
}

export function requireAbsolutePath(value: string | undefined, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new NativeBackupError('EXPLICIT_PATH_REQUIRED', label)
  }
  const trimmed = value.trim()
  if (!isAbsolute(trimmed)) throw new NativeBackupError('PATH_NOT_ABSOLUTE', label)
  if (trimmed.includes('\0') || hasDotSegment(trimmed)) throw new NativeBackupError('PATH_TRAVERSAL', label)
  return resolve(trimmed)
}

export function resolveNativeBackupLayout(input: { databasePath: string; storageRoot: string }): NativeBackupLayout {
  const databasePath = requireAbsolutePath(input.databasePath, 'database')
  const storageRoot = requireAbsolutePath(input.storageRoot, 'storage-root')
  const runtimeRoot = dirname(databasePath)
  const databaseFileName = basename(databasePath)
  if (!databaseFileName || databaseFileName === '.' || databaseFileName === '..') {
    throw new NativeBackupError('LAYOUT_INVALID')
  }
  if (resolve(runtimeRoot, REPORTS_DIRECTORY_NAME) !== storageRoot) {
    throw new NativeBackupError('LAYOUT_INVALID')
  }
  const layout = {
    databasePath,
    databaseFileName,
    runtimeRoot,
    storageRoot,
    knowledgeRoot: join(runtimeRoot, KNOWLEDGE_DIRECTORY_NAME),
    brandingRoot: join(runtimeRoot, BRANDING_DIRECTORY_NAME),
    temporaryRoot: join(runtimeRoot, TEMPORARY_DIRECTORY_NAME),
  }
  assertManagedKnowledgeLayout(layout)
  return layout
}

export function assertManagedKnowledgeLayout(layout: NativeBackupLayout) {
  const configured = runtimeConfig.knowledgeStorageRoot
  if (configured && resolve(configured) !== layout.knowledgeRoot) {
    throw new NativeBackupError('UNMANAGED_PATH', configured)
  }
}

export function assertExistingPathIsRegularFile(path: string) {
  const fileStat = lstatOrUndefined(path)
  if (!fileStat) throw new NativeBackupError('SOURCE_MISSING', path)
  if (fileStat.isSymbolicLink()) throw new NativeBackupError('SYMLINK_REJECTED', path)
  if (!fileStat.isFile()) throw new NativeBackupError('UNSUPPORTED_FILE_TYPE', path)
  assertExistingAncestorsAreNotSymlinks(path)
}

export function assertExistingPathIsDirectory(path: string) {
  const directoryStat = lstatOrUndefined(path)
  if (!directoryStat) throw new NativeBackupError('SOURCE_MISSING', path)
  if (directoryStat.isSymbolicLink()) throw new NativeBackupError('SYMLINK_REJECTED', path)
  if (!directoryStat.isDirectory()) throw new NativeBackupError('UNSUPPORTED_FILE_TYPE', path)
  assertExistingAncestorsAreNotSymlinks(path)
}

export function assertDestinationDoesNotExist(path: string) {
  assertExistingAncestorsAreNotSymlinks(path)
  if (lstatOrUndefined(path)) throw new NativeBackupError('DESTINATION_EXISTS')
}

export function assertRestoreTargetAbsent(path: string) {
  assertExistingAncestorsAreNotSymlinks(path)
  if (lstatOrUndefined(path)) throw new NativeBackupError('TARGET_OCCUPIED')
}

export function assertExistingAncestorsAreNotSymlinks(absolutePath: string) {
  let current = absolutePath
  while (true) {
    const currentStat = lstatOrUndefined(current)
    if (currentStat?.isSymbolicLink()) throw new NativeBackupError('SYMLINK_REJECTED', current)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

export function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (isAbsentPathError(error)) return undefined
    throw error
  }
}

export function isAbsentPathError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
}

export function isExistError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

export function assertNotInsideEachOther(left: string, right: string) {
  if (left === right || isPathWithinRoot(left, right) || isPathWithinRoot(right, left)) {
    throw new NativeBackupError('LAYOUT_INVALID')
  }
}

export function posixRelativeToRoot(root: string, filePath: string) {
  if (!isPathWithinRoot(root, filePath)) throw new NativeBackupError('PATH_TRAVERSAL', filePath)
  const relativePath = relative(root, filePath).split(sep).join('/')
  if (!relativePath || relativePath === '.' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new NativeBackupError('PATH_TRAVERSAL', filePath)
  }
  if (relativePath.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw new NativeBackupError('PATH_TRAVERSAL', filePath)
  }
  return relativePath
}

export function resolvePosixChild(root: string, relativePath: string) {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new NativeBackupError('PATH_TRAVERSAL', relativePath)
  }
  const segments = relativePath.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw new NativeBackupError('PATH_TRAVERSAL', relativePath)
  }
  const resolved = resolve(root, ...segments)
  if (!isPathWithinRoot(root, resolved)) throw new NativeBackupError('PATH_TRAVERSAL', relativePath)
  return resolved
}

export function isForbiddenArchiveFileName(fileName: string) {
  return fileName === LOCAL_SETTINGS_KEY_FILE_NAME
    || fileName.endsWith('.sqlite-wal')
    || fileName.endsWith('.sqlite-shm')
    || /\.sqlite$/i.test(fileName)
}

function hasDotSegment(value: string) {
  return value.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..')
}
