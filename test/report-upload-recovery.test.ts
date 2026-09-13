import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash,randomUUID } from 'node:crypto'
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMinimalDocxBuffer } from '../scripts/deployment-fixtures.mjs'
import { createPreparedReportFiles } from '../lib/documents/prepared-report-files'
import { ReportSubmissionService } from '../modules/reports/submission-service'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'
import { ReportSubmissionRepository } from '../lib/db/report-submission-repository'
import { ReportUploadRecovery } from '../lib/db/report-upload-recovery'
import { createSubmissionStorageQuota } from '../lib/storage/submission-quota'
import { expireStorageReservationsInDatabase } from '../lib/storage/quota'
import { createUploadRecoveryFiles } from '../lib/documents/upload-recovery-files'
import { auditSubmissionStorage } from '../lib/storage/submission-storage-audit'
import { runStorageMaintenance } from '../lib/storage/maintenance'

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'yanxing-recovery-'))
  const storageRoot=join(root,'files')
  const databasePath=join(root,'fresh.sqlite')
  await mkdir(storageRoot)
  const database=createReportUploadTestDatabase(databasePath,storageRoot)
  const clock={now:new Date()}
  const repository=new ReportSubmissionRepository({database,quota:createSubmissionStorageQuota({storageRoot}),now:()=>clock.now})
  repository.initializePlan({actorId:'owner',projectId:'project',stages:[{id:'stage',title:'阶段'}]})
  const files=createUploadRecoveryFiles({storageRoot})
  const recovery=new ReportUploadRecovery({database,storageRoot,files,now:()=>clock.now})
  const begin=(id:string)=>repository.beginUpload({actorId:'owner',projectId:'project',uploadId:id,fileName:'report.docx',reservedBytes:8192,expiresAt:new Date(clock.now.getTime()+1000).toISOString()})
  async function ready(id:string) {
    begin(id)
    repository.markParsing({actorId:'owner',projectId:'project',uploadId:id})
    await mkdir(join(storageRoot,id))
    await writeFile(join(storageRoot,id,id+'.docx'),'file')
    repository.markReady({actorId:'owner',projectId:'project',uploadId:id,file:{sourceKey:id+'/'+id+'.docx',fileName:'report.docx',mimeType:'application/docx',sourceSize:4,fileHash:createHash('sha256').update('file').digest('hex'),title:'报告',text:'内容',paragraphCount:1,characterCount:2}})
  }
  const confirmation=(id:string)=>({actorId:'owner',projectId:'project',idempotencyKey:'confirm_request_'+id,command:{uploadId:id,stageId:'stage',reportKind:'update' as const,expectedPlanRevision:0,expectedWorkflowRevision:0,expectedCompletionRevision:0,expectedCompletionReportId:null}})
  async function dispose(){try{database.close()}catch{}await rm(root,{recursive:true,force:true})}
  return {root,storageRoot,databasePath,database,clock,repository,files,recovery,begin,ready,confirmation,dispose}
}

test('expired ready upload is reclaimed without report allocation and only after physical deletion',async()=>{
  const f=await fixture()
  try {
    await f.ready('ready')
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    const claim=f.recovery.claim()!
    assert.equal(f.database.prepare("SELECT reserved_bytes FROM storage_usage WHERE scope_type='global'").get()?.reserved_bytes,8192)
    assert.throws(()=>f.repository.confirmSubmission(f.confirmation('ready')))
    await f.files.remove(claim.uploadId)
    f.recovery.complete(claim)
    assert.equal(f.database.prepare('SELECT status FROM report_uploads').get()?.status,'reclaimed')
    assert.equal(f.database.prepare("SELECT reserved_bytes FROM storage_usage WHERE scope_type='global'").get()?.reserved_bytes,0)
    assert.equal(f.database.prepare('SELECT next_submission_sequence FROM project_report_state').get()?.next_submission_sequence,1)
    assert.deepEqual(await f.recovery.runBatch(),{recovered:[],blocked:[]})
  } finally {await f.dispose()}
})

