import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(`${tmpdir()}/yanxing-project-members-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'project-members-test.sqlite')

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getProject, getUserProjectRole, createProjectForUser } = await import('../lib/db/repository')
const { GET: listMembers, PUT: saveMembers } = await import('../app/api/admin/projects/[projectId]/members/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function request(token: string, projectId: string, method: 'GET' | 'PUT', body?: unknown) {
  return {
    request: new Request(`http://localhost/api/admin/projects/${projectId}/members`, {
      method,
      headers: {
        cookie: `${sessionCookieName}=${encodeURIComponent(token)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    context: { params: Promise.resolve({ projectId }) },
  }
}

test('administrators manage members with a single owner and at most three collaborators', async () => {
  const admin = createOrUpdateUser({ username: 'members-admin', displayName: '成员管理员', password: 'members-admin-123', role: 'admin' })
  const owner = createOrUpdateUser({ username: 'members-owner', displayName: '原负责人', password: 'members-owner-123', role: 'researcher' })
  const editor = createOrUpdateUser({ username: 'members-editor', displayName: '编辑研究员', password: 'members-editor-123', role: 'researcher' })
  const extra = createOrUpdateUser({ username: 'members-extra', displayName: '额外研究员', password: 'members-extra-123', role: 'researcher' })
  const extraTwo = createOrUpdateUser({ username: 'members-extra-two', displayName: '额外研究员二', password: 'members-extra-two-123', role: 'researcher' })
  const extraThree = createOrUpdateUser({ username: 'members-extra-three', displayName: '额外研究员三', password: 'members-extra-three-123', role: 'researcher' })
  const project = createProjectForUser({ title: '权限组测试课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const adminSession = createSession(admin.id)
  const ownerSession = createSession(owner.id)

  assert.equal((await listMembers(request(ownerSession.token, project.id, 'GET').request, request(ownerSession.token, project.id, 'GET').context)).status, 403)
  const listed = await listMembers(request(adminSession.token, project.id, 'GET').request, request(adminSession.token, project.id, 'GET').context)
  assert.equal(listed.status, 200)
  const listedBody = await listed.json() as { revision: number; members: Array<{ userId: string; role: string }> }
  assert.deepEqual(listedBody.members.map((member) => ({ userId: member.userId, role: member.role })), [{ userId: owner.id, role: 'owner' }])

  const saved = await saveMembers(...Object.values(request(adminSession.token, project.id, 'PUT', {
    revision: listedBody.revision,
    members: [
      { userId: owner.id, role: 'editor' },
      { userId: editor.id, role: 'owner' },
    ],
  })) as [Request, { params: Promise<{ projectId: string }> }])
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as { revision?: number }
  assert.equal(getUserProjectRole(project.id, owner), 'editor')
  assert.equal(getUserProjectRole(project.id, editor), 'owner')
  assert.equal(getProject(project.id)?.ownerName, '编辑研究员')

  const conflict = await saveMembers(...Object.values(request(adminSession.token, project.id, 'PUT', {
    revision: listedBody.revision,
    members: [
      { userId: owner.id, role: 'editor' },
      { userId: editor.id, role: 'owner' },
    ],
  })) as [Request, { params: Promise<{ projectId: string }> }])
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).code, 'MEMBERSHIP_CONFLICT')

  const noOwner = await saveMembers(...Object.values(request(adminSession.token, project.id, 'PUT', { revision: savedBody.revision, members: [{ userId: owner.id, role: 'editor' }] })) as [Request, { params: Promise<{ projectId: string }> }])
  assert.equal(noOwner.status, 400)

  const twoOwners = await saveMembers(...Object.values(request(adminSession.token, project.id, 'PUT', {
    revision: savedBody.revision,
    members: [
      { userId: owner.id, role: 'owner' },
      { userId: editor.id, role: 'owner' },
    ],
  })) as [Request, { params: Promise<{ projectId: string }> }])
  assert.equal(twoOwners.status, 400)
  assert.match(((await twoOwners.json()) as { error?: string }).error ?? '', /有且只有一名负责人|有且仅有一名负责人/)

  const tooMany = await saveMembers(...Object.values(request(adminSession.token, project.id, 'PUT', {
    revision: savedBody.revision,
    members: [
      { userId: editor.id, role: 'owner' },
      { userId: owner.id, role: 'editor' },
      { userId: extra.id, role: 'editor' },
      { userId: extraTwo.id, role: 'editor' },
      { userId: extraThree.id, role: 'editor' },
    ],
  })) as [Request, { params: Promise<{ projectId: string }> }])
  assert.equal(tooMany.status, 400)
  assert.match(((await tooMany.json()) as { error?: string }).error ?? '', /协作者不能超过 3 人/)
})
