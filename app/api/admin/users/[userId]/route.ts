import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/request'
import { deleteManagedUser, getManagedUserById, isUserRole, isUserStatus, ManagedUserUpdateConflictError, updateManagedUser } from '@/lib/auth/session'
import { readRequiredUpdatedAt } from '@/lib/http/optimistic-lock'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBodyOrTooLarge } from '@/lib/http/request-body'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type UpdateUserBody = {
  username?: unknown
  displayName?: unknown
  password?: unknown
  role?: unknown
  status?: unknown
  updatedAt?: unknown
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  const { userId } = await context.params
  const currentUser = getManagedUserById(userId)
  if (!currentUser) return NextResponse.json({ error: '用户不存在。' }, { status: 404 })

  const parsed = await readJsonBodyOrTooLarge<UpdateUserBody>(request, 16 * 1024)
  if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
  const body = parsed.body
  const expectedUpdatedAt = readRequiredUpdatedAt(body?.updatedAt)
  if (!expectedUpdatedAt) return NextResponse.json({ error: '缺少有效的更新时间，请刷新后重试。' }, { status: 400 })
  const username = typeof body?.username === 'string' ? body.username : ''
  const displayName = typeof body?.displayName === 'string' ? body.displayName : ''
  const password = body?.password === undefined ? undefined : typeof body.password === 'string' ? body.password : null
  const role = body?.role
  const status = body?.status
  if (!username.trim() || !displayName.trim() || password === null || !isUserRole(role) || !isUserStatus(status)) {
    return NextResponse.json({ error: '用户信息或权限设置无效。' }, { status: 400 })
  }

  try {
    const user = await updateManagedUser({
      id: userId,
      username,
      displayName,
      password,
      role,
      status,
      expectedUpdatedAt,
      actorId: access.id,
    })
    return user
      ? NextResponse.json({ user })
      : NextResponse.json({ error: '用户不存在。' }, { status: 404 })
  } catch (error) {
    if (error instanceof ManagedUserUpdateConflictError) return NextResponse.json({ error: error.message }, { status: 409 })
    return userErrorResponse(error)
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  const { userId } = await context.params
  if (access.id === userId) {
    return NextResponse.json({ error: '不能删除当前登录账号。' }, { status: 400 })
  }

  try {
    const deleted = deleteManagedUser(userId, access.id)
    return deleted
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: '用户不存在。' }, { status: 404 })
  } catch (error) {
    return userErrorResponse(error)
  }
}

function userErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : '用户操作失败。'
  const status = message === '用户名已存在。' ? 409 : message === '管理员权限已变更，请重新登录。' ? 403 : 400
  return NextResponse.json({ error: message }, { status })
}
