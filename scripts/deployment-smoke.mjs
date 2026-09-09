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
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const PARSER_PATH_FAILURE = /无法定位|解析进程启动失败|Cannot find module|ERR_MODULE_NOT_FOUND/
const PARSER_CHILD_TIMEOUT_MS = 30_000
const DEFAULT_PARSER_MEMORY_MB = 256
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_MS = 1_000
const MILESTONE_TARGET_DATE = '2099-12-31'
const SMOKE_CHANNEL_NAME = 'deployment-smoke'
const SMOKE_MODEL_NAME = 'deployment-smoke-model'
const SMOKE_API_KEY = 'deployment-smoke-key'
const SMOKE_MODEL_CONTEXT_CHARACTERS = 8_000
const SMOKE_MODEL_OUTPUT_TOKENS = 256
const FALLBACK_ASSIGNMENT_TARGETS = ['page_analysis', 'report_insight']

class SmokeError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message)
    this.name = 'SmokeError'
    this.exitCode = exitCode
  }
}

function usage() {
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

Usage:
  node scripts/deployment-smoke.mjs
  node scripts/deployment-smoke.mjs --verify
`
}

async function main() {
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

function parseArgs(argv) {
  let verify = false
  let help = false
  for (const argument of argv) {
    if (argument === '--verify') verify = true
    else if (argument === '--help' || argument === '-h') help = true
    else throw new SmokeError(`未知参数：${argument}`, { exitCode: 2 })
  }
  return { verify, help }
}

function readConfig(args) {
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

async function runFull({ client, config, modelPort }) {
  const startedAt = new Date().toISOString()
  log('login', config.baseUrl)
  await client.login({ username: config.username, password: config.password })
  await ensureSmokeModel({ client, config, modelPort })

  const documents = createSmokeDocuments(config.marker)
  log('parser-child', 'PDF/DOCX')
  await assertParserChildren(documents)

  log('create-project', config.marker)
  const project = await createSmokeProject(client, config.marker)
  const milestoneId = project.milestones?.[0]?.id
  if (!milestoneId) throw new SmokeError('创建课题成功但缺少研究阶段。')

  const reportRecords = []
  const manifest = {
    version: MANIFEST_VERSION,
    marker: config.marker,
    createdAt: startedAt,
    baseUrl: config.baseUrl,
    expectedFailure: config.expectedFailure,
    projectId: project.id,
    projectTitle: project.title,
    reports: reportRecords,
  }
  const deadline = Date.now() + config.timeoutMs
  const workerOutcomes = []
  for (const document of [documents.pdf, documents.docx]) {
    workerOutcomes.push(await ingestAndAnalyzeReport({
      client,
      config,
      projectId: project.id,
      milestoneId,
      document,
      deadline,
      reportRecords,
      manifest,
    }))
  }
  return {
    ok: true,
    mode: 'full',
    manifestPath: config.manifestPath,
    projectId: project.id,
    reports: reportRecords,
    workerOutcomes,
  }
}

async function ingestAndAnalyzeReport({
  client,
  config,
  projectId,
  milestoneId,
  document,
  deadline,
  reportRecords,
  manifest,
}) {
  log('upload', document.kind)
  const uploaded = await uploadReport(client, {
    projectId,
    milestoneId,
    fileName: document.fileName,
    mimeType: document.kind === 'PDF' ? PDF_MIME_TYPE : DOCX_MIME_TYPE,
    bytes: document.bytes,
  })
  assertUploadHash(uploaded, document.sha256)
  const record = toManifestReport(document.kind === 'PDF' ? 'pdf' : 'docx', uploaded, document)
  reportRecords.push(record)
  await writeManifest(config.manifestPath, manifest)
  log('manifest', config.manifestPath)

  log('analyze', record.id)
  record.jobId = await requestAnalysis(client, record.id)
  await writeManifest(config.manifestPath, manifest)

  const jobs = await waitForJobs({ client, jobIds: [record.jobId], deadline, pollMs: config.pollMs })
  const detail = await client.readJson('GET', `/api/reports/${record.id}`)
  const report = detail.report
  if (!report) throw new SmokeError(`报告 ${record.id} 读取失败。`)
  const job = jobs.get(record.jobId) ?? detail.job
  if (!job) throw new SmokeError(`任务 ${record.jobId} 读取失败。`)
  record.parseStatus = report.parseStatus
  record.parseError = report.parseError
  record.jobStatus = job.status
  record.jobError = job.errorMessage
  record.lastWorkerId = job.lastWorkerId
  const outcome = assertWorkerOutcome({
    job,
    report,
    expectedFailure: config.expectedFailure,
  })
  await writeManifest(config.manifestPath, manifest)
  return outcome
}

async function runVerify({ client, config }) {
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
    if (!byId.has(record.id)) throw new SmokeError(`验证失败：报告 ${record.id} 不存在。`)
    const detail = await client.readJson('GET', `/api/reports/${record.id}`)
    const fileHash = detail.report?.fileHash
    if (fileHash !== record.sha256) {
      throw new SmokeError(`验证失败：报告 ${record.id} 的 fileHash 不匹配。`)
    }
    const downloaded = await client.readBuffer('GET', `/api/reports/${record.id}/file?download=1`)
    const sha256 = sha256Hex(downloaded)
    if (sha256 !== record.sha256) {
      throw new SmokeError(`验证失败：报告 ${record.id} 下载内容哈希不匹配。`)
    }
    verified.push({ id: record.id, kind: record.kind, sha256, bytes: downloaded.byteLength })
  }
  return { ok: true, mode: 'verify', manifestPath: config.manifestPath, projectId: manifest.projectId, reports: verified }
}

function createSmokeDocuments(marker) {
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

function startMockModelServer(failureMessage) {
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

function closeMockServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function assertParserChildren(documents) {
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

async function createSmokeProject(client, marker) {
  const payload = await client.readJson('POST', '/api/projects', {
    json: {
      title: `deployment-smoke ${marker}`,
      objective: 'Production deployment smoke: verify upload, parser child, and worker queue.',
      description: 'Disposable smoke project. Safe to keep; do not delete until Worker has finished.',
      milestones: [
        {
          id: 'smoke-stage-1',
          title: 'Smoke stage',
          targetDate: MILESTONE_TARGET_DATE,
          description: 'Upload PDF/DOCX and request analysis for deployment smoke.',
        },
      ],
    },
  })
  if (!payload.project?.id) throw new SmokeError('创建课题失败：响应缺少 project.id。')
  return payload.project
}

async function uploadReport(client, { projectId, milestoneId, fileName, mimeType, bytes }) {
  const payload = await client.readJson('POST', `/api/projects/${projectId}/reports`, {
    headers: {
      'Content-Type': mimeType,
      'x-file-name': encodeURIComponent(fileName),
      'x-report-delivery-type': 'stage',
      'x-milestone-id': encodeURIComponent(milestoneId),
    },
    body: bytes,
    expectedStatus: 202,
  })
  if (!payload.report?.id) throw new SmokeError(`上传 ${fileName} 失败：响应缺少 report.id。`)
  return payload.report
}

function assertUploadHash(report, sha256) {
  if (report.fileHash && report.fileHash !== sha256) {
    throw new SmokeError(`上传后 fileHash 不匹配：${report.id}`)
  }
}

async function requestAnalysis(client, reportId) {
  const response = await client.request('POST', `/api/reports/${reportId}/analyze`)
  if (response.status === 202 && response.json?.job?.id) return response.json.job.id
  throw new SmokeError(`启动分析失败（HTTP ${response.status}）：${readErrorMessage(response) || '未知错误'}`)
}

async function waitForJobs({ client, jobIds, deadline, pollMs }) {
  const remaining = new Set(jobIds)
  const jobs = new Map()
  while (remaining.size > 0) {
    if (Date.now() >= deadline) {
      throw new SmokeError(`等待 Worker 终态超时，仍未完成：${[...remaining].join(', ')}`)
    }
    for (const jobId of [...remaining]) {
      const payload = await client.readJson('GET', `/api/jobs/${jobId}`)
      const job = payload.job
      if (!job) throw new SmokeError(`任务 ${jobId} 不存在。`)
      jobs.set(jobId, job)
      if (TERMINAL_JOB_STATUSES.has(job.status)) remaining.delete(jobId)
    }
    if (remaining.size > 0) await delay(pollMs)
  }
  return jobs
}

function assertWorkerOutcome({ job, report, expectedFailure }) {
  if (!TERMINAL_JOB_STATUSES.has(job.status)) {
    throw new SmokeError(`任务 ${job.id} 未到达终态：${job.status}`)
  }
  if (!job.lastWorkerId && !job.lastClaimedAt) {
    throw new SmokeError(`任务 ${job.id} 终态为 ${job.status}，但没有 Worker 领取记录。`)
  }
  const combined = `${job.errorMessage ?? ''} ${report.parseError ?? ''}`
  if (PARSER_PATH_FAILURE.test(combined)) {
    throw new SmokeError(`解析子进程失败：${combined.trim()}`)
  }
  if (report.parseStatus !== 'ready') {
    throw new SmokeError(`报告 ${report.id} 解析状态为 ${report.parseStatus ?? 'unknown'}，期望 ready。${combined.trim()}`)
  }
  if (job.status !== 'failed') {
    throw new SmokeError(`任务 ${job.id} 终态为 ${job.status}，期望模型桩返回的失败。`)
  }
  if (!String(job.errorMessage ?? '').includes(expectedFailure)) {
    throw new SmokeError(`任务 ${job.id} 失败原因超出预期：${job.errorMessage ?? '未知错误'}`)
  }
  return {
    reportId: report.id,
    jobId: job.id,
    status: job.status,
    parseStatus: report.parseStatus,
    lastWorkerId: job.lastWorkerId,
    expectedModelFailure: true,
  }
}

function toManifestReport(kind, report, document) {
  return {
    id: report.id,
    kind,
    fileName: document.fileName,
    sha256: document.sha256,
  }
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

class SmokeClient {
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
        signal: AbortSignal.timeout(this.timeoutMs),
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

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[deployment-smoke] ${message}`)
    if (error instanceof SmokeError && error.exitCode === 2) console.error(usage())
    process.exitCode = error instanceof SmokeError ? error.exitCode : 1
  })
}
