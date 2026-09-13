import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(tmpdir() + '/yanxing-project-owners-')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'project-owners-test.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY='native-route-fixture-encryption-key'
process.env.YANXING_CHAT_COMPLETIONS_API_KEY='test-key-never-used-for-network'

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { createNativeProject, submitNativeReport } = await import('./helpers/native-project')
const { POST: createProjectRoute } = await import('../app/api/projects/route')
const { PATCH: patchProject, DELETE: deleteProject } = await import('../app/api/projects/[projectId]/route')
const { PATCH: editPlan } = await import('../app/api/projects/[projectId]/stages/route')
const { POST: uploadProjectReport } = await import('../app/api/projects/[projectId]/reports/route')
const { PATCH: patchReport } = await import('../app/api/reports/[reportId]/route')
const { POST: analyzeReport } = await import('../app/api/reports/[reportId]/analyze/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function cookie(token: string) {
  return { cookie: sessionCookieName + '=' + encodeURIComponent(token) }
}

function stage(id = 'stage-1', title = '阶段一') {
  return { id, title, description: title + '的工作内容与预期成果', plannedEndAt: '2026-12-31' }
}

function createBody(title: string, ownerId: string, extra: Record<string, unknown> = {}) {
  return { title, objective: '验证课题负责人默认规则', description: '验证创建课题时负责人默认为创建者', ownerId, stages: [stage()], ...extra }
}

test('PATCH ownerId is retired; administrators transfer ownership through members API instead', async () => {
  const first = createOrUpdateUser({ username: 'single-owner-first', displayName: '第一负责人', password: 'single-owner-first-123', role: 'researcher' })
  const second = createOrUpdateUser({ username: 'single-owner-second', displayName: '第二负责人', password: 'single-owner-second-123', role: 'researcher' })
  const admin = createOrUpdateUser({ username: 'single-owner-admin', displayName: '转移管理员', password: 'single-owner-admin-123', role: 'admin' })
  const project = createNativeProject({ database: getDatabase(), ownerId: first.id, title: '单负责人课题' })
  const rejected = await patchProject(new Request('http://localhost/api/projects/' + project.id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(createSession(first.id).token) },
    body: JSON.stringify({ expectedUpdatedAt: project.updatedAt, ownerId: second.id }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(rejected.status, 409)
  assert.equal(((await rejected.json()) as { code?: string }).code, 'PROJECT_FIELD_RETIRED')
  const adminRejected = await patchProject(new Request('http://localhost/api/projects/' + project.id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(createSession(admin.id).token) },
    body: JSON.stringify({ expectedUpdatedAt: project.updatedAt, ownerId: first.id }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(adminRejected.status, 409)
})

test('POST /api/projects defaults the owner to the creator and restricts researchers', async () => {
  const researcher = createOrUpdateUser({ username: 'create-owner-researcher', displayName: '创建研究员', password: 'create-owner-researcher-123', role: 'researcher' })
  const other = createOrUpdateUser({ username: 'create-owner-other', displayName: '其他研究员', password: 'create-owner-other-123', role: 'researcher' })
  const admin = createOrUpdateUser({ username: 'create-owner-admin', displayName: '创建管理员', password: 'create-owner-admin-123', role: 'admin' })
  const session = createSession(researcher.id)
  const adminSession = createSession(admin.id)
  const defaults = await createProjectRoute(new Request('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify({ title: '负责人默认课题', objective: '验证课题负责人默认规则', description: '验证创建课题时负责人默认为创建者', stages: [stage()] }),
  }))
  assert.equal(defaults.status, 201)
  const defaultBody = await defaults.json() as { project?: { ownerId?: string } }
  assert.equal(defaultBody.project?.ownerId, researcher.id)
  const rejected = await createProjectRoute(new Request('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify(createBody('越权负责人课题', other.id)),
  }))
  assert.equal(rejected.status, 403)
  assert.match(((await rejected.json()) as { error?: string }).error ?? '', /不能为其他用户创建课题/)
  const adminCreated = await createProjectRoute(new Request('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookie(adminSession.token) },
    body: JSON.stringify(createBody('管理员指定负责人课题', other.id, { stages: [stage('stage-admin')] })),
  }))
  assert.equal(adminCreated.status, 201)
  assert.equal(((await adminCreated.json()) as { project?: { ownerId?: string } }).project?.ownerId, other.id)
})

test('POST /api/projects requires project context and a complete stage plan', async () => {
  const user = createOrUpdateUser({ username: 'required-project-tester', displayName: '必填校验测试员', password: 'password-123', role: 'researcher' })
  const session = createSession(user.id)
  const base = createBody('必填规则课题', user.id)
  const cases = [
    { patch: { objective: '   ' } },
    { patch: { description: '' } },
    { patch: { stages: [] } },
  ]
  for (const item of cases) {
    const response = await createProjectRoute(new Request('http://localhost/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookie(session.token) },
      body: JSON.stringify({ ...base, ...item.patch }),
    }))
    assert.equal(response.status, 400, JSON.stringify(item.patch))
  }
  const legacy = await createProjectRoute(new Request('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify({ ...base, milestones: [stage()] }),
  }))
  assert.equal(legacy.status, 409)
})

