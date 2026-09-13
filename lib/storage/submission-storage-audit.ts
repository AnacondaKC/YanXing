import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { createPreparedReportFiles } from '@/lib/documents/prepared-report-files'
import { createUploadRecoveryFiles } from '@/lib/documents/upload-recovery-files'

export async function auditSubmissionStorage(input:{database:DatabaseSync;storageRoot:string}) {
  const db=input.database
  const issues:Array<{id:string;code:string}>=[]
  const bound=db.prepare('SELECT path FROM submission_storage_root WHERE id=1').get()?.path
  if(bound && bound!==resolve(input.storageRoot)) return {issues:[{id:'storage',code:'STORAGE_ROOT_MISMATCH'}]}
  const uploads=db.prepare('SELECT id,status,reservation_id,source_key,source_size,file_hash,recovery_error FROM report_uploads').all()
  const statuses=new Map(uploads.map(row=>[String(row.id),String(row.status)]))
  const hasReports=Boolean(db.prepare('SELECT 1 FROM report_submissions LIMIT 1').get())
  if(!bound && (uploads.length || hasReports)) return {issues:[{id:'storage',code:'STORAGE_ROOT_UNBOUND'}]}
  const verifier=createPreparedReportFiles({storageRoot:input.storageRoot})
  for(const upload of uploads) {
    if(upload.recovery_error) issues.push({id:String(upload.id),code:String(upload.recovery_error)})
    const state=db.prepare('SELECT state FROM storage_reservations WHERE id=?').get(String(upload.reservation_id))?.state
    if(upload.status==='committed' && state!=='consumed') issues.push({id:String(upload.id),code:'RESERVATION_CONSUMPTION_MISMATCH'})
    if(upload.status==='reclaimed' && state!=='released') issues.push({id:String(upload.id),code:'RESERVATION_RELEASE_MISMATCH'})
    if(['receiving','parsing','ready','reclaiming'].includes(String(upload.status)) && state!=='active') issues.push({id:String(upload.id),code:'RESERVATION_MISSING_OR_RELEASED'})
    if(upload.status==='ready') {
      try {await verifier.verify({sourceKey:String(upload.source_key),sourceSize:Number(upload.source_size),fileHash:String(upload.file_hash)})}
      catch {issues.push({id:String(upload.id),code:'PREPARED_SOURCE_UNAVAILABLE'})}
    }
  }
  const reports=db.prepare('SELECT id,source_key,source_size,file_hash,project_id,submitted_by FROM report_submissions').all()
  for(const report of reports) {
    if(!db.prepare('SELECT 1 FROM report_submission_documents WHERE report_id=?').get(String(report.id))) issues.push({id:String(report.id),code:'REPORT_DOCUMENT_MISSING'})
    const allocation=db.prepare("SELECT * FROM storage_allocations WHERE owner_type='report' AND owner_id=?").get(String(report.id))
    if(!allocation || allocation.size_bytes!==report.source_size || allocation.user_id!==report.submitted_by || allocation.project_id!==report.project_id || allocation.file_hash!==report.file_hash || allocation.source_path!==resolve(input.storageRoot,String(report.source_key))) {
      issues.push({id:String(report.id),code:'REPORT_ALLOCATION_MISMATCH'})
    }
    try {await verifier.verify({sourceKey:String(report.source_key),sourceSize:Number(report.source_size),fileHash:String(report.file_hash)})}
    catch {issues.push({id:String(report.id),code:'REPORT_SOURCE_UNAVAILABLE'})}
  }
  try {
    const inventory=await createUploadRecoveryFiles(input).inventory()
    for(const id of inventory.uploadIds) {
      if(!statuses.has(id)) issues.push({id,code:'UNREGISTERED_ARTIFACT'})
      else if(statuses.get(id)==='reclaimed') issues.push({id,code:'RECLAIMED_ARTIFACT_REAPPEARED'})
    }
    for(const entry of inventory.unknownEntries) issues.push({id:entry,code:'UNKNOWN_ARTIFACT'})
  } catch {issues.push({id:'storage',code:'STORAGE_INVENTORY_UNAVAILABLE'})}
  for(const id of mismatchedUsage(db)) issues.push({id,code:'QUOTA_COUNTER_MISMATCH'})
  const at=new Date().toISOString()
  const recoveryCandidates=db.prepare("SELECT u.id FROM report_uploads u WHERE (status='failed' OR (status IN ('receiving','parsing','ready') AND julianday(expires_at)<=julianday(?)) OR (status='reclaiming' AND julianday(recovery_lease_until)<=julianday(?) AND (recovery_retry_at IS NULL OR julianday(recovery_retry_at)<=julianday(?)))) AND report_id IS NULL AND NOT EXISTS(SELECT 1 FROM report_submissions r WHERE r.source_key COLLATE BINARY >= u.id||'/' AND r.source_key COLLATE BINARY < u.id||'0') ORDER BY created_at,id").all(at,at,at).map(row=>String(row.id))
  return {issues,recoveryCandidates}
}

function mismatchedUsage(db:DatabaseSync):string[] {
  const expected=new Map<string,number[]>()
  const add=(userId:string,projectId:string|null,values:number[])=>{
    const scopes=[['global','global'],['user',userId],...(projectId?[['project',projectId]]:[])]
    for(const scope of scopes) {
      const key=JSON.stringify(scope)
      const totals=expected.get(key)??[0,0,0,0]
      for(let index=0;index<4;index++) {
        totals[index]+=values[index]
        if(!Number.isSafeInteger(totals[index])) throw new Error('Storage accounting exceeds safe integer bounds.')
      }
      expected.set(key,totals)
    }
  }
  for(const row of db.prepare('SELECT user_id,project_id,size_bytes FROM storage_allocations').all()) add(String(row.user_id),row.project_id===null?null:String(row.project_id),[Number(row.size_bytes),1,0,0])
  for(const row of db.prepare("SELECT user_id,project_id,expected_bytes FROM storage_reservations WHERE state='active'").all()) add(String(row.user_id),row.project_id===null?null:String(row.project_id),[0,0,Number(row.expected_bytes),1])
  const actual=new Map(db.prepare('SELECT * FROM storage_usage').all().map(row=>[JSON.stringify([row.scope_type,row.scope_id]),[Number(row.used_bytes),Number(row.item_count),Number(row.reserved_bytes),Number(row.reserved_count)]]))
  return [...new Set([...expected.keys(),...actual.keys()])].filter(key=>JSON.stringify(expected.get(key)??[0,0,0,0])!==JSON.stringify(actual.get(key)??[0,0,0,0]))
}
