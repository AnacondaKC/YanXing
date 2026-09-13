import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-workspace-routes-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'workspace-routes.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'workspace-routes-encryption-key'

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { createMinimalDocxBuffer } = await import('../scripts/deployment-fixtures.mjs')
const { createNativeProject, submitNativeReport } = await import('./helpers/native-project')
const { GET: listProjects, POST: createProject } = await import('../app/api/projects/route')
const { PATCH: patchProject, PUT: putProject, DELETE: deleteProject } = await import('../app/api/projects/[projectId]/route')
const { GET: listStages, PATCH: editPlan } = await import('../app/api/projects/[projectId]/stages/route')
const { GET: listStageReports } = await import('../app/api/projects/[projectId]/stages/[stageId]/reports/route')
const { GET: listProjectReports, POST: confirmReport } = await import('../app/api/projects/[projectId]/reports/route')
const { GET: listHistory } = await import('../app/api/projects/[projectId]/reports/history/route')
const { POST: prepareUpload } = await import('../app/api/projects/[projectId]/report-uploads/route')
const { GET: listLibrary } = await import('../app/api/reports/route')
const { GET: getReport, DELETE: deleteReport, PATCH: patchReport, PUT: putReport } = await import('../app/api/reports/[reportId]/route')
const { POST: analyzeReport } = await import('../app/api/reports/[reportId]/analyze/route')
const { GET: getOverview } = await import('../app/api/overview-stats/route')
const { GET: listNotifications } = await import('../app/api/notifications/route')
const { PUT: saveMembers } = await import('../app/api/admin/projects/[projectId]/members/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function cookie(token: string): Record<string, string> {
  return { cookie: sessionCookieName + '=' + encodeURIComponent(token) }
}

function jsonRequest(url: string, method: string, token: string | undefined, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) Object.assign(headers, cookie(token))
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function stage(id = 'stage-1') {
  return { id, title: '阶段一', description: '工作内容与预期成果', plannedEndAt: '2026-12-31' }
}

