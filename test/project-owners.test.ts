import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Milestone } from '../modules/projects/domain'

const directory = await mkdtemp(`${tmpdir()}/yanxing-project-owners-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'project-owners-test.sqlite')

const { createOrUpdateUser, createSession, sessionCookieName, updateManagedUser } = await import('../lib/auth/session')
const { assignReportMilestone, createProjectForUser, createReportJob, deleteReportVersion, getLatestJobForReport, getProject, getReport, getReportSource, getUserProjectRole, updateProject } = await import('../lib/db/repository')
const { getDatabase } = await import('../lib/db/client')
const { POST: createProjectRoute } = await import('../app/api/projects/route')
const { POST: uploadProjectReport } = await import('../app/api/projects/[projectId]/reports/route')
const { PATCH: patchProject } = await import('../app/api/projects/[projectId]/route')
const { PATCH: patchReport } = await import('../app/api/reports/[reportId]/route')
const { POST: analyzeReport } = await import('../app/api/reports/[reportId]/analyze/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function reportSource(sha256: string) {
  return {
    path: path.join(directory, `${sha256}.docx`),
    fileName: `${sha256}.docx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 100,
    sha256,
  }
}

function validMilestone(id: string, title: string, patch: Partial<Milestone> = {}): Milestone {
  return {
    id,
    title,
    targetDate: '2026-12-31',
    description: title + '的工作内容与预期成果',
    status: 'not_started',
    ...patch,
  }
}

