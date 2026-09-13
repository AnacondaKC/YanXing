import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectWebHealthResponse, inspectWorkerHeartbeat } from './docker-healthcheck.mjs'
import {
  createMinimalPdfBuffer,
  createPreviewableDocxBuffer,
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
} from './deployment-fixtures.mjs'
import {
  SmokeClient,
  createIdempotencyKey,
  createSmokeProject,
  editSmokeStagePlan,
  prepareReportUpload,
  waitForUploadReady,
  confirmReportSubmission,
  loadStages,
  waitForAnalysisTask,
  waitForInsightTask,
  runFull,
} from './deployment-smoke.mjs'
import { runNativeBackupRestoreDrill } from './p5-backup-restore.mjs'

export {
  NOT_QUIESCENT_MESSAGE,
  assertTaskProbePreserved,
  backupLayoutFromIsolated,
  classifyNativeBackupFailure,
  inspectIsolatedQuiescence,
  parseBackupCliJson,
  preserveRuntimeRootAside,
  readPublishedRestoreProbe,
  resolveBackupCli,
  restoreIncompleteMarkerPath,
  runNativeBackupRestoreDrill,
  summarizeTaskProbe,
  buildNativeBackupCliArgs,
  RESTORE_INCOMPLETE_MARKER_PREFIX,
} from './p5-backup-restore.mjs'

const projectRootFromScript = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_TIMEOUT_MS = 240_000
const DEFAULT_POLL_MS = 500
const DEFAULT_USERNAME = 'admin'
const SMOKE_CHANNEL_NAME = 'deployment-smoke'
const SMOKE_MODEL_NAME = 'deployment-smoke-model'
const SMOKE_API_KEY = 'deployment-smoke-key'
const PARSER_PATH_FAILURE = /无法定位|解析进程启动失败|Cannot find module|ERR_MODULE_NOT_FOUND/
const SUCCESS_CONTEXT_CHARACTERS = 32_000
const SUCCESS_OUTPUT_TOKENS = 4_096

export const FAKE_STABLE_MASTER_KEY = 'p5-release-acceptance-fake-stable-master-key'
export const NATIVE_SCHEMA_NAME = 'yanxing-native-p3'
export const LEGACY_SCHEMA_MARKERS = [
  'schema_migrations',
  'report_versions',
  'report_facts',
  'analysis_jobs',
  'analysis_module_states',
  'analysis_artifacts',
  'analysis_snapshots',
  'job_events',
  'report_insights',
  'report_insight_reservations',
  'ai_budget_ledger',
]
export const SECRET_OBJECT_KEYS = new Set([
  'password',
  'adminPassword',
  'apiKey',
  'masterKey',
  'settingsEncryptionKey',
  'YANXING_SETTINGS_ENCRYPTION_KEY',
  'YANXING_ADMIN_PASSWORD',
  'YANXING_SMOKE_PASSWORD',
  'YANXING_CHAT_COMPLETIONS_API_KEY',
])

export class P5AcceptanceError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message)
    this.name = 'P5AcceptanceError'
    this.exitCode = exitCode
  }
}

const shutdownHooks = new Set()

export function registerAcceptanceShutdown(hook) {
  shutdownHooks.add(hook)
  return () => shutdownHooks.delete(hook)
}

export async function runAcceptanceShutdown() {
  const hooks = [...shutdownHooks]
  shutdownHooks.clear()
  await Promise.allSettled(hooks.map((hook) => hook()))
}

export function usage() {
  return `YanXing P5 isolated release acceptance.

Starts the release candidate's production Next (standalone server.js) and the
compiled default native Worker against a NEW temp root. Loopback-only ports,
explicit fake master key, isolated heartbeat/ready/instance paths, seeded admin.
Reuses scripts/deployment-smoke.mjs native operator flow against that URL only.
No live deployment, no paid providers, no replacement user-facing server.

Required (one of):
  --release-root <dir>     Assembled candidate: server.js + .runtime Worker + .next-p5-qa snapshot
  --artifact-path <dir>    Fallback: .next-p5-qa (nested standalone) or plain .next-p4-qa dist

Optional:
  --with-backup-restore   After success, stop OWN web+worker, native-backup the live
                          isolated DB/reports, rename the runtime root aside, restore
                          to the SAME absolute paths, restart, and GET published
                          report/file/analysis/insight. HMAC key is env-only;
                          --key-file is never passed and must stay outside runtime,
                          archive, destination, and collections if an operator uses it.
  YANXING_P5_RELEASE_ROOT / YANXING_P5_ARTIFACT_PATH / YANXING_P5_WITH_BACKUP_RESTORE
  YANXING_P5_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS}
  YANXING_P5_POLL_MS=${DEFAULT_POLL_MS}

Credentials never appear in logs or the JSON result. Backup HMAC uses
YANXING_SETTINGS_ENCRYPTION_KEY in the isolated env (never --key-file, never logs).
Leftover READY uploads/tasks/reservations surface NOT_QUIESCENT; expiry is not faked.
Incomplete restore markers are scoped .yanxing-restore-incomplete-<sha256(runtimeRoot)>
and are never auto-deleted.
`
}

