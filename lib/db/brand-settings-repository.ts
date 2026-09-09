import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_BRAND_SETTINGS,
  DEFAULT_HEADER_LOGO_URL,
  DEFAULT_LOGIN_WATERMARK_URL,
  MAX_BRAND_ASSET_BYTES,
  normalizeBrandDisplayText,
  type BrandAssetKind,
  type BrandImageChange,
  type BrandImageMimeType,
  type BrandSettingsInput,
  type PublicBrandSettings,
} from '@/lib/branding'
import { getDatabase, inImmediateTransaction } from '@/lib/db/client'

type BrandSettingsRow = {
  display_text: string
  header_logo: Uint8Array | null
  header_logo_mime: string | null
  login_watermark: Uint8Array | null
  login_watermark_mime: string | null
  revision: number
  updated_at: string | null
  updated_by: string | null
}

export interface StoredBrandAsset {
  bytes: Uint8Array
  mimeType: BrandImageMimeType
  revision: number
  etag: string
}

export class BrandSettingsRevisionConflictError extends Error {
  constructor(readonly actualRevision: number) {
    super('品牌设置已被其他管理员更新，请重新加载后再保存。')
    this.name = 'BrandSettingsRevisionConflictError'
  }
}

export class BrandSettingsAccessError extends Error {
  constructor() {
    super('需要有效的管理员权限。')
    this.name = 'BrandSettingsAccessError'
  }
}

export function getPublicBrandSettings(database: DatabaseSync = getDatabase()): PublicBrandSettings {
  const row = readBrandSettingsRow(database)
  return {
    displayText: row.display_text,
    headerLogoUrl: row.header_logo
      ? '/api/branding/assets/header-logo?v=' + row.revision
      : DEFAULT_HEADER_LOGO_URL,
    loginWatermarkUrl: row.login_watermark
      ? '/api/branding/assets/login-watermark?v=' + row.revision
      : DEFAULT_LOGIN_WATERMARK_URL,
    revision: row.revision,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

// Page decoration may fall back; APIs and writes must keep strict validation.
export function getPublicBrandSettingsOrDefault(database?: DatabaseSync): PublicBrandSettings {
  try {
    return getPublicBrandSettings(database)
  } catch (error) {
    console.error('[yanxing-branding] 品牌设置读取失败，页面使用默认品牌。', error)
    return { ...DEFAULT_BRAND_SETTINGS }
  }
}

export function getStoredBrandAsset(kind: BrandAssetKind, database: DatabaseSync = getDatabase()): StoredBrandAsset | null {
  const row = readBrandSettingsRow(database)
  const bytes = kind === 'header-logo' ? row.header_logo : row.login_watermark
  const mimeType = kind === 'header-logo' ? row.header_logo_mime : row.login_watermark_mime
  if (!bytes || !isBrandImageMimeType(mimeType)) return null
  return {
    bytes,
    mimeType,
    revision: row.revision,
    etag: '"brand-' + kind + '-' + createHash('sha256').update(bytes).digest('hex').slice(0, 20) + '"',
  }
}

export function saveBrandSettings(input: {
  revision: number
  settings: BrandSettingsInput
  actorId: string
}): PublicBrandSettings {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('品牌设置版本无效。')
  const displayText = normalizeBrandDisplayText(input.settings.displayText)
  if (!displayText) throw new Error('品牌文字须为 1 至 60 个字符，最多两行。')
  const headerLogo = decodeBrandImageChange(input.settings.headerLogo)
  const loginWatermark = decodeBrandImageChange(input.settings.loginWatermark)

  return inImmediateTransaction((database) => {
    const actor = database.prepare("SELECT display_name, username FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(input.actorId) as { display_name?: string; username?: string } | undefined
    if (!actor) throw new BrandSettingsAccessError()
    const current = readBrandSettingsRow(database)
    if (current.revision !== input.revision) throw new BrandSettingsRevisionConflictError(current.revision)
    const revision = current.revision + 1
    if (!Number.isSafeInteger(revision)) throw new Error('品牌设置版本已达到上限。')

    const nextHeader = resolveAssetChange(headerLogo, current.header_logo, current.header_logo_mime)
    const nextWatermark = resolveAssetChange(loginWatermark, current.login_watermark, current.login_watermark_mime)
    database.prepare(`
      UPDATE brand_settings
      SET display_text = ?, header_logo = ?, header_logo_mime = ?, login_watermark = ?, login_watermark_mime = ?,
          revision = ?, updated_at = ?, updated_by = ?
      WHERE id = 1
    `).run(
      displayText,
      nextHeader.bytes,
      nextHeader.mimeType,
      nextWatermark.bytes,
      nextWatermark.mimeType,
      revision,
      new Date().toISOString(),
      String(actor.display_name || actor.username),
    )
    return getPublicBrandSettings(database)
  })
}

function readBrandSettingsRow(database: DatabaseSync): BrandSettingsRow {
  const rows = database.prepare(`
    SELECT display_text, header_logo, header_logo_mime, login_watermark, login_watermark_mime,
           revision, updated_at, updated_by
    FROM brand_settings
    LIMIT 2
  `).all() as BrandSettingsRow[]
  const row = rows[0]
  if (rows.length !== 1 || !row || normalizeBrandDisplayText(row.display_text) !== row.display_text
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !isStoredAssetValid(row.header_logo, row.header_logo_mime)
    || !isStoredAssetValid(row.login_watermark, row.login_watermark_mime)) {
    throw new Error('品牌设置存储无效。')
  }
  return row
}

function isStoredAssetValid(bytes: Uint8Array | null, mimeType: string | null) {
  if (bytes === null || mimeType === null) return bytes === null && mimeType === null
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_BRAND_ASSET_BYTES
    && isBrandImageMimeType(mimeType) && matchesImageSignature(bytes, mimeType)
}

function decodeBrandImageChange(change: BrandImageChange): { bytes: Uint8Array; mimeType: BrandImageMimeType } | null | undefined {
  if (change === undefined || change === null) return change
  if (!isBrandImageMimeType(change.mimeType) || typeof change.dataBase64 !== 'string' || !change.dataBase64) {
    throw new Error('品牌图片格式无效。')
  }
  const validBase64 = change.dataBase64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(change.dataBase64)
  const bytes = Buffer.from(change.dataBase64, 'base64')
  if (!validBase64 || !bytes.byteLength || bytes.byteLength > MAX_BRAND_ASSET_BYTES || bytes.toString('base64') !== change.dataBase64) {
    throw new Error('品牌图片须为不超过 2 MB 的 PNG、JPG 或 WebP 文件。')
  }
  if (!matchesImageSignature(bytes, change.mimeType)) throw new Error('品牌图片内容与文件格式不匹配。')
  return { bytes, mimeType: change.mimeType }
}

function resolveAssetChange(
  change: { bytes: Uint8Array; mimeType: BrandImageMimeType } | null | undefined,
  currentBytes: Uint8Array | null,
  currentMimeType: string | null,
) {
  if (change === undefined) return { bytes: currentBytes, mimeType: currentMimeType }
  if (change === null) return { bytes: null, mimeType: null }
  return change
}

function isBrandImageMimeType(value: unknown): value is BrandImageMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp'
}

function matchesImageSignature(bytes: Uint8Array, mimeType: BrandImageMimeType) {
  if (mimeType === 'image/png') return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
}
