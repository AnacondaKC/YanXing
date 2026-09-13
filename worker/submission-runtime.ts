import { setTimeout as wait } from 'node:timers/promises'
import { runtimeConfig } from '@/lib/config/environment'
import type { SubmissionTaskRepository } from '@/lib/db/submission-task-repository'
import type { ReportSubmissionOutbox } from '@/lib/db/report-submission-outbox'
import type { ReportUploadRecovery } from '@/lib/db/report-upload-recovery'
import { createSubmissionTaskPort } from '@/worker/submission-pipeline-repository'
import { executeSubmissionTask } from '@/worker/submission-executor'
import { SubmissionTaskError, type SubmissionTaskClaim } from '@/modules/reports/submission-task-domain'
import { AiQueueFullError } from '@/lib/ai/queue-policy'

const OUTBOX_RETRY_MS = 30_000
const MAINTENANCE_INTERVAL_MS = 60_000
export interface SubmissionWorkerOptions {
  tasks: SubmissionTaskRepository
  outbox: ReportSubmissionOutbox
  recovery: ReportUploadRecovery
  maintainStorage?: () => Promise<unknown>
  onError?: (code: string) => void
}
export class SubmissionWorker {
  private readonly running = new Set<Promise<void>>()
  private lastMaintenanceAt = 0
  private lastStorageMaintenanceAt = 0
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly input: SubmissionWorkerOptions) {}

  dispatch(limit = 100) {
    const result = { delivered: 0, deferred: 0, dismissed: 0 }
    for (let index = 0; index < limit; index++) {
      const event = this.input.outbox.claim()
      if (!event) break
      try {
        this.input.outbox.deliver({ eventId: event.id, leaseToken: event.leaseToken, enqueue: (item, database) => this.input.tasks.admitFromOutbox(item, database) })
        result.delivered++
      } catch (error) {
        if (this.input.tasks.getReport(event.reportId)?.deletedAt) {
          this.input.outbox.dismissDeletedReport({ eventId: event.id, leaseToken: event.leaseToken })
          result.dismissed++
        } else {
          this.input.outbox.retry({ eventId: event.id, leaseToken: event.leaseToken, errorCode: diagnostic(error), availableAt: new Date(Date.now()+OUTBOX_RETRY_MS).toISOString() })
          result.deferred++
        }
      }
    }
    return result
  }

  async runOnce(signal?: AbortSignal) {
    if (signal?.aborted) return {delivered:0,deferred:0,dismissed:0,claimed:0}
    try {
      await this.maintainIdle(signal)
      const dispatch = this.dispatch()
      const claimed = this.fillAvailableSlots(signal)
      await Promise.all([...this.running])
      return {...dispatch,claimed}
    } finally {
      for(const controller of this.controllers) controller.abort()
      await Promise.allSettled([...this.running])
    }
  }

  async run(signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        try { this.dispatch(runtimeConfig.worker.concurrency*2) }
        catch (error) { this.input.onError?.(diagnostic(error)) }
        await this.maintainIdle(signal)
        if (signal.aborted) break
        try { this.fillAvailableSlots(signal) }
        catch (error) { this.input.onError?.(diagnostic(error)) }
        await waitForProgress(this.running,signal)
      }
    } finally {
      for(const controller of this.controllers) controller.abort()
      await Promise.allSettled([...this.running])
    }
  }

  private async maintainIdle(signal?: AbortSignal) {
    const recoveryDue = Date.now()-this.lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS
    const storageDue = this.input.maintainStorage && Date.now()-this.lastStorageMaintenanceAt >= runtimeConfig.storage.maintenanceIntervalMs
    if (!recoveryDue && !storageDue) return
    // Drain without refilling slots: synchronous reconciliation must never delay task lease heartbeats.
    await Promise.allSettled([...this.running])
    if (signal?.aborted) return
    if (recoveryDue) {
      this.lastMaintenanceAt = Date.now()
      try { await this.input.recovery.runBatch(100) }
      catch (error) { this.input.onError?.(diagnostic(error)) }
    }
    if (storageDue && !signal?.aborted) {
      this.lastStorageMaintenanceAt = Date.now()
      try { await this.input.maintainStorage!() }
      catch (error) { this.input.onError?.(diagnostic(error)) }
    }
  }

  private fillAvailableSlots(signal?: AbortSignal) {
    let count=0
    while (!signal?.aborted && this.running.size < runtimeConfig.worker.concurrency) {
      const claim=this.input.tasks.claim()
      if(!claim) break
      const work=this.runClaim(claim,signal).finally(()=>this.running.delete(work))
      this.running.add(work)
      count++
    }
    return count
  }

  async runClaim(claim: SubmissionTaskClaim, signal?: AbortSignal) {
    const controller=new AbortController()
    this.controllers.add(controller)
    const abort=()=>controller.abort()
    signal?.addEventListener('abort',abort,{once:true})
    if(signal?.aborted) controller.abort()
    const heartbeat=setInterval(()=>{
      try { if(!this.input.tasks.renew(claim)) controller.abort() }
      catch {controller.abort()}
    },Math.max(100,Math.floor(runtimeConfig.worker.leaseMs/4)))
    heartbeat.unref()
    try {
      const {port,publisher}=createSubmissionTaskPort({tasks:this.input.tasks,claim})
      await executeSubmissionTask({taskId:claim.jobId,port,publisher,signal:controller.signal,leaseOwner:claim.leaseToken})
    } catch(error) {
      try {
        if(this.input.tasks.getTask(claim.jobId)?.status==='running') {
          if(this.input.tasks.callLedger(claim.jobId).openIntent) this.input.tasks.fail(claim,'AI_CALL_INCOMPLETE')
          else this.input.tasks.interrupt(claim)
          if(!controller.signal.aborted) this.input.onError?.(diagnostic(error))
        }
      } catch(failure) { this.input.onError?.(diagnostic(failure)) }
    } finally {
      clearInterval(heartbeat)
      this.controllers.delete(controller)
      signal?.removeEventListener('abort',abort)
      // A processor must either publish, fail, or yield its lease; it may not silently leave a running row.
      try { if(this.input.tasks.getTask(claim.jobId)?.status==='running') this.input.tasks.interrupt(claim) }
      catch(error) {this.input.onError?.(diagnostic(error))}
    }
  }
}
function diagnostic(error:unknown) {
  if(error instanceof AiQueueFullError) return 'AI_QUEUE_FULL'
  if(error instanceof SubmissionTaskError) return /^[A-Z0-9_]{1,100}$/.test(error.code)?error.code:'TASK_OPERATION_FAILED'
  if(error instanceof Error && error.name==='IncompleteProviderCallError') return 'AI_CALL_INCOMPLETE'
  return 'TASK_EXECUTION_OR_CONFIGURATION_FAILED'
}
async function waitForProgress(running:Set<Promise<void>>,signal:AbortSignal) {
  const wait=new AbortController()
  const abort=()=>wait.abort()
  signal.addEventListener('abort',abort,{once:true})
  if(signal.aborted)wait.abort()
  try {await Promise.race([...running,delay(runtimeConfig.worker.pollMs,wait.signal)])}
  finally {wait.abort();signal.removeEventListener('abort',abort)}
}
function delay(milliseconds:number,signal:AbortSignal) {
  return wait(milliseconds,undefined,{signal}).catch((error:unknown)=>{
    if(!(error instanceof Error && error.name==='AbortError'))throw error
  })
}
