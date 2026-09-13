import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { tableExists } from '../lib/db/native-schema'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-analyze-route-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'analyze-route.sqlite')

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { createNativeProject, submitNativeReport } = await import('./helpers/native-project')
const { POST: analyzeReport } = await import('../app/api/reports/[reportId]/analyze/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function analyzeRequest(token: string | undefined, reportId: string) {
  return analyzeReport(new Request('http://localhost/api/reports/' + reportId + '/analyze', {
    method: 'POST',
    headers: token ? { cookie: sessionCookieName + '=' + encodeURIComponent(token) } : {},
  }), { params: Promise.resolve({ reportId }) })
}

test('native database rejects retired analysis_jobs enqueue tables', async () => {
  const database = getDatabase()
  assert.equal(tableExists(database, 'analysis_jobs'), false)
  assert.equal(tableExists(database, 'report_versions'), false)
  assert.equal(tableExists(database, 'report_submissions'), true)
  const response = await analyzeReport(new Request('http://localhost/api/reports/missing/analyze', { method: 'POST' }), {
    params: Promise.resolve({ reportId: 'missing' }),
  })
  assert.notEqual(response.status, 200)
  assert.equal(tableExists(database, 'analysis_jobs'), false)
})

test('analyze maps missing reports and unauthorized users without treating unknown errors as conflict', async () => {
  const owner = createOrUpdateUser({ username: 'analyze-owner', displayName: '分析负责人', password: 'password-123', role: 'researcher' })
  const stranger = createOrUpdateUser({ username: 'analyze-stranger', displayName: '无关用户', password: 'password-123', role: 'researcher' })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '分析权限课题' })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  assert.equal((await analyzeRequest(undefined, submitted.reportId)).status, 401)
  assert.equal((await analyzeRequest(createSession(stranger.id).token, submitted.reportId)).status, 403)
  assert.equal((await analyzeRequest(createSession(owner.id).token, 'report-missing')).status, 404)
})
