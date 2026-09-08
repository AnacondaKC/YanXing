import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(tmpdir() + '/yanxing-job-events-')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'job-events.sqlite')

const { migrateDatabase, getDatabase } = await import('../lib/db/client')
const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { createProjectForUser, createReportJob, getJobEvents, updateProject } = await import('../lib/db/repository')
const { GET: streamJobEvents } = await import('../app/api/jobs/[jobId]/events/route')

migrateDatabase()

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function createCompletedJob() {
  const owner = createOrUpdateUser({
    username: 'events-owner-' + Math.random().toString(36).slice(2, 8),
    displayName: '事件流负责人',
    password: 'password-events-123',
    role: 'researcher',
  })
  const project = createProjectForUser({ title: '事件流课题', objective: '', description: '', ownerName: owner.displayName }, owner.id)
  updateProject(project.id, {
    objective: '识别关键问题并形成决策建议',
    description: '围绕行业现状、风险与实施条件开展研究',
    milestones: [{ id: 'stage-1', title: '事实调研', targetDate: '2026-06-30', description: '形成研究依据并交付事实清单', status: 'in_progress' }],
  })
  const created = createReportJob({
    projectId: project.id,
    fileName: 'events.docx',
    source: {
      path: path.join(directory, 'source-' + Math.random().toString(36).slice(2) + '.docx'),
      fileName: 'events.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 100,
      sha256: 'events-hash-' + Math.random().toString(36).slice(2),
    },
    reportId: undefined,
    milestoneId: 'stage-1',
    autoAnalyze: true,
    deliveryType: undefined,
    actor: owner,
  })
  assert.ok(created.job)
  getDatabase().prepare("UPDATE analysis_jobs SET status = 'completed' WHERE id = ?").run(created.job.id)
  return { owner, jobId: created.job.id, token: createSession(owner.id).token }
}

function lastEventId(jobId: string) {
  return getJobEvents(jobId, 0, 500).at(-1)?.id ?? 0
}

function insertEvents(jobId: string, count: number) {
  const statement = getDatabase().prepare('INSERT INTO job_events(job_id, type, errors_json, message, created_at) VALUES (?, ?, ?, ?, ?)')
  const createdAt = new Date().toISOString()
  const ids: number[] = []
  for (let index = 0; index < count; index += 1) {
    const result = statement.run(jobId, 'info', '[]', 'event-' + index, createdAt)
    ids.push(Number(result.lastInsertRowid))
  }
  return ids
}

function eventsRequest(jobId: string, token: string, init?: { lastEventId?: string; after?: number; signal?: AbortSignal }) {
  const url = init?.after === undefined
    ? 'http://localhost/api/jobs/' + jobId + '/events'
    : 'http://localhost/api/jobs/' + jobId + '/events?after=' + init.after
  return new Request(url, {
    headers: {
      cookie: sessionCookieName + '=' + encodeURIComponent(token),
      ...(init?.lastEventId === undefined ? {} : { 'last-event-id': init.lastEventId }),
    },
    signal: init?.signal,
  })
}

async function readSse(response: Response, expectedCount: number) {
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<{ id: number; type: string }> = []
  try {
    while (events.length < expectedCount) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (!part || part.startsWith(':')) continue
        const idLine = part.split('\n').find((line) => line.startsWith('id: '))
        const eventLine = part.split('\n').find((line) => line.startsWith('event: '))
        if (idLine) events.push({ id: Number(idLine.slice(4)), type: eventLine?.slice(7) ?? '' })
      }
    }
  } finally {
    await reader.cancel()
  }
  return events
}

test('100-event backlog is drained without 700ms pacing', async () => {
  const { jobId, token } = createCompletedJob()
  const after = lastEventId(jobId)
  const ids = insertEvents(jobId, 100)
  const startedAt = Date.now()
  const events = await readSse(await streamJobEvents(eventsRequest(jobId, token, { after }), { params: Promise.resolve({ jobId }) }), 100)
  assert.equal(events.length, 100)
  assert.deepEqual(events.map((event) => event.id), ids)
  assert.ok(Date.now() - startedAt < 2_000)
})

test('500-event backlog is pulled in bounded batches without idle waits', async () => {
  const { jobId, token } = createCompletedJob()
  const after = lastEventId(jobId)
  const ids = insertEvents(jobId, 500)
  const startedAt = Date.now()
  const events = await readSse(await streamJobEvents(eventsRequest(jobId, token, { after }), { params: Promise.resolve({ jobId }) }), 500)
  assert.equal(events.length, 500)
  assert.equal(events[0]?.id, ids[0])
  assert.equal(events[499]?.id, ids[499])
  assert.ok(Date.now() - startedAt < 3_000)
})

test('Last-Event-ID wins and invalid headers fall back to the after cursor', async () => {
  const { jobId, token } = createCompletedJob()
  const ids = insertEvents(jobId, 20)
  const headerEvents = await readSse(await streamJobEvents(eventsRequest(jobId, token, { lastEventId: String(ids[9]) }), { params: Promise.resolve({ jobId }) }), 10)
  assert.deepEqual(headerEvents.map((event) => event.id), ids.slice(10))
  const queryEvents = await readSse(await streamJobEvents(eventsRequest(jobId, token, { lastEventId: 'abc', after: ids[4] }), { params: Promise.resolve({ jobId }) }), 15)
  assert.deepEqual(queryEvents.map((event) => event.id), ids.slice(5))
})

test('terminal jobs still deliver the last remaining events', async () => {
  const { jobId, token } = createCompletedJob()
  const ids = insertEvents(jobId, 150)
  const events = await readSse(await streamJobEvents(eventsRequest(jobId, token, { after: ids[119] }), { params: Promise.resolve({ jobId }) }), 30)
  assert.equal(events.length, 30)
  assert.equal(events.at(-1)?.id, ids[149])
})

test('aborting a stream releases the per-user connection slot', async () => {
  const { jobId, token } = createCompletedJob()
  insertEvents(jobId, 1)
  const controller = new AbortController()
  const held = await streamJobEvents(eventsRequest(jobId, token, { signal: controller.signal }), { params: Promise.resolve({ jobId }) })
  assert.equal(held.status, 200)
  controller.abort()
  await held.body?.cancel()
  const next = await streamJobEvents(eventsRequest(jobId, token), { params: Promise.resolve({ jobId }) })
  assert.equal(next.status, 200)
  await next.body?.cancel()
})
