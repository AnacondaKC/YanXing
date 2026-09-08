import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/request'
import {
  getPublicAiPromptSettings,
  restoreAiPromptSettings,
  saveAiPromptSettings,
  SettingsRevisionConflictError,
} from '@/lib/db/settings-repository'
import { isAiPromptTarget, type AiPromptTarget } from '@/lib/ai/prompt-defaults'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBody, RequestBodyTimeoutError, RequestBodyTooLargeError } from '@/lib/http/request-body'
import { requireSettingsRevision } from '@/lib/http/settings-revision'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RequestBody = {
  action?: unknown
  systemPrompt?: unknown
  prompts?: unknown
  targets?: unknown
  includeSystemPrompt?: unknown
  revision?: unknown
}

export async function GET(request: Request) {
  const access = requireAdmin(request, '只有管理员可以管理提示词。')
  if (access instanceof NextResponse) return access
  try {
    const settings = getPublicAiPromptSettings()
    const etag = `\"prompts-${settings.revision}\"`
    if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } })
    return NextResponse.json(settings, { headers: { ETag: etag } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '提示词读取失败。' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  const user = requireAdmin(request, '只有管理员可以管理提示词。')
  if (user instanceof NextResponse) return user
  let body: RequestBody | null
  try {
    body = await readJsonBody(request, 512 * 1024)
  } catch (error) {
    if (error instanceof RequestBodyTimeoutError) return jsonBodyFailureResponse(408)
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: '提示词内容超过大小限制。' }, { status: 413 })
    }
    throw error
  }
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: '提示词请求无效。' }, { status: 400 })

  try {
    if (body.action === 'save') {
      const condition = requireSettingsRevision(body.revision, request, 'prompts')
      if (condition instanceof NextResponse) return condition
      const settings = saveAiPromptSettings({ systemPrompt: body.systemPrompt, prompts: body.prompts }, user.displayName || user.username, user.id, condition.revision)
      return NextResponse.json({ settings }, { headers: { ETag: `"prompts-${settings.revision}"` } })
    }
    if (body.action === 'restore_defaults') {
      const targets = parsePromptTargets(body.targets)
      if (targets instanceof NextResponse) return targets
      const condition = requireSettingsRevision(body.revision, request, 'prompts')
      if (condition instanceof NextResponse) return condition
      const settings = restoreAiPromptSettings(targets, user.displayName || user.username, { includeSystemPrompt: body.includeSystemPrompt === true, actorId: user.id, expectedRevision: condition.revision })
      return NextResponse.json({ settings }, { headers: { ETag: `"prompts-${settings.revision}"` } })
    }
    return NextResponse.json({ error: '未知的提示词操作。' }, { status: 400 })
  } catch (error) {
    if (error instanceof SettingsRevisionConflictError) {
      const status = request.headers.get('if-match') === null ? 409 : 412
      return NextResponse.json({ error: error.message, revision: error.actualRevision }, { status, headers: { ETag: `"prompts-${error.actualRevision}"` } })
    }
    const message = error instanceof Error ? error.message : '提示词保存失败。'
    return NextResponse.json({ error: message }, { status: message === '管理员权限已变更，请重新登录。' ? 403 : 400 })
  }
}

function parsePromptTargets(value: unknown): AiPromptTarget[] | undefined | NextResponse {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return NextResponse.json({ error: '恢复目标必须是数组。' }, { status: 400 })
  if (!value.every(isAiPromptTarget)) return NextResponse.json({ error: '恢复目标无效。' }, { status: 400 })
  return value as AiPromptTarget[]
}