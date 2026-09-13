import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskFixture, testAnalysisResult } from './helpers/submission-task-fixture'
import { SubmissionQueryRepository } from '../lib/db/submission-query-repository'
import { SubmissionWorkspaceRepository } from '../lib/db/submission-workspace-repository'
import { cumulativeTrend, runningAverageValues } from '../lib/overview-trends'
import { notificationActions } from '../modules/notifications/domain'

function fixture() {
  const f = createTaskFixture()
  const queries = new SubmissionQueryRepository({ database: f.database, tasks: f.tasks })
  const workspace = new SubmissionWorkspaceRepository({ database: f.database, tasks: f.tasks, queries, reports: f.reports })
  return { ...f, queries, workspace }
}

function succeed(f: ReturnType<typeof fixture>, reportId: string, score: number) {
  f.tasks.admit({ actorId: 'owner', reportId, operation: 'analysis' })
  const claim = f.tasks.claim()!
  f.checkpoint(claim)
  return f.tasks.complete(claim, { ...testAnalysisResult(score), largeDocument: 'private-document'.repeat(20_000) })
}

test('batch cards preserve detail policy, zero scores, predecessor and deleted semantics with bounded queries and payload', (t) => {
  const f = fixture()
  try {
    const first = f.submit()
    succeed(f, first.reportId, 0)
    const second = f.submit()
    succeed(f, second.reportId, 20)
    const deleted = f.submit()
    f.tasks.deleteReport({ actorId: 'owner', reportId: deleted.reportId, reason: 'fixture withdrawal' })
    const completion = f.submit({ kind: 'completion' })
    for (let index = 0; index < 3; index++) succeed(f, completion.reportId, 30)
    const expected = [completion, second, first].map(receipt => f.workspace.getReportDetail({ actorId: 'owner', reportId: receipt.reportId }))
    const prepare = f.database.prepare.bind(f.database)
    const sql: string[] = []
    t.mock.method(f.database, 'prepare', (query: string) => { sql.push(query); return prepare(query) })
    t.mock.method(f.workspace, 'getReportDetail', () => { throw new Error('list must not read detail') })
    t.mock.method(f.tasks, 'listResults', () => { throw new Error('list must not load result documents') })
    t.mock.method(f.tasks, 'latestTask', () => { throw new Error('list must batch task metadata') })
    const read = (limit: number) => { sql.length = 0; const page = f.workspace.listLibraryReports({ actorId: 'owner', pagination: { limit, offset: 0 } }); return { page, count: sql.length } }
    const small = read(1)
    const large = read(100)
    assert.equal(large.count, small.count)
    assert.ok(large.count <= 10, String(large.count))
    assert.equal('items' in large.page, false)
    for (const card of large.page.reports) {
      const detail = expected.find(item => item.id === card.id)!
      assert.deepEqual(card.capabilities, detail.capabilities)
      assert.deepEqual(card.comparison, detail.comparison)
      assert.equal(card.aiScore, detail.aiScore)
      assert.equal(card.wasFirstStageSubmission, detail.wasFirstStageSubmission)
      for (const key of ['snapshot', 'insight', 'history', 'job', 'frozen_json']) assert.equal(key in card, false)
    }
    assert.equal(large.page.reports.find(card => card.id === first.reportId)?.aiScore, 0)
    assert.equal(large.page.reports[0].capabilities.canDelete, false)
    assert.equal(large.page.reports[0].capabilities.analysisAction, 'none')
    assert.ok(JSON.stringify(large.page).length < 10_000)
    assert.equal(sql.some(query => query.includes('frozen_json')), false)
    const projects = f.workspace.listProjects({ actorId: 'owner', pagination: { limit: 100, offset: 0 } })
    assert.equal('items' in projects, false)
    assert.equal(projects.projects[0].submittedReportCount, 3)
    assert.equal(f.workspace.overview({ actorId: 'owner' }).recentReports.length, 3)
  } finally { f.database.close() }
})

