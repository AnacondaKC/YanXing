import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(`${tmpdir()}/yanxing-authz-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'authz-test.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'authz-test-encryption-key'

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
import type { AuthUser } from '../lib/auth/session'
const {
  createProjectForUser,
  createReportJob,
  getReport,
  getUserProjectRole,
  listProjectsForUser,
  jobExistsReadable,
  projectExistsReadable,
  reportExistsReadable,
  userCanDeleteProject,
  updateProject,
  userCanManageJob,
  userCanManageProject,
} = await import('../lib/db/repository')
const { getDatabase } = await import('../lib/db/client')
const { GET: getAiSettings } = await import('../app/api/admin/ai-settings/route')
const { GET: getPromptSettings } = await import('../app/api/admin/prompt-settings/route')
const { GET: getReportHistory } = await import('../app/api/projects/[projectId]/reports/history/route')
const { DELETE: deleteReportVersion, PATCH: patchReport } = await import('../app/api/reports/[reportId]/route')
const { GET: listAllReports } = await import('../app/api/reports/route')

const now = () => new Date().toISOString()

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function createUser(username: string, role: AuthUser['role']) {
  return createOrUpdateUser({ username, displayName: username, password: `password-${username}-123`, role })
}

function addMember(projectId: string, user: AuthUser, role: 'owner' | 'editor') {
  getDatabase().prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(projectId, user.id, role, now())
}

test('AI model settings API only permits administrators', async () => {
  const admin = createUser('settings-admin', 'admin')
  const researcher = createUser('settings-researcher', 'researcher')
  const request = (token?: string) => new Request('http://localhost/api/admin/ai-settings', {
    headers: token ? { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` } : undefined,
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
    headers: token ? { cookie: sessionCookieName + '=' + encodeURIComponent(token) } : undefined,
  })

  assert.equal((await getPromptSettings(request())).status, 401)
  assert.equal((await getPromptSettings(request(createSession(researcher.id).token))).status, 403)
  const response = await getPromptSettings(request(createSession(admin.id).token))
  const body = await response.json() as { prompts?: unknown[] }
  assert.equal(response.status, 200)
  assert.equal(body.prompts?.length, 2)
})
test('project role authorization matrix is enforced for delete and manage', () => {
  const admin = createUser('authz-admin', 'admin')
  const owner = createUser('authz-owner', 'researcher')
  const editor = createUser('authz-editor', 'researcher')
  const outsider = createUser('authz-outsider', 'researcher')

  const project = createProjectForUser({ title: '授权测试课题', objective: '验证角色矩阵', description: '', ownerName: owner.displayName }, owner.id)
  addMember(project.id, editor, 'editor')

  assert.equal(getUserProjectRole(project.id, admin), 'owner')
  assert.equal(getUserProjectRole(project.id, owner), 'owner')
  assert.equal(getUserProjectRole(project.id, editor), 'editor')
  assert.equal(getUserProjectRole(project.id, outsider), undefined)

  for (const [member, memberRole, canManage, canDelete] of [
    [admin, 'owner', true, true],
    [owner, 'owner', true, true],
    [editor, 'editor', true, false],
    [outsider, undefined, false, false],
  ] as const) {
    const listed = listProjectsForUser(member).find((item) => item.id === project.id)
    assert.deepEqual(
      listed && { memberRole: listed.memberRole, canManage: listed.canManage, canDelete: listed.canDelete },
      { memberRole, canManage, canDelete },
      member.username,
    )
  }

  // 读取：全员可查看所有课题，无需成员身份。
  for (const member of [admin, owner, editor, outsider]) {
    assert.equal(projectExistsReadable(project.id), true, member.username)
  }

  // 管理（上传报告、操作任务）：owner + editor + admin；非成员不可。
  for (const member of [admin, owner, editor]) {
    assert.equal(userCanManageProject(project.id, member), true, member.username)
  }
  assert.equal(userCanManageProject(project.id, outsider), false)

  // 删除：仅 owner + admin。
  for (const member of [admin, owner]) {
    assert.equal(userCanDeleteProject(project.id, member), true, member.username)
  }
  for (const member of [editor, outsider]) {
    assert.equal(userCanDeleteProject(project.id, member), false, member.username)
  }
})

