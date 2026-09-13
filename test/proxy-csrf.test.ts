import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-proxy-csrf-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'proxy-csrf.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'proxy-csrf-encryption-key'
delete process.env.YANXING_TRUST_PROXY

const { createOrUpdateUser, createSession, csrfCookieName, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { proxy } = await import('../proxy')

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const user = createOrUpdateUser({ username: 'csrf-owner', displayName: 'CSRF用户', password: 'password-csrf-123', role: 'researcher' })
const session = createSession(user.id)

test.after(async () => {
  try { getDatabase().close() } catch { /* already closed */ }
  await rm(directory, { recursive: true, force: true })
})

function buckets() {
  return getDatabase().prepare('SELECT bucket_key, count FROM rate_limit_buckets ORDER BY bucket_key').all()
}

function mutation(headers: Record<string, string>) {
  return new NextRequest('http://localhost/api/jobs/task/retry', { method: 'POST', headers })
}

function sessionCookie() {
  return sessionCookieName + '=' + session.token + '; ' + csrfCookieName + '=' + session.csrfToken
}

function matchingOrigin(extra: Record<string, string> = {}) {
  return {
    cookie: sessionCookie(),
    host: 'localhost',
    origin: 'http://localhost',
    'x-yanxing-csrf': session.csrfToken,
    ...extra,
  }
}

test.describe('proxy csrf', { concurrency: false }, () => {
test('Origin/Host mismatch and forged forwarded headers are 403 without touching rate-limit buckets', async () => {
  const before = buckets()
  const crossOrigin = proxy(mutation(matchingOrigin({ origin: 'http://evil.example' })))
  assert.equal(crossOrigin.status, 403)
  assert.equal(((await crossOrigin.json()) as { error?: string }).error, '请求来源无效。')
  assert.deepEqual(buckets(), before)

  const wrongHost = proxy(mutation(matchingOrigin({ host: 'evil.example' })))
  assert.equal(wrongHost.status, 403)
  assert.equal(((await wrongHost.json()) as { error?: string }).error, '请求来源无效。')
  assert.deepEqual(buckets(), before)

  const forged = proxy(mutation(matchingOrigin({
    origin: 'http://evil.example',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'http',
  })))
  assert.equal(forged.status, 403)
  assert.equal(((await forged.json()) as { error?: string }).error, '请求来源无效。')
  assert.deepEqual(buckets(), before)
})

test('CSRF header mismatch is 403 and does not consume the mutation limiter', async () => {
  const allowed = proxy(mutation(matchingOrigin()))
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('x-middleware-next'), '1')
  const afterAllow = buckets()
  assert.ok(afterAllow.length > 0)

  const missingHeader = proxy(mutation({ cookie: sessionCookie(), host: 'localhost', origin: 'http://localhost' }))
  assert.equal(missingHeader.status, 403)
  assert.equal(((await missingHeader.json()) as { error?: string }).error, 'CSRF 校验失败。')

  const mismatched = proxy(mutation(matchingOrigin({ 'x-yanxing-csrf': 'not-the-token' })))
  assert.equal(mismatched.status, 403)
  assert.equal(((await mismatched.json()) as { error?: string }).error, 'CSRF 校验失败。')
  assert.deepEqual(buckets(), afterAllow)
})

test('cross-origin login is 403 without consuming the login limiter', async () => {
  const before = buckets()
  const rejected = proxy(new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://evil.example' },
  }))
  assert.equal(rejected.status, 403)
  assert.equal(((await rejected.json()) as { error?: string }).error, '请求来源无效。')
  assert.deepEqual(buckets(), before)
})

test('trusted proxy uses forwarded Origin host and still rejects a mismatch', async () => {
  const childDirectory = await mkdtemp(path.join(tmpdir(), 'yanxing-proxy-trust-'))
  const scriptPath = path.join(childDirectory, 'trust-proxy.mts')
  const script = [
    'const root = process.env.YANXING_PROXY_TRUST_ROOT',
    "const { createOrUpdateUser, createSession, csrfCookieName, sessionCookieName } = await import(root + '/lib/auth/session.ts')",
    "const { proxy } = await import(root + '/proxy.ts')",
    "const { getDatabase } = await import(root + '/lib/db/client.ts')",
    'const { NextRequest } = await import(process.env.YANXING_NEXT_SERVER)',
    "const user = createOrUpdateUser({ username: 'csrf-trust', displayName: '代理用户', password: 'password-csrf-123', role: 'researcher' })",
    'const session = createSession(user.id)',
    "const cookie = sessionCookieName + '=' + session.token + '; ' + csrfCookieName + '=' + session.csrfToken",
    'function post(headers) {',
    "  return proxy(new NextRequest('http://127.0.0.1/api/jobs/task/retry', { method: 'POST', headers }))",
    '}',
    'const allowed = post({',
    '  cookie, host: \'127.0.0.1\', origin: \'http://app.example\',',
    "  'x-yanxing-csrf': session.csrfToken,",
    "  'x-forwarded-host': 'app.example',",
    "  'x-forwarded-proto': 'http',",
    '})',
    'const denied = post({',
    '  cookie, host: \'127.0.0.1\', origin: \'http://evil.example\',',
    "  'x-yanxing-csrf': session.csrfToken,",
    "  'x-forwarded-host': 'app.example',",
    "  'x-forwarded-proto': 'http',",
    '})',
    'process.stdout.write(JSON.stringify({ allowed: allowed.status, denied: denied.status, deniedBody: denied.status === 403 }) + \'\\n\')',
    'getDatabase().close()',
    '',
  ].join('\n')
  await writeFile(scriptPath, script)
  try {
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), scriptPath], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        YANXING_DATABASE_PATH: path.join(childDirectory, 'trust.sqlite'),
        YANXING_NEXT_SERVER: import.meta.resolve('next/server'),
        YANXING_PROXY_TRUST_ROOT: projectRoot,
        YANXING_SETTINGS_ENCRYPTION_KEY: 'proxy-csrf-encryption-key',
        YANXING_TRUST_PROXY: 'true',
      },
      timeout: 30_000,
    })
    assert.equal(child.status, 0, child.stderr)
    const payload = JSON.parse(child.stdout) as { allowed: number; denied: number }
    assert.equal(payload.allowed, 200)
    assert.equal(payload.denied, 403)
  } finally {
    await rm(childDirectory, { recursive: true, force: true })
  }
})
})