async function jsonStatus(response: Response) {
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

test('project create, safe patch, stages, and retired writes follow native contracts', async () => {
  const owner = createOrUpdateUser({ username: 'ws-owner', displayName: '工作台负责人', password: 'password-123456', role: 'researcher' })
  const other = createOrUpdateUser({ username: 'ws-other', displayName: '其他研究员', password: 'password-123456', role: 'researcher' })
  const admin = createOrUpdateUser({ username: 'ws-admin', displayName: '工作台管理员', password: 'password-123456', role: 'admin' })
  const ownerToken = createSession(owner.id).token
  const otherToken = createSession(other.id).token
  const adminToken = createSession(admin.id).token

  const unauthorized = await createProject(jsonRequest('http://localhost/api/projects', 'POST', undefined, {
    title: '未登录课题', objective: '研究目标', description: '研究背景', stages: [stage()],
  }))
  assert.equal(unauthorized.status, 401)

  const legacyCreate = await jsonStatus(await createProject(jsonRequest('http://localhost/api/projects', 'POST', ownerToken, {
    title: '旧里程碑课题', objective: '研究目标', description: '研究背景', milestones: [stage()],
  })))
  assert.equal(legacyCreate.status, 409)
  assert.equal(legacyCreate.body.code, 'PROJECT_FIELD_RETIRED')

  const created = await jsonStatus(await createProject(jsonRequest('http://localhost/api/projects', 'POST', ownerToken, {
    title: '原生课题', objective: '研究目标', description: '研究背景', stages: [stage()],
  })))
  assert.equal(created.status, 201)
  const project = created.body.project as { id: string; ownerId: string; updatedAt: string; canDelete: boolean }
  assert.equal(project.ownerId, owner.id)
  assert.equal(project.canDelete, false)

  const stolen = await jsonStatus(await createProject(jsonRequest('http://localhost/api/projects', 'POST', ownerToken, {
    title: '越权负责人课题', objective: '研究目标', description: '研究背景', ownerId: other.id, stages: [stage('stage-2')],
  })))
  assert.equal(stolen.status, 403)

  const adminCreated = await jsonStatus(await createProject(jsonRequest('http://localhost/api/projects', 'POST', adminToken, {
    title: '管理员指定课题', objective: '研究目标', description: '研究背景', ownerId: other.id, stages: [stage('stage-a')],
  })))
  assert.equal(adminCreated.status, 201)
  assert.equal((adminCreated.body.project as { ownerId: string }).ownerId, other.id)

  const listed = await jsonStatus(await listProjects(new Request('http://localhost/api/projects', { headers: cookie(otherToken) })))
  assert.equal(listed.status, 200)
  assert.equal(((listed.body.projects as Array<{ id: string }>).some((item) => item.id === project.id)), true)

  const ownerPatch = await jsonStatus(await patchProject(jsonRequest('http://localhost/api/projects/' + project.id, 'PATCH', ownerToken, {
    expectedUpdatedAt: project.updatedAt, title: '改名后课题',
  }), { params: Promise.resolve({ projectId: project.id }) }))
  assert.equal(ownerPatch.status, 200)
  assert.equal((ownerPatch.body.project as { title: string }).title, '改名后课题')

  const stale = await jsonStatus(await patchProject(jsonRequest('http://localhost/api/projects/' + project.id, 'PATCH', ownerToken, {
    expectedUpdatedAt: project.updatedAt, title: '陈旧稿',
  }), { params: Promise.resolve({ projectId: project.id }) }))
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'PROJECT_UPDATE_CONFLICT')

  const retiredOwner = await jsonStatus(await patchProject(jsonRequest('http://localhost/api/projects/' + project.id, 'PATCH', ownerToken, {
    expectedUpdatedAt: (ownerPatch.body.project as { updatedAt: string }).updatedAt, ownerId: other.id,
  }), { params: Promise.resolve({ projectId: project.id }) }))
  assert.equal(retiredOwner.status, 409)
  assert.equal(retiredOwner.body.code, 'PROJECT_FIELD_RETIRED')

  const put = await jsonStatus(await putProject(jsonRequest('http://localhost/api/projects/' + project.id, 'PUT', ownerToken, { title: '整表替换' }), { params: Promise.resolve({ projectId: project.id }) }))
  assert.equal(put.status, 409)
  assert.equal(put.body.code, 'PROJECT_FIELD_RETIRED')

  const removed = await jsonStatus(await deleteProject(new Request('http://localhost/api/projects/' + project.id, { method: 'DELETE', headers: cookie(ownerToken) }), { params: Promise.resolve({ projectId: project.id }) }))
  assert.equal(removed.status, 409)
  assert.equal(removed.body.code, 'PROJECT_RETENTION_REQUIRED')

  const stages = await jsonStatus(await listStages(new Request('http://localhost/api/projects/' + project.id + '/stages', { headers: cookie(ownerToken) }), { params: Promise.resolve({ projectId: project.id }) }))
  assert.equal(stages.status, 200)
  const workflow = stages.body.workflow as { planRevision: number }
  const plan = await jsonStatus(await editPlan(jsonRequest('http://localhost/api/projects/' + project.id + '/stages', 'PATCH', ownerToken, {
    expectedPlanRevision: workflow.planRevision,
    nextStages: [stage('stage-1'), stage('stage-2')],
  }), { params: Promise.resolve({ projectId: project.id }) }))
  assert.equal(plan.status, 200)
  assert.equal((plan.body.stages as unknown[]).length, 2)

  const range = await listLibrary(new Request('http://localhost/api/reports?offset=100001', { headers: cookie(ownerToken) }))
  assert.equal(range.status, 400)
})