export function parseArgs(argv) {
  let help = false
  let releaseRoot
  let artifactPath
  let withBackupRestore = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') help = true
    else if (argument === '--release-root') releaseRoot = requiredValue(argv, ++index, argument)
    else if (argument.startsWith('--release-root=')) releaseRoot = argument.slice('--release-root='.length)
    else if (argument === '--artifact-path') artifactPath = requiredValue(argv, ++index, argument)
    else if (argument.startsWith('--artifact-path=')) artifactPath = argument.slice('--artifact-path='.length)
    else if (argument === '--with-backup-restore') withBackupRestore = true
    else throw new P5AcceptanceError(`未知参数：${argument}`, { exitCode: 2 })
  }
  return { help, releaseRoot, artifactPath, withBackupRestore }
}

function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new P5AcceptanceError(`参数 ${flag} 缺少路径。`, { exitCode: 2 })
  return value
}

export function resolveCliPaths(args, env = process.env) {
  const releaseRoot = trimToUndefined(args.releaseRoot) ?? trimToUndefined(env.YANXING_P5_RELEASE_ROOT)
  const artifactPath = trimToUndefined(args.artifactPath) ?? trimToUndefined(env.YANXING_P5_ARTIFACT_PATH)
  if (!releaseRoot && !artifactPath) {
    throw new P5AcceptanceError('必须通过 --release-root 或 --artifact-path 指定发布产物。', { exitCode: 2 })
  }
  return {
    releaseRoot,
    artifactPath,
    withBackupRestore: Boolean(args.withBackupRestore) || isTruthyEnv(env.YANXING_P5_WITH_BACKUP_RESTORE),
  }
}

