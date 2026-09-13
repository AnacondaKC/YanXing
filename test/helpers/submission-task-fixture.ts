import { createReportUploadTestDatabase } from './report-upload-database'
import { installSubmissionTaskSchema } from '../../lib/db/submission-task-schema'
import { ReportSubmissionRepository } from '../../lib/db/report-submission-repository'
import { SubmissionTaskRepository } from '../../lib/db/submission-task-repository'
import { createSubmissionStorageQuota } from '../../lib/storage/submission-quota'
import { getDefaultAiPromptConfig } from '../../lib/ai/prompt-defaults'
import type { SubmissionTaskSnapshot, SubmissionTaskClaim } from '../../modules/reports/submission-task-domain'
import type { ReportOperation } from '../../modules/reports/submission-domain'

export function testAnalysisResult(overall:number) {return {kind:'analysis',snapshot:{payload:{aiScore:{overall}}}}}

export function testTaskSnapshot(operation: ReportOperation): SubmissionTaskSnapshot {
  const target=operation==='analysis'?'page_analysis':'report_insight'
  return {prompts:[getDefaultAiPromptConfig(target)],
    evaluationContext:{projectId:'project',projectTitle:'课题',researchObjective:'目标',researchBackground:'背景',milestone:{id:'stage-a',title:'阶段',targetDate:'2027-01-01',workAndExpectedOutcomes:'研究成果'}},
    modelRuntime:{target,channelId:'channel',channelName:'test',channel:'chat_completions',baseUrl:'https://example.test/v1',modelId:'model',modelName:'test-model',maxContextCharacters:100000,maxOutputTokens:16000,reasoningEffort:'medium',apiKeyEncrypted:null,settingsRevision:1},
  }
}
export function createTaskFixture(input:{path?:string;storageRoot?:string}={}) {
  const database=createReportUploadTestDatabase(input.path)
  installSubmissionTaskSchema(database)
  const storageRoot=input.storageRoot??'/unused-submission-task-fixture'
  const clock={offset:0}
  const now=()=>new Date(Date.now()+clock.offset)
  database.exec("UPDATE projects SET description='研究背景'")
  const reports=new ReportSubmissionRepository({database,quota:createSubmissionStorageQuota({storageRoot}),now})
  reports.initializePlan({actorId:'owner',projectId:'project',stages:[{id:'stage-a',title:'阶段一',description:'研究',plannedEndAt:'2027-01-01'},{id:'stage-b',title:'阶段二',description:'成果',plannedEndAt:'2027-02-01'}]})
  const tasks=new SubmissionTaskRepository({database,storageRoot,now,freeze:({operation})=>testTaskSnapshot(operation)})
  let count=0
  function submit(input:{kind?:'update'|'completion';stageId?:string}={}) {
    const id='prepared-'+(++count)
    reports.beginUpload({actorId:'owner',projectId:'project',uploadId:id,fileName:'report.docx',reservedBytes:1000,expiresAt:new Date(now().getTime()+600000).toISOString()})
    reports.markParsing({actorId:'owner',projectId:'project',uploadId:id})
    reports.markReady({actorId:'owner',projectId:'project',uploadId:id,file:{sourceKey:id+'/'+id+'.docx',fileName:'report.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',sourceSize:100,fileHash:'a'.repeat(64),title:'报告',text:'研究正文',paragraphCount:1,characterCount:4}})
    const workflow=reports.loadWorkflow({actorId:'owner',projectId:'project'})
    const stageId=input.stageId??'stage-a'
    const stage=workflow.stages.find(item=>item.id===stageId)!
    return reports.confirmSubmission({actorId:'owner',projectId:'project',idempotencyKey:'submit_request_key_'+count,command:{uploadId:id,stageId,reportKind:input.kind??'update',expectedPlanRevision:workflow.planRevision,expectedWorkflowRevision:workflow.workflowRevision,expectedCompletionRevision:stage.completionRevision,expectedCompletionReportId:stage.currentCompletionReportId??null}}).receipt
  }
  function checkpoint(claim:SubmissionTaskClaim) {
    tasks.beginCall(claim,{attempt:1,provider:'chat_completions',model:'test-model'})
    tasks.checkpoint(claim,{attempt:1,provider:'chat_completions',model:'test-model',data:[{key:'fixture-checkpoint',value:{accepted:true}}]})
  }
  return {database,storageRoot,clock,now,reports,tasks,submit,checkpoint}
}
