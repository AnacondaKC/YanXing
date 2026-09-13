import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ReportSubmissionError } from '@/modules/reports/upload-domain'
import { releaseStorageReservationInDatabase } from '@/lib/storage/quota'
import { reconcileSubmissionQuota } from '@/lib/storage/submission-reconciliation'

export interface UploadReclamation {uploadId:string;token:string}
export interface UploadRecoveryFiles {remove(uploadId:string):Promise<void>}
const LEASE_MS = 60_000
const RETRY_MS = 60_000

export class ReportUploadRecovery {
  constructor(private readonly input: {database:DatabaseSync;files:UploadRecoveryFiles;storageRoot:string;now?:()=>Date}) {}

  withMutation<T>(uploadId:string, write:()=>T):T {
    return this.transaction(()=>{
      this.assertStorageRoot()
      const row=this.input.database.prepare("SELECT 1 FROM report_uploads WHERE id=? AND status IN ('receiving','parsing') AND julianday(expires_at)>julianday(?)")
        .get(uploadId,this.now().toISOString())
      if(!row) throw new ReportSubmissionError('UPLOAD_ABORTED','上传已过期或已进入回收，禁止继续写入。')
      const result=write()
      if(result instanceof Promise) throw new Error('Upload mutation fence only supports synchronous bounded filesystem operations.')
      return result
    })
  }

  claim():UploadReclamation|undefined {
    return this.transaction(()=>{
      this.assertStorageRoot()
      const at=this.now()
      const row=this.input.database.prepare(
        "SELECT u.id FROM report_uploads u WHERE (u.status='failed' OR (u.status IN ('receiving','parsing','ready') AND julianday(u.expires_at)<=julianday(?)) OR (u.status='reclaiming' AND julianday(u.recovery_lease_until)<=julianday(?) AND (u.recovery_retry_at IS NULL OR julianday(u.recovery_retry_at)<=julianday(?)))) AND u.report_id IS NULL AND NOT EXISTS (SELECT 1 FROM report_submissions r WHERE r.source_key COLLATE BINARY >= u.id||'/' AND r.source_key COLLATE BINARY < u.id||'0') ORDER BY u.created_at,u.id LIMIT 1"
      ).get(at.toISOString(),at.toISOString(),at.toISOString()) as {id:string}|undefined
      if(!row) return undefined
      const token=randomUUID()
      this.input.database.prepare("UPDATE report_uploads SET status='reclaiming',recovery_token=?,recovery_lease_until=?,recovery_retry_at=NULL WHERE id=?")
        .run(token,new Date(at.getTime()+LEASE_MS).toISOString(),row.id)
      const reservation=this.input.database.prepare('SELECT r.state FROM report_uploads u LEFT JOIN storage_reservations r ON r.id=u.reservation_id WHERE u.id=?').get(row.id)
      if(reservation?.state!=='active') reconcileSubmissionQuota({database:this.input.database,storageRoot:this.input.storageRoot,at:at.toISOString()})
      return {uploadId:row.id,token}
    })
  }

  complete(claim:UploadReclamation):void {
    this.transaction(()=>{
      this.assertStorageRoot()
      const reservation=this.requireLease(claim)
      releaseStorageReservationInDatabase(this.input.database,reservation)
      this.input.database.prepare("UPDATE report_uploads SET status='reclaimed',reclaimed_at=?,recovery_token=NULL,recovery_lease_until=NULL,recovery_error=NULL,recovery_retry_at=NULL WHERE id=?")
        .run(this.now().toISOString(),claim.uploadId)
    })
  }

  retry(claim:UploadReclamation):void {
    this.transaction(()=>{
      this.assertStorageRoot()
      this.requireLease(claim)
      const at=this.now()
      this.input.database.prepare("UPDATE report_uploads SET recovery_error='UPLOAD_CLEANUP_FAILED',recovery_lease_until=?,recovery_retry_at=? WHERE id=?")
        .run(at.toISOString(),new Date(at.getTime()+RETRY_MS).toISOString(),claim.uploadId)
    })
  }

  async runBatch(limit=100) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error('Recovery batch limit must be 1..1000.')
    this.reconcileQuota()
    const recovered:string[]=[]
    const blocked:string[]=[]
    for(let index=0;index<limit;index++) {
      const claim=this.claim()
      if(!claim) break
      try {
        await this.input.files.remove(claim.uploadId)
        this.complete(claim)
        recovered.push(claim.uploadId)
      } catch {
        blocked.push(claim.uploadId)
        try {this.retry(claim)} catch(error) {
          if(!(error instanceof ReportSubmissionError && error.code==='RECOVERY_LEASE_LOST')) throw error
        }
      }
    }
    return {recovered,blocked}
  }

  reconcileQuota() {
    return this.transaction(()=>{
      this.assertStorageRoot()
      return reconcileSubmissionQuota({database:this.input.database,storageRoot:this.input.storageRoot,at:this.now().toISOString()})
    })
  }

  private requireLease(claim:UploadReclamation):string {
    const row=this.input.database.prepare("SELECT reservation_id FROM report_uploads u WHERE id=? AND status='reclaiming' AND recovery_token=? AND julianday(recovery_lease_until)>julianday(?) AND NOT EXISTS(SELECT 1 FROM report_submissions r WHERE r.source_key COLLATE BINARY >= u.id||'/' AND r.source_key COLLATE BINARY < u.id||'0')")
      .get(claim.uploadId,claim.token,this.now().toISOString()) as {reservation_id:string}|undefined
    if(!row) throw new ReportSubmissionError('RECOVERY_LEASE_LOST','文件回收租约已失效。')
    return row.reservation_id
  }
  private assertStorageRoot() {
    const bound=this.input.database.prepare('SELECT path FROM submission_storage_root WHERE id=1').get()?.path
    const uploads=this.input.database.prepare('SELECT 1 FROM report_uploads LIMIT 1').get()
    const reports=this.input.database.prepare('SELECT 1 FROM report_submissions LIMIT 1').get()
    if((bound && bound!==resolve(this.input.storageRoot)) || (!bound && (uploads || reports))) throw new Error('Recovery storage root does not match this database.')
  }
  private now() {return this.input.now?.()??new Date()}
  private transaction<T>(work:()=>T):T {
    this.input.database.exec('BEGIN IMMEDIATE')
    try {const result=work();this.input.database.exec('COMMIT');return result}
    catch (error) {
      try { this.input.database.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  }
}
