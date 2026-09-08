import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-health-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'health.sqlite')
process.env.YANXING_WORKER_POLL_MS = '100'
delete process.env.YANXING_WORKER_HEARTBEAT_PATH
delete process.env.YANXING_WORKER_READY_PATH
delete process.env.YANXING_INSTANCE_TOKEN

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { GET: getHealth } = await import('../app/api/health/route')
const { proxy } = await import('../proxy')
const { clearWorkerHeartbeat, recordWorkerHeartbeat } = await import('../worker/health')
const { startWorker, stopWorker } = await import('../worker/runtime')
const {
  inspectWebHealthResponse,
  inspectWorkerHeartbeat,
  runDockerHealthcheck,
  workerHeartbeatFutureSkewMs,
  workerHeartbeatMaxPollMs,
  workerHeartbeatMinPollMs,
  workerStaleThresholdMs,
  webHealthTimeoutMs,
  webHealthUrl,
} = await import('../scripts/docker-healthcheck.mjs')

const healthcheckScript = fileURLToPath(new URL('../scripts/docker-healthcheck.mjs', import.meta.url))
const originalHeartbeatPath = process.env.YANXING_WORKER_HEARTBEAT_PATH

test.after(async () => {
  stopWorker()
  await rm(directory, { recursive: true, force: true })
})

test.afterEach(() => {
  if (originalHeartbeatPath === undefined) delete process.env.YANXING_WORKER_HEARTBEAT_PATH
  else process.env.YANXING_WORKER_HEARTBEAT_PATH = originalHeartbeatPath
})

test('proxy allows exact /api/health without a session and does not widen nearby paths', () => {
  const headers = { host: 'localhost' }
  assert.equal(proxy(new NextRequest('http://localhost/api/health', { headers })).status, 200)
  assert.equal(proxy(new NextRequest('http://localhost/api/healthz', { headers })).status, 401)
  assert.equal(proxy(new NextRequest('http://localhost/api/health/extra', { headers })).status, 401)
  assert.equal(proxy(new NextRequest('http://localhost/api/reports', { headers })).status, 401)
})

test('web health GET returns only status, is uncached, and pings the database', async () => {
  const response = await getHealth()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/)
  assert.equal(response.headers.get('Pragma'), 'no-cache')
})

test('web health CLI requires HTTP 200 and an exact status payload', () => {
  assert.equal(inspectWebHealthResponse(200, '{"status":"ok"}'), true)
  assert.equal(inspectWebHealthResponse(200, '{"status":"ok","detail":"x"}'), false)
  assert.equal(inspectWebHealthResponse(200, '{"status":"unhealthy"}'), false)
  assert.equal(inspectWebHealthResponse(503, '{"status":"unhealthy"}'), false)
  assert.equal(inspectWebHealthResponse(200, 'ok'), false)
  assert.equal(webHealthUrl, 'http://127.0.0.1:3000/api/health')
  assert.ok(webHealthTimeoutMs < 10_000)
})

test('worker heartbeat is off by default and does not write a file', () => {
  const probe = path.join(directory, 'heartbeat-default-off.json')
  delete process.env.YANXING_WORKER_HEARTBEAT_PATH
  recordWorkerHeartbeat(100)
  clearWorkerHeartbeat()
  assert.equal(existsSync(probe), false)
})

test('worker heartbeat writes JSON after a database ping and is removed on clear', () => {
  const heartbeatPath = path.join(directory, 'heartbeat.json')
  process.env.YANXING_WORKER_HEARTBEAT_PATH = heartbeatPath
  recordWorkerHeartbeat(100)
  const payload = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { status?: unknown; checkedAt?: unknown; pollMs?: unknown }
  assert.deepEqual(Object.keys(payload).sort(), ['checkedAt', 'pollMs', 'status'])
  assert.equal(payload.status, 'ok')
  assert.equal(payload.pollMs, 100)
  assert.equal(typeof payload.checkedAt, 'number')
  assert.equal(statSync(heartbeatPath).mode & 0o777, 0o600)
  assert.equal(inspectWorkerHeartbeat({
    content: readFileSync(heartbeatPath, 'utf8'),
    nowMs: Date.now(),
  }), true)
  clearWorkerHeartbeat()
  assert.equal(existsSync(heartbeatPath), false)
})

test('worker freshness requires strict JSON, bounds pollMs, and rejects stale or future timestamps', () => {
  const nowMs = 1_000_000
  assert.equal(workerStaleThresholdMs(1_000), 60_000)
  assert.equal(workerStaleThresholdMs(60_000), 180_000)
  assert.equal(workerStaleThresholdMs(workerHeartbeatMaxPollMs), workerHeartbeatMaxPollMs * 3)

  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs - 59_000, pollMs: 1_000 }, nowMs), true)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs - 61_000, pollMs: 1_000 }, nowMs), false)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs - 179_000, pollMs: 60_000 }, nowMs), true)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs - 181_000, pollMs: 60_000 }, nowMs), false)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs + workerHeartbeatFutureSkewMs, pollMs: 1_000 }, nowMs), true)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs + workerHeartbeatFutureSkewMs + 1, pollMs: 1_000 }, nowMs), false)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs, pollMs: workerHeartbeatMinPollMs }, nowMs), true)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs, pollMs: workerHeartbeatMaxPollMs }, nowMs), true)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs, pollMs: workerHeartbeatMinPollMs - 1 }, nowMs), false)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs, pollMs: workerHeartbeatMaxPollMs + 1 }, nowMs), false)
  assert.equal(inspectHeartbeat({ status: 'ok', checkedAt: nowMs, pollMs: 1.5 }, nowMs), false)
  assert.equal(inspectHeartbeat({ status: 'unhealthy', checkedAt: nowMs, pollMs: 1_000 }, nowMs), false)
  assert.equal(inspectWorkerHeartbeat({ content: 'not-json', nowMs }), false)
  assert.equal(inspectWorkerHeartbeat({
    content: JSON.stringify({ status: 'ok', checkedAt: nowMs, pollMs: 1_000, extra: true }),
    nowMs,
  }), false)
})