export function isTruthyEnv(value) {
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function resolveReleaseArtifacts({
  releaseRoot,
  artifactPath,
  projectRoot = projectRootFromScript,
} = {}) {
  if (releaseRoot) {
    return resolveStandaloneCandidate(path.resolve(projectRoot, releaseRoot), { projectRoot, requestedAs: 'release-root' })
  }
  if (!artifactPath) {
    throw new P5AcceptanceError('必须通过 --release-root 或 --artifact-path 指定发布产物。', { exitCode: 2 })
  }
  const resolved = path.resolve(projectRoot, artifactPath)
  if (isStandaloneRoot(resolved)) {
    return resolveStandaloneCandidate(resolved, { projectRoot, requestedAs: 'artifact-path' })
  }
  if (isNextDist(resolved)) {
    const nested = path.join(resolved, 'standalone')
    if (isStandaloneRoot(nested)) {
      return resolveStandaloneCandidate(nested, {
        projectRoot,
        requestedAs: 'artifact-path',
        sourceDist: resolved,
      })
    }
    return resolveNextStartCandidate(resolved, { projectRoot })
  }
  throw new P5AcceptanceError(`无法识别发布产物：${resolved}`, { exitCode: 2 })
}

function resolveStandaloneCandidate(webCwd, { projectRoot, sourceDist } = {}) {
  const webScript = mustFile(path.join(webCwd, 'server.js'), 'standalone server.js')
  const snapshotDir = firstExistingDirectory([
    path.join(webCwd, '.next-p5-qa'),
    sourceDist ? path.join(webCwd, path.basename(sourceDist)) : undefined,
    path.join(webCwd, '.next'),
    sourceDist,
  ])
  if (!snapshotDir || !existsSync(path.join(snapshotDir, 'BUILD_ID'))) {
    throw new P5AcceptanceError(`standalone 缺少 .next-p5-qa 快照 BUILD_ID：${webCwd}`, { exitCode: 2 })
  }
  const runtime = resolveCompiledRuntime({ preferredRoot: webCwd, projectRoot })
  return {
    kind: 'standalone',
    webKind: 'server.js',
    webCwd,
    webScript,
    webArgs: [],
    workerCwd: runtime.workerCwd,
    workerScript: runtime.workerScript,
    migrateScript: runtime.migrateScript,
    createUserScript: runtime.createUserScript,
    runtimeRoot: runtime.runtimeRoot,
    snapshotDir,
    nextDistDirName: path.basename(snapshotDir),
    nextBuildId: readBuildId(snapshotDir),
    sourceDist: sourceDist ?? null,
  }
}

function resolveNextStartCandidate(distDir, { projectRoot }) {
  const nextBin = mustFile(
    path.join(projectRoot, 'node_modules/next/dist/bin/next'),
    'next start 入口',
  )
  const runtime = resolveCompiledRuntime({ preferredRoot: projectRoot, projectRoot })
  return {
    kind: 'next-start',
    webKind: 'next start',
    webCwd: projectRoot,
    webScript: nextBin,
    webArgs: ['start', '--hostname', '127.0.0.1'],
    workerCwd: runtime.workerCwd,
    workerScript: runtime.workerScript,
    migrateScript: runtime.migrateScript,
    createUserScript: runtime.createUserScript,
    runtimeRoot: runtime.runtimeRoot,
    snapshotDir: distDir,
    nextDistDirName: path.relative(projectRoot, distDir) || path.basename(distDir),
    nextBuildId: readBuildId(distDir),
    sourceDist: distDir,
  }
}

function resolveCompiledRuntime({ preferredRoot, projectRoot }) {
  const runtimeRoot = firstExistingDirectory([
    path.join(preferredRoot, '.runtime'),
    path.join(projectRoot, '.runtime'),
  ])
  if (!runtimeRoot) throw new P5AcceptanceError('找不到编译后的 .runtime Worker。', { exitCode: 2 })
  const workerScript = mustFile(path.join(runtimeRoot, 'worker/index.mjs'), 'default native Worker')
  const migrateScript = mustFile(path.join(runtimeRoot, 'scripts/migrate.mjs'), 'migrate.mjs')
  const createUserScript = mustFile(path.join(runtimeRoot, 'scripts/create-user.mjs'), 'create-user.mjs')
  mustFile(path.join(runtimeRoot, 'lib/documents/pdf-parser-worker.mjs'), 'compiled PDF parser')
  mustFile(path.join(runtimeRoot, 'lib/documents/docx-parser-worker.mjs'), 'compiled DOCX parser')
  const workerCwd = isPathInside(runtimeRoot, preferredRoot) ? preferredRoot : projectRoot
  return { runtimeRoot, workerScript, migrateScript, createUserScript, workerCwd }
}

export async function recordReleaseIdentity(artifacts) {
  const hashes = {
    worker: await sha256File(artifacts.workerScript),
    migrate: await sha256File(artifacts.migrateScript),
    createUser: await sha256File(artifacts.createUserScript),
  }
  if (artifacts.webKind === 'server.js') hashes.server = await sha256File(artifacts.webScript)
  return {
    kind: artifacts.kind,
    webKind: artifacts.webKind,
    snapshotDir: artifacts.snapshotDir,
    nextDistDirName: artifacts.nextDistDirName,
    nextBuildId: artifacts.nextBuildId,
    workerScript: artifacts.workerScript,
    hashes,
  }
}

export async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function readSchemaIdentity(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => String(row.name))
    const legacyTables = LEGACY_SCHEMA_MARKERS.filter((name) => tables.includes(name))
    if (legacyTables.length > 0) {
      throw new P5AcceptanceError(`运行库出现遗留表：${legacyTables.join(', ')}`)
    }
    if (tables.includes('schema_migrations')) {
      throw new P5AcceptanceError('运行库包含 schema_migrations，禁止走遗留迁移。')
    }
    const identity = database.prepare(
      'SELECT name, checksum, initialized_at FROM native_schema_identity WHERE id = 1',
    ).get()
    if (!identity?.name || !identity?.checksum) {
      throw new P5AcceptanceError('运行库缺少 native_schema_identity。')
    }
    if (identity.name !== NATIVE_SCHEMA_NAME) {
      throw new P5AcceptanceError(`schema 名称不是 ${NATIVE_SCHEMA_NAME}：${identity.name}`)
    }
    return {
      name: identity.name,
      checksum: identity.checksum,
      initializedAt: identity.initialized_at,
      tables,
      legacyTables,
    }
  } finally {
    database.close()
  }
}

export function collectSecretValues(input = {}) {
  return uniqueStrings([
    input.adminPassword,
    input.masterKey,
    input.password,
    input.apiKey,
    FAKE_STABLE_MASTER_KEY,
    SMOKE_API_KEY,
    ...(Array.isArray(input.extra) ? input.extra : []),
  ])
}

export function redactSecrets(value, secrets = []) {
  if (typeof value === 'string') return redactString(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets))
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SECRET_OBJECT_KEYS.has(key) ? '[redacted]' : redactSecrets(nested, secrets)
    }
    return output
  }
  return value
}

function redactString(value, secrets) {
  let output = value
  for (const secret of [...secrets].filter((item) => item && item.length >= 8).sort((left, right) => right.length - left.length)) {
    output = output.split(secret).join('[redacted]')
  }
  return output
}

export function serializeAcceptanceResult(result, secrets) {
  return `${JSON.stringify(redactSecrets(result, secrets), null, 2)}\n`
}

export async function createIsolatedWorkspace({ tmpdir = os.tmpdir() } = {}) {
  const root = await mkdtemp(path.join(tmpdir, 'yanxing-p5-acceptance-'))
  const storage = path.join(root, 'storage')
  await mkdir(path.join(storage, 'knowledge'), { recursive: true })
  return {
    root,
    databasePath: path.join(storage, 'yanxing.sqlite'),
    runtimeRoot: storage,
    storageRoot: path.join(storage, 'reports'),
    knowledgeRoot: path.join(storage, 'knowledge'),
    heartbeatPath: path.join(root, 'worker-heartbeat.json'),
    readyPath: path.join(root, 'worker-ready'),
    manifestPath: path.join(root, 'deployment-smoke.json'),
    instanceToken: `p5-${randomBytes(8).toString('hex')}`,
    adminPassword: randomBytes(24).toString('hex'),
    masterKey: FAKE_STABLE_MASTER_KEY,
    username: DEFAULT_USERNAME,
  }
}

