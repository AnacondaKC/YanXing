import { NextResponse } from 'next/server'
import { getStoredBrandAsset } from '@/lib/db/brand-settings-repository'
import type { BrandAssetKind } from '@/lib/branding'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ kind: string }> }) {
  const { kind } = await context.params
  if (!isBrandAssetKind(kind)) return new NextResponse(null, { status: 404 })
  try {
    const asset = getStoredBrandAsset(kind)
    if (!asset) return new NextResponse(null, { status: 404 })
    if (request.headers.get('if-none-match') === asset.etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: asset.etag, 'Cache-Control': 'public, max-age=300' } })
    }
    return new NextResponse(Uint8Array.from(asset.bytes).buffer, {
      headers: {
        'Content-Type': asset.mimeType,
        'Content-Length': String(asset.bytes.byteLength),
        'Cache-Control': 'public, max-age=300',
        ETag: asset.etag,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new NextResponse(null, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

function isBrandAssetKind(value: string): value is BrandAssetKind {
  return value === 'header-logo' || value === 'login-watermark'
}