test('receiving/parsing crash is recovered by ID even without source metadata; other upload and unknown temp names survive',async()=>{
  const f=await fixture()
  try {
    f.begin('receiving')
    f.begin('parsing')
    f.repository.markParsing({actorId:'owner',projectId:'project',uploadId:'parsing'})
    await mkdir(join(f.storageRoot,'.tmp'))
    const partial=join(f.storageRoot,'.tmp','receiving-'+randomUUID()+'.upload')
    await writeFile(partial,'partial')
    await writeFile(join(f.storageRoot,'.tmp','receiving-not-a-uuid.upload'),'keep')
    await mkdir(join(f.storageRoot,'parsing'))
    await writeFile(join(f.storageRoot,'parsing','parsing.docx'),'parsed but not ready')
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    await f.ready('live')
    const result=await f.recovery.runBatch()
    assert.equal(result.recovered.length,2)
    await assert.rejects(readFile(partial),/ENOENT/)
    assert.equal(await readFile(join(f.storageRoot,'live','live.docx'),'utf8'),'file')
    assert.equal(await readFile(join(f.storageRoot,'.tmp','receiving-not-a-uuid.upload'),'utf8'),'keep')
  } finally {await f.dispose()}
})

test('durable fence prevents paused writers reopening or appending after reclamation, even with a stale clock',async()=>{
  const f=await fixture()
  try {
    f.begin('writer')
    const initial=f.clock.now
    f.recovery.withMutation('writer',()=>writeFileSync(join(f.storageRoot,'probe'),'before'))
    f.clock.now=new Date(initial.getTime()+2000)
    const claim=f.recovery.claim()!
    f.clock.now=initial
    assert.throws(()=>f.recovery.withMutation('writer',()=>writeFileSync(join(f.storageRoot,'probe'),'after')),/禁止继续写入/)
    assert.equal(await readFile(join(f.storageRoot,'probe'),'utf8'),'before')
    await f.files.remove(claim.uploadId)
    f.recovery.complete(claim)
    assert.throws(()=>f.recovery.withMutation('writer',()=>0),/禁止继续写入/)
  } finally {await f.dispose()}
})

test('failure after deletion rolls back quota release; expired recovery lease can be resumed after connection restart',async()=>{
  const f=await fixture()
  let restarted:DatabaseSync|undefined
  try {
    await f.ready('crash')
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    const old=f.recovery.claim()!
    await f.files.remove(old.uploadId)
    f.database.close()
    f.clock.now=new Date(f.clock.now.getTime()+60001)
    restarted=new DatabaseSync(f.databasePath)
    restarted.exec('PRAGMA foreign_keys=ON')
    const recovered=new ReportUploadRecovery({database:restarted,storageRoot:f.storageRoot,files:f.files,now:()=>f.clock.now})
    const next=recovered.claim()!
    assert.notEqual(next.token,old.token)
    assert.throws(()=>recovered.complete(old),/租约/)
    restarted.exec("CREATE TEMP TRIGGER fail_release BEFORE UPDATE ON report_uploads WHEN NEW.status='reclaimed' BEGIN SELECT RAISE(ABORT,'release fault'); END")
    assert.throws(()=>recovered.complete(next),/release fault/)
    assert.equal(restarted.prepare('SELECT state FROM storage_reservations').get()?.state,'active')
    restarted.exec('DROP TRIGGER fail_release')
    await f.files.remove(next.uploadId)
    recovered.complete(next)
    assert.equal(restarted.prepare('SELECT state FROM storage_reservations').get()?.state,'released')
  } finally {restarted?.close();await f.dispose()}
})

test('unknown siblings and symlinks block cleanup, preserve outside targets and retain reservations for retry',async()=>{
  const f=await fixture()
  try {
    await f.ready('blocked')
    await writeFile(join(f.storageRoot,'blocked','unrelated.txt'),'keep')
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    assert.deepEqual((await f.recovery.runBatch()).blocked,['blocked'])
    assert.equal(f.database.prepare('SELECT state FROM storage_reservations').get()?.state,'active')
    await rm(join(f.storageRoot,'blocked','unrelated.txt'))
    await rm(join(f.storageRoot,'blocked','blocked.docx'))
    const outside=join(f.root,'outside')
    await writeFile(outside,'outside')
    await symlink(outside,join(f.storageRoot,'blocked','blocked.docx'))
    f.clock.now=new Date(f.clock.now.getTime()+60001)
    assert.deepEqual((await f.recovery.runBatch()).blocked,['blocked'])
    assert.equal(await readFile(outside,'utf8'),'outside')
    await rm(join(f.storageRoot,'blocked','blocked.docx'))
    f.clock.now=new Date(f.clock.now.getTime()+60001)
    assert.deepEqual((await f.recovery.runBatch()).recovered,['blocked'])
  } finally {await f.dispose()}
})

