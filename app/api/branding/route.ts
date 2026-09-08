import { NextResponse } from 'next/server'
import { getPublicBrandSettings } from '@/lib/db/brand-settings-repository'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  try {
    const settings = getPublicBrandSettings()
    const etag = '"branding-' + settings.revision + '"'
    if (request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } })
    }
    return NextResponse.json({ settings }, { headers: { ETag: etag, 'Cache-Control': 'no-cache' } })
  } catch {
    return NextResponse.json({ error: '品牌设置读取失败。' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
