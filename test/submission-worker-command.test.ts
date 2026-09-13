import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp,rm,readdir,readFile,writeFile,mkdir,symlink } from 'node:fs/promises'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { restoreIncompleteMarkerPath } from '../lib/storage/native-restore-guard'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'
import { ensureNativeDatabase } from '../lib/db/native-schema'

const entry=fileURLToPath(new URL('../worker/submission-index.ts',import.meta.url))
function run(args:string[],cwd:string,target=entry) {
  const env:NodeJS.ProcessEnv={...process.env,YANXING_DATABASE_PATH:join(cwd,'must-not-create','default.sqlite')}
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),target,...args],{cwd,env,encoding:'utf8',timeout:15000})
}
test('explicit Worker command rejects absent/old databases and processes an empty fresh P3 database only',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-worker-command-'))
  try {
    assert.equal(run(['--help'],root).status,0)
    assert.equal(run([],root).status,1)
    const absent=join(root,'absent.sqlite')
    assert.equal(run(['--database',absent,'--storage-root',join(root,'sources'),'--once'],root).status,1)
    assert.deepEqual(await readdir(root),[])
    const path=join(root,'new.sqlite')
    const database=createReportUploadTestDatabase(path)
    database.close()
    const old=run(['--database',path,'--storage-root',join(root,'sources'),'--once'],root)
    assert.equal(old.status,1)
    assert.match(old.stderr,/不匹配/)
    const {DatabaseSync}=await import('node:sqlite')
    await rm(path)
    const connection=new DatabaseSync(path);connection.exec('PRAGMA foreign_keys=ON');ensureNativeDatabase({database:connection,storageRoot:join(root,'sources')});connection.close()
    const result=run(['--database',path,'--storage-root',join(root,'sources'),'--once'],root)
    assert.equal(result.status,0,result.stderr)
    assert.deepEqual(JSON.parse(result.stdout),{delivered:0,deferred:0,dismissed:0,claimed:0})
    assert.deepEqual(await readdir(root),['new.sqlite'])
  } finally {await rm(root,{recursive:true,force:true})}
})

test('explicit write entries fail closed before mutations for marker and incompatible schema, source and compiled',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-entry-guards-'))
  const projectRoot=fileURLToPath(new URL('..',import.meta.url))
  try {
    await symlink(join(projectRoot,'node_modules'),join(root,'node_modules'),'dir')
    const recoveryEntry=join(projectRoot,'scripts/recover-report-uploads.ts')
    await build({entryPoints:[entry,recoveryEntry],outdir:join(root,'.runtime'),outbase:projectRoot,bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',outExtension:{'.js':'.mjs'},alias:{'@':projectRoot}})
    const entries=[entry,recoveryEntry,join(root,'.runtime/worker/submission-index.mjs'),join(root,'.runtime/scripts/recover-report-uploads.mjs')]
    for(const variant of ['marker','empty','legacy','mixed','checksum','trigger','index','root','valid']) {
      const directory=join(root,variant)
      await mkdir(directory)
      const databasePath=join(directory,'db.sqlite'),storageRoot=join(directory,'reports')
      const database=new DatabaseSync(databasePath)
      database.exec('PRAGMA foreign_keys=ON')
      if(variant==='legacy') database.exec('CREATE TABLE report_versions(id TEXT)')
      else if(variant!=='empty') ensureNativeDatabase({database,storageRoot})
      if(variant==='mixed') database.exec('CREATE TABLE report_versions(id TEXT)')
      if(variant==='checksum') database.exec("UPDATE native_schema_identity SET checksum='wrong'")
      if(variant==='trigger') database.exec('DROP TRIGGER report_uploads_immutable_identity')
      if(variant==='index') database.exec('DROP INDEX idx_report_submissions_source_key')
      database.close()
      const marker=restoreIncompleteMarkerPath(directory)
      if(variant==='marker') await writeFile(marker,'incomplete')
      const before=await readFile(databasePath)
      for(const target of entries) {
        const args=['--database',databasePath,'--storage-root',variant==='root'?join(directory,'wrong'):storageRoot,target.includes('submission-index')?'--once':'--apply']
        const result=run(args,root,target)
        assert.equal(result.status,variant==='valid'?0:1,variant+' '+target+' '+result.stderr)
        if(variant!=='valid') assert.deepEqual(await readFile(databasePath),before)
      }
      if(variant==='marker') {assert.equal(await readFile(marker,'utf8'),'incomplete');await rm(marker)}
    }
  } finally {await rm(root,{recursive:true,force:true})}
})

