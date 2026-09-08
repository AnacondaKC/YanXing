'use client'

import Image from 'next/image'
import { useBranding } from '@/components/branding-provider'

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  const { settings } = useBranding()
  return (
    <Image
      src={settings.headerLogoUrl}
      alt={settings.displayText.replace(/\n/g, ' ')}
      width={2048}
      height={865}
      className={compact ? 'h-7 w-auto max-w-[8rem] object-contain object-left' : 'h-10 w-auto max-w-[11rem] object-contain object-right'}
      priority
      unoptimized
    />
  )
}

export function WorkspaceBrandHeader() {
  const { settings } = useBranding()
  return (
    <div className="flex items-center">
      <BrandLogo />
      <div className="mx-3 h-10 w-px shrink-0 bg-yx-ink" aria-hidden="true" />
      <div className="flex min-h-11 max-w-28 shrink-0 items-center whitespace-pre-line text-left text-[11px] font-[550] leading-[1.6] tracking-[0.06em] text-yx-ink">
        {settings.displayText}
      </div>
    </div>
  )
}
