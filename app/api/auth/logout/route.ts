import { NextRequest, NextResponse } from 'next/server'
import { csrfCookieName, deleteSession, parseCookieHeader, sessionCookieName } from '@/lib/auth/session'
import { runtimeConfig } from '@/lib/config/environment'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  deleteSession(parseCookieHeader(request.headers.get('cookie')).get(sessionCookieName))
  const response = NextResponse.json({ ok: true })
  const secure = runtimeConfig.isProduction
  response.cookies.set(sessionCookieName, '', { httpOnly: true, secure, sameSite: 'lax', expires: new Date(0), path: '/' })
  response.cookies.set(csrfCookieName, '', { secure, sameSite: 'lax', expires: new Date(0), path: '/' })
  return response
}