test('maintenance retains persisted reservations for expired uploads until physical cleanup',async()=>{
  const f=await fixture()
  try {
    await f.ready('held-maintenance')
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    const result=await runStorageMaintenance({database:f.database,now:f.clock.now,roots:{reportRoot:f.storageRoot,knowledgeRoot:join(f.root,'knowledge'),temporaryRoot:join(f.root,'tmp')}})
    assert.deepEqual(result.errors,[])
    assert.equal(f.database.prepare('SELECT state FROM storage_reservations').get()?.state,'active')
    assert.equal(f.database.prepare("SELECT reserved_bytes FROM storage_usage WHERE scope_type='global'").get()?.reserved_bytes,8192)
    assert.equal(await readFile(join(f.storageRoot,'held-maintenance','held-maintenance.docx'),'utf8'),'file')
  } finally {await f.dispose()}
})

test('generic reservation expiry cannot release persisted uploads before cleanup',async()=>{
  const f=await fixture()
  try {
    await f.ready('held')
    assert.equal(expireStorageReservationsInDatabase(f.database,new Date(Date.now()+86400000).toISOString()),0)
    assert.equal(f.database.prepare('SELECT state FROM storage_reservations').get()?.state,'active')
  } finally {await f.dispose()}
})

test('committed and logically deleted report files are never reclaimed; quota repair preserves knowledge allocations',async()=>{
  const f=await fixture()
  try {
    await f.ready('formal')
    const receipt=f.repository.confirmSubmission(f.confirmation('formal')).receipt
    assert.equal(f.database.prepare("SELECT document_text FROM report_uploads WHERE id='formal'").get()?.document_text,null)
    assert.equal(f.database.prepare('SELECT text FROM report_submission_documents WHERE report_id=?').get(receipt.reportId)?.text,'内容')
    assert.deepEqual(f.repository.confirmSubmission(f.confirmation('formal')).receipt,receipt)
    assert.throws(()=>f.database.exec("UPDATE report_uploads SET document_text='restore duplicate' WHERE id='formal'"))
    f.database.prepare("UPDATE report_submissions SET deleted_at=?,deleted_by='owner',deletion_reason='test' WHERE id=?").run(new Date().toISOString(),receipt.reportId)
    f.database.exec("DELETE FROM storage_allocations WHERE owner_type='report'")
    const at=new Date().toISOString()
    f.database.prepare("INSERT INTO storage_allocations VALUES ('knowledge','knowledge-doc','other',NULL,11,'hash','/external/knowledge','text/plain',?,?)").run(at,at)
    f.database.exec('UPDATE storage_usage SET used_bytes=999,reserved_bytes=999')
    assert.ok((await auditSubmissionStorage(f)).issues.some(issue=>issue.code==='REPORT_ALLOCATION_MISMATCH'))
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    assert.deepEqual(await f.recovery.runBatch(),{recovered:[],blocked:[]})
    assert.equal(await readFile(join(f.storageRoot,'formal','formal.docx'),'utf8'),'file')
    assert.equal(f.database.prepare("SELECT used_bytes FROM storage_usage WHERE scope_type='global'").get()?.used_bytes,15)
    assert.equal(f.database.prepare("SELECT used_bytes FROM storage_usage WHERE scope_type='user' AND scope_id='other'").get()?.used_bytes,11)
    assert.deepEqual((await auditSubmissionStorage(f)).issues,[])
  } finally {await f.dispose()}
})

test('reconciliation restores lost held reservation while audit reports corrupt official source without deleting it',async()=>{
  const f=await fixture()
  try {
    await f.ready('official')
    const receipt=f.repository.confirmSubmission(f.confirmation('official')).receipt
    await f.ready('pending')
    const reservation=f.database.prepare("SELECT reservation_id FROM report_uploads WHERE id='pending'").get()!.reservation_id
    f.database.prepare('DELETE FROM storage_reservations WHERE id=?').run(reservation)
    await writeFile(join(f.storageRoot,'official','official.docx'),'corrupted')
    f.recovery.reconcileQuota()
    assert.equal(f.database.prepare('SELECT state FROM storage_reservations WHERE id=?').get(reservation)?.state,'active')
    const audit=await auditSubmissionStorage(f)
    assert.ok(audit.issues.some(issue=>issue.id===receipt.reportId && issue.code==='REPORT_SOURCE_UNAVAILABLE'))
    assert.equal(await readFile(join(f.storageRoot,'official','official.docx'),'utf8'),'corrupted')
  } finally {await f.dispose()}
})

