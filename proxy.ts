import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  csrfCookieName,
  getSessionByToken,
  parseCookieHeader,
  sessionCookieName,
  verifyCsrf,
} from '@/lib/auth/session'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { rateLimitFailure } from '@/lib/http/rate-limit-response'
import { runtimeConfig } from '@/lib/config/environment'

const publicPaths = new Set(['/login', '/api/auth/login', '/api/branding'])
const publicPathPrefixes = ['/api/branding/assets/']
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

const defaultMutationRateLimit = { key: 'default', limit: 120, windowMs: 60 * 1000 }
const uploadRateLimit = { key: 'report-upload', limit: 8, windowMs: 15 * 60 * 1000 }
const knowledgeUploadRateLimit = { key: 'knowledge-upload', limit: 8, windowMs: 15 * 60 * 1000 }
const analysisRateLimit = { key: 'analysis', limit: 12, windowMs: 15 * 60 * 1000 }
const insightRateLimit = { key: 'insight', limit: 4, windowMs: 15 * 60 * 1000 }

function secured<T extends NextResponse>(response: T): T {
  for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value)
  return response
}

function securedJson(body: unknown, init?: ResponseInit) {
  return secured(NextResponse.json(body, init))
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  const isApi = path.startsWith('/api/')

  if (path === '/api/health') {
    return secured(NextResponse.next())
  }

  if (path === '/api/auth/login' && request.method === 'POST') {
    if (isCrossOriginMutation(request)) {
      return securedJson({ error: '请求来源无效。' }, { status: 403 })
    }
    const key = clientKey(request)
    // 识别不出具体客户端时退化为全站熔断阈值：只拦截大规模爆破，
    // 避免共享桶被少量输错把全站登录锁死；账号维度限流由登录路由兜底。
    const rule = key === 'direct-client' || key === 'unknown'
      ? { limit: 300, windowMs: 15 * 60 * 1000 }
      : { limit: 10, windowMs: 15 * 60 * 1000 }
    const decision = checkRateLimit(`login:${key}`, rule)
    const limited = rateLimitFailure(decision, { error: '登录尝试过于频繁，请稍后再试。', retryAfterSeconds: decision.retryAfterSeconds })
    if (limited) return securedJson(limited.body, { status: limited.status, headers: limited.headers })
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'))
  const session = getSessionByToken(cookies.get(sessionCookieName))
  if (isPublicPath(path)) {
    if (path === '/login' && session) return secured(NextResponse.redirect(new URL('/', request.url)))
    return secured(NextResponse.next())
  }

  if (!session) {
    if (isApi) return securedJson({ error: '未登录或会话已过期。' }, { status: 401 })
    return secured(NextResponse.redirect(new URL('/login', request.url)))
  }

  if (path.startsWith('/api/admin/') && session.user.role !== 'admin') {
    return securedJson({ error: '需要管理员权限。' }, { status: 403 })
  }

  if (isApi && mutationMethods.has(request.method)) {
    if (isCrossOriginMutation(request)) {
      return securedJson({ error: '请求来源无效。' }, { status: 403 })
    }
    const csrfHeader = request.headers.get('x-yanxing-csrf')
    const csrfCookie = cookies.get(csrfCookieName)
    if (!csrfHeader || csrfHeader !== csrfCookie || !verifyCsrf(session, csrfHeader)) {
      return securedJson({ error: 'CSRF 校验失败。' }, { status: 403 })
    }

    const rule = mutationRateLimitForPath(path, request.method)
    const decision = checkRateLimit(`mutation:${session.user.id}:${rule.key}`, rule)
    const limited = rateLimitFailure(decision, { error: '操作过于频繁，请稍后再试。', retryAfterSeconds: decision.retryAfterSeconds })
    if (limited) return securedJson(limited.body, { status: limited.status, headers: limited.headers })
  }

  const response = secured(NextResponse.next())
  if (/^\/api\/reports\/[^/]+\/file$/.test(path)) response.headers.set('X-Frame-Options', 'SAMEORIGIN')
  return response
}

function isPublicPath(path: string) {
  return publicPaths.has(path) || publicPathPrefixes.some((prefix) => path.startsWith(prefix))
}

function mutationRateLimitForPath(path: string, method: string) {
  if (/^\/api\/projects\/[^/]+\/reports$/.test(path)) return uploadRateLimit
  if (/^\/api\/knowledge$/.test(path)) return knowledgeUploadRateLimit
  if (/^\/api\/reports\/[^/]+\/insight$/.test(path)) return insightRateLimit
  if (
    (method === 'PUT' && /^\/api\/reports\/[^/]+$/.test(path))
    || /^\/api\/reports\/[^/]+\/analyze$/.test(path)
  ) {
    return analysisRateLimit
  }
  return defaultMutationRateLimit
}

function isCrossOriginMutation(request: NextRequest) {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    const originUrl = new URL(origin)
    const requestHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
    const requestProtocol = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '')
    return originUrl.host !== requestHost || originUrl.protocol !== `${requestProtocol}:`
  } catch {
    return true
  }
}

function clientKey(request: NextRequest) {
  // Forwarded headers are attacker-controlled unless the deployment explicitly
  // declares a trusted reverse proxy. Fail closed for direct exposure.
  if (!runtimeConfig.proxy.trustProxy) return 'direct-client'
  const forwarded = request.headers.get('x-forwarded-for')
  const hops = runtimeConfig.proxy.trustedProxyHops
  if (forwarded) {
    const addresses = forwarded.split(',').map((value) => value.trim()).filter(Boolean)
    // 最右侧第 hops 段是受信代理追加的真实客户端地址；更左侧的段均由客户端控制。
    const client = addresses.at(-hops)
    const normalized = normalizeClientAddress(client)
    if (normalized) return normalized
  }
  return normalizeClientAddress(request.headers.get('x-real-ip') ?? undefined) || 'unknown'
}

function normalizeClientAddress(value: string | undefined) {
  const candidate = value?.trim()
  if (!candidate || candidate.length > 64) return undefined
  const ipv4 = candidate.split('.')
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return ipv4.map(Number).join('.')
  const ipv6 = candidate.replace(/^\[|\]$/g, '').toLowerCase()
  if (ipv6.includes(':') && /^[0-9a-f:]+$/.test(ipv6)) {
    try {
      const parsed = new URL('http://[' + ipv6 + ']').hostname.replace(/^\[|\]$/g, '')
      return parsed.toLowerCase()
    } catch { /* invalid IPv6 */ }
  }
  return undefined
}


export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|css|js)).*)'],
}