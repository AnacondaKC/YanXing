import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rename,symlink,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const root=await mkdtemp(join(tmpdir(),'native-source-read-'))
process.env.YANXING_DATABASE_PATH=join(root,'db.sqlite')
const {createOrUpdateUser}=await import('../lib/auth/session')
const {serveSubmissionReportFile}=await import('../lib/http/submission-report-file')
const user=createOrUpdateUser({username:'file-reader',displayName:'文件读取者',password:'file-test-password',role:'researcher'})
test.after(async()=>{await rm(root,{recursive:true,force:true})})

async function fixture(content='immutable PDF'){
  const path=join(root,randomUUID()+'.pdf')
  await writeFile(path,content)
  const source={path,fileName:'报告.pdf',size:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex'),mimeType:'application/pdf'}
  let active=true,deleted=false
  const runtime={getCurrentUser:()=>active?user:undefined,workspace:{actor:()=>({...user,status:'active' as const})},processing:{tasks:{getSource:()=>deleted?undefined:source}}}
  const serve=(range?:string,includeBody=true)=>serveSubmissionReportFile({runtime,request:new Request('http://localhost/api/reports/report/file',{headers:range?{Range:range}:{}}),reportId:'report',includeBody})
  return {path,source,runtime,serve,revoke:()=>{active=false},remove:()=>{deleted=true}}
}

test('full and ranged downloads stream the same verified descriptor, with safe HEAD support',async()=>{
  const file=await fixture()
  const full=await file.serve()
  assert.equal(full.status,200)
  await rename(file.path,file.path+'.old')
  await writeFile(file.path,'replaced file')
  assert.equal(await full.text(),'immutable PDF')
  const rangeFile=await fixture()
  const range=await rangeFile.serve('bytes=0-3')
  assert.equal(range.status,206)
  assert.equal(range.headers.get('Content-Range'),'bytes 0-3/13')
  assert.equal(await range.text(),'immu')
  const head=await rangeFile.serve(undefined,false)
  assert.equal(head.status,200)
  assert.equal(head.headers.get('Content-Length'),'13')
  assert.equal(await head.text(),'')
})

test('range and HEAD cannot bypass immutable source hash validation',async()=>{
  const file=await fixture('AAAA')
  await writeFile(file.path,'BBBB')
  assert.equal((await file.serve('bytes=0-0')).status,409)
  assert.equal((await file.serve(undefined,false)).status,409)
})

test('symlinked sources are rejected even when their target has matching bytes',async()=>{
  const file=await fixture()
  await rename(file.path,file.path+'.real')
  await symlink(file.path+'.real',file.path)
  const result=await file.serve()
  assert.equal(result.status,404)
  assert.equal((await result.text()).includes(root),false)
})

test('authentication and logical deletion are rechecked after asynchronous file verification',async()=>{
  const revoked=await fixture()
  revoked.runtime.processing.tasks.getSource=()=>{queueMicrotask(revoked.revoke);return revoked.source}
  assert.equal((await revoked.serve()).status,401)
  const deleted=await fixture()
  const original=deleted.runtime.processing.tasks.getSource
  deleted.runtime.processing.tasks.getSource=()=>{const source=original();queueMicrotask(deleted.remove);return source}
  assert.equal((await deleted.serve()).status,404)
})
