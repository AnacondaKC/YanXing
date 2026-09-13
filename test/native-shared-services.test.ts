import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

const root=await mkdtemp(join(tmpdir(),'native-shared-services-'))
process.env.YANXING_DATABASE_PATH=join(root,'native.sqlite')
const {getDatabase}=await import('../lib/db/client')
const {createOrUpdateUser,createSession,sessionCookieName,deleteManagedUser,getSessionByToken}=await import('../lib/auth/session')
const {createSubmissionProcessingRuntime}=await import('../lib/reports/submission-processing-runtime')
const {replaceProjectMembers,getProjectMembersSnapshot,ProjectMembershipConflictError}=await import('../lib/db/project-members-repository')
const {GET:readMembers,PUT:writeMembers}=await import('../app/api/admin/projects/[projectId]/members/route')
const database=getDatabase()
const runtime=createSubmissionProcessingRuntime({database,storageRoot:join(root,'reports'),resolveActorId:()=>undefined})
test.after(async()=>{database.close();await rm(root,{recursive:true,force:true})})

function user(name:string,role:'admin'|'researcher'='researcher') {
  return createOrUpdateUser({username:name,displayName:name,password:'native-shared-test-password',role})
}
function project(ownerId:string) {
  return runtime.repository.createProject({actorId:ownerId,project:{title:'原生课题',objective:'研究目标',description:'研究背景',ownerId,stages:[{id:'research-'+ownerId,title:'研究阶段',description:'阶段成果',plannedEndAt:'2027-12-31'}]}})
}
function request(token:string,method='GET',body?:unknown) {
  return new NextRequest('http://localhost/api/admin/projects/project/members',{method,headers:{cookie:sessionCookieName+'='+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
}

test('shared user/member services operate without any legacy report or job tables',()=>{
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('report_versions','analysis_jobs','report_insights')").get(),undefined)
  const owner=user('native-member-owner'),admin=user('native-member-admin','admin'),next=user('native-next-owner')
  const created=project(owner.id)
  const id=created.projectId
  const changed=replaceProjectMembers({projectId:id,actorId:admin.id,expectedRevision:0,members:[{userId:next.id,role:'owner'},{userId:owner.id,role:'editor'}]})
  assert.equal(changed?.revision,1)
  assert.equal(changed?.members.find(member=>member.role==='owner')?.userId,next.id)
  assert.throws(()=>replaceProjectMembers({projectId:id,actorId:admin.id,expectedRevision:0,members:[{userId:owner.id,role:'owner'}]}),ProjectMembershipConflictError)
  assert.throws(()=>replaceProjectMembers({projectId:id,actorId:'',expectedRevision:1,members:[{userId:owner.id,role:'owner'}]}),/权限/)
})

test('deleting an audited former owner fails without deleting their account or session',()=>{
  const owner=user('native-audit-owner'),admin=user('native-audit-admin','admin'),next=user('native-audit-next')
  const created=project(owner.id),session=createSession(owner.id)
  replaceProjectMembers({projectId:created.projectId,actorId:admin.id,expectedRevision:0,members:[{userId:next.id,role:'owner'}]})
  assert.throws(()=>deleteManagedUser(owner.id,admin.id),/请停用账号/)
  assert.ok(getSessionByToken(session.token))
  assert.ok(database.prepare('SELECT id FROM users WHERE id=?').get(owner.id))
})

test('admin membership GET and PUT revalidate authority after awaited route params',async()=>{
  const owner=user('native-delay-owner'),admin=user('native-delay-admin','admin')
  const created=project(owner.id),session=createSession(admin.id)
  let resolve!: (value:{projectId:string})=>void
  let params=new Promise<{projectId:string}>(done=>{resolve=done})
  const reading=readMembers(request(session.token),{params})
  database.prepare("UPDATE users SET role='researcher' WHERE id=?").run(admin.id)
  resolve({projectId:created.projectId})
  assert.equal((await reading).status,403)
  database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id)
  params=new Promise(done=>{resolve=done})
  const writing=writeMembers(request(session.token,'PUT',{revision:0,members:[{userId:owner.id,role:'owner'}]}),{params})
  database.prepare("UPDATE users SET role='researcher' WHERE id=?").run(admin.id)
  resolve({projectId:created.projectId})
  assert.equal((await writing).status,403)
  assert.equal(getProjectMembersSnapshot(created.projectId)?.revision,0)
})
