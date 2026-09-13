import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parserChildSpawnArguments,
  resolveParserChildRuntime,
} from '../lib/documents/parser-child-runtime.mjs'
import {
  createMinimalDocxBuffer,
  createMinimalPdfBuffer,
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
} from './deployment-fixtures.mjs'

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
const DEFAULT_USERNAME = 'admin'
const DEFAULT_MODEL_HOST = '127.0.0.1'
const MANIFEST_VERSION = 1
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const NATIVE_AI_FAILURE_CODES = new Set([
  'MODEL_EXECUTION_FAILED',
  'QUALITY_GATE_FAILED',
  'WORKER_EXECUTION_FAILED',
  'AI_CALL_INCOMPLETE',
])
const AUTOMATIC_REPLAY_BLOCKED_CODES = new Set(['AI_CALL_INCOMPLETE'])
const PARSER_PATH_FAILURE = /无法定位|解析进程启动失败|Cannot find module|ERR_MODULE_NOT_FOUND/
const PARSER_CHILD_TIMEOUT_MS = 30_000
const DEFAULT_PARSER_MEMORY_MB = 256
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_MS = 1_000
const JOB_EVENTS_TIMEOUT_MS = 2_000
const STAGE_DESCRIPTION_LIMIT = 300
const SMOKE_CHANNEL_NAME = 'deployment-smoke'
const SMOKE_MODEL_NAME = 'deployment-smoke-model'
const SMOKE_API_KEY = 'deployment-smoke-key'
const SMOKE_MODEL_CONTEXT_CHARACTERS = 8_000
const SMOKE_MODEL_OUTPUT_TOKENS = 256
const FALLBACK_ASSIGNMENT_TARGETS = ['page_analysis', 'report_insight']
const COMPLETION_RETAINED_WARNING = 'formal completion retained; native report data will not be physically deleted'
export const SMOKE_STAGE_PLAN_DATES = [
  { plannedStartAt: '2026-03-01', plannedEndAt: '2026-06-30' },
  { plannedStartAt: '2026-07-01', plannedEndAt: '2026-12-31' },
]

export function smokeStagePlanDates(index) {
  return SMOKE_STAGE_PLAN_DATES[Math.min(Math.max(index, 0), SMOKE_STAGE_PLAN_DATES.length - 1)]
}

export function smokeStageIds(marker) {
  const token = String(marker ?? 'smoke').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'smoke'
  return {
    first: `smoke-${token}-s1`,
    second: `smoke-${token}-s2`,
  }
}

export class SmokeError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message)
    this.name = 'SmokeError'
    this.exitCode = exitCode
  }
}

export function usage() {
  return `YanXing production deployment smoke.

Required:
  YANXING_SMOKE_ALLOW_MUTATIONS=true
  YANXING_SMOKE_PASSWORD=<admin password>

Optional:
  YANXING_SMOKE_BASE_URL=${DEFAULT_BASE_URL}
  YANXING_SMOKE_USERNAME=${DEFAULT_USERNAME}
  YANXING_SMOKE_MARKER=<stable marker>
  YANXING_SMOKE_MANIFEST_PATH=<cwd>/storage/.deployment-smoke.json
  YANXING_SMOKE_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS}
  YANXING_SMOKE_MODEL_HOST=${DEFAULT_MODEL_HOST}  (same-container mock; default 127.0.0.1)
  YANXING_SMOKE_EXPECTED_FAILURE=<unique token returned by the in-process model stub>

Native protocol:
  POST /api/projects with stages, PATCH /api/projects/:id/stages,
  raw POST /api/projects/:id/report-uploads?fileName=, then JSON POST /api/projects/:id/reports
  with Idempotency-Key. Analysis and insight are polled independently.
  Project DELETE is rejected (409 retention). Formal completions are not physically deleted.

Usage:
  node scripts/deployment-smoke.mjs
  node scripts/deployment-smoke.mjs --verify
`
}

export async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  const config = readConfig(args)
  const client = new SmokeClient(config)
  if (config.verify) {
    console.log(JSON.stringify(await runVerify({ client, config }), null, 2))
    return
  }
  const mock = await startMockModelServer(config.expectedFailure)
  try {
    log('mock-model', `http://${config.modelHost}:${mock.port}/v1`)
    console.log(JSON.stringify(await runFull({ client, config, modelPort: mock.port }), null, 2))
  } finally {
    await closeMockServer(mock.server)
  }
}

export function parseArgs(argv) {
  let verify = false
  let help = false
  for (const argument of argv) {
    if (argument === '--verify') verify = true
    else if (argument === '--help' || argument === '-h') help = true
    else throw new SmokeError(`未知参数：${argument}`, { exitCode: 2 })
  }
  return { verify, help }
}