export function buildIsolatedProcessEnv({ isolated, artifacts, extra = {} }) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TZ: process.env.TZ,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    YANXING_COMPILED_RUNTIME: '1',
    YANXING_DATABASE_PATH: isolated.databasePath,
    YANXING_KNOWLEDGE_STORAGE_ROOT: isolated.knowledgeRoot,
    YANXING_SETTINGS_ENCRYPTION_KEY: isolated.masterKey,
    YANXING_WORKER_HEARTBEAT_PATH: isolated.heartbeatPath,
    YANXING_WORKER_READY_PATH: isolated.readyPath,
    YANXING_INSTANCE_TOKEN: isolated.instanceToken,
    YANXING_CHAT_COMPLETIONS_API_KEY: '',
    YANXING_CHAT_COMPLETIONS_BASE_URL: '',
    YANXING_CHAT_COMPLETIONS_MODEL: '',
    YANXING_ADMIN_PASSWORD: isolated.adminPassword,
    YANXING_NEXT_DIST_DIR: artifacts.nextDistDirName,
    YANXING_WORKER_POLL_MS: '250',
    YANXING_WORKER_LEASE_MS: '4000',
    YANXING_WORKER_MAX_ATTEMPTS: '2',
    HOSTNAME: '127.0.0.1',
    PORT: String(isolated.webPort),
    ...extra,
  }
}

export async function reserveLoopbackPort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

export function spawnManagedChild({
  name,
  command,
  args,
  cwd,
  env,
  children,
  logs,
  secrets,
}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const record = { name, child, pid: child.pid }
  children.add(record)
  const append = (chunk) => {
    logs.push({ name, text: redactSecrets(String(chunk), secrets) })
    if (logs.length > 800) logs.shift()
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  record.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      children.delete(record)
      resolve({ code, signal })
    })
  })
  record.completion.catch(() => {})
  return record
}

export async function stopManagedChildren(children, { graceMs = 8_000 } = {}) {
  const active = [...children]
  for (const record of active) killTree(record.child, 'SIGTERM')
  const deadline = Date.now() + graceMs
  await Promise.all(active.map(async (record) => {
    const remaining = Math.max(50, deadline - Date.now())
    let timer
    const finished = await Promise.race([
      record.completion,
      new Promise((resolve) => { timer = setTimeout(resolve, remaining, 'timeout') }),
    ]).finally(() => clearTimeout(timer))
    if (finished === 'timeout' && isPidAlive(record.child.pid)) {
      killTree(record.child, 'SIGKILL')
      await record.completion.catch(() => {})
    }
  }))
  children.clear()
}

export function killTree(child, signal) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function runForegroundCommand({
  command,
  args,
  cwd,
  env,
  secrets,
  timeoutMs = 30_000,
  label,
}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  let timer
  const timedOut = await Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () => resolve(false))
    }),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, true) }),
  ]).finally(() => clearTimeout(timer))
  if (timedOut) {
    killTree(child, 'SIGKILL')
    throw new P5AcceptanceError(`${label} 超时`)
  }
  const output = redactSecrets(`${stdout}\n${stderr}`, secrets)
  if (child.exitCode !== 0) {
    throw new P5AcceptanceError(`${label} 失败（exit ${child.exitCode ?? child.signalCode}）：${output.trim().slice(0, 1_200)}`)
  }
  return { stdout: redactSecrets(stdout, secrets), stderr: redactSecrets(stderr, secrets) }
}

export async function startReleaseProviderFixture({
  host = '127.0.0.1',
  mode = 'fail',
  failureMessage = 'p5-acceptance-model-failure',
} = {}) {
  const fixture = {
    mode,
    failureMessage,
    host,
    port: 0,
    requests: [],
    server: null,
    setMode(next) {
      fixture.mode = next
    },
  }
  fixture.server = createHttpServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      fixture.requests.push({ method: request.method, url: request.url, body: raw })
      if (fixture.mode === 'fail') {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: fixture.failureMessage } }))
        return
      }
      let parsed = {}
      try {
        parsed = raw ? JSON.parse(raw) : {}
      } catch {
        parsed = {}
      }
      const jsonMode = parsed?.response_format?.type === 'json_object'
      const content = jsonMode ? JSON.stringify(validReleaseAnalysisPayload()) : validReleaseInsightHtml()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content } }],
      }))
    })
  })
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject)
    fixture.server.listen(0, host, () => {
      fixture.port = fixture.server.address().port
      resolve()
    })
  })
  return fixture
}

export async function closeProviderFixture(fixture) {
  if (!fixture?.server) return
  await new Promise((resolve) => fixture.server.close(() => resolve()))
}

