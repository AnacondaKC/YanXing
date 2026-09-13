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

const { createOrUpdateUser, createSession, deleteSession, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { createNativeProject, nativeWorkspace, submitNativeReport } = await import('./helpers/native-project')
const { POST: cancelJobRoute } = await import('../app/api/jobs/[jobId]/cancel/route')
const { POST: retryJobRoute } = await import('../app/api/jobs/[jobId]/retry/route')

test.after(async () => {
  try { getDatabase().close() } catch { /* already closed */ }
  await rm(directory, { recursive: true, force: true })
})

interface CountRow { n: number }
interface ErrorBody { code: string | undefined }
interface CancelBody { job: { status: string | undefined } | undefined }

function cookie(token: string) {
  return { cookie: sessionCookieName + '=' + encodeURIComponent(token) }
}

function cancelRequest(token: string | undefined, jobId: string) {
  return cancelJobRoute(new Request('http://localhost/api/jobs/' + jobId + '/cancel', {
    method: 'POST',
    headers: token ? cookie(token) : {},
  }), { params: Promise.resolve({ jobId }) })
}

function retryRequest(token: string | undefined, jobId: string) {
  return retryJobRoute(new Request('http://localhost/api/jobs/' + jobId + '/retry', {
    method: 'POST',
    headers: token ? cookie(token) : {},
  }), { params: Promise.resolve({ jobId }) })
}

function taskRow(jobId: string) {
  return getDatabase().prepare('SELECT status, generation, cancel_requested, error_code FROM submission_tasks WHERE id = ?').get(jobId)
}

function taskCount(reportId: string) {
  const row = getDatabase().prepare('SELECT COUNT(*) AS n FROM submission_tasks WHERE report_id = ?').get(reportId) as CountRow | undefined
  return Number(row?.n ?? 0)
}

function notificationCount() {
  const row = getDatabase().prepare('SELECT COUNT(*) AS n FROM notifications').get() as CountRow | undefined
  return Number(row?.n ?? 0)
}

async function jsonCode(response: Response) {
  return await response.json() as ErrorBody
}

test.describe('jobs cancel route', { concurrency: false }, () => {
test('native database rejects retired analysis job cancellation', async () => {
  const database = getDatabase()
  assert.equal(tableExists(database, 'analysis_jobs'), false)
  const response = await cancelJobRoute(new Request('http://localhost/api/jobs/missing/cancel', { method: 'POST' }), {
    params: Promise.resolve({ jobId: 'missing' }),
  })
  assert.equal(response.status, 401)
  assert.equal((await jsonCode(response)).code, 'UNAUTHENTICATED')
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
  assert.equal((await jsonCode(missing)).code, 'TASK_NOT_FOUND')
  const queued = runtime.tasks.admit({ actorId: owner.id, reportId: submitted.reportId, operation: 'analysis' })
  const cancelled = await cancelRequest(session.token, queued.task.id)
  assert.equal(cancelled.status, 200)
  assert.equal(((await cancelled.json()) as CancelBody).job?.status, 'cancelled')
  const again = await cancelRequest(session.token, queued.task.id)
  assert.equal(again.status, 200)
  const next = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const admitted = runtime.tasks.admit({ actorId: owner.id, reportId: next.reportId, operation: 'analysis' })
  const claim = runtime.tasks.claim()
  assert.equal(claim?.jobId, admitted.task.id)
  runtime.tasks.fail(claim!, 'WORKER_EXECUTION_FAILED')
  const completedResponse = await cancelRequest(session.token, admitted.task.id)
  assert.equal(completedResponse.status, 409)
  assert.equal((await jsonCode(completedResponse)).code, 'TASK_ALREADY_TERMINAL')
})

test('outsiders, editors, disabled users, and revoked sessions cannot cancel or retry a live job', async () => {
  const owner = createOrUpdateUser({ username: 'cancel-acl-owner', displayName: '权限负责人', password: 'password-123', role: 'researcher' })
  const outsider = createOrUpdateUser({ username: 'cancel-acl-outsider', displayName: '课题外人', password: 'password-123', role: 'researcher' })
  const editor = createOrUpdateUser({ username: 'cancel-acl-editor', displayName: '只读成员', password: 'password-123', role: 'researcher' })
  const disabled = createOrUpdateUser({ username: 'cancel-acl-disabled', displayName: '停用用户', password: 'password-123', role: 'researcher' })
  const project = createNativeProject({
    database: getDatabase(),
    ownerId: owner.id,
    collaboratorIds: [editor.id, disabled.id],
    title: '权限取消课题',
  })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const { runtime } = nativeWorkspace(getDatabase())
  const queued = runtime.tasks.admit({ actorId: owner.id, reportId: submitted.reportId, operation: 'analysis' })
  const jobId = queued.task.id
  const before = taskRow(jobId)
  const notes = notificationCount()
  const tasks = taskCount(submitted.reportId)

  const outsiderCancel = await cancelRequest(createSession(outsider.id).token, jobId)
  assert.equal(outsiderCancel.status, 403)
  assert.equal((await jsonCode(outsiderCancel)).code, 'REPORT_WRITE_FORBIDDEN')

  const editorCancel = await cancelRequest(createSession(editor.id).token, jobId)
  assert.equal(editorCancel.status, 403)
  assert.equal((await jsonCode(editorCancel)).code, 'REPORT_WRITE_FORBIDDEN')

  const disabledSession = createSession(disabled.id)
  getDatabase().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(disabled.id)
  const disabledCancel = await cancelRequest(disabledSession.token, jobId)
  assert.equal(disabledCancel.status, 401)
  assert.equal((await jsonCode(disabledCancel)).code, 'UNAUTHENTICATED')

  const ownerSession = createSession(owner.id)
  deleteSession(ownerSession.token)
  const revokedCancel = await cancelRequest(ownerSession.token, jobId)
  assert.equal(revokedCancel.status, 401)
  assert.equal((await jsonCode(revokedCancel)).code, 'UNAUTHENTICATED')

  const outsiderRetry = await retryRequest(createSession(outsider.id).token, jobId)
  assert.equal(outsiderRetry.status, 403)
  assert.equal((await jsonCode(outsiderRetry)).code, 'REPORT_WRITE_FORBIDDEN')
  const editorRetry = await retryRequest(createSession(editor.id).token, jobId)
  assert.equal(editorRetry.status, 403)
  assert.equal((await jsonCode(editorRetry)).code, 'REPORT_WRITE_FORBIDDEN')

  assert.deepEqual(taskRow(jobId), before)
  assert.equal(notificationCount(), notes)
  assert.equal(taskCount(submitted.reportId), tasks)
  const cleanup = await cancelRequest(createSession(owner.id).token, jobId)
  assert.equal(cleanup.status, 200)
})
})
