import assert from 'node:assert/strict'
import test from 'node:test'
import { seedInitialAiSettings } from '../lib/db/initial-ai-settings'
import { encryptSecret } from '../lib/db/settings-crypto'
import { SubmissionTaskRepository } from '../lib/db/submission-task-repository'
import { SubmissionQueryRepository } from '../lib/db/submission-query-repository'
import { SubmissionWorkspaceRepository } from '../lib/db/submission-workspace-repository'
import { ReportSubmissionOutbox } from '../lib/db/report-submission-outbox'
import { createSubmissionWorkspaceHandlers } from '../lib/http/submission-workspace-handlers'
import { SubmissionWorker } from '../worker/submission-runtime'
import { createTaskFixture } from './helpers/submission-task-fixture'

process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'isolated-admission-test-key'

type HandlerInput = Parameters<typeof createSubmissionWorkspaceHandlers>[0]
function fixture() {
  const fixture = createTaskFixture()
  seedInitialAiSettings(fixture.database)
  fixture.database.prepare('UPDATE ai_model_channels SET api_key_encrypted = ?').run(encryptSecret('test-only-key'))
  const tasks = new SubmissionTaskRepository(fixture)
  const queries = new SubmissionQueryRepository({ ...fixture, tasks })
  const workspace = new SubmissionWorkspaceRepository({ ...fixture, tasks, queries })
  const handlers = createSubmissionWorkspaceHandlers({
    processing: { tasks } as HandlerInput['processing'], workspace,
    getCurrentUser: request => ({ id: request.headers.get('x-test-actor') ?? 'owner' }) as ReturnType<HandlerInput['getCurrentUser']>,
  })
  return { ...fixture, tasks, handlers }
}
const request = () => new Request('http://localhost/api/reports/test', { method: 'POST' })

for (const operation of ['analysis', 'insight'] as const) {
  for (const failure of [
    { sql: 'UPDATE ai_model_assignments SET model_id = NULL', code: 'MODEL_NOT_CONFIGURED', status: 409, message: /尚未选择模型/ },
    { sql: 'UPDATE ai_model_channels SET api_key_encrypted = NULL', code: 'MODEL_CREDENTIALS_MISSING', status: 409, message: /API 密钥/ },
    { sql: "UPDATE projects SET description = ''", code: 'PROJECT_CONTEXT_INCOMPLETE', status: 409, message: /研究背景/ },
    { sql: "UPDATE ai_model_channels SET api_key_encrypted = 'corrupt-secret'", code: 'WORKSPACE_FAILED', status: 500, message: /操作失败/ },
    { sql: "UPDATE ai_model_profiles SET model_name = ''", code: 'WORKSPACE_FAILED', status: 500, message: /操作失败/ },
    { sql: 'DROP TABLE ai_prompt_settings', code: 'WORKSPACE_FAILED', status: 500, message: /操作失败/ },
  ]) {
    test(operation + ' live start/retry maps ' + failure.sql, async context => {
      if (failure.status === 500) context.mock.method(console, 'error', () => {})
      const f = fixture()
      context.after(() => f.database.close())
      const { reportId } = f.submit()
      const prior = f.tasks.admit({ actorId: 'owner', reportId, operation }).task
      f.tasks.cancel({ actorId: 'owner', jobId: prior.id })
      f.database.exec(failure.sql)
      const responses = await Promise.all([
        operation === 'analysis' ? f.handlers.startAnalysis(request(), reportId) : f.handlers.startInsight(request(), reportId),
        f.handlers.retryJob(request(), prior.id),
      ])
      for (const response of responses) {
        assert.equal(response.status, failure.status)
        const body = await response.json()
        assert.equal(body.code, failure.code)
        assert.match(body.error, failure.message)
        assert.doesNotMatch(JSON.stringify(body), /corrupt-secret|test-only-key/)
      }
      assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_tasks').get()?.n, 1)
      assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_task_calls').get()?.n, 0)
    })
  }
}

for (const operation of ['analysis', 'insight'] as const) {
  test(operation + ' live admission preserves authorization and queue errors', async context => {
    const f = fixture()
    context.after(() => f.database.close())
    const { reportId } = f.submit()
    const start = (request: Request) => operation === 'analysis'
      ? f.handlers.startAnalysis(request, reportId) : f.handlers.startInsight(request, reportId)
    const forbidden = await start(new Request('http://localhost/api/reports/test', { method: 'POST', headers: { 'x-test-actor': 'editor' } }))
    assert.equal(forbidden.status, 403)
    assert.equal((await forbidden.json()).code, 'REPORT_WRITE_FORBIDDEN')
    const key = operation === 'analysis' ? 'YANXING_AI_GLOBAL_QUEUE_LIMIT' : 'YANXING_AI_INSIGHT_QUEUE_LIMIT'
    const previous = process.env[key]
    process.env[key] = '1'
    context.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
    const other = f.submit()
    f.tasks.admit({ actorId: 'owner', reportId: other.reportId, operation })
    const full = await start(request())
    assert.equal(full.status, 429)
    assert.equal((await full.json()).code, 'AI_QUEUE_FULL')
    assert.ok(full.headers.get('Retry-After'))
    assert.equal(f.tasks.latestTask(reportId, operation), undefined)
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_task_calls').get()?.n, 0)
  })
}

