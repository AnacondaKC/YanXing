import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-login-route-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'login-route.sqlite')
process.env.YANXING_AUTH_CONCURRENCY = '1'
process.env.YANXING_AUTH_QUEUE_LIMIT = '1'

const { authenticateUserAsync, createOrUpdateUser, csrfCookieName, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { POST: loginRoute } = await import('../app/api/auth/login/route')

const loginFailureLimit = 20
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test.after(async () => {
  try { getDatabase().close() } catch { /* already closed */ }
  await rm(directory, { recursive: true, force: true })
})

function loginRequest(body: BodyInit | null, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return loginRoute(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal,
  }))
}

function jsonLogin(username: string, password: string) {
  return loginRequest(JSON.stringify({ username, password }))
}

async function errorBody(response: Response) {
  return await response.json() as { error?: string }
}

function sessionCount() {
  return Number((getDatabase().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n)
}

function cookieHeader(response: Response, name: string) {
  return response.headers.getSetCookie().find((header) => header.startsWith(name + '='))
}

function hasAttribute(header: string, attribute: string) {
  return new RegExp(';\\s*' + attribute + '(?:;|$)', 'i').test(header)
}

test.describe('login route', { concurrency: false }, () => {
test('oversized and aborted login bodies map to 413 and 408 without creating a session', async () => {
  const before = sessionCount()
  const oversized = await loginRequest('{"username":"login-body","password":"password-12345"}', { 'content-length': String(9 * 1024) })
  assert.equal(oversized.status, 413)
  assert.equal((await errorBody(oversized)).error, '请求体超过大小限制。')

  const abort = new AbortController()
  abort.abort()
  const timedOut = await loginRequest(JSON.stringify({ username: 'login-body', password: 'password-12345' }), {}, abort.signal)
  assert.equal(timedOut.status, 408)
  assert.equal((await errorBody(timedOut)).error, '请求体读取超时。')
  assert.equal(sessionCount(), before)
})

test('malformed login JSON is a credential failure, not a parser 500', async () => {
  const before = sessionCount()
  const response = await loginRequest('{')
  assert.equal(response.status, 401)
  assert.equal((await errorBody(response)).error, '用户名或密码错误。')
  assert.equal(sessionCount(), before)
})

test('repeated failures for one account return 429 after the failure threshold', async () => {
  createOrUpdateUser({ username: 'login-limit', displayName: '限流账号', password: 'password-limit-123', role: 'researcher' })
  createOrUpdateUser({ username: 'login-limit-other', displayName: '对照账号', password: 'password-limit-123', role: 'researcher' })
  const before = sessionCount()
  for (let attempt = 0; attempt < loginFailureLimit; attempt += 1) {
    const failure = await jsonLogin('login-limit', 'wrong-password-1')
    assert.equal(failure.status, 401)
  }
  const blocked = await jsonLogin('login-limit', 'wrong-password-1')
  assert.equal(blocked.status, 429)
  assert.equal((await errorBody(blocked)).error, '该账号登录失败次数过多，请稍后再试。')
  assert.match(blocked.headers.get('Retry-After') ?? '', /^[1-9]\d*$/)
  const other = await jsonLogin('login-limit-other', 'wrong-password-1')
  assert.equal(other.status, 401)
  assert.equal((await errorBody(other)).error, '用户名或密码错误。')
  assert.equal(sessionCount(), before)
})

test('authentication backlog maps to 503 without issuing cookies', async (context) => {
  createOrUpdateUser({ username: 'login-busy', displayName: '繁忙账号', password: 'password-busy-123', role: 'researcher' })
  const hashStarted = Promise.withResolvers<void>()
  const releaseHash = Promise.withResolvers<void>()
  const originalScrypt = crypto.scrypt
  const mockedScrypt = context.mock.method(crypto, 'scrypt', (
    password: crypto.BinaryLike,
    salt: crypto.BinaryLike,
    keyLength: number,
    options: crypto.ScryptOptions,
    callback: (error: Error | null, key: Buffer) => void,
  ) => {
    hashStarted.resolve()
    originalScrypt(password, salt, keyLength, options, (error, key) => {
      void releaseHash.promise.then(() => callback(error, key))
    })
  })
  syncBuiltinESMExports()
  let held: Promise<unknown> | undefined
  let queued: Promise<unknown> | undefined
  try {
    held = authenticateUserAsync('login-busy', 'wrong-password-busy')
    await hashStarted.promise
    queued = authenticateUserAsync('login-busy', 'wrong-password-busy')
    const busy = await jsonLogin('login-busy', 'wrong-password-busy')
    assert.equal(busy.status, 503)
    assert.equal((await errorBody(busy)).error, '登录服务繁忙，请稍后再试。')
    assert.equal(busy.headers.get('Retry-After'), '1')
    assert.equal(cookieHeader(busy, sessionCookieName), undefined)
  } finally {
    releaseHash.resolve()
    mockedScrypt.mock.restore()
    syncBuiltinESMExports()
    await Promise.allSettled([held, queued].filter(Boolean))
  }
})

test('successful login sets HttpOnly session and a readable CSRF cookie', async () => {
  createOrUpdateUser({ username: 'login-cookie', displayName: 'Cookie账号', password: 'password-cookie-123', role: 'researcher' })
  const response = await jsonLogin('login-cookie', 'password-cookie-123')
  assert.equal(response.status, 200)
  const session = cookieHeader(response, sessionCookieName)
  const csrf = cookieHeader(response, csrfCookieName)
  assert.ok(session)
  assert.ok(csrf)
  assert.equal(hasAttribute(session, 'HttpOnly'), true)
  assert.equal(hasAttribute(csrf, 'HttpOnly'), false)
  assert.equal(hasAttribute(session, 'Path=/'), true)
  assert.equal(hasAttribute(csrf, 'Path=/'), true)
  assert.equal(hasAttribute(session, 'SameSite=lax'), true)
  assert.equal(hasAttribute(csrf, 'SameSite=lax'), true)
  assert.equal(hasAttribute(session, 'Secure'), false)
  assert.equal(hasAttribute(csrf, 'Secure'), false)
  assert.equal(sessionCookieName.startsWith('__Host-'), false)
})

test('production login cookies use __Host- names, Secure, and keep CSRF readable', async () => {
  const childDirectory = await mkdtemp(path.join(tmpdir(), 'yanxing-login-prod-'))
  const scriptPath = path.join(childDirectory, 'prod-login.mts')
  const script = [
    'const root = process.env.YANXING_LOGIN_PROD_ROOT',
    "const { createOrUpdateUser, csrfCookieName, sessionCookieName } = await import(root + '/lib/auth/session.ts')",
    "const { POST } = await import(root + '/app/api/auth/login/route.ts')",
    "const { getDatabase } = await import(root + '/lib/db/client.ts')",
    "createOrUpdateUser({ username: 'prod-cookie', displayName: '生产Cookie', password: 'password-prod-123', role: 'researcher' })",
    'const response = await POST(new Request(\'http://localhost/api/auth/login\', {',
    "  method: 'POST',",
    "  headers: { 'content-type': 'application/json' },",
    "  body: JSON.stringify({ username: 'prod-cookie', password: 'password-prod-123' }),",
    '}))',
    'process.stdout.write(JSON.stringify({',
    '  status: response.status,',
    '  cookies: response.headers.getSetCookie(),',
    '  sessionCookieName,',
    '  csrfCookieName,',
    "}) + '\\n')",
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
        NODE_ENV: 'production',
        YANXING_DATABASE_PATH: path.join(childDirectory, 'prod.sqlite'),
        YANXING_LOGIN_PROD_ROOT: projectRoot,
        YANXING_SETTINGS_ENCRYPTION_KEY: 'login-prod-cookie-encryption-key',
      },
      timeout: 30_000,
    })
    assert.equal(child.status, 0, child.stderr)
    const payload = JSON.parse(child.stdout) as {
      status: number
      cookies: string[]
      sessionCookieName: string
      csrfCookieName: string
    }
    assert.equal(payload.status, 200)
    assert.equal(payload.sessionCookieName, '__Host-yanxing_session')
    assert.equal(payload.csrfCookieName, '__Host-yanxing_csrf')
    const session = payload.cookies.find((header) => header.startsWith('__Host-yanxing_session='))
    const csrf = payload.cookies.find((header) => header.startsWith('__Host-yanxing_csrf='))
    assert.ok(session)
    assert.ok(csrf)
    assert.equal(hasAttribute(session, 'HttpOnly'), true)
    assert.equal(hasAttribute(csrf, 'HttpOnly'), false)
    assert.equal(hasAttribute(session, 'Secure'), true)
    assert.equal(hasAttribute(csrf, 'Secure'), true)
    assert.equal(hasAttribute(session, 'SameSite=lax'), true)
    assert.equal(hasAttribute(csrf, 'Path=/'), true)
  } finally {
    await rm(childDirectory, { recursive: true, force: true })
  }
})
})
