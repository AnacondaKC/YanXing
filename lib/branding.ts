export const DEFAULT_BRAND_DISPLAY_TEXT = '研行致远\n产业政策研究团队'
export const DEFAULT_HEADER_LOGO_URL = '/研行LOGO-完整矢量平滑版.svg'
export const DEFAULT_LOGIN_WATERMARK_URL = '/研行LOGO-完整矢量平滑版.svg'
export const MAX_BRAND_DISPLAY_TEXT_LENGTH = 60
export const MAX_BRAND_ASSET_BYTES = 2 * 1024 * 1024

export type BrandAssetKind = 'header-logo' | 'login-watermark'
export type BrandImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface PublicBrandSettings {
  displayText: string
  headerLogoUrl: string
  loginWatermarkUrl: string
  revision: number
  updatedAt: string | null
  updatedBy: string | null
}

export interface BrandImageInput {
  mimeType: BrandImageMimeType
  dataBase64: string
}

export type BrandImageChange = BrandImageInput | null | undefined

export interface BrandSettingsInput {
  displayText: string
  headerLogo?: BrandImageChange
  loginWatermark?: BrandImageChange
}

export const DEFAULT_BRAND_SETTINGS: PublicBrandSettings = {
  displayText: DEFAULT_BRAND_DISPLAY_TEXT,
  headerLogoUrl: DEFAULT_HEADER_LOGO_URL,
  loginWatermarkUrl: DEFAULT_LOGIN_WATERMARK_URL,
  revision: 1,
  updatedAt: null,
  updatedBy: null,
}

export function normalizeBrandDisplayText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
  if (!normalized || normalized.length > MAX_BRAND_DISPLAY_TEXT_LENGTH) return null
  if (normalized.split('\n').length > 2) return null
  return normalized
}
