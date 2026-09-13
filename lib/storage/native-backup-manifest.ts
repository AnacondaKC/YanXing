import { NATIVE_SCHEMA_CHECKSUM, NATIVE_SCHEMA_NAME } from '@/lib/db/native-schema'
import { NativeBackupError } from '@/lib/storage/native-backup-error'
import {
  MANIFEST_AUTHENTICATION_MODE,
  MANIFEST_MAC_DOMAIN,
  SETTINGS_KEY_CUSTODY_NOTE,
  authenticateBackupManifest,
  assertRestoreManifestAuthentication,
} from '@/lib/storage/native-backup-key'

export const NATIVE_BACKUP_FORMAT = 'yanxing-native-backup'
export const NATIVE_BACKUP_VERSION = 1
export const FILE_CHECKSUM_KIND = 'sha256-accidental-corruption'
export const FILE_COLLECTIONS = ['reports', 'knowledge', 'branding'] as const

export type NativeBackupFileCollection = typeof FILE_COLLECTIONS[number]

export type NativeBackupFileEntry = {
  collection: NativeBackupFileCollection
  relativePath: string
  sha256: string
  sizeBytes: number
}

export type NativeBackupManifestPayload = {
  format: typeof NATIVE_BACKUP_FORMAT
  version: typeof NATIVE_BACKUP_VERSION
  createdAt: string
  identity: {
    name: string
    checksum: string
    initializedAt: string
  }
  source: {
    databasePath: string
    runtimeRoot: string
    storageRoot: string
    knowledgeRoot: string
    brandingRoot: string
    databaseFileName: string
  }
  database: {
    relativePath: string
    sha256: string
    sizeBytes: number
    pageCount: number
    integrityCheck: 'ok'
    foreignKeyCheck: 'ok'
  }
  files: NativeBackupFileEntry[]
  counts: {
    reports: number
    knowledge: number
    branding: number
    liveReports: number
    tombstoneReports: number
  }
  hasEncryptedSecrets: boolean
  checksumKind: typeof FILE_CHECKSUM_KIND
  custody: typeof SETTINGS_KEY_CUSTODY_NOTE
  authenticationMode: typeof MANIFEST_AUTHENTICATION_MODE
  macDomain: typeof MANIFEST_MAC_DOMAIN
}

export type NativeBackupManifest = NativeBackupManifestPayload & {
  keyVerifier: string
  manifestMac: string
}

export function createNativeBackupManifest(input: {
  payload: NativeBackupManifestPayload
  secret: Buffer
}): NativeBackupManifest {
  assertPayloadIdentity(input.payload)
  if (input.payload.authenticationMode !== MANIFEST_AUTHENTICATION_MODE || input.payload.macDomain !== MANIFEST_MAC_DOMAIN) {
    throw new NativeBackupError('ARCHIVE_INVALID')
  }
  const mac = authenticateBackupManifest(input.payload, input.secret)
  return { ...input.payload, ...mac }
}

export function parseNativeBackupManifest(raw: string, secret: Buffer): NativeBackupManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new NativeBackupError('ARCHIVE_INVALID')
  }
  if (!isRecord(parsed)) throw new NativeBackupError('ARCHIVE_INVALID')
  const keyVerifier = requiredSha256(parsed.keyVerifier)
  const manifestMac = requiredSha256(parsed.manifestMac)
  const payload = asPayload(parsed)
  assertRestoreManifestAuthentication({ payload, keyVerifier, manifestMac, secret })
  assertPayloadIdentity(payload)
  return { ...payload, keyVerifier, manifestMac }
}

export function serializeNativeBackupManifest(manifest: NativeBackupManifest) {
  return JSON.stringify(manifest, null, 2) + '\n'
}

function assertPayloadIdentity(payload: NativeBackupManifestPayload) {
  if (payload.identity.name !== NATIVE_SCHEMA_NAME || payload.identity.checksum !== NATIVE_SCHEMA_CHECKSUM) {
    throw new NativeBackupError('IDENTITY_MISMATCH')
  }
}

