import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(`${tmpdir()}/yanxing-proxy-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'proxy-test.sqlite')

const { createOrUpdateUser, createSession, csrfCookieName, sessionCookieName } = await import('../lib/auth/session')
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

test('analysis start uses AI-task rate limits', () => {
  const analysisRequest = authenticatedMutation('proxy-analysis-rate', '/api/reports/report-rate/analyze', 'POST')
  for (let attempt = 0; attempt < 12; attempt += 1) assert.equal(proxy(analysisRequest()).status, 200)
  assert.equal(proxy(analysisRequest()).status, 429)

})

test('native preparation retains upload rate limits without sharing the confirmation bucket',()=>{
  const prepare=authenticatedMutation('proxy-native-prepare','/api/projects/p/report-uploads','POST')
  for(let attempt=0;attempt<8;attempt++)assert.equal(proxy(prepare()).status,200)
  assert.equal(proxy(prepare()).status,429)
  const original=prepare()
  const confirm=()=>new NextRequest('http://localhost/api/projects/p/reports',{method:'POST',headers:original.headers})
  assert.equal(proxy(confirm()).status,200)
})

test('native retry cannot bypass the strict AI mutation limiter',()=>{
  const retry=authenticatedMutation('proxy-native-retry','/api/jobs/task/retry','POST')
  for(let attempt=0;attempt<4;attempt++)assert.equal(proxy(retry()).status,200)
  assert.equal(proxy(retry()).status,429)
})

test('task retries do not consume the independent insight-start bucket', () => {
  const retry = authenticatedMutation('proxy-native-retry-independent', '/api/jobs/task/retry', 'POST')
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(proxy(retry()).status, 200)

  const insight = authenticatedMutation(
    'proxy-native-retry-independent',
    '/api/reports/report-rate/insight',
    'POST',
  )
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(proxy(insight()).status, 200)
  assert.equal(proxy(insight()).status, 429)
})