function projectPatchRequest(token: string, projectId: string, body: Record<string, unknown>) {
  const current = getProject(projectId)
  return new Request(`http://localhost/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: `${sessionCookieName}=${encodeURIComponent(token)}` },
    body: JSON.stringify({
      ...(current ? { updatedAt: current.updatedAt } : {}),
      ...body,
    }),
  })
}

test('projects keep exactly one owner and only administrators can transfer ownership', async () => {
  const first = createOrUpdateUser({ username: 'single-owner-first', displayName: '第一负责人', password: 'single-owner-first-123', role: 'researcher' })
  const second = createOrUpdateUser({ username: 'single-owner-second', displayName: '第二负责人', password: 'single-owner-second-123', role: 'researcher' })
  const admin = createOrUpdateUser({ username: 'single-owner-admin', displayName: '转移管理员', password: 'single-owner-admin-123', role: 'admin' })

  const project = createProjectForUser({ title: '单负责人课题', objective: '', description: '', ownerName: first.displayName }, first.id)
  assert.equal(project.ownerId, first.id)
  assert.equal(getUserProjectRole(project.id, first), 'owner')

  const updated = updateProject(project.id, {
    title: '单负责人课题',
    ownerId: second.id,
    ownerName: second.displayName,
  })
  assert.ok(updated)
  assert.equal(updated.ownerId, second.id)
  assert.equal(getUserProjectRole(project.id, first), 'editor')
  assert.equal(getUserProjectRole(project.id, second), 'owner')

  // 原负责人（研究员）不能变更负责人。
  const firstSession = createSession(first.id)
  const rejected = await patchProject(projectPatchRequest(firstSession.token, project.id, { ownerId: first.id }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(rejected.status, 403)
  assert.equal(getUserProjectRole(project.id, second), 'owner')

  // 管理员可以将负责人改回其他人。
  const adminSession = createSession(admin.id)
  const transferred = await patchProject(projectPatchRequest(adminSession.token, project.id, { ownerId: first.id }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(transferred.status, 200)
  assert.equal(getUserProjectRole(project.id, first), 'owner')
  assert.equal(getUserProjectRole(project.id, second), 'editor')
})

test('POST /api/projects defaults the owner to the creator and restricts researchers', async () => {
  const researcher = createOrUpdateUser({ username: 'create-owner-researcher', displayName: '创建研究员', password: 'create-owner-researcher-123', role: 'researcher' })
  const other = createOrUpdateUser({ username: 'create-owner-other', displayName: '其他研究员', password: 'create-owner-other-123', role: 'researcher' })
  const admin = createOrUpdateUser({ username: 'create-owner-admin', displayName: '创建管理员', password: 'create-owner-admin-123', role: 'admin' })
  const session = createSession(researcher.id)
  const adminSession = createSession(admin.id)
  const base = {    title: '负责人默认课题',
    objective: '验证课题负责人默认规则',
    description: '验证创建课题时负责人默认为创建者',
    milestones: [validMilestone('stage-1', '阶段一')],
  }
  // 研究员不传 ownerId：负责人为创建者本人。
  const defaults = await createProjectRoute(new Request('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookieName + '=' + encodeURIComponent(session.token) },
    body: JSON.stringify(base),
  }))
  assert.equal(defaults.status, 201)
  const defaultBody = await defaults.json() as { project?: { ownerId?: string } }
  assert.equal(defaultBody.project?.ownerId, researcher.id)

  // 研究员指定他人为负责人：403。
  const rejected = await createProjectRoute(new Request('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookieName + '=' + encodeURIComponent(session.token) },
    body: JSON.stringify({ ...base, title: '越权负责人课题', ownerId: other.id }),
  }))
  assert.equal(rejected.status, 403)
  const rejectedBody = await rejected.json() as { error?: string }
  assert.match(rejectedBody.error ?? '', /只有管理员可以指定其他人/)

  // 管理员可以指定其他人为负责人。
  const adminCreated = await createProjectRoute(new Request('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: sessionCookieName + '=' + encodeURIComponent(adminSession.token) },
    body: JSON.stringify({ ...base, title: '管理员指定负责人课题', ownerId: other.id }),
  }))
  assert.equal(adminCreated.status, 201)
  const adminBody = await adminCreated.json() as { project?: { ownerId?: string } }
  assert.equal(adminBody.project?.ownerId, other.id)
})

test('POST /api/projects requires project context and a complete milestone', async () => {
  const user = createOrUpdateUser({ username: 'required-project-tester', displayName: '必填校验测试员', password: 'password-123', role: 'researcher' })
  const session = createSession(user.id)
  const base = {
    title: '必填规则课题',
    objective: '验证课题必填规则',
    description: '验证研究背景与阶段计划校验',
    ownerId: user.id,
    milestones: [validMilestone('stage-1', '阶段一')],
  }
  const cases = [
    { patch: { objective: '   ' }, expected: /研究目标与核心问题不能为空/ },
    { patch: { description: '' }, expected: /研究背景与说明不能为空/ },
    { patch: { milestones: [] }, expected: /至少创建一个研究阶段/ },
    { patch: { milestones: [{ ...validMilestone('stage-1', '阶段一'), description: '' }] }, expected: /工作内容与预期成果/ },
  ]
  for (const item of cases) {
    const response = await createProjectRoute(new Request('http://localhost/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookieName + '=' + encodeURIComponent(session.token) },
      body: JSON.stringify({ ...base, ...item.patch }),
    }))
    assert.equal(response.status, 400)
    const body = await response.json() as { error?: string }
    assert.match(body.error ?? '', item.expected)
  }
})

test('historical report must be assigned to a stage before analysis', async () => {
  const owner = createOrUpdateUser({ username: 'report-stage-owner', displayName: '历史阶段负责人', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({ title: '历史报告补选课题', objective: '验证历史报告阶段补选', description: '确保分析使用明确阶段基准', ownerName: owner.displayName }, owner.id)
  updateProject(project.id, { milestones: [validMilestone('stage-1', '历史阶段')] })
  const report = createReportJob({
    projectId: project.id,
    fileName: '历史报告.docx',
    source: reportSource('historical-stage-hash'),
    reportId: undefined,
    milestoneId: undefined,
    autoAnalyze: false,
  }).report
  const session = createSession(owner.id)
  const headers = { 'Content-Type': 'application/json', cookie: sessionCookieName + '=' + encodeURIComponent(session.token) }

  const blocked = await analyzeReport(new Request('http://localhost/api/reports/' + report.id + '/analyze', { method: 'POST', headers }), { params: Promise.resolve({ reportId: report.id }) })
  assert.equal(blocked.status, 409)
  assert.equal(((await blocked.json()) as { code?: string }).code, 'REPORT_STAGE_REQUIRED')

  const assigned = await patchReport(new Request('http://localhost/api/reports/' + report.id, {
    method: 'PATCH', headers, body: JSON.stringify({ milestoneId: 'stage-1' }),
  }), { params: Promise.resolve({ reportId: report.id }) })
  assert.equal(assigned.status, 200)
  assert.equal(getReport(report.id)?.milestoneId, 'stage-1')

  const started = await analyzeReport(new Request('http://localhost/api/reports/' + report.id + '/analyze', { method: 'POST', headers }), { params: Promise.resolve({ reportId: report.id }) })
  assert.equal(started.status, 202)
})

test('report upload stays idle until the analysis endpoint is called', async () => {
  const owner = createOrUpdateUser({ username: 'manual-analysis-owner', displayName: '手动分析负责人', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({
    title: '手动启动分析课题',
    objective: '验证上传报告后不会自动分析',
    description: '确保研究工作台中的启动分析操作是唯一的任务触发入口',
    ownerName: owner.displayName,
    milestones: [validMilestone('stage-1', '报告分析阶段')],
  }, owner.id)
  const session = createSession(owner.id)
  const headers = {
    'Content-Type': 'application/pdf',
    'X-File-Name': encodeURIComponent('待分析报告.pdf'),
    'X-Milestone-Id': encodeURIComponent('stage-1'),
    'X-Report-Delivery-Type': 'stage',
    'X-Auto-Analyze': 'true',
    cookie: sessionCookieName + '=' + encodeURIComponent(session.token),
  }
  const pdf = new Blob(['%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'], { type: 'application/pdf' })
  let reportId = ''

  try {
    const uploaded = await uploadProjectReport(new Request(`http://localhost/api/projects/${project.id}/reports`, {
      method: 'POST',
      headers,
      body: pdf,
    }), { params: Promise.resolve({ projectId: project.id }) })
    const uploadBody = await uploaded.json() as { report?: { id: string }; job?: unknown }
    assert.equal(uploaded.status, 202)
    assert.ok(uploadBody.report?.id)
    assert.equal(uploadBody.job, undefined)
    reportId = uploadBody.report.id
    const storedSource = getReportSource(reportId)
    assert.equal(path.dirname(path.dirname(storedSource?.path ?? '')), path.join(process.cwd(), 'storage', 'reports'))
    assert.equal(getLatestJobForReport(reportId), undefined)

    const started = await analyzeReport(new Request(`http://localhost/api/reports/${reportId}/analyze`, {
      method: 'POST',
      headers: { cookie: sessionCookieName + '=' + encodeURIComponent(session.token) },
    }), { params: Promise.resolve({ reportId }) })
    assert.equal(started.status, 202)
    assert.equal(getLatestJobForReport(reportId)?.status, 'queued')
  } finally {
    if (reportId) await deleteReportVersion(reportId)
  }
})

