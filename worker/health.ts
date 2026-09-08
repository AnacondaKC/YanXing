import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDatabase } from '@/lib/db/client'

const heartbeatPathEnv = 'YANXING_WORKER_HEARTBEAT_PATH'
const healthyStatus = 'ok'
const heartbeatFileMode = 0o600

export function recordWorkerHeartbeat(pollMs: number) {
  const targetPath = resolveWorkerHeartbeatPath()
  if (!targetPath) return
  pingDatabase()
  writeHeartbeatFile(targetPath, {
    status: healthyStatus,
    checkedAt: Date.now(),
    pollMs,
  })
}

export function clearWorkerHeartbeat() {
  const targetPath = resolveWorkerHeartbeatPath()
  if (!targetPath) return
  removeFileIfPresent(targetPath)
  removeFileIfPresent(temporaryHeartbeatPath(targetPath))
}

function resolveWorkerHeartbeatPath() {
  const value = process.env[heartbeatPathEnv]?.trim()
  return value || undefined
}

function pingDatabase() {
  const row = getDatabase().prepare('SELECT 1 AS ok').get() as { ok?: unknown } | undefined
  if (Number(row?.ok) !== 1) throw new Error('数据库心跳检查失败。')
}

function writeHeartbeatFile(targetPath: string, payload: { status: string; checkedAt: number; pollMs: number }) {
  mkdirSync(path.dirname(targetPath), { recursive: true })
  const temporaryPath = temporaryHeartbeatPath(targetPath)
  writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: heartbeatFileMode })
  chmodSync(temporaryPath, heartbeatFileMode)
  renameSync(temporaryPath, targetPath)
}

function temporaryHeartbeatPath(targetPath: string) {
  return targetPath + '.tmp'
}

function removeFileIfPresent(targetPath: string) {
  try {
    unlinkSync(targetPath)
  } catch (error) {
    if (isNotFound(error)) return
    console.error('[yanxing-worker] heartbeat cleanup failed', error instanceof Error ? error.message : error)
  }
}

function isNotFound(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
