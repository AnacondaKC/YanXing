import type { DatabaseSync } from 'node:sqlite'
import { isAbsolute, relative, resolve } from 'node:path'
import { PERSISTED_UPLOAD_RESERVATION_END } from '@/lib/storage/submission-quota'

/** Caller holds BEGIN IMMEDIATE; shared knowledge allocations/reservations remain authoritative too. */
export function reconcileSubmissionQuota(input:{database:DatabaseSync;storageRoot:string;at:string}) {
  const db=input.database
  if(!db.isTransaction) throw new Error('Quota reconciliation requires a write transaction.')
  db.prepare(
    "INSERT INTO storage_reservations(id,user_id,project_id,expected_bytes,owner_type,expires_at,state,created_at,updated_at) SELECT reservation_id,actor_id,project_id,reserved_bytes,'report',?,CASE status WHEN 'committed' THEN 'consumed' WHEN 'reclaimed' THEN 'released' WHEN 'failed' THEN 'released' ELSE 'active' END,created_at,? FROM report_uploads WHERE 1 ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,project_id=excluded.project_id,expected_bytes=excluded.expected_bytes,owner_type='report',expires_at=excluded.expires_at,state=excluded.state,updated_at=excluded.updated_at"
  ).run(PERSISTED_UPLOAD_RESERVATION_END,input.at)
  const reports=db.prepare('SELECT r.*,COALESCE(d.mime_type,u.mime_type) AS mime_type FROM report_submissions r LEFT JOIN report_submission_documents d ON d.report_id=r.id LEFT JOIN report_uploads u ON u.report_id=r.id').all()
  const allocation=db.prepare('INSERT INTO storage_allocations(owner_type,owner_id,user_id,project_id,size_bytes,file_hash,source_path,mime_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_type,owner_id) DO UPDATE SET user_id=excluded.user_id,project_id=excluded.project_id,size_bytes=excluded.size_bytes,file_hash=excluded.file_hash,source_path=excluded.source_path,mime_type=excluded.mime_type,updated_at=excluded.updated_at')
  for(const report of reports) {
    if(typeof report.mime_type!=='string' || !report.mime_type) throw new Error('Committed report metadata is incomplete; reconciliation stopped.')
    const sourceKey=String(report.source_key)
    const sourcePath=resolve(input.storageRoot,sourceKey)
    const key=relative(resolve(input.storageRoot),sourcePath)
    if(isAbsolute(sourceKey)||!key||key==='..'||key.startsWith('../')||isAbsolute(key)) throw new Error('Invalid committed report source key; reconciliation stopped.')
    allocation.run('report',String(report.id),String(report.submitted_by),String(report.project_id),Number(report.source_size),String(report.file_hash),sourcePath,String(report.mime_type),String(report.submitted_at),input.at)
  }
  // Rebuild all scopes from the two shared ledgers, never from report rows alone.
  db.exec('CREATE TEMP TABLE submission_quota_totals(scope_type TEXT,scope_id TEXT,used_bytes INTEGER,item_count INTEGER,reserved_bytes INTEGER,reserved_count INTEGER)')
  db.exec('DELETE FROM submission_quota_totals')
  for(const scope of ['global','user','project'] as const) {
    const id=scope==='global'?"'global'":scope==='user'?'user_id':'project_id'
    const predicate=scope==='project'?' WHERE project_id IS NOT NULL':''
    db.exec("INSERT INTO submission_quota_totals SELECT '"+scope+"',"+id+",SUM(size_bytes),COUNT(*),0,0 FROM storage_allocations"+predicate+' GROUP BY '+id)
    db.exec("INSERT INTO submission_quota_totals SELECT '"+scope+"',"+id+",0,0,SUM(expected_bytes),COUNT(*) FROM storage_reservations WHERE state='active'"+(scope==='project'?' AND project_id IS NOT NULL':'')+' GROUP BY '+id)
  }
  db.prepare('UPDATE storage_usage SET used_bytes=0,item_count=0,reserved_bytes=0,reserved_count=0,revision=revision+1,updated_at=?').run(input.at)
  db.prepare('INSERT INTO storage_usage(scope_type,scope_id,used_bytes,item_count,reserved_bytes,reserved_count,updated_at) SELECT scope_type,scope_id,SUM(used_bytes),SUM(item_count),SUM(reserved_bytes),SUM(reserved_count),? FROM submission_quota_totals GROUP BY scope_type,scope_id ON CONFLICT(scope_type,scope_id) DO UPDATE SET used_bytes=excluded.used_bytes,item_count=excluded.item_count,reserved_bytes=excluded.reserved_bytes,reserved_count=excluded.reserved_count,updated_at=excluded.updated_at').run(input.at)
  db.exec('DROP TABLE submission_quota_totals')
  return {retainedReports:reports.length}
}
