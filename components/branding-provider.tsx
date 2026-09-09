'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_BRAND_SETTINGS,
  normalizeBrandDisplayText,
  type PublicBrandSettings,
} from '@/lib/branding'

type BrandingContextValue = {
  settings: PublicBrandSettings
  applySettings(settings: PublicBrandSettings): void
}

const BrandingContext = createContext<BrandingContextValue>({
  settings: DEFAULT_BRAND_SETTINGS,
  applySettings() {},
})

export function BrandingProvider({ children, initialSettings }: {
  children: ReactNode
  initialSettings: PublicBrandSettings
}) {
  const [settings, setSettings] = useState(initialSettings)

  const value = useMemo(() => ({ settings, applySettings: setSettings }), [settings])
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>
}

export function useBranding() {
  return useContext(BrandingContext)
}

export function parseBrandSettingsResponse(value: unknown): PublicBrandSettings | null {
  if (!isRecord(value) || !isRecord(value.settings)) return null
  const settings = value.settings
  const displayText = normalizeBrandDisplayText(settings.displayText)
  if (!displayText || !isLocalAssetUrl(settings.headerLogoUrl) || !isLocalAssetUrl(settings.loginWatermarkUrl)
    || !Number.isSafeInteger(settings.revision) || Number(settings.revision) < 1) return null
  return {
    displayText,
    headerLogoUrl: settings.headerLogoUrl,
    loginWatermarkUrl: settings.loginWatermarkUrl,
    revision: Number(settings.revision),
    updatedAt: typeof settings.updatedAt === 'string' ? settings.updatedAt : null,
    updatedBy: typeof settings.updatedBy === 'string' ? settings.updatedBy : null,
  }
}

function isLocalAssetUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
