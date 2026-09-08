import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/request'
import {
  BrandSettingsAccessError,
  BrandSettingsRevisionConflictError,
  getPublicBrandSettings,
  saveBrandSettings,
} from '@/lib/db/brand-settings-repository'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBody, RequestBodyTimeoutError, RequestBodyTooLargeError } from '@/lib/http/request-body'
import { requireSettingsRevision } from '@/lib/http/settings-revision'
import type { BrandSettingsInput } from '@/lib/branding'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BRAND_SETTINGS_BODY_BYTES = 6 * 1024 * 1024

type RequestBody = {
  revision?: unknown
  settings?: unknown
}

function settingsResponse(settings: ReturnType<typeof getPublicBrandSettings>) {
  return NextResponse.json({ settings }, {
    headers: { ETag: '"branding-' + settings.revision + '"', 'Cache-Control': 'no-store' },
  })
}

export function GET(request: Request) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  try {
    return settingsResponse(getPublicBrandSettings())
  } catch {
    return NextResponse.json({ error: '品牌设置读取失败，请联系管理员检查服务器配置。' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  let body: RequestBody | null
  try {
    body = await readJsonBody<RequestBody>(request, MAX_BRAND_SETTINGS_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTimeoutError) return jsonBodyFailureResponse(408)
    if (error instanceof RequestBodyTooLargeError) return jsonBodyFailureResponse(413)
    return NextResponse.json({ error: '品牌设置请求无效。' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !isRecord(body.settings)) {
    return NextResponse.json({ error: '品牌设置请求无效。' }, { status: 400 })
  }
  const condition = requireSettingsRevision(body.revision, request, 'branding')
  if (condition instanceof NextResponse) return condition

  try {
    return settingsResponse(saveBrandSettings({
      revision: condition.revision,
      settings: body.settings as unknown as BrandSettingsInput,
      actorId: access.id,
    }))
  } catch (error) {
    if (error instanceof BrandSettingsAccessError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof BrandSettingsRevisionConflictError) {
      const status = request.headers.has('if-match') ? 412 : 409
      return NextResponse.json(
        { error: error.message, revision: error.actualRevision },
        { status, headers: { ETag: '"branding-' + error.actualRevision + '"' } },
      )
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : '品牌设置保存失败。' }, { status: 400 })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
