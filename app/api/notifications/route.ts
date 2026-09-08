import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/auth/request'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBodyOrTooLarge } from '@/lib/http/request-body'
import { pageResult, parsePagination, paginationRangeFailure } from '@/lib/http/pagination'
import { listNotificationsForUser, markNotificationsRead } from '@/lib/notifications'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  let pagination
  try {
    pagination = parsePagination(request, { limit: 40, maxLimit: 100 })
  } catch (error) {
    const failure = paginationRangeFailure(error)
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status })
    throw error
  }
  const result = listNotificationsForUser(user, pagination)
  const page = pageResult(result.items, result.total, pagination)
  return NextResponse.json({
    notifications: page.items,
    total: page.total,
    unreadCount: result.unreadCount,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
  })
}

export async function PATCH(request: Request) {
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  const parsed = await readJsonBodyOrTooLarge<{ all?: unknown; ids?: unknown[] }>(request, 32 * 1024)
  if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
  const body = parsed.body
  const ids = Array.isArray(body?.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))]
    : []
  if (body?.all !== true && !ids.length) return NextResponse.json({ error: '请指定要标记的通知。' }, { status: 400 })
  if (ids.length > 100) return NextResponse.json({ error: '一次最多标记 100 条通知。' }, { status: 400 })
  const marked = markNotificationsRead(user, { all: body?.all === true, ids })
  return NextResponse.json({ marked })
}
