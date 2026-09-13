import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMinimalDocxBuffer } from '../scripts/deployment-fixtures.mjs'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'
import { createReportSubmissionRuntime } from '../lib/reports/submission-runtime'

test('real DOCX -> durable file/parse -> confirmation -> restart replay -> durable job intent, without AI in submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yanxing-submission-runtime-'))
  const databasePath = join(root,'fresh.sqlite')
  const storageRoot = join(root,'files')
  let database: DatabaseSync | undefined = createReportUploadTestDatabase(databasePath)
  try {
    const runtime = createReportSubmissionRuntime({ database, storageRoot, resolveActorId:()=> 'owner', onUnexpectedError(error){throw error} })
    runtime.repository.initializePlan({ actorId:'owner',projectId:'project',stages:[{id:'stage',title:'研究成果'}] })
    const bytes = createMinimalDocxBuffer('这是一份全新的研究报告。报告包含研究问题、调查过程与完整结论。')
    const upload = await runtime.handlers.prepare(new Request('http://test/uploads?fileName='+encodeURIComponent('研究报告.docx'),{
      method:'POST',headers:{'content-length':String(bytes.byteLength)},body:new Uint8Array(bytes),
    }),'project')
    assert.equal(upload.status,201)
    const prepared = await upload.json() as {id:string;status:string;preview:{characterCount:number}}
    assert.equal(prepared.status,'ready')
    assert.ok(prepared.preview.characterCount>0)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submissions').get()?.n,0)
    const body = {uploadId:prepared.id,stageId:'stage',reportKind:'completion',expectedPlanRevision:0,expectedWorkflowRevision:0,expectedCompletionRevision:0,expectedCompletionReportId:null}
    const request = ()=>new Request('http://test/reports',{method:'POST',headers:{'Idempotency-Key':'real_submission_request'},body:JSON.stringify(body)})
    const submitted=await runtime.handlers.confirm(request(),'project')
    assert.equal(submitted.status,201)
    const original=await submitted.json() as {receipt:{reportId:string};replayed:boolean}
    assert.equal(original.replayed,false)
    assert.equal(database.prepare('SELECT status FROM report_submission_outbox').get()?.status,'pending')
    const completedAt=database.prepare('SELECT completed_at FROM project_report_state').get()?.completed_at
    assert.ok(completedAt)
    database.close()
    database=undefined

    // A receipt survives both connection restart and temporary source storage unavailability.
    await rename(storageRoot,join(root,'offline-files'))
    database=new DatabaseSync(databasePath)
    database.exec('PRAGMA foreign_keys=ON')
    const recovered=createReportSubmissionRuntime({database,storageRoot,resolveActorId:()=> 'owner',onUnexpectedError(error){throw error}})
    const replay=await recovered.handlers.confirm(request(),'project')
    assert.equal(replay.status,200)
    assert.deepEqual((await replay.json() as {receipt:unknown}).receipt,original.receipt)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submissions').get()?.n,1)
    database.exec('CREATE TABLE test_analysis_jobs(id TEXT PRIMARY KEY, report_id TEXT UNIQUE, status TEXT)')
    const event=recovered.outbox.claim()!
    recovered.outbox.deliver({eventId:event.id,leaseToken:event.leaseToken,enqueue:(event,db)=>{
      db.prepare("INSERT INTO test_analysis_jobs VALUES ('initial-analysis',?,'queued')").run(event.reportId)
      return 'initial-analysis'
    }})
    database.exec("UPDATE test_analysis_jobs SET status='failed'")
    assert.equal(database.prepare('SELECT completed_at FROM project_report_state').get()?.completed_at,completedAt)
    assert.equal(database.prepare('SELECT first_analysis_succeeded_at FROM report_submissions').get()?.first_analysis_succeeded_at,null)
    assert.equal(database.prepare('SELECT status FROM report_submission_outbox').get()?.status,'delivered')
  } finally {
    database?.close()
    await rm(root,{recursive:true,force:true})
  }
})
