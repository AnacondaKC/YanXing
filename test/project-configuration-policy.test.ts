import assert from 'node:assert/strict'
import test from 'node:test'
import { canEditProjectConfiguration, type ProjectConfigurationEditContext } from '../modules/projects/configuration-policy'
import { canWriteProjectReports } from '../modules/reports/submission-policy'
import { SubmissionWorkspaceRepository } from '../lib/db/submission-workspace-repository'
import { SubmissionQueryRepository } from '../lib/db/submission-query-repository'
import { createSubmissionWorkspaceHandlers } from '../lib/http/submission-workspace-handlers'
import { createTaskFixture, testAnalysisResult } from './helpers/submission-task-fixture'

const editorAccess: ProjectConfigurationEditContext = {
  projectId: 'project',
  actor: { id: 'editor', role: 'researcher', status: 'active' },
  membership: { projectId: 'project', userId: 'editor', role: 'editor' },
}

test('configuration permission is project-scoped and does not imply report or AI permission', () => {
  assert.equal(canEditProjectConfiguration(editorAccess), true)
  assert.equal(canWriteProjectReports(editorAccess), false)
  assert.equal(canEditProjectConfiguration({ ...editorAccess, membership: undefined }), false)
  assert.equal(canEditProjectConfiguration({ ...editorAccess, projectId: 'other' }), false)
  assert.equal(canEditProjectConfiguration({ ...editorAccess, membership: { ...editorAccess.membership!, userId: 'other' } }), false)
  assert.equal(canEditProjectConfiguration({ ...editorAccess, actor: { ...editorAccess.actor!, status: 'disabled' } }), false)
  assert.equal(canEditProjectConfiguration({ ...editorAccess, actor: { id: 'admin', role: 'admin', status: 'active' } }), true)
  assert.equal(canEditProjectConfiguration({ ...editorAccess, actor: { id: 'admin', role: 'admin', status: 'disabled' } }), false)
  assert.equal(canEditProjectConfiguration({ ...editorAccess, membership: { ...editorAccess.membership!, role: 'owner' } }), true)
})

function workspaceFor(fixture: ReturnType<typeof createTaskFixture>) {
  return new SubmissionWorkspaceRepository({ database: fixture.database, reports: fixture.reports, tasks: fixture.tasks,
    queries: new SubmissionQueryRepository({ database: fixture.database, tasks: fixture.tasks }) })
}

