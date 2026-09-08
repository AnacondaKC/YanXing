import { NextResponse } from 'next/server'
import { isAiBudgetLimits, type AiBudgetSettingsResponse } from '@/lib/ai/budget-settings'
import { requireAdmin } from '@/lib/auth/request'
import { AiBudgetSettingsAccessError, AiBudgetSettingsRevisionConflictError, getAiBudgetSettingsResponse, saveAiBudgetSettings } from '@/lib/db/ai-budget-settings-repository'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBody, RequestBodyTimeoutError, RequestBodyTooLargeError } from '@/lib/http/request-body'
import { requireSettingsRevision } from '@/lib/http/settings-revision'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BUDGET_SETTINGS_BODY_BYTES = 4 * 1024

function settingsResponse(response: AiBudgetSettingsResponse) {
  return NextResponse.json(response, { headers: { ETag: '"budget-' + response.settings.revision + '"', 'Cache-Control': 'no-store' } })
}

export async function GET(request: Request) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  try {
    return settingsResponse(getAiBudgetSettingsResponse(access.id))
  } catch {
    return NextResponse.json({ error: '预算设置读取失败，请联系管理员检查服务器配置。' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  let body: unknown
  try {
    body = await readJsonBody<unknown>(request, MAX_BUDGET_SETTINGS_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTimeoutError) return jsonBodyFailureResponse(408)
    if (error instanceof RequestBodyTooLargeError) return jsonBodyFailureResponse(413)
    return NextResponse.json({ error: '预算设置请求读取失败。' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '预算设置请求无效。' }, { status: 400 })
  const input = body as Record<string, unknown>
  const condition = requireSettingsRevision(input.revision, request, 'budget')
  if (condition instanceof NextResponse) return condition
  if (!isAiBudgetLimits(input.limits)) return NextResponse.json({ error: '预算上限仅允许 dailyTokens 和 sevenDayTokens，且都必须为 1 至 9007199254740991 之间的整数。' }, { status: 400 })
  try {
    return settingsResponse(saveAiBudgetSettings({ revision: condition.revision, limits: input.limits, actorId: access.id }))
  } catch (error) {
    if (error instanceof AiBudgetSettingsAccessError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof AiBudgetSettingsRevisionConflictError) {
      return NextResponse.json({ error: error.message, revision: error.actualRevision }, { status: request.headers.has('if-match') ? 412 : 409 })
    }
    return NextResponse.json({ error: '预算设置保存失败，请联系管理员检查服务器配置。' }, { status: 500 })
  }
}
