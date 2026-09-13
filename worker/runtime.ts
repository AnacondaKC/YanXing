import { writeFileSync } from 'node:fs'
import { getDatabase } from '@/lib/db/client'
import { createSubmissionProcessingRuntime } from '@/lib/reports/submission-processing-runtime'
import { getReportStorageRoot, getTemporaryStorageRoot } from '@/lib/storage/runtime-roots'
import { getKnowledgeStorageRoot } from '@/lib/knowledge-storage'
import { runStorageMaintenance } from '@/lib/storage/maintenance'
import { runtimeConfig } from '@/lib/config/environment'
import { clearWorkerHeartbeat, recordWorkerHeartbeat } from '@/worker/health'

let stopController = new AbortController()
let stopRequested = false
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

function writeInstanceReadySignal() {
  const readyPath = process.env.YANXING_WORKER_READY_PATH
  const token = process.env.YANXING_INSTANCE_TOKEN
  if (!readyPath || !token) return
  writeFileSync(readyPath, token)
}

function resolveActorId() {
  return undefined
}

/** Native host: shared getDatabase, submission processing runtime, heartbeat, and ready signal. */
export async function startWorker() {
  stopRequested = false
  stopController = new AbortController()
  const database = getDatabase()
  const runtime = createSubmissionProcessingRuntime({
    database,
    storageRoot: getReportStorageRoot(),
    resolveActorId,
    maintainStorage: async () => {
      const result = await runStorageMaintenance({database, roots: {
        reportRoot: getReportStorageRoot(),
        knowledgeRoot: getKnowledgeStorageRoot(),
        temporaryRoot: getTemporaryStorageRoot(),
      }})
      if (result.errors.length) console.error('[yanxing-worker] storage maintenance', result.errors)
    },
    onWorkerError(code) {
      console.error('[yanxing-worker]', code)
    },
  })
  if (stopRequested) return
  writeInstanceReadySignal()
  const pollMs = runtimeConfig.worker.pollMs
  recordWorkerHeartbeat(pollMs)
  heartbeatTimer = setInterval(() => {
    try {
      recordWorkerHeartbeat(pollMs)
    } catch (error) {
      console.error('[yanxing-worker] heartbeat failed', error instanceof Error ? error.message : error)
    }
  }, pollMs)
  heartbeatTimer.unref()
  try {
    await runtime.worker.run(stopController.signal)
  } finally {
    clearHeartbeatTimer()
    clearWorkerHeartbeat()
  }
}

export function stopWorker() {
  if (stopRequested) return
  stopRequested = true
  stopController.abort()
  clearHeartbeatTimer()
  clearWorkerHeartbeat()
}

function clearHeartbeatTimer() {
  if (!heartbeatTimer) return
  clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
}
