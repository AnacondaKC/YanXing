import { setTimeout as wait } from 'node:timers/promises'
import type {SessionUser as AuthUser} from '@/modules/users/domain'
import type {SubmissionWorkspaceRepository} from '@/lib/db/submission-workspace-repository'

export function createJobEventStream(input:{workspace:SubmissionWorkspaceRepository;getCurrentUser:(request:Request)=>AuthUser|undefined;onError:(error:unknown)=>Response}) {
  const connections=new Map<string,number>()
  const maxConnections=20,batchSize=100,maxDurationMs=30*60*1000
  return async(request:Request,jobId:string)=>{
    const user=input.getCurrentUser(request)
    if(!user)return Response.json({error:'未登录。',code:'UNAUTHENTICATED'},{status:401})
    try{input.workspace.jobView({actorId:user.id,jobId})}catch(error){return input.onError(error)}
    if((connections.get(user.id)??0)>=maxConnections)return Response.json({error:'事件连接过多。',code:'STREAM_LIMIT'},{status:429,headers:{'Retry-After':'5'}})
    if(request.signal.aborted)return new Response(null,{status:499})
    connections.set(user.id,(connections.get(user.id)??0)+1)
    const abort=new AbortController(),encoder=new TextEncoder()
    let afterId=parseCursor(request),interval=700,stopped=false
    let controller:ReadableStreamDefaultController<Uint8Array>|undefined
    let lifetime:ReturnType<typeof setTimeout>|undefined
    const stop=()=>{
      if(stopped)return
      stopped=true
      abort.abort()
      clearTimeout(lifetime)
      request.signal.removeEventListener('abort',stop)
      const remaining=(connections.get(user.id)??1)-1
      if(remaining<=0)connections.delete(user.id);else connections.set(user.id,remaining)
      try{controller?.close()}catch{/* Consumer cancellation already closed the stream. */}
    }
    request.signal.addEventListener('abort',stop,{once:true})
    lifetime=setTimeout(stop,maxDurationMs)
    lifetime.unref()
    const stream=new ReadableStream<Uint8Array>({
      start(value){controller=value},
      async pull(value){
        try{
          while(!stopped){
            const current=input.getCurrentUser(request)
            if(!current||current.id!==user.id){stop();return}
            const events=input.workspace.listTaskEvents({actorId:user.id,jobId,afterId,limit:batchSize})
            const view=input.workspace.jobView({actorId:user.id,jobId})
            const terminal=['completed','failed','cancelled'].includes(view.job.status)
            if(events.length){
              afterId=events[events.length-1].id
              value.enqueue(encoder.encode(events.map(event=>'id: '+event.id+String.fromCharCode(10)+'event: '+event.type+String.fromCharCode(10)+'data: '+JSON.stringify(event)+String.fromCharCode(10,10)).join('')))
              interval=700
              if(terminal&&events.length<batchSize)stop()
              return // Let readable backpressure bound the next batch.
            }
            if(terminal){stop();return}
            await sleep(interval,abort.signal)
            interval=Math.min(5000,Math.round(interval*1.5))
            if(!stopped){value.enqueue(encoder.encode(': keep-alive'+String.fromCharCode(10,10)));return}
          }
        }catch(error){if(!stopped)input.onError(error);stop()}
      },
      cancel(){stop()},
    })
    return new Response(stream,{headers:{'Cache-Control':'no-store','Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no',Connection:'keep-alive'}})
  }
}
function parseCursor(request:Request){
  for(const value of [request.headers.get('last-event-id'),new URL(request.url).searchParams.get('after')]){
    if(value!==null&&value!==''&&Number.isSafeInteger(Number(value))&&Number(value)>=0)return Number(value)
  }
  return 0
}
function sleep(ms:number,signal:AbortSignal) {
  return wait(ms,undefined,{signal}).catch((error:unknown)=>{
    if(!(error instanceof Error && error.name==='AbortError'))throw error
  })
}