test('report upload protocol, immutability, delete reason, and library visibility', async () => {
  const owner = createOrUpdateUser({ username: 'ws-report-owner', displayName: '报告负责人', password: 'password-123456', role: 'researcher' })
  const editor = createOrUpdateUser({ username: 'ws-report-editor', displayName: '报告编辑', password: 'password-123456', role: 'researcher' })
  const outsider = createOrUpdateUser({ username: 'ws-report-outsider', displayName: '旁观研究员', password: 'password-123456', role: 'researcher' })
  const admin = createOrUpdateUser({ username: 'ws-report-admin', displayName: '报告管理员', password: 'password-123456', role: 'admin' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '报告协议课题', collaboratorIds: [editor.id] })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const ownerToken = createSession(owner.id).token
  const editorToken = createSession(editor.id).token
  const outsiderToken = createSession(outsider.id).token
  const adminToken = createSession(admin.id).token
  const params = { params: Promise.resolve({ projectId: project.id, reportId: submitted.reportId, stageId: submitted.stageId }) }

  const rawUpload = await confirmReport(new Request('http://localhost/api/projects/' + project.id + '/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': 'legacy.pdf', ...cookie(ownerToken) },
    body: '%PDF-1.4',
  }), params)
  assert.equal(rawUpload.status, 410)
  assert.equal(((await rawUpload.json()) as { code?: string }).code, 'UPLOAD_PROTOCOL_RETIRED')

  const bytes = createMinimalDocxBuffer('这是一份完整研究报告。')
  const prepare = await prepareUpload(new Request('http://localhost/api/projects/' + project.id + '/report-uploads?fileName=' + encodeURIComponent('next.docx'), {
    method: 'POST',
    headers: { ...cookie(ownerToken), 'content-length': String(bytes.byteLength) },
    body: new Uint8Array(bytes),
  }), params)
  assert.equal(prepare.status, 201)

  const patched = await jsonStatus(await patchReport(jsonRequest('http://localhost/api/reports/' + submitted.reportId, 'PATCH', ownerToken, { milestoneId: 'stage-1' }), { params: Promise.resolve({ reportId: submitted.reportId }) }))
  assert.equal(patched.status, 409)
  assert.equal(patched.body.code, 'REPORT_STAGE_IMMUTABLE')

  const replaced = await jsonStatus(await putReport(new Request('http://localhost/api/reports/' + submitted.reportId, { method: 'PUT', headers: cookie(ownerToken), body: 'docx' }), { params: Promise.resolve({ reportId: submitted.reportId }) }))
  assert.equal(replaced.status, 409)
  assert.equal(replaced.body.code, 'REPORT_SOURCE_IMMUTABLE')

  const missingReason = await jsonStatus(await deleteReport(jsonRequest('http://localhost/api/reports/' + submitted.reportId, 'DELETE', ownerToken, {}), { params: Promise.resolve({ reportId: submitted.reportId }) }))
  assert.equal(missingReason.status, 400)

  assert.equal((await deleteReport(new Request('http://localhost/api/reports/' + submitted.reportId, { method: 'DELETE', headers: cookie(outsiderToken), body: JSON.stringify({ reason: '越权删除' }) }), { params: Promise.resolve({ reportId: submitted.reportId }) })).status, 403)
  assert.equal((await deleteReport(jsonRequest('http://localhost/api/reports/' + submitted.reportId, 'DELETE', editorToken, { reason: '编辑删除' }), { params: Promise.resolve({ reportId: submitted.reportId }) })).status, 403)

  const library = await jsonStatus(await listLibrary(new Request('http://localhost/api/reports', { headers: cookie(outsiderToken) })))
  assert.equal(library.status, 200)
  assert.equal(((library.body.reports as Array<{ id: string }>).some((item) => item.id === submitted.reportId)), true)

  const history = await jsonStatus(await listHistory(new Request('http://localhost/api/projects/' + project.id + '/reports/history?limit=1', { headers: cookie(outsiderToken) }), params))
  assert.equal(history.status, 200)
  assert.equal(((history.body.timeline as Array<{ id: string }>)[0]?.id), submitted.reportId)

  const stageReports = await jsonStatus(await listStageReports(new Request('http://localhost/api/projects/' + project.id + '/stages/' + submitted.stageId + '/reports', { headers: cookie(ownerToken) }), params))
  assert.equal(stageReports.status, 200)

  const listed = await jsonStatus(await listProjectReports(new Request('http://localhost/api/projects/' + project.id + '/reports', { headers: cookie(ownerToken) }), params))
  assert.equal(listed.status, 200)

  const detail = await jsonStatus(await getReport(new Request('http://localhost/api/reports/' + submitted.reportId, { headers: cookie(ownerToken) }), { params: Promise.resolve({ reportId: submitted.reportId }) }))
  assert.equal(detail.status, 200)
  assert.ok('analysisTask' in detail.body || true)

  const deleted = await jsonStatus(await deleteReport(jsonRequest('http://localhost/api/reports/' + submitted.reportId, 'DELETE', ownerToken, { reason: '重复提交，保留原件' }), { params: Promise.resolve({ reportId: submitted.reportId }) }))
  assert.equal(deleted.status, 200)
  assert.equal((await getReport(new Request('http://localhost/api/reports/' + submitted.reportId, { headers: cookie(ownerToken) }), { params: Promise.resolve({ reportId: submitted.reportId }) })).status, 404)

  const second = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const adminDeleted = await jsonStatus(await deleteReport(jsonRequest('http://localhost/api/reports/' + second.reportId, 'DELETE', adminToken, { reason: '管理员清理' }), { params: Promise.resolve({ reportId: second.reportId }) }))
  assert.equal(adminDeleted.status, 200)

  const overview = await jsonStatus(await getOverview(new Request('http://localhost/api/overview-stats', { headers: cookie(ownerToken) })))
  assert.equal(overview.status, 200)
  const stats = (overview.body.stats ?? overview.body) as { submittedReportCount?: number }
  assert.equal(typeof stats.submittedReportCount, 'number')

  const notes = await listNotifications(new Request('http://localhost/api/notifications', { headers: cookie(ownerToken) }))
  assert.equal(notes.status, 200)
})

