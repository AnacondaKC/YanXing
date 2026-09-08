import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-notifications-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'notifications-test.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'notifications-test-encryption-key'

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { createProjectForUser } = await import('../lib/db/repository')
const { getDatabase } = await import('../lib/db/client')
const { listNotificationsForUser, markNotificationsRead, recordActivity } = await import('../lib/notifications')
const { notificationActions } = await import('../modules/notifications/domain')
const { GET: listNotifications, PATCH: patchNotifications } = await import('../app/api/notifications/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('notification recipients, role projection, read isolation, and pagination are enforced', async () => {
  const admin = createOrUpdateUser({ username: 'notification-admin', displayName: '通知管理员', password: 'notification-admin-password1', role: 'admin' })
  const owner = createOrUpdateUser({ username: 'notification-owner', displayName: '课题负责人', password: 'notification-owner-password1', role: 'researcher' })
  const editor = createOrUpdateUser({ username: 'notification-editor', displayName: '课题编辑', password: 'notification-editor-password1', role: 'researcher' })
  const outsider = createOrUpdateUser({ username: 'notification-outsider', displayName: '旁观研究员', password: 'notification-outsider-password1', role: 'researcher' })
  const project = createProjectForUser({
    title: '通知权限测试课题',
    objective: '验证通知收件人和角色投影',
    description: '',
    ownerName: owner.displayName,
  }, owner.id, owner.id, [editor.id])

  const record = (summary: string) => recordActivity({
    action: notificationActions.projectUpdated,
    actor: owner,
    projectId: project.id,
    projectTitle: project.title,
    summary,
    detail: '负责人执行了包含内部行为信息的详细操作记录。',
  })

  record('第一次更新课题')
  const adminFirst = listNotificationsForUser(admin, { limit: 100, offset: 0 })
  const ownerFirst = listNotificationsForUser(owner, { limit: 100, offset: 0 })
  const editorFirst = listNotificationsForUser(editor, { limit: 100, offset: 0 })
  const outsiderFirst = listNotificationsForUser(outsider, { limit: 100, offset: 0 })

  assert.equal(adminFirst.total, 1)
  assert.equal(ownerFirst.total, 1)
  assert.equal(editorFirst.total, 1)
  assert.equal(outsiderFirst.total, 0)
  assert.equal(adminFirst.items[0]?.detail, '负责人执行了包含内部行为信息的详细操作记录。')
  assert.equal(adminFirst.items[0]?.actorName, owner.displayName)
  assert.equal(Object.prototype.hasOwnProperty.call(ownerFirst.items[0] ?? {}, 'detail'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(ownerFirst.items[0] ?? {}, 'actorName'), false)
  assert.equal(ownerFirst.items[0]?.summary, '第一次更新课题')

  const ownerNotificationId = ownerFirst.items[0]!.id
  const adminNotificationId = adminFirst.items[0]!.id
  const request = (token: string | undefined, method = 'GET', body?: unknown) => new Request('http://localhost/api/notifications', {
    method,
    headers: {
      ...(token ? { cookie: sessionCookieName + '=' + encodeURIComponent(token) } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  assert.equal((await listNotifications(request(undefined))).status, 401)
  const adminApiResponse = await listNotifications(request(createSession(admin.id).token))
  const adminApiBody = await adminApiResponse.json() as { notifications?: Array<Record<string, unknown>> }
  assert.equal(adminApiResponse.status, 200)
  assert.equal(adminApiBody.notifications?.[0]?.detail, '负责人执行了包含内部行为信息的详细操作记录。')
  const ownerApiResponse = await listNotifications(request(createSession(owner.id).token))
  const ownerApiBody = await ownerApiResponse.json() as { notifications?: Array<Record<string, unknown>> }
  assert.equal(ownerApiResponse.status, 200)
  assert.equal(Object.prototype.hasOwnProperty.call(ownerApiBody.notifications?.[0] ?? {}, 'detail'), false)
  const unauthorizedMarkResponse = await patchNotifications(request(createSession(owner.id).token, 'PATCH', { ids: [adminNotificationId] }))
  const unauthorizedMarkBody = await unauthorizedMarkResponse.json() as { marked?: number }
  assert.equal(unauthorizedMarkResponse.status, 200)
  assert.equal(unauthorizedMarkBody.marked, 0)
  assert.equal(markNotificationsRead(owner, { ids: [ownerNotificationId] }), 1)
  assert.equal(listNotificationsForUser(owner, { limit: 100, offset: 0 }).unreadCount, 0)
  assert.equal(listNotificationsForUser(admin, { limit: 100, offset: 0 }).unreadCount, 1)
  assert.equal(markNotificationsRead(owner, { ids: [adminNotificationId] }), 0)
  assert.equal(markNotificationsRead(admin, { all: true, ids: [ownerNotificationId] }), 1)
  assert.equal(listNotificationsForUser(admin, { limit: 100, offset: 0 }).unreadCount, 0)

  record('第二次更新课题')
  record('第三次更新课题')
  const pagedOwner = listNotificationsForUser(owner, { limit: 2, offset: 0 })
  assert.equal(pagedOwner.total, 3)
  assert.equal(pagedOwner.items.length, 2)
  assert.equal(pagedOwner.unreadCount, 2)

  recordActivity({
    action: notificationActions.projectDeleted,
    actor: owner,
    projectId: project.id,
    projectTitle: project.title,
    recipientUserIds: [outsider.id],
    summary: '删除通知测试课题',
    detail: '删除前保存的成员收件人仍能收到这条记录。',
  })
  assert.equal(listNotificationsForUser(outsider, { limit: 100, offset: 0 }).total, 1)
  assert.equal(listNotificationsForUser(owner, { limit: 100, offset: 0 }).total, 4)
  assert.equal(listNotificationsForUser(editor, { limit: 100, offset: 0 }).total, 4)
  assert.equal(listNotificationsForUser(admin, { limit: 100, offset: 0 }).total, 4)

  getDatabase().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(admin.id)
  record('管理员停用后的更新课题')
  assert.equal(listNotificationsForUser(admin, { limit: 100, offset: 0 }).total, 4)
  assert.equal(listNotificationsForUser(owner, { limit: 100, offset: 0 }).total, 5)
})
