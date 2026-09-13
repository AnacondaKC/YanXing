import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ReportSubmissionError } from '@/modules/reports/upload-domain'

export interface SubmissionOutboxEvent {
  id: string
  reportId: string
  projectId: string
  actorId: string
  attempts: number
  leaseToken: string
}

interface OutboxRow {
  id: string; report_id: string; project_id: string; actor_id: string
  attempts: number; lease_token: string | null; status: string; lease_expires_at: string | null
}

export class ReportSubmissionOutbox {
  private readonly database: DatabaseSync
  private readonly now: () => Date
  private readonly leaseMs: number

  constructor(input: { database: DatabaseSync; now?: () => Date; leaseMs: number }) {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) throw new Error('Invalid outbox lease duration.')
    this.database = input.database
    this.now = input.now ?? (() => new Date())
    this.leaseMs = input.leaseMs
  }

  claim(): SubmissionOutboxEvent | undefined {
    return this.transaction(() => {
      const now = this.now()
      const timestamp = now.toISOString()
      const row = this.database.prepare(
        "SELECT * FROM report_submission_outbox WHERE (status='pending' AND julianday(available_at)<=julianday(?)) OR (status='leased' AND julianday(lease_expires_at)<=julianday(?)) ORDER BY created_at,id LIMIT 1"
      ).get(timestamp, timestamp) as OutboxRow | undefined
      if (!row) return undefined
      if (row.attempts >= Number.MAX_SAFE_INTEGER) throw new Error('Outbox attempt counter exhausted.')
      const token = randomUUID()
      this.database.prepare("UPDATE report_submission_outbox SET status='leased', attempts=attempts+1, lease_token=?, lease_expires_at=? WHERE id=?")
        .run(token, new Date(now.getTime() + this.leaseMs).toISOString(), row.id)
      return this.event({ ...row, attempts: row.attempts + 1, lease_token: token })
    })
  }

  deliver(input: { eventId: string; leaseToken: string; enqueue: (event: SubmissionOutboxEvent, database: DatabaseSync) => string }): string {
    if (input.enqueue.constructor.name === 'AsyncFunction') throw new Error('Outbox enqueue must be synchronous database work, not an AI/network call.')
    return this.transaction(() => {
      const event = this.requireLease(input)
      const jobId = input.enqueue(event, this.database)
      if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Outbox enqueue must return a durable job id.')
      this.database.prepare("UPDATE report_submission_outbox SET status='delivered', delivered_at=?, lease_token=NULL, lease_expires_at=NULL, last_error=NULL WHERE id=? AND lease_token=?")
        .run(this.now().toISOString(), input.eventId, input.leaseToken)
      return jobId
    })
  }

  dismissDeletedReport(input: { eventId: string; leaseToken: string }): void {
    this.transaction(() => {
      const event = this.requireLease(input)
      const report = this.database.prepare('SELECT deleted_at FROM report_submissions WHERE id=?').get(event.reportId)
      if (!report?.deleted_at) throw new Error('Only a logically deleted report intent can be dismissed.')
      this.database.prepare("UPDATE report_submission_outbox SET status='delivered',delivered_at=?,lease_token=NULL,lease_expires_at=NULL,last_error='REPORT_DELETED' WHERE id=?")
        .run(this.now().toISOString(), event.id)
    })
  }

  retry(input: { eventId: string; leaseToken: string; errorCode: string; availableAt: string }): void {
    const at = new Date(input.availableAt)
    if (!Number.isFinite(at.getTime()) || at.getTime() < this.now().getTime()) throw new Error('Outbox retry time must not precede current time.')
    if (!/^[A-Z0-9_]{1,100}$/.test(input.errorCode)) throw new Error('Outbox retry requires a safe diagnostic code, not raw provider text.')
    this.transaction(() => {
      this.requireLease(input)
      this.database.prepare("UPDATE report_submission_outbox SET status='pending', available_at=?, lease_token=NULL, lease_expires_at=NULL, last_error=? WHERE id=? AND lease_token=?")
        .run(at.toISOString(), input.errorCode, input.eventId, input.leaseToken)
    })
  }

  private requireLease(input: { eventId: string; leaseToken: string }): SubmissionOutboxEvent {
    const row = this.database.prepare("SELECT * FROM report_submission_outbox WHERE id=? AND status='leased' AND lease_token=? AND julianday(lease_expires_at)>julianday(?)")
      .get(input.eventId, input.leaseToken, this.now().toISOString()) as OutboxRow | undefined
    if (!row) throw new ReportSubmissionError('OUTBOX_LEASE_LOST', '提交任务的调度租约已失效。')
    return this.event(row)
  }

  private event(row: OutboxRow): SubmissionOutboxEvent {
    if (!row.lease_token) throw new Error('Outbox event does not have a lease.')
    return { id: row.id, reportId: row.report_id, projectId: row.project_id, actorId: row.actor_id,
      attempts: row.attempts, leaseToken: row.lease_token }
  }

  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  }
}
