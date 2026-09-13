import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { NATIVE_SCHEMA_CHECKSUM, NATIVE_SCHEMA_NAME, readBoundStorageRoot, readNativeIdentity } from '@/lib/db/native-schema'
import { NativeBackupError } from '@/lib/storage/native-backup-error'
import {
  copyCollectionTree,
  copyRegularFile,
  createBackupStagingDirectory,
  createRestoreStagingDirectory,
  discardStagingDirectory,
  hashRegularFile,
  publishStagedDirectory,
  restoreCollectionFiles,
  syncPath,
} from '@/lib/storage/native-backup-archive'
import {
  FILE_CHECKSUM_KIND,
  NATIVE_BACKUP_FORMAT,
  NATIVE_BACKUP_VERSION,
  createNativeBackupManifest,
  parseNativeBackupManifest,
  serializeNativeBackupManifest,
  type NativeBackupFileEntry,
  type NativeBackupManifest,
  type NativeBackupManifestPayload,
} from '@/lib/storage/native-backup-manifest'
import {
  MANIFEST_AUTHENTICATION_MODE,
  MANIFEST_MAC_DOMAIN,
  SETTINGS_KEY_CUSTODY_NOTE,
  assertEncryptedSecretsMatchKey,
  listEncryptedSecrets,
  requireSettingsKeySecret,
} from '@/lib/storage/native-backup-key'
import {
  REPORTS_DIRECTORY_NAME,
  assertDestinationDoesNotExist,
  assertExistingPathIsDirectory,
  assertExistingPathIsRegularFile,
  assertNotInsideEachOther,
  assertRestoreTargetAbsent,
  lstatOrUndefined,
  posixRelativeToRoot,
  requireAbsolutePath,
  resolveNativeBackupLayout,
  resolvePosixChild,
  type NativeBackupLayout,
} from '@/lib/storage/native-backup-paths'
import { assertSqliteIntegrity, openSqlite, snapshotSqliteToFile, withQuiescentSqliteFence } from '@/lib/storage/native-backup-snapshot'
import {
  BACKUP_COMPLETION_FILE_NAME,
  assertRestoreMarkerAbsent,
  createRestoreIncompleteMarker,
  removeRestoreIncompleteMarker,
} from '@/lib/storage/native-restore-guard'

export { NativeBackupError, isNativeBackupError, NATIVE_BACKUP_ERROR_CODES } from '@/lib/storage/native-backup-error'
export { NATIVE_BACKUP_FORMAT, NATIVE_BACKUP_VERSION } from '@/lib/storage/native-backup-manifest'
export { SETTINGS_KEY_CUSTODY_NOTE }

export type NativePublicationFault = {
  afterDestinationCreated?: () => Promise<void>
  afterFirstChildMoved?: () => Promise<void>
}

export type NativeBackupRequest = {
  databasePath: string
  storageRoot: string
  destination: string
  keyFile?: string
  publicationFault?: NativePublicationFault
}

export type NativeRestoreRequest = {
  archivePath: string
  databasePath: string
  storageRoot: string
  keyFile?: string
  publicationFault?: NativePublicationFault
}

export type NativeBackupResult = {
  action: 'backup'
  destination: string
  manifest: NativeBackupManifest
}

export type NativeRestoreResult = {
  action: 'restore'
  databasePath: string
  storageRoot: string
  runtimeRoot: string
  manifest: NativeBackupManifest
}

