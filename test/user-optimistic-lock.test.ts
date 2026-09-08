import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const directory = await mkdtemp(tmpdir() + '/yanxing-user-lock-')
const databasePath = path.join(directory, 'user-lock.sqlite')
process.env.YANXING_DATABASE_PATH = databasePath

const { migrateDatabase, getDatabase } = await import('../lib/db/client')
const {
  createOrUpdateUser,
  createManagedUser,
  getManagedUserById,
  listManagedUsers,
  ManagedUserUpdateConflictError,
  updateManagedUser,
  updateUserProfile,
} = await import('../lib/auth/session')
const { createProjectForUser, ProjectUpdateConflictError, replaceProjectMembers, updateProject } = await import('../lib/db/repository')
const { nextMonotonicIsoTimestamp } = await import('../lib/monotonic-iso-timestamp')

migrateDatabase()

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function freezeNow(iso: string) {
  const frozen = Date.parse(iso)
  const original = Date.now
  Date.now = () => frozen
  return { frozen, restore() { Date.now = original } }
}

function seedUser(username: string) {
  const created = createOrUpdateUser({
    username,
    displayName: username,
    password: 'password-lock-123',
    role: 'admin',
  })
  return getManagedUserById(created.id)!
}

test('monotonic helper keeps empty values and rejects invalid dates', () => {
  assert.match(nextMonotonicIsoTimestamp(), /^\d{4}-\d{2}-\d{2}T/)
  assert.throws(() => nextMonotonicIsoTimestamp('not-a-date'), /记录版本时间无效/)
  const clock = freezeNow('2026-01-01T00:00:00.000Z')
  try {
    assert.equal(nextMonotonicIsoTimestamp('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.001Z')
    Date.now = () => clock.frozen - 10_000
    assert.equal(nextMonotonicIsoTimestamp('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.001Z')
  } finally {
    clock.restore()
  }
})

test('frozen clock second update with the old updatedAt conflicts', async () => {
  const user = seedUser('lock-frozen')
  const createdAt = user.createdAt
  const clock = freezeNow(user.updatedAt)
  try {
    const first = await updateManagedUser({
      id: user.id,
      username: user.username,
      displayName: '一次更新',
      role: user.role,
      status: user.status,
      expectedUpdatedAt: user.updatedAt,
    })
    assert.ok(first)
    assert.equal(first.createdAt, createdAt)
    assert.ok(Date.parse(first.updatedAt) > clock.frozen)
    await assert.rejects(
      () => updateManagedUser({
        id: user.id,
        username: user.username,
        displayName: '二次旧稿',
        role: user.role,
        status: user.status,
        expectedUpdatedAt: user.updatedAt,
      }),
      (error: unknown) => error instanceof ManagedUserUpdateConflictError,
    )
  } finally {
    clock.restore()
  }
})

test('clock rollback still produces a newer user version', async () => {
  const user = seedUser('lock-rollback')
  const clock = freezeNow(user.updatedAt)
  Date.now = () => clock.frozen - 60_000
  try {
    const updated = await updateManagedUser({
      id: user.id,
      username: user.username,
      displayName: '回拨后更新',
      role: user.role,
      status: user.status,
      expectedUpdatedAt: user.updatedAt,
    })
    assert.ok(updated)
    assert.ok(Date.parse(updated.updatedAt) > Date.parse(user.updatedAt))
  } finally {
    clock.restore()
  }
})

test('invalid stored updatedAt is not reset by a later write', async () => {
  const user = seedUser('lock-invalid')
  getDatabase().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run('not-a-date', user.id)
  await assert.rejects(
    () => updateManagedUser({
      id: user.id,
      username: user.username,
      displayName: '无效版本',
      role: user.role,
      status: user.status,
      expectedUpdatedAt: 'not-a-date',
    }),
    /记录版本时间无效/
  )
  assert.equal(getManagedUserById(user.id)?.updatedAt, 'not-a-date')
})

test('profile updates bump the version used by managed-user drafts', async () => {
  const user = seedUser('lock-profile')
  updateUserProfile(user.id, { displayName: '资料改名' })
  await assert.rejects(
    () => updateManagedUser({
      id: user.id,
      username: user.username,
      displayName: '管理旧稿',
      role: user.role,
      status: user.status,
      expectedUpdatedAt: user.updatedAt,
    }),
    (error: unknown) => error instanceof ManagedUserUpdateConflictError,
  )
})

test('a second sqlite connection cannot apply a stale updatedAt write', async () => {
  const user = seedUser('lock-dual')
  const clock = freezeNow(user.updatedAt)
  try {
    const first = await updateManagedUser({
      id: user.id,
      username: user.username,
      displayName: '连接一',
      role: user.role,
      status: user.status,
      expectedUpdatedAt: user.updatedAt,
    })
    assert.ok(first)
    const second = new DatabaseSync(databasePath)
    try {
      const observed = second.prepare('SELECT updated_at FROM users WHERE id = ?').get(user.id) as { updated_at: string }
      assert.equal(observed.updated_at, first.updatedAt)
      const stale = second.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ? AND updated_at = ?').run('陈旧写入', user.updatedAt, user.id, user.updatedAt)
      assert.equal(Number(stale.changes), 0)
    } finally {
      second.close()
    }
  } finally {
    clock.restore()
  }
})

test('frozen clock project updates conflict instead of sharing a timestamp', () => {
  const owner = createOrUpdateUser({ username: 'lock-project-owner', displayName: '课题负责人', password: 'password-lock-123', role: 'researcher' })
  const project = createProjectForUser({ title: '版本课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const clock = freezeNow(project.updatedAt)
  try {
    const first = updateProject(project.id, { title: '一次课题' }, { expectedUpdatedAt: project.updatedAt })
    assert.ok(first)
    assert.ok(Date.parse(first.updatedAt) > clock.frozen)
    assert.throws(
      () => updateProject(project.id, { title: '二次旧稿' }, { expectedUpdatedAt: project.updatedAt }),
      (error: unknown) => error instanceof ProjectUpdateConflictError,
    )
  } finally {
    clock.restore()
  }
})

test('membership writes bump project updatedAt even when the clock is frozen', () => {
  const owner = createOrUpdateUser({ username: 'lock-member-owner', displayName: '成员负责人', password: 'password-lock-123', role: 'researcher' })
  const editor = createOrUpdateUser({ username: 'lock-member-editor', displayName: '成员编辑', password: 'password-lock-123', role: 'researcher' })
  const project = createProjectForUser({ title: '成员版本课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const clock = freezeNow(project.updatedAt)
  try {
    const members = replaceProjectMembers(project.id, [
      { userId: owner.id, role: 'owner' },
      { userId: editor.id, role: 'editor' },
    ])
    assert.ok(members)
    assert.throws(
      () => updateProject(project.id, { title: '旧课题稿' }, { expectedUpdatedAt: project.updatedAt }),
      (error: unknown) => error instanceof ProjectUpdateConflictError,
    )
  } finally {
    clock.restore()
  }
})

test('password hashing happens before the write lock so a fast update wins the version', async () => {
  const user = await createManagedUser({
    username: 'lock-hash-user',
    displayName: '哈希用户',
    password: 'password-lock-123',
    role: 'researcher',
  })
  let listedDuringHash = false
  const slow = updateManagedUser({
    id: user.id,
    username: user.username,
    displayName: '慢改密',
    password: 'password-lock-999',
    role: user.role,
    status: user.status,
    expectedUpdatedAt: user.updatedAt,
  })
  await new Promise((resolve) => setImmediate(resolve))
  listManagedUsers()
  listedDuringHash = true
  const fast = updateManagedUser({
    id: user.id,
    username: user.username,
    displayName: '快改名',
    role: user.role,
    status: user.status,
    expectedUpdatedAt: user.updatedAt,
  })
  const [slowResult, fastResult] = await Promise.allSettled([slow, fast])
  assert.equal(listedDuringHash, true)
  assert.equal(fastResult.status, 'fulfilled')
  assert.equal(slowResult.status, 'rejected')
  if (slowResult.status === 'rejected') assert.ok(slowResult.reason instanceof ManagedUserUpdateConflictError)
  if (fastResult.status === 'fulfilled') assert.equal(fastResult.value?.displayName, '快改名')
})
