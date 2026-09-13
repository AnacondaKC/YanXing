import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  COMPLETION_RETAINED_WARNING,
  NATIVE_AI_FAILURE_CODES,
  SmokeClient,
  SmokeError,
  assertWorkerOutcome,
  cleanupSmokeData,
  confirmReportSubmission,
  createIdempotencyKey,
  createSmokeDocuments,
  createSmokeProject,
  editSmokeStagePlan,
  parseArgs,
  prepareReportUpload,
  probeProtectedCompletion,
  probeRetiredWritePaths,
  readConfig,
  runFull,
  runVerify,
  startMockModelServer,
  closeMockServer,
  usage,
} from '../scripts/deployment-smoke.mjs'
import { PDF_MIME_TYPE } from '../scripts/deployment-fixtures.mjs'

const SMOKE_ENV_KEYS = [
  'YANXING_SMOKE_ALLOW_MUTATIONS',
  'YANXING_SMOKE_PASSWORD',
  'YANXING_SMOKE_BASE_URL',
  'YANXING_SMOKE_USERNAME',
  'YANXING_SMOKE_MARKER',
  'YANXING_SMOKE_MANIFEST_PATH',
  'YANXING_SMOKE_TIMEOUT_MS',
  'YANXING_SMOKE_POLL_MS',
  'YANXING_SMOKE_MODEL_HOST',
  'YANXING_SMOKE_EXPECTED_FAILURE',
]

test('usage documents native prepare/confirm routes and retention', () => {
  const text = usage()
  assert.match(text, /report-uploads\?fileName=/)
  assert.match(text, /Idempotency-Key/)
  assert.match(text, /YANXING_SMOKE_ALLOW_MUTATIONS/)
  assert.match(text, /--verify/)
  assert.match(text, /409 retention/)
  assert.doesNotMatch(text, /milestone/i)
  assert.doesNotMatch(text, /x-report-delivery-type/)
})

test('parseArgs accepts shared CLI flags and rejects unknown protocol options', () => {
  assert.deepEqual(parseArgs([]), { verify: false, help: false })
  assert.deepEqual(parseArgs(['--verify']), { verify: true, help: false })
  assert.deepEqual(parseArgs(['--help']), { verify: false, help: true })
  assert.deepEqual(parseArgs(['-h']), { verify: false, help: true })
  assert.throws(() => parseArgs(['--cleanup']), /未知参数/)
  assert.throws(() => parseArgs(['--replace']), /未知参数/)
  assert.throws(() => parseArgs(['--milestone-id', 'x']), /未知参数/)
})

test('readConfig keeps shared env and rejects invalid values', async () => {
  await withSmokeEnv({
    YANXING_SMOKE_ALLOW_MUTATIONS: undefined,
    YANXING_SMOKE_PASSWORD: 'secret',
  }, () => {
    assert.throws(() => readConfig({ verify: false }), /YANXING_SMOKE_ALLOW_MUTATIONS/)
  })
  await withSmokeEnv({
    YANXING_SMOKE_ALLOW_MUTATIONS: 'true',
    YANXING_SMOKE_PASSWORD: '',
  }, () => {
    assert.throws(() => readConfig({ verify: false }), /YANXING_SMOKE_PASSWORD/)
  })
  await withSmokeEnv({
    YANXING_SMOKE_ALLOW_MUTATIONS: 'true',
    YANXING_SMOKE_PASSWORD: 'secret',
    YANXING_SMOKE_MODEL_HOST: 'bad host',
  }, () => {
    assert.throws(() => readConfig({ verify: false }), /YANXING_SMOKE_MODEL_HOST/)
  })
  await withSmokeEnv({
    YANXING_SMOKE_ALLOW_MUTATIONS: 'true',
    YANXING_SMOKE_PASSWORD: 'secret',
    YANXING_SMOKE_TIMEOUT_MS: '0',
  }, () => {
    assert.throws(() => readConfig({ verify: false }), /无效的超时/)
  })
  await withSmokeEnv({
    YANXING_SMOKE_ALLOW_MUTATIONS: 'true',
    YANXING_SMOKE_PASSWORD: 'secret',
    YANXING_SMOKE_MARKER: 'fixed-marker',
    YANXING_SMOKE_BASE_URL: 'http://127.0.0.1:3000/',
    YANXING_SMOKE_POLL_MS: '5',
  }, () => {
    const config = readConfig({ verify: true })
    assert.equal(config.verify, true)
    assert.equal(config.marker, 'fixed-marker')
    assert.equal(config.baseUrl, 'http://127.0.0.1:3000')
    assert.equal(config.pollMs, 5)
    assert.match(config.expectedFailure, /fixed-marker/)
  })
})

