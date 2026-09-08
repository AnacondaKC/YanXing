import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/request'
import { countManagedUsers, createManagedUser, isUserRole, listManagedUsers } from '@/lib/auth/session'
import { pageResult, parsePagination, paginationRangeFailure } from '@/lib/http/pagination'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBodyOrTooLarge } from '@/lib/http/request-body'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CreateUserBody = {
  username?: unknown
  displayName?: unknown
  password?: unknown
  role?: unknown
}

export async function GET(request: Request) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  try {
    const pagination = parsePagination(request, { limit: 100, maxLimit: 100 })
    const users = listManagedUsers(pagination)
    const result = pageResult(users, countManagedUsers(), pagination)
    return NextResponse.json({ users: result.items, total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore }, { status: 200 })
  } catch (error) {
    const failure = paginationRangeFailure(error)
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status })
    throw error
  }
}

export async function POST(request: Request) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  const parsed = await readJsonBodyOrTooLarge<CreateUserBody>(request, 16 * 1024)
  if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
  const body = parsed.body
  const username = typeof body?.username === 'string' ? body.username : ''
  const displayName = typeof body?.displayName === 'string' ? body.displayName : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  const role = body?.role
  if (!username.trim() || !displayName.trim() || !password || !isUserRole(role)) {
    return NextResponse.json({ error: '请完整填写用户名、显示名称、密码和权限组。' }, { status: 400 })
  }

  try {
    const user = await createManagedUser({ username, displayName, password, role, actorId: access.id })
    return NextResponse.json({ user }, { status: 201 })
  } catch (error) {
    return userErrorResponse(error)
  }
}

function userErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : '用户操作失败。'
  const status = message === '用户名已存在。' ? 409 : message === '管理员权限已变更，请重新登录。' ? 403 : 400
  return NextResponse.json({ error: message }, { status })
}
