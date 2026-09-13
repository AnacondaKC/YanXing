import assert from 'node:assert/strict'
import test from 'node:test'
import { ReportSubmissionOutbox } from '../lib/db/report-submission-outbox'
import { SubmissionQueryRepository } from '../lib/db/submission-query-repository'
import { SubmissionTaskRepository } from '../lib/db/submission-task-repository'
import { createTaskFixture } from './helpers/submission-task-fixture'

const OUTBOX_LEASE_MS = 30_000
const RETRY_DELAY_MS = 60_000

for (const dispatchStatus of ['pending', 'leased'] as const) {
  test('deletion wins against a ' + dispatchStatus + ' outbox without an admitted task', () => {
    const fixture = createTaskFixture()
    const { database, tasks, now, clock } = fixture
    const outbox = new ReportSubmissionOutbox({ database, now, leaseMs: OUTBOX_LEASE_MS })
    const query = new SubmissionQueryRepository({ database, tasks })
    try {
      const { reportId } = fixture.submit()
      let event = outbox.claim()
      assert.ok(event)

      if (dispatchStatus === 'pending') {
        const failedEvent = event
        const unconfiguredTasks = new SubmissionTaskRepository({
          database,
          storageRoot: fixture.storageRoot,
          now,
          freeze: () => { throw new Error('分析页尚未选择模型。') },
        })
        assert.throws(() => outbox.deliver({
          eventId: failedEvent.id,
          leaseToken: failedEvent.leaseToken,
          enqueue: (intent, connection) => unconfiguredTasks.admitFromOutbox(intent, connection),
        }), /尚未选择模型/)
        outbox.retry({
          eventId: event.id,
          leaseToken: event.leaseToken,
          errorCode: 'AI_CONFIGURATION_ERROR',
          availableAt: new Date(now().getTime() + RETRY_DELAY_MS).toISOString(),
        })
        assert.equal(outbox.claim(), undefined)
      }

      const detail = query.detail('owner', reportId)
      assert.equal(detail.dispatch?.status, dispatchStatus)
      assert.equal(detail.dispatch?.errorCode, dispatchStatus === 'pending' ? 'AI_CONFIGURATION_ERROR' : undefined)
      assert.deepEqual(detail.tasks, { analysis: undefined, insight: undefined })
      assert.deepEqual(detail.capabilities.deletion, { kind: 'allowed' })

      tasks.deleteReport({ actorId: 'owner', reportId, reason: '  提交文件有误，撤回重传。 \n' })
      const deleted = tasks.getReport(reportId)
      assert.ok(deleted?.deletedAt)
      assert.equal(deleted.deletedBy, 'owner')
      assert.equal(deleted.deletionReason, '提交文件有误，撤回重传。')
      assert.throws(() => query.detail('owner', reportId), { code: 'REPORT_NOT_FOUND' })

      if (dispatchStatus === 'pending') {
        clock.offset += RETRY_DELAY_MS
        event = outbox.claim()
        assert.ok(event)
      }
      const lease = { eventId: event.id, leaseToken: event.leaseToken }
      assert.throws(() => outbox.deliver({
        ...lease,
        enqueue: (intent, connection) => tasks.admitFromOutbox(intent, connection),
      }), { code: 'REPORT_NOT_FOUND' })
      assert.equal(database.prepare('SELECT status FROM report_submission_outbox WHERE id=?').get(event.id)?.status, 'leased')

      outbox.dismissDeletedReport(lease)
      const dismissed = database.prepare('SELECT status,last_error,lease_token FROM report_submission_outbox WHERE id=?').get(event.id)
      assert.equal(dismissed?.status, 'delivered')
      assert.equal(dismissed?.last_error, 'REPORT_DELETED')
      assert.equal(dismissed?.lease_token, null)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM submission_tasks').get()?.count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM submission_task_dispatches').get()?.count, 0)
      assert.equal(tasks.claim(), undefined)
      assert.equal(outbox.claim(), undefined)
      assert.equal(tasks.getReport(reportId)?.deletedAt, deleted.deletedAt)
    } finally {
      database.close()
    }
  })
}

test('outbox admission wins the race and blocks deletion while its task is queued or running', () => {
  const fixture = createTaskFixture()
  const { database, tasks, now } = fixture
  const outbox = new ReportSubmissionOutbox({ database, now, leaseMs: OUTBOX_LEASE_MS })
  const query = new SubmissionQueryRepository({ database, tasks })
  try {
    const { reportId } = fixture.submit()
    const event = outbox.claim()
    assert.ok(event)
    assert.deepEqual(query.detail('owner', reportId).capabilities.deletion, { kind: 'allowed' })
    const jobId = outbox.deliver({
      eventId: event.id,
      leaseToken: event.leaseToken,
      enqueue: (intent, connection) => tasks.admitFromOutbox(intent, connection),
    })

    for (const status of ['queued', 'running'] as const) {
      if (status === 'running') assert.equal(tasks.claim()?.jobId, jobId)
      const detail = query.detail('owner', reportId)
      assert.equal(detail.dispatch?.status, 'delivered')
      assert.equal(detail.tasks.analysis?.status, status)
      assert.deepEqual(detail.capabilities.deletion, { kind: 'denied', code: 'REPORT_PROCESSING' })
      assert.throws(() => tasks.deleteReport({
        actorId: 'owner', reportId, reason: '  提交文件有误，撤回重传。  ',
      }), { code: 'REPORT_PROCESSING' })
      assert.equal(tasks.getReport(reportId)?.deletedAt, undefined)
      assert.equal(tasks.getReport(reportId)?.deletionReason, undefined)
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submission_task_events WHERE kind='report_deleted'").get()?.count, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM submission_tasks').get()?.count, 1)
  } finally {
    database.close()
  }
})
