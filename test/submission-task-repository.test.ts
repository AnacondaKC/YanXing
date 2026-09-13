import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTaskFixture,testTaskSnapshot,testAnalysisResult } from './helpers/submission-task-fixture'
import { SubmissionTaskRepository } from '../lib/db/submission-task-repository'
import { ReportSubmissionOutbox } from '../lib/db/report-submission-outbox'
import { SubmissionQueryRepository } from '../lib/db/submission-query-repository'
import { createSubmissionWorkspaceHandlers } from '../lib/http/submission-workspace-handlers'
import { SubmissionWorkspaceRepository } from '../lib/db/submission-workspace-repository'

test('native tasks enforce owner/admin writes, active reuse, and separate analysis/insight slots',()=>{
  const f=createTaskFixture()
  try {
    const report=f.submit()
    assert.throws(()=>f.tasks.admit({actorId:'editor',reportId:report.reportId,operation:'analysis'}),/REPORT_WRITE_FORBIDDEN/)
    const first=f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'})
    assert.equal(f.tasks.admit({actorId:'admin',reportId:report.reportId,operation:'analysis'}).task.id,first.task.id)
    assert.equal(f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'insight'}).reused,false)
    assert.equal(f.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_jobs'").get(), undefined)
  } finally {f.database.close()}
})

test('success flags/results/task/audit publish atomically and survive failed reruns',()=>{
  const f=createTaskFixture()
  try {
    const report=f.submit({kind:'completion'})
    const before=f.reports.loadWorkflow({actorId:'owner',projectId:'project'})
    const job=f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'}).task
    const claim=f.tasks.claim()!
    f.checkpoint(claim)
    f.database.exec("CREATE TEMP TRIGGER reject_success BEFORE INSERT ON submission_task_events WHEN NEW.kind='succeeded' BEGIN SELECT RAISE(ABORT,'audit fault'); END")
    assert.throws(()=>f.tasks.complete(claim,testAnalysisResult(80)),/audit fault/)
    assert.equal(f.tasks.getReport(report.reportId)?.firstAnalysisSucceededAt,undefined)
    assert.equal(f.tasks.getTask(job.id)?.status,'running')
    assert.equal(f.tasks.listResults(report.reportId,'analysis').length,0)
    f.database.exec('DROP TRIGGER reject_success')
    const result=f.tasks.complete(claim,testAnalysisResult(80))
    const succeeded=f.tasks.getReport(report.reportId)!.firstAnalysisSucceededAt
    assert.ok(succeeded)
    f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'})
    f.tasks.fail(f.tasks.claim()!,'SOURCE_UNAVAILABLE')
    assert.equal(f.tasks.getReport(report.reportId)?.firstAnalysisSucceededAt,succeeded)
    assert.equal(f.tasks.listResults(report.reportId,'analysis')[0].id,result.id)
    assert.equal(f.tasks.getReport(report.reportId)?.firstInsightSucceededAt,undefined)
    assert.deepEqual(f.reports.loadWorkflow({actorId:'owner',projectId:'project'}),before)
  } finally {f.database.close()}
})

test('historical first attempts and retries are allowed independently; admitted rerun continues after becoming historical',()=>{
  const f=createTaskFixture()
  try {
    const old=f.submit()
    f.tasks.admit({actorId:'owner',reportId:old.reportId,operation:'analysis'})
    let claim=f.tasks.claim()!
    f.checkpoint(claim);f.tasks.complete(claim,testAnalysisResult(60))
    f.tasks.admit({actorId:'owner',reportId:old.reportId,operation:'analysis'})
    f.submit()
    claim=f.tasks.claim()!
    f.checkpoint(claim);f.tasks.complete(claim,testAnalysisResult(70))
    assert.equal(f.tasks.listResults(old.reportId,'analysis').length,2)
    assert.throws(()=>f.tasks.admit({actorId:'owner',reportId:old.reportId,operation:'analysis'}),/HISTORICAL_OPERATION_ALREADY_SUCCEEDED/)
    const insight=f.tasks.admit({actorId:'owner',reportId:old.reportId,operation:'insight'}).task
    f.tasks.fail(f.tasks.claim()!,'GATE_FAILED')
    assert.equal(f.tasks.retry({actorId:'owner',jobId:insight.id}).reused,false)
    claim=f.tasks.claim()!;f.checkpoint(claim);f.tasks.complete(claim,{html:'validated fixture'})
    assert.throws(()=>f.tasks.admit({actorId:'owner',reportId:old.reportId,operation:'insight'}),/HISTORICAL_OPERATION_ALREADY_SUCCEEDED/)
  } finally {f.database.close()}
})