export function readConfig(args) {
  if (process.env.YANXING_SMOKE_ALLOW_MUTATIONS !== 'true') {
    throw new SmokeError('必须设置 YANXING_SMOKE_ALLOW_MUTATIONS=true 才会执行会写入数据的冒烟测试。', { exitCode: 2 })
  }
  const password = process.env.YANXING_SMOKE_PASSWORD ?? ''
  if (!password) throw new SmokeError('必须设置 YANXING_SMOKE_PASSWORD。', { exitCode: 2 })
  const marker = trimOrDefault(process.env.YANXING_SMOKE_MARKER, createMarker())
  return {
    verify: args.verify,
    baseUrl: trimOrDefault(process.env.YANXING_SMOKE_BASE_URL, DEFAULT_BASE_URL).replace(/\/$/, ''),
    username: trimOrDefault(process.env.YANXING_SMOKE_USERNAME, DEFAULT_USERNAME),
    password,
    marker,
    manifestPath: trimOrDefault(
      process.env.YANXING_SMOKE_MANIFEST_PATH,
      path.join(process.cwd(), 'storage', '.deployment-smoke.json'),
    ),
    timeoutMs: readPositiveInteger(process.env.YANXING_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    pollMs: readPositiveInteger(process.env.YANXING_SMOKE_POLL_MS, DEFAULT_POLL_MS),
    modelHost: readModelHost(process.env.YANXING_SMOKE_MODEL_HOST),
    expectedFailure: trimOrDefault(
      process.env.YANXING_SMOKE_EXPECTED_FAILURE,
      `yanxing-smoke-expected-failure-${marker}`,
    ),
  }
}

function readModelHost(value) {
  const host = trimOrDefault(value, DEFAULT_MODEL_HOST)
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new SmokeError(`YANXING_SMOKE_MODEL_HOST 无效：${host}`, { exitCode: 2 })
  }
  return host
}

export async function runFull({ client, config, modelPort, assertParsers = assertParserChildren }) {
  const startedAt = new Date().toISOString()
  const warnings = []
  log('login', config.baseUrl)
  await client.login({ username: config.username, password: config.password })
  await ensureSmokeModel({ client, config, modelPort })

  const documents = createSmokeDocuments(config.marker)
  log('parser-child', 'PDF/DOCX')
  await assertParsers(documents)

  log('create-project', config.marker)
  const created = await createSmokeProject(client, config.marker)
  log('edit-plan', created.project.id)
  await editSmokeStagePlan({
    client,
    projectId: created.project.id,
    workflow: created.workflow,
    stages: created.stages,
    marker: config.marker,
  })

  const reportRecords = []
  const manifest = {
    version: MANIFEST_VERSION,
    marker: config.marker,
    createdAt: startedAt,
    baseUrl: config.baseUrl,
    expectedFailure: config.expectedFailure,
    projectId: created.project.id,
    projectTitle: created.project.title,
    reports: reportRecords,
    warnings,
  }
  const deadline = Date.now() + config.timeoutMs
  const workerOutcomes = []
  for (const [index, document] of [documents.pdf, documents.docx].entries()) {
    workerOutcomes.push(await ingestAndAnalyzeReport({
      client,
      config,
      projectId: created.project.id,
      document,
      deadline,
      reportRecords,
      manifest,
      retryAnalysis: index === 0,
    }))
  }

  log('retired-protocol', created.project.id)
  await probeRetiredWritePaths(client, { projectId: created.project.id, reportId: reportRecords[0].id })

  log('protected-completion', created.project.id)
  const completion = await probeProtectedCompletion({
    client,
    config,
    projectId: created.project.id,
    document: documents.pdf,
    deadline,
  })
  reportRecords.push(completion.record)
  warnings.push(COMPLETION_RETAINED_WARNING)
  manifest.completionRetained = true
  await writeManifest(config.manifestPath, manifest)
  log('retention', `${COMPLETION_RETAINED_WARNING}: ${completion.record.id}`)

  return {
    ok: true,
    mode: 'full',
    manifestPath: config.manifestPath,
    projectId: created.project.id,
    reports: reportRecords,
    workerOutcomes,
    warnings,
    completionRetained: true,
  }
}

async function ingestAndAnalyzeReport({
  client,
  config,
  projectId,
  document,
  deadline,
  reportRecords,
  manifest,
  retryAnalysis,
}) {
  log('upload', document.kind)
  const receipt = await submitNativeReport({
    client,
    projectId,
    document,
    reportKind: 'update',
    deadline,
    pollMs: config.pollMs,
  })
  const record = toManifestReport({ kind: document.kind === 'PDF' ? 'pdf' : 'docx', document, receipt })
  reportRecords.push(record)
  await writeManifest(config.manifestPath, manifest)

  log('analyze', record.id)
  const ai = await collectAiOutcomes({
    client,
    reportId: record.id,
    deadline,
    pollMs: config.pollMs,
    retryAnalysis,
  })
  const detail = await readNativeReport(client, record.id)
  assertNativeLabels(detail)
  record.stageId = detail.stageId
  record.stageVersion = detail.stageVersion
  record.submissionSequence = detail.submissionSequence
  record.submittedAs = detail.submittedAs
  record.analysisTaskId = ai.analysis?.id
  record.insightTaskId = ai.insight?.id
  record.analysisStatus = ai.analysis?.status
  record.insightStatus = ai.insight?.status
  const outcome = assertWorkerOutcome({
    analysisTask: ai.analysis,
    insightTask: ai.insight,
    expectedFailure: config.expectedFailure,
  })
  await writeManifest(config.manifestPath, manifest)
  return outcome
}