test('submitted reports cannot change stage; analyze no longer requires a patch', async () => {
  const owner = createOrUpdateUser({ username: 'report-stage-owner', displayName: '历史阶段负责人', password: 'password-123', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '历史报告补选课题' })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const headers = { 'content-type': 'application/json', ...cookie(createSession(owner.id).token) }
  const assigned = await patchReport(new Request('http://localhost/api/reports/' + submitted.reportId, {
    method: 'PATCH', headers, body: JSON.stringify({ milestoneId: 'stage-1' }),
  }), { params: Promise.resolve({ reportId: submitted.reportId }) })
  assert.equal(assigned.status, 409)
  assert.equal(((await assigned.json()) as { code?: string }).code, 'REPORT_STAGE_IMMUTABLE')
  const started = await analyzeReport(new Request('http://localhost/api/reports/' + submitted.reportId + '/analyze', { method: 'POST', headers }), { params: Promise.resolve({ reportId: submitted.reportId }) })
  assert.ok(started.status === 202 || started.status === 200)
})

test('legacy multipart report upload is retired in favor of report-uploads', async () => {
  const owner = createOrUpdateUser({ username: 'manual-analysis-owner', displayName: '手动分析负责人', password: 'password-123', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '手动启动分析课题' })
  const session = createSession(owner.id)
  const uploaded = await uploadProjectReport(new Request('http://localhost/api/projects/' + project.id + '/reports', {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      'x-file-name': encodeURIComponent('待分析报告.pdf'),
      ...cookie(session.token),
    },
    body: '%PDF-1.4',
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(uploaded.status, 410)
  assert.equal(((await uploaded.json()) as { code?: string }).code, 'UPLOAD_PROTOCOL_RETIRED')
})

test('PATCH /api/projects/[projectId] preserves identity when only the title changes', async () => {
  const owner = createOrUpdateUser({ username: 'rename-project-owner', displayName: '课题重命名负责人', password: 'password-123', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '重命名前课题' })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const response = await patchProject(new Request('http://localhost/api/projects/' + project.id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(createSession(owner.id).token) },
    body: JSON.stringify({ expectedUpdatedAt: project.updatedAt, title: '重命名后课题' }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(response.status, 200)
  const body = await response.json() as { project?: { title?: string } }
  assert.equal(body.project?.title, '重命名后课题')
  const report = await (await import('../app/api/reports/[reportId]/route')).GET(
    new Request('http://localhost/api/reports/' + submitted.reportId, { headers: cookie(createSession(owner.id).token) }),
    { params: Promise.resolve({ reportId: submitted.reportId }) },
  )
  assert.equal(report.status, 200)
})

test('stage plan edits go through PATCH /stages and project DELETE is retained', async () => {
  const owner = createOrUpdateUser({ username: 'linked-stage-owner', displayName: '关联阶段负责人', password: 'password-123', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '关联阶段删除课题' })
  submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const session = createSession(owner.id)
  const retired = await patchProject(new Request('http://localhost/api/projects/' + project.id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify({ expectedUpdatedAt: project.updatedAt, milestones: [stage('stage-2')] }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(retired.status, 409)
  assert.equal(((await retired.json()) as { code?: string }).code, 'PROJECT_FIELD_RETIRED')
  const stages = await editPlan(new Request('http://localhost/api/projects/' + project.id + '/stages', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify({ expectedPlanRevision: 0, nextStages: [stage('stage-1'), stage('stage-2', '保留阶段')] }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(stages.status,409)
  const deleted = await deleteProject(new Request('http://localhost/api/projects/' + project.id, { method: 'DELETE', headers: cookie(session.token) }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(deleted.status, 409)
  assert.equal(((await deleted.json()) as { code?: string }).code, 'PROJECT_RETENTION_REQUIRED')
})

test('PATCH /api/projects/[projectId] rejects collaborator and progress fields', async () => {
  const owner = createOrUpdateUser({ username: 'collaborator-owner', displayName: '协作者负责人', password: 'password-123', role: 'researcher' })
  const collaborator = createOrUpdateUser({ username: 'disabled-collaborator', displayName: '停用协作者', password: 'password-123', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '协作者校验课题' })
  const session = createSession(owner.id)
  const collab = await patchProject(new Request('http://localhost/api/projects/' + project.id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify({ expectedUpdatedAt: project.updatedAt, collaboratorIds: [collaborator.id] }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(collab.status, 409)
  const progress = await patchProject(new Request('http://localhost/api/projects/' + project.id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify({ expectedUpdatedAt: project.updatedAt, stage: '已完成', progress: 100 }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(progress.status, 409)
  assert.equal(((await progress.json()) as { code?: string }).code, 'PROJECT_FIELD_RETIRED')
})

test('PATCH /api/projects/[projectId] requires expectedUpdatedAt', async () => {
  const owner = createOrUpdateUser({ username: 'lock-project-owner', displayName: '锁课题负责人', password: 'password-123', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '锁课题' })
  const session = createSession(owner.id)
  const missing = await patchProject(new Request('http://localhost/api/projects/' + project.id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify({ title: '锁课题' }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(missing.status, 400)
  const invalid = await patchProject(new Request('http://localhost/api/projects/' + project.id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookie(session.token) },
    body: JSON.stringify({ title: '锁课题', expectedUpdatedAt: 'not-a-date' }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(invalid.status, 400)
})
