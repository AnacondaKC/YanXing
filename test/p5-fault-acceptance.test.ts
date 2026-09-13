import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ReportSubmissionError } from '../modules/reports/upload-domain'
import { startP5HangProvider } from './helpers/p5-provider-server'
import {
  bindP5ProviderBaseUrl,
  buildP5Confirmation,
  closeP5Database,
  createP5NativeRoot,
  delay,
  disposeP5NativeRoot,
  fileExists,
  launchP5ConfirmProcess,
  launchP5RecoveryProcess,
  launchP5WorkerProcess,
  openP5Database,
  p5Runtime,
  p5SourcePath,
  P5_WORKER_LEASE_MS,
  P5_SETTINGS_ENCRYPTION_KEY,
  prepareP5ReadyUpload,
  raceP5Confirms,
  readP5ConfirmInvariants,
  readP5DurableConfirmSnapshot,
  readP5WorkflowTokens,
  waitForChildExit,
  waitUntil,
  type P5NativeRoot,
} from './helpers/p5-native-harness'

const PROCESS_TEST_TIMEOUT_MS = 20_000
const WORKER_TEST_TIMEOUT_MS = 30_000
const LEASE_RECOVERY_SLACK_MS = 2_000
const PROVIDER_WAIT_MS = 15_000

test('SIGKILL after native confirm commit before response replays the same report, outbox, and quota', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (context) => {
  const { root, database, close } = await openRoot(context)
  const upload = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const confirmation = buildP5Confirmation({
    identity: root.identity,
    uploadId: upload.uploadId,
    reportKind: 'update',
    tokens: readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId),
  })
  close()
  const worker = launchP5ConfirmProcess({
    databasePath: root.databasePath,
    storageRoot: root.storageRoot,
    confirmation,
    mode: 'die-after-commit',
  })
  await worker.ready
  worker.child.send('confirm')
  const message = await worker.result
  assert.deepEqual(message, { phase: 'committed' })
  worker.child.kill('SIGKILL')
  const exit = await waitForChildExit(worker.child)
  assert.equal(exit.signal, 'SIGKILL')
  const recovered = openP5Database(root.databasePath)
  context.after(() => closeP5Database(recovered))
  const before = readP5DurableConfirmSnapshot(recovered, String((recovered.prepare('SELECT report_id FROM report_submission_requests WHERE idempotency_key=?').get(confirmation.idempotencyKey) as { report_id: string }).report_id))
  const replay = p5Runtime({ database: recovered, storageRoot: root.storageRoot }).repository.confirmSubmission(confirmation)
  assert.equal(replay.replayed, true)
  assert.equal(replay.receipt.reportId, before.reportId)
  assert.deepEqual(readP5DurableConfirmSnapshot(recovered, replay.receipt.reportId), before)
  const invariants = readP5ConfirmInvariants(recovered)
  assert.equal(invariants.reportCount, 1)
  assert.equal(invariants.quotaAllocations, 1)
  assert.equal(invariants.journalMode, 'wal')
  assert.equal(invariants.legacyTables, 0)
  assert.equal(await fileExists(p5SourcePath(root.storageRoot, upload.sourceKey)), true)
})

test('true concurrent native confirm processes preserve replay and completion conflict invariants', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (context) => {
  await assertSameRequestReplay(context)
  await assertConcurrentUpdates(context)
  await assertCompetingCompletions(context)
})