for (const operation of ['analysis', 'insight'] as const) {
  test(operation + ' start and retry explain the missing explicit encryption key', async context => {
    const f = fixture()
    context.after(() => f.database.close())
    const { reportId } = f.submit()
    const prior = f.tasks.admit({ actorId: 'owner', reportId, operation }).task
    f.tasks.cancel({ actorId: 'owner', jobId: prior.id })
    const key = process.env.YANXING_SETTINGS_ENCRYPTION_KEY
    delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY
    context.after(() => { if (key === undefined) delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY; else process.env.YANXING_SETTINGS_ENCRYPTION_KEY = key })
    const responses = [
      await (operation === 'analysis' ? f.handlers.startAnalysis(request(), reportId) : f.handlers.startInsight(request(), reportId)),
      await f.handlers.retryJob(request(), prior.id),
    ]
    for (const response of responses) {
      assert.equal(response.status, 503)
      const body = await response.json()
      assert.equal(body.code, 'SETTINGS_ENCRYPTION_KEY_MISSING')
      assert.match(body.error, /YANXING_SETTINGS_ENCRYPTION_KEY/)
      assert.doesNotMatch(JSON.stringify(body), /test-only-key|isolated-admission-test-key/)
    }
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_tasks').get()?.n, 1)
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_task_calls').get()?.n, 0)
  })
}

test('missing encryption key remains visible in deferred automatic analysis', context => {
  const f = fixture()
  context.after(() => f.database.close())
  f.submit()
  const key = process.env.YANXING_SETTINGS_ENCRYPTION_KEY
  delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY
  context.after(() => { if (key === undefined) delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY; else process.env.YANXING_SETTINGS_ENCRYPTION_KEY = key })
  const outbox = new ReportSubmissionOutbox({ database: f.database, leaseMs: 60_000 })
  const worker = new SubmissionWorker({ tasks: f.tasks, outbox, recovery: {} as ConstructorParameters<typeof SubmissionWorker>[0]['recovery'] })
  assert.deepEqual(worker.dispatch(), { delivered: 0, deferred: 1, dismissed: 0 })
  assert.equal(f.database.prepare('SELECT last_error FROM report_submission_outbox').get()?.last_error, 'SETTINGS_ENCRYPTION_KEY_MISSING')
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_tasks').get()?.n, 0)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_task_calls').get()?.n, 0)
})

test('configuration errors keep outbox pending with backoff and never create paid attempts', context => {
  const f = fixture()
  context.after(() => f.database.close())
  f.submit()
  const outbox = new ReportSubmissionOutbox({ database: f.database, leaseMs: 60_000 })
  const worker = new SubmissionWorker({ tasks: f.tasks, outbox, recovery: {} as ConstructorParameters<typeof SubmissionWorker>[0]['recovery'] })
  for (const [sql, code] of [
    ['UPDATE ai_model_channels SET api_key_encrypted = NULL', 'MODEL_CREDENTIALS_MISSING'],
    ['UPDATE ai_model_assignments SET model_id = NULL', 'MODEL_NOT_CONFIGURED'],
  ]) {
    f.database.exec(sql)
    for (let attempt = 0; attempt < 6; attempt++) {
      f.database.prepare('UPDATE report_submission_outbox SET available_at = ?').run(new Date(0).toISOString())
      const before = Date.now()
      assert.deepEqual(worker.dispatch(), { delivered: 0, deferred: 1, dismissed: 0 })
      const row = f.database.prepare('SELECT status, available_at, last_error FROM report_submission_outbox').get()!
      assert.equal(row.status, 'pending')
      assert.equal(row.last_error, code)
      assert.ok(Date.parse(String(row.available_at)) >= before + 30_000)
      assert.deepEqual(worker.dispatch(), { delivered: 0, deferred: 0, dismissed: 0 })
    }
  }
  assert.equal(f.database.prepare('SELECT attempts FROM report_submission_outbox').get()?.attempts, 12)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_tasks').get()?.n, 0)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM submission_task_calls').get()?.n, 0)
})
