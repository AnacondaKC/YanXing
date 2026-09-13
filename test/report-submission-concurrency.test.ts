import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'
import { ReportSubmissionRepository } from '../lib/db/report-submission-repository'
import { createSubmissionStorageQuota } from '../lib/storage/submission-quota'
import type { ReportSubmissionConfirmation, ReportSubmissionReceipt } from '../modules/reports/upload-domain'

type Outcome = {ok:true;result:{receipt:ReportSubmissionReceipt;replayed:boolean}} | {ok:false;code:string}

function launch(databasePath:string, command:ReportSubmissionConfirmation) {
  const environment={...process.env}
  delete environment.NODE_TEST_CONTEXT
  const child=fork(fileURLToPath(new URL('./helpers/confirm-submission-process.ts',import.meta.url)),[databasePath,JSON.stringify(command)],{
    execArgv:['--import',import.meta.resolve('tsx')],env:environment,stdio:['ignore','ignore','inherit','ipc'],
  })
  const ready=new Promise<void>((resolve,reject)=>{
    child.once('error',reject)
    child.once('message',()=>resolve())
    child.once('exit',(code)=>{if(code!==0)reject(new Error('Confirmation process exited '+code))})
  })
  const result=ready.then(()=>new Promise<Outcome>((resolve,reject)=>{
    child.once('message',(message)=>resolve(message as Outcome))
    child.once('exit',(code)=>{if(code!==0)reject(new Error('Confirmation process exited '+code))})
  }))
  void result.catch(()=>undefined)
  return {child,ready,result}
}

for (const scenario of ['same-request','competing-completions'] as const) {
  test('separate processes race '+scenario+' without duplicate allocation or silent completion overwrite',{timeout:20000},async(context)=>{
    const root=await mkdtemp(join(tmpdir(),'yanxing-confirm-race-'))
    const databasePath=join(root,'fresh.sqlite')
    const database=createReportUploadTestDatabase(databasePath)
    const children:ReturnType<typeof launch>[]=[]
    try {
      const repository=new ReportSubmissionRepository({database,quota:createSubmissionStorageQuota({storageRoot:'/unused-process-test-root'})})
      repository.initializePlan({actorId:'owner',projectId:'project',stages:[{id:'stage',title:'阶段成果'}]})
      function readyUpload(id:string):ReportSubmissionConfirmation {
        const identity={actorId:'owner',projectId:'project',uploadId:id}
        repository.beginUpload({...identity,fileName:'report.docx',reservedBytes:100,expiresAt:new Date(Date.now()+60000).toISOString()})
        repository.markParsing(identity)
        repository.markReady({...identity,file:{sourceKey:id+'/report.docx',fileName:'report.docx',mimeType:'application/docx',fileHash:'a'.repeat(64),sourceSize:4,title:'报告',text:'研究报告',paragraphCount:1,characterCount:4}})
        return {actorId:'owner',projectId:'project',idempotencyKey:'confirmation_key_'+id,command:{uploadId:id,stageId:'stage',reportKind:'completion',expectedPlanRevision:0,expectedWorkflowRevision:0,expectedCompletionRevision:0,expectedCompletionReportId:null}}
      }
      const first=readyUpload('upload1')
      const second=scenario==='same-request'?first:readyUpload('upload2')
      children.push(launch(databasePath,first),launch(databasePath,second))
      context.after(()=>{for(const worker of children)worker.child.kill()})
      await Promise.all(children.map(worker=>worker.ready))
      for(const worker of children)worker.child.send('confirm')
      const outcomes=await Promise.all(children.map(worker=>worker.result))
      if(scenario==='same-request') {
        assert.ok(outcomes[0].ok && outcomes[1].ok)
        assert.deepEqual(outcomes[0].result.receipt,outcomes[1].result.receipt)
        assert.deepEqual(outcomes.map(outcome=>outcome.ok && outcome.result.replayed).sort(),[false,true])
      } else {
        assert.equal(outcomes.filter(outcome=>outcome.ok).length,1)
        assert.equal(outcomes.find(outcome=>!outcome.ok)?.code,'STAGE_COMPLETION_CHANGED')
      }
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submissions').get()?.n,1)
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submission_outbox').get()?.n,1)
      assert.equal(database.prepare('SELECT next_submission_sequence FROM project_report_state').get()?.next_submission_sequence,2)
      assert.equal(database.prepare('SELECT next_report_version FROM project_stages').get()?.next_report_version,2)
    } finally {
      for(const worker of children)worker.child.kill()
      database.close()
      await rm(root,{recursive:true,force:true})
    }
  })
}