test('outbox admission and ack roll back together; failure never undoes stage completion',()=>{
  const f=createTaskFixture()
  try {
    const report=f.submit({kind:'completion'})
    const outbox=new ReportSubmissionOutbox({database:f.database,leaseMs:30000})
    const event=outbox.claim()!
    assert.equal(f.tasks.getReport(report.reportId)?.submittedAs,'completion')
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM submission_tasks').get()?.n,0)
    f.database.exec("CREATE TEMP TRIGGER reject_ack BEFORE UPDATE ON report_submission_outbox WHEN NEW.status='delivered' BEGIN SELECT RAISE(ABORT,'ack failed'); END")
    assert.throws(()=>outbox.deliver({eventId:event.id,leaseToken:event.leaseToken,enqueue:(e,db)=>f.tasks.admitFromOutbox(e,db)}),/ack failed/)
    f.database.exec('DROP TRIGGER reject_ack')
    const id=outbox.deliver({eventId:event.id,leaseToken:event.leaseToken,enqueue:(e,db)=>f.tasks.admitFromOutbox(e,db)})
    assert.equal(f.tasks.getTask(id)?.reportId,report.reportId)
  } finally {f.database.close()}
})

test('running cancellation waits for acknowledgment; late completion cannot publish or overwrite terminal state',()=>{
  const f=createTaskFixture()
  try {
    const report=f.submit()
    const job=f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'}).task
    const claim=f.tasks.claim()!
    f.tasks.beginCall(claim,{attempt:1,provider:'chat_completions',model:'test-model'})
    assert.equal(f.tasks.cancel({actorId:'owner',jobId:job.id}).status,'running')
    assert.throws(()=>f.tasks.deleteReport({actorId:'owner',reportId:report.reportId,reason:'撤回'}),/REPORT_PROCESSING/)
    f.tasks.interrupt(claim)
    f.tasks.deleteReport({actorId:'owner',reportId:report.reportId,reason:'撤回'})
    f.tasks.settleLateCall(claim,{attempt:1,provider:'chat_completions',model:'test-model'})
    assert.equal(f.tasks.getTask(job.id)?.status,'cancelled')
    assert.throws(()=>f.tasks.complete(claim,{}),/TASK_LEASE_LOST/)
    assert.equal(f.tasks.getReport(report.reportId)?.firstAnalysisSucceededAt,undefined)
  } finally {f.database.close()}
})

test('expired provider call fails safely but allows a new task generation',()=>{
  const f=createTaskFixture()
  try {
    const report=f.submit()
    const job=f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'}).task
    const claim=f.tasks.claim(1000)!
    f.tasks.beginCall(claim,{attempt:1,provider:'chat_completions',model:'test-model'})
    f.clock.offset+=1001
    assert.equal(f.tasks.claim(),undefined)
    assert.equal(f.tasks.getTask(job.id)?.errorCode,'AI_CALL_INCOMPLETE')
    const retry=f.tasks.retry({actorId:'owner',jobId:job.id}).task
    assert.equal(retry.generation,2)
    const retryClaim=f.tasks.claim()!
    assert.equal(retryClaim.jobId,retry.id)
    f.checkpoint(retryClaim)
    f.tasks.complete(retryClaim,testAnalysisResult(85))
    assert.equal(f.tasks.getTask(retry.id)?.status,'completed')
    assert.throws(()=>f.tasks.checkpoint(claim,{attempt:1,provider:'chat_completions',model:'test-model'}),/TASK_LEASE_LOST/)
    f.tasks.settleLateCall(claim,{attempt:1,provider:'chat_completions',model:'test-model'})
    assert.equal(f.tasks.listResults(report.reportId,'analysis')[0].jobId,retry.id)
    assert.equal(f.tasks.getTask(job.id)?.status,'failed')
  } finally {f.database.close()}
})

test('restart and separate connections preserve checkpoints and fence expired owners',async()=>{
  const root=await mkdtemp(join(tmpdir(),'submission-task-restart-'))
  const path=join(root,'new.sqlite')
  const f=createTaskFixture({path})
  let reopened:DatabaseSync|undefined
  try {
    const report=f.submit()
    const job=f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'}).task
    const old=f.tasks.claim(1000)!
    f.checkpoint(old)
    f.database.close()
    reopened=new DatabaseSync(path);reopened.exec('PRAGMA foreign_keys=ON')
    const tasks=new SubmissionTaskRepository({database:reopened,storageRoot:f.storageRoot,now:f.now,freeze:({operation})=>testTaskSnapshot(operation)})
    f.clock.offset+=1001
    assert.equal(tasks.claim(),undefined)
    f.clock.offset+=5001
    const next=tasks.claim()!
    assert.equal(next.jobId,job.id)
    assert.notEqual(next.leaseToken,old.leaseToken)
    assert.deepEqual(tasks.readData(job.id,'fixture-checkpoint'),{accepted:true})
    assert.throws(()=>tasks.complete(old,{}),/TASK_LEASE_LOST/)
    assert.throws(()=>tasks.beginCall(next,{attempt:1,provider:'chat_completions',model:'test-model'}),/AI_CALL_ALREADY_RECORDED/)
    tasks.complete(next,testAnalysisResult(85))
  } finally {reopened?.close();try{f.database.close()}catch{}await rm(root,{recursive:true,force:true})}
})