export function validReleaseAnalysisPayload(score = 80) {
  return {
    '综合评分': {
      研究价值: score,
      方法严谨: score,
      证据质量: score,
      逻辑一致: score,
      结论强度: score,
      可执行性: score,
      主要影响因素: '证据与研究目标相匹配',
    },
    '报告详情': {
      章节: [{ 标题: '正文', 摘要: '分析投资方案与现金流安排。' }],
      完整度结论: '整体完整度良好',
    },
    '报告完整度': {
      研究目标: 80,
      方法与数据: 75,
      证据覆盖: 82,
      分析结构: 78,
      结论覆盖: 72,
      风险与建议: 70,
      主要缺口: '补充风险验证',
    },
    '思维导图': {
      名称: '投资研究',
      子节点: [{ 名称: '收益', 子节点: [] }, { 名称: '风险', 子节点: [] }],
    },
    '词云': Array.from({ length: 50 }, (_, index) => `主题${String.fromCodePoint(0x4e00 + index)}`),
    '热力图': [{
      章节: '正文',
      文献综述: 100,
      定性分析: 55,
      定量建模: 30,
      案例研究: 0,
      实地调研: 0,
      对比分析: 45,
    }],
    'AI建议': ['补充现金流压力测试和风险缓释措施。'],
  }
}

export function validReleaseInsightHtml() {
  return '<article><h1>研究洞察</h1><blockquote>证据支持结论。</blockquote><h2 id="risk">风险建议</h2><p>开展压力测试。</p></article>'
}

export function createSuccessDocuments(marker) {
  const pdfText = `P5PDF ${marker} 研究目标是建立可验证的研究证据。通过访谈与数据分析提出可执行的建议，并评估预算、风险和时间安排。`
  const docxText = `P5DOCX ${marker} 研究目标是建立可验证的研究证据。通过访谈与数据分析提出可执行的建议，并评估预算、风险和时间安排。`
  const pdfBytes = createMinimalPdfBuffer(pdfText)
  const docxBytes = createPreviewableDocxBuffer(docxText)
  return {
    pdf: { kind: 'PDF', fileName: `p5-success-${marker}.pdf`, bytes: pdfBytes, sha256: sha256Hex(pdfBytes), expectedText: pdfText },
    docx: { kind: 'DOCX', fileName: `p5-success-${marker}.docx`, bytes: docxBytes, sha256: sha256Hex(docxBytes), expectedText: docxText },
  }
}

export function pickSubmitStage(stages) {
  const current = stages.find((stage) => stage.lifecycleStatus === 'in_progress') ?? stages[0]
  if (!current?.id) throw new P5AcceptanceError('课题缺少可提交的研究阶段。')
  return current
}

export async function submitNativeSuccessReport({ client, projectId, document, reportKind = 'update', deadline, pollMs }) {
  const mimeType = document.kind === 'PDF' ? PDF_MIME_TYPE : DOCX_MIME_TYPE
  const prepared = await prepareReportUpload(client, {
    projectId,
    fileName: document.fileName,
    mimeType,
    bytes: document.bytes,
  })
  const upload = await waitForUploadReady(client, { projectId, upload: prepared, deadline, pollMs })
  const bundle = await loadStages(client, projectId)
  const confirmed = await confirmReportSubmission(client, {
    projectId,
    uploadId: upload.id,
    stage: pickSubmitStage(bundle.stages),
    workflow: bundle.workflow,
    reportKind,
    idempotencyKey: createIdempotencyKey(),
  })
  return confirmed.receipt
}

export function assertSuccessfulWorkerOutcome({ analysisTask, insightTask, detail }) {
  if (!analysisTask?.id) throw new P5AcceptanceError('缺少 analysisTask。')
  const diagnostic = [analysisTask.errorCode, analysisTask.errorMessage, insightTask?.errorCode, insightTask?.errorMessage]
    .filter(Boolean).join(' ')
  if (PARSER_PATH_FAILURE.test(diagnostic)) {
    throw new P5AcceptanceError(`解析子进程失败：${diagnostic}`)
  }
  if (analysisTask.status !== 'completed') {
    throw new P5AcceptanceError(
      `分析任务 ${analysisTask.id} 终态为 ${analysisTask.status}（${analysisTask.errorCode ?? '无错误码'}），期望 completed。`,
    )
  }
  if (!insightTask?.id) throw new P5AcceptanceError('缺少 insightTask。')
  if (insightTask.status !== 'completed') {
    throw new P5AcceptanceError(`洞察任务 ${insightTask.id} 终态为 ${insightTask.status}，期望 completed。`)
  }
  if (!detail?.snapshot) throw new P5AcceptanceError(`报告 ${detail?.id ?? analysisTask.reportId} 缺少已发布分析快照。`)
  if (!detail?.insight?.html) throw new P5AcceptanceError(`报告 ${detail?.id ?? analysisTask.reportId} 缺少已发布洞察 HTML。`)
  return {
    reportId: detail.id ?? analysisTask.reportId,
    analysisTaskId: analysisTask.id,
    insightTaskId: insightTask.id,
    status: 'completed',
    hasSnapshot: true,
    hasInsightHtml: true,
  }
}

