import { lstat, readdir, realpath, rm, rmdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ReportSubmissionError } from '@/modules/reports/upload-domain'

const ID = /^[A-Za-z0-9_-]{1,100}$/
const TEMP_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$/i
const TEMP_NAME = /^([A-Za-z0-9_-]{1,100})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$/i

/** The database fence must be acquired first; these operations never infer deletion authority from age. */
export function createUploadRecoveryFiles(input:{storageRoot:string}) {
  if(!input.storageRoot.trim()) throw new Error('Recovery needs an explicit private storage root.')
  const root=resolve(input.storageRoot)
  return {
    async remove(uploadId:string):Promise<void> {
      if(typeof uploadId!=='string'||!ID.test(uploadId)) throw unsafe()
      if(!await directory(root)) throw new ReportSubmissionError('UPLOAD_CLEANUP_FAILED','准备存储根目录不可用，不能将离线文件认定为已删除。',500)
      const folder=join(root,uploadId)
      if(await directory(folder)) {
        for(const name of await readdir(folder)) {
          if(name!==uploadId+'.docx' && name!==uploadId+'.pdf') throw unsafe()
        }
        for(const suffix of ['.docx','.pdf']) await removeRegular(join(folder,uploadId+suffix))
        await rmdir(folder).catch(error=>{if(!missing(error))throw error})
        await syncDirectory(root)
      }
      const temp=join(root,'.tmp')
      if(await directory(temp)) {
        for(const name of await readdir(temp)) {
          if(name.startsWith(uploadId+'-') && TEMP_SUFFIX.test(name.slice(uploadId.length+1))) await removeRegular(join(temp,name))
        }
        await syncDirectory(temp)
      }
    },
    async inventory() {
      const uploadIds=new Set<string>()
      const unknownEntries:string[]=[]
      let entries:string[]
      try {entries=await readdir(root)} catch(error){if(missing(error))return {uploadIds:[],unknownEntries};throw error}
      for(const name of entries) {
        if(name==='.tmp') continue
        if(ID.test(name)) uploadIds.add(name)
        else unknownEntries.push(name)
      }
      if(await directory(join(root,'.tmp'))) {
        for(const name of await readdir(join(root,'.tmp'))) {
          const match=TEMP_NAME.exec(name)
          if(match) uploadIds.add(match[1])
          else unknownEntries.push('.tmp/'+name)
        }
      }
      return {uploadIds:[...uploadIds],unknownEntries}
    },
  }

  async function directory(path:string):Promise<boolean> {
    let stats
    try {stats=await lstat(path)} catch(error){if(missing(error))return false;throw error}
    if(stats.isSymbolicLink() || !stats.isDirectory()) throw unsafe()
    const actualRoot=await realpath(root)
    if(await realpath(path)!==join(actualRoot,path.slice(root.length+1))) throw unsafe()
    return true
  }
}

async function removeRegular(path:string) {
  let stats
  try {stats=await lstat(path)} catch(error){if(missing(error))return;throw error}
  if(!stats.isFile() || stats.isSymbolicLink()) throw unsafe()
  await rm(path).catch(error=>{if(!missing(error))throw error})
}
async function syncDirectory(path:string) {
  const handle=await open(path,'r')
  try {await handle.sync()} finally {await handle.close()}
}
function missing(error:unknown) {return error instanceof Error && 'code' in error && error.code==='ENOENT'}
function unsafe(){return new ReportSubmissionError('UPLOAD_CLEANUP_FAILED','准备目录包含未知文件或不安全路径，已保留并停止回收。',500)}
