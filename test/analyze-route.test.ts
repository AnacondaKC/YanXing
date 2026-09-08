import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(`${tmpdir()}/yanxing-analyze-route-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'analyze-route.sqlite')

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { createProjectForUser, createReportJob, updateProject } = await import('../lib/db/repository')
const { POST: analyzeReport } = await import('../app/api/reports/[reportId]/analyze/route')

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

function analyzeRequest(token: string | undefined, reportId: string) {
  return analyzeReport(new Request(`http://localhost/api/reports/${reportId}/analyze`, {
    method: 'POST',
    headers: token ? { cookie: `${sessionCookieName}=${encodeURIComponent(token)}` } : {},
  }), { params: Promise.resolve({ reportId }) })
}

test('analyze maps missing reports and unauthorized users without treating unknown errors as conflict', async () => {
  const owner = createOrUpdateUser({ username: 'analyze-owner', displayName: '分析负责人', password: 'password-123', role: 'researcher' })
  const stranger = createOrUpdateUser({ username: 'analyze-stranger', displayName: '无关用户', password: 'password-123', role: 'researcher' })
  const ownerSession = createSession(owner.id)
  const strangerSession = createSession(stranger.id)
  const project = createProjectForUser({
    title: '分析权限课题',
    objective: '验证分析错误映射',
    description: '无权限应返回 403',
    ownerName: owner.displayName,
    milestones: [{ id: 'stage-1', title: '阶段一', targetDate: '2026-12-31', description: '工作内容与预期成果', status: 'not_started' }],
  }, owner.id)
  updateProject(project.id, { milestones: [{ id: 'stage-1', title: '阶段一', targetDate: '2026-12-31', description: '工作内容与预期成果', status: 'in_progress' }] })
  const { report } = createReportJob({
    projectId: project.id,
    fileName: 'analyze.docx',
    source: source('analyze-hash'),
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: false,
  })

  assert.equal((await analyzeRequest(undefined, report.id)).status, 401)
  assert.equal((await analyzeRequest(strangerSession.token, report.id)).status, 403)
  assert.equal((await analyzeRequest(ownerSession.token, 'report-missing')).status, 404)
})
