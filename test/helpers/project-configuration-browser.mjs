import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Actual WorkspaceApp, mocked API: never seed, authenticate, or start an app server.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const output = await mkdtemp(join(tmpdir(), 'yanxing-configuration-browser-'))
const profile = join(output, 'chrome-profile')
const base = process.env.CONFIGURATION_BROWSER_URL || 'http://localhost:3000'
const requests = [], browserErrors = [], unexpected = [], checks = []
const pending = new Map()
let chrome, socket, sessionId, sequence = 0, chromeLog = '', scenario
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function fixture(options = {}) {
  const project = { id: 'qa-project', ownerId: 'owner', ownerName: '原负责人', collaboratorNames: '研究协作者', title: '配置浏览器验收课题', objective: '原研究目标', description: '仅浏览器内存中的研究背景', memberRole: 'editor', canManage: true, canSubmit: false, canEditPlan: true, canDelete: false, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z', submittedReportCount: 0, completedStageCount: 0 }
  const stages = [1, 2].map(ordinal => ({ stage: { id: 'stage-' + ordinal, projectId: project.id, ordinal, title: '研究阶段' + ordinal, description: '阶段研究工作', lifecycleStatus: ordinal === 1 ? 'in_progress' : 'not_started', nextReportVersion: 1, stateRevision: 1, completionRevision: 0, plannedStartAt: '2030-01-01', plannedEndAt: '2030-03-01' }, stageLabel: '阶段 ' + ordinal, skippedEmpty: false, reports: [], canSubmitUpdate: false, canSubmitCompletion: false }))
  return { ...options, detail: { project, stages, workflow: { planRevision: 7, workflowRevision: 3, nextSubmissionSequence: options.frozen ? 2 : 1, currentStageId: 'stage-1' }, currentCompletionByStage: {}, selected: { stageId: 'stage-1', source: 'current_stage' } }, members: { revision: 11, members: [{ userId: 'owner', role: 'owner', displayName: '原负责人' }, { userId: 'editor', role: 'editor', displayName: '研究协作者' }] } }
}
const users = [{ id: 'owner', username: 'owner', displayName: '原负责人', role: 'researcher' }, { id: 'new-owner', username: 'new-owner', displayName: '新负责人', role: 'researcher' }, { id: 'editor', username: 'editor', displayName: '研究协作者', role: 'researcher' }]
const paginated = (key, items) => ({ [key]: items, total: items.length, offset: 0, limit: 100, hasMore: false })
function responseFor(request) {
  const path = new URL(request.url).pathname
  const method = request.method
  const body = request.postData ? JSON.parse(request.postData) : undefined
  requests.push({ path, method, body })
  if (method === 'GET') {
    if (path === '/api/auth/me') return { user: { ...users[2], role: scenario.admin ? 'admin' : 'researcher' } }
    if (path === '/api/users') return paginated('users', users)
    if (path === '/api/projects') return paginated('projects', [scenario.detail.project])
    if (path === '/api/projects/qa-project') return scenario.detail
    if (path === '/api/admin/projects/qa-project/members') return scenario.members
    if (path === '/api/reports') return paginated('reports', [])
    if (path === '/api/knowledge') return paginated('items', [])
    if (path === '/api/notifications') return { notifications: [], unreadCount: 0 }
    if (path === '/api/overview-stats') return { submittedReportCount: 0, totalCharacters: 0, knowledgeCount: 0, knowledgeCategoryCount: 0, weeklyNewReports: 0, weeklyNewKnowledge: 0, completedStageCount: 0, jobStats: { completed: 0, failed: 0, cancelled: 0, running: 0, queued: 0 }, trends: { submissions: [], characters: [], successRate: [], knowledge: [], averageScore: [], analyzedProjects: [] } }
  }
  if (method === 'PATCH' && path === '/api/projects/qa-project') {
    const { expectedUpdatedAt, ...metadata } = body
    assert.equal(expectedUpdatedAt, scenario.detail.project.updatedAt, 'metadata CAS token')
    Object.assign(scenario.detail.project, metadata, { updatedAt: '2030-01-02T00:00:00Z' })
    return { project: scenario.detail.project }
  }
  if (method === 'PATCH' && path === '/api/projects/qa-project/stages') {
    if (scenario.conflict) return { __status: 409, code: 'PLAN_REVISION_CONFLICT', error: '计划版本冲突，请重新载入' }
    scenario.detail.stages = body.nextStages.map((stage, index) => ({ ...scenario.detail.stages[index], stage: { ...scenario.detail.stages[index].stage, ...stage } }))
    scenario.detail.workflow.planRevision++
    return { stages: scenario.detail.stages, workflow: scenario.detail.workflow }
  }
  if (method === 'PUT' && path === '/api/admin/projects/qa-project/members') {
    scenario.members = { ...body, revision: body.revision + 1 }
    scenario.detail.project.ownerId = body.members.find(member => member.role === 'owner').userId
    return scenario.members
  }
  unexpected.push(method + ' ' + path)
  return { __status: 501, error: 'Unmocked API blocked: ' + method + ' ' + path }
}
function call(method, params = {}, session) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
}
const page = (method, params = {}) => call(method, params, sessionId)
async function evaluate(expression) {
  const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(check, label) {
  let lastError
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await check()) return } catch (error) { lastError = error }
    await pause(100)
  }
  throw new Error('Timeout: ' + label + (lastError ? '; ' + lastError.message : ''))
}
async function click(label) {
  const expression = '([...document.querySelectorAll("button")].find(el => el.innerText.trim() === ' + JSON.stringify(label) + '))'
  await waitFor(() => evaluate('Boolean(' + expression + ' && !' + expression + '.disabled)'), 'enabled button ' + label)
  await evaluate(expression + '.click()')
}
async function fill(selector, value) {
  await evaluate('(() => { const el=document.querySelector(' + JSON.stringify(selector) + '); if (!el || el.matches(":disabled")) throw Error("Missing or disabled field: " + ' + JSON.stringify(selector) + '); Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set.call(el,' + JSON.stringify(value) + '); el.dispatchEvent(new Event("input", {bubbles:true})); })()')
}
async function screenshot(name) {
  await pause(250)
  const image = await page('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, name + '.png'), Buffer.from(image.data, 'base64'))
}
async function layoutCheck(name) {
  const dimensions = await evaluate('(() => { const dialog = document.querySelector("[role=dialog]"); const r=dialog.getBoundingClientRect(); return { viewport: innerWidth, body: document.documentElement.scrollWidth, dialog: dialog.scrollWidth, client: dialog.clientWidth, left:r.left, right:r.right }; })()')
  assert.ok(dimensions.body <= dimensions.viewport && dimensions.dialog <= dimensions.client + 1 && dimensions.left >= 0 && dimensions.right <= dimensions.viewport + 1, name + ': horizontal overflow ' + JSON.stringify(dimensions))
  checks.push({ name, dimensions })
}
const mutations = () => requests.filter(request => request.method !== 'GET')
let bundle
async function mount(options = {}) {
  scenario = fixture(options)
  requests.length = 0
  await page('Page.navigate', { url: base + '/login' })
  await waitFor(() => evaluate('document.readyState === "complete" && Boolean(document.querySelector("input[type=password]"))'), 'login CSS shell')
  await evaluate('history.replaceState(null,"","/?view=dashboard&project=qa-project"); document.body.replaceChildren();')
  await evaluate(bundle)
  await click('修改课题')
  await waitFor(() => evaluate('Boolean(document.querySelector("#configuration-title"))'), 'actual configuration dialog')
}
async function saveAndWait() {
  await click('保存课题配置')
  await waitFor(() => evaluate('!document.querySelector("#configuration-title") && !document.querySelector("nav[aria-label=配置分区]")'), 'configuration saved and closed')
}
async function runScenarios() {
  await mount()
  assert.ok(await evaluate('document.querySelector("[role=dialog]").className.includes("max-w-4xl")'), 'restored 4xl dialog')
  for (const label of ['01 课题信息', '02 研究团队', '03 计划与排期', '保存课题配置']) assert.ok(await evaluate('document.body.innerText.includes(' + JSON.stringify(label) + ')'), label)
  await layoutCheck('desktop information')
  await screenshot('01-desktop-information')
  await click('02 研究团队')
  assert.equal(await evaluate('document.querySelector("[aria-label=课题负责人]").disabled'), true, 'editor owner selector disabled')
  assert.equal(requests.some(request => request.path.includes('/admin/')), false, 'editor never requests admin members')
  await click('01 课题信息')
  await fill('#configuration-objective', '更新研究目标，不影响报告快照')
  await saveAndWait()
  assert.deepEqual(mutations().map(request => request.path), ['/api/projects/qa-project'], 'metadata-only save has no plan or members write')
  checks.push({ name: 'editor metadata-only save and owner permissions' })

  await mount({ frozen: true })
  await click('03 计划与排期')
  const frozenControls = await evaluate('[...document.querySelectorAll("button")].filter(el => /删除阶段|上移阶段|下移阶段/.test(el.getAttribute("aria-label") || "") || el.innerText.includes("新增研究阶段")).map(el => el.disabled)')
  assert.equal(frozenControls.length, 7, 'two stages expose six structural buttons plus add')
  assert.ok(frozenControls.every(Boolean), 'frozen structural controls disabled')
  await fill('[aria-label="阶段 1 名称"]', '冻结后修改的阶段名称')
  await fill('[aria-label="阶段 1 计划完成日期"]', '2030-04-01')
  await screenshot('02-desktop-frozen-plan')
  await saveAndWait()
  assert.deepEqual(mutations().map(request => request.path), ['/api/projects/qa-project/stages'])
  assert.equal(mutations()[0].body.expectedPlanRevision, 7)
  assert.equal(mutations()[0].body.nextStages[0].plannedEndAt, '2030-04-01')
  checks.push({ name: 'editor frozen plan permits name/date saves with revision' })

  await mount({ admin: true })
  await click('02 研究团队')
  await waitFor(() => evaluate('!document.querySelector("[aria-label=课题负责人]").disabled'), 'admin owner selector loaded')
  await evaluate('document.querySelector("[aria-label=课题负责人]").click()')
  await waitFor(() => evaluate('[...document.querySelectorAll("[role=option]")].some(el => el.innerText.includes("新负责人"))'), 'new owner option')
  await evaluate('[...document.querySelectorAll("[role=option]")].find(el => el.innerText.includes("新负责人")).click()')
  await click('01 课题信息')
  await saveAndWait()
  const membership = mutations().find(request => request.method === 'PUT')
  assert.equal(membership.body.revision, 11)
  assert.deepEqual(membership.body.members, [{ userId: 'new-owner', role: 'owner' }, { userId: 'editor', role: 'editor' }])
  checks.push({ name: 'admin owner PUT retains revision and collaborator' })

  await mount({ conflict: true })
  await fill('#configuration-title', '信息保存但计划冲突')
  await click('03 计划与排期')
  await fill('[aria-label="阶段 1 名称"]', '冲突中的阶段草稿')
  await click('保存课题配置')
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=alert]"))'), 'partial save conflict alert')
  const alert = await evaluate('document.querySelector("[role=alert]").innerText')
  assert.match(alert, /课题信息.*已保存|已保存.*课题信息/)
  assert.ok(await evaluate('[...document.querySelectorAll("button")].some(el => el.innerText === "保存课题配置" && el.disabled)'), 'conflict locks saving')
  assert.equal(mutations().length, 2)
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify('[aria-label="阶段 1 名称"]') + ').value'), '冲突中的阶段草稿')
  await screenshot('03-desktop-partial-save')
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await layoutCheck('mobile plan conflict')
  await screenshot('04-mobile-partial-save')
  await click('01 课题信息')
  await layoutCheck('mobile information')
  await screenshot('05-mobile-information')
  checks.push({ name: 'metadata success / plan 409 remains open, preserves draft and locks writes', alert })
}
try {
  const result = await build({ entryPoints: [join(projectRoot, 'test/helpers/project-configuration-browser-entry.tsx')], absWorkingDir: projectRoot, plugins: [{ name: 'next-image-interop', setup(builder) { builder.onResolve({ filter: /^next\/image$/ }, () => ({ path: 'next-image', namespace: 'qa-next' })); builder.onLoad({ filter: /.*/, namespace: 'qa-next' }, () => ({ contents: 'export { Image as default } from "next/dist/client/image-component"', resolveDir: projectRoot })); } }], bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' }, tsconfig: join(projectRoot, 'tsconfig.json') })
  bundle = result.outputFiles[0].text
  chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.stderr.on('data', data => { chromeLog += data })
  await waitFor(() => chromeLog.includes('DevTools listening on ws:'), 'Chrome startup')
  socket = new WebSocket(chromeLog.split('DevTools listening on ')[1].trim().split(String.fromCharCode(10))[0])
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id) {
      const promise = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(promise?.timer)
      if (message.error) promise?.reject(new Error(message.error.message)); else promise?.resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    if (message.method === 'Fetch.requestPaused') {
      let body
      try { body = responseFor(message.params.request) }
      catch (error) { browserErrors.push(error.stack); body = { __status: 500, error: 'Fixture failed: ' + error.message } }
      const responseCode = body.__status || 200
      delete body.__status
      void call('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }, message.sessionId).catch(error => browserErrors.push(error.message))
    }
  })
  const target = await call('Target.createTarget', { url: 'about:blank' })
  sessionId = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await page('Page.enable')
  await page('Runtime.enable')
  await page('Network.enable')
  // Keep server-rendered login CSS but prevent its unrelated hydration from owning the fixture DOM.
  await page('Network.setBlockedURLs', { urls: ['*/_next/static/chunks/*.js*'] })
  // Request-stage interception applies before navigation: no real API request can leave the page.
  await page('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await runScenarios()
  assert.deepEqual(unexpected, [], 'all API calls explicitly mocked')
  assert.deepEqual(browserErrors, [], 'no browser runtime exceptions')
  await writeFile(join(output, 'result.json'), JSON.stringify({ mockedApi: true, checks, requests, browserErrors }, null, 2))
  console.log(JSON.stringify({ status: 'passed', mockedApi: true, checks, artifacts: output }, null, 2))
} catch (error) {
  if (sessionId) await screenshot('failure').catch(() => {})
  console.error(JSON.stringify({ status: 'failed', error: error.stack, browserErrors, unexpected, requests, artifacts: output }, null, 2))
  process.exitCode = 1
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close').catch(() => {}); socket.close() }
  for (const request of pending.values()) clearTimeout(request.timer)
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM')
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), pause(3000)])
    if (chrome.exitCode === null) chrome.kill('SIGKILL')
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
}
