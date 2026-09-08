import { createHash, randomBytes, randomUUID, scrypt as scryptAsync, scryptSync, timingSafeEqual } from 'node:crypto'
import { getDatabase, inImmediateTransaction } from '@/lib/db/client'
import { runtimeConfig } from '@/lib/config/environment'
import { nextMonotonicIsoTimestamp } from '@/lib/monotonic-iso-timestamp'

const secureCookiePrefix = runtimeConfig.isProduction ? '__Host-' : ''
export const sessionCookieName = secureCookiePrefix + 'yanxing_session'
export const csrfCookieName = secureCookiePrefix + 'yanxing_csrf'
const sessionLifetimeMs = runtimeConfig.sessionHours * 60 * 60 * 1000
const scryptWorkFactor = 32_768
const scryptBlockSize = 8
const scryptParallelization = 1
const scryptKeyLength = 64
const scryptMaxMemory = 64 * 1024 * 1024

export type UserRole = 'admin' | 'researcher'

export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  avatar?: string
}

export type UserStatus = 'active' | 'disabled'

export interface ManagedUser extends AuthUser {
  status: UserStatus
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
}

export interface AuthSession {
  id: string
  user: AuthUser
  csrfTokenHash: string
  expiresAt: string
}

export function createOrUpdateUser(input: {
  username: string
  displayName: string
  password: string
  role: UserRole
}) {
  const username = normalizeUsername(input.username)
  const displayName = input.displayName.trim()
  if (!displayName || displayName.length > 80) throw new Error('显示名称不能为空，且不能超过 80 个字符。')
  validatePassword(input.password)
  const passwordHash = hashPassword(input.password)
  inImmediateTransaction((database) => {
    const existing = database.prepare('SELECT id, updated_at FROM users WHERE username = ? COLLATE NOCASE').get(username) as { id: string; updated_at?: string } | undefined
    const id = existing?.id ?? `user-${randomUUID()}`
    const timestamp = nextMonotonicIsoTimestamp(existing?.updated_at)
    database.prepare(`
      INSERT INTO users(id, username, display_name, password_hash, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        password_hash = excluded.password_hash,
        role = excluded.role,
        status = 'active',
        updated_at = excluded.updated_at
    `).run(id, username, displayName, passwordHash, input.role, timestamp, timestamp)
    if (existing) database.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id)
  })
  return getUserByUsername(username)!
}

