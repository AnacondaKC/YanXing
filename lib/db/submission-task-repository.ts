import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { isAbsolute, relative, resolve } from 'node:path'
import { runtimeConfig } from '@/lib/config/environment'
import { pageAnalysisModule } from '@/modules/analysis/modules'
import { freezeSubmissionTask, assertSubmissionTaskAdmission } from '@/lib/ai/submission-admission'
import { canWriteProjectReports, resolveReportDeletionAccess, resolveReportOperationAccess } from '@/modules/reports/submission-policy'
import { MAX_REPORT_OPERATION_SUCCESSES, type ReportOperation, type ReportSubmission, type ReportOperationHistory, type ReportWriteContext } from '@/modules/reports/submission-domain'
import { SubmissionTaskError, type SubmissionTask, type SubmissionTaskClaim, type SubmissionTaskSnapshot, type SubmissionTaskResult } from '@/modules/reports/submission-task-domain'
import type { AnalysisStage } from '@/modules/contracts/analysis'
import type { ReportSource } from '@/modules/reports/domain'
import type { SubmissionOutboxEvent } from '@/lib/db/report-submission-outbox'
import type { SubmissionTaskStore, TaskCallReceipt, TaskDataWrite } from '@/modules/reports/submission-task-ports'

type Row = Record<string, SQLOutputValue>
interface RepositoryOptions {
  database: DatabaseSync
  storageRoot: string
  now?: () => Date
  freeze?: typeof freezeSubmissionTask
  assertAdmission?: typeof assertSubmissionTaskAdmission
}

export class SubmissionTaskRepository implements SubmissionTaskStore {
  constructor(private readonly options: RepositoryOptions) {
    const bound=options.database.prepare('SELECT path FROM submission_storage_root WHERE id=1').get()?.path
    if(bound && bound!==resolve(options.storageRoot)) throw taskError('STORAGE_ROOT_MISMATCH')
  }
  private get db() { return this.options.database }
  private now() { return (this.options.now?.() ?? new Date()).toISOString() }

  admit(input: { actorId: string; reportId: string; operation: ReportOperation }) {
    return this.transaction(() => this.admitInTransaction(input))
  }

  admitFromOutbox(event: SubmissionOutboxEvent, database: DatabaseSync): string {
    if (database !== this.db || !database.isTransaction) throw new Error('Outbox and task admission must share a transaction.')
    const existing = this.db.prepare('SELECT job_id FROM submission_task_dispatches WHERE event_id=?').get(event.id)
    if (existing) return String(existing.job_id)
    const report = this.getReport(event.reportId)
    if (!report || report.projectId !== event.projectId) throw taskError('REPORT_NOT_FOUND')
    // A manually started first analysis already fulfills this durable intent, including terminal attempts.
    const prior = this.latestTask(event.reportId, 'analysis')
    const task = prior ?? this.admitInTransaction({ actorId: event.actorId, reportId: event.reportId, operation: 'analysis' }).task
    this.db.prepare('INSERT INTO submission_task_dispatches(event_id,job_id) VALUES (?,?)').run(event.id, task.id)
    return task.id
  }

  private admitInTransaction(input: { actorId: string; reportId: string; operation: ReportOperation }) {
    if (input.operation !== 'analysis' && input.operation !== 'insight') throw taskError('INVALID_OPERATION', 400)
    const report = this.getReport(input.reportId)
    if (!report) throw taskError('REPORT_NOT_FOUND', 404)
    const access = this.access(input.actorId, report.projectId)
    const latestRow = this.db.prepare('SELECT id FROM report_submissions WHERE project_id=? AND deleted_at IS NULL ORDER BY submission_sequence DESC LIMIT 1').get(report.projectId)
    const decision = resolveReportOperationAccess({ access, report, latestSubmission: latestRow ? this.getReport(String(latestRow.id)) : undefined, history: this.history(report, input.operation) })
    if (decision.kind === 'denied') throw taskError(decision.code, decision.code === 'REPORT_WRITE_FORBIDDEN' ? 403 : 409)
    if (decision.kind === 'reuse') return { task: this.getTask(decision.jobId)!, reused: true }
    const frozen = (this.options.freeze ?? freezeSubmissionTask)({ database: this.db, reportId: report.id, operation: input.operation })
    const at = this.now()
    ;(this.options.assertAdmission ?? assertSubmissionTaskAdmission)({ database: this.db, actorId: input.actorId, projectId: report.projectId, reportId: report.id, operation: input.operation })
    const generation = (this.latestTask(report.id, input.operation)?.generation ?? 0) + 1
    if (!Number.isSafeInteger(generation)) throw taskError('TASK_GENERATION_EXHAUSTED')
    const id = randomUUID()
    this.db.prepare("INSERT INTO submission_tasks(id,report_id,project_id,actor_id,operation,generation,status,stage,frozen_json,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued','validating',?,?,?,?)")
      .run(id, report.id, report.projectId, input.actorId, input.operation, generation, JSON.stringify(frozen), at, at, at)
    this.event({jobId: id, kind: 'queued', message: '任务已通过资格与队列准入。'})
    return { task: this.getTask(id)!, reused: false }
  }