test('comparison uses current predecessor success, skips deleted not unscored, and permanently suppresses first stage submission',()=>{
  const f=createTaskFixture()
  try {
    const first=f.submit()
    f.tasks.admit({actorId:'owner',reportId:first.reportId,operation:'analysis'})
    let claim=f.tasks.claim()!;f.checkpoint(claim);f.tasks.complete(claim,testAnalysisResult(60))
    const middle=f.submit()
    const current=f.submit()
    f.tasks.admit({actorId:'owner',reportId:current.reportId,operation:'analysis'})
    claim=f.tasks.claim()!;f.checkpoint(claim);f.tasks.complete(claim,testAnalysisResult(80))
    const queries=new SubmissionQueryRepository({database:f.database,tasks:f.tasks})
    let comparison=queries.detail('owner',current.reportId).comparison
    assert.equal(comparison.status,'available')
    if(comparison.status==='available'){assert.equal(comparison.baselineReportId,middle.reportId);assert.equal(comparison.scoreDelta,undefined)}
    f.tasks.deleteReport({actorId:'owner',reportId:middle.reportId,reason:'撤回'})
    comparison=queries.detail('owner',current.reportId).comparison
    if(comparison.status==='available'){assert.equal(comparison.baselineReportId,first.reportId);assert.equal(comparison.scoreDelta,20)}
    assert.deepEqual(queries.detail('owner',first.reportId).comparison,{status:'unavailable',reason:'first_stage_submission'})
  } finally {f.database.close()}
})

test('task handlers use trusted identities and expose no frozen secrets or storage keys',async()=>{
  const f=createTaskFixture()
  try {
    const report=f.submit()
    const queries=new SubmissionQueryRepository({database:f.database,tasks:f.tasks})
    type HandlerInput = Parameters<typeof createSubmissionWorkspaceHandlers>[0]
    const handlers = createSubmissionWorkspaceHandlers({
      processing: { tasks: f.tasks } as HandlerInput['processing'],
      workspace: new SubmissionWorkspaceRepository({ ...f, queries }),
      getCurrentUser: request => {
        const id = request.headers.get('x-test-actor')
        return id ? { id } as ReturnType<HandlerInput['getCurrentUser']> : undefined
      },
    })
    const request=(actor:string)=>new Request('http://test/task',{method:'POST',headers:{'x-test-actor':actor}})
    assert.equal((await handlers.startAnalysis(request(''),report.reportId)).status,401)
    assert.equal((await handlers.startAnalysis(request('editor'),report.reportId)).status,403)
    const response=await handlers.startAnalysis(request('owner'),report.reportId)
    assert.equal(response.status,202)
    const detail=await (await handlers.getReport(request('editor'),report.reportId)).text()
    assert.doesNotMatch(detail,/apiKeyEncrypted|frozen_json|sourceKey|leaseToken|example.test/)
    assert.equal(JSON.parse(detail).capabilities.analysisAction, 'none')
  } finally {f.database.close()}
})

test('lease renewal is a conditional monotonic write and cannot revive expired or cancelled claims',()=>{
  const f=createTaskFixture()
  try {
    const report=f.submit()
    const job=f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'}).task
    const claim=f.tasks.claim(1000)!
    const lease=f.database.prepare('SELECT lease_until FROM submission_tasks').get()?.lease_until
    assert.equal(f.tasks.renew(claim,100),true)
    assert.equal(f.database.prepare('SELECT lease_until FROM submission_tasks').get()?.lease_until,lease)
    assert.equal(f.tasks.renew({...claim,leaseToken:'stale'}),false)
    f.clock.offset+=1001
    assert.equal(f.tasks.renew(claim),false)
    assert.equal(f.database.prepare('SELECT lease_until FROM submission_tasks').get()?.lease_until,lease)
    f.tasks.cancel({actorId:'owner',jobId:job.id})
    assert.equal(f.tasks.renew(claim),false)
  } finally {f.database.close()}
})


test('call insertion cannot fabricate completed calls; deleted outbox reports are dismissed without a task',()=>{
  const f=createTaskFixture()
  try {
    const report=f.submit()
    const job=f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'}).task
    const claim=f.tasks.claim()!
    assert.throws(()=>f.database.prepare("INSERT INTO submission_task_calls(job_id,attempt,provider,model,lease_token,state,started_at,completed_at) VALUES (?,1,'chat_completions','test-model',?,'completed',?,?)").run(job.id,claim.leaseToken,f.now().toISOString(),f.now().toISOString()),/call_must_start_without_receipt/)
    f.tasks.cancel({actorId:'owner',jobId:job.id});f.tasks.interrupt(claim)
    const outbox=new ReportSubmissionOutbox({database:f.database,leaseMs:30000})
    const event=outbox.claim()!
    assert.throws(()=>outbox.dismissDeletedReport({eventId:event.id,leaseToken:event.leaseToken}),/logically deleted/)
    f.tasks.deleteReport({actorId:'owner',reportId:report.reportId,reason:'撤回'})
    outbox.dismissDeletedReport({eventId:event.id,leaseToken:event.leaseToken})
    assert.equal(f.database.prepare('SELECT last_error FROM report_submission_outbox').get()?.last_error,'REPORT_DELETED')
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM submission_tasks').get()?.n,1)
  } finally {f.database.close()}
})