export async function createManagedUser(input: {
  username: string
  displayName: string
  password: string
  role: UserRole
  actorId?: string
}): Promise<ManagedUser> {
  const username = normalizeUsername(input.username)
  const displayName = normalizeDisplayName(input.displayName)
  validatePassword(input.password)
  if (!isUserRole(input.role)) throw new Error('用户权限组无效。')
  const id = `user-${randomUUID()}`
  const passwordHash = await hashPasswordAsync(input.password)
  try {
    return inImmediateTransaction((database) => {
      if (input.actorId) {
        const actor = database.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(input.actorId)
        if (!actor) throw new Error('管理员权限已变更，请重新登录。')
      }
      const timestamp = nextMonotonicIsoTimestamp()
      database.prepare(`
        INSERT INTO users(id, username, display_name, password_hash, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(id, username, displayName, passwordHash, input.role, timestamp, timestamp)
      const row = database.prepare('SELECT id, username, display_name, role, status, avatar, created_at, updated_at, last_login_at FROM users WHERE id = ?').get(id) as Record<string, unknown>
      return managedUserFromRow(row)
    })
  } catch (error) {
    if (isUniqueUsernameError(error)) throw new Error('用户名已存在。')
    throw error
  }
}

export function listManagedUsers(pagination?: { limit: number; offset: number }): ManagedUser[] {
  const suffix = pagination ? ' LIMIT ? OFFSET ?' : ''
  const parameters = pagination ? [pagination.limit, pagination.offset] : []
  const rows = getDatabase().prepare(`
    SELECT id, username, display_name, role, status, avatar, created_at, updated_at, last_login_at
    FROM users
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, display_name COLLATE NOCASE, username COLLATE NOCASE${suffix}
  `).all(...parameters) as Array<Record<string, unknown>>
  return rows.map(managedUserFromRow)
}

export function countManagedUsers(): number {
  const row = getDatabase().prepare('SELECT COUNT(*) AS count FROM users').get() as { count?: unknown } | undefined
  return Number(row?.count ?? 0)
}

export function getManagedUserById(userId: string): ManagedUser | undefined {
  const row = getDatabase().prepare(`
    SELECT id, username, display_name, role, status, avatar, created_at, updated_at, last_login_at
    FROM users
    WHERE id = ?
  `).get(userId) as Record<string, unknown> | undefined
  return row ? managedUserFromRow(row) : undefined
}
export class ManagedUserUpdateConflictError extends Error {
  constructor() {
    super('用户信息已被其他管理员更新，请刷新后重试。')
    this.name = 'ManagedUserUpdateConflictError'
  }
}

export async function updateManagedUser(input: {
  id: string
  username: string
  displayName: string
  password?: string
  role: UserRole
  status: UserStatus
  expectedUpdatedAt?: string
  actorId?: string
}): Promise<ManagedUser | undefined> {
  const username = normalizeUsername(input.username)
  const displayName = normalizeDisplayName(input.displayName)
  if (!isUserRole(input.role)) throw new Error('用户权限组无效。')
  if (!isUserStatus(input.status)) throw new Error('用户状态无效。')
  const passwordHash = input.password ? (validatePassword(input.password), await hashPasswordAsync(input.password)) : undefined
  return inImmediateTransaction((database) => {
    if (input.actorId) {
      const actor = database.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(input.actorId)
      if (!actor) throw new Error('管理员权限已变更，请重新登录。')
    }
    if (input.actorId === input.id && (input.role !== 'admin' || input.status !== 'active')) {
      throw new Error('不能降低当前登录账号的管理员权限。')
    }
    const existing = database.prepare('SELECT username, role, status, updated_at FROM users WHERE id = ?').get(input.id) as { username?: string; role?: string; status?: string; updated_at?: string } | undefined
    if (!existing) return undefined
    if (input.expectedUpdatedAt && existing.updated_at !== input.expectedUpdatedAt) throw new ManagedUserUpdateConflictError()
    if (existing.status === 'active' && input.status !== 'active') {
      const ownedProject = database.prepare("SELECT 1 FROM project_members WHERE user_id = ? AND role = 'owner' LIMIT 1").get(input.id)
      if (ownedProject) throw new Error('该用户仍是课题负责人，请先转移负责人后再停用。')
    }
    if (existing.role === 'admin' && existing.status === 'active' && (input.role !== 'admin' || input.status !== 'active')) {
      const row = database.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?",
      ).get(input.id) as { count: number }
      if (row.count < 1) throw new Error('至少需要保留一名启用的管理员。')
    }

    const timestamp = nextMonotonicIsoTimestamp(existing.updated_at)
    try {
      if (passwordHash) {
        database.prepare(`
          UPDATE users
          SET username = ?, display_name = ?, password_hash = ?, role = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(username, displayName, passwordHash, input.role, input.status, timestamp, input.id)
      } else {
        database.prepare(`
          UPDATE users
          SET username = ?, display_name = ?, role = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(username, displayName, input.role, input.status, timestamp, input.id)
      }
    } catch (error) {
      if (isUniqueUsernameError(error)) throw new Error('用户名已存在。')
      throw error
    }
    if (passwordHash || existing.username !== username || existing.role !== input.role || existing.status !== input.status) {
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(input.id)
    }
    syncOwnedProjectOwnerNames(database, input.id)
    return getManagedUserById(input.id)
  })
}

export function deleteManagedUser(userId: string, actorId?: string): boolean {
  return inImmediateTransaction((database) => {
    if (actorId) {
      const actor = database.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(actorId)
      if (!actor) throw new Error('管理员权限已变更，请重新登录。')
    }
    const target = database.prepare(`
      SELECT id, role, status
      FROM users
      WHERE id = ?
    `).get(userId) as { id: string; role: UserRole; status: UserStatus } | undefined
    if (!target) return false

    if (target.role === 'admin' && target.status === 'active') {
      const otherActiveAdmins = database.prepare(`
        SELECT COUNT(*) AS count
        FROM users
        WHERE role = 'admin' AND status = 'active' AND id <> ?
      `).get(userId) as { count: number }
      if (otherActiveAdmins.count < 1) throw new Error('至少需要保留一名启用的管理员。')
    }

    const soleOwnerProjects = database.prepare(`
      SELECT COUNT(*) AS count
      FROM project_members membership
      WHERE membership.user_id = ?
        AND membership.role = 'owner'
        AND NOT EXISTS (
          SELECT 1
          FROM project_members other_membership
          WHERE other_membership.project_id = membership.project_id
            AND other_membership.role = 'owner'
            AND other_membership.user_id <> ?
        )
    `).get(userId, userId) as { count: number }
    if (soleOwnerProjects.count > 0) {
      throw new Error('该用户仍是课题唯一负责人，请先转交课题负责人后再删除。')
    }

    database.prepare('DELETE FROM users WHERE id = ?').run(userId)

    return true
  })
}

export function updateUserProfile(userId: string, input: {
  displayName: string
  avatar?: string
}): AuthUser {
  const displayName = normalizeDisplayName(input.displayName)
  const avatar = input.avatar !== undefined ? String(input.avatar).trim().slice(0, 1000) : undefined
  return inImmediateTransaction((database) => {
    const existing = database.prepare('SELECT updated_at FROM users WHERE id = ?').get(userId) as { updated_at?: string } | undefined
    if (!existing) throw new Error('用户不存在或已停用。')
    const timestamp = nextMonotonicIsoTimestamp(existing.updated_at)
    if (avatar !== undefined) {
      database.prepare(`
        UPDATE users
        SET display_name = ?, avatar = ?, updated_at = ?
        WHERE id = ?
      `).run(displayName, avatar || null, timestamp, userId)
    } else {
      database.prepare(`
        UPDATE users
        SET display_name = ?, updated_at = ?
        WHERE id = ?
      `).run(displayName, timestamp, userId)
    }

    syncOwnedProjectOwnerNames(database, userId)
    const row = database.prepare("SELECT id, username, display_name, role, avatar FROM users WHERE id = ? AND status = 'active'").get(userId) as Record<string, unknown> | undefined
    if (!row) throw new Error('用户不存在或已停用。')
    return userFromRow(row)
  })
}


export function getActiveUserById(userId: string): AuthUser | undefined {
  return getActiveUsersByIds([userId])[0]
}

export function getActiveUsersByIds(ids: string[]): Array<AuthUser | undefined> {
  if (!ids.length) return []
  const uniqueIds = [...new Set(ids)]
  const rows = getDatabase().prepare(`
    SELECT id, username, display_name, role, avatar
    FROM users
    WHERE status = 'active' AND id IN (${uniqueIds.map(() => '?').join(', ')})
  `).all(...uniqueIds) as Array<Record<string, unknown>>
  const users = new Map(rows.map((row) => [String(row.id), userFromRow(row)] as const))
  return ids.map((id) => users.get(id))
}

export function listActiveUsers(pagination?: { limit: number; offset: number }): AuthUser[] {
  const suffix = pagination ? ' LIMIT ? OFFSET ?' : ''
  const parameters = pagination ? [pagination.limit, pagination.offset] : []
  const rows = getDatabase().prepare(`
    SELECT id, username, display_name, role, avatar
    FROM users
    WHERE status = 'active'
    ORDER BY display_name COLLATE NOCASE, username COLLATE NOCASE${suffix}
  `).all(...parameters) as Array<Record<string, unknown>>
  return rows.map(userFromRow)
}

export function countActiveUsers(): number {
  const row = getDatabase().prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'active'").get() as { count?: unknown } | undefined
  return Number(row?.count ?? 0)
}
export class AuthenticationBusyError extends Error {
  constructor() {
    super('登录服务繁忙，请稍后再试。')
    this.name = 'AuthenticationBusyError'
  }
}

const maxConcurrentAuthentications = runtimeConfig.auth.maxConcurrent
const maxQueuedAuthentications = runtimeConfig.auth.maxQueued
let activeAuthentications = 0
const authenticationWaiters: Array<() => void> = []

async function acquireAuthenticationSlot() {
  if (activeAuthentications < maxConcurrentAuthentications) {
    activeAuthentications += 1
    return
  }
  if (authenticationWaiters.length >= maxQueuedAuthentications) throw new AuthenticationBusyError()
  await new Promise<void>((resolve) => authenticationWaiters.push(resolve))
  activeAuthentications += 1
}

function releaseAuthenticationSlot() {
  activeAuthentications = Math.max(0, activeAuthentications - 1)
  authenticationWaiters.shift()?.()
}

export async function authenticateUserAsync(usernameInput: string, password: string): Promise<AuthUser | undefined> {
  await acquireAuthenticationSlot()
  try {
    let username: string
    try {
      username = normalizeUsername(usernameInput)
    } catch {
      await verifyPasswordAsync(password, dummyPasswordHash)
      return undefined
    }
    const row = getDatabase().prepare(`
    SELECT id, username, display_name, password_hash, role, status, avatar
    FROM users WHERE username = ? COLLATE NOCASE
  `).get(username) as Record<string, unknown> | undefined
    const candidateHash = row && row.status === 'active' ? String(row.password_hash) : dummyPasswordHash
    const valid = await verifyPasswordAsync(password, candidateHash)
    if (!row || row.status !== 'active' || !valid) return undefined
    const timestamp = now()
    const authenticated = getDatabase().prepare(`
      UPDATE users SET last_login_at = ?
      WHERE id = ? AND status = 'active' AND password_hash = ?
    `).run(timestamp, String(row.id), String(row.password_hash))
    return Number(authenticated.changes) === 1 ? userFromRow(row) : undefined
  } finally {
    releaseAuthenticationSlot()
  }
}

export function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  const timestamp = now()
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString()
  const id = `session-${randomUUID()}`
  inImmediateTransaction((database) => {
    database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(timestamp)
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    database.prepare(`
      INSERT INTO sessions(id, user_id, token_hash, csrf_token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, digest(token), digest(csrfToken), expiresAt, timestamp)
  })
  return { token, csrfToken, expiresAt }
}

export function getSessionByToken(token: string | undefined): AuthSession | undefined {
  if (!token || token.length > 256) return undefined
  const row = getDatabase().prepare(`
    SELECT session.id AS session_id, session.csrf_token_hash, session.expires_at,
           user.id, user.username, user.display_name, user.role, user.status, user.avatar
    FROM sessions session
    JOIN users user ON user.id = session.user_id
    WHERE session.token_hash = ? AND session.expires_at > ? AND user.status = 'active'
  `).get(digest(token), now()) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    id: String(row.session_id),
    user: userFromRow(row),
    csrfTokenHash: String(row.csrf_token_hash),
    expiresAt: String(row.expires_at),
  }
}

export function deleteSession(token: string | undefined) {
  if (!token) return
  getDatabase().prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token))
}

