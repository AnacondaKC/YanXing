import assert from 'node:assert/strict'
import test from 'node:test'
import {runRelocateStorageCli} from '../scripts/relocate-storage'

test('production relocation entry refuses the old write protocol without opening a database',()=>{
  const output:string[]=[]
  const io={log:(message:string)=>output.push(message),error:(message:string)=>output.push(message)}
  assert.equal(runRelocateStorageCli(['--from','/old','--to','/new','--database','/must-not-open.sqlite','--apply'],io),1)
  assert.match(output[0],/已关闭/)
  assert.match(output[0],/不会自动迁移或覆盖/)
  assert.equal(runRelocateStorageCli(['--help'],io),0)
})
