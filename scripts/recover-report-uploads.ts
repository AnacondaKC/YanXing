import { DatabaseSync } from 'node:sqlite'
import { assertNoIncompleteRestore } from '../lib/storage/native-restore-guard'
import { assertNativeSchema } from '../lib/db/native-schema'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ReportUploadRecovery } from '../lib/db/report-upload-recovery'
import { createUploadRecoveryFiles } from '../lib/documents/upload-recovery-files'
import { auditSubmissionStorage } from '../lib/storage/submission-storage-audit'

async function main() {
  const args=process.argv.slice(2)
  let databasePath:string|undefined
  let storageRoot:string|undefined
  let apply=false
  let limit=100
  for(let index=0;index<args.length;index++) {
    const flag=args[index]
    if(flag==='--help') {console.log('recover-report-uploads --database PATH --storage-root PATH [--apply] [--limit 1..1000]');return}
    if(flag==='--apply') {apply=true;continue}
    const value=args[++index]
    if(!value || value.startsWith('--')) throw new Error('Missing value for '+flag)
    if(flag==='--database') databasePath=resolve(value)
    else if(flag==='--storage-root') storageRoot=resolve(value)
    else if(flag==='--limit') limit=Number(value)
    else throw new Error('Unknown option '+flag)
  }
  if(!databasePath || !storageRoot || !Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error('Explicit database, storage root and a limit of 1..1000 are required.')
  assertNoIncompleteRestore(databasePath)
  if(!(await stat(databasePath)).isFile()) throw new Error('Database must be an existing file.')
  const database=new DatabaseSync(databasePath,{readOnly:!apply})
  try {
    assertNativeSchema({database,storageRoot})
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    const before=await auditSubmissionStorage({database,storageRoot})
    if(!apply){console.log(JSON.stringify({mode:'dry-run',...before},null,2));return}
    if(before.issues.some(issue=>issue.code==='STORAGE_ROOT_MISMATCH'||issue.code==='STORAGE_ROOT_UNBOUND')) throw new Error('Storage root does not match the database; no changes applied.')
    const recovery=new ReportUploadRecovery({database,storageRoot,files:createUploadRecoveryFiles({storageRoot})})
    const result=await recovery.runBatch(limit)
    const after=await auditSubmissionStorage({database,storageRoot})
    console.log(JSON.stringify({mode:'apply',...result,...after},null,2))
    if(result.blocked.length || after.issues.length) process.exitCode=2
  } finally {database.close()}
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Recovery failed');process.exitCode=1})
