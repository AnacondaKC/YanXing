import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-health-unavail-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'health-unavailable.sqlite')
process.env.YANXING_KNOWLEDGE_STORAGE_ROOT = path.join(directory, 'knowledge')
delete process.env.YANXING_WORKER_HEARTBEAT_PATH
delete process.env.YANXING_WORKER_READY_PATH
delete process.env.YANXING_INSTANCE_TOKEN

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { GET: getHealth } = await import('../app/api/health/route')
const { proxy } = await import('../proxy')
const { recordWorkerHeartbeat } = await import('../worker/health')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('database failure returns 503 from web health, leaves worker heartbeat unchanged, and still bypasses proxy session lookup', async () => {
  const heartbeatPath = path.join(directory, 'db-fail-heartbeat.json')
  process.env.YANXING_WORKER_HEARTBEAT_PATH = heartbeatPath
  recordWorkerHeartbeat(100)
  const before = readFileSync(heartbeatPath, 'utf8')
  const user = createOrUpdateUser({
    username: 'health-session',
    displayName: 'Health Session',
    password: 'health-session-password-1',
    role: 'researcher',
  })
  const session = createSession(user.id)
  getDatabase().close()

  assert.throws(() => recordWorkerHeartbeat(100))
  assert.equal(readFileSync(heartbeatPath, 'utf8'), before)

  const response = await getHealth()
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { status: 'unhealthy' })
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/)

  const proxied = proxy(new NextRequest('http://localhost/api/health', {
    headers: {
      cookie: sessionCookieName + '=' + session.token,
      host: 'localhost',
    },
  }))
  assert.equal(proxied.status, 200)
})
