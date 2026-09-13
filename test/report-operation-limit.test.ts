import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EMPTY_SNAPSHOT } from '../lib/analysis-job-progress'
import { DashboardView } from '../components/dashboard-view'
import { InsightWorkspace } from '../components/insight-workspace'
import { SubmissionQueryRepository } from '../lib/db/submission-query-repository'
import { SubmissionWorkspaceRepository } from '../lib/db/submission-workspace-repository'
import { createSubmissionWorkspaceHandlers } from '../lib/http/submission-workspace-handlers'
import type { WorkspaceReportDetail } from '../modules/contracts/submission-workspace'
import type { ReportOperation } from '../modules/reports/submission-domain'
import { createTaskFixture } from './helpers/submission-task-fixture'

const analysisPayload = {
  kind: 'analysis',
  snapshot: { payload: { ...EMPTY_SNAPSHOT, aiScore: {
    overall: 83, summary: '保留分析结果',
    dimensions: [{ id: 'evidence', label: '保留证据评分', score: 83 }],
  } } },
}
const insightPayload = {
  kind: 'insight',
  insight: { title: '保留洞察结果', summary: '研究摘要', readingMinutes: 1, sections: [], html: '<h1>保留洞察正文</h1>' },
}

function renderOperation(operation: ReportOperation, report: WorkspaceReportDetail) {
  return operation === 'analysis'
    ? renderToStaticMarkup(createElement(DashboardView, {
      report, snapshot: report.snapshot, analysisTask: report.analysisTask,
      canManage: true, onStartAnalysis() {}, async onCancelAnalysis() {},
    }))
    : renderToStaticMarkup(createElement(InsightWorkspace, {
      report, insight: report.insight, insightTask: report.insightTask,
      canManage: true, onGenerate() {}, onCancel() {},
    }))
}

for (const operation of ['analysis', 'insight'] as const) {
  test(operation + ': three successful results cap admission and hide rerun without discarding output', async context => {
    const fixture = createTaskFixture()
    context.after(() => fixture.database.close())
    const { tasks } = fixture
    const queries = new SubmissionQueryRepository(fixture)
    const workspace = new SubmissionWorkspaceRepository({ ...fixture, queries })
    type HandlerInput = Parameters<typeof createSubmissionWorkspaceHandlers>[0]
    const live = createSubmissionWorkspaceHandlers({
      processing: { tasks } as HandlerInput['processing'], workspace,
      getCurrentUser: request => ({ id: request.headers.get('x-test-actor') ?? 'owner' }) as ReturnType<HandlerInput['getCurrentUser']>,
    })
    const start = (actorId: string) => operation === 'analysis'
      ? live.startAnalysis(request(actorId), reportId)
      : live.startInsight(request(actorId), reportId)
    const { reportId } = fixture.submit()
    const input = { actorId: 'owner', reportId, operation }
    const request = (actorId: string) => new Request('http://localhost/api/tasks', {
      method: 'POST', headers: { 'x-test-actor': actorId },
    })
    const payload = operation === 'analysis' ? analysisPayload : insightPayload
    const actionKey = operation === 'analysis' ? 'analysisAction' : 'insightAction'
    const otherOperation = operation === 'analysis' ? 'insight' : 'analysis'
    const buttonLabel = operation === 'analysis' ? '更新分析' : '重新生成洞察'
    const resultText = operation === 'analysis' ? /保留证据评分/ : /保留洞察正文/
    const history = () => tasks.history(tasks.getReport(reportId)!, operation)

    const failed = tasks.admit(input).task
    tasks.fail(tasks.claim()!, 'SOURCE_UNAVAILABLE')
    const cancelled = tasks.admit(input).task
    tasks.cancel({ actorId: 'owner', jobId: cancelled.id })
    assert.equal(tasks.getTask(failed.id)?.status, 'failed')
    assert.equal(tasks.getTask(cancelled.id)?.status, 'cancelled')
    assert.equal(history().successCount, 0)

    for (let successCount = 1; successCount <= 3; successCount++) {
      const concurrent = await Promise.all([start('owner'), start('admin'), live.retryJob(request('owner'), failed.id)])
      assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 200, 202])
      const bodies = await Promise.all(concurrent.map(response => response.json()))
      assert.equal(new Set(bodies.map(body => body.job.id)).size, 1)
      const admitted = { task: tasks.latestTask(reportId, operation)! }
      const queued = await start('owner')
      assert.equal(queued.status, 200)
      const queuedReuse = await queued.json()
      assert.equal(queuedReuse.reused, true)
      assert.equal(queuedReuse.job.id, admitted.task.id)
      assert.equal(queuedReuse.job.generation, admitted.task.generation)
      assert.equal(queuedReuse.job.status, 'queued')
      const claim = tasks.claim()!
      const running = await live.retryJob(request('admin'), failed.id)
      assert.equal(running.status, 200)
      const reused = await running.json()
      assert.equal(reused.reused, true)
      assert.equal(reused.job.id, admitted.task.id)
      assert.equal(reused.job.generation, admitted.task.generation)
      assert.equal(reused.job.status, 'running')
      fixture.checkpoint(claim)
      tasks.complete(claim, payload)
      assert.equal(history().successCount, successCount)
      assert.equal(tasks.latestTask(reportId, operation)?.generation, successCount + 2)

      if (successCount < 2) continue
      const detail = workspace.getReportDetail(input)
      const native = queries.detail('owner', reportId)
      assert.equal(detail.history[operation].length, successCount)
      assert.deepEqual(native.results[operation]?.payload, payload)
      assert.equal(detail.capabilities[actionKey], successCount === 2 ? 'rerun' : 'none')
      const markup = renderOperation(operation, detail)
      const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.join('') ?? ''
      assert.equal(buttons.includes(buttonLabel), successCount === 2)
      assert.match(markup, resultText)
    }

    for (const actorId of ['owner', 'admin']) {
      const responses = await Promise.all([
        start(actorId),
        live.retryJob(request(actorId), failed.id),
        live.retryJob(request(actorId), cancelled.id),
      ])
      for (const response of responses) {
        assert.equal(response.status, 409)
        assert.equal((await response.json()).code, 'REPORT_OPERATION_SUCCESS_LIMIT')
      }
      assert.deepEqual(queries.detail(actorId, reportId).capabilities[operation], {
        kind: 'denied', code: 'REPORT_OPERATION_SUCCESS_LIMIT',
      })
      assert.equal(workspace.getReportDetail({ actorId, reportId }).capabilities[actionKey], 'none')
    }
    assert.equal(tasks.latestTask(reportId, operation)?.generation, 5)
    assert.equal(tasks.listResults(reportId, operation).length, 3)
    assert.equal(tasks.admit({ ...input, operation: otherOperation }).reused, false)
    assert.equal(tasks.history(tasks.getReport(reportId)!, otherOperation).successCount, 0)
    const newReport = fixture.submit()
    assert.equal(tasks.history(tasks.getReport(newReport.reportId)!, operation).successCount, 0)
    assert.equal(tasks.admit({ ...input, reportId: newReport.reportId }).reused, false)
    assert.equal(tasks.latestTask(newReport.reportId, operation)?.generation, 1)
  })
}
