import {randomUUID} from 'node:crypto'
import type {DatabaseSync} from 'node:sqlite'
import {createSubmissionProcessingRuntime} from '../../lib/reports/submission-processing-runtime'
import {SubmissionWorkspaceRepository} from '../../lib/db/submission-workspace-repository'
import {getReportStorageRoot} from '../../lib/storage/runtime-roots'

export function nativeWorkspace(database:DatabaseSync) {
  const runtime=createSubmissionProcessingRuntime({database,storageRoot:getReportStorageRoot(),resolveActorId:()=>undefined})
  return {runtime,workspace:new SubmissionWorkspaceRepository({database,tasks:runtime.tasks,queries:runtime.queries,reports:runtime.repository})}
}

export function createNativeProject(input:{database:DatabaseSync;ownerId:string;actorId?:string;title?:string;collaboratorIds?:string[];objective?:string;description?:string}) {
  const title=input.title??'原生测试课题'
  const {runtime}=nativeWorkspace(input.database)
  const workflow=runtime.repository.createProject({actorId:input.actorId??input.ownerId,project:{title,ownerId:input.ownerId,collaboratorIds:input.collaboratorIds,objective:input.objective??'测试研究目标',description:input.description??'测试研究背景',stages:[{id:randomUUID(),title:'研究阶段',description:'研究阶段目标',plannedEndAt:'2030-12-31'}]}})
  const row=input.database.prepare('SELECT updated_at FROM projects WHERE id=?').get(workflow.projectId)!
  return {id:workflow.projectId,title,updatedAt:String(row.updated_at),workflow}
}

export function submitNativeReport(input:{database:DatabaseSync;actorId:string;projectId:string;kind?:'update'|'completion';stageId?:string}) {
  const {runtime,workspace}=nativeWorkspace(input.database)
  const workflow=runtime.repository.loadWorkflow({actorId:input.actorId,projectId:input.projectId})
  const stageId=input.stageId??workflow.stages.find((stage)=>stage.lifecycleStatus==='in_progress')?.id??workflow.stages[0]?.id
  if (!stageId) throw new Error('native project has no stage')
  const stage=workflow.stages.find((item)=>item.id===stageId)!
  const uploadId=randomUUID()
  const text='这是一份完整研究报告。'
  const file={sourceKey:uploadId+'/report.docx',fileName:'report.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',fileHash:(uploadId.replace(/-/g,'')+'a'.repeat(64)).slice(0,64),sourceSize:text.length,title:'研究报告',text,paragraphCount:1,characterCount:text.length}
  runtime.repository.beginUpload({actorId:input.actorId,projectId:input.projectId,uploadId,fileName:file.fileName,reservedBytes:1024,expiresAt:new Date(Date.now()+60_000).toISOString()})
  runtime.repository.markParsing({actorId:input.actorId,projectId:input.projectId,uploadId})
  runtime.repository.markReady({actorId:input.actorId,projectId:input.projectId,uploadId,file})
  const confirmed=runtime.repository.confirmSubmission({actorId:input.actorId,projectId:input.projectId,idempotencyKey:('submit_native_'+uploadId.replace(/-/g,'')).slice(0,128),command:{uploadId,stageId,reportKind:input.kind??'update',expectedPlanRevision:workflow.planRevision,expectedWorkflowRevision:workflow.workflowRevision,expectedCompletionRevision:stage.completionRevision,expectedCompletionReportId:stage.currentCompletionReportId??null}})
  return {receipt:confirmed.receipt,reportId:confirmed.receipt.reportId,runtime,workspace,stageId}
}
