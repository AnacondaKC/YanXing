import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createTaskFixture } from './helpers/submission-task-fixture'
import type { SubmissionTaskClaim } from '../modules/reports/submission-task-domain'

type Outcome={ok:true;claim:SubmissionTaskClaim|null}|{ok:false;message:string}
function launch(databasePath:string,storageRoot:string) {
  const env={...process.env};delete env.NODE_TEST_CONTEXT
  const child=fork(fileURLToPath(new URL('./helpers/claim-submission-task-process.ts',import.meta.url)),[databasePath,storageRoot],{env,execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','inherit','ipc']})
  const ready=new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(new Error('Child exited '+code))})})
  const result=ready.then(()=>new Promise<Outcome>((resolve,reject)=>{child.once('message',message=>resolve(message as Outcome));child.once('exit',code=>{if(code!==0)reject(new Error('Child exited '+code))})}))
  void result.catch(()=>undefined)
  return {child,ready,result}
}
test('two real Worker processes cannot claim or call the same queued task twice',{timeout:20000},async context=>{
  const root=await mkdtemp(join(tmpdir(),'submission-worker-race-'))
  const path=join(root,'new.sqlite')
  const f=createTaskFixture({path})
  const children:ReturnType<typeof launch>[]=[]
  context.after(()=>{for(const item of children)item.child.kill()})
  try {
    const report=f.submit()
    f.tasks.admit({actorId:'owner',reportId:report.reportId,operation:'analysis'})
    children.push(launch(path,f.storageRoot),launch(path,f.storageRoot))
    await Promise.all(children.map(item=>item.ready))
    for(const item of children)item.child.send('claim')
    const outcomes=await Promise.all(children.map(item=>item.result))
    assert.ok(outcomes.every(item=>item.ok),JSON.stringify(outcomes))
    const claims=outcomes.flatMap(item=>item.ok && item.claim?[item.claim]:[])
    assert.equal(claims.length,1)
    f.checkpoint(claims[0])
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM submission_task_calls').get()?.n,1)
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM submission_tasks').get()?.n,1)
    assert.equal(f.tasks.claim(),undefined)
  } finally {for(const item of children)item.child.kill();f.database.close();await rm(root,{recursive:true,force:true})}
})