export async function backupNativeRuntime(input: NativeBackupRequest): Promise<NativeBackupResult> {
  const layout = resolveNativeBackupLayout(input)
  const destination = requireAbsolutePath(input.destination, 'destination')
  assertExistingPathIsRegularFile(layout.databasePath)
  assertNotInsideEachOther(destination, layout.runtimeRoot)
  assertDestinationDoesNotExist(destination)
  assertRestoreMarkerAbsent(layout.runtimeRoot)
  const secret = requireSettingsKeySecret({
    keyFile: input.keyFile,
    forbiddenRoots: [layout.runtimeRoot, destination],
  })
  const parent = dirname(destination)
  const stagingPath = await createBackupStagingDirectory(parent)
  try {
    const snapshot = await captureBackupSnapshot({ layout, stagingPath, secret })
    const payload = buildManifestPayload({ layout, snapshot })
    const manifest = createNativeBackupManifest({ payload, secret })
    const manifestPath = join(stagingPath, 'MANIFEST.json')
    await writeFile(manifestPath, serializeNativeBackupManifest(manifest), { flag: 'wx', mode: 0o600 })
    syncPath(manifestPath)
    await publishStagedDirectory({
      stagingPath,
      destination,
      completionFileName: BACKUP_COMPLETION_FILE_NAME,
      afterDestinationCreated: input.publicationFault?.afterDestinationCreated,
      afterFirstChildMoved: input.publicationFault?.afterFirstChildMoved,
    })
    return { action: 'backup', destination, manifest }
  } catch (error) {
    await discardStagingDirectory(stagingPath)
    throw error
  }
}

export async function restoreNativeRuntime(input: NativeRestoreRequest): Promise<NativeRestoreResult> {
  const layout = resolveNativeBackupLayout(input)
  const archivePath = requireAbsolutePath(input.archivePath, 'archive')
  assertExistingPathIsDirectory(archivePath)
  assertRestoreTargetsAreAbsent(layout)
  assertRestoreMarkerAbsent(layout.runtimeRoot)
  assertNotInsideEachOther(archivePath, layout.runtimeRoot)
  const secret = requireSettingsKeySecret({
    keyFile: input.keyFile,
    forbiddenRoots: [layout.runtimeRoot, archivePath],
  })
  const manifest = parseNativeBackupManifest(await readManifestText(archivePath), secret)
  assertRestorePathsMatch(layout, manifest)
  await assertArchiveLayout(archivePath, manifest)
  const parent = dirname(layout.runtimeRoot)
  const stagingPath = await createRestoreStagingDirectory(parent)
  try {
    await materializeRuntimeStaging({ archivePath, stagingPath, layout, manifest })
    await validateStagedRuntime({ stagingPath, layout, manifest, secret })
    await createRestoreIncompleteMarker(layout.runtimeRoot)
    await publishStagedDirectory({
      stagingPath,
      destination: layout.runtimeRoot,
      afterDestinationCreated: input.publicationFault?.afterDestinationCreated,
      afterFirstChildMoved: input.publicationFault?.afterFirstChildMoved,
    })
    removeRestoreIncompleteMarker(layout.runtimeRoot)
    return {
      action: 'restore',
      databasePath: layout.databasePath,
      storageRoot: layout.storageRoot,
      runtimeRoot: layout.runtimeRoot,
      manifest,
    }
  } catch (error) {
    await discardStagingDirectory(stagingPath)
    throw error
  }
}

async function captureBackupSnapshot(input: {
  layout: NativeBackupLayout
  stagingPath: string
  secret: Buffer
}) {
  const databaseDir = join(input.stagingPath, 'database')
  const filesRoot = join(input.stagingPath, 'files')
  return withQuiescentSqliteFence({
    databasePath: input.layout.databasePath,
    storageRoot: input.layout.storageRoot,
    whileHeld: async (reader) => {
      assertEncryptedSecretsMatchKey(reader, input.secret)
      await mkdir(databaseDir, { recursive: true, mode: 0o700 })
      const sqliteDestination = join(databaseDir, input.layout.databaseFileName)
      const pageCount = await snapshotSqliteToFile({
        reader,
        destinationFile: sqliteDestination,
        storageRoot: input.layout.storageRoot,
      })
      const reports = await copyCollectionTree({
        sourceRoot: input.layout.storageRoot,
        destinationRoot: join(filesRoot, 'reports'),
        collection: 'reports',
      })
      const knowledge = await copyCollectionTree({
        sourceRoot: input.layout.knowledgeRoot,
        destinationRoot: join(filesRoot, 'knowledge'),
        collection: 'knowledge',
      })
      const branding = await copyCollectionTree({
        sourceRoot: input.layout.brandingRoot,
        destinationRoot: join(filesRoot, 'branding'),
        collection: 'branding',
      })
      const files = [...reports, ...knowledge, ...branding]
      assertReferencedFileIdentities(reader, input.layout, files)
      const databaseHash = await hashRegularFile(sqliteDestination)
      return {
        identity: requireIdentity(reader),
        boundRoot: requireBoundRoot(reader),
        pageCount,
        files,
        databaseHash,
        liveReports: countLiveReports(reader),
        tombstoneReports: countTombstoneReports(reader),
        hasEncryptedSecrets: listEncryptedSecrets(reader).length > 0,
      }
    },
  })
}