test('actual streaming writer paused at a network read cannot recreate reclaimed temporary files',{timeout:10000},async()=>{
  const f=await fixture()
  let controller:ReadableStreamDefaultController<Uint8Array>|undefined
  try {
    let written!:()=>void
    const firstWrite=new Promise<void>(resolve=>{written=resolve})
    const files=createPreparedReportFiles({storageRoot:f.storageRoot,withMutation:(id,write)=>{
      const result=f.recovery.withMutation(id,write)
      if(result && typeof result==='object' && 'bytesWritten' in result) written()
      return result
    }})
    const service=new ReportSubmissionService({repository:f.repository,files,maxUploadBytes:8192,uploadTtlMs:1000,now:()=>f.clock.now,newId:()=> 'streaming'})
    const body=new ReadableStream<Uint8Array>({start(stream){controller=stream;stream.enqueue(createMinimalDocxBuffer('研究正文'))}})
    const preparation=service.prepare({actorId:'owner',projectId:'project',fileName:'report.docx',body})
    const rejected=assert.rejects(preparation,/禁止继续写入/)
    await firstWrite
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    assert.deepEqual((await f.recovery.runBatch()).recovered,['streaming'])
    controller!.enqueue(Buffer.from('late bytes'))
    controller!.close()
    await rejected
    assert.deepEqual((await f.files.inventory()).uploadIds,[])
    assert.equal(f.database.prepare("SELECT reserved_bytes FROM storage_usage WHERE scope_type='global'").get()?.reserved_bytes,0)
  } finally {await f.dispose()}
})

test('parser completion arriving after recovery cannot publish ready or release another recovery lease',{timeout:10000},async()=>{
  const f=await fixture()
  let resume!:()=>void
  try {
    let started!:()=>void
    const parsing=new Promise<void>(resolve=>{started=resolve})
    const paused=new Promise<void>(resolve=>{resume=resolve})
    const files=createPreparedReportFiles({storageRoot:f.storageRoot,withMutation:(id,write)=>f.recovery.withMutation(id,write),extractText:async()=>{
      started();await paused;return {text:'研究内容',paragraphCount:1,characterCount:4}
    }})
    const service=new ReportSubmissionService({repository:f.repository,files,maxUploadBytes:8192,uploadTtlMs:1000,now:()=>f.clock.now,newId:()=> 'parsing-late'})
    const body=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(createMinimalDocxBuffer('研究正文'));stream.close()}})
    const preparation=service.prepare({actorId:'owner',projectId:'project',fileName:'report.docx',body})
    const rejected=assert.rejects(preparation)
    await parsing
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    assert.deepEqual((await f.recovery.runBatch()).recovered,['parsing-late'])
    resume()
    await rejected
    assert.equal(f.database.prepare('SELECT status FROM report_uploads').get()?.status,'reclaimed')
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM report_submissions').get()?.n,0)
  } finally {resume?.();await f.dispose()}
})

