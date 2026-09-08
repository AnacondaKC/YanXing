import { hostname } from 'node:os'
import { writeFileSync } from 'node:fs'
import { reconcileAiBudgetsIfDue } from '@/lib/ai/budget'
import { randomUUID } from 'node:crypto'
import { migrateDatabase } from '@/lib/db/client'
import { runStorageMaintenanceIfDue } from '@/lib/storage/maintenance'
import {
  claimNextJob,
  isJobCancellationRequested,
  pruneJobEventsIfDue,
  releaseJobLease,
  renewJobLease,
} from '@/lib/db/repository'
import { processJob } from '@/worker/job-processor'
import { clearWorkerHeartbeat, recordWorkerHeartbeat } from '@/worker/health'
import { runtimeConfig } from '@/lib/config/environment'

const pollIntervalMs = runtimeConfig.worker.pollMs
const leaseMs = runtimeConfig.worker.leaseMs
const heartbeatMs = Math.max(1_000, Math.floor(leaseMs / 4))
const concurrency = runtimeConfig.worker.concurrency
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`

let stopRequested = false
let stopController = new AbortController()
const running = new Set<Promise<void>>()
const activeControllers = new Set<AbortController>()

function writeInstanceReadySignal() {
  const readyPath = process.env.YANXING_WORKER_READY_PATH
  const token = process.env.YANXING_INSTANCE_TOKEN
  if (!readyPath || !token) return
  writeFileSync(readyPath, token)
}

export async function startWorker() {
  migrateDatabase()
  if (stopRequested) return
  writeInstanceReadySignal()
  stopController = new AbortController()
  console.info(`[yanxing-worker] started id=${workerId} concurrency=${concurrency}`)

  while (!stopRequested) {
    // 维护和任务领取失败应留在轮询内退避，不能让临时 SQLITE_BUSY 终止整个 Worker。
    try {
      const budgetMaintenance = reconcileAiBudgetsIfDue()
      if (budgetMaintenance && (budgetMaintenance.released || budgetMaintenance.settled || budgetMaintenance.extended || budgetMaintenance.uncertain || budgetMaintenance.unresolved)) {
        console.info('[yanxing-worker] AI budget reconciliation completed', budgetMaintenance)
      }
    } catch (error) {
      console.error('[yanxing-worker] AI budget reconciliation failed', error instanceof Error ? error.message : error)
    }
    try {
      const storageMaintenance = await runStorageMaintenanceIfDue()
      if (storageMaintenance) {
        console.info('[yanxing-worker] storage maintenance completed', {
          expiredReservations: storageMaintenance.expiredReservations,
          allocationsCreated: storageMaintenance.allocationsCreated,
          allocationsUpdated: storageMaintenance.allocationsUpdated,
          allocationsRemoved: storageMaintenance.allocationsRemoved,
          orphanFilesDeleted: storageMaintenance.orphanFilesDeleted,
        })
      }
    } catch (error) {
      console.error('[yanxing-worker] storage maintenance failed', error instanceof Error ? error.message : error)
    }
    if (stopRequested) break
    try {
      pruneJobEventsIfDue()
    } catch (error) {
      console.error('[yanxing-worker] event pruning failed', error instanceof Error ? error.message : error)
    }
    if (stopRequested) break
    let claimedAny = false
    while (!stopRequested && running.size < concurrency) {
      const leaseOwner = workerId + ':claim:' + randomUUID()
      let job
      try {
        job = claimNextJob(leaseOwner, leaseMs)
      } catch (error) {
        console.error('[yanxing-worker] job claim failed', error instanceof Error ? error.message : error)
        break
      }
      if (!job) break
      claimedAny = true
      const execution = runClaimedJob(job.id, leaseOwner).finally(() => running.delete(execution))
      running.add(execution)
    }

    if (!stopRequested) {
      try {
        recordWorkerHeartbeat(pollIntervalMs)
      } catch (error) {
        console.error('[yanxing-worker] heartbeat failed', error instanceof Error ? error.message : error)
      }
    }

    if (!claimedAny) {
      if (running.size) await Promise.race([...running, delay(pollIntervalMs, stopController.signal)])
      else await delay(pollIntervalMs, stopController.signal)
    }
  }

  // 优雅停机：中止所有运行中的任务（在安全点停止并释放租约），再等待退出。
  for (const controller of activeControllers) controller.abort()
  await Promise.allSettled(running)
  clearWorkerHeartbeat()
  console.info('[yanxing-worker] stopped')
}

export function stopWorker() {
  if (stopRequested) return
  stopRequested = true
  stopController.abort()
  for (const controller of activeControllers) controller.abort()
  clearWorkerHeartbeat()
}

async function runClaimedJob(jobId: string, leaseOwner: string) {
  const controller = new AbortController()
  activeControllers.add(controller)
  let renewedAt = Date.now()
  const heartbeat = setInterval(() => {
    try {
      if (stopRequested || controller.signal.aborted) return
      if (isJobCancellationRequested(jobId, leaseOwner)) {
        controller.abort()
        return
      }
      if (stopRequested || controller.signal.aborted) return
      if (Date.now() - renewedAt >= heartbeatMs) {
        if (stopRequested || controller.signal.aborted) return
        if (!renewJobLease(jobId, leaseOwner, leaseMs)) controller.abort()
        else renewedAt = Date.now()
      }
    } catch {
      controller.abort()
    }
  }, 1_000)
  heartbeat.unref()

  let failure: { code?: string; message?: string } | undefined
  try {
    await processJob(jobId, { signal: controller.signal, leaseOwner })
  } catch (error) {
    if (!controller.signal.aborted) {
      failure = { code: 'worker_execution_failed', message: error instanceof Error ? error.message : '分析任务执行失败。' }
      console.error(`[yanxing-worker] job failed id=${jobId}`, failure.message)
    }
  } finally {
    clearInterval(heartbeat)
    activeControllers.delete(controller)
    try {
      releaseJobLease(jobId, leaseOwner, failure)
    } catch (error) {
      console.error(`[yanxing-worker] lease release failed id=${jobId}`, error instanceof Error ? error.message : error)
    }
  }
}

function delay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>
    const abortListener = () => finish()
    const finish = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortListener)
      resolve()
    }
    timeout = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', abortListener, { once: true })
    if (signal?.aborted) finish()
  })
}
