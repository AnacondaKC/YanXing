import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(tmpdir() + '/yanxing-authz-')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'authz-test.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'authz-test-encryption-key'

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
import type { SessionUser as AuthUser } from '../modules/users/domain'
const { getDatabase } = await import('../lib/db/client')
const { createNativeProject, submitNativeReport } = await import('./helpers/native-project')
const { GET: getAiSettings } = await import('../app/api/admin/ai-settings/route')
const { GET: getPromptSettings } = await import('../app/api/admin/prompt-settings/route')
const { GET: listProjects } = await import('../app/api/projects/route')
const { GET: getReportHistory } = await import('../app/api/projects/[projectId]/reports/history/route')
const { DELETE: deleteReportVersion, PATCH: patchReport } = await import('../app/api/reports/[reportId]/route')
const { GET: listAllReports } = await import('../app/api/reports/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function createUser(username: string, role: AuthUser['role']) {
  return createOrUpdateUser({ username, displayName: username, password: 'password-' + username + '-123', role })
}

function cookie(token?: string): Record<string, string> {
  if (!token) return {}
  return { cookie: sessionCookieName + '=' + encodeURIComponent(token) }
}

test('AI model settings API only permits administrators', async () => {
  const admin = createUser('settings-admin', 'admin')
  const researcher = createUser('settings-researcher', 'researcher')
  const request = (token?: string) => new Request('http://localhost/api/admin/ai-settings', {
    headers: token ? cookie(token) : undefined,
  })
  assert.equal((await getAiSettings(request())).status, 401)
  assert.equal((await getAiSettings(request(createSession(researcher.id).token))).status, 403)
  const response = await getAiSettings(request(createSession(admin.id).token))
  const body = await response.json() as { settings?: { channels?: unknown[]; assignments?: unknown[] } }
  assert.equal(response.status, 200)
  assert.equal(body.settings?.channels?.length, 1)
  assert.equal(body.settings?.assignments?.length, 2)
  assert.equal((await getPromptSettings(request())).status, 401)
  assert.equal((await getPromptSettings(request(createSession(researcher.id).token))).status, 403)
  const promptResponse = await getPromptSettings(request(createSession(admin.id).token))
  const promptBody = await promptResponse.json() as { prompts?: unknown[] }
  assert.equal(promptResponse.status, 200)
  assert.equal(promptBody.prompts?.length, 2)
})

test('prompt settings API only permits administrators', async () => {
  const admin = createUser('prompt-settings-admin', 'admin')
  const researcher = createUser('prompt-settings-researcher', 'researcher')
  const request = (token?: string) => new Request('http://localhost/api/admin/prompt-settings', {
    headers: token ? cookie(token) : undefined,
  })
  assert.equal((await getPromptSettings(request())).status, 401)
  assert.equal((await getPromptSettings(request(createSession(researcher.id).token))).status, 403)
  const response = await getPromptSettings(request(createSession(admin.id).token))
  const body = await response.json() as { prompts?: unknown[] }
  assert.equal(response.status, 200)
  assert.equal(body.prompts?.length, 2)
})

test('project role authorization matrix is enforced for write and retention', async () => {
  const adminUser = createUser('authz-admin', 'admin')
  const owner = createUser('authz-owner', 'researcher')
  const editor = createUser('authz-editor', 'researcher')
  const outsider = createUser('authz-outsider', 'researcher')
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '授权测试课题', collaboratorIds: [editor.id] })
  for (const [member, memberRole, canManage, canSubmit] of [
    [adminUser, undefined, true, true],
    [owner, 'owner', true, true],
    [editor, 'editor', true, false],
    [outsider, undefined, false, false],
  ] as const) {
    const response = await listProjects(new Request('http://localhost/api/projects', { headers: cookie(createSession(member.id).token) }))
    const body = await response.json() as { projects: Array<{ id: string; memberRole?: string; canManage: boolean; canEditPlan: boolean; canSubmit: boolean; canDelete: boolean }> }
    const listed = body.projects.find((item) => item.id === project.id)
    assert.ok(listed, member.username)
    assert.equal(listed.canDelete, false, member.username)
    assert.equal(listed.canManage, canManage, member.username)
    assert.equal(listed.canEditPlan, canManage, member.username)
    assert.equal(listed.canSubmit, canSubmit, member.username)
    if (memberRole) assert.equal(listed.memberRole, memberRole, member.username)
  }
})

test('report library returns all reports to every signed-in user', async () => {
  const owner = createUser('report-list-owner', 'researcher')
  const outsider = createUser('report-list-outsider', 'researcher')
  const adminUser = createUser('report-list-admin', 'admin')
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '报告库全可见课题' })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  for (const member of [outsider, owner, adminUser]) {
    const body = await (await listAllReports(new Request('http://localhost/api/reports', { headers: cookie(createSession(member.id).token) }))).json() as { reports: Array<{ id: string }> }
    assert.equal(body.reports.some((item) => item.id === submitted.reportId), true, member.username)
  }
})