function buildManifestPayload(input: {
  layout: NativeBackupLayout
  snapshot: Awaited<ReturnType<typeof captureBackupSnapshot>>
}): NativeBackupManifestPayload {
  if (input.snapshot.boundRoot !== input.layout.storageRoot) throw new NativeBackupError('STORAGE_ROOT_MISMATCH')
  return {
    format: NATIVE_BACKUP_FORMAT,
    version: NATIVE_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    identity: {
      name: input.snapshot.identity.name,
      checksum: input.snapshot.identity.checksum,
      initializedAt: input.snapshot.identity.initializedAt,
    },
    source: {
      databasePath: input.layout.databasePath,
      runtimeRoot: input.layout.runtimeRoot,
      storageRoot: input.layout.storageRoot,
      knowledgeRoot: input.layout.knowledgeRoot,
      brandingRoot: input.layout.brandingRoot,
      databaseFileName: input.layout.databaseFileName,
    },
    database: {
      relativePath: 'database/' + input.layout.databaseFileName,
      sha256: input.snapshot.databaseHash.sha256,
      sizeBytes: input.snapshot.databaseHash.sizeBytes,
      pageCount: input.snapshot.pageCount,
      integrityCheck: 'ok',
      foreignKeyCheck: 'ok',
    },
    files: input.snapshot.files,
    counts: {
      reports: countCollection(input.snapshot.files, 'reports'),
      knowledge: countCollection(input.snapshot.files, 'knowledge'),
      branding: countCollection(input.snapshot.files, 'branding'),
      liveReports: input.snapshot.liveReports,
      tombstoneReports: input.snapshot.tombstoneReports,
    },
    hasEncryptedSecrets: input.snapshot.hasEncryptedSecrets,
    checksumKind: FILE_CHECKSUM_KIND,
    custody: SETTINGS_KEY_CUSTODY_NOTE,
    authenticationMode: MANIFEST_AUTHENTICATION_MODE,
    macDomain: MANIFEST_MAC_DOMAIN,
  }
}

async function materializeRuntimeStaging(input: {
  archivePath: string
  stagingPath: string
  layout: NativeBackupLayout
  manifest: NativeBackupManifest
}) {
  await mkdir(join(input.stagingPath, REPORTS_DIRECTORY_NAME), { recursive: true, mode: 0o700 })
  const archiveDatabase = join(input.archivePath, 'database', input.layout.databaseFileName)
  const stagedDatabase = join(input.stagingPath, input.layout.databaseFileName)
  const copied = await copyRegularFile(archiveDatabase, stagedDatabase)
  if (copied.sha256 !== input.manifest.database.sha256 || copied.sizeBytes !== input.manifest.database.sizeBytes) {
    throw new NativeBackupError('TAMPERED_ARCHIVE')
  }
  await restoreCollectionFiles({
    archiveCollectionRoot: join(input.archivePath, 'files', 'reports'),
    destinationRoot: join(input.stagingPath, REPORTS_DIRECTORY_NAME),
    collection: 'reports',
    expected: input.manifest.files,
  })
  await restoreCollectionFiles({
    archiveCollectionRoot: join(input.archivePath, 'files', 'knowledge'),
    destinationRoot: join(input.stagingPath, 'knowledge'),
    collection: 'knowledge',
    expected: input.manifest.files,
  })
  await restoreCollectionFiles({
    archiveCollectionRoot: join(input.archivePath, 'files', 'branding'),
    destinationRoot: join(input.stagingPath, 'branding'),
    collection: 'branding',
    expected: input.manifest.files,
  })
}