test('killed worker preserves incomplete call without replay and allows a new retry generation', { timeout: WORKER_TEST_TIMEOUT_MS }, async (context) => {
  const { root, database, close } = await openRoot(context)
  const provider = await startP5HangProvider()
  context.after(() => provider.close())
  bindP5ProviderBaseUrl(database, provider.baseUrl)
  const upload = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const confirmation = buildP5Confirmation({
    identity: root.identity,
    uploadId: upload.uploadId,
    reportKind: 'update',
    tokens: readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId),
  })
  const receipt = p5Runtime({ database, storageRoot: root.storageRoot }).repository.confirmSubmission(confirmation).receipt
  close()
  const worker = launchP5WorkerProcess({
    databasePath: root.databasePath,
    storageRoot: root.storageRoot,
    providerBaseUrl: provider.baseUrl,
  })
  context.after(() => worker.child.kill('SIGKILL'))
  await waitUntil({
    predicate: () => provider.requestCount() >= 1,
    timeoutMs: PROVIDER_WAIT_MS,
    message: 'worker did not reach the controlled provider: ' + worker.stderr(),
  })
  const requestCountAfterCall = provider.requestCount()
  assert.equal(requestCountAfterCall, 1)
  worker.child.kill('SIGKILL')
  await waitForChildExit(worker.child)
  await delay(P5_WORKER_LEASE_MS + LEASE_RECOVERY_SLACK_MS)
  const recovery = launchP5WorkerProcess({
    databasePath: root.databasePath,
    storageRoot: root.storageRoot,
    providerBaseUrl: provider.baseUrl,
    mode: 'once',
  })
  context.after(() => recovery.child.kill('SIGKILL'))
  await waitUntil({
    predicate: () => recovery.child.exitCode !== null || recovery.child.signalCode !== null,
    timeoutMs: 8_000,
    message: 'recovery worker did not exit: ' + recovery.stderr(),
  })
  const recoveredExit = await waitForChildExit(recovery.child)
  assert.equal(recoveredExit.code, 0, recovery.stderr())
  assert.equal(provider.requestCount(), requestCountAfterCall)
  const recovered = openP5Database(root.databasePath)
  context.after(() => closeP5Database(recovered))
  const task = recovered.prepare(
    'SELECT id, status, error_code FROM submission_tasks WHERE report_id=? AND operation=?',
  ).get(receipt.reportId, 'analysis') as { id: string; status: string; error_code: string | null }
  assert.equal(task.status, 'failed')
  assert.equal(task.error_code, 'AI_CALL_INCOMPLETE')
  const call = recovered.prepare(
    'SELECT state FROM submission_task_calls WHERE job_id=? ORDER BY attempt DESC LIMIT 1',
  ).get(task.id) as { state: string }
  assert.equal(call.state, 'started')
  const runtime = p5Runtime({ database: recovered, storageRoot: root.storageRoot })
  const previousKey = process.env.YANXING_SETTINGS_ENCRYPTION_KEY
  context.after(() => {
    if (previousKey === undefined) delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY
    else process.env.YANXING_SETTINGS_ENCRYPTION_KEY = previousKey
  })
  process.env.YANXING_SETTINGS_ENCRYPTION_KEY = P5_SETTINGS_ENCRYPTION_KEY
  const { task: retry } = runtime.tasks.retry({ actorId: root.identity.ownerId, jobId: task.id })
  assert.notEqual(retry.id, task.id)
  assert.equal(retry.generation, 2)
  assert.equal(retry.status, 'queued')
  assert.equal(provider.requestCount(), requestCountAfterCall)
  assert.equal(runtime.tasks.getTask(task.id)?.status, 'failed')
})

test('fenced cleanup cannot delete formal or tombstone files during concurrent recovery', { timeout: PROCESS_TEST_TIMEOUT_MS }, async (context) => {
  const { root, database, close } = await openRoot(context)
  const runtime = p5Runtime({ database, storageRoot: root.storageRoot })
  const first = await prepareAndConfirm(root, database, 'update')
  const second = await prepareAndConfirm(root, database, 'update')
  runtime.tasks.deleteReport({ actorId: root.identity.ownerId, reportId: first.reportId, reason: 'p5-tombstone' })
  const decoy = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  runtime.repository.failUpload({
    actorId: root.identity.ownerId,
    projectId: root.identity.projectId,
    uploadId: decoy.uploadId,
    errorCode: 'REPORT_PARSE_FAILED',
  })
  const live = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const confirmation = buildP5Confirmation({
    identity: root.identity,
    uploadId: live.uploadId,
    reportKind: 'update',
    tokens: readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId),
  })
  close()
  const recovery = launchP5RecoveryProcess({ databasePath: root.databasePath, storageRoot: root.storageRoot })
  const confirm = launchP5ConfirmProcess({
    databasePath: root.databasePath,
    storageRoot: root.storageRoot,
    confirmation,
  })
  await Promise.all([recovery.ready, confirm.ready])
  recovery.child.send('run')
  confirm.child.send('confirm')
  const [recoveryResult, confirmResult] = await Promise.all([recovery.result, confirm.result])
  assert.equal(recoveryResult.ok, true)
  assert.ok(recoveryResult.result?.recovered.includes(decoy.uploadId))
  assert.ok(!recoveryResult.result?.recovered.includes(first.uploadId))
  assert.ok(!recoveryResult.result?.recovered.includes(second.uploadId))
  assert.ok(!('phase' in confirmResult) && confirmResult.ok, JSON.stringify(confirmResult))
  const recovered = openP5Database(root.databasePath)
  context.after(() => closeP5Database(recovered))
  const firstRow = recovered.prepare('SELECT deleted_at, source_key FROM report_submissions WHERE id=?').get(first.reportId) as { deleted_at: string; source_key: string }
  const secondRow = recovered.prepare('SELECT deleted_at, source_key FROM report_submissions WHERE id=?').get(second.reportId) as { deleted_at: string | null; source_key: string }
  assert.ok(firstRow.deleted_at)
  assert.equal(secondRow.deleted_at, null)
  assert.equal(await fileExists(p5SourcePath(root.storageRoot, firstRow.source_key)), true)
  assert.equal(await fileExists(p5SourcePath(root.storageRoot, secondRow.source_key)), true)
  assert.equal(await fileExists(p5SourcePath(root.storageRoot, live.sourceKey)), true)
  const recoveredRuntime = p5Runtime({ database: recovered, storageRoot: root.storageRoot })
  assert.throws(
    () => recoveredRuntime.recovery.withMutation(first.uploadId, () => undefined),
    (error: unknown) => error instanceof ReportSubmissionError && error.code === 'UPLOAD_ABORTED',
  )
  assert.throws(
    () => recoveredRuntime.recovery.withMutation(second.uploadId, () => undefined),
    (error: unknown) => error instanceof ReportSubmissionError && error.code === 'UPLOAD_ABORTED',
  )
  const claimed = recoveredRuntime.recovery.claim()
  assert.ok(!claimed || (claimed.uploadId !== first.uploadId && claimed.uploadId !== second.uploadId && claimed.uploadId !== live.uploadId))
})

