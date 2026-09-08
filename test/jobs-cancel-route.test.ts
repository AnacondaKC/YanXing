import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(`${tmpdir()}/yanxing-jobs-cancel-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'jobs-cancel.sqlite')

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { claimNextJob, createProjectForUser, createReportJob, updateProject } = await import('../lib/db/repository')
const { getDatabase } = await import('../lib/db/client')
const { POST: cancelJobRoute } = await import('../app/api/jobs/[jobId]/cancel/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function source(hash: string) {
  const fileName = hash + '.docx'
  return {
    fileName,
    path: path.join(directory, fileName),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 12,
    sha256: hash,
  }
}

function cancelRequest(token: string, jobId: string) {
  return cancelJobRoute(new Request(`http://localhost/api/jobs/${jobId}/cancel`, {
    method: 'POST',
    headers: { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` },
  }), { params: Promise.resolve({ jobId }) })
}

test('cancel maps missing, cancelled, and other terminal jobs after the transaction', async () => {
  const owner = createOrUpdateUser({ username: 'cancel-owner', displayName: '取消负责人', password: 'password-123', role: 'researcher' })
  const session = createSession(owner.id)
  const project = createProjectForUser({
    title: '取消任务课题',
    objective: '验证取消映射',
    description: '终态任务与幂等取消',
    ownerName: owner.displayName,
    milestones: [{ id: 'stage-1', title: '阶段一', targetDate: '2026-12-31', description: '工作内容与预期成果', status: 'not_started' }],
  }, owner.id)
  updateProject(project.id, { milestones: [{ id: 'stage-1', title: '阶段一', targetDate: '2026-12-31', description: '工作内容与预期成果', status: 'in_progress' }] })

  const missing = await cancelRequest(session.token, 'job-does-not-exist')
  assert.equal(missing.status, 404)

  const queued = createReportJob({
    projectId: project.id,
    fileName: 'queued.docx',
    source: source('queued-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  const cancelled = await cancelRequest(session.token, queued.job!.id)
  assert.equal(cancelled.status, 200)
  assert.equal(((await cancelled.json()) as { job?: { status?: string } }).job?.status, 'cancelled')
  const again = await cancelRequest(session.token, queued.job!.id)
  assert.equal(again.status, 200)

  const completed = createReportJob({
    projectId: project.id,
    fileName: 'completed.docx',
    source: source('completed-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
  })
  assert.equal(claimNextJob('cancel-worker', 60_000)?.id, completed.job!.id)
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(completed.job!.id)
  const completedResponse = await cancelRequest(session.token, completed.job!.id)
  assert.equal(completedResponse.status, 409)
})