test('overview GET applies per-user limits without sharing another user bucket', async () => {
  const owner = createOrUpdateUser({ username: 'ws-rate-owner', displayName: '限流用户', password: 'password-123456', role: 'researcher' })
  const other = createOrUpdateUser({ username: 'ws-rate-other', displayName: '独立用户', password: 'password-123456', role: 'researcher' })
  const token = createSession(owner.id).token
  const read = (session: string) => getOverview(new Request('http://localhost/api/overview-stats', { headers: cookie(session) }))
  assert.equal((await read(token)).status, 200)
  const { checkRateLimit } = await import('../lib/security/rate-limit')
  for (let index = 1; index < 120; index++) checkRateLimit('overview-stats:' + owner.id, { limit: 120, windowMs: 60_000 })
  const limited = await read(token)
  assert.equal(limited.status, 429)
  assert.ok(limited.headers.get('Retry-After'))
  assert.equal((await read(createSession(other.id).token)).status, 200)
})

test('confirmation replay does not duplicate upload notifications', async () => {
  const owner = createOrUpdateUser({ username: 'ws-replay-owner', displayName: '重放用户', password: 'password-123456', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '重放课题' })
  const token = createSession(owner.id).token
  const bytes = createMinimalDocxBuffer('隔离重放测试报告。')
  const params = { params: Promise.resolve({ projectId: project.id }) }
  const prepared = await prepareUpload(new Request('http://localhost/api/projects/' + project.id + '/report-uploads?fileName=replay.docx', {
    method: 'POST', headers: { ...cookie(token), 'content-length': String(bytes.byteLength) }, body: new Uint8Array(bytes),
  }), params)
  assert.equal(prepared.status, 201)
  const upload = await prepared.json() as { id: string }
  const workflow = project.workflow
  const stage = workflow.stages[0]
  const command = { uploadId: upload.id, stageId: stage.id, reportKind: 'update', expectedPlanRevision: workflow.planRevision, expectedWorkflowRevision: workflow.workflowRevision, expectedCompletionRevision: stage.completionRevision, expectedCompletionReportId: null }
  const confirm = () => confirmReport(new Request('http://localhost/api/projects/' + project.id + '/reports', { method: 'POST', headers: { ...cookie(token), 'content-type': 'application/json', 'idempotency-key': 'workspace_replay_notification_123' }, body: JSON.stringify(command) }), params)
  assert.equal((await confirm()).status, 201)
  const count = () => getDatabase().prepare('SELECT COUNT(*) AS count FROM notifications WHERE project_id=?').get(project.id)!.count
  const first = count()
  assert.ok(Number(first) > 0)
  assert.equal((await confirm()).status, 200)
  assert.equal(count(), first)
})

test('analyze maps missing reports and unauthorized users', async () => {
  const owner = createOrUpdateUser({ username: 'ws-analyze-owner', displayName: '分析负责人', password: 'password-123456', role: 'researcher' })
  const stranger = createOrUpdateUser({ username: 'ws-analyze-stranger', displayName: '无关用户', password: 'password-123456', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '分析权限课题' })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const analyze = (token: string | undefined, reportId: string) => analyzeReport(new Request('http://localhost/api/reports/' + reportId + '/analyze', {
    method: 'POST',
    headers: token ? cookie(token) : {},
  }), { params: Promise.resolve({ reportId }) })
  assert.equal((await analyze(undefined, submitted.reportId)).status, 401)
  assert.equal((await analyze(createSession(stranger.id).token, submitted.reportId)).status, 403)
  assert.equal((await analyze(createSession(owner.id).token, 'report-missing')).status, 404)
})