export function verifyCsrf(session: AuthSession, token: string | undefined) {
  if (!token || token.length > 256) return false
  return safeEqual(session.csrfTokenHash, digest(token))
}

export function parseCookieHeader(header: string | null) {
  const cookies = new Map<string, string>()
  const seenNames = new Set<string>()
  const invalidNames = new Set<string>()
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    const name = (separator >= 0 ? part.slice(0, separator) : part).trim()
    if (!name || !/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(name)) continue
    // 即使首个值畸形、超长或无法 URI 解码，也要占用该名称；
    // 否则攻击者可用第二个合法同名 Cookie 绕过重复 Cookie 拒绝。
    if (seenNames.has(name) || invalidNames.has(name)) {
      cookies.delete(name)
      invalidNames.add(name)
      continue
    }
    seenNames.add(name)
    if (separator < 1) continue
    const value = part.slice(separator + 1).trim()
    if (value.length > 4096) continue
    try {
      const decoded = decodeURIComponent(value)
      if (decoded.length <= 4096) cookies.set(name, decoded)
    } catch { /* ignore malformed cookie */ }
  }
  return cookies
}

export function isUserRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'researcher'
}

export function isUserStatus(value: unknown): value is UserStatus {
  return value === 'active' || value === 'disabled'
}

function normalizeDisplayName(value: string) {
  const displayName = value.trim()
  if (!displayName || displayName.length > 80) throw new Error('显示名称不能为空，且不能超过 80 个字符。')
  return displayName
}

