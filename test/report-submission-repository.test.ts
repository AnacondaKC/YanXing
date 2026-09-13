import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ReportSubmissionRepository } from '../lib/db/report-submission-repository'
import { StageWorkflowError } from '../modules/projects/stage-domain'
import { ReportSubmissionError, type SubmissionFailureCode } from '../modules/reports/upload-domain'
import {
  OWNER,
  PROJECT_ID,
  confirmationFor,
  connectSubmissionEngine,
  count,
  createSubmissionEngine,
  initializeDefaultPlan,
  preparedFile,
  receiveReadyUpload,
  wrapQuota,
} from './helpers/report-submission-fixture'

function expectCode(code: SubmissionFailureCode | StageWorkflowError['code']) {
  return (error: unknown) => (
    (error instanceof ReportSubmissionError || error instanceof StageWorkflowError) && error.code === code
  )
}

function closeAll(...databases: Array<{ close(): void }>) {
  for (const database of databases) {
    try { database.close() } catch { /* already closed */ }
  }
}

test('initializePlan persists zero revisions and rejects a second plan', () => {
  const { database, repository } = createSubmissionEngine()
  try {
    const workflow = initializeDefaultPlan(repository)
    assert.equal(workflow.planRevision, 0)
    assert.equal(workflow.workflowRevision, 0)
    assert.equal(workflow.nextSubmissionSequence, 1)
    assert.equal(workflow.stages[0]?.lifecycleStatus, 'in_progress')
    assert.equal(workflow.stages[1]?.lifecycleStatus, 'not_started')
    assert.throws(() => initializeDefaultPlan(repository), expectCode('STAGE_PLAN_EXISTS'))
    assert.throws(() => repository.initializePlan({ actorId: 'editor', projectId: PROJECT_ID, stages: [{ id: 's', title: 'x' }] }), expectCode('REPORT_WRITE_FORBIDDEN'))
    assert.throws(() => repository.loadWorkflow({ actorId: OWNER, projectId: 'missing' }), expectCode('PROJECT_NOT_FOUND'))
  } finally { closeAll(database) }
})

test('editor can read plans but cannot upload; admin can initialize without membership', () => {
  const { database, repository } = createSubmissionEngine()
  try {
    assert.throws(() => repository.loadWorkflow({ actorId: 'editor', projectId: PROJECT_ID }), expectCode('STAGE_PLAN_MISSING'))
    assert.equal(repository.initializePlan({
      actorId: 'admin',
      projectId: PROJECT_ID,
      stages: [{ id: 'stage-1', title: '开题研究' }, { id: 'stage-2', title: '实地调研' }],
    }).planRevision, 0)
    assert.equal(repository.loadWorkflow({ actorId: 'editor', projectId: PROJECT_ID }).planRevision, 0)
    assert.throws(() => repository.beginUpload({
      actorId: 'editor', projectId: PROJECT_ID, uploadId: 'upload-editor', fileName: 'a.docx', reservedBytes: 8,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), expectCode('REPORT_WRITE_FORBIDDEN'))
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM report_uploads'), 0)
  } finally { closeAll(database) }
})

test('upload requires parsing before ready and rejects invalid or oversized prepared files', () => {
  const { database, repository } = createSubmissionEngine()
  try {
    initializeDefaultPlan(repository)
    const uploadId = 'upload-ready-1'
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const receiving = repository.beginUpload({
      actorId: OWNER, projectId: PROJECT_ID, uploadId, fileName: 'report.docx', reservedBytes: 1024, expiresAt,
    })
    assert.equal(receiving.status, 'receiving')
    assert.equal(count(database, "SELECT reserved_bytes AS n FROM storage_usage WHERE scope_type='global'"), 1024)
    assert.throws(() => repository.markReady({ actorId: OWNER, projectId: PROJECT_ID, uploadId, file: preparedFile(uploadId) }), expectCode('UPLOAD_NOT_READY'))
    assert.equal(repository.markParsing({ actorId: OWNER, projectId: PROJECT_ID, uploadId }).status, 'parsing')
    assert.throws(() => repository.markReady({
      actorId: OWNER, projectId: PROJECT_ID, uploadId,
      file: { ...preparedFile(uploadId), sourceKey: '../escape.docx' },
    }), expectCode('UPLOAD_FILE_INVALID'))
    assert.throws(() => repository.markReady({
      actorId: OWNER, projectId: PROJECT_ID, uploadId,
      file: { ...preparedFile(uploadId), sourceSize: 2048 },
    }), expectCode('UPLOAD_FILE_INVALID'))
    assert.throws(() => repository.markReady({ actorId: OWNER, projectId: PROJECT_ID, uploadId, file: preparedFile('another-upload') }), expectCode('UPLOAD_FILE_INVALID'))
    assert.throws(() => repository.markReady({ actorId: OWNER, projectId: PROJECT_ID, uploadId, file: { ...preparedFile(uploadId), characterCount: 1 } }), expectCode('UPLOAD_FILE_INVALID'))
    const ready = repository.markReady({ actorId: OWNER, projectId: PROJECT_ID, uploadId, file: preparedFile(uploadId) })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.prepared?.sourceKey, uploadId + '/report.docx')
  } finally { closeAll(database) }
})