async function validateStagedRuntime(input: {
  stagingPath: string
  layout: NativeBackupLayout
  manifest: NativeBackupManifest
  secret: Buffer
}) {
  const stagedDatabase = join(input.stagingPath, input.layout.databaseFileName)
  const database = openSqlite(stagedDatabase, true)
  try {
    assertSqliteIntegrity(database)
    const identity = requireIdentity(database)
    if (identity.name !== NATIVE_SCHEMA_NAME || identity.checksum !== NATIVE_SCHEMA_CHECKSUM) {
      throw new NativeBackupError('IDENTITY_MISMATCH')
    }
    if (identity.checksum !== input.manifest.identity.checksum || identity.name !== input.manifest.identity.name) {
      throw new NativeBackupError('IDENTITY_MISMATCH')
    }
    const boundRoot = requireBoundRoot(database)
    if (boundRoot !== input.layout.storageRoot || boundRoot !== input.manifest.source.storageRoot) {
      throw new NativeBackupError('STORAGE_ROOT_MISMATCH')
    }
    assertEncryptedSecretsMatchKey(database, input.secret)
    assertReferencedFileIdentities(database, input.layout, input.manifest.files)
  } finally {
    database.close()
  }
}

function assertRestorePathsMatch(layout: NativeBackupLayout, manifest: NativeBackupManifest) {
  if (
    layout.databasePath !== manifest.source.databasePath
    || layout.runtimeRoot !== manifest.source.runtimeRoot
    || layout.storageRoot !== manifest.source.storageRoot
    || layout.databaseFileName !== manifest.source.databaseFileName
  ) {
    throw new NativeBackupError('PATH_MISMATCH')
  }
}

function assertRestoreTargetsAreAbsent(layout: NativeBackupLayout) {
  assertRestoreTargetAbsent(layout.runtimeRoot)
  assertRestoreTargetAbsent(layout.databasePath)
  assertRestoreTargetAbsent(layout.storageRoot)
}

async function assertArchiveLayout(archivePath: string, manifest: NativeBackupManifest) {
  const names = await readdir(archivePath)
  for (const name of names) {
    if (name !== 'MANIFEST.json' && name !== 'database' && name !== 'files') {
      throw new NativeBackupError('ARCHIVE_INVALID', name)
    }
    const fullPath = join(archivePath, name)
    const stat = lstatOrUndefined(fullPath)
    if (stat?.isSymbolicLink()) throw new NativeBackupError('SYMLINK_REJECTED', fullPath)
  }
  const manifestStat = lstatOrUndefined(join(archivePath, 'MANIFEST.json'))
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new NativeBackupError('ARCHIVE_INVALID')
  assertExistingPathIsDirectory(join(archivePath, 'database'))
  assertExistingPathIsDirectory(join(archivePath, 'files'))
  const databaseNames = await readdir(join(archivePath, 'database'))
  if (databaseNames.length !== 1 || databaseNames[0] !== manifest.source.databaseFileName) {
    throw new NativeBackupError('ARCHIVE_INVALID')
  }
}

async function readManifestText(archivePath: string) {
  const manifestPath = join(archivePath, 'MANIFEST.json')
  const manifestStat = lstatOrUndefined(manifestPath)
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new NativeBackupError('ARCHIVE_INVALID')
  const hashed = await hashRegularFile(manifestPath)
  if (hashed.sizeBytes < 2) throw new NativeBackupError('ARCHIVE_INVALID')
  return readFile(manifestPath, 'utf8')
}

