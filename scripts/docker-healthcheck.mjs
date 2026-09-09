import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const webHealthUrl = 'http://127.0.0.1:3000/api/health'
export const webHealthTimeoutMs = 8_000
export const healthyStatus = 'ok'
export const workerHeartbeatMinPollMs = 100
export const workerHeartbeatMaxPollMs = 600_000
export const workerHeartbeatMinStaleMs = 60_000
export const workerHeartbeatPollMultiplier = 3
export const workerHeartbeatFutureSkewMs = 5_000

// Worker freshness window is max(60s, 3 × pollMs).
// pollMs must be a JSON integer in [100, 600000]; invalid JSON fails closed.
// The 60s floor covers a slow poll tick with SQLITE_BUSY / maintenance.
// Future checkedAt beyond 5s skew fails closed.

export function workerStaleThresholdMs(pollMs) {
  return Math.max(workerHeartbeatMinStaleMs, pollMs * workerHeartbeatPollMultiplier)
}

export function inspectWebHealthResponse(httpStatus, bodyText) {
  if (httpStatus !== 200) return false
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return false
  }
  if (!isPlainObject(parsed)) return false
  const keys = Object.keys(parsed)
  return keys.length === 1 && keys[0] === 'status' && parsed.status === healthyStatus
}

export function inspectWorkerHeartbeat({ content, nowMs }) {
  const parsed = parseHeartbeatJson(content)
  if (!parsed) return false
  if (parsed.checkedAt - nowMs > workerHeartbeatFutureSkewMs) return false
  const ageMs = Math.max(0, nowMs - parsed.checkedAt)
  return ageMs <= workerStaleThresholdMs(parsed.pollMs)
}

export async function runDockerHealthcheck(argv, env = process.env) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== 'web' && argv[0] !== 'worker')) {
    throw new Error('Usage: node scripts/docker-healthcheck.mjs [web|worker]')
  }
  if (argv[0] !== 'web') checkWorkerHealth(env)
  if (argv[0] !== 'worker') await checkWebHealth(env)
}

async function checkWebHealth(env) {
  const port = env.PORT?.trim() || '3000'
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Invalid web health port')
  }
  const url = new URL(webHealthUrl)
  url.port = port
  let response
  try {
    response = await fetch(url.href, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(webHealthTimeoutMs),
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('web health request timed out')
    }
    throw new Error(error instanceof Error ? error.message : 'web health request failed')
  }
  const bodyText = await response.text()
  if (!inspectWebHealthResponse(response.status, bodyText)) {
    throw new Error('web health status mismatch')
  }
}

function checkWorkerHealth(env) {
  const targetPath = typeof env.YANXING_WORKER_HEARTBEAT_PATH === 'string' ? env.YANXING_WORKER_HEARTBEAT_PATH.trim() : ''
  if (!targetPath) throw new Error('YANXING_WORKER_HEARTBEAT_PATH is not set')
  let content
  try {
    const stats = statSync(targetPath)
    if (!stats.isFile()) throw new Error('worker heartbeat is not a file')
    content = readFileSync(targetPath, 'utf8')
  } catch (error) {
    if (isNotFound(error)) throw new Error('worker heartbeat missing')
    throw error instanceof Error ? error : new Error('worker heartbeat unreadable')
  }
  if (!inspectWorkerHeartbeat({ content, nowMs: Date.now() })) {
    throw new Error('worker heartbeat stale or unhealthy')
  }
}

function parseHeartbeatJson(content) {
  try {
    const parsed = JSON.parse(content)
    if (!isPlainObject(parsed)) return undefined
    const keys = Object.keys(parsed)
    if (keys.length !== 3 || !keys.includes('status') || !keys.includes('checkedAt') || !keys.includes('pollMs')) {
      return undefined
    }
    if (parsed.status !== healthyStatus) return undefined
    if (typeof parsed.checkedAt !== 'number' || !Number.isFinite(parsed.checkedAt)) return undefined
    if (!isAllowedPollMs(parsed.pollMs)) return undefined
    return { status: parsed.status, checkedAt: parsed.checkedAt, pollMs: parsed.pollMs }
  } catch {
    return undefined
  }
}

function isAllowedPollMs(value) {
  return Number.isSafeInteger(value) && value >= workerHeartbeatMinPollMs && value <= workerHeartbeatMaxPollMs
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNotFound(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(process.argv[1]).href === import.meta.url
}

if (isMainModule()) {
  try {
    await runDockerHealthcheck(process.argv.slice(2))
  } catch (error) {
    console.error('[yanxing-health]', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
