import { DatabaseSync } from 'node:sqlite'
import { ReportSubmissionRepository } from '../../lib/db/report-submission-repository'
import { createSubmissionStorageQuota } from '../../lib/storage/submission-quota'
import type { ReportSubmissionConfirmation } from '../../modules/reports/upload-domain'

const database = new DatabaseSync(process.argv[2])
database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000')
const repository = new ReportSubmissionRepository({ database, quota:createSubmissionStorageQuota({storageRoot:'/unused-process-test-root'}) })
process.once('message', () => {
  let result: unknown
  try {
    result={ok:true,result:repository.confirmSubmission(JSON.parse(process.argv[3]) as ReportSubmissionConfirmation)}
  } catch(error) {
    result={ok:false,code:error instanceof Error && 'code' in error ? error.code : 'UNEXPECTED'}
  } finally {database.close()}
  process.send?.(result,()=>process.disconnect())
})
process.send?.({ready:true})
