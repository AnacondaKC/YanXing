import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { tableExists } from '../lib/db/native-schema'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-job-events-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'job-events.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY='native-route-fixture-encryption-key'
process.env.YANXING_CHAT_COMPLETIONS_API_KEY='test-key-never-used-for-network'

const { getDatabase } = await import('../lib/db/client')
const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { createNativeProject, nativeWorkspace, submitNativeReport } = await import('./helpers/native-project')
const { GET: streamJobEvents } = await import('../app/api/jobs/[jobId]/events/route')
const { createJobEventStream } = await import('../lib/http/submission-task-events')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function createQueuedJob() {
  const owner = createOrUpdateUser({
    username: 'events-owner-' + Math.random().toString(36).slice(2, 8),
    displayName: '事件流负责人',
    password: 'password-events-123',
    role: 'researcher',
  })
  const project = createNativeProject({ database: getDatabase(), ownerId: owner.id, title: '事件流课题' })
  const submitted = submitNativeReport({ database: getDatabase(), actorId: owner.id, projectId: project.id })
  const admitted = nativeWorkspace(getDatabase()).runtime.tasks.admit({ actorId: owner.id, reportId: submitted.reportId, operation: 'analysis' })
  return { owner, jobId: admitted.task.id, reportId: submitted.reportId, token: createSession(owner.id).token }
}

function lastEventId(jobId: string) {
  const row = getDatabase().prepare('SELECT MAX(id) AS id FROM submission_task_events WHERE job_id = ?').get(jobId) as { id?: number } | undefined
  return Number(row?.id ?? 0)
}

function insertEvents(jobId: string, count: number, kind = 'progress') {
  const task = getDatabase().prepare('SELECT report_id, actor_id FROM submission_tasks WHERE id = ?').get(jobId) as { report_id: string; actor_id: string }
  const statement = getDatabase().prepare('INSERT INTO submission_task_events(job_id, report_id, actor_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  const createdAt = new Date().toISOString()
  const ids: number[] = []
  for (let index = 0; index < count; index += 1) {
    const result = statement.run(jobId, task.report_id, task.actor_id, kind, 'event-' + index, createdAt)
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

async function readSse(response: Response, expectedCount: number, timeoutMs = 5_000) {
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<{ id: number; type: string; data: string }> = []
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    void reader.cancel().catch(() => undefined)
  }, timeoutMs)
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
        const dataLine = part.split('\n').find((line) => line.startsWith('data: '))
        if (idLine) events.push({ id: Number(idLine.slice(4)), type: eventLine?.slice(7) ?? '', data: dataLine?.slice(6) ?? '' })
      }
    }
    if (timedOut) throw new Error('Timed out waiting for SSE events: received ' + events.length + ' of ' + expectedCount)
    assert.equal(events.length, expectedCount, 'SSE ended before the expected event count')
  } finally {
    clearTimeout(deadline)
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
  return events
}

test('SSE test reader bounds a stalled stream and releases its reader', { timeout: 2_000 }, async () => {
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')) },
    cancel() { cancellations += 1 },
  })
  await assert.rejects(readSse(new Response(stream), 1, 25), /Timed out waiting for SSE events: received 0 of 1/)
  assert.equal(cancellations, 1)
  assert.equal(stream.locked, false)
})

test('SSE test reader rejects an early EOF and releases its reader', async () => {
  const response = new Response('id: 1\nevent: queued\ndata: {}\n\n')
  await assert.rejects(readSse(response, 2), /SSE ended before the expected event count/)
  assert.equal(response.body?.locked, false)
})

test('native database rejects retired job_events streaming', async () => {
  const database = getDatabase()
  assert.equal(tableExists(database, 'job_events'), false)
  assert.equal(tableExists(database, 'analysis_jobs'), false)
  const response = await streamJobEvents(new Request('http://localhost/api/jobs/missing/events'), { params: Promise.resolve({ jobId: 'missing' }) })
  assert.notEqual(response.status, 200)
  assert.equal(tableExists(database, 'job_events'), false)
})

