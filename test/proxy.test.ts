import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(`${tmpdir()}/yanxing-proxy-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'proxy-test.sqlite')

const { createOrUpdateUser, createSession, csrfCookieName, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { config, proxy } = await import('../proxy')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('proxy matcher excludes all static image extensions', () => {
  assert.match(config.matcher[0], /png\|jpg\|jpeg/)
})

test('login can load public brand settings and custom assets without a session', () => {
  for (const pathName of ['/api/branding', '/api/branding/assets/header-logo', '/api/branding/assets/login-watermark']) {
    const response = proxy(new NextRequest('http://localhost' + pathName, { headers: { host: 'localhost' } }))
    assert.equal(response.status, 200)
  }
  assert.equal(proxy(new NextRequest('http://localhost/api/admin/branding', { headers: { host: 'localhost' } })).status, 401)
})

function authenticatedMutation(username: string, pathName: string, method: string) {
  const user = createOrUpdateUser({
    username,
    displayName: username,
    password: 'proxy-rate-password-123',
    role: 'researcher',
  })
  const session = createSession(user.id)
  return () => new NextRequest('http://localhost' + pathName, {
    method,
    headers: {
      cookie: `${sessionCookieName}=${session.token}; ${csrfCookieName}=${session.csrfToken}`,
      host: 'localhost',
      origin: 'http://localhost',
      'x-yanxing-csrf': session.csrfToken,
    },
  })
}

test('insight mutations are rate limited after CSRF validation', () => {
  const user = createOrUpdateUser({
    username: 'proxy-rate-user',
    displayName: 'Proxy Rate User',
    password: 'proxy-rate-password-123',
    role: 'researcher',
  })
  const session = createSession(user.id)
  const request = () => new NextRequest('http://localhost/api/reports/report-rate/insight', {
    method: 'POST',
    headers: {
      cookie: `${sessionCookieName}=${session.token}; ${csrfCookieName}=${session.csrfToken}`,
      host: 'localhost',
      origin: 'http://localhost',
      'x-yanxing-csrf': session.csrfToken,
    },
  })

  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(proxy(request()).status, 200)
  }

  const blocked = proxy(request())
  assert.equal(blocked.status, 429)
  assert.match(blocked.headers.get('Retry-After') ?? '', /^[1-9]\d*$/)
})

test('analysis start and report replacement use AI-task rate limits', () => {
  const analysisRequest = authenticatedMutation('proxy-analysis-rate', '/api/reports/report-rate/analyze', 'POST')
  for (let attempt = 0; attempt < 12; attempt += 1) assert.equal(proxy(analysisRequest()).status, 200)
  assert.equal(proxy(analysisRequest()).status, 429)

  const replacementRequest = authenticatedMutation('proxy-replace-rate', '/api/reports/report-rate', 'PUT')
  for (let attempt = 0; attempt < 12; attempt += 1) assert.equal(proxy(replacementRequest()).status, 200)
  assert.equal(proxy(replacementRequest()).status, 429)
})

test('proxy maps an unavailable rate limiter to 503', () => {
  getDatabase().close()
  const response = proxy(new NextRequest('http://localhost/api/auth/login', { method: 'POST', headers: { host: 'localhost' } }))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Retry-After'), '5')
})