test('report library returns all reports to every signed-in user', async () => {
  const owner = createUser('report-list-owner', 'researcher')
  const outsider = createUser('report-list-outsider', 'researcher')
  const admin = createUser('report-list-admin', 'admin')
  const project = createProjectForUser({ title: '报告库全可见课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const report = createReportJob({
    projectId: project.id,
    fileName: 'private-report.docx',
    source: {
      path: path.join(directory, 'private-report.docx'),
      fileName: 'private-report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'private-report-list-hash',
    },
    reportId: undefined,
    milestoneId: undefined,
    autoAnalyze: false,
  }).report
  const request = (token: string) => new NextRequest('http://localhost/api/reports', {
    headers: { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` },
  })

  for (const member of [outsider, owner, admin]) {
    const body = await (await listAllReports(request(createSession(member.id).token))).json() as { reports: Array<{ id: string }> }
    assert.equal(body.reports.some((item) => item.id === report.id), true, member.username)
  }
})

test('report deletion API only permits the project owner or an administrator', async () => {
  const owner = createUser('delete-report-owner', 'researcher')
  const editor = createUser('delete-report-editor', 'researcher')
  const admin = createUser('delete-report-admin', 'admin')
  const outsider = createUser('delete-report-outsider', 'researcher')
  const project = createProjectForUser({ title: '报告删除授权课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  addMember(project.id, editor, 'editor')

  const createDeletableReport = (suffix: string) => createReportJob({
    projectId: project.id,
    fileName: `delete-${suffix}.docx`,
    source: {
      path: path.join(directory, 'stored-reports', suffix, `delete-${suffix}.docx`),
      fileName: `delete-${suffix}.docx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: `delete-report-${suffix}`,
    },
    reportId: undefined,
    milestoneId: undefined,
    autoAnalyze: false,
  }).report
  const report = createDeletableReport('owner')
  const request = (reportId: string, token?: string) => new Request(`http://localhost/api/reports/${reportId}`, {
    method: 'DELETE',
    headers: token ? { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` } : undefined,
  })
  const context = (reportId: string) => ({ params: Promise.resolve({ reportId }) })

  assert.equal((await deleteReportVersion(request(report.id), context(report.id))).status, 401)
  assert.equal((await deleteReportVersion(request(report.id, createSession(outsider.id).token), context(report.id))).status, 403)
  assert.equal((await deleteReportVersion(request(report.id, createSession(editor.id).token), context(report.id))).status, 403)
  assert.equal((await deleteReportVersion(request(report.id, createSession(owner.id).token), context(report.id))).status, 200)
  assert.equal(getReport(report.id), undefined)

  const adminReport = createDeletableReport('admin')
  assert.equal((await deleteReportVersion(request(adminReport.id, createSession(admin.id).token), context(adminReport.id))).status, 200)
  assert.equal(getReport(adminReport.id), undefined)
})

test('job-level manage authorization follows the owning project role', async () => {
  const owner = createUser('job-owner', 'researcher')
  const editor = createUser('job-editor', 'researcher')
  const admin = createUser('job-admin', 'admin')
  const outsider = createUser('job-outsider', 'researcher')

  const project = createProjectForUser({ title: '任务授权课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  addMember(project.id, editor, 'editor')
  updateProject(project.id, {
    objective: '识别关键问题并形成决策建议',
    description: '围绕行业现状、风险与实施条件开展研究',
    milestones: [{ id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' }],
  })

  const source = { path: path.join(directory, 'missing.docx'), fileName: 'missing.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 100, sha256: 'deadbeef' }
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'missing.docx',
    source: source,
    reportId: undefined,
    milestoneId: 'stage-1',
  })

  for (const member of [admin, owner, editor]) {
    assert.equal(userCanManageJob(job.id, member), true, member.username)
  }
  assert.equal(userCanManageJob(job.id, outsider), false)

  // 读取权限：全员可读任务与报告，无需成员身份。
  for (const member of [admin, owner, editor, outsider]) {
    assert.equal(jobExistsReadable(job.id), true, member.username)
    assert.equal(reportExistsReadable(report.id), true, member.username)
  }

  const olderReport = report
  const newerReport = createReportJob({
    projectId: project.id,
    fileName: 'newer-missing.docx',
    source: {
      path: path.join(directory, 'newer-missing.docx'),
      fileName: 'newer-missing.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'newer-report-list-hash',
    },
    reportId: undefined,
    milestoneId: undefined,
    autoAnalyze: false,
  }).report
  const historyRequest = (token?: string, query = '') => new Request(`http://localhost/api/projects/${project.id}/reports/history${query}`, {
    headers: token ? { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` } : undefined,
  })
  const historyContext = { params: Promise.resolve({ projectId: project.id }) }
  assert.equal((await getReportHistory(historyRequest(), historyContext)).status, 401)
  const firstPageResponse = await getReportHistory(historyRequest(createSession(outsider.id).token, '?limit=1&offset=0'), historyContext)
  const firstPageBody = await firstPageResponse.json() as { latestReportId?: string; entries?: Array<{ report?: { id?: string } }>; hasMore?: boolean }
  assert.equal(firstPageResponse.status, 200)
  assert.equal(firstPageBody.latestReportId, newerReport.id)
  assert.equal(firstPageBody.entries?.[0]?.report?.id, newerReport.id)
  assert.equal(firstPageBody.hasMore, true)

  const secondPageResponse = await getReportHistory(historyRequest(createSession(outsider.id).token, '?limit=1&offset=1'), historyContext)
  const secondPageBody = await secondPageResponse.json() as { latestReportId?: string; entries?: Array<{ report?: { id?: string } }>; hasMore?: boolean }
  assert.equal(secondPageResponse.status, 200)
  assert.equal(secondPageBody.latestReportId, undefined)
  assert.equal(secondPageBody.entries?.[0]?.report?.id, olderReport.id)
  assert.equal(secondPageBody.hasMore, false)
})

test('report patch and delete abort independently from upload cancel copy', async () => {
  const owner = createUser('abort-report-owner', 'researcher')
  const project = createProjectForUser({ title: '报告取消文案课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const report = createReportJob({
    projectId: project.id,
    fileName: 'abort.docx',
    source: {
      path: path.join(directory, 'abort.docx'),
      fileName: 'abort.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'abort-report-hash',
    },
    reportId: undefined,
    milestoneId: undefined,
    autoAnalyze: false,
  }).report
  const token = createSession(owner.id).token
  const controller = new AbortController()
  controller.abort()
  const headers = { cookie: `${sessionCookieName}=${encodeURIComponent(token)}`, 'content-type': 'application/json' }
  const context = { params: Promise.resolve({ reportId: report.id }) }

  const patched = await patchReport(new Request(`http://localhost/api/reports/${report.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ milestoneId: 'stage-1' }),
    signal: controller.signal,
  }), context)
  assert.equal(patched.status, 408)
  assert.equal((await patched.json() as { error?: string }).error, '请求已取消。')

  const deleted = await deleteReportVersion(new Request(`http://localhost/api/reports/${report.id}`, {
    method: 'DELETE',
    headers,
    signal: controller.signal,
  }), context)
  assert.equal(deleted.status, 408)
  assert.equal((await deleted.json() as { error?: string }).error, '请求已取消。')
})

test('paginated report lists reject offsets beyond the allowed range', async () => {
  const owner = createUser('page-range-owner', 'researcher')
  const project = createProjectForUser({ title: '分页越界课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const token = createSession(owner.id).token
  const cookie = { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` }
  const listed = await listAllReports(new NextRequest('http://localhost/api/reports?offset=100001', { headers: cookie }))
  assert.equal(listed.status, 400)
  assert.match((await listed.json() as { error?: string }).error ?? '', /分页偏移超出允许范围/)
  const history = await getReportHistory(new Request(`http://localhost/api/projects/${project.id}/reports/history?offset=100001`, { headers: cookie }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(history.status, 400)
  assert.match((await history.json() as { error?: string }).error ?? '', /分页偏移超出允许范围/)
})
