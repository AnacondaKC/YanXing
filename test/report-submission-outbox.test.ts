import assert from 'node:assert/strict'
import test from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'
import { ReportSubmissionOutbox } from '../lib/db/report-submission-outbox'

function fixture() {
  const database = createReportUploadTestDatabase()
  const at = new Date().toISOString()
  database.exec("INSERT INTO project_report_state(project_id) VALUES ('project')")
  database.prepare("INSERT INTO project_stages(id,project_id,ordinal,title,lifecycle_status,started_at) VALUES ('stage','project',1,'调研','in_progress',?)").run(at)
  database.prepare("INSERT INTO report_submissions(id,project_id,stage_id,stage_version,submission_sequence,submitted_as,title,file_name,source_key,file_hash,source_size,paragraph_count,character_count,submitted_by,submitted_at,was_first_stage_submission) VALUES ('report','project','stage',1,1,'update','报告','report.pdf','report.pdf','hash',10,1,10,'owner',?,1)").run(at)
  database.prepare("INSERT INTO report_submission_outbox(id,report_id,project_id,actor_id,event_type,payload_json,available_at,created_at) VALUES ('event','report','project','owner','report_submitted','{}',?,?)").run(at,at)
  database.exec('CREATE TABLE test_dispatched_jobs (id TEXT PRIMARY KEY, report_id TEXT NOT NULL UNIQUE)')
  let now = new Date(at)
  return { database, outbox: new ReportSubmissionOutbox({ database, leaseMs: 1000, now: () => now }),
    advance: (milliseconds: number) => { now = new Date(now.getTime()+milliseconds) }, now: () => now }
}

function enqueue(reportId: string, database: DatabaseSync) {
  database.prepare('INSERT INTO test_dispatched_jobs(id,report_id) VALUES (?,?)').run('job-'+reportId,reportId)
  return 'job-'+reportId
}

test('automatic SQLite rollback preserves the original acknowledgement failure', () => {
  const { database, outbox } = fixture()
  try {
    const event = outbox.claim()!
    database.exec("CREATE TEMP TRIGGER rollback_ack BEFORE UPDATE ON report_submission_outbox WHEN NEW.status='delivered' BEGIN SELECT RAISE(ROLLBACK,'original acknowledgement failure'); END")
    assert.throws(() => outbox.deliver({ eventId: event.id, leaseToken: event.leaseToken, enqueue: (event, db) => enqueue(event.reportId, db) }), /original acknowledgement failure/)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM test_dispatched_jobs').get()?.n, 0)
    assert.equal(database.isTransaction, false)
  } finally { database.close() }
})

test('outbox lease is exclusive, delivery creates a durable job and acknowledgement in the same transaction', () => {
  const { database, outbox } = fixture()
  try {
    const event = outbox.claim()!
    assert.equal(event.reportId,'report')
    assert.equal(event.attempts,1)
    assert.equal(outbox.claim(),undefined)
    assert.equal(outbox.deliver({ eventId:event.id, leaseToken:event.leaseToken, enqueue:(event,db)=>enqueue(event.reportId,db) }),'job-report')
    assert.equal(database.prepare('SELECT status FROM report_submission_outbox').get()?.status,'delivered')
    assert.equal(outbox.claim(),undefined)
    assert.throws(()=>outbox.deliver({ eventId:event.id,leaseToken:event.leaseToken,enqueue:(event,db)=>enqueue(event.reportId,db) }),/租约/)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM test_dispatched_jobs').get()?.n,1)
  } finally { database.close() }
})

test('crashed worker lease expires and fences stale acknowledgement from the recovered worker', () => {
  const { database, outbox, advance } = fixture()
  try {
    const stale=outbox.claim()!
    advance(1001)
    const recovered=outbox.claim()!
    assert.notEqual(recovered.leaseToken,stale.leaseToken)
    assert.equal(recovered.attempts,2)
    assert.throws(()=>outbox.deliver({eventId:stale.id,leaseToken:stale.leaseToken,enqueue:(event,db)=>enqueue(event.reportId,db)}),/租约/)
    outbox.deliver({eventId:recovered.id,leaseToken:recovered.leaseToken,enqueue:(event,db)=>enqueue(event.reportId,db)})
  } finally { database.close() }
})

test('failed acknowledgement rolls back created job; persisted intent remains retryable', () => {
  const { database, outbox, advance, now } = fixture()
  try {
    const event=outbox.claim()!
    database.exec("CREATE TEMP TRIGGER fail_ack BEFORE UPDATE ON report_submission_outbox WHEN NEW.status='delivered' BEGIN SELECT RAISE(ABORT,'injected acknowledgement failure'); END")
    assert.throws(()=>outbox.deliver({eventId:event.id,leaseToken:event.leaseToken,enqueue:(event,db)=>enqueue(event.reportId,db)}),/injected/)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM test_dispatched_jobs').get()?.n,0)
    assert.equal(database.prepare('SELECT status FROM report_submission_outbox').get()?.status,'leased')
    outbox.retry({eventId:event.id,leaseToken:event.leaseToken,errorCode:'TEMPORARY_DATABASE_ERROR',availableAt:new Date(now().getTime()+2000).toISOString()})
    assert.equal(outbox.claim(),undefined)
    advance(2001)
    database.exec('DROP TRIGGER fail_ack')
    const next=outbox.claim()!
    outbox.deliver({eventId:next.id,leaseToken:next.leaseToken,enqueue:(event,db)=>enqueue(event.reportId,db)})
  } finally { database.close() }
})

test('outbox rejects asynchronous delivery and preserves caller transaction on nested use', () => {
  const { database, outbox } = fixture()
  try {
    const event=outbox.claim()!
    const asyncEnqueue = (async () => 'job') as unknown as Parameters<ReportSubmissionOutbox['deliver']>[0]['enqueue']
    assert.throws(()=>outbox.deliver({eventId:event.id,leaseToken:event.leaseToken,enqueue:asyncEnqueue}),/synchronous/)
    database.exec('BEGIN')
    database.exec("INSERT INTO test_dispatched_jobs VALUES ('outer','outer-report')")
    assert.throws(()=>outbox.claim(),/transaction/)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM test_dispatched_jobs').get()?.n,1)
    database.exec('ROLLBACK')
  } finally { database.close() }
})
