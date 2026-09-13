import { cpus, loadavg, platform, totalmem } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createMinimalDocxBuffer } from './deployment-fixtures.mjs'
import {
  buildP5Confirmation,
  closeP5Database,
  createP5NativeRoot,
  disposeP5NativeRoot,
  openP5Database,
  percentile,
  P5_REPORT_TEXT,
  prepareP5ReadyUpload,
  raceP5Confirms,
  readP5ConfirmInvariants,
  readP5WorkflowTokens,
  type P5ConfirmOutcome,
  type P5NativeRoot,
} from '../test/helpers/p5-native-harness'

const UPDATE_ROUNDS = 20
const WAVE_SIZE = 4
const UPDATE_COUNT = UPDATE_ROUNDS * WAVE_SIZE
const COMPLETION_COUNT = 4
const P50 = 50
const P95 = 95

interface TimingSummary {
  success: number
  conflict: number
  busy: number
  other: number
  confirmLatency: { p50Ms: number; p95Ms: number; maxMs: number }
  beginImmediate: { p50Ms: number; p95Ms: number; maxMs: number; sampleCount: number }
}

async function runP5ContentionBenchmark() {
  const root = await createP5NativeRoot()
  const database = openP5Database(root.databasePath)
  try {
    const sequentialUpload = await prepareP5ReadyUpload({
      database,
      storageRoot: root.storageRoot,
      actorId: root.identity.ownerId,
      projectId: root.identity.projectId,
    })
    const baselineTokens = readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId)
    closeP5Database(database)
    const sequential = await raceP5Confirms({
      databasePath: root.databasePath,
      storageRoot: root.storageRoot,
      commands: [buildP5Confirmation({
        identity: root.identity,
        uploadId: sequentialUpload.uploadId,
        reportKind: 'update',
        tokens: baselineTokens,
      })],
    })
    const sequentialOutcome = sequential[0]
    if (!sequentialOutcome?.ok) throw new Error('sequential baseline confirm failed: ' + JSON.stringify(sequentialOutcome))
    const updateOutcomes = await runUpdateWaves(root)
    const completionOutcomes = await runCompletionWave(root)
    const recovered = openP5Database(root.databasePath)
    const invariants = readP5ConfirmInvariants(recovered)
    closeP5Database(recovered)
    const updates = summarize(updateOutcomes)
    const completions = summarize(completionOutcomes)
    const ok = invariants.legacyTables === 0
      && invariants.journalMode === 'wal'
      && updates.success === UPDATE_COUNT
      && updates.other === 0
      && completions.success === 1
      && invariants.reportCount === 1 + updates.success + completions.success
      && invariants.uniqueSequences === invariants.reportCount
      && invariants.quotaAllocations === invariants.reportCount
    const fixture = createMinimalDocxBuffer(P5_REPORT_TEXT)
    return {
      kind: 'p5-contention-benchmark',
      measurementKind: 'sqlite-confirm-transaction-microbenchmark',
      disclaimer: 'Isolated temp-root SQLite BEGIN IMMEDIATE contention sample on a shared host. Not HTTP/AI latency, not production capacity, and not an SLO.',
      definitions: {
        elapsedMs: 'Child-process wall time around repository.confirmSubmission (wrapped exec BEGIN IMMEDIATE through COMMIT or ROLLBACK). Excludes DOCX prepare/parse, Worker, and provider HTTP.',
        beginImmediateMs: 'Test-only DatabaseSync.exec wrapper around the exact BEGIN IMMEDIATE statement. Includes writer-lock acquisition until SQLite returns from that exec. Not kernel lock tracing.',
        sequentialBaseline: 'One uncontended confirmSubmission child used as a latency reference, not subtracted to invent lock wait.',
        success: 'confirmSubmission returned a receipt (fresh or replayed).',
        conflict: 'STAGE_COMPLETION_CHANGED from the stage token check inside the same transaction.',
        busy: 'SQLite SQLITE_BUSY after busy_timeout.',
      },
      notMeasured: ['http-handler', 'ai-provider', 'worker-pipeline', 'docx-parse', 'kernel-lock-wait', 'elapsed-minus-sequential-lock-wait'],
      workload: {
        concurrentConfirmProcesses: WAVE_SIZE,
        updateRounds: UPDATE_ROUNDS,
        updateOperations: UPDATE_COUNT,
        competingCompletions: COMPLETION_COUNT,
        httpProviderRequestCount: 0,
        busyTimeoutMs: 10_000,
        journalMode: invariants.journalMode,
        fixture: {
          kind: 'minimal-docx',
          bytes: fixture.byteLength,
          textChars: P5_REPORT_TEXT.length,
        },
      },
      host: {
        platform: platform(),
        node: process.version,
        cpuCount: cpus().length,
        loadAverage: loadavg(),
        totalMemoryBytes: totalmem(),
      },
      sequentialBaseline: {
        confirmLatencyMs: roundMs(sequentialOutcome.elapsedMs),
        beginImmediateMs: roundMs(sequentialOutcome.beginImmediateMs),
      },
      updates,
      completions,
      invariants: { ...invariants, ok },
    }
  } finally {
    closeP5Database(database)
    await disposeP5NativeRoot(root)
  }
}

