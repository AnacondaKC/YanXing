import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(`${tmpdir()}/yanxing-user-management-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'user-management-test.sqlite')

const { authenticateUserAsync, createOrUpdateUser, createSession, getManagedUserById, sessionCookieName, updateManagedUser } = await import('../lib/auth/session')
const { createProjectForUser, listProjectsForUser } = await import('../lib/db/repository')
const { GET: listUsers, POST: createUser } = await import('../app/api/admin/users/route')
const { DELETE: deleteUser, PATCH: updateUser } = await import('../app/api/admin/users/[userId]/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function requestFor(token: string | undefined, body?: unknown) {
  return new Request('http://localhost/api/admin/users', {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function deleteRequest(token: string | undefined, userId: string) {
  return deleteUser(new Request(`http://localhost/api/admin/users/${userId}`, {
    method: 'DELETE',
    headers: token ? { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` } : {},
  }), { params: Promise.resolve({ userId }) })
}

function patchRequest(token: string, userId: string, body: Record<string, unknown>) {
  const current = getManagedUserById(userId)
  return updateUser(new Request(`http://localhost/api/admin/users/${userId}`, {
    method: 'PATCH',
    headers: {
      cookie: `${sessionCookieName}=${encodeURIComponent(token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...(current ? { updatedAt: current.updatedAt } : {}),
      ...body,
    }),
  }), { params: Promise.resolve({ userId }) })
}

test('user management is administrator-only and supports account lifecycle changes', async () => {
  const admin = createOrUpdateUser({ username: 'management-admin', displayName: '管理管理员', password: 'management-admin-123', role: 'admin' })
  const researcher = createOrUpdateUser({ username: 'management-researcher', displayName: '管理研究员', password: 'management-researcher-123', role: 'researcher' })
  const adminSession = createSession(admin.id)
  const researcherSession = createSession(researcher.id)

  assert.equal((await listUsers(requestFor(undefined))).status, 401)
  assert.equal((await listUsers(requestFor(researcherSession.token))).status, 403)

  const listed = await listUsers(requestFor(adminSession.token))
  assert.equal(listed.status, 200)
  const listedBody = await listed.json() as { users: Array<{ username: string; status: string }> }
  assert.ok(listedBody.users.some((user) => user.username === 'management-admin' && user.status === 'active'))

  const created = await createUser(requestFor(adminSession.token, {
    username: 'managed-user',
    displayName: '待管理用户',
    password: 'managed-user-123',
    role: 'researcher',
  }))
  assert.equal(created.status, 201)
  const createdBody = await created.json() as { user: { id: string; role: string; status: string } }
  assert.equal(createdBody.user.role, 'researcher')
  assert.equal(createdBody.user.status, 'active')

  const updated = await patchRequest(adminSession.token, createdBody.user.id, {
    username: 'managed-admin',
    displayName: '已管理用户',
    password: 'managed-admin-123',
    role: 'admin',
    status: 'active',
  })
  assert.equal(updated.status, 200)
  assert.equal((await authenticateUserAsync('managed-admin', 'managed-admin-123'))?.role, 'admin')

  const disabled = await patchRequest(adminSession.token, createdBody.user.id, {
    username: 'managed-admin',
    displayName: '已管理用户',
    role: 'admin',
    status: 'disabled',
  })
  assert.equal(disabled.status, 200)
  assert.equal(await authenticateUserAsync('managed-admin', 'managed-admin-123'), undefined)

  const lastAdmin = await patchRequest(adminSession.token, admin.id, {
    username: 'management-admin',
    displayName: '管理管理员',
    role: 'researcher',
    status: 'disabled',
  })
  assert.equal(lastAdmin.status, 400)
})

test('PATCH /api/admin/users/[userId] requires a valid updatedAt', async () => {
  const admin = createOrUpdateUser({ username: 'lock-admin', displayName: '锁管理员', password: 'lock-admin-123', role: 'admin' })
  const target = createOrUpdateUser({ username: 'lock-user', displayName: '锁用户', password: 'lock-user-123', role: 'researcher' })
  const session = createSession(admin.id)
  const payload = {
    username: 'lock-user',
    displayName: '锁用户',
    role: 'researcher',
    status: 'active',
  }
  const missing = await updateUser(new Request(`http://localhost/api/admin/users/${target.id}`, {
    method: 'PATCH',
    headers: {
      cookie: `${sessionCookieName}=${encodeURIComponent(session.token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  }), { params: Promise.resolve({ userId: target.id }) })
  assert.equal(missing.status, 400)
  const invalid = await patchRequest(session.token, target.id, { ...payload, updatedAt: 'not-a-date' })
  assert.equal(invalid.status, 400)
})

test('administrators can delete users while preserving account and project safeguards', async () => {
  const admin = createOrUpdateUser({ username: 'delete-admin', displayName: '删除管理员', password: 'delete-admin-123', role: 'admin' })
  const researcher = createOrUpdateUser({ username: 'delete-researcher', displayName: '删除研究员', password: 'delete-researcher-123', role: 'researcher' })
  const target = createOrUpdateUser({ username: 'delete-target', displayName: '待删除用户', password: 'delete-target-123', role: 'researcher' })
  const adminSession = createSession(admin.id)
  const researcherSession = createSession(researcher.id)
  const targetSession = createSession(target.id)

  assert.equal((await deleteRequest(undefined, target.id)).status, 401)
  assert.equal((await deleteRequest(researcherSession.token, target.id)).status, 403)
  const selfDelete = await deleteRequest(adminSession.token, admin.id)
  assert.equal(selfDelete.status, 400)
  assert.match((await selfDelete.json() as { error?: string }).error ?? '', /不能删除当前登录账号/)

  const deleted = await deleteRequest(adminSession.token, target.id)
  assert.equal(deleted.status, 200)
  assert.equal(await authenticateUserAsync('delete-target', 'delete-target-123'), undefined)
  assert.equal((await listUsers(requestFor(targetSession.token))).status, 401)
  const afterDeletion = await listUsers(requestFor(adminSession.token))
  const afterDeletionBody = await afterDeletion.json() as { users: Array<{ id: string }> }
  assert.equal(afterDeletionBody.users.some((user) => user.id === target.id), false)

  const soleOwner = createOrUpdateUser({ username: 'sole-owner', displayName: '唯一负责人', password: 'sole-owner-123', role: 'researcher' })
  createProjectForUser({ title: '唯一负责人课题', objective: '', description: '', ownerName: soleOwner.displayName }, soleOwner.id)
  const ownerDeletion = await deleteRequest(adminSession.token, soleOwner.id)
  assert.equal(ownerDeletion.status, 400)
  assert.match((await ownerDeletion.json() as { error?: string }).error ?? '', /唯一负责人/)
  assert.ok(await authenticateUserAsync('sole-owner', 'sole-owner-123'))

  const departingCollaborator = createOrUpdateUser({ username: 'departing-collaborator', displayName: '待移除协作者', password: 'departing-collaborator-123', role: 'researcher' })
  const survivingOwner = createOrUpdateUser({ username: 'surviving-owner', displayName: '保留负责人', password: 'surviving-owner-123', role: 'researcher' })
  const sharedProject = createProjectForUser({
    title: '含协作者课题',
    objective: '',
    description: '',
    ownerName: survivingOwner.displayName,
  }, survivingOwner.id, survivingOwner.id, [departingCollaborator.id])
  const collaboratorDeletion = await deleteRequest(adminSession.token, departingCollaborator.id)
  assert.equal(collaboratorDeletion.status, 200)
  const survivingProject = listProjectsForUser(survivingOwner).find((project) => project.id === sharedProject.id)
  assert.equal(survivingProject?.ownerName, survivingOwner.displayName)
})

test('users can update their own profile including displayName and avatar', async () => {
  const { PATCH: updateMe, GET: getMe } = await import('../app/api/auth/me/route')
  const { NextRequest } = await import('next/server')
  const user = createOrUpdateUser({ username: 'profile-user', displayName: '初始名称', password: 'password-123', role: 'researcher' })
  const session = createSession(user.id)

  const unauthed = await updateMe(new NextRequest('http://localhost/api/auth/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '新名称' }),
  }))
  assert.equal(unauthed.status, 401)

  const emptyName = await updateMe(new NextRequest('http://localhost/api/auth/me', {
    method: 'PATCH',
    headers: {
      cookie: `${sessionCookieName}=${encodeURIComponent(session.token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: '   ' }),
  }))
  assert.equal(emptyName.status, 400)

  const updated = await updateMe(new NextRequest('http://localhost/api/auth/me', {
    method: 'PATCH',
    headers: {
      cookie: `${sessionCookieName}=${encodeURIComponent(session.token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: '自定义名称', avatar: '🦉' }),
  }))
  assert.equal(updated.status, 200)
  const body = await updated.json() as { user: { displayName: string; avatar: string } }
  assert.equal(body.user.displayName, '自定义名称')
  assert.equal(body.user.avatar, '🦉')

  const verified = await getMe(new NextRequest('http://localhost/api/auth/me', {
    headers: {
      cookie: `${sessionCookieName}=${encodeURIComponent(session.token)}`,
    },
  }))
  assert.equal(verified.status, 200)
  const verifiedBody = await verified.json() as { user: { displayName: string; avatar: string } }
  assert.equal(verifiedBody.user.displayName, '自定义名称')
  assert.equal(verifiedBody.user.avatar, '🦉')

  const unchanged = await updateMe(new NextRequest('http://localhost/api/auth/me', {
    method: 'PATCH',
    headers: {
      cookie: `${sessionCookieName}=${encodeURIComponent(session.token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: '自定义名称', avatar: 1 }),
  }))
  assert.equal(unchanged.status, 200)
  const unchangedBody = await unchanged.json() as { user: { displayName: string; avatar?: string } }
  assert.equal(unchangedBody.user.avatar, '🦉')

  const cleared = await updateMe(new NextRequest('http://localhost/api/auth/me', {
    method: 'PATCH',
    headers: {
      cookie: `${sessionCookieName}=${encodeURIComponent(session.token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: '自定义名称', avatar: '   ' }),
  }))
  assert.equal(cleared.status, 200)
  const clearedBody = await cleared.json() as { user: { displayName: string; avatar?: string } }
  assert.equal(clearedBody.user.displayName, '自定义名称')
  assert.equal(clearedBody.user.avatar, undefined)
})

test('delayed admin demotion after PATCH and DELETE params still returns 403', async () => {
  const superAdmin = createOrUpdateUser({ username: 'delayed-super', displayName: '监督管理员', password: 'delayed-super-123', role: 'admin' })
  const admin = createOrUpdateUser({ username: 'delayed-admin', displayName: '延迟管理员', password: 'delayed-admin-123', role: 'admin' })
  const target = createOrUpdateUser({ username: 'delayed-target', displayName: '延迟目标', password: 'delayed-target-123', role: 'researcher' })
  const adminSession = createSession(admin.id)

  let resolvePatchParams!: (value: { userId: string }) => void
  const patchParams = new Promise<{ userId: string }>((resolve) => {
    resolvePatchParams = resolve
  })
  const patchPending = updateUser(new Request(`http://localhost/api/admin/users/${target.id}`, {
    method: 'PATCH',
    headers: {
      cookie: `${sessionCookieName}=${encodeURIComponent(adminSession.token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'delayed-target',
      displayName: '延迟目标',
      role: 'researcher',
      status: 'active',
      updatedAt: getManagedUserById(target.id)?.updatedAt,
    }),
  }), { params: patchParams })
  await Promise.resolve()
  await updateManagedUser({
    id: admin.id,
    username: 'delayed-admin',
    displayName: '延迟管理员',
    role: 'researcher',
    status: 'active',
    expectedUpdatedAt: getManagedUserById(admin.id)?.updatedAt,
    actorId: superAdmin.id,
  })
  resolvePatchParams({ userId: target.id })
  const patched = await patchPending
  assert.equal(patched.status, 403)
  assert.match((await patched.json() as { error?: string }).error ?? '', /管理员权限已变更/)

  const restored = createOrUpdateUser({ username: 'delayed-admin', displayName: '延迟管理员', password: 'delayed-admin-123', role: 'admin' })
  const restoredSession = createSession(restored.id)
  let resolveDeleteParams!: (value: { userId: string }) => void
  const deleteParams = new Promise<{ userId: string }>((resolve) => {
    resolveDeleteParams = resolve
  })
  const deletePending = deleteUser(new Request(`http://localhost/api/admin/users/${target.id}`, {
    method: 'DELETE',
    headers: { cookie: `${sessionCookieName}=${encodeURIComponent(restoredSession.token)}` },
  }), { params: deleteParams })
  await Promise.resolve()
  await updateManagedUser({
    id: restored.id,
    username: 'delayed-admin',
    displayName: '延迟管理员',
    role: 'researcher',
    status: 'active',
    expectedUpdatedAt: getManagedUserById(restored.id)?.updatedAt,
    actorId: superAdmin.id,
  })
  resolveDeleteParams({ userId: target.id })
  const deleted = await deletePending
  assert.equal(deleted.status, 403)
  assert.match((await deleted.json() as { error?: string }).error ?? '', /管理员权限已变更/)
})