test('expired ready uploads cannot confirm; failUpload releases quota and remains owner-only after revoke', () => {
  const { database, quota } = createSubmissionEngine()
  const clock = { now: new Date() }
  const repository = new ReportSubmissionRepository({ database, quota, now: () => clock.now })
  try {
    initializeDefaultPlan(repository)
    const uploadId = 'upload-expire-1'
    repository.beginUpload({
      actorId: OWNER, projectId: PROJECT_ID, uploadId, fileName: 'report.docx', reservedBytes: 1024,
      expiresAt: new Date(clock.now.getTime() + 1000).toISOString(),
    })
    repository.markParsing({ actorId: OWNER, projectId: PROJECT_ID, uploadId })
    repository.markReady({ actorId: OWNER, projectId: PROJECT_ID, uploadId, file: preparedFile(uploadId) })
    clock.now = new Date(clock.now.getTime() + 2000)
    assert.throws(() => repository.confirmSubmission(confirmationFor(repository, {
      uploadId, idempotencyKey: 'expired_request_key1',
    })), expectCode('UPLOAD_EXPIRED'))
    database.exec("UPDATE project_members SET role='editor' WHERE user_id='owner'")
    assert.throws(() => repository.getUpload({ actorId: OWNER, projectId: PROJECT_ID, uploadId }), expectCode('REPORT_WRITE_FORBIDDEN'))
    const failed = repository.failUpload({ actorId: OWNER, projectId: PROJECT_ID, uploadId, errorCode: 'REPORT_PARSE_FAILED' })
    assert.equal(failed.status, 'failed')
    assert.equal(count(database, "SELECT reserved_bytes AS n FROM storage_usage WHERE scope_type='global'"), 0)
    assert.throws(() => repository.failUpload({ actorId: 'admin', projectId: PROJECT_ID, uploadId, errorCode: 'REPORT_PARSE_FAILED' }), expectCode('UPLOAD_NOT_FOUND'))
  } finally { closeAll(database) }
})

test('confirmSubmission writes report, document, stages, quota, audit, outbox and immutable receipt', () => {
  const { database, repository } = createSubmissionEngine()
  try {
    initializeDefaultPlan(repository)
    receiveReadyUpload(repository, 'upload-confirm-1')
    const input = confirmationFor(repository, { uploadId: 'upload-confirm-1', idempotencyKey: 'submission_request_01' })
    const first = repository.confirmSubmission(input)
    assert.equal(first.replayed, false)
    assert.equal(first.receipt.stageVersion, 1)
    assert.equal(first.receipt.submissionSequence, 1)
    assert.equal(first.receipt.submittedAs, 'update')
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM report_submissions'), 1)
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM report_submission_documents'), 1)
    assert.equal(count(database, "SELECT COUNT(*) AS n FROM report_submission_outbox WHERE status='pending'"), 1)
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM report_submission_audit'), 1)
    assert.equal(database.prepare('SELECT owner_id FROM storage_allocations').get()?.owner_id, first.receipt.reportId)
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='report_versions'").get(), undefined)
    assert.equal(database.prepare('SELECT document_text FROM report_uploads').get()?.document_text, null)
    const payload = JSON.parse(String(database.prepare('SELECT payload_json FROM report_submission_outbox').get()?.payload_json)) as { workflow: { stages: Array<{ lifecycleStatus: string }> } }
    assert.equal(payload.workflow.stages[0]?.lifecycleStatus, 'in_progress')
    const replay = repository.confirmSubmission({ ...input, command: { ...input.command } })
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.receipt, first.receipt)
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM report_submissions'), 1)
  } finally { closeAll(database) }
})