function asPayload(value: Record<string, unknown>): NativeBackupManifestPayload {
  if (value.format !== NATIVE_BACKUP_FORMAT || value.version !== NATIVE_BACKUP_VERSION) {
    throw new NativeBackupError('ARCHIVE_INVALID')
  }
  if (value.checksumKind !== FILE_CHECKSUM_KIND || value.custody !== SETTINGS_KEY_CUSTODY_NOTE) {
    throw new NativeBackupError('ARCHIVE_INVALID')
  }
  if (value.authenticationMode !== MANIFEST_AUTHENTICATION_MODE || value.macDomain !== MANIFEST_MAC_DOMAIN) {
    throw new NativeBackupError('ARCHIVE_INVALID')
  }
  if (!isRecord(value.identity) || !isRecord(value.source) || !isRecord(value.database) || !isRecord(value.counts)) {
    throw new NativeBackupError('ARCHIVE_INVALID')
  }
  if (!Array.isArray(value.files)) throw new NativeBackupError('ARCHIVE_INVALID')
  return {
    format: NATIVE_BACKUP_FORMAT,
    version: NATIVE_BACKUP_VERSION,
    createdAt: requiredString(value.createdAt),
    identity: {
      name: requiredString(value.identity.name),
      checksum: requiredString(value.identity.checksum),
      initializedAt: requiredString(value.identity.initializedAt),
    },
    source: {
      databasePath: requiredString(value.source.databasePath),
      runtimeRoot: requiredString(value.source.runtimeRoot),
      storageRoot: requiredString(value.source.storageRoot),
      knowledgeRoot: requiredString(value.source.knowledgeRoot),
      brandingRoot: requiredString(value.source.brandingRoot),
      databaseFileName: requiredString(value.source.databaseFileName),
    },
    database: {
      relativePath: requiredString(value.database.relativePath),
      sha256: requiredSha256(value.database.sha256),
      sizeBytes: requiredByteCount(value.database.sizeBytes),
      pageCount: requiredByteCount(value.database.pageCount),
      integrityCheck: value.database.integrityCheck === 'ok' ? 'ok' : failArchive(),
      foreignKeyCheck: value.database.foreignKeyCheck === 'ok' ? 'ok' : failArchive(),
    },
    files: value.files.map(asFileEntry),
    counts: {
      reports: requiredByteCount(value.counts.reports),
      knowledge: requiredByteCount(value.counts.knowledge),
      branding: requiredByteCount(value.counts.branding),
      liveReports: requiredByteCount(value.counts.liveReports),
      tombstoneReports: requiredByteCount(value.counts.tombstoneReports),
    },
    hasEncryptedSecrets: value.hasEncryptedSecrets === true,
    checksumKind: FILE_CHECKSUM_KIND,
    custody: SETTINGS_KEY_CUSTODY_NOTE,
    authenticationMode: MANIFEST_AUTHENTICATION_MODE,
    macDomain: MANIFEST_MAC_DOMAIN,
  }
}

function asFileEntry(value: unknown): NativeBackupFileEntry {
  if (!isRecord(value)) throw new NativeBackupError('ARCHIVE_INVALID')
  const collection = value.collection
  if (collection !== 'reports' && collection !== 'knowledge' && collection !== 'branding') {
    throw new NativeBackupError('ARCHIVE_INVALID')
  }
  return {
    collection,
    relativePath: requiredString(value.relativePath),
    sha256: requiredSha256(value.sha256),
    sizeBytes: requiredByteCount(value.sizeBytes),
  }
}

function requiredString(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) throw new NativeBackupError('ARCHIVE_INVALID')
  return value
}

function requiredSha256(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new NativeBackupError('ARCHIVE_INVALID')
  return value.toLowerCase()
}

function requiredByteCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NativeBackupError('ARCHIVE_INVALID')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function failArchive(): never {
  throw new NativeBackupError('ARCHIVE_INVALID')
}