test('createIdempotencyKey matches the native submission contract', () => {
  const key = createIdempotencyKey()
  assert.match(key, /^[A-Za-z0-9_-]{16,128}$/)
})

test('createSmokeProject posts ordered stages and never milestones', async () => {
  const fake = new FakeYanXing()
  await withMockedFetch(fake.fetch, async () => {
    const client = authedClient()
    const created = await createSmokeProject(client, 'marker-1')
    assert.equal(created.project.id, 'project-1')
    assert.equal(created.workflow.planRevision, 1)
  })
  const create = fake.calls.find((call) => call.method === 'POST' && call.pathname === '/api/projects')
  assert.ok(create)
  assert.ok(Array.isArray(create.json.stages))
  assert.equal(create.json.stages.length, 2)
  assert.equal('milestones' in create.json, false)
  assert.equal(create.json.stages[0].id, 'smoke-marker-1-s1')
  assert.equal(create.json.stages[1].id, 'smoke-marker-1-s2')
  assert.notEqual(create.json.stages[0].id, create.json.stages[1].id)
  assert.equal(create.json.objective.length > 0, true)
  assert.equal(create.json.description.length > 0, true)
  assert.equal(create.json.stages[0].plannedEndAt, '2026-06-30')
  assert.equal(create.json.stages[1].plannedEndAt, '2026-12-31')
})

test('prepare uses raw fileName query and confirm sends JSON revisions plus Idempotency-Key', async () => {
  const fake = new FakeYanXing()
  const documents = createSmokeDocuments('prep-1')
  await withMockedFetch(fake.fetch, async () => {
    const client = authedClient()
    const created = await createSmokeProject(client, 'prep-1')
    const planned = await editSmokeStagePlan({
      client,
      projectId: created.project.id,
      workflow: created.workflow,
      stages: created.stages,
      marker: 'prep-1',
    })
    const upload = await prepareReportUpload(client, {
      projectId: created.project.id,
      fileName: documents.pdf.fileName,
      mimeType: PDF_MIME_TYPE,
      bytes: documents.pdf.bytes,
    })
    assert.equal(upload.status, 'ready')
    const confirmed = await confirmReportSubmission(client, {
      projectId: created.project.id,
      uploadId: upload.id,
      stage: planned.stages[0],
      workflow: planned.workflow,
      reportKind: 'update',
      idempotencyKey: 'smoke_confirm_key_01',
    })
    assert.equal(confirmed.receipt.stageVersion, 1)
    assert.equal(confirmed.receipt.submissionSequence, 1)
    assert.equal(confirmed.receipt.submittedAs, 'update')
  })
  const prepare = fake.calls.find((call) => call.method === 'POST' && call.pathname.endsWith('/report-uploads'))
  assert.ok(prepare)
  assert.equal(prepare.searchParams.get('fileName'), documents.pdf.fileName)
  assert.equal(prepare.fileNameHeader, null)
  assert.equal(prepare.deliveryType, null)
  assert.equal(prepare.milestoneId, null)
  assert.equal(prepare.contentType, PDF_MIME_TYPE)
  const plan = fake.calls.find((call) => call.method === 'PATCH' && call.pathname.endsWith('/stages'))
  assert.ok(plan)
  assert.equal(plan.json.nextStages[0].plannedEndAt, '2026-06-30')
  assert.equal(plan.json.nextStages[0].description.includes('prep-1'), true)
  assert.equal(plan.json.nextStages[1].plannedEndAt, '2026-12-31')
  const confirm = fake.calls.find((call) => (
    call.method === 'POST'
    && call.pathname === '/api/projects/project-1/reports'
    && call.contentType?.includes('application/json')
  ))
  assert.ok(confirm)
  assert.equal(confirm.idempotencyKey, 'smoke_confirm_key_01')
  assert.deepEqual(confirm.json.reportKind, 'update')
  assert.equal(confirm.json.expectedCompletionReportId, null)
  assert.equal(typeof confirm.json.expectedPlanRevision, 'number')
  assert.equal(typeof confirm.json.expectedWorkflowRevision, 'number')
  assert.equal(typeof confirm.json.expectedCompletionRevision, 'number')
})