test('recovery CLI dry-run lists candidates without writes, apply is bounded and repeated apply is harmless',{timeout:10000},async()=>{
  const f=await fixture()
  try {
    f.clock.now=new Date(Date.now()-2000)
    await f.ready('cli-expired')
    const environment={...process.env}
    delete environment.NODE_TEST_CONTEXT
    const args=['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('../scripts/recover-report-uploads.ts',import.meta.url)),'--database',f.databasePath,'--storage-root',f.storageRoot]
    const execute=promisify(execFile)
    const preview=await execute(process.execPath,args,{env:environment})
    assert.deepEqual((JSON.parse(preview.stdout) as {recoveryCandidates:string[]}).recoveryCandidates,['cli-expired'])
    assert.equal(f.database.prepare('SELECT status FROM report_uploads').get()?.status,'ready')
    assert.equal(await readFile(join(f.storageRoot,'cli-expired','cli-expired.docx'),'utf8'),'file')
    const applied=await execute(process.execPath,[...args,'--apply','--limit','1'],{env:environment})
    assert.deepEqual((JSON.parse(applied.stdout) as {recovered:string[]}).recovered,['cli-expired'])
    const repeated=await execute(process.execPath,[...args,'--apply'],{env:environment})
    assert.deepEqual((JSON.parse(repeated.stdout) as {recovered:string[]}).recovered,[])
    assert.equal(f.database.prepare('SELECT next_submission_sequence FROM project_report_state').get()?.next_submission_sequence,1)
  } finally {await f.dispose()}
})

test('indexed binary prefixes protect formal and tombstone reports independently of uploads',async()=>{
  const f=await fixture()
  try {
    let sequence=0
    const insertUpload=(id:string)=>f.database.prepare("INSERT INTO report_uploads(id,project_id,actor_id,file_name,status,reservation_id,reserved_bytes,created_at,expires_at) VALUES (?,'project','owner','report.docx','failed',?,8192,?,?)").run(id,'reservation-'+id,f.clock.now.toISOString(),new Date(f.clock.now.getTime()+1000).toISOString())
    for (const id of ['a%_', 'Case', '汉字', 'a[0]']) {
      insertUpload(id)
      const claimBeforeInsert=++sequence===1
      f.clock.now=new Date(f.clock.now.getTime()+2000)
      const claim=claimBeforeInsert ? f.recovery.claim() : undefined
      f.database.prepare("INSERT INTO report_submissions(id,project_id,stage_id,stage_version,submission_sequence,submitted_as,title,file_name,source_key,file_hash,source_size,paragraph_count,character_count,submitted_by,submitted_at,was_first_stage_submission) VALUES (?,'project','stage',?,?,'update','报告','report.docx',?,'hash',4,1,2,'owner',?,?)").run('report-'+id,sequence,sequence,id+'/report.docx',f.clock.now.toISOString(),sequence===1?1:0)
      f.database.prepare("INSERT INTO report_submission_documents(report_id,text,mime_type) VALUES (?,'正文','application/docx')").run('report-'+id)
      if (sequence%2===0) f.database.prepare("UPDATE report_submissions SET deleted_at=?,deleted_by='owner',deletion_reason='fixture' WHERE id=?").run(f.clock.now.toISOString(),'report-'+id)
      if(claim) assert.throws(()=>f.recovery.complete(claim),/租约/)
      assert.equal(f.recovery.claim(),undefined)
    }
    for (const id of ['aX_', 'case', '汉', 'a0']) insertUpload(id)
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    assert.deepEqual((await auditSubmissionStorage(f)).recoveryCandidates?.sort(), ['aX_', 'case', '汉', 'a0'].sort())
    assert.ok(f.recovery.claim())
    const sql="SELECT 1 FROM report_uploads u WHERE NOT EXISTS (SELECT 1 FROM report_submissions r WHERE r.source_key COLLATE BINARY >= u.id||'/' AND r.source_key COLLATE BINARY < u.id||'0')"
    const plan=f.database.prepare('EXPLAIN QUERY PLAN '+sql).all().map(row=>row.detail).join(' ')
    assert.match(plan,/SEARCH r USING COVERING INDEX idx_report_submissions_source_key/)
    assert.doesNotMatch(plan,/SCAN r\b/)
  } finally {await f.dispose()}
})

test('wrong root and offline storage never count as successful reclamation',async()=>{
  const f=await fixture()
  try {
    await f.ready('offline')
    f.clock.now=new Date(f.clock.now.getTime()+2000)
    const wrong=new ReportUploadRecovery({database:f.database,storageRoot:join(f.root,'wrong'),files:{async remove(){throw new Error('must not be called')}},now:()=>f.clock.now})
    assert.throws(()=>wrong.claim(),/does not match/)
    const claim=f.recovery.claim()!
    assert.throws(()=>wrong.retry(claim),/does not match/)
    assert.equal(f.database.prepare('SELECT recovery_error FROM report_uploads').get()?.recovery_error,null)
    f.clock.now=new Date(f.clock.now.getTime()+60001)
    await rm(f.storageRoot,{recursive:true,force:true})
    assert.deepEqual((await f.recovery.runBatch()).blocked,['offline'])
    assert.equal(f.database.prepare('SELECT state FROM storage_reservations').get()?.state,'active')
  } finally {await f.dispose()}
})
