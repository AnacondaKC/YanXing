import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

const directory = await mkdtemp(tmpdir() + '/yanxing-db-concurrency-')
const fixturePath = path.join(import.meta.dirname, 'fixtures', 'database-process.ts')
const tsxLoader = import.meta.resolve('tsx')
const insightDatabasePath = path.join(directory, 'insight.sqlite')
process.env.YANXING_DATABASE_PATH = insightDatabasePath

const { createOrUpdateUser } = await import('../lib/auth/session')
const { createProjectForUser, createReportJob } = await import('../lib/db/repository')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function runFixture(operation: string, databasePath: string, ...arguments_: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, fixturePath, operation, ...arguments_], {
      cwd: process.cwd(),
      env: { ...process.env, YANXING_DATABASE_PATH: databasePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error('fixture ' + operation + ' exited with ' + code + ': ' + stderr))
    })
  })
}

test('concurrent report insight requests reserve only one model generation slot', async () => {
  const owner = createOrUpdateUser({
    username: 'insight-concurrency-owner',
    displayName: 'Insight Owner',
    password: 'password-owner-123',
    role: 'researcher',
  })
  const project = createProjectForUser({ title: 'Insight concurrency', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  const { updateProject } = await import('../lib/db/repository')
  updateProject(project.id, {
    objective: '识别关键问题并形成决策建议',
    description: '围绕行业现状、风险与实施条件开展研究',
    milestones: [{ id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' }],
  })
  const { report, job } = createReportJob({
    projectId: project.id,
    fileName: 'insight.docx',
    source: {
      path: path.join(directory, 'insight.docx'),
      fileName: 'insight.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'insight-concurrency-hash',
    },
    reportId: undefined,
    milestoneId: 'stage-1',
  })
  const database = new DatabaseSync(insightDatabasePath)
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  database.prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(job.id)
  database.close()

  const results = await Promise.all([
    runFixture('insight-reservation', insightDatabasePath, report.id),
    runFixture('insight-reservation', insightDatabasePath, report.id),
  ])
  assert.deepEqual(results.sort(), ['duplicate', 'reserved'])
})
