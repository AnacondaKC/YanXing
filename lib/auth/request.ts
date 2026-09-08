import { NextResponse } from 'next/server'
import { getSessionByToken, parseCookieHeader, sessionCookieName, type AuthUser } from '@/lib/auth/session'

export function getRequestSession(request: Request) {
  const token = parseCookieHeader(request.headers.get('cookie')).get(sessionCookieName)
  return getSessionByToken(token)
}

export function getRequestUser(request: Request): AuthUser | undefined {
  return getRequestSession(request)?.user
}

export function requireAdmin(request: Request, forbiddenMessage = '需要管理员权限。'): AuthUser | NextResponse {
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ error: forbiddenMessage }, { status: 403 })
  return user
}
