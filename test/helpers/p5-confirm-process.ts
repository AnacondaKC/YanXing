import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ReportSubmissionRepository } from '../../lib/db/report-submission-repository'
import { createSubmissionStorageQuota } from '../../lib/storage/submission-quota'
import type { ReportSubmissionConfirmation } from '../../modules/reports/upload-domain'

export type P5ConfirmMode = 'reply' | 'die-after-commit'

export type P5ConfirmOutcome =
  | { ok: true; result: { receipt: unknown; replayed: boolean }; elapsedMs: number; beginImmediateMs: number }
  | { ok: false; code: string; elapsedMs: number; beginImmediateMs: number | null }

const SQLITE_BUSY = 5
const SQLITE_BUSY_TIMEOUT_MS = 10_000

function failureCode(error: unknown) {
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string' && error.code.length > 0) return error.code
    if ('errcode' in error && Number(error.errcode) === SQLITE_BUSY) return 'SQLITE_BUSY'
  }
  if (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)) return 'SQLITE_BUSY'
  return 'UNEXPECTED'
}

function isBeginImmediateSql(sql: string) {
  return sql.trimStart().toUpperCase().startsWith('BEGIN IMMEDIATE')
}

function instrumentBeginImmediate(database: DatabaseSync) {
  const originalExec = database.exec.bind(database)
  const samples: number[] = []
  Object.defineProperty(database, 'exec', {
    configurable: true,
    writable: true,
    value: (sql: string) => {
      if (!isBeginImmediateSql(sql)) return originalExec(sql)
      const startedAt = performance.now()
      try {
        return originalExec(sql)
      } finally {
        samples.push(performance.now() - startedAt)
      }
    },
  })
  return samples
}

function runConfirmation(input: {
  databasePath: string
  storageRoot: string
  confirmation: ReportSubmissionConfirmation
  mode: P5ConfirmMode
}): P5ConfirmOutcome {
  const database = new DatabaseSync(input.databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS })
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=' + SQLITE_BUSY_TIMEOUT_MS)
  const beginImmediateSamples = instrumentBeginImmediate(database)
  const startedAt = performance.now()
  let keepOpen = false
  const lastBeginImmediateMs = () => beginImmediateSamples.at(-1) ?? null
  try {
    const repository = new ReportSubmissionRepository({
      database,
      quota: createSubmissionStorageQuota({ storageRoot: input.storageRoot }),
    })
    const result = repository.confirmSubmission(input.confirmation)
    keepOpen = input.mode === 'die-after-commit'
    const beginImmediateMs = lastBeginImmediateMs()
    if (beginImmediateMs === null) throw new Error('confirmSubmission did not execute BEGIN IMMEDIATE')
    return { ok: true, result, elapsedMs: performance.now() - startedAt, beginImmediateMs }
  } catch (error) {
    return { ok: false, code: failureCode(error), elapsedMs: performance.now() - startedAt, beginImmediateMs: lastBeginImmediateMs() }
  } finally {
    if (!keepOpen) database.close()
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
  const confirmation = JSON.parse(process.argv[4] ?? '') as ReportSubmissionConfirmation
  const mode = (process.argv[5] ?? 'reply') as P5ConfirmMode
  process.once('message', () => {
    const outcome = runConfirmation({
      databasePath: process.argv[2] ?? '',
      storageRoot: process.argv[3] ?? '',
      confirmation,
      mode,
    })
    if (mode === 'die-after-commit') {
      if (!outcome.ok) {
        process.send?.(outcome, () => process.disconnect())
        return
      }
      process.send?.({ phase: 'committed' })
      return
    }
    process.send?.(outcome, () => process.disconnect())
  })
  process.send?.({ ready: true })
}
