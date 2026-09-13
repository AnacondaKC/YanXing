import { DatabaseSync } from 'node:sqlite'
import { SubmissionTaskRepository } from '../../lib/db/submission-task-repository'

const database=new DatabaseSync(process.argv[2])
database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000')
const tasks=new SubmissionTaskRepository({database,storageRoot:process.argv[3]})
process.once('message',()=>{
  let result:unknown
  try {result={ok:true,claim:tasks.claim()??null}}
  catch(error) {result={ok:false,message:error instanceof Error?error.message:'FAILED'}}
  finally {database.close()}
  process.send?.(result,()=>process.disconnect())
})
process.send?.({ready:true})
