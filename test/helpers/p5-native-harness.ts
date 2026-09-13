import { randomUUID } from 'node:crypto'
import { fork, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createMinimalDocxBuffer } from '../../scripts/deployment-fixtures.mjs'
import { createSubmissionProcessingRuntime } from '../../lib/reports/submission-processing-runtime'
import type { ReportSubmissionConfirmation } from '../../modules/reports/upload-domain'
import type { P5BootstrapConfig, P5NativeIdentity } from './p5-native-bootstrap'
import type { P5ConfirmMode, P5ConfirmOutcome } from './p5-confirm-process'

export { type P5ConfirmOutcome, type P5NativeIdentity }

export const P5_SETTINGS_ENCRYPTION_KEY = 'p5-fault-acceptance-settings-key'
export const P5_PROVIDER_API_KEY = 'p5-controlled-http-provider-key'
export const P5_MODEL_NAME = 'p5-controlled-model'
export const P5_OWNER_USERNAME = 'p5-owner'
export const P5_PLACEHOLDER_PROVIDER_URL = 'http://127.0.0.1:1'
export const P5_WORKER_LEASE_MS = 4_000
export const P5_SQLITE_BUSY_TIMEOUT_MS = 10_000
export const P5_REPORT_TEXT = '投资方案研究。研究目标关注现金流与风险。通过访谈和定量分析形成证据，提出可执行的建议。'

const TSX_LOADER = String(import.meta.resolve('tsx'))
const TSCONFIG_PATH = fileURLToPath(new URL('../../tsconfig.source.json', import.meta.url))
const BOOTSTRAP_SCRIPT = fileURLToPath(new URL('./p5-native-bootstrap.ts', import.meta.url))
const CONFIRM_SCRIPT = fileURLToPath(new URL('./p5-confirm-process.ts', import.meta.url))
const RECOVERY_SCRIPT = fileURLToPath(new URL('./p5-recovery-process.ts', import.meta.url))
const WORKER_SCRIPT = fileURLToPath(new URL('./p5-worker-process.ts', import.meta.url))

export interface P5NativeRoot {
  root: string
  databasePath: string
  storageRoot: string
  identity: P5NativeIdentity
}

export interface P5DurableConfirmSnapshot {
  reportId: string
  reports: Array<Record<string, unknown>>
  outbox: Array<Record<string, unknown>>
  allocations: Array<Record<string, unknown>>
  usage: Array<Record<string, unknown>>
  request: Record<string, unknown> | undefined
}

export interface P5ReadyUpload {
  uploadId: string
  sourceKey: string
  sourceSize: number
}

export function createP5ChildEnv(input: {
  databasePath: string
  providerBaseUrl?: string
}): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  environment.TSX_TSCONFIG_PATH = process.env.TSX_TSCONFIG_PATH ?? TSCONFIG_PATH
  environment.NODE_ENV = 'test'
  environment.YANXING_DATABASE_PATH = input.databasePath
  environment.YANXING_SETTINGS_ENCRYPTION_KEY = P5_SETTINGS_ENCRYPTION_KEY
  environment.YANXING_CHAT_COMPLETIONS_API_KEY = P5_PROVIDER_API_KEY
  environment.YANXING_CHAT_COMPLETIONS_MODEL = P5_MODEL_NAME
  environment.YANXING_CHAT_COMPLETIONS_BASE_URL = input.providerBaseUrl ?? P5_PLACEHOLDER_PROVIDER_URL
  environment.YANXING_WORKER_LEASE_MS = String(P5_WORKER_LEASE_MS)
  environment.YANXING_WORKER_POLL_MS = '100'
  environment.YANXING_WORKER_CONCURRENCY = '1'
  return environment
}

export async function createP5NativeRoot(): Promise<P5NativeRoot> {
  const root = await mkdtemp(join(tmpdir(), 'yanxing-p5-'))
  const databasePath = join(root, 'yanxing.sqlite')
  const storageRoot = join(root, 'reports')
  await mkdir(storageRoot, { recursive: true })
  const identity = await spawnP5Bootstrap({ databasePath, storageRoot, ownerUsername: P5_OWNER_USERNAME })
  return { root, databasePath, storageRoot, identity }
}

export async function disposeP5NativeRoot(root: P5NativeRoot) {
  await rm(root.root, { recursive: true, force: true })
}

export function openP5Database(databasePath: string) {
  const database = new DatabaseSync(databasePath, { timeout: P5_SQLITE_BUSY_TIMEOUT_MS })
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=' + P5_SQLITE_BUSY_TIMEOUT_MS)
  return database
}

export function bindP5ProviderBaseUrl(database: DatabaseSync, baseUrl: string) {
  database.prepare('UPDATE ai_model_channels SET base_url=?, updated_at=?').run(baseUrl, new Date().toISOString())
}

