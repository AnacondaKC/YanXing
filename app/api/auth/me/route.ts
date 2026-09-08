import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth/request'
import { updateUserProfile } from '@/lib/auth/session'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBodyOrTooLarge } from '@/lib/http/request-body'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = getRequestSession(request)
  if (!session) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  return NextResponse.json({ user: session.user, expiresAt: session.expiresAt })
}

export async function PATCH(request: NextRequest) {
  const session = getRequestSession(request)
  if (!session) return NextResponse.json({ error: '未登录。' }, { status: 401 })

  const parsed = await readJsonBodyOrTooLarge<{ displayName?: unknown; avatar?: unknown }>(request, 16 * 1024)
  if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
  const body = parsed.body
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : ''
  const avatar = typeof body?.avatar === 'string' ? body.avatar.trim() : undefined

  if (!displayName) {
    return NextResponse.json({ error: '显示名称不能为空。' }, { status: 400 })
  }
  if (displayName.length > 80) {
    return NextResponse.json({ error: '显示名称不能超过 80 个字符。' }, { status: 400 })
  }

  try {
    const updatedUser = updateUserProfile(session.user.id, {
      displayName,
      avatar,
    })
    return NextResponse.json({ user: updatedUser })
  } catch (error) {
    const message = error instanceof Error ? error.message : '更新用户信息失败。'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