test('report deletion API only permits the project owner or an administrator', async () => {
  const owner = createUser('delete-report-owner', 'researcher')
  const editor = createUser('delete-report-editor', 'researcher')
  const adminUser = createUser('delete-report-admin', 'admin')
  const outsider = createUser('delete-report-outsider', 'researcher')
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '报告删除授权课题', collaboratorIds: [editor.id] })
  const first = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const request = (reportId: string, token?: string) => new Request('http://localhost/api/reports/' + reportId, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...cookie(token) },
    body: JSON.stringify({ reason: '授权测试删除' }),
  })
  const context = (reportId: string) => ({ params: Promise.resolve({ reportId }) })
  assert.equal((await deleteReportVersion(request(first.reportId), context(first.reportId))).status, 401)
  assert.equal((await deleteReportVersion(request(first.reportId, createSession(outsider.id).token), context(first.reportId))).status, 403)
  assert.equal((await deleteReportVersion(request(first.reportId, createSession(editor.id).token), context(first.reportId))).status, 403)
  assert.equal((await deleteReportVersion(request(first.reportId, createSession(owner.id).token), context(first.reportId))).status, 200)
  const adminReport = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  assert.equal((await deleteReportVersion(request(adminReport.reportId, createSession(adminUser.id).token), context(adminReport.reportId))).status, 200)
})

test('history pagination is visible to every signed-in user', async () => {
  const owner = createUser('job-owner', 'researcher')
  const outsider = createUser('job-outsider', 'researcher')
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '任务授权课题' })
  const older = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const newer = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const historyRequest = (token?: string, query = '') => new Request('http://localhost/api/projects/' + project.id + '/reports/history' + query, { headers: cookie(token) })
  const historyContext = { params: Promise.resolve({ projectId: project.id }) }
  assert.equal((await getReportHistory(historyRequest(), historyContext)).status, 401)
  const firstPageResponse = await getReportHistory(historyRequest(createSession(outsider.id).token, '?limit=1&offset=0'), historyContext)
  const firstPageBody = await firstPageResponse.json() as { latestSubmissionReportId?: string; timeline?: Array<{ id?: string }>; hasMore?: boolean }
  assert.equal(firstPageResponse.status, 200)
  assert.equal(firstPageBody.latestSubmissionReportId, newer.reportId)
  assert.equal(firstPageBody.timeline?.[0]?.id, newer.reportId)
  assert.equal(firstPageBody.hasMore, true)
  const secondPageResponse = await getReportHistory(historyRequest(createSession(outsider.id).token, '?limit=1&offset=1'), historyContext)
  const secondPageBody = await secondPageResponse.json() as { timeline?: Array<{ id?: string }>; hasMore?: boolean }
  assert.equal(secondPageResponse.status, 200)
  assert.equal(secondPageBody.timeline?.[0]?.id, older.reportId)
  assert.equal(secondPageBody.hasMore, false)
})

test('report patch and delete abort independently from upload cancel copy', async () => {
  const owner = createUser('abort-report-owner', 'researcher')
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '报告取消文案课题' })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const token = createSession(owner.id).token
  const controller = new AbortController()
  controller.abort()
  const headers = { ...cookie(token), 'content-type': 'application/json' }
  const context = { params: Promise.resolve({ reportId: submitted.reportId }) }
  const patched = await patchReport(new Request('http://localhost/api/reports/' + submitted.reportId, {
    method: 'PATCH', headers, body: JSON.stringify({ milestoneId: 'stage-1' }), signal: controller.signal,
  }), context)
  assert.equal(patched.status, 408)
  assert.equal((await patched.json() as { error?: string }).error, '请求已取消。')
  const deleted = await deleteReportVersion(new Request('http://localhost/api/reports/' + submitted.reportId, {
    method: 'DELETE', headers, body: JSON.stringify({ reason: '取消' }), signal: controller.signal,
  }), context)
  assert.equal(deleted.status, 408)
  assert.equal((await deleted.json() as { error?: string }).error, '请求已取消。')
})

test('paginated report lists reject offsets beyond the allowed range', async () => {
  const owner = createUser('page-range-owner', 'researcher')
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '分页越界课题' })
  const token = createSession(owner.id).token
  const listed = await listAllReports(new Request('http://localhost/api/reports?offset=100001', { headers: cookie(token) }))
  assert.equal(listed.status, 400)
  assert.match((await listed.json() as { error?: string }).error ?? '', /分页偏移超出允许范围/)
  const history = await getReportHistory(new Request('http://localhost/api/projects/' + project.id + '/reports/history?offset=100001', { headers: cookie(token) }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(history.status, 400)
  assert.match((await history.json() as { error?: string }).error ?? '', /分页偏移超出允许范围/)
})
