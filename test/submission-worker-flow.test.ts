import assert from 'node:assert/strict'
import test,{type TestContext} from 'node:test'
import { mkdtemp,rm,readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'
import { installSubmissionTaskSchema } from '../lib/db/submission-task-schema'
import { seedInitialAiSettings } from '../lib/db/initial-ai-settings'
import { encryptSecret } from '../lib/db/settings-crypto'
import { createSubmissionProcessingRuntime } from '../lib/reports/submission-processing-runtime'
import { createMinimalDocxBuffer } from '../scripts/deployment-fixtures.mjs'
import { SubmissionWorker } from '../worker/submission-runtime'
import { runtimeConfig } from '../lib/config/environment'
import { validSubmissionAnalysis,submissionProviderResponse } from './helpers/submission-provider-fixtures'

async function setup(context:TestContext) {
  const root=await mkdtemp(join(tmpdir(),'native-worker-flow-'))
  const storageRoot=join(root,'sources')
  const database=createReportUploadTestDatabase(join(root,'new.sqlite'))
  const previousKey=process.env.YANXING_SETTINGS_ENCRYPTION_KEY
  process.env.YANXING_SETTINGS_ENCRYPTION_KEY='native-worker-explicit-key'
  context.after(async()=>{database.close();await rm(root,{recursive:true,force:true});if(previousKey===undefined)delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY;else process.env.YANXING_SETTINGS_ENCRYPTION_KEY=previousKey})
  seedInitialAiSettings(database)
  installSubmissionTaskSchema(database)
  database.exec("UPDATE projects SET description='研究背景与说明'")
  database.prepare('UPDATE ai_model_channels SET api_key_encrypted=?').run(encryptSecret('test-provider-only-not-a-real-key'))
  const diagnostics:string[]=[]
  const runtime=createSubmissionProcessingRuntime({database,storageRoot,resolveActorId:()=> 'owner',onWorkerError:code=>diagnostics.push(code)})
  runtime.repository.initializePlan({actorId:'owner',projectId:'project',stages:[{id:'first',title:'初始研究阶段',description:'形成完整研究成果',plannedEndAt:'2027-01-01'},{id:'last',title:'总结阶段',description:'总结研究成果',plannedEndAt:'2027-02-01'}]})
  let sequence=0
  async function submit(kind:'update'|'completion'='update') {
    const bytes=createMinimalDocxBuffer('投资方案研究。研究目标关注现金流与风险。通过访谈和定量分析形成证据，提出可执行的建议。')
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close()}})
    const prepared=await runtime.service.prepare({actorId:'owner',projectId:'project',fileName:'研究报告.docx',body,contentLength:bytes.length})
    const workflow=runtime.repository.loadWorkflow({actorId:'owner',projectId:'project'})
    const stageId=kind==='completion'?'last':'first'
    const stage=workflow.stages.find(item=>item.id===stageId)!
    return (await runtime.service.confirm({actorId:'owner',projectId:'project',idempotencyKey:'real_worker_submit_'+(++sequence),command:{uploadId:prepared.id,stageId,reportKind:kind,expectedPlanRevision:workflow.planRevision,expectedWorkflowRevision:workflow.workflowRevision,expectedCompletionRevision:stage.completionRevision,expectedCompletionReportId:stage.currentCompletionReportId??null}})).receipt
  }
  return {root,storageRoot,database,runtime,diagnostics,submit}
}

