import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { tableExists } from '../lib/db/native-schema'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-jobs-cancel-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'jobs-cancel.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY='native-route-fixture-encryption-key'
process.env.YANXING_CHAT_COMPLETIONS_API_KEY='test-key-never-used-for-network'

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { createNativeProject, nativeWorkspace, submitNativeReport } = await import('./helpers/native-project')
const { POST: cancelJobRoute } = await import('../app/api/jobs/[jobId]/cancel/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function cancelRequest(token: string, jobId: string) {
  return cancelJobRoute(new Request('http://localhost/api/jobs/' + jobId + '/cancel', {
    method: 'POST',
    headers: { cookie: sessionCookieName + '=' + encodeURIComponent(token) },
  }), { params: Promise.resolve({ jobId }) })
}

test('native database rejects retired analysis job cancellation', async () => {
  const database = getDatabase()
  assert.equal(tableExists(database, 'analysis_jobs'), false)
  const response = await cancelJobRoute(new Request('http://localhost/api/jobs/missing/cancel', { method: 'POST' }), {
    params: Promise.resolve({ jobId: 'missing' }),
  })
  assert.notEqual(response.status, 200)
  assert.equal(tableExists(database, 'analysis_jobs'), false)
})

test('cancel maps missing, cancelled, and other terminal jobs after the transaction', async () => {
  const owner = createOrUpdateUser({ username: 'cancel-owner', displayName: '取消负责人', password: 'password-123', role: 'researcher' })
  const session = createSession(owner.id)
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '取消任务课题' })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const { runtime } = nativeWorkspace(getDatabase())
  const missing = await cancelRequest(session.token, 'job-does-not-exist')
  assert.equal(missing.status, 404)
  const queued = runtime.tasks.admit({ actorId: owner.id, reportId: submitted.reportId, operation: 'analysis' })
  const cancelled = await cancelRequest(session.token, queued.task.id)
  assert.equal(cancelled.status, 200)
  assert.equal(((await cancelled.json()) as { job?: { status?: string } }).job?.status, 'cancelled')
  const again = await cancelRequest(session.token, queued.task.id)
  assert.equal(again.status, 200)
  const next = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const admitted = runtime.tasks.admit({ actorId: owner.id, reportId: next.reportId, operation: 'analysis' })
  const claim = runtime.tasks.claim()
  assert.equal(claim?.jobId, admitted.task.id)
  runtime.tasks.fail(claim!, 'WORKER_EXECUTION_FAILED')
  const completedResponse = await cancelRequest(session.token, admitted.task.id)
  assert.equal(completedResponse.status, 409)
})