export function p5Runtime(input: { database: DatabaseSync; storageRoot: string }) {
  return createSubmissionProcessingRuntime({
    database: input.database,
    storageRoot: input.storageRoot,
    resolveActorId: () => undefined,
  })
}

export async function prepareP5ReadyUpload(input: {
  database: DatabaseSync
  storageRoot: string
  actorId: string
  projectId: string
}): Promise<P5ReadyUpload> {
  const runtime = p5Runtime(input)
  const bytes = createMinimalDocxBuffer(P5_REPORT_TEXT)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const prepared = await runtime.service.prepare({
    actorId: input.actorId,
    projectId: input.projectId,
    fileName: '研究报告.docx',
    body,
    contentLength: bytes.byteLength,
  })
  if (!prepared.prepared) throw new Error('native prepare did not persist a ready file')
  return { uploadId: prepared.id, sourceKey: prepared.prepared.sourceKey, sourceSize: prepared.prepared.sourceSize }
}

export function readP5WorkflowTokens(database: DatabaseSync, projectId: string, stageId: string) {
  const state = database.prepare(
    'SELECT plan_revision, workflow_revision FROM project_report_state WHERE project_id=?',
  ).get(projectId) as { plan_revision: number; workflow_revision: number }
  const stage = database.prepare(
    'SELECT completion_revision, current_completion_report_id FROM project_stages WHERE id=?',
  ).get(stageId) as { completion_revision: number; current_completion_report_id: string | null }
  return {
    expectedPlanRevision: Number(state.plan_revision),
    expectedWorkflowRevision: Number(state.workflow_revision),
    expectedCompletionRevision: Number(stage.completion_revision),
    expectedCompletionReportId: stage.current_completion_report_id,
  }
}

export function buildP5Confirmation(input: {
  identity: P5NativeIdentity
  uploadId: string
  reportKind: 'update' | 'completion'
  tokens: ReturnType<typeof readP5WorkflowTokens>
  idempotencyKey?: string
}): ReportSubmissionConfirmation {
  return {
    actorId: input.identity.ownerId,
    projectId: input.identity.projectId,
    idempotencyKey: input.idempotencyKey ?? p5IdempotencyKey(),
    command: {
      uploadId: input.uploadId,
      stageId: input.identity.stageId,
      reportKind: input.reportKind,
      expectedPlanRevision: input.tokens.expectedPlanRevision,
      expectedWorkflowRevision: input.tokens.expectedWorkflowRevision,
      expectedCompletionRevision: input.tokens.expectedCompletionRevision,
      expectedCompletionReportId: input.tokens.expectedCompletionReportId,
    },
  }
}

export function p5IdempotencyKey() {
  return ('p5_' + randomUUID().replaceAll('-', '')).slice(0, 128)
}

export function readP5DurableConfirmSnapshot(database: DatabaseSync, reportId: string): P5DurableConfirmSnapshot {
  return {
    reportId,
    reports: database.prepare(
      'SELECT id, stage_id, stage_version, submission_sequence, submitted_as, source_key, source_size, submitted_by, deleted_at FROM report_submissions ORDER BY submission_sequence, id',
    ).all() as Array<Record<string, unknown>>,
    outbox: database.prepare(
      'SELECT id, report_id, project_id, actor_id, event_type, status, payload_json FROM report_submission_outbox ORDER BY id',
    ).all() as Array<Record<string, unknown>>,
    allocations: database.prepare(
      'SELECT owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path FROM storage_allocations ORDER BY owner_id',
    ).all() as Array<Record<string, unknown>>,
    usage: database.prepare(
      'SELECT scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count FROM storage_usage ORDER BY scope_type, scope_id',
    ).all() as Array<Record<string, unknown>>,
    request: database.prepare(
      'SELECT actor_id, project_id, idempotency_key, request_digest, upload_id, report_id, receipt_json FROM report_submission_requests WHERE report_id=?',
    ).get(reportId) as Record<string, unknown> | undefined,
  }
}

export function readP5ConfirmInvariants(database: DatabaseSync) {
  const reports = database.prepare(
    'SELECT COUNT(*) AS n, COUNT(DISTINCT submission_sequence) AS sequences FROM report_submissions',
  ).get() as { n: number; sequences: number }
  const inProgress = database.prepare(
    "SELECT COUNT(*) AS n FROM project_stages WHERE lifecycle_status='in_progress'",
  ).get() as { n: number }
  const allocations = database.prepare(
    "SELECT COUNT(*) AS n FROM storage_allocations WHERE owner_type='report'",
  ).get() as { n: number }
  const journal = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
  const legacy = database.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('report_versions','analysis_jobs','report_insights')",
  ).get() as { n: number }
  return {
    reportCount: Number(reports.n),
    uniqueSequences: Number(reports.sequences),
    inProgressStages: Number(inProgress.n),
    quotaAllocations: Number(allocations.n),
    journalMode: String(journal.journal_mode).toLowerCase(),
    legacyTables: Number(legacy.n),
  }
}