test('idempotent replay happens before stale tokens; digest is field-order stable; alternate key conflicts', () => {
  const { database, repository } = createSubmissionEngine()
  try {
    initializeDefaultPlan(repository)
    receiveReadyUpload(repository, 'upload-a')
    receiveReadyUpload(repository, 'upload-b')
    const original = confirmationFor(repository, { uploadId: 'upload-a', idempotencyKey: 'completion_request_01', reportKind: 'completion' })
    const first = repository.confirmSubmission(original)
    assert.equal(first.replayed, false)
    const reversed = {
      ...original,
      command: Object.fromEntries(Object.entries(original.command).reverse()) as typeof original.command,
    }
    const replay = repository.replayConfirmation(reversed)
    assert.equal(replay?.replayed, true)
    assert.deepEqual(replay?.receipt, first.receipt)
    const staleReplay = repository.confirmSubmission(original)
    assert.equal(staleReplay.replayed, true)
    assert.deepEqual(staleReplay.receipt, first.receipt)
    assert.throws(() => repository.confirmSubmission({ ...original, command: { ...original.command, reportKind: 'update' } }), expectCode('IDEMPOTENCY_KEY_REUSED'))
    const otherKey = confirmationFor(repository, { uploadId: 'upload-a', idempotencyKey: 'completion_request_02', reportKind: 'completion' })
    assert.throws(() => repository.confirmSubmission(otherKey), expectCode('UPLOAD_ALREADY_COMMITTED'))
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM report_submissions'), 1)
  } finally { closeAll(database) }
})

test('injected audit, outbox and quota failures after stage mutation fully roll back', () => {
  const base = createSubmissionEngine()
  try {
    initializeDefaultPlan(base.repository)
    receiveReadyUpload(base.repository, 'upload-audit')
    base.database.exec("CREATE TEMP TRIGGER fail_audit AFTER INSERT ON report_submission_audit BEGIN SELECT RAISE(ABORT, 'injected audit'); END")
    assert.throws(() => base.repository.confirmSubmission(confirmationFor(base.repository, {
      uploadId: 'upload-audit', idempotencyKey: 'inject_audit_request1',
    })), /injected audit/)
    assert.equal(count(base.database, 'SELECT COUNT(*) AS n FROM report_submissions'), 0)
    assert.equal(count(base.database, 'SELECT COUNT(*) AS n FROM project_stages WHERE lifecycle_status = \'in_progress\''), 1)
    assert.equal(base.repository.getUpload({ actorId: OWNER, projectId: PROJECT_ID, uploadId: 'upload-audit' }).status, 'ready')
    base.database.exec('DROP TRIGGER fail_audit')

    receiveReadyUpload(base.repository, 'upload-outbox')
    base.database.exec("CREATE TEMP TRIGGER fail_outbox AFTER INSERT ON report_submission_outbox BEGIN SELECT RAISE(ABORT, 'injected outbox'); END")
    assert.throws(() => base.repository.confirmSubmission(confirmationFor(base.repository, {
      uploadId: 'upload-outbox', idempotencyKey: 'inject_outbox_request1',
    })), /injected outbox/)
    assert.equal(count(base.database, 'SELECT COUNT(*) AS n FROM report_submissions'), 0)
    base.database.exec('DROP TRIGGER fail_outbox')
  } finally { closeAll(base.database) }

  const traps: { consume?: Error } = { consume: new Error('injected quota') }
  const fresh = createSubmissionEngine()
  const quota = wrapQuota(fresh.quota, traps)
  const repository = new ReportSubmissionRepository({ database: fresh.database, quota })
  try {
    initializeDefaultPlan(repository)
    receiveReadyUpload(repository, 'upload-quota')
    assert.throws(() => repository.confirmSubmission(confirmationFor(repository, {
      uploadId: 'upload-quota', idempotencyKey: 'inject_quota_request1',
    })), /injected quota/)
    assert.equal(count(fresh.database, 'SELECT COUNT(*) AS n FROM report_submissions'), 0)
    assert.equal(count(fresh.database, 'SELECT COUNT(*) AS n FROM storage_allocations'), 0)
    assert.equal(repository.getUpload({ actorId: OWNER, projectId: PROJECT_ID, uploadId: 'upload-quota' }).status, 'ready')
    assert.equal(fresh.database.prepare('SELECT lifecycle_status FROM project_stages WHERE id = ?').get('stage-1')?.lifecycle_status, 'in_progress')
  } finally { closeAll(fresh.database) }
})