test('real DOCX -> outbox -> frozen full provider pipeline -> independent insight histories without legacy writes',{timeout:20000},async context=>{
  const f=await setup(context)
  const requests:Array<{model:string;messages:unknown}>=[]
  let insight=false
  context.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit)=>{
    const request=JSON.parse(String(options.body)) as {model:string;messages:unknown}
    requests.push(request)
    return submissionProviderResponse(insight?'<article><h1>研究洞察</h1><blockquote>证据支持结论。</blockquote><h2 id="risk">风险建议</h2><p>开展压力测试。</p></article>':JSON.stringify(validSubmissionAnalysis()))
  })
  const report=await f.submit()
  assert.deepEqual(f.runtime.worker.dispatch(),{delivered:1,deferred:0,dismissed:0})
  const job=f.runtime.tasks.latestTask(report.reportId,'analysis')!
  const frozen=f.runtime.tasks.getFrozen(job.id)
  f.database.prepare('UPDATE ai_model_profiles SET model_name=? WHERE id=?').run('changed-after-admission',frozen.modelRuntime.modelId)
  f.runtime.repository.editPlan({actorId:'owner',projectId:'project',edit:{expectedPlanRevision:0,nextStages:[{id:'first',title:'修改后的阶段',description:'修改后的目标',plannedEndAt:'2027-01-01'},{id:'last',title:'总结阶段',description:'总结研究成果',plannedEndAt:'2027-02-01'}]}})
  const before=f.runtime.repository.loadWorkflow({actorId:'owner',projectId:'project'})
  await f.runtime.worker.runOnce()
  assert.equal(f.runtime.tasks.getTask(job.id)?.status,'completed',JSON.stringify(f.diagnostics))
  assert.equal(requests.length,1)
  assert.equal(requests[0].model,frozen.modelRuntime.modelName)
  assert.match(JSON.stringify(requests[0].messages),/初始研究阶段/)
  assert.equal(f.runtime.tasks.callLedger(job.id).completed,1)
  assert.ok(f.runtime.tasks.getReport(report.reportId)?.firstAnalysisSucceededAt)
  assert.equal(f.runtime.tasks.getReport(report.reportId)?.firstInsightSucceededAt,undefined)
  assert.deepEqual(f.runtime.repository.loadWorkflow({actorId:'owner',projectId:'project'}),before)
  const source=f.runtime.tasks.getReport(report.reportId)!.sourceKey
  assert.deepEqual(await readdir(join(f.storageRoot,source.split('/')[0])),[source.split('/')[1]])
  insight=true
  f.runtime.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'insight'})
  await f.runtime.worker.runOnce()
  assert.ok(f.runtime.tasks.getReport(report.reportId)?.firstInsightSucceededAt)
  f.runtime.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'insight'})
  await f.runtime.worker.runOnce()
  assert.equal(f.runtime.tasks.listResults(report.reportId,'insight').length,2)
  assert.equal(requests.length,3)
  assert.equal(f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='analysis_jobs'").get(),undefined)
  assert.equal(f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='report_versions'").get(),undefined)
  assert.equal(f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='report_insights'").get(),undefined)
  assert.doesNotMatch(JSON.stringify(f.runtime.queries.detail('editor',report.reportId)),/apiKeyEncrypted|test-provider-only|leaseToken|sourceKey/)
})

test('provider output retry checkpoints failed-call completion before complete quality-gated publication',{timeout:20000},async context=>{
  const f=await setup(context)
  let calls=0
  context.mock.method(globalThis,'fetch',async()=>submissionProviderResponse(++calls===1?'{}':JSON.stringify(validSubmissionAnalysis(75))))
  const report=await f.submit()
  await f.runtime.worker.runOnce()
  const job=f.runtime.tasks.latestTask(report.reportId,'analysis')!
  assert.equal(job.status,'completed',JSON.stringify(f.diagnostics))
  assert.equal(calls,2)
  assert.equal(f.runtime.tasks.callLedger(job.id).completed,2)
  assert.equal(f.runtime.tasks.listData(job.id,'artifact:').length,2)
  assert.equal(f.runtime.tasks.listResults(report.reportId,'analysis').length,1)
})

test('dispatch needs no usage quota and cannot undo a completed project',{timeout:20000},async context=>{
  const f=await setup(context)
  let calls=0
  context.mock.method(globalThis,'fetch',async()=>{calls++;return submissionProviderResponse(JSON.stringify(validSubmissionAnalysis()))})
  const report=await f.submit('completion')
  const completed=f.runtime.repository.loadWorkflow({actorId:'owner',projectId:'project'})
  assert.ok(completed.completedAt)
  await f.runtime.worker.runOnce()
  assert.equal(calls,1)
  assert.equal(f.runtime.tasks.latestTask(report.reportId,'analysis')?.status,'completed',JSON.stringify(f.diagnostics))
  assert.deepEqual(f.runtime.repository.loadWorkflow({actorId:'owner',projectId:'project'}),completed)
})

test('cancellation during actual provider call records completed calls but never publishes late success',{timeout:20000},async context=>{
  const f=await setup(context)
  let started!:()=>void,respond!:()=>void
  const requestStarted=new Promise<void>(resolve=>{started=resolve})
  const responseReady=new Promise<void>(resolve=>{respond=resolve})
  context.mock.method(globalThis,'fetch',async()=>{started();await responseReady;return submissionProviderResponse(JSON.stringify(validSubmissionAnalysis()))})
  const report=await f.submit()
  const running=f.runtime.worker.runOnce()
  try {
    await requestStarted
    const job=f.runtime.tasks.latestTask(report.reportId,'analysis')!
    assert.equal(f.runtime.tasks.callLedger(job.id).started,1)
    f.runtime.tasks.cancel({actorId:'owner',jobId:job.id})
    assert.throws(()=>f.runtime.tasks.deleteReport({actorId:'owner',reportId:report.reportId,reason:'撤回'}),/REPORT_PROCESSING/)
    respond()
    await running
    assert.equal(f.runtime.tasks.getTask(job.id)?.status,'cancelled',JSON.stringify(f.diagnostics))
    assert.equal(f.runtime.tasks.callLedger(job.id).completed,1)
    assert.equal(f.runtime.tasks.getReport(report.reportId)?.firstAnalysisSucceededAt,undefined)
    assert.equal(f.runtime.tasks.listResults(report.reportId,'analysis').length,0)
  } finally {respond();await running}
})

test('due maintenance drains running tasks without starving heartbeat or refilling slots',{timeout:10000},async context=>{
  const f=await setup(context)
  const previousLease=process.env.YANXING_WORKER_LEASE_MS,previousPoll=process.env.YANXING_WORKER_POLL_MS
  process.env.YANXING_WORKER_LEASE_MS='4000'
  process.env.YANXING_WORKER_POLL_MS='100'
  context.after(()=>{
    if(previousLease===undefined) delete process.env.YANXING_WORKER_LEASE_MS;else process.env.YANXING_WORKER_LEASE_MS=previousLease
    if(previousPoll===undefined) delete process.env.YANXING_WORKER_POLL_MS;else process.env.YANXING_WORKER_POLL_MS=previousPoll
  })
  let started!:()=>void,respond!:()=>void,finished!:()=>void
  const requestStarted=new Promise<void>(resolve=>{started=resolve})
  const responseReady=new Promise<void>(resolve=>{respond=resolve})
  const maintained=new Promise<void>(resolve=>{finished=resolve})
  const controller=new AbortController()
  let active=false,maintenanceCount=0,renewals=0,now=Date.now()
  context.mock.method(Date,'now',()=>now)
  context.mock.method(globalThis,'fetch',async()=>{active=true;started();await responseReady;active=false;return submissionProviderResponse(JSON.stringify(validSubmissionAnalysis()))})
  const originalRenew=f.runtime.tasks.renew.bind(f.runtime.tasks)
  context.mock.method(f.runtime.tasks,'renew',(claim:Parameters<typeof originalRenew>[0])=>{renewals++;return originalRenew(claim)})
  const worker=new SubmissionWorker({tasks:f.runtime.tasks,outbox:f.runtime.outbox,recovery:f.runtime.recovery,maintainStorage:async()=>{
    assert.equal(active,false)
    if(++maintenanceCount===2){controller.abort();finished()}
  }})
  await f.submit()
  const running=worker.run(controller.signal)
  try {
    await requestStarted
    now+=Math.max(runtimeConfig.storage.maintenanceIntervalMs,60_000)+1
    await new Promise(resolve=>setTimeout(resolve,1250))
    assert.equal(maintenanceCount,1)
    assert.ok(renewals>=1,'active task heartbeat must keep renewing during drain')
    respond()
    await maintained
    await running
    assert.equal(maintenanceCount,2)
  } finally {respond();controller.abort();await running}
})