test('editor metadata and plan edits preserve published analysis, frozen evaluation input, and workflow state', () => {
  const f = createTaskFixture()
  try {
    const workspace = workspaceFor(f)
    const report = f.submit()
    const job = f.tasks.admit({ actorId: 'owner', reportId: report.reportId, operation: 'analysis' }).task
    const claim = f.tasks.claim()!
    f.checkpoint(claim)
    f.tasks.complete(claim, testAnalysisResult(84))
    const before = workspace.getProjectDetail({ actorId: 'editor', projectId: 'project' })
    const results = f.tasks.listResults(report.reportId, 'analysis')
    const storedReport = f.tasks.getReport(report.reportId)
    const frozenJob = f.tasks.getTask(job.id)
    assert.equal(before.project.canManage, true)
    assert.equal(before.project.canEditPlan, true)
    assert.equal(before.project.canSubmit, false)
    assert.equal(before.selectedReport?.capabilities.canEditPlan, true)
    assert.equal(before.selectedReport?.capabilities.analysisAction, 'none')
    const after = workspace.safeEditProject({ actorId: 'editor', projectId: 'project', edit: {
      expectedUpdatedAt: before.project.updatedAt, title: '修订标题', objective: '新的研究目标', description: '修订背景',
    } })
    assert.equal(after.project.objective, '新的研究目标')
    assert.deepEqual(after.selectedReport?.snapshot, before.selectedReport?.snapshot)
    assert.deepEqual(after.workflow, before.workflow)
    assert.throws(() => workspace.safeEditProject({ actorId: 'editor', projectId: 'project', edit: { expectedUpdatedAt: before.project.updatedAt, title: '过期' } }), { code: 'PROJECT_UPDATE_CONFLICT' })
    const plan = f.reports.loadWorkflow({ actorId: 'owner', projectId: 'project' })
    assert.throws(() => f.reports.editPlan({ actorId: 'editor', projectId: 'project', edit: { expectedPlanRevision: 0, nextStages: [{ id: 'new-stage', title: '非法结构修改' }] } }), /不能增删或重排/)
    const nextStages = plan.stages.map(stage => ({ id: stage.id, title: stage.title + '修订', description: '修订说明', plannedEndAt: '2028-01-01' }))
    const changed = f.reports.editPlan({ actorId: 'editor', projectId: 'project', edit: { expectedPlanRevision: 0, nextStages } })
    assert.equal(changed.planRevision, 1)
    assert.equal(changed.workflowRevision, plan.workflowRevision)
    assert.throws(() => f.reports.editPlan({ actorId: 'editor', projectId: 'project', edit: { expectedPlanRevision: 0, nextStages } }), { code: 'PROJECT_PLAN_CHANGED' })
    assert.deepEqual(f.tasks.listResults(report.reportId, 'analysis'), results)
    assert.deepEqual(f.tasks.getReport(report.reportId), storedReport)
    assert.deepEqual(f.tasks.getTask(job.id), frozenJob)
    assert.deepEqual(workspace.getReportDetail({ actorId: 'editor', reportId: report.reportId }).snapshot, before.selectedReport?.snapshot)
    assert.throws(() => f.tasks.admit({ actorId: 'editor', reportId: report.reportId, operation: 'analysis' }), /REPORT_WRITE_FORBIDDEN/)
    assert.throws(() => f.tasks.admit({ actorId: 'editor', reportId: report.reportId, operation: 'insight' }), /REPORT_WRITE_FORBIDDEN/)
    assert.throws(() => f.reports.beginUpload({ actorId: 'editor', projectId: 'project', uploadId: 'forbidden-upload', fileName: 'report.docx', reservedBytes: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { code: 'REPORT_WRITE_FORBIDDEN' })
  } finally { f.database.close() }
})

test('repository edits reauthorize revoked memberships and disabled accounts rather than trusting capability reads', () => {
  const f = createTaskFixture()
  try {
    const workspace = workspaceFor(f)
    const before = workspace.getProjectDetail({ actorId: 'editor', projectId: 'project' })
    const edit = { expectedUpdatedAt: before.project.updatedAt, objective: '不应写入' }
    const planEdit = { expectedPlanRevision: 0, nextStages: [{ id: 'stage-a', title: '不应写入' }] }
    assert.throws(() => workspace.safeEditProject({ actorId: 'other', projectId: 'project', edit }), { code: 'PROJECT_CONFIGURATION_FORBIDDEN' })
    assert.throws(() => f.reports.editPlan({ actorId: 'other', projectId: 'project', edit: planEdit }), { code: 'PROJECT_CONFIGURATION_FORBIDDEN' })
    f.database.exec("UPDATE users SET status='disabled' WHERE id='editor'")
    assert.throws(() => workspace.safeEditProject({ actorId: 'editor', projectId: 'project', edit }), { code: 'UNAUTHENTICATED' })
    assert.throws(() => f.reports.editPlan({ actorId: 'editor', projectId: 'project', edit: planEdit }), { code: 'PROJECT_CONFIGURATION_FORBIDDEN' })
    f.database.exec("UPDATE users SET status='active' WHERE id='editor'; DELETE FROM project_members WHERE user_id='editor'")
    assert.throws(() => workspace.safeEditProject({ actorId: 'editor', projectId: 'project', edit }), { code: 'PROJECT_CONFIGURATION_FORBIDDEN' })
    assert.throws(() => f.reports.editPlan({ actorId: 'editor', projectId: 'project', edit: planEdit }), { code: 'PROJECT_CONFIGURATION_FORBIDDEN' })
    assert.equal(workspace.getProjectDetail({ actorId: 'editor', projectId: 'project' }).project.canManage, false)
    assert.equal(workspace.getProjectDetail({ actorId: 'owner', projectId: 'project' }).project.updatedAt, before.project.updatedAt)
  } finally { f.database.close() }
})

test('live stage handler enforces editor authorization and revision checks', async () => {
  const f = createTaskFixture()
  try {
    type HandlerInput = Parameters<typeof createSubmissionWorkspaceHandlers>[0]
    const handlers = createSubmissionWorkspaceHandlers({
      processing: { repository: f.reports } as HandlerInput['processing'], workspace: workspaceFor(f),
      getCurrentUser: () => ({ id: 'editor' }) as ReturnType<HandlerInput['getCurrentUser']>,
    })
    const request = () => new Request('http://localhost/plan', { method: 'PATCH', body: JSON.stringify({ expectedPlanRevision: 0, nextStages: [{ id: 'stage-a', title: '协作修订' }] }) })
    assert.equal((await handlers.listStages(new Request('http://localhost/plan'), 'project')).status, 200)
    assert.equal((await handlers.editPlan(request(), 'project')).status, 200)
    assert.equal((await handlers.editPlan(request(), 'project')).status, 409)
    f.database.exec("UPDATE users SET status='disabled' WHERE id='editor'")
    assert.equal((await handlers.editPlan(request(), 'project')).status, 401)
  } finally { f.database.close() }
})