test('BEGIN IMMEDIATE does not silently roll back a caller transaction', () => {
  const { database, repository } = createSubmissionEngine()
  try {
    database.exec('BEGIN')
    database.prepare("UPDATE projects SET title = 'nested-lock' WHERE id = ?").run(PROJECT_ID)
    assert.throws(() => initializeDefaultPlan(repository), /within a transaction/i)
    database.exec('COMMIT')
    assert.equal(database.prepare('SELECT title FROM projects WHERE id = ?').get(PROJECT_ID)?.title, 'nested-lock')
  } finally { closeAll(database) }
})

test('separate connections see committed completion tokens and replay the same receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-sub-'))
  const path = join(dir, 'db.sqlite')
  const first = createSubmissionEngine(path)
  let second: { database: { close(): void } } | undefined
  try {
    initializeDefaultPlan(first.repository)
    receiveReadyUpload(first.repository, 'upload-one')
    receiveReadyUpload(first.repository, 'upload-two')
    const completion = confirmationFor(first.repository, {
      uploadId: 'upload-one', idempotencyKey: 'multi_connection_key01', reportKind: 'completion',
    })
    const committed = first.repository.confirmSubmission(completion)
    const attached = connectSubmissionEngine(path, first.quota)
    second = attached
    const stale = confirmationFor(attached.repository, {
      uploadId: 'upload-two', idempotencyKey: 'multi_connection_key02', reportKind: 'completion',
    })
    stale.command.expectedCompletionRevision = completion.command.expectedCompletionRevision
    stale.command.expectedCompletionReportId = completion.command.expectedCompletionReportId
    stale.command.expectedWorkflowRevision = completion.command.expectedWorkflowRevision
    assert.throws(() => attached.repository.confirmSubmission(stale), expectCode('STAGE_COMPLETION_CHANGED'))
    const replay = attached.repository.confirmSubmission(completion)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.receipt, committed.receipt)
    assert.equal(count(attached.database, 'SELECT COUNT(*) AS n FROM report_submissions'), 1)
  } finally {
    closeAll(first.database, ...(second ? [second.database] : []))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a held write lock surfaces as busy to the other connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-lock-'))
  const path = join(dir, 'db.sqlite')
  const first = createSubmissionEngine(path)
  let second: { database: { close(): void } } | undefined
  try {
    initializeDefaultPlan(first.repository)
    receiveReadyUpload(first.repository, 'upload-lock')
    const attached = connectSubmissionEngine(path, first.quota, 50)
    second = attached
    first.database.exec('BEGIN IMMEDIATE')
    first.database.prepare('UPDATE projects SET title = title WHERE id = ?').run(PROJECT_ID)
    assert.throws(() => attached.repository.confirmSubmission(confirmationFor(attached.repository, {
      uploadId: 'upload-lock', idempotencyKey: 'busy_request_key01',
    })), /locked|busy/i)
    first.database.exec('ROLLBACK')
  } finally {
    closeAll(first.database, ...(second ? [second.database] : []))
    rmSync(dir, { recursive: true, force: true })
  }
})