export async function waitForWebHealth(baseUrl, { timeoutMs = 90_000, pollMs = 250, child } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new P5AcceptanceError(`Web 在就绪前退出（${child.signalCode ?? child.exitCode}）`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000), redirect: 'error' })
      const text = await response.text()
      if (inspectWebHealthResponse(response.status, text)) return true
    } catch {
      // still starting
    }
    await delay(pollMs)
  }
  throw new P5AcceptanceError('Web /api/health 就绪超时')
}

export async function waitForWorkerReady({ readyPath, instanceToken, timeoutMs = 30_000, pollMs = 100, child } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new P5AcceptanceError(`Worker 在就绪前退出（${child.signalCode ?? child.exitCode}）`)
    }
    try {
      if ((await readFile(readyPath, 'utf8')) === instanceToken) return true
    } catch {
      // ready file not written yet
    }
    await delay(pollMs)
  }
  throw new P5AcceptanceError('Worker ready 文件超时')
}

export async function waitForWorkerHeartbeat(heartbeatPath, { timeoutMs = 30_000, pollMs = 100, child } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new P5AcceptanceError(`Worker 在心跳就绪前退出（${child.signalCode ?? child.exitCode}）`)
    }
    try {
      const content = await readFile(heartbeatPath, 'utf8')
      if (inspectWorkerHeartbeat({ content, nowMs: Date.now() })) return true
    } catch {
      // heartbeat not written yet
    }
    await delay(pollMs)
  }
  throw new P5AcceptanceError('Worker heartbeat 就绪超时')
}

export async function waitForLoopbackPortFree(port, { timeoutMs = 8_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isLoopbackPortBusy(port))) return true
    await delay(pollMs)
  }
  throw new P5AcceptanceError(`端口 127.0.0.1:${port} 仍被占用`)
}

async function isLoopbackPortBusy(port) {
  const server = createNetServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    await new Promise((resolve) => server.close(() => resolve()))
    return false
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') return true
    await new Promise((resolve) => server.close(() => resolve())).catch(() => {})
    return true
  }
}

export async function expectWebHealthFailure(baseUrl, { timeoutMs = 8_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000), redirect: 'error' })
      const text = await response.text()
      if (!inspectWebHealthResponse(response.status, text)) return true
    } catch {
      return true
    }
    await delay(pollMs)
  }
  throw new P5AcceptanceError('Web 停止后健康检查仍成功')
}

export async function withProcessEnv(overrides, fn) {
  const previous = {}
  const missing = []
  for (const [key, value] of Object.entries(overrides)) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) previous[key] = process.env[key]
    else missing.push(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const key of missing) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

export async function runNativeOperatorFailure({ client, config, modelPort }) {
  return withProcessEnv({ YANXING_COMPILED_RUNTIME: '1' }, () => runFull({ client, config, modelPort }))
}

export async function runNativeOperatorSuccess({ client, marker, deadline, pollMs }) {
  const documents = createSuccessDocuments(marker)
  const created = await createSmokeProject(client, marker)
  await editSmokeStagePlan({
    client,
    projectId: created.project.id,
    workflow: created.workflow,
    stages: created.stages,
    marker,
  })
  const reports = []
  for (const document of [documents.pdf, documents.docx]) {
    const receipt = await submitNativeSuccessReport({
      client,
      projectId: created.project.id,
      document,
      deadline,
      pollMs,
    })
    const analysis = await waitForAnalysisTask({ client, reportId: receipt.reportId, deadline, pollMs })
    const insight = await waitForInsightTask({ client, reportId: receipt.reportId, deadline, pollMs })
    const detail = await client.readJson('GET', `/api/reports/${receipt.reportId}`)
    const insightView = await client.readJson('GET', `/api/reports/${receipt.reportId}/insight`)
    const outcome = assertSuccessfulWorkerOutcome({ analysisTask: analysis, insightTask: insight, detail })
    if (!insightView?.insight?.html) {
      throw new P5AcceptanceError(`洞察接口未返回 html：${receipt.reportId}`)
    }
    reports.push({
      id: receipt.reportId,
      kind: document.kind,
      analysisTaskId: outcome.analysisTaskId,
      insightTaskId: outcome.insightTaskId,
      analysisStatus: analysis.status,
      insightStatus: insight.status,
      hasSnapshot: true,
      hasInsightHtml: true,
      aiScore: detail.aiScore ?? detail.snapshot?.aiScore?.overall ?? null,
    })
  }
  return { projectId: created.project.id, reports }
}