test('PATCH /api/projects/[projectId] preserves published analysis when only the title changes', async () => {
  const owner = createOrUpdateUser({ username: 'rename-project-owner', displayName: '课题重命名负责人', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({
    title: '重命名前课题',
    objective: '验证重命名不影响分析结果',
    description: '课题名称属于展示信息，不应清空已经发布的报告分析',
    ownerName: owner.displayName,
    milestones: [validMilestone('stage-1', '分析阶段')],
  }, owner.id)
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: '已分析报告.docx',
    source: reportSource('rename-project-report-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const snapshotId = 'rename-project-snapshot'
  const database = getDatabase()
  database.prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(job.id)
  database.prepare(`
    INSERT INTO analysis_snapshots(
      id, job_id, report_version_id, kind, schema_version, prompt_version, pipeline_version,
      model_calls_json, artifacts_json, module_states_json, payload_json, created_at
    ) VALUES (?, ?, ?, 'final', 1, 'test-prompt', 'test-pipeline', '[]', '[]', '[]', '{}', ?)
  `).run(snapshotId, job.id, report.id, new Date().toISOString())
  database.prepare('UPDATE report_versions SET current_analysis_id = ? WHERE id = ?').run(snapshotId, report.id)
  assert.equal(getReport(report.id)?.currentAnalysisId, snapshotId)

  const currentProject = getProject(project.id)!
  const session = createSession(owner.id)
  const response = await patchProject(projectPatchRequest(session.token, project.id, {
    title: '重命名后课题',
    objective: currentProject.objective,
    description: currentProject.description,
    milestones: currentProject.milestones,
  }), { params: Promise.resolve({ projectId: project.id }) })

  assert.equal(response.status, 200)
  assert.equal(getProject(project.id)?.title, '重命名后课题')
  assert.equal(getReport(report.id)?.currentAnalysisId, snapshotId)
})

test('PATCH /api/projects/[projectId] rejects deleting a report-linked stage', async () => {
  const owner = createOrUpdateUser({ username: 'linked-stage-owner', displayName: '关联阶段负责人', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({ title: '关联阶段删除课题', objective: '验证阶段删除保护', description: '确保报告所属阶段不会被直接删除', ownerName: owner.displayName }, owner.id)
  updateProject(project.id, { milestones: [validMilestone('stage-1', '已关联阶段'), validMilestone('stage-2', '保留阶段')] })
  createReportJob({
    projectId: project.id,
    fileName: '关联报告.docx',
    source: reportSource('linked-stage-report-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
    deliveryType: 'stage',
  })
  const session = createSession(owner.id)

  const response = await patchProject(projectPatchRequest(session.token, project.id, {
    milestones: [validMilestone('stage-2', '保留阶段')],
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(response.status, 400)
  const body = await response.json() as { error?: string }
  assert.match(body.error ?? '', /已关联报告，不能直接删除/)
})

test('PATCH /api/projects/[projectId] enforces sequential stage progression and completed milestone report requirement', async () => {
  const user = createOrUpdateUser({ username: 'sequence-tester', displayName: '阶段顺序测试员', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({ title: '阶段顺序课题', objective: '验证阶段顺序规则', description: '用于验证阶段推进与成果关联', ownerName: user.displayName }, user.id)
  updateProject(project.id, { milestones: [
    validMilestone('stage-1', '阶段一', { status: 'in_progress' }),
    validMilestone('stage-2', '阶段二'),
  ] })
  const session = createSession(user.id)

  // 场景 1：上一阶段未完成，直接开启下一阶段 -> 报错 400
  const invalidSequenceBody = {
    milestones: [
      validMilestone('stage-1', '阶段一', { status: 'in_progress' }),
      validMilestone('stage-2', '阶段二', { status: 'in_progress' }),
    ],
  }

  const res1 = await patchProject(projectPatchRequest(session.token, project.id, invalidSequenceBody), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(res1.status, 400)
  const body1 = (await res1.json()) as { error?: string }
  assert.match(body1.error || '', /必须在上一阶段/)

  // 场景 2：阶段已完成，但未关联成果报告 -> 报错 400
  const missingReportBody = {
    milestones: [
      validMilestone('stage-1', '阶段一', { status: 'completed', reportIds: [] }),
      validMilestone('stage-2', '阶段二'),
    ],
  }

  const res2 = await patchProject(projectPatchRequest(session.token, project.id, missingReportBody), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(res2.status, 400)
  const body2 = (await res2.json()) as { error?: string }
  assert.match(body2.error || '', /已完成，必须关联成果报告/)

  // 场景 3：阶段一已完成并关联当前课题报告，阶段二推进中 -> 成功 200
  const report = createReportJob({
    projectId: project.id,
    fileName: '阶段一成果.docx',
    source: reportSource('sequence-report-hash'),
    reportId: undefined,
    milestoneId: undefined,
    autoAnalyze: false,
  }).report
  assignReportMilestone(report.id, 'stage-1')
  const validBody = {
    milestones: [
      validMilestone('stage-1', '阶段一', { status: 'completed', reportIds: [report.id] }),
      validMilestone('stage-2', '阶段二', { status: 'in_progress' }),
    ],
  }

  const res3 = await patchProject(projectPatchRequest(session.token, project.id, validBody), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(res3.status, 200)
  const body3 = (await res3.json()) as { project?: { milestones?: any[] } }
  assert.equal(body3.project?.milestones?.length, 2)
  assert.equal(body3.project?.milestones?.[0].status, 'completed')
  assert.deepEqual(body3.project?.milestones?.[0].reportIds, [report.id])
  assert.equal(body3.project?.milestones?.[1].status, 'in_progress')
  assert.equal('progressLogs' in (body3.project?.milestones?.[1] ?? {}), false)
  assert.equal('progress' in (body3.project?.milestones?.[1] ?? {}), false)

  const atRiskResponse = await patchProject(projectPatchRequest(session.token, project.id, {
    milestones: [
      validMilestone('stage-1', '阶段一', { status: 'completed', reportIds: [report.id] }),
      validMilestone('stage-2', '阶段二', { status: 'at_risk' }),
    ],
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(atRiskResponse.status, 200)
  const atRiskBody = (await atRiskResponse.json()) as { project?: { status?: string } }
  assert.equal(atRiskBody.project?.status, 'at_risk')
})

test('PATCH /api/projects/[projectId] rejects inactive collaborators before persistence', async () => {
  const owner = createOrUpdateUser({ username: 'collaborator-owner', displayName: '协作者负责人', password: 'password-123', role: 'researcher' })
  const collaborator = createOrUpdateUser({ username: 'disabled-collaborator', displayName: '停用协作者', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({ title: '协作者校验课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const session = createSession(owner.id)
  await updateManagedUser({ ...collaborator, status: 'disabled' })

  const response = await patchProject(projectPatchRequest(session.token, project.id, { collaboratorIds: [collaborator.id] }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error?: string }
  assert.match(body.error || '', /无效的协作者/)
  assert.equal(getUserProjectRole(project.id, collaborator), undefined)
})

test('PATCH /api/projects/[projectId] treats collaboratorIds as the complete editor set', async () => {
  const owner = createOrUpdateUser({ username: 'collaborator-revoke-owner', displayName: '撤权负责人', password: 'password-123', role: 'researcher' })
  const firstCollaborator = createOrUpdateUser({ username: 'collaborator-revoke-first', displayName: '旧协作者', password: 'password-123', role: 'researcher' })
  const secondCollaborator = createOrUpdateUser({ username: 'collaborator-revoke-second', displayName: '保留协作者', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({ title: '协作者撤权课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const session = createSession(owner.id)

  const added = await patchProject(projectPatchRequest(session.token, project.id, {
    collaboratorIds: [firstCollaborator.id, secondCollaborator.id],
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(added.status, 200)
  assert.equal(getUserProjectRole(project.id, firstCollaborator), 'editor')
  assert.equal(getUserProjectRole(project.id, secondCollaborator), 'editor')

  const removed = await patchProject(projectPatchRequest(session.token, project.id, {
    collaboratorIds: [secondCollaborator.id],
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(removed.status, 200)
  assert.equal(getUserProjectRole(project.id, firstCollaborator), undefined)
  assert.equal(getUserProjectRole(project.id, secondCollaborator), 'editor')
})

test('PATCH /api/projects/[projectId] rejects nonexistent and cross-project reports for completed milestones', async () => {
  const owner = createOrUpdateUser({ username: 'report-owner', displayName: '报告校验负责人', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({ title: '报告归属课题', objective: '验证报告归属', description: '用于验证报告与阶段关联', ownerName: owner.displayName }, owner.id)
  const otherProject = createProjectForUser({ title: '其他报告课题', objective: '提供跨课题报告', description: '用于验证跨课题关联被拒绝', ownerName: owner.displayName }, owner.id)
  const foreignReport = createReportJob({
    projectId: otherProject.id,
    fileName: '其他课题成果.docx',
    source: reportSource('foreign-report-hash'),
    reportId: undefined,
    milestoneId: undefined,
    autoAnalyze: false,
  }).report
  const session = createSession(owner.id)

  for (const reportId of ['missing-report', foreignReport.id]) {
    const response = await patchProject(projectPatchRequest(session.token, project.id, {
      milestones: [validMilestone('stage-1', '阶段一', { status: 'completed', reportIds: [reportId] })],
    }), { params: Promise.resolve({ projectId: project.id }) })
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error?: string }
    assert.match(body.error || '', /不存在或不属于当前课题/)
  }
})

test('PATCH /api/projects/[projectId] rejects client-submitted project progress and stage fields', async () => {
  const owner = createOrUpdateUser({ username: 'legacy-progress-owner', displayName: '旧进度负责人', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({ title: '旧字段校验课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const session = createSession(owner.id)

  const response = await patchProject(projectPatchRequest(session.token, project.id, { stage: '已完成', progress: 100 }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error?: string }
  assert.match(body.error || '', /自动生成/)
})

test('PATCH /api/projects/[projectId] requires a valid updatedAt', async () => {
  const owner = createOrUpdateUser({ username: 'lock-project-owner', displayName: '锁课题负责人', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({ title: '锁课题', objective: '验证乐观锁', description: '缺少更新时间应拒绝写入', ownerName: owner.displayName }, owner.id)
  const session = createSession(owner.id)
  const missing = await patchProject(new Request(`http://localhost/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: `${sessionCookieName}=${encodeURIComponent(session.token)}` },
    body: JSON.stringify({ title: '锁课题' }),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(missing.status, 400)
  const invalid = await patchProject(projectPatchRequest(session.token, project.id, { title: '锁课题', updatedAt: 'not-a-date' }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(invalid.status, 400)
})

test('PATCH /api/projects/[projectId] ignores unknown milestone fields', async () => {
  const owner = createOrUpdateUser({ username: 'ignore-unknown-owner', displayName: '忽略未知字段负责人', password: 'password-123', role: 'researcher' })
  const milestones = [validMilestone('stage-1', '阶段一')]
  const project = createProjectForUser({
    title: '忽略未知字段课题',
    objective: '验证未知字段被忽略',
    description: '阶段 payload 中的废弃字段不应导致失败',
    ownerName: owner.displayName,
    milestones,
  }, owner.id)
  const session = createSession(owner.id)

  const response = await patchProject(projectPatchRequest(session.token, project.id, {
    milestones: [{
      ...validMilestone('stage-1', '阶段一'),
      progress: 45,
      progressLogs: [],
      targetPeriod: '2026 Q1',
      weight: 50,
    }],
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { project?: { milestones?: Array<Record<string, unknown>> } }
  const milestone = body.project?.milestones?.[0] ?? {}
  assert.equal(milestone.id, 'stage-1')
  assert.equal('progress' in milestone, false)
  assert.equal('progressLogs' in milestone, false)
  assert.equal('targetPeriod' in milestone, false)
  assert.equal('weight' in milestone, false)
})

test('PATCH /api/projects/[projectId] derives project status and stage from milestones', async () => {
  const owner = createOrUpdateUser({ username: 'status-owner', displayName: '状态负责人', password: 'password-123', role: 'researcher' })
  const milestones = [validMilestone('stage-1', '成果交付阶段')]
  const project = createProjectForUser({ title: '状态推导课题', objective: '验证聚合状态', description: '由阶段状态推导课题状态', ownerName: owner.displayName, milestones }, owner.id)
  const report = createReportJob({
    projectId: project.id,
    fileName: '最终成果.docx',
    source: reportSource('derived-status-report'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
    deliveryType: 'final',
  }).report
  const session = createSession(owner.id)

  const response = await patchProject(projectPatchRequest(session.token, project.id, {
    milestones: [validMilestone('stage-1', '成果交付阶段', { status: 'completed', reportIds: [report.id] })],
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { project?: { status?: string; stage?: string; milestones?: Array<Record<string, unknown>> } }
  assert.equal(body.project?.status, 'completed')
  assert.equal(body.project?.stage, '已完成')
  assert.equal('progress' in (body.project ?? {}), false)
  assert.equal('progress' in (body.project?.milestones?.[0] ?? {}), false)
})

test('PATCH /api/projects/[projectId] enforces the collaborator limit of three', async () => {
  const owner = createOrUpdateUser({ username: 'cap-owner', displayName: '协作者上限负责人', password: 'cap-owner-123', role: 'researcher' })
  const collaborators = [
    createOrUpdateUser({ username: 'cap-collab-1', displayName: '协作者一', password: 'cap-collab-1-123', role: 'researcher' }),
    createOrUpdateUser({ username: 'cap-collab-2', displayName: '协作者二', password: 'cap-collab-2-123', role: 'researcher' }),
    createOrUpdateUser({ username: 'cap-collab-3', displayName: '协作者三', password: 'cap-collab-3-123', role: 'researcher' }),
    createOrUpdateUser({ username: 'cap-collab-4', displayName: '协作者四', password: 'cap-collab-4-123', role: 'researcher' }),
  ]
  const project = createProjectForUser({ title: '协作者上限课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const session = createSession(owner.id)

  const three = await patchProject(projectPatchRequest(session.token, project.id, {
    collaboratorIds: collaborators.slice(0, 3).map((user) => user.id),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(three.status, 200)

  const four = await patchProject(projectPatchRequest(session.token, project.id, {
    collaboratorIds: collaborators.map((user) => user.id),
  }), { params: Promise.resolve({ projectId: project.id }) })
  assert.equal(four.status, 400)
  const body = await four.json() as { error?: string }
  assert.match(body.error ?? '', /协作者不能超过 3 人/)
  for (const user of collaborators) {
    assert.equal(getUserProjectRole(project.id, user), user === collaborators[3] ? undefined : 'editor')
  }
})
