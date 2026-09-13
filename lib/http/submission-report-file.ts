import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open,realpath,type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { resolveByteRange } from '@/lib/documents/byte-range'
import { contentDispositionHeader } from '@/lib/documents/content-disposition'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { rateLimitFailure } from '@/lib/http/rate-limit-response'
import { logUnexpectedError } from '@/lib/http/public-error'
import { SubmissionTaskError } from '@/modules/reports/submission-task-domain'
import { ReportSubmissionError } from '@/modules/reports/upload-domain'
import type { SubmissionServerRuntime } from '@/lib/reports/server-runtime'

type FileRuntime=Pick<SubmissionServerRuntime,'getCurrentUser'>&{
  workspace:Pick<SubmissionServerRuntime['workspace'],'actor'>
  processing:{tasks:Pick<SubmissionServerRuntime['processing']['tasks'],'getSource'>}
}
const FILE_OPEN_FLAGS=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK

export async function serveSubmissionReportFile(input:{runtime:FileRuntime;request:Request;reportId:string;includeBody:boolean}) {
  let handle:FileHandle|undefined
  try {
    const user=input.runtime.getCurrentUser(input.request)
    if(!user)return json({error:'未登录。',code:'UNAUTHENTICATED'},401)
    input.runtime.workspace.actor(user.id)
    const limited=rateLimitFailure(checkRateLimit('report-file:'+user.id,{limit:240,windowMs:60*1000}),{error:'下载过于频繁，请稍后再试。'})
    if(limited)return json(limited.body,limited.status,limited.headers)
    const source=input.runtime.processing.tasks.getSource(input.reportId)
    if(!source)return unavailable()
    // Reject symlinked ancestors as well as the leaf; never reopen a verified pathname for the response.
    if(await realpath(source.path)!==source.path)return unavailable()
    handle=await open(source.path,FILE_OPEN_FLAGS)
    const before=await handle.stat()
    if(!before.isFile()||before.size<=0)return unavailable()
    if(before.size!==source.size)return integrityFailure('SOURCE_SIZE_MISMATCH')
    const digest=createHash('sha256')
    for await(const chunk of handle.createReadStream({start:0,end:before.size-1,autoClose:false,signal:input.request.signal}))digest.update(chunk)
    if(digest.digest('hex')!==source.sha256)return integrityFailure('SOURCE_HASH_MISMATCH')
    const after=await handle.stat()
    if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)return integrityFailure('SOURCE_CHANGED')
    const currentUser=input.runtime.getCurrentUser(input.request)
    if(!currentUser||currentUser.id!==user.id)return json({error:'会话已过期，请重新登录。',code:'UNAUTHENTICATED'},401)
    input.runtime.workspace.actor(user.id)
    const currentSource=input.runtime.processing.tasks.getSource(input.reportId)
    if(!currentSource||currentSource.path!==source.path||currentSource.sha256!==source.sha256||currentSource.size!==source.size)return unavailable()
    const range=resolveByteRange(input.request.headers.get('range'),before.size)
    if(!range)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+before.size,'Cache-Control':'private, no-store'}})
    const headers=new Headers({
      'Accept-Ranges':'bytes','Cache-Control':'private, no-store',
      'Content-Disposition':contentDispositionHeader(source.fileName,new URL(input.request.url).searchParams.get('download')==='1'),
      'Content-Length':String(range.end-range.start+1),'Content-Security-Policy':"frame-ancestors 'self'",
      'Content-Type':source.mimeType,'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN',
    })
    if(range.partial)headers.set('Content-Range','bytes '+range.start+'-'+range.end+'/'+before.size)
    if(!input.includeBody)return new Response(null,{status:range.partial?206:200,headers})
    const stream=handle.createReadStream({start:range.start,end:range.end,autoClose:true,signal:input.request.signal})
    handle=undefined // The response stream now owns closure, including client cancellation.
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status:range.partial?206:200,headers})
  } catch(error) {
    if(error instanceof SubmissionTaskError||error instanceof ReportSubmissionError)return json({error:error.message,code:error.code},error.status)
    const code=error&&typeof error==='object'&&'code'in error?String(error.code):''
    if(['ELOOP','ENOENT','ENOTDIR'].includes(code))return unavailable()
    if(input.request.signal.aborted)return json({error:'文件读取已取消。',code:'REQUEST_ABORTED'},499)
    logUnexpectedError('report-file',error)
    return json({error:'报告文件读取失败，请稍后重试。',code:'REPORT_FILE_FAILED'},500)
  } finally {
    await handle?.close()
  }
}
function unavailable(){return json({error:'报告源文件不存在或不可用。',code:'REPORT_SOURCE_UNAVAILABLE'},404)}
function integrityFailure(code:string){return json({error:'报告源文件校验失败。',code},409)}
function json(value:unknown,status:number,headers?:Record<string,string>){return Response.json(value,{status,headers:{'Cache-Control':'private, no-store',...headers}})}