test('query counts stay constant as report and project pages grow', (t) => {
  const f = fixture()
  try {
    const first = f.submit()
    const prepare = f.database.prepare.bind(f.database)
    let count = 0
    t.mock.method(f.database, 'prepare', (sql: string) => { count++; return prepare(sql) })
    const measured = (read: () => unknown) => { count = 0; read(); return count }
    const detailRead = () => f.workspace.getReportDetail({ actorId: 'owner', reportId: first.reportId })
    const detailBefore = measured(detailRead)
    for (let index = 0; index < 60; index++) f.submit()
    for (let index = 0; index < 20; index++) f.reports.createProject({ actorId: 'owner', project: { ownerId: 'owner', title: 'project ' + index, objective: 'objective', description: 'description', stages: [{ id: 'stage-' + index, title: 'stage', description: 'research', plannedEndAt: '2030-01-01' }] } })
    assert.equal(measured(detailRead), detailBefore)
    const library = (limit: number) => () => f.workspace.listLibraryReports({ actorId: 'owner', pagination: { limit, offset: 0 } })
    const projects = (limit: number) => () => f.workspace.listProjects({ actorId: 'owner', pagination: { limit, offset: 0 } })
    assert.equal(measured(library(1)), measured(library(100)))
    const smallProjects = measured(projects(1))
    const largeProjects = measured(projects(100))
    // Empty projects need no task/result reads; a populated page adds one shared batch, not per-card reads.
    assert.ok(largeProjects <= smallProjects + 3)
    assert.ok(largeProjects <= 11)
    assert.ok(measured(() => f.workspace.overview({ actorId: 'owner' })) <= 23)
  } finally { f.database.close() }
})

test('SQL overview equals event-based golden trends including old baseline and zero scores', () => {
  const f = fixture()
  try {
    const scores: Array<{ at: string; value: number }> = []
    const reports: Array<{ at: string; value: number }> = []
    for (const [offset, value] of [[-12, 0], [-5, 80], [-1, 40]]) {
      f.clock.offset = offset * 86_400_000
      const receipt = f.submit()
      reports.push({ at: f.tasks.getReport(receipt.reportId)!.submittedAt, value: 1 })
      const result = succeed(f, receipt.reportId, value)
      scores.push({ at: result.createdAt, value })
    }
    const overview = f.workspace.overview({ actorId: 'owner' })
    assert.deepEqual(overview.stats.trends.averageScore, runningAverageValues(scores).map(Math.round))
    assert.deepEqual(overview.stats.trends.submissions, cumulativeTrend(reports))
    assert.deepEqual(overview.stats.trends.characters, cumulativeTrend(reports.map(row => ({ ...row, value: 4 }))))
    assert.equal(overview.stats.weeklyNewReports, 2)
    assert.equal(overview.stats.totalCharacters, 12)
    assert.equal(overview.stats.jobStats.completed, 3)
    assert.equal(overview.stats.trends.successRate.at(-1), 100)
  } finally { f.database.close() }
})

test('notification batch rollback is best-effort after committed edit; all ignores ids and selected ids are user-scoped', () => {
  const f = fixture()
  try {
    const actor = f.workspace.actor('owner')
    const activity = { action: notificationActions.projectUpdated, actor, projectId: 'project', summary: 'updated', detail: 'updated project' }
    f.workspace.recordActivity(activity)
    const owner = f.workspace.listNotifications({ actorId: 'owner', pagination: { limit: 100, offset: 0 } }).notifications[0]
    const admin = f.workspace.listNotifications({ actorId: 'admin', pagination: { limit: 100, offset: 0 } }).notifications[0]
    assert.equal(f.workspace.markNotificationsRead({ actorId: 'owner', ids: [owner.id, owner.id, admin.id] }), 1)
    assert.equal(f.workspace.markNotificationsRead({ actorId: 'admin', all: true, ids: [owner.id, 'ignored'] }), 1)
    const before = f.database.prepare('SELECT COUNT(*) AS count FROM notifications').get()!.count
    f.database.exec("CREATE TEMP TRIGGER notification_fault BEFORE INSERT ON notifications WHEN NEW.recipient_user_id='owner' BEGIN SELECT RAISE(ABORT,'injected notification failure'); END")
    const current = f.workspace.getProjectDetail({ actorId: 'owner', projectId: 'project' })
    const edited = f.workspace.safeEditProject({ actorId: 'owner', projectId: 'project', edit: { expectedUpdatedAt: current.project.updatedAt, title: 'committed title' } })
    assert.equal(edited.project.title, 'committed title')
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM notifications').get()!.count, before)
    assert.equal(f.database.isTransaction, false)
  } finally { f.database.close() }
})