export async function runVerify({ client, config }) {
  log('login', config.baseUrl)
  await client.login({ username: config.username, password: config.password })
  const manifest = await readManifest(config.manifestPath)
  log('verify', manifest.projectId)
  const listing = await client.readJson('GET', `/api/projects/${manifest.projectId}/reports?limit=100`)
  const reports = listing.reports
  if (!Array.isArray(reports)) throw new SmokeError('课题报告列表响应无效。')
  const byId = new Map(reports.map((report) => [report.id, report]))
  const verified = []
  for (const record of manifest.reports) {
    const listed = byId.get(record.id)
    if (!listed) throw new SmokeError(`验证失败：报告 ${record.id} 不存在。`)
    if (record.stageVersion != null && listed.stageVersion !== record.stageVersion) {
      throw new SmokeError(`验证失败：报告 ${record.id} 的 stageVersion 不匹配。`)
    }
    if (record.submissionSequence != null && listed.submissionSequence !== record.submissionSequence) {
      throw new SmokeError(`验证失败：报告 ${record.id} 的 submissionSequence 不匹配。`)
    }
    const detail = await readNativeReport(client, record.id)
    assertNativeLabels(detail)
    const downloaded = await client.readBuffer('GET', `/api/reports/${record.id}/file?download=1`)
    const sha256 = sha256Hex(downloaded)
    if (sha256 !== record.sha256) {
      throw new SmokeError(`验证失败：报告 ${record.id} 下载内容哈希不匹配。`)
    }
    verified.push({
      id: record.id,
      kind: record.kind,
      sha256,
      bytes: downloaded.byteLength,
      stageVersion: listed.stageVersion,
      submissionSequence: listed.submissionSequence,
    })
  }
  if (manifest.completionRetained) {
    log('retention', COMPLETION_RETAINED_WARNING)
  }
  return { ok: true, mode: 'verify', manifestPath: config.manifestPath, projectId: manifest.projectId, reports: verified }
}

export function createSmokeDocuments(marker) {
  const pdfText = `YXPDF ${marker}`
  const docxText = `YXDOCX ${marker}`
  const pdfBytes = createMinimalPdfBuffer(pdfText)
  const docxBytes = createMinimalDocxBuffer(docxText)
  return {
    pdf: {
      kind: 'PDF',
      fileName: `smoke-${marker}.pdf`,
      bytes: pdfBytes,
      sha256: sha256Hex(pdfBytes),
      expectedText: pdfText,
    },
    docx: {
      kind: 'DOCX',
      fileName: `smoke-${marker}.docx`,
      bytes: docxBytes,
      sha256: sha256Hex(docxBytes),
      expectedText: docxText,
    },
  }
}

async function ensureSmokeModel({ client, config, modelPort }) {
  const current = await client.readJson('GET', '/api/admin/ai-settings')
  let settings = current.settings
  if (!settings?.revision) throw new SmokeError('读取模型设置失败。')
  const existing = settings.channels.find((channel) => channel.name === SMOKE_CHANNEL_NAME)
  const existingModel = existing?.models?.find((model) => model.modelName === SMOKE_MODEL_NAME)
  const baseUrl = `http://${config.modelHost}:${modelPort}/v1`
  log('save-channel', baseUrl)
  settings = await saveAiSettings(client, {
    action: 'save_channel',
    revision: settings.revision,
    channel: {
      id: existing?.id,
      name: SMOKE_CHANNEL_NAME,
      baseUrl,
      apiKey: SMOKE_API_KEY,
      models: [{
        id: existingModel?.id,
        modelName: SMOKE_MODEL_NAME,
        maxContextCharacters: SMOKE_MODEL_CONTEXT_CHARACTERS,
        maxOutputTokens: SMOKE_MODEL_OUTPUT_TOKENS,
        reasoningEffort: 'auto',
      }],
    },
  })
  const channel = settings.channels.find((item) => item.name === SMOKE_CHANNEL_NAME)
  const model = channel?.models?.find((item) => item.modelName === SMOKE_MODEL_NAME)
  if (!model?.id) throw new SmokeError('部署冒烟模型渠道保存失败。')
  const targets = settings.assignments?.length
    ? settings.assignments.map((assignment) => assignment.target)
    : FALLBACK_ASSIGNMENT_TARGETS
  log('save-assignments', model.id)
  await saveAiSettings(client, {
    action: 'save_assignments',
    revision: settings.revision,
    assignments: targets.map((target) => ({ target, modelId: model.id })),
  })
}