async function runUpdateWaves(root: P5NativeRoot) {
  const database = openP5Database(root.databasePath)
  const uploads = []
  for (let index = 0; index < UPDATE_COUNT; index += 1) {
    uploads.push(await prepareP5ReadyUpload({
      database,
      storageRoot: root.storageRoot,
      actorId: root.identity.ownerId,
      projectId: root.identity.projectId,
    }))
  }
  const tokens = readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId)
  closeP5Database(database)
  const outcomes: P5ConfirmOutcome[] = []
  for (let offset = 0; offset < uploads.length; offset += WAVE_SIZE) {
    const wave = uploads.slice(offset, offset + WAVE_SIZE)
    outcomes.push(...await raceP5Confirms({
      databasePath: root.databasePath,
      storageRoot: root.storageRoot,
      commands: wave.map((upload) => buildP5Confirmation({
        identity: root.identity,
        uploadId: upload.uploadId,
        reportKind: 'update',
        tokens,
      })),
    }))
  }
  return outcomes
}

async function runCompletionWave(root: P5NativeRoot) {
  const database = openP5Database(root.databasePath)
  const uploads = []
  for (let index = 0; index < COMPLETION_COUNT; index += 1) {
    uploads.push(await prepareP5ReadyUpload({
      database,
      storageRoot: root.storageRoot,
      actorId: root.identity.ownerId,
      projectId: root.identity.projectId,
    }))
  }
  const tokens = readP5WorkflowTokens(database, root.identity.projectId, root.identity.stageId)
  closeP5Database(database)
  return raceP5Confirms({
    databasePath: root.databasePath,
    storageRoot: root.storageRoot,
    commands: uploads.map((upload) => buildP5Confirmation({
      identity: root.identity,
      uploadId: upload.uploadId,
      reportKind: 'completion',
      tokens,
    })),
  })
}

function summarize(outcomes: P5ConfirmOutcome[]): TimingSummary {
  const elapsed = outcomes.map((outcome) => outcome.elapsedMs)
  const beginImmediate = outcomes.flatMap((outcome) => outcome.beginImmediateMs === null ? [] : [outcome.beginImmediateMs])
  return {
    success: outcomes.filter((outcome) => outcome.ok).length,
    conflict: outcomes.filter((outcome) => !outcome.ok && outcome.code === 'STAGE_COMPLETION_CHANGED').length,
    busy: outcomes.filter((outcome) => !outcome.ok && outcome.code === 'SQLITE_BUSY').length,
    other: outcomes.filter((outcome) => !outcome.ok && outcome.code !== 'STAGE_COMPLETION_CHANGED' && outcome.code !== 'SQLITE_BUSY').length,
    confirmLatency: {
      p50Ms: roundMs(percentile(elapsed, P50)),
      p95Ms: roundMs(percentile(elapsed, P95)),
      maxMs: roundMs(Math.max(0, ...elapsed)),
    },
    beginImmediate: {
      p50Ms: roundMs(percentile(beginImmediate, P50)),
      p95Ms: roundMs(percentile(beginImmediate, P95)),
      maxMs: roundMs(Math.max(0, ...beginImmediate)),
      sampleCount: beginImmediate.length,
    },
  }
}

function roundMs(value: number) {
  return Math.round(value * 100) / 100
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
  void runP5ContentionBenchmark().then((report) => {
    process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))
    process.exitCode = report.invariants.ok ? 0 : 1
  }).catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : 'benchmark failed') + String.fromCharCode(10))
    process.exitCode = 1
  })
}