test('health CLI worker mode accepts a fresh heartbeat and rejects missing, stale, or malformed files', async () => {
  const heartbeatPath = path.join(directory, 'cli-heartbeat.json')
  writeFileSync(heartbeatPath, JSON.stringify({ status: 'ok', checkedAt: Date.now(), pollMs: 1_000 }))
  await runDockerHealthcheck(['worker'], { ...process.env, YANXING_WORKER_HEARTBEAT_PATH: heartbeatPath })

  writeFileSync(heartbeatPath, JSON.stringify({ status: 'ok', checkedAt: Date.now() - 120_000, pollMs: 1_000 }))
  await assert.rejects(
    () => runDockerHealthcheck(['worker'], { ...process.env, YANXING_WORKER_HEARTBEAT_PATH: heartbeatPath }),
    /stale or unhealthy/,
  )
  writeFileSync(heartbeatPath, 'not-json')
  await assert.rejects(
    () => runDockerHealthcheck(['worker'], { ...process.env, YANXING_WORKER_HEARTBEAT_PATH: heartbeatPath }),
    /stale or unhealthy/,
  )
  await assert.rejects(
    () => runDockerHealthcheck(['worker'], { ...process.env, YANXING_WORKER_HEARTBEAT_PATH: path.join(directory, 'missing.json') }),
    /missing/,
  )
  await assert.rejects(() => runDockerHealthcheck([]), /Usage/)
  await assert.rejects(() => runDockerHealthcheck(['web', 'worker']), /Usage/)
})

test('health CLI process contract for web|worker', () => {
  const heartbeatPath = path.join(directory, 'cli-process-heartbeat.json')
  writeFileSync(heartbeatPath, JSON.stringify({ status: 'ok', checkedAt: Date.now(), pollMs: 1_000 }))
  const healthy = spawnCli(['worker'], { YANXING_WORKER_HEARTBEAT_PATH: heartbeatPath })
  assert.equal(healthy.status, 0, healthy.stderr)

  writeFileSync(heartbeatPath, JSON.stringify({ status: 'ok', checkedAt: Date.now() - 120_000, pollMs: 1_000 }))
  const stale = spawnCli(['worker'], { YANXING_WORKER_HEARTBEAT_PATH: heartbeatPath })
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /stale or unhealthy/)

  writeFileSync(heartbeatPath, JSON.stringify({ status: 'ok', checkedAt: Date.now() + 60_000, pollMs: 1_000 }))
  const future = spawnCli(['worker'], { YANXING_WORKER_HEARTBEAT_PATH: heartbeatPath })
  assert.notEqual(future.status, 0)

  writeFileSync(heartbeatPath, 'not-json')
  const malformed = spawnCli(['worker'], { YANXING_WORKER_HEARTBEAT_PATH: heartbeatPath })
  assert.notEqual(malformed.status, 0)

  const usage = spawnCli([])
  assert.notEqual(usage.status, 0)
  assert.match(usage.stderr, /Usage: node scripts\/docker-healthcheck\.mjs web\|worker/)

  const web = spawnCli(['web'])
  assert.notEqual(web.status, 0)
})

test('worker poll loop writes a heartbeat and removes it on stop without touching the ready signal', async () => {
  const heartbeatPath = path.join(directory, 'runtime-heartbeat.json')
  const readyPath = path.join(directory, 'runtime-ready')
  process.env.YANXING_WORKER_HEARTBEAT_PATH = heartbeatPath
  process.env.YANXING_WORKER_READY_PATH = readyPath
  process.env.YANXING_INSTANCE_TOKEN = 'health-ready-token'

  const running = startWorker()
  await waitFor(() => existsSync(heartbeatPath) && existsSync(readyPath))
  const payload = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { status?: unknown; pollMs?: unknown }
  assert.equal(payload.status, 'ok')
  assert.equal(payload.pollMs, 100)
  assert.equal(statSync(heartbeatPath).mode & 0o777, 0o600)
  assert.equal(readFileSync(readyPath, 'utf8'), 'health-ready-token')

  stopWorker()
  await running
  assert.equal(existsSync(heartbeatPath), false)
  assert.equal(readFileSync(readyPath, 'utf8'), 'health-ready-token')
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

function inspectHeartbeat(payload: { status: string; checkedAt: number; pollMs: number }, nowMs: number) {
  return inspectWorkerHeartbeat({ content: JSON.stringify(payload), nowMs })
}

function spawnCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [healthcheckScript, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error('timed out waiting for worker health files')
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