async function saveAiSettings(client, json) {
  const payload = await client.readJson('PUT', '/api/admin/ai-settings', {
    json,
    headers: { 'If-Match': `"models-${json.revision}"` },
  })
  if (!payload.settings?.revision) throw new SmokeError(`保存模型设置失败（${json.action}）。`)
  return payload.settings
}

export function startMockModelServer(failureMessage) {
  const body = JSON.stringify({ error: { message: failureMessage } })
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(body)
      })
    })
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new SmokeError('冒烟模型桩未能绑定端口。'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

export function closeMockServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export async function assertParserChildren(documents) {
  const parent = existsSync(path.join(process.cwd(), 'storage'))
    ? path.join(process.cwd(), 'storage', 'tmp')
    : os.tmpdir()
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(path.join(parent, 'deployment-smoke-'))
  try {
    const pdfPath = path.join(directory, documents.pdf.fileName)
    const docxPath = path.join(directory, documents.docx.fileName)
    await writeFile(pdfPath, documents.pdf.bytes)
    await writeFile(docxPath, documents.docx.bytes)
    await runParserChild({ kind: 'PDF', filePath: pdfPath, expectedText: documents.pdf.expectedText })
    await runParserChild({ kind: 'DOCX', filePath: docxPath, expectedText: documents.docx.expectedText })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runParserChild({ kind, filePath, expectedText }) {
  let runtime
  try {
    runtime = resolveParserChildRuntime({ kind })
  } catch (error) {
    throw new SmokeError(error instanceof Error ? error.message : String(error))
  }
  const result = await spawnParserJson({
    kind,
    runtime,
    filePath,
  })
  if (!result?.ok || typeof result.text !== 'string' || !result.text.includes(expectedText)) {
    const detail = typeof result?.error === 'string' && result.error.trim()
      ? result.error.trim()
      : JSON.stringify(result ?? null)
    throw new SmokeError(`${kind} 解析子进程未提取到预期正文。${detail}`)
  }
}

function parserMemoryMb(kind) {
  const envName = kind === 'PDF' ? 'REPORT_PDF_PARSER_MEMORY_MB' : 'REPORT_DOCX_PARSER_MEMORY_MB'
  const raw = process.env[envName]
  if (!raw?.trim()) return DEFAULT_PARSER_MEMORY_MB
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PARSER_MEMORY_MB
  return parsed
}

function spawnParserJson({ kind, runtime, filePath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, parserChildSpawnArguments(runtime, parserMemoryMb(kind), filePath), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = []
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new SmokeError(`解析子进程超时：${path.basename(runtime.workerPath)}`))
    }, PARSER_CHILD_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8').slice(0, 4_096 - stderr.length)
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(new SmokeError(`解析进程启动失败：${error.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      const raw = Buffer.concat(output).toString('utf8').trim()
      try {
        resolve(raw ? JSON.parse(raw) : undefined)
      } catch {
        reject(new SmokeError(`解析子进程输出无效（exit ${code ?? 'unknown'}）：${stderr || raw.slice(0, 300)}`))
      }
    })
  })
}

export async function createSmokeProject(client, marker) {
  const stageIds = smokeStageIds(marker)
  const payload = await client.readJson('POST', '/api/projects', {
    json: {
      title: `deployment-smoke ${marker}`,
      objective: 'Production deployment smoke: native prepare/confirm, parser child, and independent AI tasks.',
      description: 'Disposable smoke project. Formal reports are retained; project DELETE is rejected.',
      stages: [
        {
          id: stageIds.first,
          title: 'Smoke stage',
          description: 'Upload PDF/DOCX and confirm native report submissions for deployment smoke.',
          plannedStartAt: SMOKE_STAGE_PLAN_DATES[0].plannedStartAt,
          plannedEndAt: SMOKE_STAGE_PLAN_DATES[0].plannedEndAt,
        },
        {
          id: stageIds.second,
          title: 'Smoke follow-up',
          description: 'Remain in progress after an explicit completion protection check.',
          plannedStartAt: SMOKE_STAGE_PLAN_DATES[1].plannedStartAt,
          plannedEndAt: SMOKE_STAGE_PLAN_DATES[1].plannedEndAt,
        },
      ],
    },
    expectedStatus: 201,
  })
  return readCreatedProject(payload)
}

export async function editSmokeStagePlan({ client, projectId, workflow, stages, marker }) {
  const nextStages = stages.map((stage, index) => {
    const dates = smokeStagePlanDates(index)
    const next = {
      id: stage.id,
      title: stage.title,
      plannedStartAt: stage.plannedStartAt || dates.plannedStartAt,
      plannedEndAt: stage.plannedEndAt || dates.plannedEndAt,
    }
    const description = withSmokeDescription(stage.description, index === 0 ? marker : undefined)
    if (description) next.description = description
    return next
  })
  const payload = await client.readJson('PATCH', `/api/projects/${projectId}/stages`, {
    json: { expectedPlanRevision: workflow.planRevision, nextStages },
  })
  return readWorkflowBundle(payload, '更新阶段计划')
}

export async function prepareReportUpload(client, { projectId, fileName, mimeType, bytes }) {
  const pathname = `/api/projects/${projectId}/report-uploads?fileName=${encodeURIComponent(fileName)}`
  const payload = await client.readJson('POST', pathname, {
    headers: { 'Content-Type': mimeType },
    body: bytes,
    expectedStatus: 201,
  })
  if (!payload?.id) throw new SmokeError(`准备上传 ${fileName} 失败：响应缺少 upload id。`)
  return payload
}

export async function waitForUploadReady(client, { projectId, upload, deadline, pollMs }) {
  let current = await client.readJson('GET', `/api/projects/${projectId}/report-uploads/${upload.id}`)
  while (current.status !== 'ready') {
    if (current.status === 'failed') {
      throw new SmokeError(`准备记录 ${current.id} 解析失败：${current.errorCode ?? 'UPLOAD_FAILED'}`)
    }
    if (Date.now() >= deadline) throw new SmokeError(`等待准备记录 ${current.id} 就绪超时。`)
    await delay(pollMs)
    current = await client.readJson('GET', `/api/projects/${projectId}/report-uploads/${current.id}`)
  }
  return current
}

export async function confirmReportSubmission(client, { projectId, uploadId, stage, workflow, reportKind, idempotencyKey }) {
  const payload = await client.readJson('POST', `/api/projects/${projectId}/reports`, {
    headers: { 'Idempotency-Key': idempotencyKey },
    json: {
      uploadId,
      stageId: stage.id,
      reportKind,
      expectedPlanRevision: workflow.planRevision,
      expectedWorkflowRevision: workflow.workflowRevision,
      expectedCompletionRevision: stage.completionRevision,
      expectedCompletionReportId: stage.currentCompletionReportId ?? null,
    },
  })
  if (!payload?.receipt?.reportId) throw new SmokeError('确认提交失败：响应缺少 receipt.reportId。')
  assertNativeLabels(payload.receipt)
  return payload
}

async function submitNativeReport({ client, projectId, document, reportKind, deadline, pollMs }) {
  const mimeType = document.kind === 'PDF' ? PDF_MIME_TYPE : DOCX_MIME_TYPE
  const prepared = await prepareReportUpload(client, {
    projectId,
    fileName: document.fileName,
    mimeType,
    bytes: document.bytes,
  })
  const upload = await waitForUploadReady(client, { projectId, upload: prepared, deadline, pollMs })
  const bundle = await loadStages(client, projectId)
  const stage = currentSubmitStage(bundle.stages)
  const confirmed = await confirmReportSubmission(client, {
    projectId,
    uploadId: upload.id,
    stage,
    workflow: bundle.workflow,
    reportKind,
    idempotencyKey: createIdempotencyKey(),
  })
  await assertDownloadedHash(client, confirmed.receipt.reportId, document.sha256)
  return confirmed.receipt
}

export async function loadStages(client, projectId) {
  const payload = await client.readJson('GET', `/api/projects/${projectId}/stages`)
  return readWorkflowBundle(payload, '读取阶段计划')
}

async function collectAiOutcomes({ client, reportId, deadline, pollMs, retryAnalysis }) {
  const [analysis, insight] = await Promise.all([
    waitForAnalysisTask({ client, reportId, deadline, pollMs }),
    waitForInsightTask({ client, reportId, deadline, pollMs }),
  ])
  let analysisTask = analysis
  if (retryAnalysis && analysisTask?.status === 'failed' && analysisTask.id) {
    if (AUTOMATIC_REPLAY_BLOCKED_CODES.has(analysisTask.errorCode)) {
      log('retry-skip', `${analysisTask.id} ${analysisTask.errorCode}`)
    } else {
      log('retry', analysisTask.id)
      const retried = await client.request('POST', `/api/jobs/${analysisTask.id}/retry`)
      if ((retried.status === 200 || retried.status === 202) && retried.json?.job?.id) {
        analysisTask = await waitForAnalysisTask({ client, reportId, deadline, pollMs })
      }
    }
  }
  if (analysisTask?.id) await probeJobEvents(client, analysisTask.id)
  if (insight?.id) await probeJobEvents(client, insight.id)
  return { analysis: analysisTask, insight }
}

export async function waitForAnalysisTask({ client, reportId, deadline, pollMs }) {
  return waitForNativeTask({ client, reportId, operation: 'analysis', deadline, pollMs, optional: false })
}

export async function waitForInsightTask({ client, reportId, deadline, pollMs }) {
  return waitForNativeTask({ client, reportId, operation: 'insight', deadline, pollMs, optional: true })
}

async function waitForNativeTask({ client, reportId, operation, deadline, pollMs, optional }) {
  let startAttempted = false
  let jobId
  while (Date.now() < deadline) {
    const detail = await readNativeReport(client, reportId)
    let task = operation === 'analysis' ? detail.analysisTask : detail.insightTask
    if (!task?.id && !startAttempted) {
      startAttempted = true
      task = await startNativeTask(client, reportId, operation, optional)
      if (!task?.id && optional) return null
    }
    if (task?.id) jobId = task.id
    if (jobId) {
      const viewed = await readJobView(client, jobId)
      if (TERMINAL_TASK_STATUSES.has(viewed.status)) return viewed
    }
    await delay(pollMs)
  }
  if (optional) return null
  throw new SmokeError(`等待 ${operation} 终态超时：${reportId}`)
}

async function startNativeTask(client, reportId, operation, optional) {
  const pathname = operation === 'analysis'
    ? `/api/reports/${reportId}/analyze`
    : `/api/reports/${reportId}/insight`
  const response = await client.request('POST', pathname)
  if ((response.status === 202 || response.status === 200) && response.json?.job?.id) {
    return response.json.job
  }
  if (optional && response.status >= 400 && response.status < 500) {
    log(`${operation}-skip`, readErrorMessage(response) || `HTTP ${response.status}`)
    return null
  }
  throw new SmokeError(`启动 ${operation} 失败（HTTP ${response.status}）：${readErrorMessage(response) || '未知错误'}`)
}

async function readJobView(client, jobId) {
  const payload = await client.readJson('GET', `/api/jobs/${jobId}`)
  const job = payload.job
  if (!job?.id) throw new SmokeError(`任务 ${jobId} 不存在。`)
  return job
}

async function probeJobEvents(client, jobId) {
  try {
    const response = await client.request('GET', `/api/jobs/${jobId}/events`, {
      parseJson: false,
      timeoutMs: JOB_EVENTS_TIMEOUT_MS,
    })
    if (response.status !== 200) {
      log('job-events', `HTTP ${response.status}`)
    }
  } catch (error) {
    log('job-events', error instanceof Error ? error.message : String(error))
  }
}

export function assertWorkerOutcome({ analysisTask, insightTask, expectedFailure }) {
  if (!analysisTask?.id) throw new SmokeError('缺少 analysisTask。')
  if (!TERMINAL_TASK_STATUSES.has(analysisTask.status)) {
    throw new SmokeError(`分析任务 ${analysisTask.id} 未到达终态：${analysisTask.status}`)
  }
  const diagnostic = [
    analysisTask.errorCode,
    analysisTask.errorMessage,
    insightTask?.errorCode,
    insightTask?.errorMessage,
  ].filter(Boolean).join(' ')
  if (PARSER_PATH_FAILURE.test(diagnostic)) {
    throw new SmokeError(`解析子进程失败：${diagnostic}`)
  }
  if (analysisTask.status !== 'failed') {
    throw new SmokeError(`分析任务 ${analysisTask.id} 终态为 ${analysisTask.status}，期望模型桩返回的失败。`)
  }
  const nativeFailure = NATIVE_AI_FAILURE_CODES.has(analysisTask.errorCode)
  const expectedHit = diagnostic.includes(expectedFailure)
  if (!nativeFailure && !expectedHit) {
    throw new SmokeError(`分析任务 ${analysisTask.id} 失败原因超出预期：${analysisTask.errorCode ?? '未知错误'}`)
  }
  if (insightTask && !TERMINAL_TASK_STATUSES.has(insightTask.status) && insightTask.status !== undefined) {
    throw new SmokeError(`洞察任务 ${insightTask.id} 未到达终态：${insightTask.status}`)
  }
  return {
    reportId: analysisTask.reportId,
    analysisTaskId: analysisTask.id,
    insightTaskId: insightTask?.id,
    status: analysisTask.status,
    errorCode: analysisTask.errorCode,
    expectedModelFailure: true,
  }
}

export async function probeRetiredWritePaths(client, { projectId, reportId }) {
  const direct = await client.request('POST', `/api/projects/${projectId}/reports`, {
    headers: {
      'Content-Type': PDF_MIME_TYPE,
      'x-file-name': encodeURIComponent('legacy-direct.pdf'),
    },
    body: Buffer.from('%PDF-1.4'),
  })
  assertErrorCode(direct, 410, 'UPLOAD_PROTOCOL_RETIRED', '旧直传报告协议')

  const patch = await client.request('PATCH', `/api/reports/${reportId}`, {
    json: { stageId: 'smoke-stage-2' },
  })
  assertErrorCode(patch, 409, 'REPORT_STAGE_IMMUTABLE', '修改报告阶段')

  const put = await client.request('PUT', `/api/reports/${reportId}`, {
    json: { sourcePath: '/tmp/replaced.pdf' },
  })
  assertErrorCode(put, 409, 'REPORT_SOURCE_IMMUTABLE', '替换报告源文件')

  await assertProjectRetained(client, projectId)
}

export async function probeProtectedCompletion({ client, config, projectId, document, deadline }) {
  const receipt = await submitNativeReport({
    client,
    projectId,
    document: {
      ...document,
      fileName: document.fileName.replace(/(\.pdf|\.docx)$/i, '-completion$1'),
    },
    reportKind: 'completion',
    deadline,
    pollMs: config.pollMs,
  })
  const deleted = await client.request('DELETE', `/api/reports/${receipt.reportId}`, {
    json: { reason: 'deployment-smoke protected completion check' },
  })
  assertErrorCode(deleted, 409, 'COMPLETION_REPORT_PROTECTED', '删除当前完结报告')
  return {
    record: toManifestReport({
      kind: document.kind === 'PDF' ? 'pdf' : 'docx',
      document,
      receipt,
      submittedAs: 'completion',
    }),
  }
}

export async function cleanupSmokeData({ client, manifest }) {
  const completions = (manifest.reports ?? []).filter((report) => (
    report.submittedAs === 'completion' || report.isCurrentCompletion
  ))
  if (completions.length > 0) {
    log('cleanup', `${COMPLETION_RETAINED_WARNING}: ${completions.map((item) => item.id).join(', ')}`)
    await assertProjectRetained(client, manifest.projectId)
    return {
      ok: true,
      retained: true,
      reason: 'completion',
      reportIds: completions.map((item) => item.id),
    }
  }
  for (const report of manifest.reports ?? []) {
    const response = await client.request('DELETE', `/api/reports/${report.id}`, {
      json: { reason: `deployment-smoke logical cleanup ${manifest.marker ?? ''}`.trim() },
    })
    if (response.status !== 200) {
      throw new SmokeError(`逻辑删除更新报告失败（HTTP ${response.status}）：${readErrorMessage(response)}`)
    }
  }
  await assertProjectRetained(client, manifest.projectId)
  log('cleanup', 'update reports logically deleted; project and files retained')
  return { ok: true, retained: true, reason: 'project-retention' }
}

async function assertProjectRetained(client, projectId) {
  const response = await client.request('DELETE', `/api/projects/${projectId}`)
  assertErrorCode(response, 409, 'PROJECT_RETENTION_REQUIRED', '删除课题')
}

async function assertDownloadedHash(client, reportId, sha256) {
  const downloaded = await client.readBuffer('GET', `/api/reports/${reportId}/file?download=1`)
  if (sha256Hex(downloaded) !== sha256) {
    throw new SmokeError(`上传后下载哈希不匹配：${reportId}`)
  }
}

async function readNativeReport(client, reportId) {
  const payload = await client.readJson('GET', `/api/reports/${reportId}`)
  if (!payload?.id) throw new SmokeError(`报告 ${reportId} 读取失败。`)
  return payload
}

function readCreatedProject(payload) {
  const project = payload?.project
  if (!project?.id) throw new SmokeError('创建课题失败：响应缺少 project.id。')
  const bundle = readWorkflowBundle(payload, '创建课题')
  return { project, ...bundle }
}

function readWorkflowBundle(payload, context) {
  const workflow = payload?.workflow
  const groups = Array.isArray(payload?.stages) ? payload.stages : []
  if (!workflow || !Number.isInteger(workflow.planRevision) || groups.length === 0) {
    throw new SmokeError(`${context}：响应缺少 workflow/stages。`)
  }
  const stages = groups.map((group) => {
    const stage = group?.stage ?? group
    if (!stage?.id) throw new SmokeError(`${context}：阶段缺少 id。`)
    return stage
  })
  return { workflow, stages }
}

function currentSubmitStage(stages) {
  const current = stages.find((stage) => stage.lifecycleStatus === 'in_progress') ?? stages[0]
  if (!current?.id) throw new SmokeError('课题缺少可提交的研究阶段。')
  return current
}

function assertNativeLabels(record) {
  if (!Number.isSafeInteger(record.stageVersion) || record.stageVersion < 1) {
    throw new SmokeError(`响应缺少有效 stageVersion：${record.reportId ?? record.id ?? ''}`)
  }
  if (!Number.isSafeInteger(record.submissionSequence) || record.submissionSequence < 1) {
    throw new SmokeError(`响应缺少有效 submissionSequence：${record.reportId ?? record.id ?? ''}`)
  }
}

function assertErrorCode(response, status, code, action) {
  if (response.status !== status || response.json?.code !== code) {
    throw new SmokeError(`${action} 期望 HTTP ${status}/${code}，实际 ${response.status}/${response.json?.code ?? 'missing'}`)
  }
}

function withSmokeDescription(description, marker) {
  const base = (description ?? 'Smoke stage').trim()
  if (!marker) return base.slice(0, STAGE_DESCRIPTION_LIMIT)
  const suffix = ` [${marker}]`
  return (base + suffix).slice(0, STAGE_DESCRIPTION_LIMIT)
}

function toManifestReport({ kind, document, receipt, submittedAs }) {
  return {
    id: receipt.reportId,
    kind,
    fileName: document.fileName,
    sha256: document.sha256,
    stageId: receipt.stageId,
    stageVersion: receipt.stageVersion,
    submissionSequence: receipt.submissionSequence,
    submittedAs: submittedAs ?? receipt.submittedAs,
  }
}

export function createIdempotencyKey() {
  return `smoke_${randomBytes(16).toString('hex')}`
}

async function writeManifest(manifestPath, manifest) {
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function readManifest(manifestPath) {
  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    throw new SmokeError(`找不到冒烟清单：${manifestPath}`)
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new SmokeError(`冒烟清单不是合法 JSON：${manifestPath}`)
  }
  if (manifest?.version !== MANIFEST_VERSION || !manifest.projectId || !Array.isArray(manifest.reports) || manifest.reports.length === 0) {
    throw new SmokeError(`冒烟清单无效：${manifestPath}`)
  }
  return manifest
}

export class SmokeClient {
  constructor(config) {
    this.baseUrl = config.baseUrl
    this.timeoutMs = config.timeoutMs
    this.cookies = new Map()
  }

  async login({ username, password }) {
    const response = await this.request('POST', '/api/auth/login', {
      json: { username, password },
      expectedStatus: 200,
    })
    if (!this.csrfToken()) throw new SmokeError('登录成功但缺少 CSRF cookie。')
    return response.json
  }

  csrfToken() {
    return this.cookies.get('__Host-yanxing_csrf') ?? this.cookies.get('yanxing_csrf')
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  async readJson(method, pathname, options = {}) {
    const response = await this.request(method, pathname, options)
    if (options.expectedStatus && response.status !== options.expectedStatus) {
      throw new SmokeError(`${method} ${pathname} 期望 HTTP ${options.expectedStatus}，实际 ${response.status}：${readErrorMessage(response)}`)
    }
    if (!options.expectedStatus && (response.status < 200 || response.status >= 300)) {
      throw new SmokeError(`${method} ${pathname} 失败（HTTP ${response.status}）：${readErrorMessage(response)}`)
    }
    return response.json ?? {}
  }

  async readBuffer(method, pathname) {
    const response = await this.request(method, pathname, { parseJson: false })
    if (response.status < 200 || response.status >= 300) {
      throw new SmokeError(`${method} ${pathname} 失败（HTTP ${response.status}）。`)
    }
    return response.buffer
  }

  async request(method, pathname, options = {}) {
    const headers = new Headers(options.headers)
    const cookie = this.cookieHeader()
    if (cookie) headers.set('cookie', cookie)
    if (isMutation(method) && pathname !== '/api/auth/login') {
      const csrf = this.csrfToken()
      if (!csrf) throw new SmokeError('缺少 CSRF token，无法发送写请求。')
      headers.set('x-yanxing-csrf', csrf)
    }
    let body = options.body
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.json)
    }
    let response
    try {
      response = await fetch(new URL(pathname, `${this.baseUrl}/`), {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      })
    } catch (error) {
      throw new SmokeError(`无法连接 ${this.baseUrl}${pathname}：${error instanceof Error ? error.message : String(error)}`)
    }
    this.storeCookies(response)
    const buffer = Buffer.from(await response.arrayBuffer())
    const json = options.parseJson === false ? undefined : parseJsonBuffer(buffer)
    const result = { status: response.status, json, buffer }
    if (options.expectedStatus && response.status !== options.expectedStatus) {
      throw new SmokeError(`${method} ${pathname} 期望 HTTP ${options.expectedStatus}，实际 ${response.status}：${readErrorMessage(result)}`)
    }
    return result
  }

  storeCookies(response) {
    const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    for (const line of lines) {
      const pair = line.split(';', 1)[0]
      const separator = pair.indexOf('=')
      if (separator < 1) continue
      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
    }
  }
}

function isMutation(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

function parseJsonBuffer(buffer) {
  if (buffer.byteLength === 0) return undefined
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return undefined
  }
}

function readErrorMessage(response) {
  const json = response.json
  if (json && typeof json.error === 'string' && json.error.trim()) return json.error.trim()
  const text = Buffer.isBuffer(response.buffer) ? response.buffer.toString('utf8').trim() : ''
  return text.slice(0, 300)
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createMarker() {
  return `smoke-${Date.now().toString(16)}-${randomBytes(3).toString('hex')}`
}

function trimOrDefault(value, fallback) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

function readPositiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SmokeError(`无效的超时/轮询毫秒：${value}`, { exitCode: 2 })
  }
  return parsed
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function log(step, detail) {
  console.error(`[deployment-smoke] ${step}${detail ? ` ${detail}` : ''}`)
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

export {
  COMPLETION_RETAINED_WARNING,
  NATIVE_AI_FAILURE_CODES,
  TERMINAL_TASK_STATUSES,
}

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[deployment-smoke] ${message}`)
    if (error instanceof SmokeError && error.exitCode === 2) console.error(usage())
    process.exitCode = error instanceof SmokeError ? error.exitCode : 1
  })
}