function assertReferencedFileIdentities(database: DatabaseSync, layout: NativeBackupLayout, files: NativeBackupFileEntry[]) {
  const present = new Map(files.map((entry) => [entry.collection + ':' + entry.relativePath, entry]))
  const reports = database.prepare(
    'SELECT source_key AS sourceKey, file_hash AS fileHash, source_size AS sourceSize FROM report_submissions',
  ).all() as Array<{ sourceKey?: unknown; fileHash?: unknown; sourceSize?: unknown }>
  for (const row of reports) {
    if (typeof row.sourceKey !== 'string' || !row.sourceKey) throw new NativeBackupError('MISSING_FILE')
    const sourceKey = row.sourceKey
    const absolutePath = resolvePosixChild(layout.storageRoot, sourceKey.replaceAll('\\', '/'))
    const relativePath = posixRelativeToRoot(layout.storageRoot, absolutePath)
    const entry = present.get('reports:' + relativePath)
    if (!entry) throw new NativeBackupError('MISSING_FILE', sourceKey)
    assertStoredFileIdentity(entry, row.fileHash, row.sourceSize)
  }
  const knowledge = database.prepare(
    'SELECT source_path AS sourcePath, file_hash AS fileHash, file_size AS fileSize FROM knowledge_items',
  ).all() as Array<{ sourcePath?: unknown; fileHash?: unknown; fileSize?: unknown }>
  for (const row of knowledge) {
    if (typeof row.sourcePath !== 'string' || !row.sourcePath) throw new NativeBackupError('MISSING_FILE')
    const relativePath = knowledgeRelativePath(layout, row.sourcePath)
    const entry = present.get('knowledge:' + relativePath)
    if (!entry) throw new NativeBackupError('MISSING_FILE', row.sourcePath)
    assertStoredFileIdentity(entry, row.fileHash, row.fileSize)
  }
}

function knowledgeRelativePath(layout: NativeBackupLayout, sourcePath: string) {
  try {
    return posixRelativeToRoot(layout.knowledgeRoot, sourcePath)
  } catch {
    throw new NativeBackupError('UNMANAGED_PATH', sourcePath)
  }
}

function assertStoredFileIdentity(entry: NativeBackupFileEntry, fileHash: unknown, sizeBytes: unknown) {
  if (entry.sha256 !== requiredSha256(fileHash) || entry.sizeBytes !== requiredNonNegativeInteger(sizeBytes)) {
    throw new NativeBackupError('SOURCE_INTEGRITY')
  }
}

function requiredSha256(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new NativeBackupError('SOURCE_INTEGRITY')
  return value.toLowerCase()
}

function requiredNonNegativeInteger(value: unknown) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new NativeBackupError('SOURCE_INTEGRITY')
    return Number(value)
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) return value
  throw new NativeBackupError('SOURCE_INTEGRITY')
}

function countLiveReports(database: DatabaseSync) {
  return Number((database.prepare('SELECT COUNT(*) AS n FROM report_submissions WHERE deleted_at IS NULL').get() as { n: number }).n)
}

function countTombstoneReports(database: DatabaseSync) {
  return Number((database.prepare('SELECT COUNT(*) AS n FROM report_submissions WHERE deleted_at IS NOT NULL').get() as { n: number }).n)
}

function requireIdentity(database: DatabaseSync) {
  const identity = readNativeIdentity(database)
  if (!identity) throw new NativeBackupError('INCOMPATIBLE_DATABASE')
  return identity
}

function requireBoundRoot(database: DatabaseSync) {
  const boundRoot = readBoundStorageRoot(database)
  if (!boundRoot) throw new NativeBackupError('STORAGE_ROOT_MISMATCH')
  return boundRoot
}

function countCollection(files: NativeBackupFileEntry[], collection: NativeBackupFileEntry['collection']) {
  return files.filter((entry) => entry.collection === collection).length
}
