import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {access,mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:net'
import {fileURLToPath} from 'node:url'

const projectRoot=fileURLToPath(new URL('../../',import.meta.url))
const root=await mkdtemp(join(tmpdir(),process.argv.includes('--p5')?'yanxing-p5-browser-':'yanxing-p4-browser-'))
const releaseRoot=process.env.P5_RELEASE_ROOT
const children=[]
const env={...process.env,NODE_ENV:'production',...(releaseRoot?{YANXING_COMPILED_RUNTIME:'1'}:{}),YANXING_NEXT_DIST_DIR:process.env.YANXING_NEXT_DIST_DIR??'.next-p4-qa',YANXING_DATABASE_PATH:join(root,'app.sqlite'),YANXING_KNOWLEDGE_STORAGE_ROOT:join(root,'knowledge'),YANXING_SETTINGS_ENCRYPTION_KEY:'browser-only-isolated-test-key',YANXING_CHAT_COMPLETIONS_API_KEY:'',YANXING_WORKER_READY_PATH:join(root,'worker-ready'),YANXING_WORKER_HEARTBEAT_PATH:join(root,'worker-heartbeat.json'),YANXING_INSTANCE_TOKEN:'p4-browser-isolated-worker',P4_BROWSER_ROOT:root}
let socket,sessionId,nextLog='',chromeLog='',workerLog=''
const pending=new Map(),errors=[]
let sequence=0,dropConfirmation=true,authRequests=0,prepareRequests=0
const confirmations=[]
const delay=ms=>new Promise(done=>setTimeout(done,ms))
async function waitFor(check,label){for(let i=0;i<100;i++){try{if(await check())return}catch{}await delay(100)}throw new Error('Timeout: '+label)}
function child(command,args,options={}){const result=spawn(command,args,{cwd:projectRoot,env,...options});children.push(result);return result}
function call(method,params={},session){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},10000);pending.set(id,{resolve,reject,timer});try{socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}))}catch(error){clearTimeout(timer);pending.delete(id);reject(error)}})}
const page=(method,params={})=>call(method,params,sessionId)
async function evaluate(expression){const result=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}
const text=()=>evaluate('document.body.innerText')
async function click(label){await waitFor(()=>evaluate('(()=>{const el=[...document.querySelectorAll("button")].find(el=>el.innerText.trim()==='+JSON.stringify(label)+');return Boolean(el&&!el.disabled)})()'),'enabled button: '+label);await evaluate('(()=>{const el=[...document.querySelectorAll("button")].find(el=>el.innerText.trim()==='+JSON.stringify(label)+');if(!el)throw Error("Missing button");el.click()})()')}
async function screenshot(name){await delay(850);const image=await page('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(image.data,'base64'))}
async function navigate(url){const marker=String(Date.now())+Math.random();await evaluate('window.__p4NavigationMarker='+JSON.stringify(marker));await page('Page.navigate',{url});await waitFor(()=>evaluate('window.__p4NavigationMarker!=='+JSON.stringify(marker)+'&&document.readyState==="complete"'),'new document ready');await delay(700)}
async function api(path,body,requestOptions={}){
  const options={method:body?'POST':'GET',...requestOptions,headers:{'Content-Type':'application/json',...requestOptions.headers},...(body?{body:JSON.stringify(body)}:{})}
  return evaluate('(async()=>{const options='+JSON.stringify(options)+';const token=document.cookie.split("; ").find(x=>x.split("=")[0].endsWith("yanxing_csrf"))?.split("=").slice(1).join("=");options.headers["x-yanxing-csrf"]=decodeURIComponent(token??"");const response=await fetch('+JSON.stringify(path)+',options);return {status:response.status,body:await response.json()}})()')
}
try {
  const seeded=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),resolve(projectRoot,'test/helpers/native-browser-seed.ts')],{cwd:projectRoot,env,encoding:'utf8'})
  if(seeded.status!==0)throw Error(seeded.stderr)
  const worker=child(process.execPath,[resolve(releaseRoot??projectRoot,'.runtime/worker/index.mjs')],{cwd:releaseRoot??projectRoot})
  worker.stdout.on('data',data=>workerLog+=data);worker.stderr.on('data',data=>workerLog+=data)
  await waitFor(async()=>{await access(env.YANXING_WORKER_READY_PATH);return true},'native default Worker readiness')
  const reservation=createServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));const port=reservation.address().port;await new Promise(done=>reservation.close(done))
  const base='http://localhost:'+port
  const next=releaseRoot
    ?child(process.execPath,[resolve(releaseRoot,'server.js')],{cwd:releaseRoot,env:{...env,PORT:String(port),HOSTNAME:'127.0.0.1'}})
    :child(process.execPath,[resolve(projectRoot,'node_modules/next/dist/bin/next'),'start','-p',String(port),'--hostname','127.0.0.1'])
  next.stdout.on('data',data=>nextLog+=data);next.stderr.on('data',data=>nextLog+=data)
  await waitFor(async()=>{const response=await fetch(base+'/login');return response.ok},'isolated Next server')
  const chrome=child('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--remote-debugging-port=0','--user-data-dir='+join(root,'chrome'),'about:blank'])
  chrome.stderr.on('data',data=>chromeLog+=data)
  await waitFor(()=>chromeLog.includes('DevTools listening on ws:'),'Chrome CDP')
  socket=new WebSocket(chromeLog.split('DevTools listening on ')[1].trim().split(String.fromCharCode(10))[0])
  await new Promise((done,fail)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',fail,{once:true})})
  socket.addEventListener('message',event=>{void (async()=>{
    const message=JSON.parse(String(event.data))
    if(message.id){const promise=pending.get(message.id);pending.delete(message.id);clearTimeout(promise?.timer);if(message.error)promise?.reject(Error(message.error.message));else promise?.resolve(message.result)}
    if(message.method==='Network.requestWillBeSent'&&new URL(message.params.request.url).pathname==='/api/auth/me')authRequests++
    if(message.method==='Network.requestWillBeSent'&&message.params.request.method==='POST'&&new URL(message.params.request.url).pathname.endsWith('/report-uploads'))prepareRequests++
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text)
    if(message.method==='Fetch.requestPaused'){
      const request=message.params.request
      if(request.method==='POST')confirmations.push({command:request.postData,key:Object.entries(request.headers).find(([name])=>name.toLowerCase()==='idempotency-key')?.[1]})
      const shouldDrop=dropConfirmation&&request.method==='POST'&&message.params.responseStatusCode>=200&&message.params.responseStatusCode<300
      if(shouldDrop)dropConfirmation=false
      await call(shouldDrop?'Fetch.failRequest':'Fetch.continueResponse',{requestId:message.params.requestId,...(shouldDrop?{errorReason:'ConnectionClosed'}:{})},message.sessionId)
    }
  })().catch(error=>errors.push(String(error)))})
  const target=await call('Target.createTarget',{url:'about:blank'});sessionId=(await call('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId
  socket.addEventListener('close',()=>{for(const promise of pending.values()){clearTimeout(promise.timer);promise.reject(Error('Browser transport closed'))}pending.clear()})
  await page('Page.enable');await page('Runtime.enable');await page('Network.enable');await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await navigate(base+'/login')
  await waitFor(()=>evaluate('Boolean(document.querySelector("input[type=password]"))'),'login form')
  await evaluate('(()=>{const fields=[...document.querySelectorAll("input")];const username=fields.find(x=>x.type!=="password"&&x.type!=="checkbox"&&x.type!=="hidden");const password=fields.find(x=>x.type==="password");for(const [el,value]of [[username,"browser-admin"],[password,"browser-test-password"]]){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}))}})()')
  await evaluate('document.querySelector("form").requestSubmit()')
  await waitFor(()=>evaluate('!location.pathname.includes("login")'),'authenticated workspace')
  await waitFor(()=>evaluate('[...document.querySelectorAll("button")].some(x=>x.innerText.includes("新建课题"))'),'native overview')
  await waitFor(()=>evaluate('Boolean(document.querySelector("[aria-label=分析质量全景]"))'),'original overview quality panel')
  await screenshot('01-overview')
  await click('新建课题');await waitFor(()=>evaluate('Boolean(document.querySelector("#guide-project-title"))'),'original full-page setup guide')
  await evaluate('(()=>{for(const [id,value]of [["guide-project-title","浏览器验收课题"],["guide-project-objective","验证研究目标与证据"],["guide-project-description","浏览器隔离环境研究背景"]]){const el=document.getElementById(id);Object.getOwnPropertyDescriptor(el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}))}})()')
  await screenshot('02-create-project');await click('下一步');await click('下一步');await click('下一步');await click('设立课题并开启研究')
  await waitFor(async()=>{const result=await api('/api/projects');return result.body.projects?.length===1},'created native project')
  const listed=await api('/api/projects');const project=listed.body.projects[0]
  let detail=(await api('/api/projects/'+project.id)).body
  const first=detail.stages[0].stage
  const edited=await api('/api/projects/'+project.id+'/stages',{expectedPlanRevision:detail.workflow.planRevision,nextStages:[{id:first.id,title:first.title,description:first.description,plannedStartAt:first.plannedStartAt,plannedEndAt:first.plannedEndAt},{id:'browser-final-stage',title:'成果总结',description:'汇总最终研究成果',plannedEndAt:'2030-03-01'},{id:'browser-removable-stage',title:'草稿校验阶段',description:'验证阶段移除时保留已选文件',plannedEndAt:'2030-04-01'}]},{method:'PATCH'})
  assert.equal(edited.status,200,JSON.stringify(edited.body))
  await navigate(base+'/?view=dashboard&project='+project.id)
  await waitFor(()=>evaluate('Boolean(document.querySelector("button[aria-label=本次交付阶段]"))'),'onboarding stage selector')
  assert.equal(await evaluate('Boolean(document.querySelector("header [aria-label=阶段与报告选择]"))'),false,'empty dashboard has no duplicate toolbar')
  assert.equal(await evaluate('Boolean(document.querySelector("header h1"))'),true,'project overview remains visible')
  async function chooseDeliveryStage(title){
    await evaluate('document.querySelector("button[aria-label=本次交付阶段]").click()')
    await waitFor(()=>evaluate('[...document.querySelectorAll("[role=option]")].some(el=>el.innerText.includes('+JSON.stringify(title)+'))'),'delivery stage options')
    await evaluate('[...document.querySelectorAll("[role=option]")].find(el=>el.innerText.includes('+JSON.stringify(title)+')).click()')
  }
  await screenshot('03-empty-current-stage')
  const browsingUrl=await evaluate('location.href')
  await chooseDeliveryStage('草稿校验阶段')
  assert.equal(await evaluate('location.href'),browsingUrl,'draft selection must not navigate')
  await waitFor(()=>evaluate('Boolean(document.querySelector("[aria-label=本次报告类型]"))'),'report types visible beside stage selector')
  await waitFor(()=>evaluate('Boolean(document.querySelector("input[type=file]"))'),'single-page first-report upload')
  assert.equal(await evaluate('document.querySelector("[aria-label=本次报告类型] input[value=update]").checked'),true)
  assert.ok((await text()).includes('将跳过并完成 2 个前置阶段'))
  await chooseDeliveryStage(first.title)
  await evaluate('document.querySelector("[aria-label=本次报告类型] input[value=completion]").click()')
  const document=await page('DOM.getDocument');const node=await page('DOM.querySelector',{nodeId:document.root.nodeId,selector:'input[type=file]'})
  await page('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[join(root,'研究报告.docx')]})
  await waitFor(()=>evaluate('[...document.querySelectorAll("button")].some(el=>el.innerText==="上传报告"&&!el.disabled)'),'first-report file ready')
  assert.equal(await evaluate('[...document.querySelectorAll("[aria-label=研究报告交付引导] button")].some(el=>/调整研究计划|编辑课题信息/.test(el.innerText))'),false,'onboarding no longer exposes plan or metadata editors')
  await screenshot('04-confirm-impact');await evaluate('(()=>{const button=[...document.querySelectorAll("button")].find(el=>el.innerText==="上传报告");button.click();button.click()})()')
  await waitFor(()=>evaluate('[...document.querySelectorAll("button")].some(el=>el.innerText==="确认提交"&&!el.disabled)'),'prepared document')
  assert.equal(prepareRequests,1,'double click prepares only one upload')
  assert.equal((await api('/api/projects/'+project.id)).body.project.submittedReportCount,0,'parsing does not formally submit')
  await screenshot('05-prepared-not-submitted')
  await page('Fetch.enable',{patterns:[{urlPattern:'*/api/projects/*/reports',requestStage:'Response'}]})
  await click('确认提交')
  await waitFor(async()=>(await text()).includes('重试同一提交'),'unknown confirmation result')
  await screenshot('06-uncertain-confirmation')
  await click('稍后确认')
  await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'),'deferred confirmation dialog')
  await click('继续处理已有提交')
  await waitFor(async()=>(await text()).includes('重试同一提交'),'reopened original confirmation from onboarding')
  await click('重试同一提交')
  await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'),'idempotent confirmation recovery')
  await page('Fetch.disable')
  assert.equal(confirmations.length,2)
  assert.ok(confirmations[0].key)
  assert.deepEqual(confirmations[1],confirmations[0],'retry must preserve command and idempotency key')
  await waitFor(async()=>{const result=await api('/api/projects/'+project.id);return result.body.project?.submittedReportCount===1},'formal native submission')
  detail=(await api('/api/projects/'+project.id)).body
  assert.equal(detail.stages[1].stage.lifecycleStatus,'in_progress')
  assert.equal(detail.stages[0].reports[0].stageVersion,1)
  assert.equal(detail.stages[0].reports[0].submissionSequence,1)
  const reportId=detail.stages[0].reports[0].id
  const analysisUrl=await evaluate('location.href')
  const analysisParams=new URL(analysisUrl).searchParams
  assert.equal(analysisParams.get('view'),'dashboard','successful submission opens analysis')
  assert.equal(analysisParams.get('report'),reportId,'submission pins the receipt report instead of the next empty stage')
  assert.equal(analysisParams.get('stage'),first.id)
  assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=研究报告交付引导]"))'),false,'successful submission removes the upload form')
  await navigate(analysisUrl)
  await waitFor(()=>evaluate('Boolean(document.querySelector("[class*=report-board]"))'),'refresh keeps the submitted report analysis')
  assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=研究报告交付引导]"))'),false)
  const refused=await api('/api/reports/'+reportId,{stageId:'browser-final-stage'},{method:'PATCH'});assert.equal(refused.status,409)
  await navigate(base+'/?view=dashboard&project='+project.id)
  await waitFor(async()=>(await text()).includes('本阶段暂无报告'),'new current stage empty state')
  await screenshot('07-advanced-current-stage')
  assert.equal(await evaluate('Boolean(document.querySelector("header [aria-label=阶段与报告选择]"))'),false,'next empty stage also owns its actions')
  assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=已有报告入口]"))'),false,'empty stages omit the removed report footer')
  await click('历史');await waitFor(()=>evaluate('Boolean(document.querySelector("[aria-label=报告版本历史]"))'),'history navigation opens reports')
  assert.equal(await evaluate('Boolean(document.querySelector("header [aria-label=阶段与报告选择]"))'),false,'history omits header stage/report controls')
  await click('查看报告');await waitFor(()=>evaluate('Boolean(document.querySelector("[class*=report-board]"))'),'existing report remains accessible through history')
  assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=研究报告交付引导]"))'),false,'report selection opens analysis without onboarding')
  await navigate(base+'/?view=dashboard&project='+project.id+'&stage=browser-final-stage')
  await waitFor(()=>evaluate('Boolean(document.querySelector("button[aria-label=本次交付阶段]"))'),'empty stage draft')
  await chooseDeliveryStage(first.title)
  await waitFor(async()=>(await text()).includes('不再接受阶段报告'),'completed stage invalidates update explicitly')
  assert.equal(await evaluate('[...document.querySelectorAll("[aria-label=本次报告类型] input[type=radio]")].some(el=>el.checked)'),false)
  assert.equal(await evaluate('[...document.querySelectorAll("button")].find(el=>el.innerText==="上传报告").disabled'),true,'explicit completion selection is required')
  assert.equal(await evaluate('document.querySelector("[aria-label=本次报告类型] input[value=update]").disabled'),true)
  await chooseDeliveryStage('成果总结')
  const fileStatus=await evaluate('(async()=>{const response=await fetch("/api/reports/'+reportId+'/file",{headers:{Range:"bytes=0-9"}});return {status:response.status,bytes:(await response.arrayBuffer()).byteLength}})()')
  assert.deepEqual(fileStatus,{status:206,bytes:10})
  assert.equal((await api('/api/reports/'+reportId,{reason:'验收当前完结报告保护'},{method:'DELETE'})).status,409)
  await page('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
  await screenshot('08-mobile')
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false,'mobile horizontal overflow')
  await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  const reader=await api('/api/admin/users',{username:'onboarding-reader',displayName:'引导只读验收员',password:'onboarding-reader-password',role:'researcher'})
  assert.equal(reader.status,201)
  const membership=await api('/api/admin/projects/'+project.id+'/members')
  const members=membership.body.members.map(member=>({userId:member.userId,role:member.role}))
  assert.equal((await api('/api/admin/projects/'+project.id+'/members',{revision:membership.body.revision,members:[...members,{userId:reader.body.user.id,role:'editor'}]},{method:'PUT'})).status,200)
  await api('/api/auth/logout',{})
  assert.equal((await api('/api/auth/login',{username:'onboarding-reader',password:'onboarding-reader-password'})).status,200)
  await navigate(base+'/?view=dashboard&project='+project.id+'&stage=browser-final-stage')
  await waitFor(async()=>(await text()).includes('只读权限查看该课题'),'read-only notice appears immediately')
  assert.equal(await evaluate('[...document.querySelectorAll("[aria-label=研究报告交付引导] button")].some(el=>/上传报告|解析文件|编辑课题信息|调整研究计划/.test(el.innerText))'),false,'read-only onboarding exposes no write actions')
  assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=已有报告入口]"))'),false,'read-only onboarding omits the removed report footer')
  await screenshot('08b-read-only-onboarding')
  await api('/api/auth/logout',{})
  assert.equal((await api('/api/auth/login',{username:'browser-admin',password:'browser-test-password'})).status,200)
  await navigate(base+'/?view=dashboard&project='+project.id+'&stage=browser-final-stage')
  await waitFor(()=>evaluate('Boolean(document.querySelector("button[aria-label=本次交付阶段]"))'),'restore administrative session')
  assert.deepEqual(errors,[])
  assert.ok(authRequests>0&&authRequests<=8,'startup must not flood or repeatedly abort authentication requests')
  const extended=process.argv.includes('--p5')?await (await import('./p5-browser-checks.mjs')).runP5BrowserChecks({api,page,evaluate,click,navigate,text,waitFor,screenshot,base,projectId:project.id,reportId}):undefined
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({ok:true,root,projectId:project.id,reportId,screenshots:9,confirmationRequests:confirmations.length,authRequests,paidProviderCalls:0,extended}))
} catch(error) {
  await screenshot('failure').catch(()=>{})
  console.error(String(error));console.error('Browser text:',await text().catch(()=>''));console.error('Browser errors:',errors)
  process.exitCode=1
} finally {
  socket?.close()
  for(const process of children)process.kill('SIGTERM')
  await delay(500)
  for(const process of children)if(process.exitCode===null)process.kill('SIGKILL')
  await writeFile(join(root,'next.log'),nextLog)
  await writeFile(join(root,'chrome.log'),chromeLog)
  await writeFile(join(root,'worker.log'),workerLog)
  console.log('Isolated QA artifacts: '+root)
}