test('100-event backlog is drained without 700ms pacing', async () => {
  const { jobId, token } = createQueuedJob()
  const after = lastEventId(jobId)
  const ids = insertEvents(jobId, 100)
  const startedAt = Date.now()
  const events = await readSse(await streamJobEvents(eventsRequest(jobId, token, { after }), { params: Promise.resolve({ jobId }) }), 100)
  assert.equal(events.length, 100)
  assert.deepEqual(events.map((event) => event.id), ids)
  assert.ok(Date.now() - startedAt < 2_000)
})

test('500-event backlog is pulled in bounded batches without idle waits', async () => {
  const { jobId, token } = createQueuedJob()
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
  const { jobId, token } = createQueuedJob()
  const ids = insertEvents(jobId, 20)
  const headerEvents = await readSse(await streamJobEvents(eventsRequest(jobId, token, { lastEventId: String(ids[9]) }), { params: Promise.resolve({ jobId }) }), 10)
  assert.deepEqual(headerEvents.map((event) => event.id), ids.slice(10))
  const queryEvents = await readSse(await streamJobEvents(eventsRequest(jobId, token, { lastEventId: 'abc', after: ids[4] }), { params: Promise.resolve({ jobId }) }), 15)
  assert.deepEqual(queryEvents.map((event) => event.id), ids.slice(5))
})

test('queued jobs still deliver the last remaining events', async () => {
  const { jobId, token } = createQueuedJob()
  const ids = insertEvents(jobId, 150)
  const events = await readSse(await streamJobEvents(eventsRequest(jobId, token, { after: ids[119] }), { params: Promise.resolve({ jobId }) }), 30)
  assert.equal(events.length, 30)
  assert.equal(events.at(-1)?.id, ids[149])
})

test('aborting a stream releases the per-user connection slot', async () => {
  const { jobId, token } = createQueuedJob()
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

test('cancel releases exactly one connection slot even when abort and body cancellation both fire',async()=>{
  const {jobId,token}=createQueuedJob()
  const responses:Response[]=[]
  const controller=new AbortController()
  try {
    responses.push(await streamJobEvents(eventsRequest(jobId,token,{signal:controller.signal}),{params:Promise.resolve({jobId})}))
    for(let index=1;index<20;index++)responses.push(await streamJobEvents(eventsRequest(jobId,token),{params:Promise.resolve({jobId})}))
    assert.ok(responses.every(response=>response.status===200))
    assert.equal((await streamJobEvents(eventsRequest(jobId,token),{params:Promise.resolve({jobId})})).status,429)
    controller.abort();await responses[0].body?.cancel()
    const replacement=await streamJobEvents(eventsRequest(jobId,token),{params:Promise.resolve({jobId})})
    assert.equal(replacement.status,200);responses.push(replacement)
    assert.equal((await streamJobEvents(eventsRequest(jobId,token),{params:Promise.resolve({jobId})})).status,429)
  }finally{await Promise.all(responses.map(response=>response.body?.cancel()))}
})

for (const preAborted of [false, true]) {
  test('SSE cancellation does not invoke onError, preAborted=' + preAborted, async () => {
    const { owner, jobId, token } = createQueuedJob()
    const errors: unknown[] = []
    const stream = createJobEventStream({
      workspace: nativeWorkspace(getDatabase()).workspace,
      getCurrentUser: () => owner,
      onError(error) { errors.push(error); return new Response(null, { status: 500 }) },
    })
    const controller = new AbortController()
    if (preAborted) controller.abort()
    const response = await stream(eventsRequest(jobId, token, { after: lastEventId(jobId), signal: controller.signal }), jobId)
    if (preAborted) {
      assert.equal(response.status, 499)
    } else {
      assert.equal(response.status, 200)
      assert.ok(response.body)
      const reader = response.body.getReader()
      const pending = reader.read()
      controller.abort()
      try { assert.equal((await pending).done, true) }
      finally { await reader.cancel() }
    }
    assert.deepEqual(errors, [])
  })
}