export async function raiseSmokeModelLimits(client) {
  const current = await client.readJson('GET', '/api/admin/ai-settings')
  let settings = current.settings
  if (!settings?.revision) throw new P5AcceptanceError('读取模型设置失败。')
  const existing = settings.channels.find((channel) => channel.name === SMOKE_CHANNEL_NAME)
  const existingModel = existing?.models?.find((model) => model.modelName === SMOKE_MODEL_NAME)
  if (!existing || !existingModel) throw new P5AcceptanceError('找不到 deployment-smoke 模型渠道，无法提升成功路径输出上限。')
  settings = await saveAiSettings(client, {
    action: 'save_channel',
    revision: settings.revision,
    channel: {
      id: existing.id,
      name: SMOKE_CHANNEL_NAME,
      baseUrl: existing.baseUrl,
      apiKey: SMOKE_API_KEY,
      models: [{
        id: existingModel.id,
        modelName: SMOKE_MODEL_NAME,
        maxContextCharacters: SUCCESS_CONTEXT_CHARACTERS,
        maxOutputTokens: SUCCESS_OUTPUT_TOKENS,
        reasoningEffort: existingModel.reasoningEffort ?? 'auto',
      }],
    },
  })
  const channel = settings.channels.find((item) => item.name === SMOKE_CHANNEL_NAME)
  const model = channel?.models?.find((item) => item.modelName === SMOKE_MODEL_NAME)
  if (!model?.id) throw new P5AcceptanceError('提升成功路径模型输出上限失败。')
  const targets = settings.assignments?.length
    ? settings.assignments.map((assignment) => assignment.target)
    : ['page_analysis', 'report_insight']
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
  if (!payload.settings?.revision) throw new P5AcceptanceError(`保存模型设置失败（${json.action}）。`)
  return payload.settings
}

export async function runP5ReleaseAcceptance({
  releaseRoot,
  artifactPath,
  withBackupRestore = false,
  projectRoot = projectRootFromScript,
  timeoutMs = readPositiveInteger(process.env.YANXING_P5_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  pollMs = readPositiveInteger(process.env.YANXING_P5_POLL_MS, DEFAULT_POLL_MS),
  keepWorkspaceOnFailure = true,
} = {}) {
  const artifacts = resolveReleaseArtifacts({ releaseRoot, artifactPath, projectRoot })
  const identity = await recordReleaseIdentity(artifacts)
  const isolated = await createIsolatedWorkspace()
  isolated.webPort = await reserveLoopbackPort()
  const secrets = collectSecretValues(isolated)
  const children = new Set()
  const logs = []
  const env = buildIsolatedProcessEnv({ isolated, artifacts })
  const fixtureFailure = `p5-acceptance-model-failure-${isolated.instanceToken}`
  const marker = `p5-${isolated.instanceToken.slice(3, 11)}`
  const baseUrl = `http://127.0.0.1:${isolated.webPort}`
  let fixture
  let web
  let worker
  const unregisterShutdown = registerAcceptanceShutdown(async () => {
    await stopManagedChildren(children)
    await closeProviderFixture(fixture)
  })
  const result = {
    ok: false,
    mode: 'p5-release-acceptance',
    isolated: true,
    paidProviders: false,
    artifacts: identity,
    workspace: isolated.root,
    baseUrl,
  }
  try {
    fixture = await startReleaseProviderFixture({
      host: '127.0.0.1',
      mode: 'fail',
      failureMessage: fixtureFailure,
    })
    await runForegroundCommand({
      command: process.execPath,
      args: [artifacts.migrateScript, '--mode=production'],
      cwd: artifacts.workerCwd,
      env,
      secrets,
      label: 'migrate',
    })
    result.schema = readSchemaIdentity(isolated.databasePath)
    await runForegroundCommand({
      command: process.execPath,
      args: [artifacts.createUserScript, '--mode=production', '--username', isolated.username, '--display-name', 'P5验收管理员'],
      cwd: artifacts.workerCwd,
      env,
      secrets,
      label: 'create-user',
    })
    worker = spawnService({
      name: 'worker',
      artifacts,
      isolated,
      env,
      children,
      logs,
      secrets,
    })
    web = spawnService({
      name: 'web',
      artifacts,
      isolated,
      env,
      children,
      logs,
      secrets,
    })
    await waitForWebHealth(baseUrl, { child: web.child })
    await waitForWorkerReady({ readyPath: isolated.readyPath, instanceToken: isolated.instanceToken, child: worker.child })
    await waitForWorkerHeartbeat(isolated.heartbeatPath, { child: worker.child })
    result.readiness = { web: 'ok', workerReady: true, heartbeat: true }

    killTree(web.child, 'SIGKILL')
    await web.completion.catch(() => {})
    children.delete(web)
    await expectWebHealthFailure(baseUrl)
    await waitForLoopbackPortFree(isolated.webPort)
    web = spawnService({ name: 'web', artifacts, isolated, env, children, logs, secrets })
    await waitForWebHealth(baseUrl, { child: web.child })
    result.restarts = { web: { crashedThenRecovered: true } }

    const client = new SmokeClient({ baseUrl, timeoutMs })
    const smokeConfig = {
      verify: false,
      baseUrl,
      username: isolated.username,
      password: isolated.adminPassword,
      marker,
      manifestPath: isolated.manifestPath,
      timeoutMs,
      pollMs,
      modelHost: '127.0.0.1',
      expectedFailure: fixtureFailure,
    }
    result.smoke = await runNativeOperatorFailure({ client, config: smokeConfig, modelPort: fixture.port })

    worker = await restartService({
      record: worker,
      signal: 'SIGKILL',
      children,
      spawn: () => spawnService({ name: 'worker', artifacts, isolated, env, children, logs, secrets }),
    })
    await waitForWorkerReady({ readyPath: isolated.readyPath, instanceToken: isolated.instanceToken, child: worker.child })
    await waitForWorkerHeartbeat(isolated.heartbeatPath, { child: worker.child })
    result.restarts.workerCrash = { recovered: true, pid: worker.pid }

    fixture.setMode('succeed')
    await raiseSmokeModelLimits(client)
    const successDeadline = Date.now() + timeoutMs
    result.success = await runNativeOperatorSuccess({
      client,
      marker: `${marker}-ok`,
      deadline: successDeadline,
      pollMs,
    })
    result.schemaAfter = readSchemaIdentity(isolated.databasePath)
    if (withBackupRestore) {
      try {
        result.backupRestore = await runNativeBackupRestoreDrill({
          artifacts,
          isolated,
          env,
          secrets,
          children,
          web,
          worker,
          client,
          success: result.success,
          logs,
          projectRoot,
          timeoutMs: Math.min(timeoutMs, 60_000),
          deps: {
            killTree,
            isPidAlive,
            delay,
            waitForLoopbackPortFree,
            runForegroundCommand,
            spawnService,
            waitForWebHealth,
            waitForWorkerReady,
            waitForWorkerHeartbeat,
          },
        })
      } catch (error) {
        throw error instanceof P5AcceptanceError
          ? error
          : new P5AcceptanceError(error instanceof Error ? error.message : String(error))
      }
    }
    result.ok = true
    await rm(isolated.root, { recursive: true, force: true })
    result.workspaceRemoved = true
    return redactSecrets(result, secrets)
  } catch (error) {
    result.error = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
    result.logs = logs.slice(-40)
    if (!keepWorkspaceOnFailure) await rm(isolated.root, { recursive: true, force: true })
    const wrapped = new P5AcceptanceError(result.error, { exitCode: error instanceof P5AcceptanceError ? error.exitCode : 1 })
    wrapped.result = redactSecrets(result, secrets)
    throw wrapped
  } finally {
    unregisterShutdown()
    await stopManagedChildren(children)
    await closeProviderFixture(fixture)
  }
}

function spawnService({ name, artifacts, isolated, env, children, logs, secrets }) {
  if (name === 'web') {
    const args = artifacts.kind === 'standalone'
      ? [artifacts.webScript]
      : [artifacts.webScript, ...artifacts.webArgs, '--port', String(isolated.webPort)]
    return spawnManagedChild({
      name,
      command: process.execPath,
      args,
      cwd: artifacts.webCwd,
      env,
      children,
      logs,
      secrets,
    })
  }
  return spawnManagedChild({
    name,
    command: process.execPath,
    args: [artifacts.workerScript],
    cwd: artifacts.workerCwd,
    env,
    children,
    logs,
    secrets,
  })
}

async function restartService({ record, signal, children, spawn }) {
  killTree(record.child, signal)
  await record.completion.catch(() => {})
  children.delete(record)
  return spawn()
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return 0
  }
  const paths = resolveCliPaths(args, env)
  const result = await runP5ReleaseAcceptance({
    releaseRoot: paths.releaseRoot,
    artifactPath: paths.artifactPath,
    withBackupRestore: paths.withBackupRestore,
  })
  console.log(serializeAcceptanceResult(result, collectSecretValues({
    adminPassword: result.error ? undefined : undefined,
    extra: [FAKE_STABLE_MASTER_KEY, SMOKE_API_KEY],
  })))
  return result.ok ? 0 : 1
}

