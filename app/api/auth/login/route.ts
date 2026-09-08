import { NextResponse } from 'next/server'
import { authenticateUserAsync, AuthenticationBusyError, createSession, csrfCookieName, sessionCookieName } from '@/lib/auth/session'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBody, RequestBodyTimeoutError, RequestBodyTooLargeError } from '@/lib/http/request-body'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { rateLimitFailure } from '@/lib/http/rate-limit-response'
import { runtimeConfig } from '@/lib/config/environment'

export const runtime = 'nodejs'

const maxLoginBodyBytes = 8 * 1024
// 所有用户名都使用同一失败桶，避免通过 429/401 差异枚举账号。
const loginFailureRateLimit = { limit: 20, windowMs: 15 * 60 * 1000 }

export async function POST(request: Request) {
  let body: { username?: string; password?: string } | null
  try {
    body = await readJsonBody<{ username?: string; password?: string }>(request, maxLoginBodyBytes)
  } catch (error) {
    if (error instanceof RequestBodyTimeoutError) return jsonBodyFailureResponse(408)
    if (error instanceof RequestBodyTooLargeError) return jsonBodyFailureResponse(413)
    return NextResponse.json({ error: '用户名或密码错误。' }, { status: 401 })
  }
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!username || username.length > 32 || !password || password.length > 128) {
    return NextResponse.json({ error: '用户名或密码错误。' }, { status: 401 })
  }
  let user
  try {
    user = await authenticateUserAsync(username, password)
  } catch (error) {
    if (error instanceof AuthenticationBusyError) {
      return NextResponse.json({ error: error.message }, { status: 503, headers: { 'Retry-After': '1' } })
    }
    console.error('登录认证失败（数据库或服务异常）：', error)
    return NextResponse.json({ error: '登录服务暂时不可用，请稍后再试。' }, { status: 500 })
  }
  if (!user) {
    const decision = checkRateLimit(`login-user:${username.toLowerCase()}`, loginFailureRateLimit)
    const limited = rateLimitFailure(decision, { error: '该账号登录失败次数过多，请稍后再试。' })
    if (limited) return NextResponse.json(limited.body, { status: limited.status, headers: limited.headers })
    return NextResponse.json({ error: '用户名或密码错误。' }, { status: 401 })
  }

  const session = createSession(user.id)
  const secure = runtimeConfig.isProduction
  const response = NextResponse.json({ user })
  response.cookies.set(sessionCookieName, session.token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(session.expiresAt),
  })
  response.cookies.set(csrfCookieName, session.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(session.expiresAt),
  })
  return response
}