  claim(leaseMs = runtimeConfig.worker.leaseMs): SubmissionTaskClaim | undefined {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100) throw new Error('Invalid task lease duration.')
    return this.transaction(() => {
      this.recoverExpiredInTransaction()
      const at=this.now()
      const row = this.db.prepare("SELECT t.id FROM submission_tasks t JOIN report_submissions r ON r.id=t.report_id WHERE t.status='queued' AND t.cancel_requested=0 AND r.deleted_at IS NULL AND julianday(t.available_at)<=julianday(?) ORDER BY t.created_at,t.id LIMIT 1").get(at)
      if (!row) return undefined
      const claim = { jobId: String(row.id), leaseToken: randomUUID() }
      this.db.prepare("UPDATE submission_tasks SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?")
        .run(claim.leaseToken, new Date(Date.parse(at) + leaseMs).toISOString(), at, claim.jobId)
      this.event({jobId: claim.jobId, kind: 'claimed', message: 'Worker已领取任务。'})
      return claim
    })
  }

  renew(claim: SubmissionTaskClaim, leaseMs = runtimeConfig.worker.leaseMs): boolean {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100) throw new Error('Invalid task lease duration.')
    return this.transaction(() => {
      const at=this.now(), until=new Date(Date.parse(at)+leaseMs).toISOString()
      const changed=this.db.prepare("UPDATE submission_tasks SET lease_until=MAX(lease_until,?),updated_at=? WHERE id=? AND status='running' AND lease_token=? AND cancel_requested=0 AND julianday(lease_until)>julianday(?) AND EXISTS(SELECT 1 FROM report_submissions r WHERE r.id=submission_tasks.report_id AND r.deleted_at IS NULL)")
        .run(until,at,claim.jobId,claim.leaseToken,at)
      return Number(changed.changes)===1
    })
  }

  cancelled(claim: SubmissionTaskClaim): boolean {
    return !this.db.prepare("SELECT 1 FROM submission_tasks t JOIN report_submissions r ON r.id=t.report_id WHERE t.id=? AND t.status='running' AND t.lease_token=? AND julianday(t.lease_until)>julianday(?) AND t.cancel_requested=0 AND r.deleted_at IS NULL").get(claim.jobId, claim.leaseToken, this.now())
  }

  beginCall(claim: SubmissionTaskClaim, input: { attempt: number; provider: string; model: string }): void {
    this.transaction(() => {
      const task = this.requireLive(claim)
      const model = this.getFrozen(task.id).modelRuntime
      if (input.provider !== model.channel || input.model !== model.modelName) throw taskError('CALL_MODEL_MISMATCH')
      if (input.attempt > (task.operation === 'analysis' ? pageAnalysisModule.maxAttempts : 1)) throw taskError('CALL_ATTEMPTS_EXHAUSTED')
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 100 || !input.provider || !input.model) throw taskError('INVALID_CALL_INTENT')
      if (this.callLedger(claim.jobId).openIntent) throw taskError('AI_CALL_INCOMPLETE')
      if (this.db.prepare('SELECT 1 FROM submission_task_calls WHERE job_id=? AND attempt=?').get(claim.jobId, input.attempt)) throw taskError('AI_CALL_ALREADY_RECORDED')
      this.db.prepare("INSERT INTO submission_task_calls(job_id,attempt,provider,model,lease_token,state,started_at) VALUES (?,?,?,?,?,'started',?)")
        .run(claim.jobId, input.attempt, input.provider, input.model, claim.leaseToken, this.now())
    })
  }

  checkpoint(claim: SubmissionTaskClaim, receipt: TaskCallReceipt): void {
    this.transaction(() => {
      this.requireLive(claim)
      this.recordReceipt(claim, receipt)
      for (const data of receipt.data ?? []) this.putData(claim.jobId, data)
    })
  }

  settleLateCall(claim: SubmissionTaskClaim, receipt: TaskCallReceipt): void {
    this.transaction(() => {
      // The original lease proves call ownership; late completion cannot publish results.
      this.recordReceipt(claim, receipt)
      this.event({jobId: claim.jobId, kind: 'call_completed', message: '已记录迟到调用完成，不发布结果。'})
    })
  }

  private recordReceipt(claim: SubmissionTaskClaim, receipt: TaskCallReceipt) {
    const call = this.db.prepare('SELECT * FROM submission_task_calls WHERE job_id=? AND attempt=?').get(claim.jobId, receipt.attempt)
    if (!call || call.lease_token !== claim.leaseToken || call.provider !== receipt.provider || call.model !== receipt.model) throw taskError('CALL_RECEIPT_MISMATCH')
    if (call.state === 'completed') return
    this.db.prepare("UPDATE submission_task_calls SET state='completed',completed_at=? WHERE job_id=? AND attempt=?").run(this.now(), claim.jobId, receipt.attempt)
  }

  callLedger(jobId: string) {
    const calls = this.db.prepare('SELECT * FROM submission_task_calls WHERE job_id=? ORDER BY attempt').all(jobId)
    const open = calls.find(call => call.state === 'started')
    const operation = this.getTaskRow(jobId).operation
    const module = operation === 'analysis' ? 'page_analysis' : 'report_insight'
    return { started: calls.length, completed: calls.filter(call => call.state === 'completed').length,
      openIntent: open ? { attempt: Number(open.attempt), provider: String(open.provider), model: String(open.model), stage: module, module } : undefined }
  }

  complete(claim: SubmissionTaskClaim, payload: unknown): SubmissionTaskResult {
    return this.transaction(() => {
      const task = this.requireLive(claim)
      const ledger = this.callLedger(task.id)
      if (ledger.openIntent || ledger.completed < 1) throw taskError('AI_CALL_INCOMPLETE')
      const id = randomUUID(), at = this.now()
      this.db.prepare('INSERT INTO submission_task_results(id,job_id,report_id,operation,generation,payload_json,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, task.id, task.reportId, task.operation, task.generation, JSON.stringify(payload), at)
      const column = task.operation === 'analysis' ? 'first_analysis_succeeded_at' : 'first_insight_succeeded_at'
      this.db.prepare('UPDATE report_submissions SET '+column+'=COALESCE('+column+',?) WHERE id=?').run(at, task.reportId)
      this.db.prepare("UPDATE submission_tasks SET status='completed',stage='completed',lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?").run(at, task.id)
      this.event({jobId: task.id, kind: 'succeeded', message: '通过质量校验的结果已发布。'})
      return { id, jobId: task.id, reportId: task.reportId, operation: task.operation, generation: task.generation, payload, createdAt: at }
    })
  }

  fail(claim: SubmissionTaskClaim, code = 'WORKER_EXECUTION_FAILED'): void {
    this.transaction(() => {
      const task = this.requireLease(claim)
      this.terminate(task.id, task.cancelRequested ? 'cancelled' : 'failed', safeCode(code))
    })
  }

  interrupt(claim: SubmissionTaskClaim): void {
    this.transaction(() => {
      const task = this.requireLease(claim)
      if (task.cancelRequested) this.terminate(task.id, 'cancelled', 'CANCELLED')
      else if (this.callLedger(task.id).openIntent) this.terminate(task.id, 'failed', 'AI_CALL_INCOMPLETE')
      else if (task.attempts >= runtimeConfig.worker.maxAttempts) this.terminate(task.id, 'failed', 'WORKER_RETRY_EXHAUSTED')
      else this.requeue(task.id, task.attempts)
    })
  }

  cancel(input: { actorId: string; jobId: string }): SubmissionTask {
    return this.transaction(() => {
      const task = this.getTask(input.jobId)
      if (!task) throw taskError('TASK_NOT_FOUND', 404)
      this.assertWrite(input.actorId, task.projectId)
      if (task.status === 'queued') {
        this.db.prepare('UPDATE submission_tasks SET cancel_requested=1 WHERE id=?').run(task.id)
        this.terminate(task.id, 'cancelled', 'CANCELLED')
      } else if (task.status === 'running') {
        this.db.prepare('UPDATE submission_tasks SET cancel_requested=1,updated_at=? WHERE id=?').run(this.now(), task.id)
        this.event({jobId: task.id, kind: 'cancellation_requested', message: '正在停止任务，终态前不能删除报告。', actorId: input.actorId})
      }
      return this.getTask(task.id)!
    })
  }

  retry(input: { actorId: string; jobId: string }) {
    const task = this.getTask(input.jobId)
    if (!task) throw taskError('TASK_NOT_FOUND', 404)
    return this.admit({ actorId: input.actorId, reportId: task.reportId, operation: task.operation })
  }

  deleteReport(input: { actorId: string; reportId: string; reason: string }): void {
    if (!input.reason.trim() || input.reason.length > 500) throw taskError('INVALID_DELETE_REASON', 400)
    this.transaction(() => {
      const report = this.getReport(input.reportId)
      if (!report) throw taskError('REPORT_NOT_FOUND', 404)
      const stage = this.db.prepare('SELECT current_completion_report_id FROM project_stages WHERE id=?').get(report.stageId)
      const decision = resolveReportDeletionAccess({ access: this.access(input.actorId, report.projectId), report,
        stage: { id: report.stageId, projectId: report.projectId, currentCompletionReportId: stage?.current_completion_report_id ? String(stage.current_completion_report_id) : undefined },
        operations: { analysis: this.history(report, 'analysis'), insight: this.history(report, 'insight') } })
      if (decision.kind === 'denied') throw taskError(decision.code, decision.code === 'REPORT_WRITE_FORBIDDEN' ? 403 : 409)
      this.db.prepare('UPDATE report_submissions SET deleted_at=?,deleted_by=?,deletion_reason=? WHERE id=?').run(this.now(), input.actorId, input.reason.trim(), report.id)
      this.db.prepare('INSERT INTO submission_task_events(report_id,actor_id,kind,message,created_at) VALUES (?,?,?,?,?)').run(report.id, input.actorId, 'report_deleted', '报告已逻辑删除，文件和成功历史保留。', this.now())
    })
  }

  progress(claim: SubmissionTaskClaim, input: { stage: AnalysisStage; stageIndex: number }): SubmissionTask {
    return this.transaction(() => {
      this.requireLive(claim)
      this.db.prepare('UPDATE submission_tasks SET stage=?,stage_index=?,updated_at=? WHERE id=?').run(input.stage, input.stageIndex, this.now(), claim.jobId)
      return this.getTask(claim.jobId)!
    })
  }

  saveData(claim: SubmissionTaskClaim, data: TaskDataWrite[]): void {
    this.transaction(() => { this.requireLive(claim); for (const item of data) this.putData(claim.jobId, item) })
  }
  readData(jobId: string, key: string): unknown {
    const row = this.db.prepare('SELECT payload_json FROM submission_task_data WHERE job_id=? AND data_key=?').get(jobId, key)
    return row ? JSON.parse(String(row.payload_json)) as unknown : undefined
  }
  listData(jobId: string, prefix: string): unknown[] {
    return this.db.prepare('SELECT payload_json FROM submission_task_data WHERE job_id=? AND substr(data_key,1,?)=? ORDER BY data_key').all(jobId, prefix.length, prefix).map(row => JSON.parse(String(row.payload_json)) as unknown)
  }
  private putData(jobId: string, item: TaskDataWrite) {
    const current = this.readData(jobId, item.key)
    if (item.key.startsWith('artifact:') && current !== undefined && JSON.stringify(current) !== JSON.stringify(item.value)) throw taskError('ARTIFACT_IMMUTABLE')
    this.db.prepare('INSERT INTO submission_task_data(job_id,data_key,payload_json) VALUES (?,?,?) ON CONFLICT(job_id,data_key) DO UPDATE SET payload_json=excluded.payload_json').run(jobId, item.key, JSON.stringify(item.value))
  }

  getTask(jobId: string): SubmissionTask | undefined {
    const row = this.db.prepare('SELECT * FROM submission_tasks WHERE id=?').get(jobId)
    if (!row) return undefined
    return { id: String(row.id), reportId: String(row.report_id), projectId: String(row.project_id), actorId: String(row.actor_id), operation: row.operation as ReportOperation,
      generation: Number(row.generation), status: row.status as SubmissionTask['status'], stage: row.stage as AnalysisStage, stageIndex: Number(row.stage_index), attempts: Number(row.attempts), cancelRequested: Boolean(row.cancel_requested),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), errorCode: row.error_code ? String(row.error_code) : undefined }
  }
  getFrozen(jobId: string): SubmissionTaskSnapshot { return JSON.parse(String(this.getTaskRow(jobId).frozen_json)) as SubmissionTaskSnapshot }
  getReport(reportId: string): ReportSubmission | undefined {
    const row = this.db.prepare('SELECT * FROM report_submissions WHERE id=?').get(reportId)
    if (!row) return undefined
    return { id: String(row.id), projectId: String(row.project_id), stageId: String(row.stage_id), stageVersion: Number(row.stage_version), submissionSequence: Number(row.submission_sequence), submittedAs: row.submitted_as as ReportSubmission['submittedAs'],
      title: String(row.title), fileName: String(row.file_name), sourceKey: String(row.source_key), fileHash: String(row.file_hash), sourceSize: Number(row.source_size), paragraphCount: Number(row.paragraph_count), characterCount: Number(row.character_count), submittedBy: String(row.submitted_by), submittedAt: String(row.submitted_at), wasFirstStageSubmission: Boolean(row.was_first_stage_submission),
      firstAnalysisSucceededAt: optionalText(row.first_analysis_succeeded_at), firstInsightSucceededAt: optionalText(row.first_insight_succeeded_at), deletedAt: optionalText(row.deleted_at), deletedBy: optionalText(row.deleted_by), deletionReason: optionalText(row.deletion_reason) }
  }
  getSource(reportId: string): ReportSource | undefined {
    const report = this.getReport(reportId)
    if (!report || report.deletedAt) return undefined
    const root = resolve(this.options.storageRoot)
    if (this.db.prepare('SELECT path FROM submission_storage_root WHERE id=1').get()?.path !== root) throw taskError('STORAGE_ROOT_MISMATCH')
    const path = resolve(root, report.sourceKey), key = relative(root, path)
    if (!key || isAbsolute(report.sourceKey) || key === '..' || key.startsWith('../') || isAbsolute(key)) throw taskError('INVALID_SOURCE')
    const doc = this.db.prepare('SELECT mime_type FROM report_submission_documents WHERE report_id=?').get(reportId)
    if (!doc) return undefined
    return { path, fileName: report.fileName, size: report.sourceSize, sha256: report.fileHash, mimeType: String(doc.mime_type) }
  }
  getDocumentText(reportId: string) {
    const report = this.getReport(reportId), row = this.db.prepare('SELECT text FROM report_submission_documents WHERE report_id=?').get(reportId)
    if (!report || !row || report.deletedAt) throw taskError('REPORT_NOT_FOUND')
    return { text: String(row.text), paragraphCount: report.paragraphCount, characterCount: report.characterCount }
  }
  latestTask(reportId: string, operation: ReportOperation): SubmissionTask | undefined {
    const row = this.db.prepare('SELECT id FROM submission_tasks WHERE report_id=? AND operation=? ORDER BY generation DESC LIMIT 1').get(reportId, operation)
    return row ? this.getTask(String(row.id)) : undefined
  }
  history(report: ReportSubmission, operation: ReportOperation): ReportOperationHistory {
    const latest = this.latestTask(report.id, operation)
    const successCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM submission_task_results WHERE report_id=? AND operation=?').get(report.id, operation)!.count)
    return { successCount, firstSucceededAt: operation === 'analysis' ? report.firstAnalysisSucceededAt : report.firstInsightSucceededAt,
      latestAttempt: latest ? { jobId: latest.id, status: latest.status } : undefined }
  }
  listResults(reportId: string, operation: ReportOperation): SubmissionTaskResult[] {
    return this.db.prepare('SELECT * FROM submission_task_results WHERE report_id=? AND operation=? ORDER BY generation DESC').all(reportId, operation).map(row => ({ id: String(row.id), jobId: String(row.job_id), reportId: String(row.report_id), operation, generation: Number(row.generation), payload: JSON.parse(String(row.payload_json)) as unknown, createdAt: String(row.created_at) }))
  }
  access(actorId: string, projectId: string): ReportWriteContext {
    const actor = this.db.prepare('SELECT role,status FROM users WHERE id=?').get(actorId)
    const membership = this.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(projectId, actorId)
    return { projectId, actor: actor ? { id: actorId, role: actor.role as 'admin' | 'researcher', status: actor.status as 'active' | 'disabled' } : undefined,
      membership: membership ? { userId: actorId, projectId, role: membership.role as 'owner' | 'editor' } : undefined }
  }
  assertWrite(actorId: string, projectId: string) { if (!canWriteProjectReports(this.access(actorId, projectId))) throw taskError('REPORT_WRITE_FORBIDDEN', 403) }
  assertRead(actorId: string) { if (!this.db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(actorId)) throw taskError('UNAUTHENTICATED', 401) }
  recordProgress(claim: SubmissionTaskClaim, kind: string) { this.transaction(() => { this.requireLive(claim); this.event({jobId: claim.jobId, kind: 'progress', message: safeCode(kind.toUpperCase())}) }) }

  private requireLive(claim: SubmissionTaskClaim) { if (this.cancelled(claim)) throw taskError('TASK_LEASE_LOST'); return this.getTask(claim.jobId)! }
  private requireLease(claim: SubmissionTaskClaim) {
    const row = this.getTaskRow(claim.jobId)
    if (row.status !== 'running' || row.lease_token !== claim.leaseToken || Date.parse(String(row.lease_until)) <= Date.parse(this.now())) throw taskError('TASK_LEASE_LOST')
    return this.getTask(claim.jobId)!
  }
  private getTaskRow(jobId: string): Row { const row = this.db.prepare('SELECT * FROM submission_tasks WHERE id=?').get(jobId); if (!row) throw taskError('TASK_NOT_FOUND', 404); return row }
  private terminate(jobId: string, status: 'failed' | 'cancelled', code: string) {
    this.db.prepare('UPDATE submission_tasks SET status=?,lease_token=NULL,lease_until=NULL,error_code=?,updated_at=? WHERE id=?').run(status, code, this.now(), jobId)
    this.event({jobId: jobId, kind: status, message: code})
  }
  private recoverExpiredInTransaction() {
    const rows = this.db.prepare("SELECT id FROM submission_tasks WHERE status='running' AND julianday(lease_until)<=julianday(?)").all(this.now())
    for (const row of rows) {
      const task = this.getTask(String(row.id))!
      if (task.cancelRequested) this.terminate(task.id, 'cancelled', 'CANCELLED')
      else if (this.callLedger(task.id).openIntent) this.terminate(task.id, 'failed', 'AI_CALL_INCOMPLETE')
      else if (task.attempts >= runtimeConfig.worker.maxAttempts) this.terminate(task.id, 'failed', 'WORKER_RETRY_EXHAUSTED')
      else this.requeue(task.id, task.attempts)
    }
  }
  private requeue(jobId: string, attempts: number) {
    const {retryBaseMs,retryMaxMs}=runtimeConfig.worker
    const delay=Math.min(retryMaxMs,retryBaseMs*Math.pow(2,Math.min(attempts-1,20)))
    this.db.prepare("UPDATE submission_tasks SET status='queued',lease_token=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE id=?")
      .run(new Date(Date.parse(this.now())+delay).toISOString(),this.now(),jobId)
  }
  private event(input: {jobId: string; kind: string; message: string; actorId?: string}) {
    const task = this.getTask(input.jobId)!
    this.db.prepare('INSERT INTO submission_task_events(job_id,report_id,actor_id,kind,message,created_at) VALUES (?,?,?,?,?,?)')
      .run(input.jobId, task.reportId, input.actorId ?? task.actorId, input.kind, input.message, this.now())
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.db.exec('COMMIT'); return result }
    catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  }
}
function optionalText(value: SQLOutputValue) { return value === null ? undefined : String(value) }
function safeCode(code: string) { return /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'WORKER_EXECUTION_FAILED' }
function taskError(code: string, status = 409) {
  const message = code === 'REPORT_OPERATION_SUCCESS_LIMIT'
    ? `每份报告的分析和洞察各最多成功 ${MAX_REPORT_OPERATION_SUCCESSES} 次，当前操作已达到上限。`
    : code
  return new SubmissionTaskError(code, message, status)
}
