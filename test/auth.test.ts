import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(`${tmpdir()}/yanxing-auth-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'auth-test.sqlite')

const {
  authenticateUserAsync,
  createOrUpdateUser,
  createSession,
  deleteSession,
  getSessionByToken,
  parseCookieHeader,
  updateManagedUser,
  verifyCsrf,
} = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('database initialization does not create an administrator automatically', async () => {
  getDatabase()
  const automatic = getDatabase().prepare("SELECT id FROM users WHERE username = 'admin' COLLATE NOCASE").get()
  assert.equal(automatic, undefined)

  const created = createOrUpdateUser({
    username: 'admin',
    displayName: '系统管理员',
    password: 'changed-password-1',
    role: 'admin',
  })
  assert.equal(created.username, 'admin')
  assert.equal(created.role, 'admin')
  assert.equal((await authenticateUserAsync('admin', 'changed-password-1'))?.id, created.id)
})

test('user creation normalizes username and hashes the password', () => {
  const user = createOrUpdateUser({ username: 'Alpha.User', displayName: '测试用户', password: 'correct-horse-1234', role: 'admin' })
  assert.equal(user.username, 'alpha.user')
  assert.equal(user.displayName, '测试用户')
  const row = getDatabase().prepare('SELECT password_hash, role FROM users WHERE id = ?').get(user.id) as { password_hash: string; role: string }
  assert.equal(row.role, 'admin')
  assert.ok(row.password_hash.startsWith('scrypt$'))
  assert.ok(!row.password_hash.includes('correct-horse-1234'))
})

test('authentication rejects wrong passwords and unknown users', async () => {
  const created = createOrUpdateUser({ username: 'auth-check', displayName: '认证测试', password: 'another-pass-5678', role: 'researcher' })
  assert.equal((await authenticateUserAsync('auth-check', 'another-pass-5678'))?.id, created.id)
  assert.equal(await authenticateUserAsync('auth-check', 'wrong-password'), undefined)
  assert.equal(await authenticateUserAsync('no-such-user', 'another-pass-5678'), undefined)
  assert.equal(await authenticateUserAsync('非法 用户名', 'another-pass-5678'), undefined)
})

test('successful login updates last_login_at without bumping users.updated_at', async () => {
  const created = createOrUpdateUser({ username: 'login-clock', displayName: '登录时钟', password: 'login-clock-5678', role: 'researcher' })
  const before = getDatabase().prepare('SELECT last_login_at, updated_at FROM users WHERE id = ?').get(created.id) as { last_login_at: string | null; updated_at: string }
  assert.equal(before.last_login_at, null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(await authenticateUserAsync('login-clock', 'login-clock-5678'))
  const after = getDatabase().prepare('SELECT last_login_at, updated_at FROM users WHERE id = ?').get(created.id) as { last_login_at: string | null; updated_at: string }
  assert.ok(after.last_login_at)
  assert.notEqual(after.last_login_at, before.updated_at)
  assert.equal(after.updated_at, before.updated_at)
})

test('sessions are created, verified, and deleted', () => {
  const user = createOrUpdateUser({ username: 'session-user', displayName: '会话测试', password: 'session-pass-1234', role: 'researcher' })
  const session = createSession(user.id)
  const resolved = getSessionByToken(session.token)
  assert.equal(resolved?.user.id, user.id)
  assert.equal(verifyCsrf(resolved!, session.csrfToken), true)
  assert.equal(verifyCsrf(resolved!, 'forged-token'), false)
  assert.equal(verifyCsrf(resolved!, ''), false)
  assert.equal(getSessionByToken('not-a-real-token'), undefined)
  deleteSession(session.token)
  assert.equal(getSessionByToken(session.token), undefined)
})

test('changing a password revokes all existing sessions', async () => {
  const user = createOrUpdateUser({ username: 'password-change', displayName: '改密测试', password: 'old-password-1234', role: 'researcher' })
  const first = createSession(user.id)
  const second = createSession(user.id)

  await updateManagedUser({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    password: 'new-password-5678',
    role: user.role,
    status: 'active',
  })

  assert.equal(getSessionByToken(first.token), undefined)
  assert.equal(getSessionByToken(second.token), undefined)
  assert.equal(await authenticateUserAsync(user.username, 'old-password-1234'), undefined)
  assert.equal((await authenticateUserAsync(user.username, 'new-password-5678'))?.id, user.id)
})

test('disabling and re-enabling an account cannot resurrect an old session', async () => {
  const created = createOrUpdateUser({ username: 'status-session', displayName: '状态会话', password: 'status-pass-1234', role: 'researcher' })
  const session = createSession(created.id)
  const managed = { id: created.id, username: created.username, displayName: created.displayName, role: created.role }

  await updateManagedUser({ ...managed, status: 'disabled' })
  assert.equal(getSessionByToken(session.token), undefined)
  await updateManagedUser({ ...managed, status: 'active' })
  assert.equal(getSessionByToken(session.token), undefined)
})

test('expired sessions and disabled users are rejected', async () => {
  const { createHash } = await import('node:crypto')
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')

  const user = createOrUpdateUser({ username: 'expiry-user', displayName: '过期测试', password: 'expiry-pass-1234', role: 'researcher' })
  const session = createSession(user.id)
  getDatabase().prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), digest(session.token))
  assert.equal(getSessionByToken(session.token), undefined)

  const disabled = createOrUpdateUser({ username: 'disabled-user', displayName: '停用测试', password: 'disabled-pass-123', role: 'researcher' })
  const disabledSession = createSession(disabled.id)
  assert.ok(getSessionByToken(disabledSession.token))
  getDatabase().prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', disabled.id)
  assert.equal(getSessionByToken(disabledSession.token), undefined)
  assert.equal(await authenticateUserAsync('disabled-user', 'disabled-pass-123'), undefined)
})

test('cookie parser rejects duplicate or malformed authentication cookies', () => {
  assert.equal(parseCookieHeader('yanxing_session=first; yanxing_session=second').has('yanxing_session'), false)
  assert.equal(parseCookieHeader('yanxing_session=first; bad name=value').get('yanxing_session'), 'first')
  assert.equal(parseCookieHeader('yanxing_session=%ZZ; yanxing_session=valid').has('yanxing_session'), false)
  assert.equal(parseCookieHeader('yanxing_csrf=' + 'x'.repeat(4097) + '; yanxing_csrf=valid').has('yanxing_csrf'), false)
  assert.equal(parseCookieHeader('yanxing_csrf=hello%20world').get('yanxing_csrf'), 'hello world')
})

test('username constraints reject invalid input', () => {
  assert.throws(() => createOrUpdateUser({ username: 'ab', displayName: '太短', password: 'password-12345', role: 'researcher' }), /用户名必须/)
  assert.throws(() => createOrUpdateUser({ username: 'ok-name', displayName: '   ', password: 'password-12345', role: 'researcher' }), /显示名称/)
})