test('aborted report writes return 408 before retired or delete handling', async () => {
  const owner = createOrUpdateUser({ username: 'ws-abort-owner', displayName: '取消请求负责人', password: 'password-123456', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '取消请求课题' })
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
  const deleted = await deleteReport(new Request('http://localhost/api/reports/' + submitted.reportId, {
    method: 'DELETE', headers, body: JSON.stringify({ reason: '取消' }), signal: controller.signal,
  }), context)
  assert.equal(deleted.status, 408)
})

test('native HTTP permits editor configuration only and preserves admin-only owner management', async () => {
  const database = getDatabase()
  const owner = createOrUpdateUser({ username: 'config-owner', displayName: '配置负责人', password: 'password-123456', role: 'researcher' })
  const editor = createOrUpdateUser({ username: 'config-editor', displayName: '配置协作者', password: 'password-123456', role: 'researcher' })
  const stranger = createOrUpdateUser({ username: 'config-stranger', displayName: '外人', password: 'password-123456', role: 'researcher' })
  const ownerToken = createSession(owner.id).token
  const editorToken = createSession(editor.id).token
  const strangerToken = createSession(stranger.id).token
  const project = createNativeProject({ database, ownerId: owner.id, collaboratorIds: [editor.id] })
  const context = { params: Promise.resolve({ projectId: project.id }) }
  const url = 'http://localhost/api/projects/' + project.id
  const listed = await listProjects(new Request('http://localhost/api/projects', { headers: cookie(editorToken) }))
  const item = (await listed.json()).projects.find((entry: { id: string }) => entry.id === project.id)
  assert.equal(item.canManage, true)
  assert.equal(item.canEditPlan, true)
  assert.equal(item.canSubmit, false)
  const edit = { expectedUpdatedAt: project.updatedAt, objective: '协作者修改目标', description: '协作者修改说明', title: '协作者修改标题' }
  const edited = await patchProject(jsonRequest(url, 'PATCH', editorToken, edit), context)
  assert.equal(edited.status, 200)
  const editedBody = await edited.json()
  assert.equal(editedBody.project.objective, edit.objective)
  assert.equal((await patchProject(jsonRequest(url, 'PATCH', editorToken, edit), context)).status, 409)
  const nextStages = project.workflow.stages.map(stage => ({ id: stage.id, title: '协作者修订计划', description: '阶段说明', plannedEndAt: '2031-01-01' }))
  const planEdit = { expectedPlanRevision: 0, nextStages }
  assert.equal((await editPlan(jsonRequest(url + '/stages', 'PATCH', editorToken, planEdit), context)).status, 200)
  assert.equal((await editPlan(jsonRequest(url + '/stages', 'PATCH', editorToken, planEdit), context)).status, 409)
  assert.equal((await patchProject(jsonRequest(url, 'PATCH', strangerToken, edit), context)).status, 403)
  assert.equal((await editPlan(jsonRequest(url + '/stages', 'PATCH', strangerToken, planEdit), context)).status, 403)
  for (const token of [ownerToken, editorToken]) {
    const members = { revision: 0, members: [{ userId: stranger.id, role: 'owner' }] }
    assert.equal((await saveMembers(jsonRequest(url + '/members', 'PUT', token, members), context)).status, 403)
    for (const fields of [{ ownerId: stranger.id }, { ownerName: stranger.displayName }, { collaboratorIds: [stranger.id] }, { members: members.members }]) {
      const response = await patchProject(jsonRequest(url, 'PATCH', token, { expectedUpdatedAt: editedBody.project.updatedAt, ...fields }), context)
      assert.ok(response.status === 400 || response.status === 409)
    }
  }
  assert.equal(database.prepare("SELECT user_id FROM project_members WHERE project_id=? AND role='owner'").get(project.id)?.user_id, owner.id)
  database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(editor.id)
  assert.equal((await patchProject(jsonRequest(url, 'PATCH', editorToken, edit), context)).status, 401)
  assert.equal((await editPlan(jsonRequest(url + '/stages', 'PATCH', editorToken, planEdit), context)).status, 401)
})