export async function fileExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function p5SourcePath(storageRoot: string, sourceKey: string) {
  return join(storageRoot, sourceKey)
}

export function closeP5Database(database: DatabaseSync | undefined) {
  try { database?.close() } catch { /* already closed */ }
}

export function waitForChildExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

export function launchP5ConfirmProcess(input: {
  databasePath: string
  storageRoot: string
  confirmation: ReportSubmissionConfirmation
  mode?: P5ConfirmMode
}) {
  const child = fork(CONFIRM_SCRIPT, [
    input.databasePath,
    input.storageRoot,
    JSON.stringify(input.confirmation),
    input.mode ?? 'reply',
  ], {
    execArgv: ['--import', TSX_LOADER],
    env: createP5ChildEnv({ databasePath: input.databasePath }),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const ready = waitForIpcMessage<{ ready?: boolean }>(child, (message) => message.ready === true)
  const result = ready.then(() => waitForIpcMessage<P5ConfirmOutcome | { phase: 'committed' }>(child, () => true))
  void result.catch(() => undefined)
  return { child, ready, result }
}

export async function raceP5Confirms(input: {
  databasePath: string
  storageRoot: string
  commands: ReportSubmissionConfirmation[]
}): Promise<P5ConfirmOutcome[]> {
  const workers = input.commands.map((confirmation) => launchP5ConfirmProcess({
    databasePath: input.databasePath,
    storageRoot: input.storageRoot,
    confirmation,
  }))
  try {
    await Promise.all(workers.map((worker) => worker.ready))
    for (const worker of workers) worker.child.send('confirm')
    const outcomes = await Promise.all(workers.map((worker) => worker.result))
    return outcomes.map((outcome) => {
      if ('phase' in outcome) throw new Error('confirm child returned a crash marker in reply mode')
      return outcome
    })
  } finally {
    for (const worker of workers) worker.child.kill('SIGKILL')
  }
}

export function launchP5RecoveryProcess(input: { databasePath: string; storageRoot: string }) {
  const child = fork(RECOVERY_SCRIPT, [input.databasePath, input.storageRoot], {
    execArgv: ['--import', TSX_LOADER],
    env: createP5ChildEnv({ databasePath: input.databasePath }),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const ready = waitForIpcMessage<{ ready?: boolean }>(child, (message) => message.ready === true)
  const result = ready.then(() => waitForIpcMessage<{ ok: boolean; result?: { recovered: string[]; blocked: string[] }; code?: string }>(child, () => true))
  void result.catch(() => undefined)
  return { child, ready, result }
}

export function launchP5WorkerProcess(input: {
  databasePath: string
  storageRoot: string
  providerBaseUrl: string
  mode?: 'continuous' | 'once'
}) {
  const args = [WORKER_SCRIPT, input.databasePath, input.storageRoot]
  if (input.mode === 'once') args.push('--once')
  const child = spawn(process.execPath, ['--import', TSX_LOADER, ...args], {
    env: createP5ChildEnv({ databasePath: input.databasePath, providerBaseUrl: input.providerBaseUrl }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return {
    child,
    stderr: () => stderr,
  }
}

export async function waitUntil(input: {
  predicate: () => boolean | Promise<boolean>
  timeoutMs: number
  message: string
}) {
  const deadline = Date.now() + input.timeoutMs
  while (Date.now() < deadline) {
    if (await input.predicate()) return
    await delay(25)
  }
  throw new Error(input.message)
}

export function percentile(values: number[], percent: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil((percent / 100) * sorted.length) - 1
  return sorted[Math.max(0, rank)] ?? 0
}

export function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function spawnP5Bootstrap(config: P5BootstrapConfig): Promise<P5NativeIdentity> {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, BOOTSTRAP_SCRIPT, JSON.stringify(config)], {
    env: createP5ChildEnv({ databasePath: config.databasePath }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const [code, signal] = await waitForSpawnExit(child)
  if (code !== 0) {
    throw new Error('native bootstrap failed (' + String(code ?? signal) + '): ' + Buffer.concat(stderr).toString())
  }
  const text = Buffer.concat(stdout).toString().trim()
  const line = text.split('\n').at(-1)
  if (!line) throw new Error('native bootstrap produced no identity JSON')
  return JSON.parse(line) as P5NativeIdentity
}

function waitForIpcMessage<T>(child: ChildProcess, match: (message: T) => boolean) {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (message: T) => {
      if (!match(message)) return
      cleanup()
      resolve(message)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error('child exited before IPC result (' + String(code ?? signal) + ')'))
    }
    const cleanup = () => {
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function waitForSpawnExit(child: ChildProcess) {
  return new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve([code, signal]))
  })
}