function normalizeUsername(value: string) {
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error('用户名必须为 3-32 位小写字母、数字、点、下划线或连字符。')
  }
  return username
}

function validatePassword(password: string) {
  if (password.length < 12 || password.length > 128) throw new Error('密码长度必须为 12-128 个字符。')
}

function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = scrypt(password, salt)
  return encodePasswordHash(salt, hash)
}

async function hashPasswordAsync(password: string) {
  await acquireAuthenticationSlot()
  try {
    const salt = randomBytes(16)
    const hash = await scryptAsyncPromise(password, salt)
    return encodePasswordHash(salt, hash)
  } finally {
    releaseAuthenticationSlot()
  }
}

function encodePasswordHash(salt: Buffer, hash: Buffer) {
  return ['scrypt', scryptWorkFactor, scryptBlockSize, scryptParallelization, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

async function verifyPasswordAsync(password: string, encoded: string): Promise<boolean> {
  try {
    const [algorithm, workFactorText, blockSizeText, parallelizationText, saltText, hashText] = encoded.split('$')
    if (algorithm !== 'scrypt') return false
    const workFactor = Number(workFactorText)
    const blockSize = Number(blockSizeText)
    const parallelization = Number(parallelizationText)
    if (workFactor !== scryptWorkFactor || blockSize !== scryptBlockSize || parallelization !== scryptParallelization) return false
    const salt = Buffer.from(saltText, 'base64url')
    const expected = Buffer.from(hashText, 'base64url')
    const actual = await scryptAsyncPromise(password, salt)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
function scryptAsyncPromise(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptAsync(password, salt, scryptKeyLength, {
      N: scryptWorkFactor,
      r: scryptBlockSize,
      p: scryptParallelization,
      maxmem: scryptMaxMemory,
    }, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

function scrypt(password: string, salt: Buffer) {
  return scryptSync(password, salt, scryptKeyLength, {
    N: scryptWorkFactor,
    r: scryptBlockSize,
    p: scryptParallelization,
    maxmem: scryptMaxMemory,
  })
}

function userFromRow(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: String(row.role) as UserRole,
    avatar: row.avatar ? String(row.avatar) : undefined,
  }
}

function managedUserFromRow(row: Record<string, unknown>): ManagedUser {
  return {
    ...userFromRow(row),
    status: String(row.status) as UserStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastLoginAt: row.last_login_at === null || row.last_login_at === undefined ? undefined : String(row.last_login_at),
  }
}

function isUniqueUsernameError(error: unknown) {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed: users.username')
}

function getUserByUsername(username: string) {
  const row = getDatabase().prepare('SELECT id, username, display_name, role, avatar FROM users WHERE username = ? COLLATE NOCASE').get(username) as Record<string, unknown> | undefined
  return row ? userFromRow(row) : undefined
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function now() {
  return new Date().toISOString()
}

function syncOwnedProjectOwnerNames(database: ReturnType<typeof getDatabase>, userId: string) {
  const rows = database.prepare(`
    SELECT projects.id AS id, projects.updated_at AS updated_at
    FROM projects
    INNER JOIN project_members ON project_members.project_id = projects.id
    WHERE project_members.user_id = ? AND project_members.role = 'owner'
  `).all(userId) as Array<{ id: string; updated_at: string }>
  const update = database.prepare(`
    UPDATE projects
    SET owner_name = (
      SELECT owner_users.display_name
      FROM project_members owner_members
      INNER JOIN users owner_users ON owner_users.id = owner_members.user_id
      WHERE owner_members.project_id = projects.id AND owner_members.role = 'owner'
      LIMIT 1
    ),
    updated_at = ?
    WHERE id = ?
  `)
  for (const row of rows) {
    update.run(nextMonotonicIsoTimestamp(row.updated_at), row.id)
  }
}

const dummyPasswordHash = ['scrypt', scryptWorkFactor, scryptBlockSize, scryptParallelization, Buffer.alloc(16).toString('base64url'), Buffer.alloc(scryptKeyLength).toString('base64url')].join('$')