test('runFull uses two-phase native routes, independent AI tasks, and retention probes', async () => {
  const fake = new FakeYanXing()
  const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-smoke-'))
  const manifestPath = path.join(directory, 'manifest.json')
  try {
    await withSmokeEnv(operatorEnv(manifestPath), async () => {
      await withMockedFetch(fake.fetch, async () => {
        const config = readConfig({ verify: false })
        const result = await runFull({
          client: new SmokeClient(config),
          config,
          modelPort: 9,
          assertParsers: async () => {},
        })
        assert.equal(result.ok, true)
        assert.equal(result.completionRetained, true)
        assert.ok(result.warnings.includes(COMPLETION_RETAINED_WARNING))
        assert.equal(result.reports.length, 3)
        assert.equal(result.reports[0].stageVersion, 1)
        assert.equal(result.reports[0].submissionSequence, 1)
        assert.equal(result.reports[1].stageVersion, 2)
        assert.equal(result.reports[1].submissionSequence, 2)
        assert.equal(result.reports[2].submittedAs, 'completion')
        assert.equal(result.workerOutcomes.length, 2)
        assert.equal(result.workerOutcomes[0].status, 'failed')
        assert.ok(NATIVE_AI_FAILURE_CODES.has(result.workerOutcomes[0].errorCode))
        assert.ok(result.workerOutcomes[0].analysisTaskId)
        assert.ok(result.workerOutcomes[0].insightTaskId)
      })
    })
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.completionRetained, true)
    assert.equal(manifest.reports[2].submittedAs, 'completion')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  assert.equal(fake.calls.some((call) => 'milestones' in (call.json ?? {})), false)
  assert.equal(fake.calls.some((call) => call.milestoneId), false)
  assert.equal(fake.calls.some((call) => call.deliveryType), false)
  const prepares = fake.calls.filter((call) => call.method === 'POST' && call.pathname.endsWith('/report-uploads'))
  assert.ok(prepares.length >= 3)
  assert.ok(prepares.every((call) => !call.fileNameHeader && !call.milestoneId && !call.deliveryType))
  const confirms = fake.calls.filter((call) => (
    call.method === 'POST'
    && call.pathname === '/api/projects/project-1/reports'
    && call.contentType?.includes('application/json')
  ))
  assert.ok(confirms.length >= 3)
  assert.ok(confirms.every((call) => call.idempotencyKey && !call.fileNameHeader))
  assert.ok(fake.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/report-uploads')))
  assert.ok(fake.calls.some((call) => call.method === 'GET' && call.pathname.includes('/report-uploads/')))
  assert.ok(fake.calls.some((call) => call.method === 'PATCH' && call.pathname.endsWith('/stages')))
  assert.ok(fake.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/analyze')))
  assert.ok(fake.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/insight')))
  assert.ok(fake.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/retry')))
  assert.ok(fake.calls.some((call) => call.method === 'GET' && call.pathname.endsWith('/events')))
  const direct = fake.calls.find((call) => (
    call.method === 'POST'
    && call.pathname === '/api/projects/project-1/reports'
    && call.contentType === PDF_MIME_TYPE
  ))
  assert.ok(direct)
  assert.equal(fake.deletes.reports.length, 1)
  assert.equal(fake.deletes.reports[0].status, 409)
  assert.equal(fake.deletes.projects.length, 1)
  assert.equal(fake.deletes.projects[0].status, 409)
  assert.equal(fake.deletedReportIds.length, 0)
})

test('runVerify checks native labels and downloaded file hashes', async () => {
  const fake = new FakeYanXing()
  const documents = createSmokeDocuments('verify-1')
  const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-smoke-verify-'))
  const manifestPath = path.join(directory, 'manifest.json')
  try {
    await withMockedFetch(fake.fetch, async () => {
      const client = authedClient()
      const created = await createSmokeProject(client, 'verify-1')
      const upload = await prepareReportUpload(client, {
        projectId: created.project.id,
        fileName: documents.pdf.fileName,
        mimeType: PDF_MIME_TYPE,
        bytes: documents.pdf.bytes,
      })
      const confirmed = await confirmReportSubmission(client, {
        projectId: created.project.id,
        uploadId: upload.id,
        stage: created.stages[0],
        workflow: created.workflow,
        reportKind: 'update',
        idempotencyKey: 'smoke_verify_key_0001',
      })
      await writeJson(manifestPath, {
        version: 1,
        projectId: created.project.id,
        reports: [{
          id: confirmed.receipt.reportId,
          kind: 'pdf',
          sha256: documents.pdf.sha256,
          stageVersion: confirmed.receipt.stageVersion,
          submissionSequence: confirmed.receipt.submissionSequence,
        }],
      })
      await withSmokeEnv(operatorEnv(manifestPath, { YANXING_SMOKE_MARKER: 'verify-1' }), async () => {
        const verified = await runVerify({ client: authedClient(), config: readConfig({ verify: true }) })
        assert.equal(verified.ok, true)
        assert.equal(verified.reports[0].sha256, documents.pdf.sha256)
        assert.equal(verified.reports[0].stageVersion, 1)
        assert.equal(verified.reports[0].submissionSequence, 1)
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('retired writes return native 410/409 codes', async () => {
  const fake = new FakeYanXing()
  await withMockedFetch(fake.fetch, async () => {
    const client = authedClient()
    const created = await createSmokeProject(client, 'retired-1')
    const documents = createSmokeDocuments('retired-1')
    const upload = await prepareReportUpload(client, {
      projectId: created.project.id,
      fileName: documents.pdf.fileName,
      mimeType: PDF_MIME_TYPE,
      bytes: documents.pdf.bytes,
    })
    const confirmed = await confirmReportSubmission(client, {
      projectId: created.project.id,
      uploadId: upload.id,
      stage: created.stages[0],
      workflow: created.workflow,
      reportKind: 'update',
      idempotencyKey: 'smoke_retired_key_0001',
    })
    await probeRetiredWritePaths(client, {
      projectId: created.project.id,
      reportId: confirmed.receipt.reportId,
    })
  })
})

test('protected completion DELETE is rejected and cleanup will not remove it', async () => {
  const fake = new FakeYanXing()
  await withMockedFetch(fake.fetch, async () => {
    const client = authedClient()
    const created = await createSmokeProject(client, 'protect-1')
    const documents = createSmokeDocuments('protect-1')
    const probed = await probeProtectedCompletion({
      client,
      config: { pollMs: 1 },
      projectId: created.project.id,
      document: documents.pdf,
      deadline: Date.now() + 5_000,
    })
    assert.equal(probed.record.submittedAs, 'completion')
    const cleaned = await cleanupSmokeData({
      client,
      manifest: {
        projectId: created.project.id,
        marker: 'protect-1',
        reports: [probed.record],
      },
    })
    assert.equal(cleaned.retained, true)
    assert.equal(cleaned.reason, 'completion')
    assert.deepEqual(cleaned.reportIds, [probed.record.id])
  })
  assert.equal(fake.deletedReportIds.length, 0)
  assert.ok(fake.deletes.reports.every((item) => item.status === 409))
  assert.ok(fake.deletes.projects.length >= 1)
})

test('cleanup logically deletes updates with a reason and never physically deletes the project', async () => {
  const fake = new FakeYanXing()
  await withMockedFetch(fake.fetch, async () => {
    const client = authedClient()
    const created = await createSmokeProject(client, 'clean-1')
    const documents = createSmokeDocuments('clean-1')
    const upload = await prepareReportUpload(client, {
      projectId: created.project.id,
      fileName: documents.pdf.fileName,
      mimeType: PDF_MIME_TYPE,
      bytes: documents.pdf.bytes,
    })
    const confirmed = await confirmReportSubmission(client, {
      projectId: created.project.id,
      uploadId: upload.id,
      stage: created.stages[0],
      workflow: created.workflow,
      reportKind: 'update',
      idempotencyKey: 'smoke_clean_key_00001',
    })
    const cleaned = await cleanupSmokeData({
      client,
      manifest: {
        projectId: created.project.id,
        marker: 'clean-1',
        reports: [{ id: confirmed.receipt.reportId, submittedAs: 'update' }],
      },
    })
    assert.equal(cleaned.reason, 'project-retention')
    assert.equal(cleaned.retained, true)
  })
  assert.deepEqual(fake.deletedReportIds, ['report-1'])
  const logical = fake.calls.find((call) => call.method === 'DELETE' && call.pathname === '/api/reports/report-1')
  assert.match(logical.json.reason, /deployment-smoke logical cleanup/)
  assert.ok(fake.deletes.projects.every((item) => item.status === 409))
  assert.equal(fake.physicalProjectDeletes, 0)
})

test('assertWorkerOutcome requires native failed AI status and rejects parser path failures', () => {
  const failed = {
    id: 'job-1',
    reportId: 'report-1',
    status: 'failed',
    errorCode: 'MODEL_EXECUTION_FAILED',
  }
  const outcome = assertWorkerOutcome({
    analysisTask: failed,
    insightTask: { id: 'job-2', status: 'failed', errorCode: 'MODEL_EXECUTION_FAILED' },
    expectedFailure: 'token',
  })
  assert.equal(outcome.expectedModelFailure, true)
  const incomplete = assertWorkerOutcome({
    analysisTask: { ...failed, errorCode: 'AI_CALL_INCOMPLETE' },
    expectedFailure: 'token',
  })
  assert.equal(incomplete.errorCode, 'AI_CALL_INCOMPLETE')
  assert.throws(() => assertWorkerOutcome({
    analysisTask: { ...failed, status: 'completed' },
    expectedFailure: 'token',
  }), /期望模型桩返回的失败/)
  assert.throws(() => assertWorkerOutcome({
    analysisTask: { ...failed, errorCode: 'Cannot find module parser' },
    expectedFailure: 'token',
  }), /解析子进程失败/)
  assert.throws(() => assertWorkerOutcome({
    analysisTask: { ...failed, errorCode: 'STAGE_PLAN_MISSING' },
    expectedFailure: 'token',
  }), /失败原因超出预期/)
})

test('in-process model stub returns the expected failure without calling paid providers', async () => {
  const mock = await startMockModelServer('local-expected-failure')
  try {
    const response = await fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deployment-smoke-model', messages: [] }),
    })
    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.equal(payload.error.message, 'local-expected-failure')
  } finally {
    await closeMockServer(mock.server)
  }
})

function operatorEnv(manifestPath, extra = {}) {
  return {
    YANXING_SMOKE_ALLOW_MUTATIONS: 'true',
    YANXING_SMOKE_PASSWORD: 'secret',
    YANXING_SMOKE_BASE_URL: 'http://127.0.0.1:3000',
    YANXING_SMOKE_MARKER: 'full-marker',
    YANXING_SMOKE_MANIFEST_PATH: manifestPath,
    YANXING_SMOKE_TIMEOUT_MS: '5000',
    YANXING_SMOKE_POLL_MS: '1',
    YANXING_SMOKE_EXPECTED_FAILURE: 'expected-token',
    ...extra,
  }
}

function authedClient() {
  const client = new SmokeClient({
    baseUrl: 'http://127.0.0.1:3000',
    timeoutMs: 5_000,
  })
  client.cookies.set('yanxing_csrf', 'csrf-token')
  return client
}

async function withSmokeEnv(env, run) {
  const previous = {}
  for (const key of SMOKE_ENV_KEYS) previous[key] = process.env[key]
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const key of SMOKE_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

async function withMockedFetch(handler, run) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(value))
}

class FakeYanXing {
  constructor() {
    this.calls = []
    this.deletes = { reports: [], projects: [] }
    this.deletedReportIds = []
    this.physicalProjectDeletes = 0
    this.revision = 1
    this.channels = []
    this.assignments = [{ target: 'page_analysis', modelId: 'model-existing' }]
    this.project = null
    this.workflow = { planRevision: 1, workflowRevision: 1, nextSubmissionSequence: 1, currentStageId: 'smoke-stage-1' }
    this.stages = [
      this.createStage('smoke-stage-1', 'Smoke stage', 'in_progress', 1),
      this.createStage('smoke-stage-2', 'Smoke follow-up', 'not_started', 2),
    ]
    this.uploads = new Map()
    this.reports = new Map()
    this.tasks = new Map()
    this.ids = { upload: 0, report: 0, job: 0 }
    this.fetch = this.fetch.bind(this)
  }

  createStage(id, title, lifecycleStatus, ordinal) {
    return {
      id,
      projectId: 'project-1',
      title,
      description: title,
      lifecycleStatus,
      completionRevision: 0,
      currentCompletionReportId: null,
      ordinal,
    }
  }

  async fetch(input, init = {}) {
    const url = input instanceof URL ? input : new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const body = readBody(init.body)
    const contentType = headers.get('content-type')
    const json = contentType?.includes('application/json') && body.length ? JSON.parse(body.toString('utf8')) : undefined
    const call = {
      method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      contentType,
      fileNameHeader: headers.get('x-file-name'),
      deliveryType: headers.get('x-report-delivery-type'),
      milestoneId: headers.get('x-milestone-id'),
      idempotencyKey: headers.get('idempotency-key'),
      json,
    }
    this.calls.push(call)
    return this.route(method, url, { headers, body, json, call })
  }

  route(method, url, request) {
    const { pathname } = url
    if (method === 'POST' && pathname === '/api/auth/login') return this.login()
    if (pathname === '/api/admin/ai-settings') return this.aiSettings(method, request.json)
    if (method === 'POST' && pathname === '/api/projects') return this.createProject(request.json)
    if (method === 'GET' && pathname === '/api/projects/project-1/stages') return jsonResponse(this.stagesPayload())
    if (method === 'PATCH' && pathname === '/api/projects/project-1/stages') return this.editPlan(request.json)
    if (method === 'POST' && pathname === '/api/projects/project-1/report-uploads') {
      return this.prepare(url.searchParams.get('fileName') ?? '', request.body)
    }
    const uploadMatch = pathname.match(/^\/api\/projects\/project-1\/report-uploads\/([^/]+)$/)
    if (method === 'GET' && uploadMatch) return jsonResponse(this.uploads.get(uploadMatch[1]))
    if (method === 'GET' && pathname === '/api/projects/project-1/reports') return jsonResponse({ reports: [...this.reports.values()].map((report) => this.card(report)) })
    if (method === 'POST' && pathname === '/api/projects/project-1/reports') return this.confirm(request)
    if (method === 'DELETE' && pathname === '/api/projects/project-1') {
      this.deletes.projects.push({ status: 409 })
      return jsonResponse({ error: '课题文件需长期保留，当前版本不提供课题删除。', code: 'PROJECT_RETENTION_REQUIRED' }, 409)
    }
    const reportFile = pathname.match(/^\/api\/reports\/([^/]+)\/file$/)
    if (method === 'GET' && reportFile) return new Response(this.reports.get(reportFile[1]).bytes, { status: 200 })
    const analyze = pathname.match(/^\/api\/reports\/([^/]+)\/analyze$/)
    if (method === 'POST' && analyze) return this.startTask(analyze[1], 'analysis')
    const insight = pathname.match(/^\/api\/reports\/([^/]+)\/insight$/)
    if (method === 'POST' && insight) return this.startTask(insight[1], 'insight')
    const reportMatch = pathname.match(/^\/api\/reports\/([^/]+)$/)
    if (reportMatch) return this.reportWrite(method, reportMatch[1], request.json)
    const retry = pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/)
    if (method === 'POST' && retry) return this.retry(retry[1])
    const events = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/)
    if (method === 'GET' && events) {
      return new Response('event: failed\ndata: {"message":"MODEL_EXECUTION_FAILED"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const job = pathname.match(/^\/api\/jobs\/([^/]+)$/)
    if (method === 'GET' && job) {
      const viewed = this.viewJob(job[1])
      return jsonResponse({ job: viewed, analysisTask: viewed.operation === 'analysis' ? viewed : undefined, insightTask: viewed.operation === 'insight' ? viewed : undefined })
    }
    return jsonResponse({ error: `unhandled ${method} ${pathname}`, code: 'NOT_FOUND' }, 404)
  }

  login() {
    const headers = new Headers({ 'content-type': 'application/json' })
    headers.append('set-cookie', 'yanxing_csrf=csrf-token')
    headers.append('set-cookie', 'yanxing_session=session-token')
    return new Response(JSON.stringify({ user: { id: 'admin-1', username: 'admin' } }), { status: 200, headers })
  }

  aiSettings(method, json) {
    if (method === 'GET') return jsonResponse({ settings: this.settings() })
    if (json?.action === 'save_channel') {
      this.revision += 1
      const channel = {
        id: json.channel.id ?? 'channel-smoke',
        name: json.channel.name,
        baseUrl: json.channel.baseUrl,
        models: json.channel.models.map((model) => ({ ...model, id: model.id ?? 'model-smoke' })),
      }
      this.channels = [channel]
      return jsonResponse({ settings: this.settings() })
    }
    if (json?.action === 'save_assignments') {
      this.revision += 1
      this.assignments = json.assignments
      return jsonResponse({ settings: this.settings() })
    }
    return jsonResponse({ error: 'unsupported settings action', code: 'INVALID_SUBMISSION' }, 400)
  }

  settings() {
    return { revision: this.revision, channels: this.channels, assignments: this.assignments }
  }

  createProject(json) {
    if (!json?.stages || json.milestones) {
      return jsonResponse({ error: 'native stages required', code: 'INVALID_PROJECT' }, 400)
    }
    this.project = { id: 'project-1', title: json.title, objective: json.objective, description: json.description, canDelete: false }
    return jsonResponse(this.projectDetail(), 201)
  }

  editPlan(json) {
    if (json.expectedPlanRevision !== this.workflow.planRevision) {
      return jsonResponse({ error: 'plan revision conflict', code: 'STAGE_PLAN_CONFLICT' }, 409)
    }
    this.workflow.planRevision += 1
    for (const next of json.nextStages) {
      const stage = this.stages.find((item) => item.id === next.id)
      if (stage && next.description) stage.description = next.description
    }
    return jsonResponse(this.stagesPayload())
  }

  prepare(fileName, body) {
    const id = `upload-${++this.ids.upload}`
    const upload = { id, projectId: 'project-1', status: 'ready', fileName, bytes: body }
    this.uploads.set(id, upload)
    return jsonResponse({ id, projectId: 'project-1', status: 'ready', fileName }, 201)
  }

  confirm(request) {
    if (!request.json || request.headers.get('x-file-name') || request.call.contentType === PDF_MIME_TYPE) {
      return jsonResponse({ error: '请先 POST /report-uploads 再以 JSON 确认提交。', code: 'UPLOAD_PROTOCOL_RETIRED' }, 410)
    }
    const command = request.json
    const upload = this.uploads.get(command.uploadId)
    const stage = this.stages.find((item) => item.id === command.stageId)
    if (!upload || !stage) return jsonResponse({ error: 'upload or stage missing', code: 'INVALID_SUBMISSION' }, 400)
    const id = `report-${++this.ids.report}`
    const stageVersion = [...this.reports.values()].filter((report) => report.stageId === stage.id).length + 1
    const submissionSequence = this.workflow.nextSubmissionSequence
    this.workflow.nextSubmissionSequence += 1
    this.workflow.workflowRevision += 1
    if (command.reportKind === 'completion') {
      stage.currentCompletionReportId = id
      stage.completionRevision += 1
      stage.lifecycleStatus = 'completed'
      const next = this.stages.find((item) => item.ordinal === stage.ordinal + 1)
      if (next) {
        next.lifecycleStatus = 'in_progress'
        this.workflow.currentStageId = next.id
      }
    }
    const report = {
      id,
      projectId: 'project-1',
      stageId: stage.id,
      stageVersion,
      submissionSequence,
      submittedAs: command.reportKind,
      fileName: upload.fileName,
      title: upload.fileName,
      bytes: upload.bytes,
      sourceSize: upload.bytes.length,
      submittedAt: new Date().toISOString(),
    }
    this.reports.set(id, report)
    return jsonResponse({
      receipt: {
        reportId: id,
        projectId: 'project-1',
        stageId: stage.id,
        stageVersion,
        submissionSequence,
        submittedAs: command.reportKind,
        submittedAt: report.submittedAt,
        title: report.title,
        fileName: report.fileName,
        sourceSize: report.sourceSize,
      },
      replayed: false,
    }, 201)
  }

  reportWrite(method, reportId, json) {
    const report = this.reports.get(reportId)
    if (method === 'GET') return jsonResponse(this.detail(report))
    if (method === 'PATCH') return jsonResponse({ error: '已提交报告的阶段归属不可修改。', code: 'REPORT_STAGE_IMMUTABLE' }, 409)
    if (method === 'PUT') return jsonResponse({ error: '已提交报告的源文件不可替换。', code: 'REPORT_SOURCE_IMMUTABLE' }, 409)
    if (method === 'DELETE') {
      const stage = this.stages.find((item) => item.currentCompletionReportId === reportId)
      if (stage) {
        this.deletes.reports.push({ id: reportId, status: 409 })
        return jsonResponse({ error: '当前完结报告受保护。', code: 'COMPLETION_REPORT_PROTECTED' }, 409)
      }
      if (!json?.reason) return jsonResponse({ error: '请填写删除原因。', code: 'INVALID_DELETE_REASON' }, 400)
      this.deletedReportIds.push(reportId)
      this.deletes.reports.push({ id: reportId, status: 200 })
      this.reports.delete(reportId)
      return jsonResponse({ ok: true, reportId })
    }
    return jsonResponse({ error: 'method not allowed', code: 'NOT_FOUND' }, 405)
  }

  startTask(reportId, operation) {
    const existing = this.latestTask(reportId, operation)
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return jsonResponse({ job: existing, reused: true }, 200)
    }
    const job = this.createJob(reportId, operation)
    return jsonResponse({ job, reused: false }, 202)
  }

  retry(jobId) {
    const current = this.tasks.get(jobId)
    const job = this.createJob(current.reportId, current.operation)
    return jsonResponse({ job, reused: false }, 202)
  }

  createJob(reportId, operation) {
    const id = `job-${++this.ids.job}`
    const job = {
      id,
      reportId,
      projectId: 'project-1',
      operation,
      status: 'queued',
      errorCode: undefined,
      polls: 0,
    }
    this.tasks.set(id, job)
    return job
  }

  latestTask(reportId, operation) {
    return [...this.tasks.values()].reverse().find((task) => task.reportId === reportId && task.operation === operation)
  }

  viewJob(jobId) {
    const job = this.tasks.get(jobId)
    job.polls += 1
    if (job.status === 'queued' && job.polls >= 2) {
      job.status = 'failed'
      job.errorCode = 'MODEL_EXECUTION_FAILED'
    }
    return job
  }

  detail(report) {
    const analysisTask = this.latestTask(report.id, 'analysis')
    const insightTask = this.latestTask(report.id, 'insight')
    const stage = this.stages.find((item) => item.id === report.stageId)
    return {
      ...this.card(report),
      analysisTask,
      insightTask,
      job: analysisTask,
      labels: {
        stageLabel: stage.title,
        reportLabel: `${stage.title} V${report.stageVersion}`,
        compactLabel: `阶段0${stage.ordinal} V${report.stageVersion}`,
        roleLabel: report.submittedAs === 'completion' ? '阶段完结报告' : '阶段更新报告',
      },
    }
  }

  card(report) {
    const stage = this.stages.find((item) => item.id === report.stageId)
    return {
      id: report.id,
      projectId: report.projectId,
      stageId: report.stageId,
      stageVersion: report.stageVersion,
      submissionSequence: report.submissionSequence,
      title: report.title,
      fileName: report.fileName,
      sourceSize: report.sourceSize,
      submittedAs: report.submittedAs,
      submittedAt: report.submittedAt,
      isCurrentCompletion: stage.currentCompletionReportId === report.id,
      labels: { reportLabel: `${stage.title} V${report.stageVersion}` },
    }
  }

  projectDetail() {
    return { project: this.project, ...this.stagesPayload() }
  }

  stagesPayload() {
    return {
      workflow: this.workflow,
      stages: this.stages.map((stage) => ({
        stage,
        reports: [],
        skippedEmpty: false,
        canSubmitUpdate: stage.lifecycleStatus !== 'completed',
        canSubmitCompletion: true,
      })),
      currentCompletionByStage: Object.fromEntries(
        this.stages.filter((stage) => stage.currentCompletionReportId).map((stage) => [stage.id, stage.currentCompletionReportId]),
      ),
    }
  }
}

function readBody(body) {
  if (!body) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body === 'string') return Buffer.from(body)
  return Buffer.from(String(body))
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
