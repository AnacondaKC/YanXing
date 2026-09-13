import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { runtimeConfig } from '@/lib/config/environment'
import { decryptSecretWithSecret, deriveSettingsEncryptionKey } from '@/lib/db/settings-crypto'
import { NativeBackupError } from '@/lib/storage/native-backup-error'
import { assertExistingPathIsRegularFile, requireAbsolutePath } from '@/lib/storage/native-backup-paths'
import { isPathWithinRoot } from '@/lib/storage/path-containment'

export const MANIFEST_AUTHENTICATION_MODE = 'hmac-sha256-scrypt-v2'
export const MANIFEST_MAC_DOMAIN = 'yanxing-native-backup-manifest-v1'
export const SETTINGS_KEY_CUSTODY_NOTE = [
  '设置主密钥不得写入归档或清单。',
  '--key-file 必须是运行根、归档和目标之外单独保管的绝对路径。',
  '--key-file 按原始字节读取；请用 printf 写入以免尾随换行，环境变量按 UTF-8。',
  '文件 SHA-256 只检测意外损坏。',
  '清单始终使用提供的设置密钥做 HMAC；恢复必须用同一密钥校验。',
  '若库中有加密模型密钥，备份和恢复都会用该密钥实际解密密文。',
].join('')

const KEY_VERIFIER_DOMAIN = 'yanxing-native-backup-key-verify-v1'

export type ManifestMacFields = {
  keyVerifier: string
  manifestMac: string
}

export function requireSettingsKeySecret(input: { keyFile?: string; forbiddenRoots?: string[] }) {
  if (input.keyFile) {
    const keyFile = requireAbsolutePath(input.keyFile, 'key-file')
    assertExistingPathIsRegularFile(keyFile)
    assertKeyFileOutsideRoots(keyFile, input.forbiddenRoots ?? [])
    return readFileSync(keyFile)
  }
  const configured = runtimeConfig.settingsEncryptionKey
  if (configured) return Buffer.from(configured, 'utf8')
  throw new NativeBackupError('KEY_REQUIRED')
}

function assertKeyFileOutsideRoots(keyFile: string, roots: string[]) {
  for (const root of roots) {
    const resolvedRoot = requireAbsolutePath(root, 'key-file')
    if (keyFile === resolvedRoot || isPathWithinRoot(resolvedRoot, keyFile)) {
      throw new NativeBackupError('MASTER_KEY_FORBIDDEN')
    }
  }
}

export function authenticateBackupManifest(payload: unknown, secret: Buffer): ManifestMacFields {
  const derived = deriveSettingsEncryptionKey(secret)
  return {
    keyVerifier: hmacHex(derived, KEY_VERIFIER_DOMAIN),
    manifestMac: hmacHex(derived, MANIFEST_MAC_DOMAIN + canonicalJson(payload)),
  }
}

export function assertRestoreManifestAuthentication(input: {
  payload: unknown
  keyVerifier: string
  manifestMac: string
  secret: Buffer
}) {
  const derived = deriveSettingsEncryptionKey(input.secret)
  const keyVerifier = hmacHex(derived, KEY_VERIFIER_DOMAIN)
  if (!safeEqualHex(keyVerifier, input.keyVerifier)) throw new NativeBackupError('KEY_MISMATCH')
  const manifestMac = hmacHex(derived, MANIFEST_MAC_DOMAIN + canonicalJson(input.payload))
  if (!safeEqualHex(manifestMac, input.manifestMac)) throw new NativeBackupError('TAMPERED_ARCHIVE')
}

export function assertEncryptedSecretsMatchKey(database: DatabaseSync, secret: Buffer) {
  for (const ciphertext of listEncryptedSecrets(database)) {
    try {
      decryptSecretWithSecret(ciphertext, secret)
    } catch {
      throw new NativeBackupError('KEY_MISMATCH')
    }
  }
}

export function listEncryptedSecrets(database: DatabaseSync) {
  const channels = database.prepare(
    "SELECT api_key_encrypted AS value FROM ai_model_channels WHERE api_key_encrypted IS NOT NULL AND length(trim(api_key_encrypted)) > 0",
  ).all() as Array<{ value?: unknown }>
  const frozen = database.prepare(
    "SELECT json_extract(frozen_json, '$.modelRuntime.apiKeyEncrypted') AS value FROM submission_tasks WHERE json_extract(frozen_json, '$.modelRuntime.apiKeyEncrypted') IS NOT NULL AND length(trim(json_extract(frozen_json, '$.modelRuntime.apiKeyEncrypted'))) > 0",
  ).all() as Array<{ value?: unknown }>
  return [...channels, ...frozen]
    .map((row) => row.value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key])
    return sorted
  }
  return value
}

function hmacHex(key: Buffer, message: string) {
  return createHmac('sha256', key).update(message).digest('hex')
}

function safeEqualHex(left: string, right: string) {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right) || left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}