async function openRoot(context: TestContext) {
  const root = await createP5NativeRoot()
  const database = openP5Database(root.databasePath)
  const close = () => closeP5Database(database)
  context.after(async () => {
    close()
    await disposeP5NativeRoot(root)
  })
  return { root, database, close }
}

async function prepareAndConfirm(root: P5NativeRoot, database: ReturnType<typeof openP5Database>, reportKind: 'update' | 'completion') {
  const upload = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const confirmation = buildP5Confirmation({
    identity: root.identity,
    uploadId: upload.uploadId,
    reportKind,
    tokens: readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId),
  })
  const receipt = p5Runtime({ database, storageRoot: root.storageRoot }).repository.confirmSubmission(confirmation).receipt
  return { ...upload, reportId: receipt.reportId }
}

async function assertSameRequestReplay(context: TestContext) {
  const { root, database, close } = await openRoot(context)
  const upload = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const confirmation = buildP5Confirmation({
    identity: root.identity,
    uploadId: upload.uploadId,
    reportKind: 'update',
    tokens: readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId),
  })
  close()
  const outcomes = await raceP5Confirms({
    databasePath: root.databasePath,
    storageRoot: root.storageRoot,
    commands: [confirmation, confirmation],
  })
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes))
  const receipts = outcomes.flatMap((outcome) => outcome.ok ? [outcome.result.receipt] : [])
  assert.deepEqual(receipts[0], receipts[1])
  assert.equal(outcomes.filter((outcome) => outcome.ok && outcome.result.replayed).length, 1)
  const recovered = openP5Database(root.databasePath)
  context.after(() => closeP5Database(recovered))
  assert.equal(readP5ConfirmInvariants(recovered).reportCount, 1)
}

async function assertConcurrentUpdates(context: TestContext) {
  const { root, database, close } = await openRoot(context)
  const first = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const second = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const tokens = readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId)
  close()
  const outcomes = await raceP5Confirms({
    databasePath: root.databasePath,
    storageRoot: root.storageRoot,
    commands: [
      buildP5Confirmation({ identity: root.identity, uploadId: first.uploadId, reportKind: 'update', tokens }),
      buildP5Confirmation({ identity: root.identity, uploadId: second.uploadId, reportKind: 'update', tokens }),
    ],
  })
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes))
  const recovered = openP5Database(root.databasePath)
  context.after(() => closeP5Database(recovered))
  const invariants = readP5ConfirmInvariants(recovered)
  assert.equal(invariants.reportCount, 2)
  assert.equal(invariants.uniqueSequences, 2)
  assert.equal(invariants.inProgressStages, 1)
  assert.equal(invariants.quotaAllocations, 2)
}

async function assertCompetingCompletions(context: TestContext) {
  const { root, database, close } = await openRoot(context)
  const first = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const second = await prepareP5ReadyUpload({ database, storageRoot: root.storageRoot, actorId: root.identity.ownerId, projectId: root.identity.projectId })
  const tokens = readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId)
  close()
  const outcomes = await raceP5Confirms({
    databasePath: root.databasePath,
    storageRoot: root.storageRoot,
    commands: [
      buildP5Confirmation({ identity: root.identity, uploadId: first.uploadId, reportKind: 'completion', tokens }),
      buildP5Confirmation({ identity: root.identity, uploadId: second.uploadId, reportKind: 'completion', tokens }),
    ],
  })
  const successes = outcomes.filter((outcome) => outcome.ok)
  const conflicts = outcomes.filter((outcome) => !outcome.ok && outcome.code === 'STAGE_COMPLETION_CHANGED')
  assert.equal(successes.length, 1, JSON.stringify(outcomes))
  assert.equal(conflicts.length, 1, JSON.stringify(outcomes))
  const recovered = openP5Database(root.databasePath)
  context.after(() => closeP5Database(recovered))
  const invariants = readP5ConfirmInvariants(recovered)
  assert.equal(invariants.reportCount, 1)
  assert.equal(invariants.inProgressStages, 0)
}