function isStandaloneRoot(dir) {
  return existsSync(path.join(dir, 'server.js')) && statSync(path.join(dir, 'server.js')).isFile()
}

function isNextDist(dir) {
  return existsSync(path.join(dir, 'BUILD_ID')) && existsSync(path.join(dir, 'required-server-files.json'))
}

function readBuildId(snapshotDir) {
  return readFileSync(path.join(snapshotDir, 'BUILD_ID'), 'utf8').trim()
}

function mustFile(filePath, label) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new P5AcceptanceError(`找不到${label}：${filePath}`, { exitCode: 2 })
  }
  return filePath
}

function firstExistingDirectory(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate) && statSync(candidate).isDirectory())
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function trimToUndefined(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readPositiveInteger(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(process.argv[1]).href === import.meta.url
}

if (isMainModule()) {
  const onSignal = async () => {
    await runAcceptanceShutdown()
    process.exit(1)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    process.exitCode = await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(redactSecrets(message, [FAKE_STABLE_MASTER_KEY, SMOKE_API_KEY]))
    if (error?.result) console.error(serializeAcceptanceResult(error.result, [FAKE_STABLE_MASTER_KEY, SMOKE_API_KEY]))
    process.exitCode = error instanceof P5AcceptanceError ? error.exitCode : 1
  }
}
